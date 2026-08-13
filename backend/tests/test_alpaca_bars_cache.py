"""bars_multi memoisation.

The Portfolio Live range selector refetches a whole basket every time the user
switches 1W/1M/3M/YTD, and each of those was a paginated multi-second round trip.
These tests pin the cache down, and in particular pin the rule that a failure or
an empty basket is NEVER memoised — caching one would blank the chart for the
whole TTL after the vendor had already recovered.
"""
import os

import pytest

os.environ.setdefault("ALPACA_API_KEY", "test-key")
os.environ.setdefault("ALPACA_API_SECRET", "test-secret")

import alpaca  # noqa: E402


BAR = {"t": "2026-08-13T13:30:00Z", "o": 1.0, "h": 1.0, "l": 1.0, "c": 100.0, "v": 10}


class _Resp:
    def __init__(self, payload):
        self._payload = payload

    def raise_for_status(self):
        pass

    def json(self):
        return self._payload


@pytest.fixture
def wire(monkeypatch):
    """Count outbound requests, and let a test swap in the payload or an error."""
    state = {"calls": 0, "payload": {"bars": {"AAPL": [BAR]}, "next_page_token": None}, "error": None}

    def fake_get(url, **kwargs):
        state["calls"] += 1
        if state["error"]:
            raise state["error"]
        return _Resp(state["payload"])

    monkeypatch.setattr(alpaca.httpx, "get", fake_get)
    monkeypatch.setattr(alpaca, "available", lambda: True)
    # Each test starts from a clean cache; these are process-wide otherwise.
    alpaca._bars_multi_fast.cache_clear()
    alpaca._bars_multi_slow.cache_clear()
    return state


def test_identical_slow_request_is_served_from_cache(wire):
    first = alpaca.bars_multi(("AAPL",), "1h", "2026-07-10")
    second = alpaca.bars_multi(("AAPL",), "1h", "2026-07-10")
    assert wire["calls"] == 1
    assert first == second
    assert first["AAPL"][0]["c"] == 100.0


def test_identical_fast_request_is_served_from_cache(wire):
    alpaca.bars_multi(("AAPL",), "5m", "2026-08-12")
    alpaca.bars_multi(("AAPL",), "5m", "2026-08-12")
    assert wire["calls"] == 1


def test_a_different_window_is_a_different_entry(wire):
    alpaca.bars_multi(("AAPL",), "1h", "2026-07-10")
    alpaca.bars_multi(("AAPL",), "1h", "2026-06-01")
    assert wire["calls"] == 2


def test_a_different_timeframe_is_a_different_entry(wire):
    alpaca.bars_multi(("AAPL",), "1h", "2026-07-10")
    alpaca.bars_multi(("AAPL",), "1d", "2026-07-10")
    assert wire["calls"] == 2


def test_a_different_basket_is_a_different_entry(wire):
    alpaca.bars_multi(("AAPL",), "1h", "2026-07-10")
    alpaca.bars_multi(("AAPL", "MSFT"), "1h", "2026-07-10")
    assert wire["calls"] == 2


def test_duplicate_symbols_collapse_onto_one_entry(wire):
    alpaca.bars_multi(("AAPL",), "1h", "2026-07-10")
    alpaca.bars_multi(("AAPL", "AAPL"), "1h", "2026-07-10")
    assert wire["calls"] == 1


def test_a_vendor_failure_is_not_cached(wire):
    wire["error"] = RuntimeError("vendor down")
    assert alpaca.bars_multi(("AAPL",), "1h", "2026-07-10") == {}

    wire["error"] = None
    recovered = alpaca.bars_multi(("AAPL",), "1h", "2026-07-10")
    assert recovered["AAPL"][0]["c"] == 100.0, "recovery must not be blocked by a cached failure"
    assert wire["calls"] == 2


def test_an_empty_basket_is_not_cached(wire):
    wire["payload"] = {"bars": {}, "next_page_token": None}
    assert alpaca.bars_multi(("AAPL",), "1h", "2026-07-10") == {}

    wire["payload"] = {"bars": {"AAPL": [BAR]}, "next_page_token": None}
    assert alpaca.bars_multi(("AAPL",), "1h", "2026-07-10")["AAPL"]
    assert wire["calls"] == 2


def test_non_equities_are_screened_out_before_any_request(wire):
    assert alpaca.bars_multi(("^GSPC", "BTC-USD"), "1h", "2026-07-10") == {}
    assert wire["calls"] == 0


def test_unknown_timeframe_makes_no_request(wire):
    assert alpaca.bars_multi(("AAPL",), "not-a-timeframe", "2026-07-10") == {}
    assert wire["calls"] == 0
