import logging
logger = logging.getLogger(__name__)

import pandas as pd
import yfinance as yf
import requests
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

router = APIRouter()

FALLBACK_BTC = 843706.0       # SEC EDGAR 8-K 2026-06-01
FALLBACK_AVG_COST = 75699.0   # SEC EDGAR 8-K 2026-06-01


def _get_mstr_btc():
    """
    Scrapes MSTR BTC holdings from SEC EDGAR 8-K filings (static HTML, always accessible).
    strategy.com uses JS rendering and cannot be scraped with HTTP.
    """
    import re
    headers = {"User-Agent": "finance-terminal research@example.com"}
    try:
        # Step 1: get recent filings for Strategy Inc (CIK 0001050446)
        sub = requests.get(
            "https://data.sec.gov/submissions/CIK0001050446.json",
            headers=headers, timeout=8
        ).json()
        recent = sub.get("filings", {}).get("recent", {})
        forms  = recent.get("form", [])
        dates  = recent.get("filingDate", [])
        accns  = recent.get("accessionNumber", [])
        docs   = recent.get("primaryDocument", [])

        # Step 2: find the most recent 8-K
        for form, date, acc, doc in zip(forms, dates, accns, docs):
            if form != "8-K":
                continue
            acc_clean = acc.replace("-", "")
            url = f"https://www.sec.gov/Archives/edgar/data/1050446/{acc_clean}/{doc}"
            resp = requests.get(url, headers=headers, timeout=10)
            if resp.status_code != 200:
                continue

            # Strip HTML/entities and search for BTC holdings block
            text = re.sub(r"<[^>]+>", " ", resp.text)
            text = re.sub(r"&[a-z#0-9]+;", " ", text)
            text = re.sub(r"\s+", " ", text)

            # "Aggregate BTC Holdings ... <headers> ... NNN,NNN $price $avg"
            m = re.search(
                r"Aggregate BTC Holdings[^0-9]{0,300}([\d]{3},[\d]{3})", text, re.IGNORECASE
            )
            if not m:
                # Fallback: number followed by dollar amounts near "Bitcoin"
                m = re.search(
                    r"([\d]{3},[\d]{3})\s+\$[\d.]+\s+\$[\d,]+\s+\*?Bitcoin", text, re.IGNORECASE
                )
            if m:
                btc = float(m.group(1).replace(",", ""))
                if 100_000 < btc < 5_000_000:
                    # Extract per-BTC average purchase price (the 5-6 digit number after aggregate price)
                    # Text structure: "843,706 $63.87 $75,699" — want the 5-digit dollar amount
                    avg_match = re.search(
                        r"Average Purchase Price[^\d$]{0,50}\$([\d,]{4,8})\b", text, re.IGNORECASE
                    )
                    if not avg_match:
                        # Fallback: find the per-BTC price near the BTC count
                        idx_btc = text.find(m.group(1))
                        nearby = text[idx_btc:idx_btc + 60] if idx_btc != -1 else ""
                        price_m = re.search(r"\$([\d,]{5,6})\b", nearby)
                        avg_match = price_m
                    avg_cost = float(avg_match.group(1).replace(",", "")) if avg_match else FALLBACK_AVG_COST
                    return {"btc": btc, "avg_cost": avg_cost, "source": f"SEC EDGAR 8-K ({date})"}

        return {"btc": FALLBACK_BTC, "avg_cost": FALLBACK_AVG_COST, "source": "EDGAR parse failed — enter manually"}
    except Exception as e:
        return {"btc": FALLBACK_BTC, "avg_cost": FALLBACK_AVG_COST, "source": f"EDGAR unavailable — enter manually"}


class NavRequest(BaseModel):
    target: str = "MSTR"
    asset: str = "BTC-USD"
    start: str = "2023-01-01"
    end: str | None = None
    holdings: float | None = None
    avg_cost: float | None = None
    gross_debt_m: float = 4200.0
    gross_cash_m: float = 150.0
    use_live: bool = True


@router.post("/proxy")
def nav_proxy(req: NavRequest):
    end = req.end or str(pd.Timestamp.today().date())
    try:
        target_tkr = yf.Ticker(req.target.strip().upper())
        asset_tkr  = yf.Ticker(req.asset.strip().upper())

        target_hist = target_tkr.history(start=req.start, end=end)
        asset_hist  = asset_tkr.history(start=req.start, end=end)

        if target_hist.empty:
            raise HTTPException(404, f"No data for {req.target}")
        if asset_hist.empty:
            raise HTTPException(404, f"No data for {req.asset}")

        # Strip timezone
        if target_hist.index.tz is not None:
            target_hist.index = target_hist.index.tz_localize(None)
        if asset_hist.index.tz is not None:
            asset_hist.index = asset_hist.index.tz_localize(None)

        info = target_tkr.info
        shares = info.get("sharesOutstanding") or info.get("impliedSharesOutstanding") or 345_930_000

    except HTTPException:
        raise
    except Exception as e:
        logger.exception("internal error"); raise HTTPException(500, "Internal server error")

    mstr_live = None
    if req.target.upper() == "MSTR" and req.use_live:
        mstr_live = _get_mstr_btc()

    holdings = req.holdings or (mstr_live["btc"] if mstr_live else 1000.0)
    avg_cost = req.avg_cost or (mstr_live["avg_cost"] if mstr_live else 0.0)

    # Outer join then forward-fill so we keep all trading days
    target_s = target_hist["Close"].rename("target")
    asset_s  = asset_hist["Close"].rename("asset")
    df = pd.concat([target_s, asset_s], axis=1).ffill().bfill().dropna()

    if df.empty:
        raise HTTPException(404, "No overlapping data after alignment")

    net_debt = (req.gross_debt_m - req.gross_cash_m) * 1_000_000
    df["gav_per_share"] = (holdings * df["asset"]) / shares
    df["nav_per_share"] = df["gav_per_share"] - net_debt / shares
    df["premium"] = (df["target"] - df["nav_per_share"]) / df["nav_per_share"].abs().replace(0, 1)

    latest = df.iloc[-1]
    btc_price = float(latest["asset"])
    unrealized_pnl = (btc_price - avg_cost) * holdings if avg_cost > 0 else 0

    return {
        "current": {
            "target_price":  round(float(latest["target"]), 2),
            "gav_per_share": round(float(latest["gav_per_share"]), 2),
            "nav_per_share": round(float(latest["nav_per_share"]), 2),
            "premium":       round(float(latest["premium"]) * 100, 2),
            "asset_spot":    round(btc_price, 2),
        },
        "holdings":       holdings,
        "avg_cost":       avg_cost,
        "unrealized_pnl": round(unrealized_pnl / 1e9, 3),
        "source":         mstr_live["source"] if mstr_live else "manual",
        "series": [
            {
                "date":    str(d.date()),
                "target":  round(float(r["target"]), 2),
                "nav":     round(float(r["nav_per_share"]), 2),
                "premium": round(float(r["premium"]) * 100, 2),
            }
            for d, r in df.iterrows()
        ],
    }
