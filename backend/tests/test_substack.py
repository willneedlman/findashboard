"""Tests for the free-Substack evidence source used by the Mover Radar.

The matcher is the interesting part: a ticker in the title always counts, a
company name may match anywhere in the body, and a bare ticker only matches the
body for 3+ char symbols (so 1-2 char tickers don't collide with ordinary
uppercase words). Network-free — the per-feed fetch is monkeypatched.
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))

import rss_feeds  # noqa: E402
from social_schema import NewsEvent, utc_now  # noqa: E402


def _ev(title: str, body: str) -> NewsEvent:
    return NewsEvent(
        timestamp=utc_now(), source_name="Substack (Test)", ticker=None,
        headline_or_text=title, sentiment_score=None, url="https://x/p/1",
        raw_payload={"match_text": f"{title} {body}"},
    )


SAMPLE = [
    _ev("NVDA prints another record", "chip demand stays strong"),                 # ticker in title
    _ev("All Along the AI Watchtower", "we remain long Nvidia and Broadcom"),       # company in body only
    _ev("Small Themes: June", "our favorite name here is AMZN on logistics"),       # 3+ char ticker in body
    _ev("Macro Memo: Spin Cycle", "GM guided lower on the call"),                   # 2-char ticker in body only
    _ev("Money Market Snapshot", "repo, bills, and the front end"),                 # no mention
]


def _patch(monkeypatch):
    monkeypatch.setattr(rss_feeds, "_SUBSTACK_FEEDS", {"Test": "https://x/feed"})
    monkeypatch.setattr(rss_feeds, "_fetch_substack_feed", lambda name, url: list(SAMPLE))


def test_ticker_in_title_matches(monkeypatch):
    _patch(monkeypatch)
    out = rss_feeds.fetch_substack_mentions("NVDA", "Nvidia")
    titles = [e.headline_or_text for e in out]
    assert "NVDA prints another record" in titles
    # every returned event is tagged with the queried ticker
    assert all(e.ticker == "NVDA" for e in out)


def test_company_name_matches_in_body(monkeypatch):
    _patch(monkeypatch)
    out = rss_feeds.fetch_substack_mentions("NVDA", "Nvidia")
    assert "All Along the AI Watchtower" in [e.headline_or_text for e in out]


def test_three_char_ticker_matches_in_body(monkeypatch):
    _patch(monkeypatch)
    out = rss_feeds.fetch_substack_mentions("AMZN")  # no company name supplied
    assert "Small Themes: June" in [e.headline_or_text for e in out]


def test_two_char_ticker_body_only_is_guarded(monkeypatch):
    _patch(monkeypatch)
    # GM appears only in a body, no company name -> the short-ticker guard drops it.
    out = rss_feeds.fetch_substack_mentions("GM")
    assert "Macro Memo: Spin Cycle" not in [e.headline_or_text for e in out]
    # ...but supplying the company name rescues it.
    out2 = rss_feeds.fetch_substack_mentions("GM", "General Motors")
    # (only matches if the body actually names it; this sample body says "GM", not
    # "General Motors", so it stays out — the guard holds unless the name appears)
    assert "Macro Memo: Spin Cycle" not in [e.headline_or_text for e in out2]


def test_no_false_positive_on_unrelated_post(monkeypatch):
    _patch(monkeypatch)
    out = rss_feeds.fetch_substack_mentions("TSLA", "Tesla")
    assert "Money Market Snapshot" not in [e.headline_or_text for e in out]


def test_ticker_word_boundary_not_substring(monkeypatch):
    # A ticker must be a whole token: 'AMZN' should not fire on 'AMZNX' (a fund).
    monkeypatch.setattr(rss_feeds, "_SUBSTACK_FEEDS", {"Test": "https://x/feed"})
    monkeypatch.setattr(rss_feeds, "_fetch_substack_feed",
                        lambda name, url: [_ev("Fund note", "we bought AMZNX today")])
    out = rss_feeds.fetch_substack_mentions("AMZN")
    assert out == []
