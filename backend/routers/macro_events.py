"""Macro Event Release Hub API.

Real US economic releases from FRED: the published schedule (recent + next
release date per series) plus the headline actual and the prior print. For each
released event the immediate market read is the release-day cross-asset move in
the S&P 500, the dollar index, and the 10-year yield, pulled from the shared
price cache. FRED does not publish consensus, so there is no expected figure and
none is invented. If FRED is unavailable the endpoint returns an empty feed and
the client falls back to its bundled seed.
"""
from __future__ import annotations

import logging
import os
import re
import sys
import time
from datetime import date, datetime, timedelta

import requests
from fastapi import APIRouter

sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))
import cache  # noqa: E402
import ff_calendar  # noqa: E402
import investing_calendar  # noqa: E402

logger = logging.getLogger(__name__)
router = APIRouter()

_FRED_KEY = os.getenv("FRED_API_KEY", "")
_FRED = "https://api.stlouisfed.org/fred"
_TTL = 6 * 3600
_RELEASE_TIME = "08:30"          # US data releases land at 08:30 ET
_TZ = "-04:00"                   # EDT for the current-season dates in scope

# Curated major US releases: display name, FRED release id (schedule) + headline
# series (value), how to render it, and where the print comes from.
_RELEASES = [
    {"key": "cpi", "name": "CPI Inflation", "release_id": 10, "series": "CPIAUCSL", "units": "pc1", "fmt": "yoy", "freq": "m", "impact": "High", "category": "Inflation", "source": "BLS", "url": "https://www.bls.gov/cpi/"},
    {"key": "corecpi", "name": "Core CPI Inflation", "release_id": 10, "series": "CPILFESL", "units": "pc1", "fmt": "yoy", "freq": "m", "impact": "High", "category": "Inflation", "source": "BLS", "url": "https://www.bls.gov/cpi/"},
    {"key": "ppi", "name": "PPI Final Demand", "release_id": 46, "series": "PPIFIS", "units": "pc1", "fmt": "yoy", "freq": "m", "impact": "Medium", "category": "Inflation", "source": "BLS", "url": "https://www.bls.gov/ppi/"},
    {"key": "pce", "name": "Core PCE Price Index", "release_id": 21, "series": "PCEPILFE", "units": "pc1", "fmt": "yoy", "freq": "m", "impact": "High", "category": "Inflation", "source": "BEA", "url": "https://www.bea.gov/data/personal-consumption-expenditures-price-index"},
    {"key": "nfp", "name": "Non-Farm Payrolls", "release_id": 50, "series": "PAYEMS", "units": "chg", "fmt": "k", "freq": "m", "impact": "High", "category": "Labor", "source": "BLS", "url": "https://www.bls.gov/ces/"},
    {"key": "unrate", "name": "Unemployment Rate", "release_id": 50, "series": "UNRATE", "units": "lin", "fmt": "pct", "freq": "m", "impact": "High", "category": "Labor", "source": "BLS", "url": "https://www.bls.gov/cps/"},
    {"key": "gdp", "name": "Real GDP Growth", "release_id": 53, "series": "A191RL1Q225SBEA", "units": "lin", "fmt": "pct", "freq": "q", "impact": "Medium", "category": "Growth", "source": "BEA", "url": "https://www.bea.gov/data/gdp/gross-domestic-product", "nowcast": "GDPNOW", "nowcast_label": "GDPNow"},
    {"key": "indpro", "name": "Industrial Production", "release_id": 13, "series": "INDPRO", "units": "pch", "fmt": "mom", "freq": "m", "impact": "Low", "category": "Growth", "source": "Federal Reserve", "url": "https://www.federalreserve.gov/releases/g17/current/", "time": "09:15"},
    {"key": "retail", "name": "Retail Sales", "release_id": 9, "series": "RSAFS", "units": "pch", "fmt": "mom", "freq": "m", "impact": "High", "category": "Growth", "source": "Census", "url": "https://www.census.gov/retail/marts/www/marts_current.pdf"},
    {"key": "claims", "name": "Initial Jobless Claims", "release_id": 180, "series": "ICSA", "units": "lin", "fmt": "claims_k", "freq": "w", "impact": "Medium", "category": "Labor", "source": "DOL", "url": "https://www.dol.gov/ui/data.pdf"},
    {"key": "contclaims", "name": "Continuing Claims", "release_id": 180, "series": "CCSA", "units": "lin", "fmt": "count_m", "freq": "w", "impact": "Low", "category": "Labor", "source": "DOL", "url": "https://www.dol.gov/ui/data.pdf"},
    {"key": "jolts", "name": "JOLTS Job Openings", "release_id": 192, "series": "JTSJOL", "units": "lin", "fmt": "k_m", "freq": "m", "impact": "Medium", "category": "Labor", "source": "BLS", "url": "https://www.bls.gov/jlt/", "time": "10:00"},
    {"key": "durable", "name": "Durable Goods Orders", "release_id": 95, "series": "DGORDER", "units": "pch", "fmt": "mom", "freq": "m", "impact": "Low", "category": "Growth", "source": "Census", "url": "https://www.census.gov/manufacturing/m3/"},
    {"key": "housing", "name": "Housing Starts", "release_id": 27, "series": "HOUST", "units": "lin", "fmt": "k_m", "freq": "m", "impact": "Low", "category": "Growth", "source": "Census", "url": "https://www.census.gov/construction/nrc/"},
    {"key": "umich", "name": "UMich Consumer Sentiment", "release_id": 91, "series": "UMCSENT", "units": "lin", "fmt": "idx", "freq": "m", "impact": "Low", "category": "Sentiment", "source": "UMich", "url": "http://www.sca.isr.umich.edu/", "time": "10:00"},
    {"key": "trade", "name": "Trade Balance", "release_id": 51, "series": "BOPGSTB", "units": "lin", "fmt": "bal_b", "freq": "m", "impact": "Low", "category": "Growth", "source": "BEA", "url": "https://www.bea.gov/data/intl-trade-investment/international-trade-goods-and-services"},
]

_MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]

# Release-day reaction assets: (yfinance ticker, display label, unit). We derive
# the reaction ourselves (no calendar source provides one) as the close-to-close
# move on the release day. One consistent global-risk set is used for EVERY event
# — US and international alike — so the columns stay identical across the tape and
# only three reliable tickers are ever pulled. A hot EU/Asia print still moves
# these (US futures, the dollar, Treasury yields), so the read stays meaningful.
_REACTION_ASSETS = [("SPY", "S&P 500", "%"), ("DX-Y.NYB", "DXY", "%"), ("^TNX", "US 10Y", "bp")]

# Consensus overlay: our release key -> (measure, {exact Investing titles},
# {exact FF titles}). Titles are matched exactly (period tag stripped) so a y/y
# print can never take a m/m consensus. Investing is tried first (wider range +
# explicit y/y labels), Forex Factory second; anything unmatched stays blank.
_CONSENSUS = {
    "cpi": ("yoy", {"cpi (yoy)"}, {"cpi y/y"}),
    "corecpi": ("yoy", {"core cpi (yoy)"}, {"core cpi y/y"}),
    "ppi": ("yoy", {"ppi (yoy)"}, {"ppi y/y"}),
    "pce": ("yoy", {"core pce price index (yoy)"}, {"core pce price index y/y"}),
    "nfp": ("k_signed", {"nonfarm payrolls"}, {"non-farm employment change"}),
    "unrate": ("pct", {"unemployment rate"}, {"unemployment rate"}),
    "claims": ("k_raw", {"initial jobless claims"}, {"unemployment claims"}),
    "contclaims": ("millions", {"continuing jobless claims"}, set()),
    "jolts": ("millions", {"jolts job openings"}, {"jolts job openings"}),
    "retail": ("mom", {"retail sales (mom)"}, {"retail sales m/m"}),
    "durable": ("mom", {"durable goods orders (mom)"}, {"durable goods orders m/m"}),
    "housing": ("millions", {"housing starts"}, set()),
    "umich": ("idx", {"michigan consumer sentiment"},
              {"prelim uom consumer sentiment", "revised uom consumer sentiment", "uom consumer sentiment"}),
    "trade": ("billions", {"trade balance"}, {"trade balance"}),
}


