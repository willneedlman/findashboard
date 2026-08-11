"""Portfolio Live's intraday book-value curve. Network-free — the bar downloads,
the Alpaca client and the clock are all stubbed.

The timezone cases are the ones that matter: cache.get_download drops the zone but
keeps the wall-clock, and yfinance stamps US intraday bars in exchange time, so a
naive index is ET. Reading it as UTC shifts every bar 4-5h and can attribute the
open to the wrong session.
"""
import datetime as dt
import os
import sys

import pandas as pd
import pytest
from fastapi import HTTPException

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import alpaca  # noqa: E402
from routers import portfolio as portfolio_router  # noqa: E402


def _naive_et_bars(day: dt.date, symbols_to_prices: dict) -> pd.DataFrame:
    """Intraday closes shaped like cache.get_download's output: tz-naive ET
    wall-clock, one column per symbol."""
    n = len(next(iter(symbols_to_prices.values())))
    idx = pd.to_datetime([dt.datetime.combine(day, dt.time(9, 30)) + dt.timedelta(minutes=5 * i) for i in range(n)])
    return pd.DataFrame(symbols_to_prices, index=idx)


@pytest.fixture(autouse=True)
def _no_network(monkeypatch):
    monkeypatch.setattr(alpaca, "available", lambda: False)
    monkeypatch.setattr(portfolio_router, "get_download", lambda *a, **k: pd.DataFrame())


def _stub(monkeypatch, intraday: pd.DataFrame, daily: pd.DataFrame, bars_tf: str | None = None):
    """Route the bar download to `intraday` and the prior-close download to `daily`.

    They are told apart by interval, so a range whose bars are themselves daily
    (3m/ytd/1y) must pass bars_tf="1d". That is safe because those ranges baseline
    off the first plotted point and never call the prior-close path at all.
    """
    tf = bars_tf or portfolio_router._LIVE_TF

    def fake_download(tickers, start, end, interval="1d", **kwargs):
        return intraday if interval == tf else daily
    monkeypatch.setattr(portfolio_router, "get_download", fake_download)

    # Ranges wider than a day are clipped to a window measured back from *today*
    # (_live_range_start), so a fixture pinned to a fixed date silently loses
    # points as real time moves past it — this file's dates would otherwise be a
    # slow fuse. Anchor "today" to the newest bar the fixture actually provides.
    if not intraday.empty:
        newest = pd.Timestamp(intraday.index.max())
        if newest.tzinfo is None:
            newest = newest.tz_localize("UTC")
        monkeypatch.setattr(portfolio_router, "_pd_today", lambda: newest)


def _daily(day: dt.date, symbols_to_prices: dict) -> pd.DataFrame:
    n = len(next(iter(symbols_to_prices.values())))
    idx = pd.to_datetime([day - dt.timedelta(days=n - 1 - i) for i in range(n)])
    return pd.DataFrame(symbols_to_prices, index=idx)


def _request(**kw):
    return portfolio_router.LiveValueRequest(**kw)


def test_cash_only_book_is_a_flat_line():
    got = portfolio_router.live_value(_request(holdings=[], cash=5000))
    assert got["value"] == 5000
    assert got["prior_value"] == 5000
    assert got["change_abs"] == 0.0
    assert got["points"] == []
    assert got["source"] == "none"


def test_empty_book_with_no_cash_is_rejected():
    with pytest.raises(HTTPException) as err:
        _request(holdings=[], cash=0)
    assert err.value.status_code == 400


def test_naive_intraday_index_is_read_as_eastern_not_utc(monkeypatch):
    """A 09:30 ET open must surface as 13:30Z. Localizing to UTC instead would
    emit 09:30Z and place the bar in the pre-market of the wrong session."""
    day = dt.date(2026, 8, 6)
    _stub(monkeypatch,
          _naive_et_bars(day, {"AAPL": [100.0, 101.0, 102.0]}),
          _daily(day - dt.timedelta(days=1), {"AAPL": [90.0, 95.0]}))

    got = portfolio_router.live_value(_request(holdings=[{"ticker": "AAPL", "shares": 10}], cash=0))

    assert got["session_date"] == "2026-08-06"
    assert got["points"][0]["t"] == "2026-08-06T13:30:00+00:00"
    assert got["points"][-1]["t"] == "2026-08-06T13:40:00+00:00"


