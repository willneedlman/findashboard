"""FINRA equity short interest — free biweekly CDN files, no auth, no key.

FINRA publishes a consolidated short-interest file (all reporting venues, not
just OTC despite the URL path) at a fixed biweekly cadence tied to Reg SHO
settlement dates (the 15th and last calendar day of each month, backed off to
the prior weekday on a weekend). There is no per-symbol API — the file is the
whole market (~20k+ symbols, ~2MB), so this fetches and parses it once per
release and serves per-ticker lookups from the cached parse.

Not published yet returns 403 (not 404), which is how the latest-available
date is detected: walk backward through candidate settlement dates until one
succeeds.
"""
from __future__ import annotations

import calendar
import csv
import io
import logging
from datetime import date, timedelta

import requests

try:
    from disk_cache import disk_get, disk_set
except ImportError:  # pragma: no cover
    def disk_get(_k): return None
    def disk_set(_k, _v, ttl=0): pass

logger = logging.getLogger(__name__)

_BASE = "https://cdn.finra.org/equity/otcmarket/biweekly"
_TIMEOUT = 20
_CACHE_KEY = "finra_short_interest:v1"
_CACHE_TTL = 4 * 24 * 3600   # file only changes biweekly; recheck well before the next one


def _prior_weekday(d: date) -> date:
    while d.weekday() >= 5:
        d -= timedelta(days=1)
    return d


def _candidate_dates(months_back: int = 4) -> list[date]:
    """Settlement dates most-recent-first: the last day and the 15th of each
    of the last few months, so the first successful fetch is the latest
    published file."""
    today = date.today()
    y, m = today.year, today.month
    out: set[date] = set()
    for _ in range(months_back):
        last_day = calendar.monthrange(y, m)[1]
        out.add(_prior_weekday(date(y, m, last_day)))
        out.add(_prior_weekday(date(y, m, 15)))
        m -= 1
        if m == 0:
            m, y = 12, y - 1
    return sorted((d for d in out if d <= today), reverse=True)


def _fetch_file(d: date) -> str | None:
    url = f"{_BASE}/shrt{d.strftime('%Y%m%d')}.csv"
    try:
        r = requests.get(url, timeout=_TIMEOUT)
        if r.status_code == 200:
            return r.text
        return None   # 403 = not published yet; treat any non-200 the same way
    except Exception as exc:
        logger.warning("short interest fetch failed for %s: %s", d, exc)
        return None


def _parse(text: str) -> dict[str, dict]:
    by_symbol: dict[str, dict] = {}
    reader = csv.DictReader(io.StringIO(text), delimiter="|")
    for row in reader:
        sym = (row.get("symbolCode") or "").strip().upper()
        if not sym:
            continue

        def _int(key: str) -> int | None:
            v = (row.get(key) or "").strip()
            try:
                return int(v) if v else None
            except ValueError:
                return None

        def _float(key: str) -> float | None:
            v = (row.get(key) or "").strip()
            try:
                return float(v) if v else None
            except ValueError:
                return None

        by_symbol[sym] = {
            "issuer_name": row.get("issueName"),
            "exchange": row.get("marketClassCode"),
            "current_short_position": _int("currentShortPositionQuantity"),
            "previous_short_position": _int("previousShortPositionQuantity"),
            "avg_daily_volume": _int("averageDailyVolumeQuantity"),
            "days_to_cover": _float("daysToCoverQuantity"),
            "change_pct": _float("changePercent"),
            "settlement_date": row.get("settlementDate"),
        }
    return by_symbol


def _load_latest() -> dict:
    cached = disk_get(_CACHE_KEY)
    if cached is not None:
        return cached
    settlement = None
    by_symbol: dict[str, dict] = {}
    for d in _candidate_dates():
        text = _fetch_file(d)
        if text:
            settlement = d.isoformat()
            by_symbol = _parse(text)
            break
    result = {"settlement_date": settlement, "by_symbol": by_symbol}
    # Cache even a miss briefly so a bad run doesn't hammer the CDN on every request.
    disk_set(_CACHE_KEY, result, ttl=_CACHE_TTL if by_symbol else 3600)
    return result


def short_interest_for_ticker(ticker: str) -> dict | None:
    """Latest published short-interest snapshot for one symbol, or None if
    the symbol isn't in the file (thinly-traded/delisted) or nothing has
    been published yet in the lookback window."""
    symbol = (ticker or "").strip().upper()
    if not symbol:
        return None
    data = _load_latest()
    row = data["by_symbol"].get(symbol)
    if not row:
        return None
    return {
        **row,
        "source": "FINRA",
        "source_url": "https://www.finra.org/finra-data/browse-catalog/equity-short-interest",
    }
