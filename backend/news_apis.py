"""News-API integrations: Alpha Vantage News & Sentiment, Marketaux, NewsData.io.

Alpha Vantage shares the SAME account/key as backend/alphavantage.py's price-
history fallback — the free tier is a hard 25 requests/DAY for the whole
account, not per feature. This module tracks its own conservative sub-budget
(15/day) so it can never by itself exhaust the shared cap the price fallback
also depends on.

Marketaux and NewsData.io need their own free-tier API keys (MARKETAUX_API_KEY,
NEWSDATA_API_KEY in .env) — signing up is something only you can do, not a
script. Both no-op (available() False, empty results) until a real key is
present, same convention as every other optional provider in this backend
(serpapi_finance, alphavantage, etc.).

NewsData.io's free tier delays articles by 12 HOURS — it is not a real-time
source. It's implemented because it was asked for, but the aggregator ranks it
last and it should not be relied on for "what's moving this ticker right now."
"""
from __future__ import annotations

import datetime as _dt
import logging
import os
import threading

import requests
from dotenv import load_dotenv

from disk_cache import disk_get, disk_set
from social_schema import NewsEvent, dict_to_event, event_to_dict, retry_with_backoff, utc_now

load_dotenv(os.path.join(os.path.dirname(__file__), ".env"))

logger = logging.getLogger(__name__)
_TIMEOUT = 15
_UA = {"User-Agent": "Alphatape Research admin@alphatape.app"}
_CACHE_TTL = 900   # 15 min — real news doesn't turn over faster than this on a free key


def _cached_events(cache_key: str) -> list[NewsEvent] | None:
    raw = disk_get(cache_key)
    return [dict_to_event(d) for d in raw] if raw is not None else None


def _store_events(cache_key: str, events: list[NewsEvent], ttl: int = _CACHE_TTL) -> None:
    disk_set(cache_key, [event_to_dict(e) for e in events], ttl=ttl)


# ── Alpha Vantage News & Sentiment ───────────────────────────────────────────
_AV_DAILY_CAP = 15   # conservative sub-budget of the account-wide 25/day cap
_av_lock = threading.Lock()


def alphavantage_available() -> bool:
    key = os.getenv("ALPHAVANTAGE_API_KEY", "")
    return bool(key and key != "your_key_here")


def _av_consume() -> bool:
    with _av_lock:
        key = f"av_news:usage:{_dt.date.today().isoformat()}"
        used = int(disk_get(key) or 0)
        if used >= _AV_DAILY_CAP:
            return False
        disk_set(key, used + 1, ttl=26 * 3600)
        return True


def _parse_av_time(raw: str | None) -> _dt.datetime:
    if not raw:
        return utc_now()
    try:
        return _dt.datetime.strptime(raw, "%Y%m%dT%H%M%S").replace(tzinfo=_dt.timezone.utc)
    except ValueError:
        return utc_now()


def fetch_alphavantage_news(ticker: str, limit: int = 20) -> list[NewsEvent]:
    """Title/summary/source plus a per-ticker relevance-weighted sentiment
    score. Cached 15 min per ticker so repeat lookups don't spend budget."""
    if not alphavantage_available():
        return []
    sym = ticker.strip().upper()
    if not sym:
        return []
    cache_key = f"av_news:v1:{sym}"
    cached = _cached_events(cache_key)
    if cached is not None:
        return cached
    if not _av_consume():
        logger.info("alphavantage news: daily sub-budget (%d) exhausted, skipping %s", _AV_DAILY_CAP, sym)
        return []

    def _do():
        return requests.get(
            "https://www.alphavantage.co/query",
            params={"function": "NEWS_SENTIMENT", "tickers": sym, "limit": limit,
                    "apikey": os.environ["ALPHAVANTAGE_API_KEY"]},
            headers=_UA, timeout=_TIMEOUT,
        )

    try:
        resp = retry_with_backoff(_do, label=f"alphavantage news {sym}")
        resp.raise_for_status()
        data = resp.json()
    except Exception as exc:
        logger.warning("alphavantage news fetch failed for %s: %s", sym, exc)
        return []
    if "Note" in data or "Information" in data:
        # AV returns HTTP 200 with a plain-English rate-limit notice instead of
        # an error status when the key is throttled.
        logger.warning("alphavantage news rate-limited for %s: %s", sym, data.get("Note") or data.get("Information"))
        return []

    events: list[NewsEvent] = []
    for item in data.get("feed", []) or []:
        tick = next((t for t in item.get("ticker_sentiment", []) if t.get("ticker", "").upper() == sym), None)
        score = float(tick["ticker_sentiment_score"]) if tick and tick.get("ticker_sentiment_score") else None
        events.append(NewsEvent(
            timestamp=_parse_av_time(item.get("time_published")), source_name="AlphaVantage", ticker=sym,
            headline_or_text=item.get("title") or item.get("summary") or "",
            sentiment_score=score, url=item.get("url"), raw_payload=item,
        ))
    _store_events(cache_key, events)
    return events


