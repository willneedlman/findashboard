import os
import sys

import pandas as pd

sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))

from routers.portfolio import _series_metrics  # noqa: E402


def test_short_window_reports_period_return_without_calling_it_cagr_applicable():
    dates = pd.to_datetime(["2026-01-02", "2026-07-31"])
    equity = pd.Series([1.0, 1.081], index=dates)
    benchmark = pd.Series([0.0, 0.084], index=dates)

    metrics = _series_metrics(equity, benchmark, 0.04)

    assert metrics["period_return"] == 8.1
    assert metrics["cagr_applicable"] is False
    assert metrics["period_days"] == 210
    assert metrics["observations"] == 2
    assert metrics["cumulative_return_method"] == "auto-adjusted close, daily time-weighted proxy"
