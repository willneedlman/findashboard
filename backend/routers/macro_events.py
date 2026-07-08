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
import sys
import time
from datetime import date, datetime

import requests
from fastapi import APIRouter

sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))
import cache  # noqa: E402

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
    {"key": "gdp", "name": "Real GDP Growth", "release_id": 53, "series": "A191RL1Q225SBEA", "units": "lin", "fmt": "pct", "freq": "q", "impact": "Medium", "category": "Growth", "source": "BEA", "url": "https://www.bea.gov/data/gdp/gross-domestic-product"},
    {"key": "indpro", "name": "Industrial Production", "release_id": 13, "series": "INDPRO", "units": "pch", "fmt": "mom", "freq": "m", "impact": "Low", "category": "Growth", "source": "Federal Reserve", "url": "https://www.federalreserve.gov/releases/g17/current/", "time": "09:15"},
]

_MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]

# release-day reaction: (yfinance ticker, display label, unit)
_REACTION_ASSETS = [("SPY", "S&P 500", "%"), ("DX-Y.NYB", "DXY", "%"), ("^TNX", "US 10Y", "bp")]

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
def _series_obs(series: str, units: str) -> list[tuple[str, float]]:
    data = _fred_get("series/observations", {
        "series_id": series, "sort_order": "desc", "limit": 4, "units": units,
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
    return f"{v:.1f}"


def _period_label(obs_date: str, freq: str) -> str:
    y, m, _ = obs_date.split("-")
    if freq == "q":
        return f"Q{(int(m) - 1) // 3 + 1} {y}"
    return f"{_MONTHS[int(m) - 1]} {y}"


def _next_period_label(obs_date: str, freq: str) -> str:
    y, m, _ = obs_date.split("-")
    yi, mi = int(y), int(m)
    if freq == "q":
        q = (mi - 1) // 3 + 1
        return f"Q{q + 1} {yi}" if q < 4 else f"Q1 {yi + 1}"
    return f"{_MONTHS[mi % 12]} {yi + (1 if mi == 12 else 0)}"


# ── release-day market reaction ───────────────────────────────────────────────
def _reactions_for(dates: list[str]) -> dict[str, list[dict]]:
    """Map each release date to the cross-asset move on that trading day."""
    if not dates:
        return {}
    start = (min(datetime.strptime(d, "%Y-%m-%d").date() for d in dates)).replace(day=1).isoformat()
    end = date.today().isoformat()
    try:
        df = cache.get_download(tuple(t for t, _, _ in _REACTION_ASSETS), start, end)
    except Exception as ex:  # noqa: BLE001
        logger.warning("reaction download failed: %s", ex)
        return {}
    if df is None or df.empty:
        return {}
    closes = df["Close"] if "Close" in df else df
    out: dict[str, list[dict]] = {}
    for d in dates:
        day = datetime.strptime(d, "%Y-%m-%d").date()
        moves: list[dict] = []
        for ticker, label, unit in _REACTION_ASSETS:
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
        if moves:
            out[d] = moves
    return out


# ── build ─────────────────────────────────────────────────────────────────────
def _direction(actual: float, previous: float) -> str:
    if actual > previous:
        return "higher than"
    if actual < previous:
        return "lower than"
    return "level with"


def _build() -> dict:
    today = date.today().isoformat()
    events: list[dict] = []
    released_dates: list[str] = []
    drafts: list[dict] = []

    for r in _RELEASES:
        dates = _release_dates(r["release_id"])
        if not dates:
            continue
        past = sorted([d for d in dates if d <= today])
        future = sorted([d for d in dates if d > today])
        obs = _series_obs(r["series"], r["units"])
        if not obs:
            continue
        (obs_date, actual_v), previous = obs[0], (obs[1] if len(obs) > 1 else None)
        prev_v = previous[1] if previous else actual_v
        period = _period_label(obs_date, r["freq"])

        if past:
            rel_date = past[-1]
            released_dates.append(rel_date)
            drafts.append({"r": r, "status": "released", "date": rel_date,
                           "actual": _fmt(r["fmt"], actual_v), "previous": _fmt(r["fmt"], prev_v),
                           "period": period,
                           "summary": f"{r['name']} came in at {_fmt(r['fmt'], actual_v)} for {period}, "
                                      f"{_direction(actual_v, prev_v)} the {_fmt(r['fmt'], prev_v)} prior read."})
        if future:
            up_period = _next_period_label(obs_date, r["freq"])
            drafts.append({"r": r, "status": "upcoming", "date": future[0],
                           "actual": None, "previous": _fmt(r["fmt"], actual_v), "period": up_period,
                           "summary": f"Next {r['name']} release covers {up_period}. "
                                      f"The prior print was {_fmt(r['fmt'], actual_v)} for {period}."})

    reactions = _reactions_for(released_dates)

    for d in drafts:
        r = d["r"]
        t = r.get("time", _RELEASE_TIME)
        events.append({
            "id": f"{r['key']}-{d['date']}",
            "name": f"{r['name']} ({d['period']})",
            "country": "United States", "countryCode": "US", "region": "US",
            "category": r["category"],
            "datetime": f"{d['date']}T{t}:00{_TZ}",
            "displayTime": f"{_MONTHS[int(d['date'][5:7]) - 1]} {int(d['date'][8:10])}, {d['date'][:4]} · {t} ET",
            "impact": r["impact"], "status": d["status"],
            "actual": d["actual"], "expected": None, "previous": d["previous"],
            "summary": d["summary"],
            "sourceName": r["source"], "sourceUrl": r["url"],
            "reactions": reactions.get(d["date"], []) if d["status"] == "released" else [],
        })

    return {"events": events, "source": "FRED", "as_of": datetime.utcnow().isoformat() + "Z",
            "note": "Live US releases from FRED. Reaction is the release-day cross-asset move. Consensus is not published on this data tier."}


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
