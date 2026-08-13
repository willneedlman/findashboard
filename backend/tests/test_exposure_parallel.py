"""Dealer exposure fetches its chains concurrently.

One HTTP round trip per expiry and up to 32 expiries meant a cold SPY load spent
about fifteen seconds almost entirely waiting on the network. These tests pin the
concurrency, and pin that the yfinance fallback stays sequential — it is rate
limited app-wide and a fan-out at it trips that limit.
"""
import threading
import time

import pytest

from routers import options as opts


EXPIRIES = [f"2026-09-{day:02d}" for day in range(1, 25)]


def _chain(strike=500.0):
    row = {"strike": strike, "openInterest": 100, "volume": 50,
           "impliedVolatility": 0.2, "bid": 1.0, "ask": 1.1, "lastPrice": 1.05,
           "delta": 0.5, "gamma": 0.01}
    return {"calls": [row], "puts": [dict(row)]}


class _Tracker:
    """Records how many fetches overlap, so sequential code cannot pass."""

    def __init__(self, delay=0.05, fail_on=()):
        self.delay = delay
        self.fail_on = set(fail_on)
        self.live = 0
        self.peak = 0
        self.calls = []
        self._lock = threading.Lock()

    def __call__(self, symbol, expiration, greeks=True):
        with self._lock:
            self.live += 1
            self.peak = max(self.peak, self.live)
            self.calls.append(expiration)
        try:
            time.sleep(self.delay)
            if expiration in self.fail_on:
                raise RuntimeError("chain unavailable")
            return _chain()
        finally:
            with self._lock:
                self.live -= 1


@pytest.fixture
def wired(monkeypatch):
    monkeypatch.setattr(opts, "is_market_open", lambda: True)
    # TTLCache is dict-like; clearing it forces the cold path every test.
    opts._expo_cache.clear()
    monkeypatch.setattr(opts, "disk_set", lambda *a, **k: None)
    monkeypatch.setattr(opts._tradier, "get_quote", lambda sym: {"last": 500.0})
    monkeypatch.setattr(opts._tradier, "get_expirations", lambda sym: EXPIRIES)


def test_chains_are_fetched_concurrently(wired, monkeypatch):
    tracker = _Tracker()
    monkeypatch.setattr(opts._tradier, "get_options_chain", tracker)

    started = time.monotonic()
    opts.dealer_exposure("SPY", expiries=24)
    elapsed = time.monotonic() - started

    assert len(tracker.calls) >= 24, "every expiry is still fetched"
    assert tracker.peak > 1, "fetches must overlap; sequential fetching is the bug"
    # 24 x 50ms sequential is 1.2s. Concurrency has to beat that clearly.
    assert elapsed < 0.9, f"cold fetch took {elapsed:.2f}s, expected concurrent"


def test_concurrency_is_bounded(wired, monkeypatch):
    # Unbounded fan-out at a rate-limited vendor is its own outage.
    tracker = _Tracker()
    monkeypatch.setattr(opts._tradier, "get_options_chain", tracker)
    opts.dealer_exposure("SPY", expiries=24)
    assert tracker.peak <= 8


def test_a_failed_chain_falls_back_without_killing_the_request(wired, monkeypatch):
    tracker = _Tracker(fail_on={EXPIRIES[0], EXPIRIES[5]})
    monkeypatch.setattr(opts._tradier, "get_options_chain", tracker)

    yf_calls = []

    class _FakeYf:
        def __init__(self, sym): pass
        def option_chain(self, exp):
            yf_calls.append(exp)
            raise RuntimeError("no yfinance in tests")

    monkeypatch.setattr(opts.yf, "Ticker", _FakeYf)
    body = opts.dealer_exposure("SPY", expiries=24)

    # Only the two that failed reach the fallback, and the response still builds.
    assert sorted(yf_calls) == sorted([EXPIRIES[0], EXPIRIES[5]])
    assert body["by_strike"], "the surviving expiries still produce a profile"


def test_every_requested_expiry_is_represented(wired, monkeypatch):
    monkeypatch.setattr(opts._tradier, "get_options_chain", _Tracker(delay=0))
    body = opts.dealer_exposure("SPY", expiries=24)
    assert len(body["processed"]) >= 24
    assert {row["expiry"] for row in body["per_expiry"]} <= set(body["processed"])
