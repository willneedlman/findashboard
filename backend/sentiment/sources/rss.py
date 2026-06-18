"""RSS source adapter (ported from the legacy `_fetch_rss`)."""
from __future__ import annotations

import calendar
import time
from typing import Any

import certifi
import requests

from sentiment.config import SourceSpec
from sentiment.sources.base import FetchOutcome, timed_fetch

_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
                  "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
}
_CA_BUNDLE = certifi.where()


def _raw(spec: SourceSpec, limit: int) -> list[dict[str, Any]]:
    import feedparser

    r = requests.get(spec.target, headers=_HEADERS, timeout=10, verify=_CA_BUNDLE)
    r.raise_for_status()
    feed = feedparser.parse(r.text)
    now = int(time.time())
    items: list[dict[str, Any]] = []
    for e in feed.entries[:limit]:
        title = (e.get("title") or "").strip()
        if not title:
            continue
        pub_at = now
        if e.get("published_parsed"):
            try:
                pub_at = int(calendar.timegm(e.published_parsed))
            except Exception:
                pass
        items.append({
            "title": title, "published_at": pub_at,
            "url": e.get("link", ""), "engagement_weight": 1.0,
        })
    return items


def fetch(spec: SourceSpec, limit: int) -> FetchOutcome:
    return timed_fetch(spec, lambda: _raw(spec, limit))
