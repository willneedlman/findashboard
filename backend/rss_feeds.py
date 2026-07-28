"""Direct RSS feeds — CNBC, MarketWatch, WSJ. No API key, no rate limit beyond
politeness (cached 5 min).

feedparser must NOT be handed a raw URL — its built-in fetcher uses bare
urllib, and this environment's Python doesn't have a working local CA bundle
(SSL cert-verify failures on every https feed). Fetching via `requests` (which
bundles certifi) and handing feedparser the raw bytes sidesteps that
entirely — verified against all three feeds below.

These are general market-headline feeds, not ticker-tagged at the source, so
matching a ticker means substring-matching its symbol/company name in the
title+summary — a much weaker relevance signal than the tagged sources
(Alpha Vantage, Marketaux, StockTwits). Treat RSS matches as corroborating
evidence, not primary detection.
"""
from __future__ import annotations

import datetime as _dt
import logging
import re

import feedparser
import requests

from disk_cache import disk_get, disk_set
from social_schema import NewsEvent, dict_to_event, event_to_dict, retry_with_backoff, utc_now

logger = logging.getLogger(__name__)
_TIMEOUT = 10
_CACHE_TTL = 300
_UA = {
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
}

_FEEDS = {
    "CNBC": "https://search.cnbc.com/rs/search/combinedcms/view.xml?partnerId=wrss01&id=100003114",
    "MarketWatch": "https://www.marketwatch.com/rss/topstories",
    "WSJ": "https://feeds.a.dj.com/rss/RSSMarketsMain.xml",
}


def fetch_rss_feed(source_name: str, url: str) -> list[NewsEvent]:
    """All current headlines from one feed, unfiltered. Never raises."""
    cache_key = f"rss:v1:{source_name}"
    cached = disk_get(cache_key)
    if cached is not None:
        return [dict_to_event(d) for d in cached]

    def _do():
        return requests.get(url, headers=_UA, timeout=_TIMEOUT)

    try:
        resp = retry_with_backoff(_do, label=f"rss {source_name}")
        resp.raise_for_status()
        parsed = feedparser.parse(resp.content)
    except Exception as exc:
        logger.warning("rss fetch failed for %s: %s", source_name, exc)
        return []

    events: list[NewsEvent] = []
    for entry in parsed.entries:
        title = entry.get("title") or ""
        if not title:
            continue
        events.append(NewsEvent(
            timestamp=_parse_rss_time(entry), source_name=source_name, ticker=None,
            headline_or_text=title, sentiment_score=None,
            url=entry.get("link"), raw_payload=dict(entry),
        ))
    _store(cache_key, events)
    return events


def fetch_all_headlines() -> list[NewsEvent]:
    """Every configured feed combined, newest first."""
    events: list[NewsEvent] = []
    for name, url in _FEEDS.items():
        events.extend(fetch_rss_feed(name, url))
    events.sort(key=lambda e: e.timestamp, reverse=True)
    return events


_GOOGLE_NEWS_CACHE_TTL = 300


def fetch_google_news(ticker: str, company_name: str | None = None, days: int = 3, limit: int = 25) -> list[NewsEvent]:
    """Google News' RSS search — a real per-ticker QUERY (not a fixed feed),
    aggregating across dozens of publishers Google crawls (Benzinga, Motley
    Fool, Seeking Alpha, TradingKey, 24/7 Wall St, etc.), most of which this
    backend has no direct feed for. No API key.

    This is what actually catches a specific "why did this move" story — the
    fixed CNBC/MarketWatch/WSJ feeds only carry each outlet's own top stories,
    which is a tiny fraction of everything published about any one name on a
    given day. Verified live: for a name where the 3 fixed feeds and every
    tagged source (AV/Marketaux/NewsData) all missed the actual driver, this
    surfaced it directly (a dedicated "Key Drivers Unveiled" story and a
    multi-bank-price-target roundup) within the first page of results.

    `link` is a Google redirect URL, not the publisher's own URL — it still
    resolves correctly when opened, Google just proxies it.
    """
    sym = ticker.strip().upper()
    if not sym:
        return []
    cache_key = f"google_news:v1:{sym}"
    cached = disk_get(cache_key)
    if cached is not None:
        return [dict_to_event(d) for d in cached]

    query = f"{company_name or sym} {sym} stock when:{days}d" if company_name else f"{sym} stock when:{days}d"

    def _do():
        return requests.get(
            "https://news.google.com/rss/search",
            params={"q": query, "hl": "en-US", "gl": "US", "ceid": "US:en"},
            headers=_UA, timeout=_TIMEOUT,
        )

    try:
        resp = retry_with_backoff(_do, label=f"google news {sym}")
        resp.raise_for_status()
        parsed = feedparser.parse(resp.content)
    except Exception as exc:
        logger.warning("google news fetch failed for %s: %s", sym, exc)
        return []

    events: list[NewsEvent] = []
    for entry in parsed.entries[:limit]:
        title = entry.get("title") or ""
        if not title:
            continue
        publisher = (entry.get("source") or {}).get("title")
        events.append(NewsEvent(
            timestamp=_parse_rss_time(entry), source_name=f"Google News ({publisher})" if publisher else "Google News",
            ticker=sym, headline_or_text=title, sentiment_score=None,
            url=entry.get("link"), raw_payload=dict(entry),
        ))
    disk_set(cache_key, [event_to_dict(e) for e in events], ttl=_GOOGLE_NEWS_CACHE_TTL)
    return events


