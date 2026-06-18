"""Reddit source adapter: PRAW when credentialed, else the public hot RSS feed.

Ported from the legacy `_fetch_reddit*`. PRAW failures fall back to RSS rather
than failing the outcome; a hard RSS HTTP error (incl. 429/403 throttling) is
raised so the reliability layer records it.
"""
from __future__ import annotations

import calendar
import math
import os
import re
import time
from typing import Any

import requests

from sentiment.config import SourceSpec
from sentiment.sources.base import FetchOutcome, timed_fetch

_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
                  "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
}


def _praw(sub_name: str, limit: int) -> list[dict[str, Any]]:
    """Authenticated fetch. Returns [] on any failure so the caller falls back to RSS."""
    try:
        import praw

        reddit = praw.Reddit(
            client_id=os.getenv("REDDIT_CLIENT_ID", ""),
            client_secret=os.getenv("REDDIT_CLIENT_SECRET", ""),
            user_agent=os.getenv("REDDIT_USER_AGENT", "FinanceDashboard/1.0"),
        )
        items: list[dict[str, Any]] = []
        for post in reddit.subreddit(sub_name).hot(limit=limit):
            title = (post.title or "").strip()
            if not title:
                continue
            eng = math.log1p(max(0, post.score)) * (post.upvote_ratio or 0.5)
            items.append({
                "title": title, "published_at": int(post.created_utc),
                "url": f"https://reddit.com{post.permalink}", "engagement_weight": round(eng, 3),
            })
        return items
    except Exception:
        return []


def _rss(sub_name: str, limit: int) -> list[dict[str, Any]]:
    import feedparser

    url = f"https://www.reddit.com/r/{sub_name}/hot/.rss?limit={min(limit, 100)}"
    r = requests.get(url, headers=_HEADERS, timeout=12)
    if r.status_code in (429, 403):
        raise RuntimeError(f"reddit RSS throttled ({r.status_code})")
    r.raise_for_status()
    feed = feedparser.parse(r.text)
    now = int(time.time())
    items: list[dict[str, Any]] = []
    for e in feed.entries[:limit]:
        title = re.sub(r'\s*:\s*$', '', (e.get("title") or "").strip()).strip()
        if not title or title.lower().startswith("posted by"):
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


def _raw(spec: SourceSpec, limit: int) -> list[dict[str, Any]]:
    if os.getenv("REDDIT_CLIENT_ID") and os.getenv("REDDIT_CLIENT_SECRET"):
        items = _praw(spec.target, limit)
        if items:
            return items
    return _rss(spec.target, limit)


def fetch(spec: SourceSpec, limit: int) -> FetchOutcome:
    return timed_fetch(spec, lambda: _raw(spec, limit))
