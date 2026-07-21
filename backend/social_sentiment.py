"""Retail-forum sentiment: StockTwits (live) + Reddit (dormant).

StockTwits' public per-symbol stream (`/api/2/streams/symbol/{ticker}.json`)
needs no API key/OAuth — StockTwits' own official developer portal is closed
to new registrations right now, but this anonymous endpoint is the same one
the stocktwits.com website itself calls. It sits behind Cloudflare, which
bot-challenges the default python-requests User-Agent inconsistently but lets
a realistic browser UA through reliably (verified live) — so this always sends
one.

Reddit does NOT work the same way: reddit.com blocks this class of request
outright (verified with plain requests AND curl_cffi Chrome-TLS-impersonation
— both 403, on both the JSON search and the RSS path, on both the API
subdomain and the plain HTML page). That's an IP/network-level block, not a
header or fingerprint problem, so it would very likely also fail from
production. reddit_social.py is kept as-is (already degrades to
`available: False` safely) and wrapped here so the aggregator can list Reddit
as a real source the moment it's viable again — official API access, or
Reddit lifting the block — without every call site changing.
"""
from __future__ import annotations

import logging

import requests

import reddit_social
from disk_cache import disk_get, disk_set
from social_schema import NewsEvent, dict_to_event, event_to_dict, retry_with_backoff, utc_now

logger = logging.getLogger(__name__)
_TIMEOUT = 12
_CACHE_TTL = 300   # 5 min — social streams turn over fast, but this is an anonymous endpoint; don't hammer it
_BROWSER_UA = {
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
}
_SENTIMENT_MAP = {"Bullish": 1.0, "Bearish": -1.0}


def fetch_stocktwits_mentions(ticker: str, limit: int = 30) -> list[NewsEvent]:
    """Recent public StockTwits messages tagged with `ticker`, newest first.
    Never raises — degrades to an empty list on any failure (Cloudflare
    challenge, timeout, symbol with no stream, etc.)."""
    sym = ticker.strip().upper()
    if not sym:
        return []
    cache_key = f"stocktwits:v1:{sym}"
    cached = disk_get(cache_key)
    if cached is not None:
        return [dict_to_event(d) for d in cached]

    def _do():
        return requests.get(
            f"https://api.stocktwits.com/api/2/streams/symbol/{sym}.json",
            params={"limit": limit}, headers=_BROWSER_UA, timeout=_TIMEOUT,
        )

    try:
        resp = retry_with_backoff(_do, label=f"stocktwits {sym}")
        if resp.status_code != 200:
            disk_set(cache_key, [], ttl=60)   # likely a transient Cloudflare challenge — retry soon
            return []
        data = resp.json()
    except Exception as exc:
        logger.warning("stocktwits fetch failed for %s: %s", sym, exc)
        return []

    events: list[NewsEvent] = []
    for m in data.get("messages", []) or []:
        body = m.get("body") or ""
        if not body:
            continue
        basic = ((m.get("entities") or {}).get("sentiment") or {}).get("basic")
        user = (m.get("user") or {}).get("username")
        events.append(NewsEvent(
            timestamp=_parse_created(m.get("created_at")), source_name="StockTwits", ticker=sym,
            headline_or_text=body, sentiment_score=_SENTIMENT_MAP.get(basic),
            url=f"https://stocktwits.com/{user}/message/{m.get('id')}" if user and m.get("id") else None,
            raw_payload=m,
        ))
    disk_set(cache_key, [event_to_dict(e) for e in events], ttl=_CACHE_TTL)
    return events


def fetch_reddit_mentions(ticker: str) -> list[NewsEvent]:
    """Wraps reddit_social.ticker_mentions() — returns [] while Reddit blocks
    unauthenticated requests (see module docstring); ready to return real
    events the moment that changes, with no call-site changes needed."""
    result = reddit_social.ticker_mentions(ticker)
    if not result.get("available"):
        return []
    sym = ticker.strip().upper()
    events: list[NewsEvent] = []
    for p in result.get("posts", []):
        events.append(NewsEvent(
            timestamp=_parse_epoch(p.get("created_utc")), source_name="Reddit", ticker=sym,
            headline_or_text=p.get("title") or "", sentiment_score=None,
            url=p.get("permalink"), raw_payload=p,
        ))
    return events


def fetch_social_mentions(ticker: str) -> list[NewsEvent]:
    """Every social source combined, newest first."""
    events = fetch_stocktwits_mentions(ticker) + fetch_reddit_mentions(ticker)
    events.sort(key=lambda e: e.timestamp, reverse=True)
    return events


def _parse_created(raw: str | None):
    if not raw:
        return utc_now()
    try:
        import datetime as _dt
        return _dt.datetime.strptime(raw, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=_dt.timezone.utc)
    except ValueError:
        return utc_now()


def _parse_epoch(raw):
    if not raw:
        return utc_now()
    try:
        import datetime as _dt
        return _dt.datetime.fromtimestamp(float(raw), tz=_dt.timezone.utc)
    except (TypeError, ValueError):
        return utc_now()
