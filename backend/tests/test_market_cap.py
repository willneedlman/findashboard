import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))

import market_cap  # noqa: E402


def test_prefers_diluted_shares(monkeypatch):
    monkeypatch.setattr(market_cap, "_price", lambda t: (305.93, "quotes.live_price"))
    monkeypatch.setattr(market_cap, "_diluted_shares", lambda t: (15_004_697_000.0, "sec"))

    cap = market_cap.market_cap("AAPL")

    assert cap["basis"] == market_cap.BASIS_DILUTED
    assert cap["value"] == round(305.93 * 15_004_697_000.0)
    assert cap["shares"] == 15_004_697_000.0
    assert cap["source"] == "quotes.live_price x sec"


def test_falls_back_to_basic_shares_and_says_so(monkeypatch):
    monkeypatch.setattr(market_cap, "_price", lambda t: (100.0, "quotes.live_price"))
    monkeypatch.setattr(market_cap, "_diluted_shares", lambda t: (None, None))
    monkeypatch.setattr("cache.get_info", lambda t: {"sharesOutstanding": 1_000_000.0})

    cap = market_cap.market_cap("AAPL")

    assert cap["basis"] == market_cap.BASIS_BASIC
    assert cap["value"] == 100_000_000


def test_vendor_cap_is_labelled_because_it_cannot_be_reconciled(monkeypatch):
    monkeypatch.setattr(market_cap, "_price", lambda t: (None, None))
    monkeypatch.setattr(market_cap, "_diluted_shares", lambda t: (None, None))
    monkeypatch.setattr("cache.get_info", lambda t: {"marketCap": 4.46e12})

    cap = market_cap.market_cap("AAPL")

    assert cap["basis"] == market_cap.BASIS_VENDOR
    assert cap["shares"] is None
    assert cap["value"] == round(4.46e12)


def test_missing_everything_returns_none_not_a_placeholder(monkeypatch):
    monkeypatch.setattr(market_cap, "_price", lambda t: (None, None))
    monkeypatch.setattr(market_cap, "_diluted_shares", lambda t: (None, None))
    monkeypatch.setattr("cache.get_info", lambda t: {})

    cap = market_cap.market_cap("NOPE")

    assert cap["value"] is None
    assert cap["basis"] is None


def test_blank_ticker_short_circuits():
    cap = market_cap.market_cap("")

    assert cap["value"] is None
    assert cap["source"] is None
