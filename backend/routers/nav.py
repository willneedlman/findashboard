import logging
logger = logging.getLogger(__name__)

import re
import os
import sys
import json
import threading
from pathlib import Path

import pandas as pd
import requests
from cachetools import TTLCache
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))
from cache import get_history, get_info

router = APIRouter()

# External live-data fetches (CoinGecko, Sprott) cached 1h to respect rate limits.
_live_cache: TTLCache = TTLCache(maxsize=64, ttl=3600)
_live_lock = threading.Lock()

FALLBACK_BTC = 845256.0       # SEC EDGAR 8-K 2026-06-08 (as of June 7, 2026)
FALLBACK_AVG_COST = 75680.0   # SEC EDGAR 8-K 2026-06-08

# Curated registry of asset-backed proxy companies (crypto treasuries, metals,
# materials). MSTR carries live='mstr_edgar' and uses the dedicated scraper below;
# every other entry serves a stored snapshot. Values for non-MSTR names are
# placeholders to be edited — see the file's _meta note.
_REGISTRY_PATH = Path(__file__).resolve().parent.parent / "data" / "treasury_companies.json"


def _load_registry() -> dict:
    try:
        with open(_REGISTRY_PATH) as fh:
            data = json.load(fh)
        return {k: v for k, v in data.items() if not k.startswith("_")}
    except Exception as e:
        logger.warning("nav registry load failed: %s", e)
        return {}


REGISTRY = _load_registry()


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


def _cached(key: str, producer):
    """Run producer() at most once per TTL window, keyed by `key`."""
    with _live_lock:
        if key in _live_cache:
            return _live_cache[key]
    val = producer()
    if val is not None:
        with _live_lock:
            _live_cache[key] = val
    return val


def _get_crypto_holdings(ticker: str, coin: str) -> dict | None:
    """
    Live crypto-treasury holdings via CoinGecko's public_treasury API.
    Matches the company by ticker (symbols come as 'MARA.US', '3350.T', …).
    avg_cost is derived from total entry value when CoinGecko reports it.
    """
    def fetch():
        try:
            r = requests.get(
                f"https://api.coingecko.com/api/v3/companies/public_treasury/{coin}",
                timeout=10,
            )
            r.raise_for_status()
            return r.json().get("companies", [])
        except Exception as e:
            logger.warning("_get_crypto_holdings(%s) fetch: %s", coin, e)
            return None

    companies = _cached(f"coingecko:{coin}", fetch)
    if not companies:
        return None
    tk = ticker.strip().upper()
    match = next(
        (c for c in companies if c.get("symbol") and c["symbol"].upper().split(".")[0].split(":")[-1] == tk),
        None,
    )
    if not match:
        return None
    holdings = float(match.get("total_holdings") or 0) or None
    if not holdings:
        return None
    entry = float(match.get("total_entry_value_usd") or 0)
    avg_cost = round(entry / holdings, 2) if entry > 0 else 0.0
    return {"holdings": holdings, "avg_cost": avg_cost,
            "source": f"CoinGecko public treasury ({coin})"}


def _get_sprott_nav(slug: str) -> float | None:
    """Scrape current NAV per unit from a Sprott physical-trust api-update page."""
    def fetch():
        try:
            url = f"https://www.sprottusa.com/api-update/investment-strategies/physical-bullion-trusts/{slug}/"
            resp = requests.get(url, headers={"User-Agent": "Mozilla/5.0"}, timeout=10)
            if resp.status_code != 200:
                return None
            text = re.sub(r"<[^>]+>", " ", resp.text)
            text = re.sub(r"\s+", " ", text)
            # First "Net Asset Value per Unit $XX.XX" is the US$ figure (CAD follows).
            m = re.search(r"Net Asset Value per Unit[^$]{0,20}\$\s*([\d,]+\.\d{2})", text, re.IGNORECASE)
            if not m:
                return None
            return float(m.group(1).replace(",", ""))
        except Exception as e:
            logger.warning("_get_sprott_nav(%s): %s", slug, e)
            return None

    return _cached(f"sprott:{slug}", fetch)


def _get_etf_nav(ticker: str) -> float | None:
    """Live NAV per share for ETFs that expose navPrice via yfinance."""
    try:
        nav = get_info(ticker).get("navPrice")
        return float(nav) if nav else None
    except Exception as e:
        logger.warning("_get_etf_nav(%s): %s", ticker, e)
        return None


def _live_price(sym: str) -> float | None:
    """Freshest last trade for the NAV snapshot — Binance for crypto, Tradier/
    yfinance for equities/ETFs/FX. Returns None on any failure so callers fall
    back to the EOD close from history."""
    try:
        from quotes import live_price
        p = live_price(sym)
        return float(p) if p else None
    except Exception:
        return None


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


@router.get("/registry")
def nav_registry():
    """Preset asset-backed proxy companies for the NAV Tracker selector."""
    return [
        {
            "ticker":      ticker,
            "name":        e.get("name", ticker),
            "category":    e.get("category", ""),
            "asset":       e.get("asset", ""),
            "asset_label": e.get("asset_label", ""),
            "live":        e.get("live", ""),
        }
        for ticker, e in REGISTRY.items()
    ]