def _norm_consensus(measure: str, raw: str) -> str | None:
    """A source forecast string ('218K', '1,820K', '4.2%', '1.177M', '-71.6B')
    formatted to match our actual/previous display for that measure."""
    s = raw.replace(",", "").strip()
    m = re.search(r"-?\d+\.?\d*", s)
    if not m:
        return None
    n = float(m.group())
    u = s.upper()
    if measure == "yoy":
        return f"{n:.1f}% y/y"
    if measure == "mom":
        return f"{n:.1f}% m/m"
    if measure == "pct":
        return f"{n:.1f}%"
    if measure == "idx":
        return f"{n:.1f}"
    if measure == "k_signed":
        return f"{'+' if n >= 0 else ''}{n:.0f}K"
    if measure == "k_raw":
        return f"{n:.0f}K"
    if measure == "millions":
        val = n / 1000 if "K" in u else n
        return f"{val:.2f}M"
    if measure == "billions":
        val = n / 1000 if "M" in u else n
        return f"{'-$' if val < 0 else '$'}{abs(val):.1f}B"
    return None


def _consensus(inv: dict, ff: dict, key: str, date10: str) -> str | None:
    spec = _CONSENSUS.get(key)
    if not spec:
        return None
    measure, inv_titles, ff_titles = spec
    for t in inv_titles:
        raw = inv.get((t, date10))
        if raw:
            v = _norm_consensus(measure, raw)
            if v:
                return v
    for t in ff_titles:
        raw = ff.get(("USD", t, date10))
        if raw:
            v = _norm_consensus(measure, raw)
            if v:
                return v
    return None

_cache_payload: dict | None = None
_cache_at = 0.0


# ── FRED helpers ──────────────────────────────────────────────────────────────
def _fred_get(path: str, params: dict) -> dict:
    params = {**params, "api_key": _FRED_KEY, "file_type": "json"}
    last = None
    for _ in range(3):
        try:
            r = requests.get(f"{_FRED}/{path}", params=params, timeout=15)
            if r.status_code == 200:
                return r.json()
            last = r.status_code
        except requests.RequestException as ex:
            last = str(ex)
        time.sleep(0.6)
    logger.warning("FRED %s failed: %s", path, last)
    return {}


@cache.cached(ttl=_TTL, maxsize=64)
def _release_dates(release_id: int) -> list[str]:
    data = _fred_get("release/dates", {
        "release_id": release_id, "sort_order": "desc",
        "include_release_dates_with_no_data": "true", "limit": 30,
    })
    return [d["date"] for d in data.get("release_dates", [])]


@cache.cached(ttl=_TTL, maxsize=64)
def _series_obs(series: str, units: str, limit: int = 4) -> list[tuple[str, float]]:
    data = _fred_get("series/observations", {
        "series_id": series, "sort_order": "desc", "limit": limit, "units": units,
    })
    out = []
    for o in data.get("observations", []):
        try:
            out.append((o["date"], float(o["value"])))
        except (ValueError, KeyError):
            continue
    return out


# ── formatting ────────────────────────────────────────────────────────────────
def _fmt(fmt: str, v: float) -> str:
    if fmt in ("yoy", "mom"):
        return f"{v:.1f}% {'y/y' if fmt == 'yoy' else 'm/m'}"
    if fmt == "pct":
        return f"{v:.1f}%"
    if fmt == "k":
        return f"{'+' if v >= 0 else ''}{v:.0f}K"
    if fmt == "claims_k":       # weekly claims count -> "215K"
        return f"{v / 1000:.0f}K"
    if fmt == "count_m":        # raw count -> "1.81M" (continuing claims)
        return f"{v / 1e6:.2f}M"
    if fmt == "k_m":            # thousands -> "1.18M" (housing starts, JOLTS)
        return f"{v / 1000:.2f}M"
    if fmt == "bal_b":          # millions USD -> "-$77.6B" (trade balance)
        return f"{'-$' if v < 0 else '$'}{abs(v) / 1000:.1f}B"
    if fmt == "idx":            # index level -> "44.8"
        return f"{v:.1f}"
    return f"{v:.1f}"


def _period_label(obs_date: str, freq: str) -> str:
    y, m, d = obs_date.split("-")
    if freq == "q":
        return f"Q{(int(m) - 1) // 3 + 1} {y}"
    if freq == "w":
        return f"w/e {_MONTHS[int(m) - 1]} {int(d)}"
    return f"{_MONTHS[int(m) - 1]} {y}"


