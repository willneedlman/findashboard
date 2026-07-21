"""Shared schema + retry helper for the multi-source news/social data collector.

Every source (Alpha Vantage, Marketaux, NewsData.io, StockTwits, Reddit, direct
RSS, SEC EDGAR) gets mapped into ONE NewsEvent shape here, so the aggregator —
and any downstream consumer, like a ticker move-explainer — never has to
special-case a source's native payload.
"""
from __future__ import annotations

import logging
import random
import time
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from typing import Any, Callable, TypeVar

logger = logging.getLogger(__name__)
T = TypeVar("T")


@dataclass
class NewsEvent:
    timestamp: datetime             # UTC
    source_name: str                # "AlphaVantage" | "Marketaux" | "NewsData" | "StockTwits" | "Reddit" | "CNBC" | "MarketWatch" | "WSJ" | "SEC EDGAR"
    ticker: str | None
    headline_or_text: str
    sentiment_score: float | None   # normalized -1 (bearish) .. +1 (bullish); None when the source carries no sentiment signal
    url: str | None
    raw_payload: dict[str, Any] = field(default_factory=dict, repr=False)


def event_to_dict(e: NewsEvent) -> dict:
    """JSON-safe dict for disk_cache (which json.dumps's everything) and for
    the API/CLI layer — timestamp becomes an ISO-8601 string."""
    d = asdict(e)
    d["timestamp"] = e.timestamp.isoformat()
    return d


def dict_to_event(d: dict) -> NewsEvent:
    d = dict(d)
    ts = d["timestamp"]
    d["timestamp"] = datetime.fromisoformat(ts) if isinstance(ts, str) else ts
    return NewsEvent(**d)


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


_RETRYABLE_STATUS = {429, 500, 502, 503, 504}
_CONN_ERRORS = {"ConnectionError", "Timeout", "ReadTimeout", "ConnectTimeout", "SSLError"}


def retry_with_backoff(fn: Callable[[], T], *, retries: int = 3, base: float = 0.5, cap: float = 6.0, label: str = "fetch") -> T:
    """Run fn(), retrying transient network/rate-limit failures with jittered
    exponential backoff. Raises the last exception if every attempt fails —
    callers wrap this in their own try/except and degrade to an empty result,
    since one source going down should never take the whole aggregation down."""
    attempt = 0
    while True:
        try:
            return fn()
        except Exception as exc:
            status = getattr(getattr(exc, "response", None), "status_code", None)
            retryable = (status in _RETRYABLE_STATUS) or (type(exc).__name__ in _CONN_ERRORS)
            if attempt >= retries or not retryable:
                raise
            delay = min(cap, base * (2 ** attempt)) + random.uniform(0, base)
            logger.warning("%s failed (%s); retry %d/%d in %.2fs", label, status or type(exc).__name__, attempt + 1, retries, delay)
            time.sleep(delay)
            attempt += 1