def fetch_ticker_mentions(ticker: str, company_name: str | None = None) -> list[NewsEvent]:
    """Headlines across all feeds mentioning `ticker` or `company_name`
    (substring match, case-insensitive) — tagged with `ticker` on the
    returned events since the source itself doesn't tag entities."""
    sym = ticker.strip().upper()
    if not sym:
        return []
    terms = [sym] + ([company_name] if company_name else [])
    pattern = re.compile("|".join(re.escape(t) for t in terms if t), re.IGNORECASE)

    matches: list[NewsEvent] = []
    for e in fetch_all_headlines():
        haystack = e.headline_or_text
        if pattern.search(haystack):
            matches.append(NewsEvent(
                timestamp=e.timestamp, source_name=e.source_name, ticker=sym,
                headline_or_text=e.headline_or_text, sentiment_score=None,
                url=e.url, raw_payload=e.raw_payload,
            ))
    return matches


# ── Substack (free, ticker-naming finance publications) ───────────────────────
# Evidence source for the Mover Radar. Paid Substacks expose only a paywall
# teaser in RSS, so every feed here is one whose FREE posts embed the full body —
# which is what lets us match a ticker/company that a deliberately oblique title
# never names. Low cadence, so a 15-min cache is plenty.
_SUBSTACK_CACHE_TTL = 900
_SUBSTACK_FEEDS = {
    "The Transcript":      "https://thetranscript.substack.com/feed",
    "Net Interest":        "https://www.netinterest.co/feed",
    "The Bear Cave":       "https://thebearcave.substack.com/feed",
    "Doomberg":            "https://doomberg.substack.com/feed",
    "Klement on Investing": "https://klementoninvesting.substack.com/feed",
}
_HTML_TAG_RE = re.compile(r"<[^>]+>")


def _entry_text(entry) -> str:
    """Title + full post body (free posts embed it), tags stripped and bounded —
    the haystack a ticker or company name is matched against."""
    parts = [entry.get("title") or "", entry.get("summary") or ""]
    for c in (entry.get("content") or []):
        parts.append(c.get("value") or "")
    txt = _HTML_TAG_RE.sub(" ", " ".join(parts))
    return re.sub(r"\s+", " ", txt).strip()[:6000]


def _fetch_substack_feed(name: str, url: str) -> list[NewsEvent]:
    """Recent posts from one Substack, cached and ticker-agnostic. The matchable
    body text rides along in raw_payload['match_text']. Never raises."""
    cache_key = f"substack:v1:{name}"
    cached = disk_get(cache_key)
    if cached is not None:
        return [dict_to_event(d) for d in cached]

    def _do():
        return requests.get(url, headers=_UA, timeout=_TIMEOUT)

    try:
        resp = retry_with_backoff(_do, label=f"substack {name}")
        resp.raise_for_status()
        parsed = feedparser.parse(resp.content)
    except Exception as exc:
        logger.warning("substack fetch failed for %s: %s", name, exc)
        return []

    events: list[NewsEvent] = []
    for entry in parsed.entries:
        title = (entry.get("title") or "").strip()
        if not title:
            continue
        events.append(NewsEvent(
            timestamp=_parse_rss_time(entry), source_name=f"Substack ({name})", ticker=None,
            headline_or_text=title, sentiment_score=None, url=entry.get("link"),
            raw_payload={"match_text": _entry_text(entry)},
        ))
    disk_set(cache_key, [event_to_dict(e) for e in events], ttl=_SUBSTACK_CACHE_TTL)
    return events


def fetch_substack_mentions(ticker: str, company_name: str | None = None) -> list[NewsEvent]:
    """Free-Substack posts that mention `ticker` or `company_name`, tagged with
    `ticker`. A ticker in the title always counts; the company name may match
    anywhere in the body; a bare ticker only matches the body for symbols of 3+
    chars, since 1-2 char tickers collide with ordinary uppercase words."""
    sym = ticker.strip().upper()
    if not sym:
        return []
    tick_re = re.compile(rf"(?<![A-Za-z0-9]){re.escape(sym)}(?![A-Za-z0-9])")
    name_re = re.compile(re.escape(company_name), re.IGNORECASE) if company_name else None

    out: list[NewsEvent] = []
    for name, url in _SUBSTACK_FEEDS.items():
        for e in _fetch_substack_feed(name, url):
            title = e.headline_or_text
            body = (e.raw_payload or {}).get("match_text") or title
            hit = bool(tick_re.search(title)) \
                or (name_re is not None and name_re.search(body) is not None) \
                or (len(sym) >= 3 and tick_re.search(body) is not None)
            if hit:
                out.append(NewsEvent(
                    timestamp=e.timestamp, source_name=e.source_name, ticker=sym,
                    headline_or_text=e.headline_or_text, sentiment_score=None,
                    url=e.url, raw_payload=e.raw_payload,
                ))
    return out


def _store(cache_key: str, events: list[NewsEvent]) -> None:
    disk_set(cache_key, [event_to_dict(e) for e in events], ttl=_CACHE_TTL)


def _parse_rss_time(entry) -> _dt.datetime:
    parsed = entry.get("published_parsed") or entry.get("updated_parsed")
    if parsed:
        try:
            return _dt.datetime(*parsed[:6], tzinfo=_dt.timezone.utc)
        except (TypeError, ValueError):
            pass
    return utc_now()
