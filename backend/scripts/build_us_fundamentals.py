"""Build backend/data/us_fundamentals.json — a bundled snapshot of basic stats for
the US screener universe (S&P 500 + S&P 400 + Nasdaq 100), sourced from Finnhub.

This is the durable fallback the screener serves when FMP is throttled or a name's
deep fundamentals aren't cached yet, so major US companies always show real stats
(sector + ratios + margins + growth) instead of blank columns.

Two Finnhub calls per name: /stock/metric (ratios, margins, growth, beta) and
/stock/profile2 (name, sector, exchange, market cap, derived price). Finnhub's free
tier is 60 calls/min, so this is throttled and runs sequentially, majors first; it
is merge-safe and saves after every name, so a rerun fills gaps without losing
progress. Refresh quarterly:  python3 backend/scripts/build_us_fundamentals.py
"""
import json
import os
import time

import requests

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(os.path.dirname(HERE), "data")
BASE = "https://finnhub.io/api/v1"


def _key() -> str:
    env = os.path.join(os.path.dirname(HERE), ".env")
    for line in open(env):
        if line.startswith("FINNHUB_API_KEY="):
            return line.split("=", 1)[1].strip().strip('"').strip("'")
    return os.getenv("FINNHUB_API_KEY", "")


_KEY = _key()
_session = requests.Session()


def _norm(t: str) -> str:
    return str(t).strip().upper().replace(".", "-")


# Finnhub's industry labels -> the screener's GICS sector list. Keyword-matched
# (first hit wins) so varied labels still resolve. Unmatched -> "" (blank).
_SECTOR_RULES = [
    ("Healthcare", ["pharmaceutical", "biotech", "health", "medical", "life scien", "drug"]),
    ("Financial Services", ["bank", "insurance", "financial", "capital market", "asset manage", "consumer financ"]),
    ("Technology", ["technology", "semiconductor", "software", "hardware", "electronic", "it servic"]),
    ("Communication Services", ["communication", "telecom", "media", "entertainment", "internet"]),
    ("Consumer Cyclical", ["retail", "automobile", "auto ", "apparel", "luxury", "hotel", "restaurant", "leisure", "homebuild", "travel", "e-commerce", "distributor", "consumer servic"]),
    ("Consumer Defensive", ["food", "beverage", "tobacco", "household", "personal product", "grocery", "staple", "consumer product"]),
    ("Energy", ["energy", "oil", "gas ", "petroleum"]),
    ("Utilities", ["utilit", "electric util", "water util"]),
    ("Real Estate", ["real estate", "reit"]),
    ("Basic Materials", ["chemical", "metal", "mining", "material", "paper", "forest", "steel", "packaging"]),
    ("Industrials", ["industrial", "machinery", "aerospace", "defense", "transport", "airline", "logistic", "construction", "engineering", "electrical equip", "building", "commercial servic", "professional servic", "trading", "road", "rail", "marine", "shipping"]),
]


def _to_gics(industry: str) -> str:
    s = (industry or "").lower()
    for sector, keys in _SECTOR_RULES:
        if any(k in s for k in keys):
            return sector
    return ""


def _exch(raw: str) -> str:
    s = (raw or "").upper()
    if "NASDAQ" in s:
        return "NASDAQ"
    if "NEW YORK" in s or s.startswith("NYSE"):
        return "NYSE"
    if "AMEX" in s or "AMERICAN" in s:
        return "AMEX"
    return ""


def _load_universe() -> list:
    d = json.load(open(os.path.join(DATA, "index_constituents.json")))
    seen, order = set(), []
    for k in ("nasdaq100", "sp500", "sp400"):          # majors first
        for t in d.get(k, []):
            n = _norm(t)
            if n and n not in seen:
                seen.add(n)
                order.append(n)
    return order


def _get(path: str, sym: str) -> dict:
    r = _session.get(f"{BASE}{path}", params={"symbol": sym, "metric": "all", "token": _KEY}, timeout=10)
    time.sleep(1.05)                                    # ~57 calls/min, under the 60/min free cap
    if r.status_code != 200:
        return {}
    try:
        return r.json() or {}
    except Exception:
        return {}


def _num(v, nd=2):
    return round(v, nd) if isinstance(v, (int, float)) else None