def _next_period_label(obs_date: str, freq: str) -> str:
    y, m, _ = obs_date.split("-")
    yi, mi = int(y), int(m)
    if freq == "q":
        q = (mi - 1) // 3 + 1
        return f"Q{q + 1} {yi}" if q < 4 else f"Q1 {yi + 1}"
    if freq == "w":
        nd = date.fromisoformat(obs_date) + timedelta(days=7)
        return f"w/e {_MONTHS[nd.month - 1]} {nd.day}"
    return f"{_MONTHS[mi % 12]} {yi + (1 if mi == 12 else 0)}"


# ── release-day market reaction ───────────────────────────────────────────────
def _price_closes(tickers: set[str], start: str):
    """Batched daily closes for a set of tickers (one cached download)."""
    if not tickers:
        return None
    try:
        df = cache.get_download(tuple(sorted(tickers)), start, date.today().isoformat())
    except Exception as ex:  # noqa: BLE001
        logger.warning("reaction download failed: %s", ex)
        return None
    if df is None or df.empty:
        return None
    return df["Close"] if "Close" in df else df


def _reaction(closes, assets: list, date10: str) -> list[dict]:
    """Cross-asset move on the release day for one event's asset set."""
    if closes is None:
        return []
    day = datetime.strptime(date10, "%Y-%m-%d").date()
    moves: list[dict] = []
    for ticker, label, unit in assets:
        if ticker not in closes:
            continue
        s = closes[ticker].dropna()
        after = s[s.index.date >= day]
        if after.empty:
            continue
        pos = s.index.get_loc(after.index[0])
        if not isinstance(pos, int) or pos < 1:
            continue
        cur, prev = float(s.iloc[pos]), float(s.iloc[pos - 1])
        if prev == 0:
            continue
        change = (cur - prev) * 100 if unit == "bp" else (cur / prev - 1) * 100
        moves.append({"asset": label, "change": round(change, 2 if unit == "%" else 1), "unit": unit})
    return moves


# ── build ─────────────────────────────────────────────────────────────────────
def _direction(actual: float, previous: float) -> str:
    if actual > previous:
        return "higher than"
    if actual < previous:
        return "lower than"
    return "level with"


# ── FOMC (reuses the Rate Engine's schedule + implied path) ───────────────────
def _fomc_range() -> tuple[str | None, str | None]:
    """(current, previous) fed funds target range from FRED. DFEDTARU/L only move
    at meetings, so the previous distinct range is the last value that differs."""
    up = _series_obs("DFEDTARU", "lin", limit=120)
    lo = _series_obs("DFEDTARL", "lin", limit=120)
    if not up or not lo:
        return None, None
    cur_u, cur_l = up[0][1], lo[0][1]
    current = f"{cur_l:.2f}-{cur_u:.2f}%"
    previous = current
    for (_, u), (_, l) in zip(up, lo):
        if u != cur_u or l != cur_l:
            previous = f"{l:.2f}-{u:.2f}%"
            break
    return current, previous


def _fomc_expectation(meeting_iso: str) -> str | None:
    """Market-implied call for a meeting from the Rate Engine's futures/curve path."""
    try:
        from routers.rates import fed_projections
        proj = fed_projections()
    except Exception as ex:  # noqa: BLE001
        logger.warning("fed_projections failed: %s", ex)
        return None
    ym = meeting_iso[:7]
    m = next((x for x in proj.get("meetings", []) if x.get("date") == ym), None)
    if not m:
        return None
    action, prob = max(
        (("Hold", m.get("prob_hold", 0)), ("Cut", m.get("prob_cut", 0)), ("Hike", m.get("prob_hike", 0))),
        key=lambda kp: kp[1],
    )
    return f"{action} ~{prob}%"


