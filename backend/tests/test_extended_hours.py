"""Overnight pricing: the portfolio and its option marks must keep moving after
the close. Network-free — yfinance and the clock are stubbed."""
import datetime as dt
import os
import sys

import pandas as pd
import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import extended_quotes  # noqa: E402
import market_hours  # noqa: E402
from routers import market as market_router  # noqa: E402
from routers import options as options_router  # noqa: E402

ET = market_hours._ET


def _closes(values, last_day, tz=ET):
    idx = pd.to_datetime([last_day - dt.timedelta(days=len(values) - 1 - i) for i in range(len(values))]).tz_localize(tz)
    return pd.DataFrame({"Close": values}, index=idx)


@pytest.fixture(autouse=True)
def _no_network(monkeypatch):
    monkeypatch.setattr(extended_quotes, "extended_quote", lambda sym: {"price": None, "as_of": None})


def _stub_history(monkeypatch, frame):
    monkeypatch.setattr(market_router, "_cached_history", lambda sym, period="5d": frame)


def test_regular_hours_quote_is_unchanged(monkeypatch):
    today = dt.date(2026, 7, 30)
    _stub_history(monkeypatch, _closes([100.0, 110.0], today))
    monkeypatch.setattr(market_router, "is_market_open", lambda: True)
    monkeypatch.setattr(market_router, "session_label", lambda: "regular")
    monkeypatch.setattr(market_router, "now_et", lambda: dt.datetime(2026, 7, 30, 11, 0, tzinfo=ET))

    got = market_router._try_history_quote("AAPL")
    assert got["current_price"] == 110.0
    assert got["pct_change_1d"] == 10.0
    assert "extended_pct" not in got


def test_after_hours_move_stacks_on_the_days_move(monkeypatch):
    """Today's bar exists, so the day runs from the prior close and the
    after-hours print is added on top."""
    today = dt.date(2026, 7, 30)
    _stub_history(monkeypatch, _closes([100.0, 110.0], today))
    monkeypatch.setattr(market_router, "is_market_open", lambda: False)
    monkeypatch.setattr(market_router, "session_label", lambda: "after-hours")
    monkeypatch.setattr(market_router, "now_et", lambda: dt.datetime(2026, 7, 30, 18, 0, tzinfo=ET))
    monkeypatch.setattr(extended_quotes, "extended_quote",
                        lambda sym: {"price": 121.0, "as_of": "2026-07-30T18:00:00-04:00"})

    got = market_router._try_history_quote("AAPL")
    assert got["current_price"] == 121.0
    assert got["pct_change_1d"] == 21.0            # 100 -> 121, not 110 -> 121
    assert got["regular_close"] == 110.0
    assert got["extended_pct"] == 10.0             # the after-hours leg alone
    assert got["session"] == "after-hours"


def test_pre_market_measures_from_the_last_close_not_two_days_back(monkeypatch):
    """Before the open today's bar does not exist yet, so the last bar IS the
    prior close. Treating it as an older bar reports a two-day move every
    morning."""
    yesterday = dt.date(2026, 7, 30)
    _stub_history(monkeypatch, _closes([100.0, 110.0], yesterday))
    monkeypatch.setattr(market_router, "is_market_open", lambda: False)
    monkeypatch.setattr(market_router, "session_label", lambda: "pre-market")
    monkeypatch.setattr(market_router, "now_et", lambda: dt.datetime(2026, 7, 31, 6, 30, tzinfo=ET))
    monkeypatch.setattr(extended_quotes, "extended_quote",
                        lambda sym: {"price": 115.5, "as_of": "2026-07-31T06:30:00-04:00"})

    got = market_router._try_history_quote("AAPL")
    assert got["current_price"] == 115.5
    assert got["pct_change_1d"] == 5.0             # 110 -> 115.5, NOT 100 -> 115.5
    assert got["regular_close"] == 110.0


