"""Investing.com economic-calendar consensus overlay.

Investing publishes forecast + previous for a custom date range via an AJAX
endpoint that returns HTML rows. It reaches far more of our upcoming events than
the Forex Factory week-ahead feed and labels the y/y vs m/m basis explicitly, so
matches stay measure-safe. Best-effort: on any block (Cloudflare) or format
change it returns an empty map and consensus falls back to Forex Factory / blank.
"""
from __future__ import annotations

import json
import logging
import threading
import time
from datetime import date, timedelta

import requests
from bs4 import BeautifulSoup

logger = logging.getLogger(__name__)

_URL = "https://www.investing.com/economic-calendar/Service/getCalendarFilteredData"
_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36"
_TTL = 2 * 3600

_lock = threading.Lock()
_cache: dict[tuple[str, str], str] = {}
_cache_at = 0.0


def _fetch() -> dict[tuple[str, str], str]:
    """(normalized_title, date10) -> forecast string, for US events over ~60 days."""
    today = date.today()
    body = (
        "country%5B%5D=5&importance%5B%5D=1&importance%5B%5D=2&importance%5B%5D=3"
        "&timeZone=8&timeFilter=timeRemain&currentTab=custom"
        f"&dateFrom={today.isoformat()}&dateTo={(today + timedelta(days=60)).isoformat()}&limit_from=0"
    )
    headers = {"User-Agent": _UA, "X-Requested-With": "XMLHttpRequest",
               "Content-Type": "application/x-www-form-urlencoded",
               "Referer": "https://www.investing.com/economic-calendar/"}
    out: dict[tuple[str, str], str] = {}
    try:
        r = requests.post(_URL, headers=headers, data=body, timeout=20)
        if r.status_code != 200:
            logger.info("Investing calendar -> %s", r.status_code)
            return out
        html = json.loads(r.text).get("data", "")
        soup = BeautifulSoup(html, "html.parser")
        for tr in soup.select("tr.js-event-item"):
            title_el = tr.select_one("td.event")
            fore_el = tr.select_one("td.fore")
            if not title_el or not fore_el:
                continue
            fc = fore_el.get_text(strip=True)
            if not fc:
                continue
            title = _normalize(title_el.get_text(strip=True))
            day = (tr.get("data-event-datetime", "") or "")[:10]
            if title and day:
                out[(title, day)] = fc
    except Exception as ex:  # noqa: BLE001
        logger.warning("Investing calendar fetch failed: %s", ex)
    return out


def _normalize(title: str) -> str:
    """Drop the trailing period tag ('(Jun)', '(Q2)') and lowercase, so an exact
    match compares the measure only: 'Core CPI (YoY)  (Jun)' -> 'core cpi (yoy)'."""
    t = title.strip()
    # remove a trailing "(Jun)"/"(Q2)"/"(Jul)" style period marker
    if t.endswith(")"):
        cut = t.rfind("(")
        if cut > 0 and len(t) - cut <= 6:
            t = t[:cut].strip()
    return " ".join(t.lower().split())


def consensus_map() -> dict[tuple[str, str], str]:
    global _cache, _cache_at
    with _lock:
        if _cache and time.time() - _cache_at < _TTL:
            return _cache
    fresh = _fetch()
    with _lock:
        if fresh:
            _cache, _cache_at = fresh, time.time()
        return _cache