@router.post("/proxy")
def nav_proxy(req: NavRequest):
    end = req.end or str(pd.Timestamp.today().date())
    target = req.target.strip().upper()
    entry = REGISTRY.get(target)
    try:
        target_hist = get_history(target, start=req.start, end=end)
        asset_hist  = get_history(req.asset, start=req.start, end=end)

        if target_hist.empty:
            raise HTTPException(404, f"No data for {req.target}")
        if asset_hist.empty:
            raise HTTPException(404, f"No data for {req.asset}")

        info = get_info(target)
        shares = (info.get("sharesOutstanding") or info.get("impliedSharesOutstanding") or 100_000_000)
        latest_spot = float(asset_hist["Close"].dropna().iloc[-1])
        live_debt_m = (info.get("totalDebt") or 0) / 1e6
        live_cash_m = (info.get("totalCash") or 0) / 1e6

    except HTTPException:
        raise
    except Exception:
        logger.exception("internal error"); raise HTTPException(500, "Internal server error")

    # Live last-trade for the snapshot (history Close is the prior EOD). Crypto
    # via Binance, equities/ETFs via Tradier->yfinance; falls back to EOD.
    live_target_px = _live_price(target)
    live_asset_px  = _live_price(req.asset)
    if live_asset_px:
        latest_spot = live_asset_px

    # ── Resolve holdings/NAV LIVE. Nothing financial is stored in the registry.
    #    MSTR uses its dedicated EDGAR feed; crypto treasuries use CoinGecko;
    #    bullion trusts/ETFs use reported NAV. Manual entry overrides all. ──
    model = (entry.get("model") if entry else None) or "holdings"
    live_src = entry.get("live") if entry else None

    if not req.use_live:
        holdings = req.holdings if req.holdings is not None else 0.0
        avg_cost = req.avg_cost if req.avg_cost is not None else 0.0
        model, source, source_tier = "holdings", "Manual entry", "manual"
    elif live_src == "mstr_edgar":
        live = _get_mstr_btc()
        holdings, avg_cost = live["btc"], live["avg_cost"]
        source, source_tier = live["source"], "mstr-edgar"
    elif live_src == "coingecko":
        r = _get_crypto_holdings(target, entry.get("coin", "bitcoin"))
        if r:
            holdings, avg_cost, source, source_tier = r["holdings"], r["avg_cost"], r["source"], "coingecko"
        else:
            holdings, avg_cost, source, source_tier = 0.0, 0.0, "Live fetch failed — enter manually", "needs-manual"
    elif model == "reported_nav":
        nav_unit = _get_sprott_nav(entry["sprott_slug"]) if live_src == "sprott" else _get_etf_nav(target)
        if nav_unit and latest_spot > 0:
            holdings = (nav_unit / latest_spot) * shares   # implied units, fully live
            avg_cost = 0.0
            source = "Sprott NAV per unit" if live_src == "sprott" else "yfinance navPrice"
            source_tier = "fund-nav"
        else:
            holdings, avg_cost, source, source_tier = 0.0, 0.0, "NAV unavailable — enter manually", "needs-manual"
    else:
        holdings = req.holdings if req.holdings is not None else 0.0
        avg_cost = req.avg_cost if req.avg_cost is not None else 0.0
        source, source_tier = "Not in registry — enter holdings manually", "needs-manual"

    # Debt/cash: live from yfinance in auto mode; manual override otherwise.
    # Bullion trusts/ETFs hold no corporate debt — NAV is metal-only.
    if model == "reported_nav":
        gross_debt_m = gross_cash_m = 0.0
    elif source_tier == "manual":
        gross_debt_m, gross_cash_m = req.gross_debt_m, req.gross_cash_m
    else:
        gross_debt_m = live_debt_m or req.gross_debt_m
        gross_cash_m = live_cash_m or req.gross_cash_m

    asset_label = (entry.get("asset_label") if entry else None) or req.asset.strip().upper().split("-")[0]
    company_name = (entry.get("name") if entry else None) or target

    # Outer join then forward-fill so we keep all trading days
    target_s = target_hist["Close"].rename("target")
    asset_s  = asset_hist["Close"].rename("asset")
    df = pd.concat([target_s, asset_s], axis=1).ffill().bfill().dropna()

    if df.empty:
        raise HTTPException(404, "No overlapping data after alignment")

    # Override the latest row with live prices so the current snapshot (and the
    # chart's right edge) reflect the market now, not yesterday's close.
    if live_target_px:
        df.iat[-1, df.columns.get_loc("target")] = live_target_px
    if live_asset_px:
        df.iat[-1, df.columns.get_loc("asset")] = live_asset_px

    net_debt = (gross_debt_m - gross_cash_m) * 1_000_000
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
        "is_live":        bool(live_target_px or live_asset_px),
        "holdings":       round(holdings, 2),
        "avg_cost":       avg_cost,
        "company_name":   company_name,
        "asset_label":    asset_label,
        "model":          model,
        "gross_debt_m":   round(gross_debt_m, 1),
        "gross_cash_m":   round(gross_cash_m, 1),
        "unrealized_pnl": round(unrealized_pnl / 1e9, 3),
        "source":         source,
        "source_tier":    source_tier,
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
