import logging
logger = logging.getLogger(__name__)

import pandas as pd
import yfinance as yf
import requests
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

router = APIRouter()

FALLBACK_BTC = 845256.0       # SEC EDGAR 8-K 2026-06-08 (as of June 7, 2026)
FALLBACK_AVG_COST = 75680.0   # SEC EDGAR 8-K 2026-06-08


def _extract_btc_from_text(text: str, date: str) -> dict | None:
    """
    Parse BTC holdings and average cost from a cleaned 8-K filing text.

    Strategy's 8-K format has evolved. Two variants are in use:

    Variant A (no purchases that week):
        "Aggregate BTC Holdings ... 843,706 $63.87 $75,699"

    Variant B (with purchases — new format, the table now has a 'During Period'
    column that comes BEFORE the cumulative total):
        "Aggregate BTC Holdings ... 1,550 $101.3 $65,332 845,256 $63.97 $75,680"

    In both cases the cumulative holdings value is the first number > 100,000
    that appears in the 600 characters after the "Aggregate BTC Holdings" marker.
    """
    import re
    idx = text.find("Aggregate BTC Holdings")
    if idx == -1:
        return None

    window = text[idx: idx + 600]

    # Find all comma-separated numbers (NNN,NNN or N,NNN,NNN style)
    candidates = re.findall(r"(\d[\d,]*\d)", window)
    btc = None
    for raw in candidates:
        val = float(raw.replace(",", ""))
        if 100_000 < val < 10_000_000:
            btc = val
            break

    if btc is None:
        return None

    # Average purchase price per BTC (USD, range 10k–500k).
    # Strategy's tables include both a period avg and a cumulative avg; the
    # cumulative is always the LAST valid dollar amount in the range.
    avg_cost = FALLBACK_AVG_COST
    dollar_candidates = re.findall(r"\$\s*([\d,]{4,8})\b", window)
    valid_prices = [float(r.replace(",", "")) for r in dollar_candidates
                    if 10_000 <= float(r.replace(",", "")) <= 500_000]
    if valid_prices:
        avg_cost = valid_prices[-1]

    return {"btc": btc, "avg_cost": avg_cost, "source": f"SEC EDGAR 8-K ({date})"}


def _get_mstr_btc():
    """
    Fetches MSTR BTC holdings from SEC EDGAR 8-K filings.
    Scans the most recent filings in order; returns as soon as a 'BTC Update'
    section is found and parsed successfully.
    """
    import re
    headers = {"User-Agent": "finance-terminal research@example.com"}
    try:
        sub = requests.get(
            "https://data.sec.gov/submissions/CIK0001050446.json",
            headers=headers, timeout=8
        ).json()
        recent = sub.get("filings", {}).get("recent", {})
        forms  = recent.get("form", [])
        dates  = recent.get("filingDate", [])
        accns  = recent.get("accessionNumber", [])
        docs   = recent.get("primaryDocument", [])

        for form, date, acc, doc in zip(forms, dates, accns, docs):
            if form != "8-K":
                continue
            acc_clean = acc.replace("-", "")
            url = f"https://www.sec.gov/Archives/edgar/data/1050446/{acc_clean}/{doc}"
            resp = requests.get(url, headers=headers, timeout=10)
            if resp.status_code != 200:
                continue

            text = re.sub(r"<[^>]+>", " ", resp.text)
            text = re.sub(r"&[a-z#0-9]+;", " ", text)
            text = re.sub(r"\s+", " ", text)

            # Only process filings that have a BTC update section
            if not re.search(r"BTC Update|Aggregate BTC Holdings", text, re.IGNORECASE):
                continue

            result = _extract_btc_from_text(text, date)
            if result:
                return result

        return {"btc": FALLBACK_BTC, "avg_cost": FALLBACK_AVG_COST, "source": "EDGAR parse failed — enter manually"}
    except Exception as e:
        logger.warning("_get_mstr_btc: %s", e)
        return {"btc": FALLBACK_BTC, "avg_cost": FALLBACK_AVG_COST, "source": "EDGAR unavailable — enter manually"}


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
    except Exception:
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
