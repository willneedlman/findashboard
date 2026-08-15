import datetime as dt
import os
import sys

import pandas as pd

sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))

from routers import market  # noqa: E402


def _closes(dates, values):
    return pd.Series(values, index=pd.to_datetime(dates))


def test_todays_bar_is_not_its_own_baseline(monkeypatch):
    today = dt.date(2026, 8, 14)
    monkeypatch.setattr(market, "now_et", lambda: dt.datetime(2026, 8, 14, 23, 18))
    closes = _closes(["2026-08-12", "2026-08-13", "2026-08-14"], [100.0, 110.0, 120.0])

    # Once today's bar exists the 1-day move runs from the bar before it. Taking
    # the last bar unguarded made overnight-moves compare a live print against
    # today's own close and report that as an overnight gap.
    assert market._prior_session_close(closes) == 110.0
    assert market._session_closes(closes) == (120.0, 110.0, True)
    assert today.isoformat() == "2026-08-14"


def test_last_bar_is_the_baseline_before_todays_bar_exists(monkeypatch):
    monkeypatch.setattr(market, "now_et", lambda: dt.datetime(2026, 8, 14, 7, 0))
    closes = _closes(["2026-08-12", "2026-08-13"], [100.0, 110.0])

    assert market._prior_session_close(closes) == 110.0
    assert market._session_closes(closes) == (110.0, 100.0, False)


def test_single_bar_has_no_prior(monkeypatch):
    monkeypatch.setattr(market, "now_et", lambda: dt.datetime(2026, 8, 14, 23, 18))
    closes = _closes(["2026-08-14"], [120.0])

    assert market._session_closes(closes) == (120.0, None, True)
    # No earlier bar to measure from, so the baseline degrades to the bar itself
    # rather than inventing one.
    assert market._prior_session_close(closes) == 120.0


def test_empty_series_yields_nothing():
    assert market._session_closes(None) == (None, None, False)
    assert market._session_closes(pd.Series(dtype=float)) == (None, None, False)
    assert market._prior_session_close(None) is None