def _fomc_drafts(today: str) -> tuple[list[dict], str | None]:
    """Released (most recent) + upcoming (next) FOMC decision as event drafts."""
    from routers.rates import _FOMC_DATES
    current, previous = _fomc_range()
    if current is None:
        return [], None
    hist = [round(v, 3) for _, v in reversed(_series_obs("DFEDTARU", "lin", limit=8))]
    past = sorted([d for d in _FOMC_DATES if d <= today])
    future = sorted([d for d in _FOMC_DATES if d > today])
    drafts: list[dict] = []
    released_date: str | None = None
    meta = {"key": "fomc", "name": "FOMC Rate Decision", "category": "Central Bank",
            "impact": "High", "source": "Federal Reserve",
            "url": "https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm", "time": "14:00"}

    if past:
        released_date = past[-1]
        changed = current != previous
        verb = "held the target range at" if not changed else f"moved the target range from {previous} to"
        try:
            from routers.rates import _latest_fomc_statement
            stmt = _latest_fomc_statement()
            url = stmt[1] if stmt and stmt[0] == released_date else meta["url"]
        except Exception:  # noqa: BLE001
            url = meta["url"]
        drafts.append({"r": {**meta, "url": url}, "status": "released", "date": released_date,
                       "actual": current, "expected": None, "previous": previous,
                       "period": _period_label(released_date, "m"), "history": hist,
                       "summary": f"The FOMC {verb} {current}."})
    if future:
        nxt = future[0]
        exp = _fomc_expectation(nxt)
        drafts.append({"r": meta, "status": "upcoming", "date": nxt,
                       "actual": None, "expected": exp, "expected_label": "Mkt implied", "previous": current,
                       "period": _period_label(nxt, "m"), "history": hist,
                       "summary": f"Next FOMC decision. Current target range is {current}."
                                  + (f" Futures imply {exp}." if exp else "")})
    return drafts, released_date


def _fed_event_drafts(today: str, dates: list[str], meta: dict, summary: str) -> tuple[list[dict], str | None]:
    """Recent + next occurrence of a scheduled Fed event (Minutes, Beige Book).
    Qualitative: no numeric actual/consensus, just a released-day marker + move."""
    past = [d for d in dates if d <= today]
    future = [d for d in dates if d > today]
    drafts: list[dict] = []
    released_date: str | None = None
    if past:
        released_date = past[-1]
        drafts.append({"r": meta, "status": "released", "date": released_date,
                       "actual": "Released", "expected": None, "previous": "—",
                       "period": _period_label(released_date, "m"), "history": [], "summary": summary})
    if future:
        drafts.append({"r": meta, "status": "upcoming", "date": future[0],
                       "actual": None, "expected": None, "previous": "—",
                       "period": _period_label(future[0], "m"), "history": [], "summary": summary})
    return drafts, released_date


# EU/Asia marquee events, sourced from the Investing.com multi-country calendar.
# Matched by (currency, exact normalized title). fmt appends the basis so a value
# reads like the US rows; reactions use the shared _REACTION_ASSETS set.
def _i(key, name, region, country, ccode, cc, ccy, titles, category, impact, source, url, time, tzl, tzo, fmt, freq):
    return {"key": key, "name": name, "region": region, "country": country, "countryCode": ccode,
            "cc": cc, "ccy": ccy, "titles": titles, "category": category, "impact": impact,
            "source": source, "url": url, "time": time, "tz_label": tzl, "tz_offset": tzo, "fmt": fmt, "freq": freq}


