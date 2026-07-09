"""Forex Factory public calendar feed — the free consensus overlay.

FF publishes its calendar as a plain JSON feed (no key). Each row carries a
curated ``forecast`` field, which is the market consensus FF shows on its
calendar. We use it only to fill the consensus/estimate for events whose measure
maps cleanly to one of ours; FRED remains the source of actuals and the schedule.

The feed rate-limits aggressive polling (429), so this module caches for several
hours and fails soft (returns an empty map) on any error, leaving consensus blank
rather than wrong.
"""
from __future__ import annotations

import logging
import re
import threading
import time

import requests

logger = logging.getLogger(__name__)

_URLS = [
    "https://nfs.faireconomy.media/ff_calendar_thisweek.json",
    "https://nfs.faireconomy.media/ff_calendar_nextweek.json",
]
_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36"
_TTL = 3 * 3600

_lock = threading.Lock()
_cache: dict[tuple[str, str, str], str] = {}
_cache_at = 0.0


def _fetch() -> dict[tuple[str, str, str], str]:
    """(country, title_lower, date10) -> forecast string. Empty on any failure."""
    out: dict[tuple[str, str, str], str] = {}
    for url in _URLS:
        try:
            r = requests.get(url, headers={"User-Agent": _UA}, timeout=20)
            if r.status_code != 200 or not r.text.strip().startswith("["):
                logger.info("FF feed %s -> %s (skipped)", url.rsplit("/", 1)[-1], r.status_code)
                continue
            for e in r.json():
                fc = (e.get("forecast") or "").strip()
                if not fc:
                    continue
                title = (e.get("title") or "").strip().lower()
                day = (e.get("date") or "")[:10]
                if title and day:
                    out[(e.get("country", ""), title, day)] = fc
        except Exception as ex:  # noqa: BLE001
            logger.warning("FF feed fetch failed: %s", ex)
    return out


def consensus_map() -> dict[tuple[str, str, str], str]:
    global _cache, _cache_at
    with _lock:
        if _cache and time.time() - _cache_at < _TTL:
            return _cache
    fresh = _fetch()
    with _lock:
        if fresh:                       # keep the last good map on a failed refresh
            _cache, _cache_at = fresh, time.time()
        return _cache


def parse_value(s: str) -> float | None:
    """FF forecast strings ('110K', '4.2%', '0.3%', '7.32M') -> the display number."""
    m = re.search(r"-?\d+\.?\d*", s.replace(",", ""))
    return float(m.group()) if m else None
