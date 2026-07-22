"""Expand backend/data/us_fundamentals.json beyond S&P 500 + S&P 400 + Nasdaq 100
with two more candidate sources:

  1. Recent IPOs (trailing ~12 months) from Finnhub's /calendar/ipo, status
     "priced" (completed) only — new listings large enough to matter haven't
     had time to be added to an index yet, so the base build script's
     S&P/Nasdaq universe misses them entirely.
  2. A curated list of large, liquid ADRs (foreign companies trading on
     NYSE/Nasdaq via American Depositary Receipt) — foreign domicile makes
     these ineligible for S&P 500 regardless of size, and they're not
     reliably enumerable from any single free source, so this is a
     hand-picked list of well-known large names, not an exhaustive scan.

Reuses build_us_fundamentals.py's exact fetch/merge/save pattern (same two
Finnhub calls per name, same ~57/min pacing, same incremental-save safety) so
the two seed sources stay in one consistent schema. Re-runnable: only fetches
symbols not already in the file.

Run:  python3 backend/scripts/expand_us_fundamentals.py
"""
import json
import os
import sys
import time
from datetime import date, timedelta

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


def _get(path: str, params: dict) -> dict:
    p = dict(params)
    p["token"] = _KEY
    r = _session.get(f"{BASE}{path}", params=p, timeout=10)
    time.sleep(1.05)   # ~57 calls/min, under the 60/min free cap — same pace as build_us_fundamentals.py
    if r.status_code != 200:
        return {}
    try:
        return r.json() or {}
    except Exception:
        return {}


def _num(v, nd=2):
    return round(v, nd) if isinstance(v, (int, float)) else None


def _fetch(tk: str):
    m = (_get("/stock/metric", {"symbol": tk, "metric": "all"}) or {}).get("metric", {})
    p = _get("/stock/profile2", {"symbol": tk})
    if not m and not p:
        return None
    # profile2 can resolve a foreign ADR (TSM, TM, BABA, ASML, …) to its
    # overseas PRIMARY listing, reporting marketCapitalization in THAT
    # market's local currency (TWD, JPY, CNY, EUR, …), not USD — same field
    # shape either way, so a naive read is silently wrong by the FX rate
    # (e.g. TSM came back as a $59T market cap). No live FX conversion here,
    # so treat non-USD as unknown rather than report a corrupted figure.
    currency = p.get("currency")
    non_usd = currency not in (None, "USD")
    mc = None if non_usd else (p.get("marketCapitalization") or m.get("marketCapitalization"))   # $M
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


# ── Candidate source 1: recent IPOs ─────────────────────────────────────────

_MIN_IPO_RAISE = 500_000_000   # $500M+ offering size — the calendar's `totalSharesValue`
                                 # is money raised, not resulting market cap, but it's the
                                 # only free signal available before a full profile fetch,
                                 # and it's enough to separate genuinely major listings from
                                 # the much larger volume of small-cap/SPAC noise (a typical
                                 # trailing-12-month window is 300+ IPOs; most raise well
                                 # under $100M).


def _ipo_candidates(months_back: int = 12) -> list:
    """Finnhub /calendar/ipo, chunked into <=30-day windows (its own 200-row
    cap), status == priced (completed listings) only, filtered to raises
    >= _MIN_IPO_RAISE — expected/withdrawn rows have no real company to seed,
    and most of the volume in any given window is small enough to be out of
    scope for a large-cap filter anyway."""
    end = date.today()
    start = end - timedelta(days=months_back * 30)
    syms, seen = [], set()
    cur = start
    while cur <= end:
        chunk_end = min(cur + timedelta(days=29), end)
        d = _get("/calendar/ipo", {"from": cur.isoformat(), "to": chunk_end.isoformat()})
        for r in (d.get("ipoCalendar") or []):
            sym = _norm(r.get("symbol") or "")
            status = (r.get("status") or "").lower()
            raise_amt = r.get("totalSharesValue") or 0
            if sym and status == "priced" and raise_amt >= _MIN_IPO_RAISE and sym not in seen:
                seen.add(sym)
                syms.append(sym)
        cur = chunk_end + timedelta(days=1)
    return syms


# ── Candidate source 2: curated large ADRs ──────────────────────────────────
# Well-known, liquid, NYSE/Nasdaq-listed ADRs of foreign-domiciled companies —
# foreign domicile makes these ineligible for S&P 500 regardless of size, and
# no free API in this app enumerates "all ADRs", so this is hand-picked, not
# exhaustive. Skews toward names large/liquid enough to plausibly matter for
# an earnings-calendar market-cap filter.
_ADR_CANDIDATES = [
    # Semiconductors / tech
    "TSM", "ASML", "SAP", "INFY", "WIT", "STM", "ERIC", "NOK", "LOGI",
    # China / Asia consumer & internet
    "BABA", "JD", "PDD", "BIDU", "NTES", "TCOM", "BEKE", "YUMC", "TME",
    "SE", "GRAB", "MELI",
    # Europe consumer & industrials
    "UL", "DEO", "BUD", "NSRGY", "LVMUY", "ADDYY", "PUM", "RACE",
    # Energy
    "SHEL", "BP", "TTE", "E", "EQNR", "PBR", "SU",
    # Pharma / healthcare
    "NVS", "AZN", "SNY", "NVO", "GSK", "TAK", "RHHBY", "TEVA",
    # Financials
    "HSBC", "ING", "DB", "UBS", "BCS", "MUFG", "SMFG", "MFG",
    "IBN", "HDB", "SAN", "BBVA", "ITUB", "BBD",
    # Industrials / autos / materials
    "TM", "HMC", "RIO", "BHP", "VALE", "SONY", "SIEGY", "VWAGY",
    # Telecom
    "TEF", "VOD", "AMX", "TU", "ORAN",
]


def gather_candidates() -> list:
    print("fetching IPO calendar candidates...")
    ipo = _ipo_candidates()
    print(f"  {len(ipo)} priced IPOs in the trailing 12 months")
    adr = [_norm(t) for t in _ADR_CANDIDATES]
    print(f"  {len(adr)} curated ADR candidates")
    seen, out = set(), []
    for t in ipo + adr:
        if t not in seen:
            seen.add(t)
            out.append(t)
    return out


def main():
    if not _KEY:
        raise SystemExit("FINNHUB_API_KEY not found in backend/.env")
    path = os.path.join(DATA, "us_fundamentals.json")
    out: dict = {}
    if os.path.exists(path):
        try:
            out = json.load(open(path))
        except Exception:
            out = {}

    candidates = gather_candidates()
    todo = [t for t in candidates if t not in out]
    print(f"start: {len(out)} existing, {len(todo)} new candidates to fetch (~{len(todo) * 2.2 / 60:.0f} min)")
    added = 0
    for i, tk in enumerate(todo):
        try:
            row = _fetch(tk)
        except Exception:
            row = None
        if row:
            out[tk] = row
            added += 1
        if (i + 1) % 20 == 0 or i == len(todo) - 1:
            json.dump(out, open(path, "w"), separators=(",", ":"), sort_keys=True)
            print(f"  {i + 1}/{len(todo)} fetched, {added} added so far, {len(out)} total (last: {tk})")
    print(f"done: {added}/{len(todo)} new entries added, {len(out)} total in seed")


if __name__ == "__main__":
    main()
