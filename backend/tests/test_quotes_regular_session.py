"""/market/quotes must mark a book to a real-time price while the market is OPEN.

Regression guard: the Alpaca real-time path was originally wired only to the
pre-market / after-hours / overnight branches, so during the regular session the
endpoint fell through to the still-forming daily bar. A fast poll then re-read the
same delayed close all afternoon — stale data exactly when it matters most.

Network-free: the batch download, the Alpaca client and the clock are stubbed.
"""
import datetime as dt
import os
import sys

import pandas as pd
import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import alpaca  # noqa: E402
import extended_quotes  # noqa: E402
import quotes as quotes_module  # noqa: E402
from routers import market as market_router  # noqa: E402


@pytest.fixture(autouse=True)
def _no_network(monkeypatch):
    monkeypatch.setattr(extended_quotes, "extended_quote", lambda sym: {"price": None, "as_of": None})
    monkeypatch.setattr(alpaca, "get_latest_prices", lambda syms: {})
    monkeypatch.setattr(alpaca, "get_latest_overnight_quotes", lambda syms: {})
    monkeypatch.setattr(market_router, "is_overnight_session", lambda: False)
    monkeypatch.setattr(quotes_module, "live_price", lambda sym: None)
    market_router.get_quotes.cache_clear()
    yield
    market_router.get_quotes.cache_clear()


def _download(day: dt.date, closes_by_symbol: dict) -> pd.DataFrame:
    """A frame shaped like yf.download's multi-ticker output: MultiIndex columns
    with the field on level 0, which is what _close_frame unpacks."""
    n = len(next(iter(closes_by_symbol.values())))
    idx = pd.to_datetime([day - dt.timedelta(days=n - 1 - i) for i in range(n)])
    return pd.DataFrame(
        {("Close", sym): closes for sym, closes in closes_by_symbol.items()},
        index=idx,
    )


def _daily(day: dt.date, closes: list) -> pd.DataFrame:
    return _download(day, {"AAPL": closes})


def _open_session(monkeypatch, day: dt.date, closes: list):
    monkeypatch.setattr(market_router, "is_market_open", lambda: True)
    monkeypatch.setattr(market_router, "session_label", lambda: "regular")
    monkeypatch.setattr(market_router, "now_et", lambda: dt.datetime(day.year, day.month, day.day, 11, 0))
    monkeypatch.setattr(market_router, "get_download", lambda *a, **k: _daily(day, closes))


def test_open_session_marks_to_the_realtime_trade_not_the_daily_bar(monkeypatch):
    day = dt.date(2026, 8, 6)
    # Daily series carries yesterday's 100 close and today's delayed 104 bar.
    _open_session(monkeypatch, day, [100.0, 104.0])
    monkeypatch.setattr(alpaca, "get_latest_prices", lambda syms: {"AAPL": 108.0})

    got = market_router.get_quotes("AAPL")["quotes"]["AAPL"]

    assert got["current_price"] == 108.0            # not the 104.0 delayed bar
    assert got["source"] == "alpaca_realtime"
    assert got["pct_change_1d"] == 8.0              # measured off the 100.0 prior close


def test_open_session_before_todays_bar_exists_uses_the_last_close_as_baseline(monkeypatch):
    """Early in the session the daily series often stops at yesterday, so its last
    row IS the prior close and must not be skipped over."""
    day = dt.date(2026, 8, 6)
    monkeypatch.setattr(market_router, "is_market_open", lambda: True)
    monkeypatch.setattr(market_router, "session_label", lambda: "regular")
    monkeypatch.setattr(market_router, "now_et", lambda: dt.datetime(2026, 8, 6, 9, 45))
    monkeypatch.setattr(market_router, "get_download",
                        lambda *a, **k: _daily(day - dt.timedelta(days=1), [90.0, 100.0]))
    monkeypatch.setattr(alpaca, "get_latest_prices", lambda syms: {"AAPL": 110.0})

    got = market_router.get_quotes("AAPL")["quotes"]["AAPL"]

    assert got["current_price"] == 110.0
    assert got["pct_change_1d"] == 10.0             # off 100.0, not the older 90.0


def test_open_session_falls_back_to_the_daily_bar_when_alpaca_is_dark(monkeypatch):
    """No keys or a failed call must degrade to the prior behavior, not error."""
    day = dt.date(2026, 8, 6)
    _open_session(monkeypatch, day, [100.0, 104.0])

    got = market_router.get_quotes("AAPL")["quotes"]["AAPL"]

    assert got["current_price"] == 104.0
    assert got["source"] == "batch_history"


def test_crypto_gets_a_realtime_mark_during_the_session(monkeypatch):
    """Alpaca does not serve crypto, but it trades 24/7 so the daily bar is just as
    stale. It routes through quotes.live_price (Binance, keyless)."""
    day = dt.date(2026, 8, 6)
    monkeypatch.setattr(market_router, "is_market_open", lambda: True)
    monkeypatch.setattr(market_router, "session_label", lambda: "regular")
    monkeypatch.setattr(market_router, "now_et", lambda: dt.datetime(2026, 8, 6, 11, 0))
    monkeypatch.setattr(market_router, "get_download",
                        lambda *a, **k: _download(day, {"BTC-USD": [50000.0, 51000.0]}))
    monkeypatch.setattr(quotes_module, "live_price", lambda sym: 55000.0)

    got = market_router.get_quotes("BTC-USD")["quotes"]["BTC-USD"]

    assert got["current_price"] == 55000.0
    assert got["source"] == "crypto_realtime"      # honest label: Binance, not Alpaca
    assert got["pct_change_1d"] == 10.0


def test_closed_market_keeps_the_extended_hours_behavior(monkeypatch):
    """The regular-session branch must not shadow the after-hours path."""
    day = dt.date(2026, 8, 6)
    monkeypatch.setattr(market_router, "is_market_open", lambda: False)
    monkeypatch.setattr(market_router, "session_label", lambda: "after-hours")
    monkeypatch.setattr(market_router, "now_et", lambda: dt.datetime(2026, 8, 6, 18, 0))
    monkeypatch.setattr(market_router, "get_download", lambda *a, **k: _daily(day, [100.0, 110.0]))
    monkeypatch.setattr(alpaca, "get_latest_prices", lambda syms: {"AAPL": 121.0})

    got = market_router.get_quotes("AAPL")["quotes"]["AAPL"]

    assert got["current_price"] == 121.0
    assert got["source"] == "alpaca_extended"
    assert got["regular_close"] == 110.0