# ── Marketaux ────────────────────────────────────────────────────────────────
def marketaux_available() -> bool:
    key = os.getenv("MARKETAUX_API_KEY", "")
    return bool(key and key != "your_marketaux_key_here")


def fetch_marketaux_news(ticker: str, limit: int = 20) -> list[NewsEvent]:
    """Real-time tagged stock news. Free tier: 100 requests/day."""
    if not marketaux_available():
        return []
    sym = ticker.strip().upper()
    if not sym:
        return []
    cache_key = f"marketaux_news:v1:{sym}"
    cached = _cached_events(cache_key)
    if cached is not None:
        return cached

    def _do():
        return requests.get(
            "https://api.marketaux.com/v1/news/all",
            params={"symbols": sym, "filter_entities": "true", "language": "en",
                    "limit": limit, "api_token": os.environ["MARKETAUX_API_KEY"]},
            timeout=_TIMEOUT,
        )

    try:
        resp = retry_with_backoff(_do, label=f"marketaux news {sym}")
        resp.raise_for_status()
        data = resp.json()
    except Exception as exc:
        logger.warning("marketaux news fetch failed for %s: %s", sym, exc)
        return []

    events: list[NewsEvent] = []
    for item in data.get("data", []) or []:
        ts = _parse_iso(item.get("published_at"))
        entity = next((e for e in item.get("entities", []) if e.get("symbol", "").upper() == sym), None)
        score = float(entity["sentiment_score"]) if entity and entity.get("sentiment_score") is not None else None
        events.append(NewsEvent(
            timestamp=ts, source_name="Marketaux", ticker=sym,
            headline_or_text=item.get("title") or item.get("description") or "",
            sentiment_score=score, url=item.get("url"), raw_payload=item,
        ))
    _store_events(cache_key, events)
    return events


# ── NewsData.io ──────────────────────────────────────────────────────────────
def newsdata_available() -> bool:
    key = os.getenv("NEWSDATA_API_KEY", "")
    return bool(key and key != "your_newsdata_key_here")


def fetch_newsdata_news(ticker: str, company_name: str | None = None) -> list[NewsEvent]:
    """Free tier: 200 credits/day BUT articles are delayed ~12 hours — treat
    this as a backfill/corroboration source, not a real-time one."""
    if not newsdata_available():
        return []
    sym = ticker.strip().upper()
    if not sym:
        return []
    cache_key = f"newsdata_news:v1:{sym}"
    cached = _cached_events(cache_key)
    if cached is not None:
        return cached

    query = company_name or sym

    def _do():
        return requests.get(
            "https://newsdata.io/api/1/latest",
            params={"q": query, "language": "en", "category": "business",
                    "apikey": os.environ["NEWSDATA_API_KEY"]},
            timeout=_TIMEOUT,
        )

    try:
        resp = retry_with_backoff(_do, label=f"newsdata news {sym}")
        resp.raise_for_status()
        data = resp.json()
    except Exception as exc:
        logger.warning("newsdata news fetch failed for %s: %s", sym, exc)
        return []

    events: list[NewsEvent] = []
    for item in data.get("results", []) or []:
        events.append(NewsEvent(
            timestamp=_parse_iso(item.get("pubDate")), source_name="NewsData", ticker=sym,
            headline_or_text=item.get("title") or item.get("description") or "",
            sentiment_score=None, url=item.get("link"), raw_payload=item,
        ))
    _store_events(cache_key, events, ttl=3600)   # already ~12h stale — no value in re-checking every 15 min
    return events


def _parse_iso(raw: str | None) -> _dt.datetime:
    if not raw:
        return utc_now()
    try:
        s = raw.replace("Z", "+00:00")
        dt = _dt.datetime.fromisoformat(s)
        return dt if dt.tzinfo else dt.replace(tzinfo=_dt.timezone.utc)
    except ValueError:
        return utc_now()