def test_curve_is_shares_times_marks_plus_cash(monkeypatch):
    day = dt.date(2026, 8, 6)
    _stub(monkeypatch,
          _naive_et_bars(day, {"AAPL": [100.0, 110.0], "MSFT": [200.0, 200.0]}),
          _daily(day - dt.timedelta(days=1), {"AAPL": [100.0], "MSFT": [200.0]}))

    got = portfolio_router.live_value(_request(
        holdings=[{"ticker": "AAPL", "shares": 10}, {"ticker": "MSFT", "shares": 2}], cash=500))

    # 10*100 + 2*200 + 500 = 1900, then 10*110 + 2*200 + 500 = 2000
    assert [p["value"] for p in got["points"]] == [1900.0, 2000.0]
    assert got["value"] == 2000.0
    assert got["cash"] == 500.0


def test_day_change_measures_against_the_prior_session_close(monkeypatch):
    day = dt.date(2026, 8, 6)
    _stub(monkeypatch,
          _naive_et_bars(day, {"AAPL": [110.0]}),
          _daily(day - dt.timedelta(days=1), {"AAPL": [80.0, 100.0]}))

    got = portfolio_router.live_value(_request(holdings=[{"ticker": "AAPL", "shares": 10}], cash=0))

    assert got["prior_value"] == 1000.0        # 10 * the 100.0 prior close
    assert got["change_abs"] == 100.0
    assert got["change_pct"] == 10.0


def test_only_the_newest_session_is_plotted(monkeypatch):
    """A multi-day bar window must render as one intraday curve, not a stitched
    multi-day line."""
    older = _naive_et_bars(dt.date(2026, 8, 5), {"AAPL": [50.0, 51.0]})
    newest = _naive_et_bars(dt.date(2026, 8, 6), {"AAPL": [100.0, 101.0]})
    _stub(monkeypatch, pd.concat([older, newest]),
          _daily(dt.date(2026, 8, 5), {"AAPL": [99.0]}))

    got = portfolio_router.live_value(_request(holdings=[{"ticker": "AAPL", "shares": 1}], cash=0))

    assert got["session_date"] == "2026-08-06"
    assert [p["value"] for p in got["points"]] == [100.0, 101.0]


def test_bars_before_a_holdings_first_print_are_dropped(monkeypatch):
    """Otherwise the total steps up as names come online, which reads as a rally
    that never happened."""
    day = dt.date(2026, 8, 6)
    intraday = _naive_et_bars(day, {"AAPL": [100.0, 101.0, 102.0], "MSFT": [None, 200.0, 201.0]})
    _stub(monkeypatch, intraday, _daily(day - dt.timedelta(days=1), {"AAPL": [100.0], "MSFT": [200.0]}))

    got = portfolio_router.live_value(_request(
        holdings=[{"ticker": "AAPL", "shares": 1}, {"ticker": "MSFT", "shares": 1}], cash=0))

    assert len(got["points"]) == 2               # the leading MSFT-less bar is gone
    assert got["points"][0]["value"] == 301.0    # 101 + 200


def test_a_stale_holding_carries_its_last_print_forward(monkeypatch):
    day = dt.date(2026, 8, 6)
    intraday = _naive_et_bars(day, {"AAPL": [100.0, 101.0], "MSFT": [200.0, None]})
    _stub(monkeypatch, intraday, _daily(day - dt.timedelta(days=1), {"AAPL": [100.0], "MSFT": [200.0]}))

    got = portfolio_router.live_value(_request(
        holdings=[{"ticker": "AAPL", "shares": 1}, {"ticker": "MSFT", "shares": 1}], cash=0))

    assert [p["value"] for p in got["points"]] == [300.0, 301.0]


def test_duplicate_tickers_are_merged(monkeypatch):
    day = dt.date(2026, 8, 6)
    _stub(monkeypatch, _naive_et_bars(day, {"AAPL": [100.0]}),
          _daily(day - dt.timedelta(days=1), {"AAPL": [100.0]}))

    got = portfolio_router.live_value(_request(
        holdings=[{"ticker": "AAPL", "shares": 3}, {"ticker": "aapl", "shares": 2}], cash=0))

    assert got["priced"] == ["AAPL"]
    assert got["points"][0]["value"] == 500.0