_INTL = [
    _i("eu-cpi", "Eurozone CPI", "EU", "Eurozone", "EU", "EU", "EUR", {"cpi (yoy)"}, "Inflation", "High", "Eurostat", "https://ec.europa.eu/eurostat", "11:00", "CET", "+02:00", "yoy", "m"),
    _i("eu-gdp", "Eurozone GDP", "EU", "Eurozone", "EU", "EU", "EUR", {"gdp (qoq)"}, "Growth", "High", "Eurostat", "https://ec.europa.eu/eurostat", "11:00", "CET", "+02:00", "qoq", "q"),
    _i("ecb", "ECB Rate Decision", "EU", "Eurozone", "EU", "EU", "EUR", {"ecb interest rate decision", "deposit facility rate"}, "Central Bank", "High", "ECB", "https://www.ecb.europa.eu/press/govcdec/html/index.en.html", "14:15", "CET", "+02:00", "pct", "m"),
    _i("eu-unrate", "Eurozone Unemployment", "EU", "Eurozone", "EU", "EU", "EUR", {"unemployment rate"}, "Labor", "Medium", "Eurostat", "https://ec.europa.eu/eurostat", "11:00", "CET", "+02:00", "pct", "m"),
    _i("de-cpi", "German CPI", "EU", "Germany", "DE", "DE", "EUR", {"german cpi (yoy)"}, "Inflation", "Medium", "Destatis", "https://www.destatis.de", "08:00", "CET", "+02:00", "yoy", "m"),
    _i("de-ifo", "German ifo Business Climate", "EU", "Germany", "DE", "DE", "EUR", {"german ifo business climate index"}, "Sentiment", "Medium", "ifo Institute", "https://www.ifo.de", "10:00", "CET", "+02:00", "idx", "m"),
    _i("uk-cpi", "UK CPI", "EU", "United Kingdom", "UK", "UK", "GBP", {"cpi (yoy)"}, "Inflation", "High", "UK ONS", "https://www.ons.gov.uk", "07:00", "BST", "+01:00", "yoy", "m"),
    _i("uk-gdp", "UK GDP", "EU", "United Kingdom", "UK", "UK", "GBP", {"gdp (mom)"}, "Growth", "Medium", "UK ONS", "https://www.ons.gov.uk", "07:00", "BST", "+01:00", "mom", "m"),
    _i("boe", "BoE Rate Decision", "EU", "United Kingdom", "UK", "UK", "GBP", {"boe interest rate decision"}, "Central Bank", "High", "Bank of England", "https://www.bankofengland.co.uk", "12:00", "BST", "+01:00", "pct", "m"),
    _i("boj", "BoJ Rate Decision", "ASIA", "Japan", "JP", "JP", "JPY", {"boj interest rate decision"}, "Central Bank", "High", "Bank of Japan", "https://www.boj.or.jp/en/", "12:00", "JST", "+09:00", "pct", "m"),
    _i("jp-cpi", "Japan Core CPI", "ASIA", "Japan", "JP", "JP", "JPY", {"national core cpi (yoy)"}, "Inflation", "Medium", "Japan Stats", "https://www.stat.go.jp/english/", "08:30", "JST", "+09:00", "yoy", "m"),
    _i("cn-gdp", "China GDP", "ASIA", "China", "CN", "CN", "CNY", {"gdp (yoy)"}, "Growth", "High", "China NBS", "https://www.stats.gov.cn/english/", "10:00", "CST", "+08:00", "yoy", "q"),
    _i("cn-cpi", "China CPI", "ASIA", "China", "CN", "CN", "CNY", {"cpi (yoy)"}, "Inflation", "Medium", "China NBS", "https://www.stats.gov.cn/english/", "09:30", "CST", "+08:00", "yoy", "m"),
    _i("cn-pmi", "China Manufacturing PMI", "ASIA", "China", "CN", "CN", "CNY", {"manufacturing pmi"}, "Sentiment", "Medium", "China NBS", "https://www.stats.gov.cn/english/", "09:30", "CST", "+08:00", "idx", "m"),
]


def _fmt_intl(fmt: str, raw: str) -> str | None:
    raw = (raw or "").strip()
    if not raw:
        return None
    if fmt == "yoy":
        return f"{raw} y/y"
    if fmt == "qoq":
        return f"{raw} q/q"
    if fmt == "mom":
        return f"{raw} m/m"
    return raw


def _intl_drafts(today: str) -> list[dict]:
    """Recent released + next upcoming for each marquee EU/Asia event, from the
    Investing.com calendar. Fails soft to [] (US feed is unaffected)."""
    from collections import defaultdict
    rows = investing_calendar.calendar_rows()
    if not rows:
        return []
    by: dict[tuple[str, str], list[dict]] = defaultdict(list)
    for r in rows:
        if r["date"]:
            by[(r["ccy"], r["title"])].append(r)
    drafts: list[dict] = []
    for spec in _INTL:
        matches: list[dict] = []
        for t in spec["titles"]:
            matches += by.get((spec["ccy"], t), [])
        if not matches:
            continue
        matches.sort(key=lambda x: x["date"])
        past = [m for m in matches if m["date"] <= today and m["actual"].strip()]
        future = [m for m in matches if m["date"] > today]
        if past:
            m = past[-1]
            period = m["period"] or _period_label(m["date"], spec["freq"])
            drafts.append({"r": spec, "status": "released", "date": m["date"],
                           "actual": _fmt_intl(spec["fmt"], m["actual"]),
                           "expected": _fmt_intl(spec["fmt"], m["forecast"]),
                           "expected_label": "consensus" if m["forecast"].strip() else None,
                           "previous": _fmt_intl(spec["fmt"], m["previous"]) or "—",
                           "period": period, "history": [],
                           "summary": f"{spec['name']} for {period}, from the {spec['country']} calendar."})
        if future:
            m = future[0]
            period = m["period"] or _next_period_label(m["date"], spec["freq"])
            drafts.append({"r": spec, "status": "upcoming", "date": m["date"],
                           "actual": None,
                           "expected": _fmt_intl(spec["fmt"], m["forecast"]),
                           "expected_label": "consensus" if m["forecast"].strip() else None,
                           "previous": _fmt_intl(spec["fmt"], m["previous"]) or "—",
                           "period": period, "history": [],
                           "summary": f"Upcoming {spec['name']} release ({spec['country']})."})
    return drafts