def _fetch(tk: str):
    m = (_get("/stock/metric", tk) or {}).get("metric", {})
    p = _get("/stock/profile2", tk)
    if not m and not p:
        return None
    mc = p.get("marketCapitalization") or m.get("marketCapitalization")   # $M
    sh = p.get("shareOutstanding")
    price = round(mc / sh, 2) if mc and sh else None
    ev_eb = m.get("currentEv/ebitdaTTM") or m.get("currentEv/ebitda")
    if mc is None and price is None and not m:
        return None
    return {
        "ticker": tk,
        "companyName": p.get("name") or tk,
        "price": price,
        "marketCap": round(mc / 1000, 2) if mc else None,        # $M -> $B
        "beta": _num(m.get("beta")),
        "sector": _to_gics(p.get("finnhubIndustry")),
        "industry": p.get("finnhubIndustry") or "",
        "exchange": _exch(p.get("exchange")),
        "country": "United States" if (p.get("country") in (None, "US", "USA", "")) else p.get("country"),
        "peRatio": _num(m.get("peTTM") or m.get("peBasicExclExtraTTM"), 1),
        "pbRatio": _num(m.get("pbQuarterly") or m.get("pbAnnual")),
        "psRatio": _num(m.get("psTTM") or m.get("psAnnual")),
        "evEbitda": _num(ev_eb, 1),
        "pegRatio": _num(m.get("pegTTM") or m.get("pegRatio")),
        "grossMargin": _num(m.get("grossMarginTTM") or m.get("grossMarginAnnual"), 1),
        "operatingMargin": _num(m.get("operatingMarginTTM") or m.get("operatingMarginAnnual"), 1),
        "netMargin": _num(m.get("netProfitMarginTTM") or m.get("netProfitMarginAnnual"), 1),
        "roe": _num(m.get("roeTTM") or m.get("roeRfy"), 1),
        "roa": _num(m.get("roaTTM") or m.get("roaRfy"), 1),
        "debtEquity": _num(m.get("totalDebt/totalEquityQuarterly") or m.get("totalDebt/totalEquityAnnual")),
        "currentRatio": _num(m.get("currentRatioQuarterly") or m.get("currentRatioAnnual")),
        "revenueGrowth": _num(m.get("revenueGrowthTTMYoy")),
        "epsGrowth": _num(m.get("epsGrowthTTMYoy")),
        "dividendYield": _num(m.get("dividendYieldIndicatedAnnual") or m.get("currentDividendYieldTTM")),
        "quickRatio": _num(m.get("quickRatioAnnual") or m.get("quickRatioQuarterly")),
        "inventoryTurnover": _num(m.get("inventoryTurnoverTTM") or m.get("inventoryTurnoverAnnual")),
        "receivablesTurnover": _num(m.get("receivablesTurnoverTTM") or m.get("receivablesTurnoverAnnual")),
        "interestCoverage": _num(m.get("netInterestCoverageTTM") or m.get("netInterestCoverageAnnual")),
        "payoutRatio": _num(m.get("payoutRatioAnnual") or m.get("payoutRatioTTM")),
    }


def main():
    if not _KEY:
        raise SystemExit("FINNHUB_API_KEY not found in backend/.env")
    uni = _load_universe()
    path = os.path.join(DATA, "us_fundamentals.json")
    out: dict = {}
    if os.path.exists(path):
        try:
            out = json.load(open(path))
        except Exception:
            out = {}
    todo = [t for t in uni if t not in out]
    print(f"start: {len(out)}/{len(uni)} already have, {len(todo)} to fetch (~{len(todo) * 2.2 / 60:.0f} min)")
    for i, tk in enumerate(todo):
        try:
            row = _fetch(tk)
        except Exception:
            row = None
        if row:
            out[tk] = row
        if (i + 1) % 20 == 0 or i == len(todo) - 1:
            json.dump(out, open(path, "w"), separators=(",", ":"), sort_keys=True)
            print(f"  {i + 1}/{len(todo)} fetched, {len(out)}/{len(uni)} total (last: {tk})")
    json.dump(out, open(path, "w"), separators=(",", ":"), sort_keys=True)
    missing = [t for t in uni if t not in out]
    print(f"wrote {len(out)}/{len(uni)} names -> {path}")
    if missing:
        print(f"still missing ({len(missing)}): {', '.join(missing[:40])}")


if __name__ == "__main__":
    main()