def test_closed_with_no_extended_print_falls_back_to_the_close(monkeypatch):
    today = dt.date(2026, 7, 30)
    _stub_history(monkeypatch, _closes([100.0, 110.0], today))
    monkeypatch.setattr(market_router, "is_market_open", lambda: False)
    monkeypatch.setattr(market_router, "session_label", lambda: "closed")
    monkeypatch.setattr(market_router, "now_et", lambda: dt.datetime(2026, 7, 30, 23, 0, tzinfo=ET))

    got = market_router._try_history_quote("AAPL")
    assert got["current_price"] == 110.0
    assert got["pct_change_1d"] == 10.0
    assert "extended_pct" not in got


def test_portfolio_quotes_batch_all_symbols_in_one_download(monkeypatch):
    idx = pd.to_datetime(["2026-07-30", "2026-07-31"])
    columns = pd.MultiIndex.from_product([["Close"], ["MSFT", "NVDA"]])
    frame = pd.DataFrame([[100.0, 200.0], [110.0, 190.0]], index=idx, columns=columns)
    monkeypatch.setattr(market_router, "get_download", lambda *args, **kwargs: frame)
    market_router.get_quotes.cache_clear()

    result = market_router.get_quotes("MSFT,NVDA")

    assert result["quotes"]["MSFT"]["current_price"] == 110.0
    assert result["quotes"]["MSFT"]["pct_change_1d"] == 10.0
    assert result["quotes"]["NVDA"]["current_price"] == 190.0
    assert result["quotes"]["NVDA"]["pct_change_1d"] == -5.0


# ── option marks ────────────────────────────────────────────────────────────

def _mark_request(strike=100.0):
    return options_router.MarksRequest(legs=[options_router.MarkLeg(
        underlying="AAPL", expiry="2026-12-18", strike=strike, option_type="call",
    )])


def _stub_chain(monkeypatch, spot, bid=5.0, ask=5.4, iv=0.30, strike=100.0):
    monkeypatch.setattr(options_router, "options_chain", lambda ticker, expiry: {
        "calls": [{"strike": strike, "bid": bid, "ask": ask, "lastPrice": 5.2,
                   "impliedVolatility": iv, "delta": 0.55}],
        "puts": [], "spot": spot, "dte": 140,
    })


def test_open_market_marks_off_the_chain(monkeypatch):
    _stub_chain(monkeypatch, spot=100.0)
    monkeypatch.setattr(options_router, "is_market_open", lambda: True)

    mark = options_router.option_marks(_mark_request())["marks"][0]
    assert mark["source"] == "chain"
    assert mark["mark"] == pytest.approx(5.2, abs=0.01)     # the mid
    assert mark["delta"] == 0.55                            # the chain's own delta


def test_closed_market_reprices_off_the_extended_spot(monkeypatch):
    """The whole point: the chain's closing mid cannot show an overnight move."""
    _stub_chain(monkeypatch, spot=100.0)
    monkeypatch.setattr(options_router, "is_market_open", lambda: False)
    monkeypatch.setattr(extended_quotes, "extended_spot", lambda sym: 108.0)

    mark = options_router.option_marks(_mark_request())["marks"][0]
    assert mark["source"] == "bs-extended"
    assert mark["spot"] == 108.0
    # An 8% move up in the underlying must lift a 100-strike call well above the
    # frozen 5.20 closing mid.
    assert mark["mark"] > 5.2
    # And the delta must be recomputed against that spot, not the chain's.
    assert mark["delta"] != 0.55
    assert mark["delta"] > 0.55


def test_closed_market_without_an_extended_print_keeps_the_closing_mid(monkeypatch):
    _stub_chain(monkeypatch, spot=100.0)
    monkeypatch.setattr(options_router, "is_market_open", lambda: False)
    monkeypatch.setattr(extended_quotes, "extended_spot", lambda sym: None)

    mark = options_router.option_marks(_mark_request())["marks"][0]
    assert mark["source"] == "chain"
    assert mark["mark"] == pytest.approx(5.2, abs=0.01)


def test_unlisted_strike_still_falls_back_to_black_scholes(monkeypatch):
    _stub_chain(monkeypatch, spot=100.0, strike=100.0)
    monkeypatch.setattr(options_router, "is_market_open", lambda: True)

    mark = options_router.option_marks(_mark_request(strike=125.0))["marks"][0]
    assert mark["source"] == "bs"
    assert mark["mark"] is not None
