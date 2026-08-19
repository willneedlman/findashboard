import os
import sys
from datetime import date, timedelta

import pandas as pd
import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))

from routers import rates as R  # noqa: E402


def _anchor_frame(days: int) -> pd.DataFrame:
    """Ten years of flat-ish anchors, framed like _fred_anchor_history returns."""
    idx = pd.bdate_range(end=date.today() - timedelta(days=1), periods=2600)
    frame = pd.DataFrame(index=idx)
    for sym, level in (("^IRX", 4.0), ("^FVX", 4.2), ("^TNX", 4.4), ("^TYX", 4.6)):
        frame[sym] = level
    return frame[frame.index >= pd.Timestamp(date.today() - timedelta(days=days))]


@pytest.fixture
def _fred(monkeypatch):
    monkeypatch.setattr(R, "_fred_anchor_history", lambda days: _anchor_frame(days))
    R.curve_spreads.cache_clear()
    yield
    R.curve_spreads.cache_clear()


def test_history_scales_with_lookback(_fred):
    """The slice used to be a hard [-126:], so every caller got six months."""
    short = R.curve_spreads(lookback=200)["spreads"][0]["history"]
    deep = R.curve_spreads(lookback=3650)["spreads"][0]["history"]
    assert len(deep) > 5 * len(short)
    assert deep[0]["date"] < short[0]["date"]


def test_default_window_stays_about_six_months(_fred):
    """The Rate Engine panel reads low/high as a six-month range."""
    history = R.curve_spreads()["spreads"][0]["history"]
    assert 120 <= len(history) <= 150


def test_lookback_is_clamped(_fred):
    """A hostile value cannot ask FRED for a thousand years."""
    assert len(R.curve_spreads(lookback=10**9)["spreads"][0]["history"]) <= 2600
    assert len(R.curve_spreads(lookback=-5)["spreads"][0]["history"]) > 0


def test_falls_back_to_yfinance_without_a_fred_key(monkeypatch):
    """No key must not mean no curve: the yfinance path still has to run."""
    monkeypatch.setattr(R, "_FRED_KEY", "")
    assert R._fred_anchor_history(400).empty