def test_no_intraday_data_is_a_404(monkeypatch):
    _stub(monkeypatch, pd.DataFrame(), pd.DataFrame())
    with pytest.raises(HTTPException) as err:
        portfolio_router.live_value(_request(holdings=[{"ticker": "AAPL", "shares": 1}], cash=0))
    assert err.value.status_code == 404


def test_missing_prior_close_reports_no_baseline_rather_than_inventing_one(monkeypatch):
    day = dt.date(2026, 8, 6)
    _stub(monkeypatch, _naive_et_bars(day, {"AAPL": [100.0]}), pd.DataFrame())

    got = portfolio_router.live_value(_request(holdings=[{"ticker": "AAPL", "shares": 1}], cash=0))

    assert got["prior_value"] is None
    assert got["change_abs"] is None
    assert got["change_pct"] is None


# ── Chart ranges ─────────────────────────────────────────────────────────────

def test_range_specs_cover_every_offered_range():
    """Every range the UI offers must resolve to a timeframe, or the endpoint 500s
    on a KeyError the moment someone clicks that button."""
    for rng in ("1h", "1d", "1w", "1m", "3m", "ytd", "1y"):
        tf, start = portfolio_router._live_range_start(rng)
        assert tf
        assert start


def test_fetch_start_is_padded_past_the_display_window():
    """Weekends and holidays must not short a window, so the fetch reaches back
    further than the range the user asked to see."""
    for rng in ("1w", "1m", "3m", "1y"):
        _, start = portfolio_router._live_range_start(rng)
        cutoff = portfolio_router._live_window_cutoff(rng)
        assert pd.Timestamp(start, tz="UTC") < cutoff, rng


def test_multi_day_ranges_measure_gain_from_the_first_plotted_point(monkeypatch):
    """Over a year of chart, the gain the user means is the change across what
    they are looking at — not a one-day move against a year-long axis."""
    day = dt.date(2026, 8, 6)
    idx = pd.to_datetime([day - dt.timedelta(days=n) for n in (20, 10, 0)])
    intraday = pd.DataFrame({"AAPL": [100.0, 150.0, 200.0]}, index=idx)
    _stub(monkeypatch, intraday, _daily(day - dt.timedelta(days=1), {"AAPL": [999.0]}), bars_tf="1d")

    got = portfolio_router.live_value(_request(
        holdings=[{"ticker": "AAPL", "shares": 1}], cash=0, range="1y"))

    assert got["range"] == "1y"
    assert got["prior_value"] == 100.0     # first plotted point, not the 999 daily close
    assert got["change_abs"] == 100.0
    assert got["change_pct"] == 100.0


def test_one_day_range_still_measures_against_the_prior_close(monkeypatch):
    day = dt.date(2026, 8, 6)
    _stub(monkeypatch,
          _naive_et_bars(day, {"AAPL": [110.0, 120.0]}),
          _daily(day - dt.timedelta(days=1), {"AAPL": [80.0, 100.0]}))

    got = portfolio_router.live_value(_request(
        holdings=[{"ticker": "AAPL", "shares": 1}], cash=0, range="1d"))

    assert got["prior_value"] == 100.0
    assert got["change_pct"] == 20.0


def test_multi_day_range_is_not_collapsed_to_one_session(monkeypatch):
    """The 1d path slices to the newest ET session. A week must NOT do that, or
    every long range would render a single day."""
    day = dt.date(2026, 8, 6)
    idx = pd.to_datetime([day - dt.timedelta(days=n) for n in (3, 2, 1, 0)])
    intraday = pd.DataFrame({"AAPL": [10.0, 11.0, 12.0, 13.0]}, index=idx)
    _stub(monkeypatch, intraday, _daily(day, {"AAPL": [10.0]}), bars_tf="30m")

    got = portfolio_router.live_value(_request(
        holdings=[{"ticker": "AAPL", "shares": 1}], cash=0, range="1w"))

    assert len(got["points"]) == 4


def test_an_unknown_range_is_rejected_by_validation():
    with pytest.raises(Exception):
        _request(holdings=[{"ticker": "AAPL", "shares": 1}], cash=0, range="10y")
