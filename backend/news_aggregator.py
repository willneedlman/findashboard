"""Aggregates every source in this data-collection system into one ranked,
de-duplicated timeline of NewsEvent objects for a given ticker.

Sources (see each module's docstring for exact caveats):
  - news_apis.py         Alpha Vantage News & Sentiment (shared 25/day AV budget),
                         Marketaux (100/day, needs MARKETAUX_API_KEY),
                         NewsData.io (200 credits/day, 12h-delayed, needs NEWSDATA_API_KEY)
  - social_sentiment.py  StockTwits (live, no key) + Reddit (dormant — reddit.com
                         blocks unauthenticated requests outright, see that
                         module's docstring)
  - rss_feeds.py         CNBC / MarketWatch / WSJ direct RSS (substring-matched
                         to the ticker/company name) + Google News RSS search
                         (a real per-ticker query aggregating dozens of
                         publishers — the highest-recall source here) + free
                         ticker-naming Substacks (The Transcript, Net Interest,
                         The Bear Cave, Doomberg, Klement — matched on title or
                         full free-post body). No key for any.
  - sec_edgar_feed.py    SEC EDGAR filings — 8-K/10-Q/10-K/Form 4/13D/13G/144
                         (no key, compliant User-Agent required)

Every source runs concurrently and is individually fault-isolated — one
source erroring never drops the others. Missing API keys (Marketaux,
NewsData.io) just mean that source contributes nothing; nothing blocks on it.

CLI:
    python news_aggregator.py TSLA
    python news_aggregator.py TSLA "Tesla Inc"
"""
from __future__ import annotations

import logging
import sys
from concurrent.futures import ThreadPoolExecutor, as_completed
from typing import Callable

import news_apis
import rss_feeds
import sec_edgar_feed
import social_sentiment
from social_schema import NewsEvent

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
logger = logging.getLogger(__name__)


def _source_calls(ticker: str, company_name: str | None) -> dict[str, Callable[[], list]]:
    return {
        "AlphaVantage": lambda: news_apis.fetch_alphavantage_news(ticker),
        "Marketaux": lambda: news_apis.fetch_marketaux_news(ticker),
        "NewsData": lambda: news_apis.fetch_newsdata_news(ticker, company_name),
        "Social (StockTwits/Reddit)": lambda: social_sentiment.fetch_social_mentions(ticker),
        "RSS (CNBC/MarketWatch/WSJ)": lambda: rss_feeds.fetch_ticker_mentions(ticker, company_name),
        "Google News": lambda: rss_feeds.fetch_google_news(ticker, company_name),
        "Substack": lambda: rss_feeds.fetch_substack_mentions(ticker, company_name),
        "SEC EDGAR": lambda: sec_edgar_feed.fetch_recent_filings(ticker),
    }


def collect(ticker: str, company_name: str | None = None) -> dict:
    """Runs every source concurrently for `ticker`. Returns:
        {
          "ticker": str,
          "events": list[NewsEvent]     # merged, newest first, de-duplicated
          "source_status": {source_name: {"count": int, "error": str | None}},
        }
    A source that raises is caught here (fault isolation) and recorded in
    source_status with its error message — collect() itself never raises.
    """
    sym = ticker.strip().upper()
    calls = _source_calls(sym, company_name)
    events: list[NewsEvent] = []
    status: dict[str, dict] = {}

    with ThreadPoolExecutor(max_workers=len(calls)) as pool:
        futures = {pool.submit(fn): name for name, fn in calls.items()}
        for future in as_completed(futures):
            name = futures[future]
            try:
                result = future.result()
                events.extend(result)
                status[name] = {"count": len(result), "error": None}
            except Exception as exc:
                logger.warning("source %s failed for %s: %s", name, sym, exc)
                status[name] = {"count": 0, "error": str(exc)}

    events = _dedupe(events)
    events.sort(key=lambda e: e.timestamp, reverse=True)
    return {"ticker": sym, "events": events, "source_status": status}


def _dedupe(events: list[NewsEvent]) -> list[NewsEvent]:
    """Same URL, or same source+near-identical headline, collapses to one —
    wire stories and RSS feeds routinely republish the same AP/Reuters item."""
    seen_urls: set[str] = set()
    seen_headlines: set[tuple[str, str]] = set()
    out: list[NewsEvent] = []
    for e in events:
        if e.url and e.url in seen_urls:
            continue
        key = (e.source_name, e.headline_or_text.strip().lower()[:120])
        if key in seen_headlines:
            continue
        if e.url:
            seen_urls.add(e.url)
        seen_headlines.add(key)
        out.append(e)
    return out


def _print_summary(result: dict) -> None:
    ticker = result["ticker"]
    events = result["events"]
    status = result["source_status"]
    print(f"\n=== {ticker} — {len(events)} events across {len(status)} sources ===\n")
    for name, s in status.items():
        flag = f"error: {s['error']}" if s["error"] else f"{s['count']} events"
        print(f"  {name:<28} {flag}")
    print()
    for e in events[:40]:
        ts = e.timestamp.strftime("%Y-%m-%d %H:%M UTC")
        sent = f"{e.sentiment_score:+.2f}" if e.sentiment_score is not None else "  —  "
        print(f"[{ts}] ({e.source_name:<12} {sent}) {e.headline_or_text[:110]}")
        if e.url:
            print(f"    {e.url}")


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: python news_aggregator.py TICKER [\"Company Name\"]")
        sys.exit(1)
    arg_ticker = sys.argv[1]
    arg_company = sys.argv[2] if len(sys.argv) > 2 else None
    _print_summary(collect(arg_ticker, arg_company))
