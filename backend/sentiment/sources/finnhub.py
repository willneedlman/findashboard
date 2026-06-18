"""Finnhub general-news adapter (ported from the legacy `_fetch_finnhub`)."""
from __future__ import annotations

import os
import time
from typing import Any

import requests

from sentiment.config import SourceSpec
from sentiment.sources.base import FetchOutcome, timed_fetch


def _raw(limit: int) -> list[dict[str, Any]]:
    key = os.getenv("FINNHUB_API_KEY", "")
    if not key:
        raise RuntimeError("FINNHUB_API_KEY not configured")
    r = requests.get(
        "https://finnhub.io/api/v1/news",
        params={"category": "general", "token": key},
        timeout=10,
    )
    if r.status_code == 429:
        raise RuntimeError("finnhub rate limit")
    r.raise_for_status()
    items: list[dict[str, Any]] = []
    for item in r.json()[:limit]:
        headline = (item.get("headline") or "").strip()
        if not headline:
            continue
        items.append({
            "title": headline, "published_at": int(item.get("datetime", time.time())),
            "url": item.get("url", ""), "engagement_weight": 1.0,
        })
    return items


def fetch(spec: SourceSpec, limit: int) -> FetchOutcome:
    return timed_fetch(spec, lambda: _raw(limit))
