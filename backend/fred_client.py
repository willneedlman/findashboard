"""Shared FRED (St. Louis Fed) client.

Thin wrapper over the free FRED observations API, used wherever a tool needs real
public macro/housing/credit series instead of a mock. Returns clean ascending
(date, value) pairs with the FRED missing marker (".") dropped. Every series is
cached for 12h — FRED updates daily at most, and this keeps the free key well
under any rate limit. When no key is configured, callers get None/empty and fall
back to their prior behaviour.
"""
from __future__ import annotations

import logging
import os
from datetime import date, datetime, timedelta

import requests

from cache import cached

_log = logging.getLogger(__name__)
_KEY = os.getenv("FRED_API_KEY", "")
_BASE = "https://api.stlouisfed.org/fred/series/observations"


def available() -> bool:
    return bool(_KEY)


@cached(ttl=12 * 3600, maxsize=256)
def series(series_id: str, months: int = 48) -> list[tuple[date, float]]:
    """Ascending [(date, value)] for a FRED series over the last `months`.

    Empty list on any failure or missing key, so callers degrade gracefully."""
    if not _KEY:
        return []
    start = (date.today() - timedelta(days=int(months * 31) + 45)).isoformat()
    try:
        r = requests.get(_BASE, params={
            "series_id": series_id, "observation_start": start,
            "api_key": _KEY, "file_type": "json", "sort_order": "asc",
        }, timeout=10)
        out: list[tuple[date, float]] = []
        for o in r.json().get("observations", []):
            v = o.get("value")
            if v in (".", "", None):
                continue
            try:
                out.append((datetime.strptime(o["date"], "%Y-%m-%d").date(), float(v)))
            except (ValueError, KeyError):
                continue
        return out
    except Exception as e:
        _log.warning("FRED fetch %s failed: %s", series_id, e)
        return []


def latest(series_id: str) -> tuple[date, float] | None:
    obs = series(series_id, months=6)
    return obs[-1] if obs else None


def as_of(obs: list[tuple[date, float]], when: date) -> float | None:
    """Value effective at `when` — the last observation on or before that month.
    Lets a quarterly/annual series (median price, income) fill a monthly axis."""
    val = None
    for d, v in obs:
        if d <= when:
            val = v
        else:
            break
    return val