def _conference_board_drafts(today: str) -> tuple[list[dict], str | None]:
    """Conference Board Consumer Confidence — a high-impact US print that FRED
    does NOT carry (Conference Board is a private release), so it is scheduled by
    rule instead: the last Tuesday of each month at 10:00 ET. Qualitative like the
    Fed drafts — no invented actual/consensus, just a released-day marker + move."""
    from routers.rates import _last_weekday
    base = date.today()
    months: list[tuple[int, int]] = []
    for off in (-1, 0, 1, 2):
        idx = (base.month - 1) + off
        months.append((base.year + idx // 12, idx % 12 + 1))
    dates = sorted(_last_weekday(y, m, 1).isoformat() for y, m in months)  # weekday 1 = Tuesday
    meta = {"key": "conf-board-confidence", "name": "Conference Board Consumer Confidence",
            "category": "Sentiment", "impact": "High", "source": "Conference Board",
            "url": "https://www.conference-board.org/topics/consumer-confidence", "time": "10:00"}
    return _fed_event_drafts(
        today, dates, meta,
        "The Conference Board's monthly read on US consumer confidence — a high-impact gauge of "
        "household sentiment and near-term spending intentions.")


def _build() -> dict:
    today = date.today().isoformat()
    events: list[dict] = []
    drafts: list[dict] = []

    for r in _RELEASES:
        dates = _release_dates(r["release_id"])
        if not dates:
            continue
        past = sorted([d for d in dates if d <= today])
        future = sorted([d for d in dates if d > today])
        obs = _series_obs(r["series"], r["units"], limit=8)
        if not obs:
            continue
        (obs_date, actual_v), previous = obs[0], (obs[1] if len(obs) > 1 else None)
        prev_v = previous[1] if previous else actual_v
        period = _period_label(obs_date, r["freq"])
        history = [round(v, 2) for _, v in reversed(obs)]   # oldest -> newest, for the sparkline

        if past:
            rel_date = past[-1]
            drafts.append({"r": r, "status": "released", "date": rel_date,
                           "actual": _fmt(r["fmt"], actual_v), "previous": _fmt(r["fmt"], prev_v),
                           "period": period, "history": history,
                           "summary": f"{r['name']} came in at {_fmt(r['fmt'], actual_v)} for {period}, "
                                      f"{_direction(actual_v, prev_v)} the {_fmt(r['fmt'], prev_v)} prior read."})
        if future:
            up_period = _next_period_label(obs_date, r["freq"])
            # Some releases have a free official nowcast that maps to the next print
            # (e.g. Atlanta Fed GDPNow for the upcoming GDP advance estimate).
            exp = exp_label = None
            nc_note = ""
            if r.get("nowcast"):
                nc = _series_obs(r["nowcast"], "lin", limit=1)
                if nc:
                    exp = _fmt(r["fmt"], nc[0][1])
                    exp_label = r["nowcast_label"]
                    nc_note = f" {exp_label} tracks {exp}."
            drafts.append({"r": r, "status": "upcoming", "date": future[0],
                           "actual": None, "expected": exp, "expected_label": exp_label,
                           "previous": _fmt(r["fmt"], actual_v), "period": up_period, "history": history,
                           "summary": f"Next {r['name']} release covers {up_period}. "
                                      f"The prior print was {_fmt(r['fmt'], actual_v)} for {period}." + nc_note})

    # FOMC decisions reuse the Rate Engine's schedule + implied path.
    fomc_drafts, _ = _fomc_drafts(today)
    drafts.extend(fomc_drafts)
    from routers.rates import _FOMC_DATES, _BEIGE_BOOK_DATES
    minutes_dates = sorted((date.fromisoformat(d) + timedelta(days=21)).isoformat() for d in _FOMC_DATES)
    for d_dates, meta, summ in [
        (minutes_dates,
         {"key": "fomc-minutes", "name": "FOMC Minutes", "category": "Central Bank", "impact": "Medium",
          "source": "Federal Reserve", "url": "https://www.federalreserve.gov/monetarypolicy/fomcminutes.htm", "time": "14:00"},
         "Minutes from the prior FOMC meeting, with the detail behind the policy decision and the range of member views."),
        (sorted(_BEIGE_BOOK_DATES),
         {"key": "beige-book", "name": "Fed Beige Book", "category": "Central Bank", "impact": "Low",
          "source": "Federal Reserve", "url": "https://www.federalreserve.gov/monetarypolicy/beige-book-default.htm", "time": "14:00"},
         "Anecdotal read on regional economic conditions, published two weeks before each FOMC meeting."),
    ]:
        fd, _ = _fed_event_drafts(today, d_dates, meta, summ)
        drafts.extend(fd)

    cb_drafts, _ = _conference_board_drafts(today)
    drafts.extend(cb_drafts)

    drafts.extend(_intl_drafts(today))

    inv = investing_calendar.consensus_map()
    ff = ff_calendar.consensus_map()

    # Reactions: one consistent asset set for every event, so a single small,
    # cached price download covers the whole tape (no per-region ticker pulls).
    rel = [d for d in drafts if d["status"] == "released"]
    tickers = {tk for tk, _, _ in _REACTION_ASSETS} if rel else set()
    start = (min((date.fromisoformat(d["date"]) for d in rel), default=date.today()) - timedelta(days=10)).isoformat()
    closes = _price_closes(tickers, start)

    for d in drafts:
        r = d["r"]
        t = r.get("time", _RELEASE_TIME)
        tz_off = r.get("tz_offset", _TZ)
        tz_lab = r.get("tz_label", "ET")
        # Consensus: an existing forecast (GDPNow, FOMC futures, intl) wins; otherwise
        # the free Investing.com / Forex Factory consensus where the measure matches.
        exp, exp_label = d.get("expected"), d.get("expected_label")
        if exp is None:
            c = _consensus(inv, ff, r["key"], d["date"])
            if c is not None:
                exp, exp_label = c, "consensus"
        events.append({
            "id": f"{r['key']}-{d['date']}",
            "name": f"{r['name']} ({d['period']})",
            "country": r.get("country", "United States"), "countryCode": r.get("countryCode", "US"),
            "region": r.get("region", "US"), "category": r["category"],
            "datetime": f"{d['date']}T{t}:00{tz_off}",
            "displayTime": f"{_MONTHS[int(d['date'][5:7]) - 1]} {int(d['date'][8:10])}, {d['date'][:4]} · {t} {tz_lab}",
            "impact": r["impact"], "status": d["status"],
            "actual": d["actual"], "expected": exp, "expectedLabel": exp_label,
            "previous": d["previous"], "history": d.get("history", []),
            "summary": d["summary"],
            "sourceName": r["source"], "sourceUrl": r["url"],
            "reactions": _reaction(closes, _REACTION_ASSETS, d["date"]) if d["status"] == "released" else [],
        })

    return {"events": events, "source": "FRED + Investing", "as_of": datetime.utcnow().isoformat() + "Z",
            "note": "US releases from FRED, EU/Asia from the Investing.com calendar, FOMC from the Rate Engine. Reaction is our own release-day close-to-close move in the S&P 500, dollar (DXY) and 10-year yield. Consensus is pulled from Investing.com / Forex Factory; it is only published a few days before a release, so events further out show a dash until then."}


@router.get("")
@router.get("/")
def macro_events() -> dict:
    global _cache_payload, _cache_at
    if not _FRED_KEY:
        return {"events": [], "source": "unavailable", "as_of": datetime.utcnow().isoformat() + "Z"}
    if _cache_payload and time.time() - _cache_at < _TTL:
        return _cache_payload
    payload = _build()
    if payload["events"]:
        _cache_payload, _cache_at = payload, time.time()
    return payload
