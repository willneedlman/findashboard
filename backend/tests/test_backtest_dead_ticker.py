"""A dead ticker (bad / newly-listed / delisted, so its price column is all NaN)
must not collapse the whole backtest to empty — the rest of the book still
charts and weights renormalize. This is what made a wide aggregated portfolio
show 'No performance data' on the homescreen Overview. Network-free: get_download
and the risk-free rate are monkeypatched.
"""
import os
import sys

import numpy as np
import pandas as pd

sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))

from routers import portfolio as pf  # noqa: E402


def _frame(dead_col=True):
    idx = pd.bdate_range("2025-01-01", periods=40)
    data = {
        "AAPL": np.linspace(100, 112, 40),
        "MSFT": np.linspace(200, 214, 40),
        "SPY": np.linspace(400, 424, 40),
    }
    if dead_col:
        data["ZZZZ"] = [float("nan")] * 40   # unfetchable symbol
    return pd.DataFrame(data, index=idx)


def _patch(monkeypatch, df):
    monkeypatch.setattr(pf, "get_download", lambda *a, **k: df)
    monkeypatch.setattr(pf, "_get_risk_free_rate", lambda: 0.04)


def test_dead_ticker_is_dropped_not_fatal(monkeypatch):
    _patch(monkeypatch, _frame(dead_col=True))
    req = pf.BacktestRequest(
        tickers=["AAPL", "MSFT", "ZZZZ"], weights=[0.34, 0.33, 0.33],
        benchmark="SPY", start="2025-01-01", end="2025-03-01", interval="1d",
    )
    out = pf.backtest(req)
    assert len(out["cumulative"]) >= 2                      # charts instead of 404
    assert set(out["per_ticker_returns"].keys()) == {"AAPL", "MSFT"}  # ZZZZ dropped
    # surviving equity weights renormalize (0.34 + 0.33 of the book, cash 0)
    assert req.tickers == ["AAPL", "MSFT"]


def test_all_good_tickers_unaffected(monkeypatch):
    _patch(monkeypatch, _frame(dead_col=False))
    req = pf.BacktestRequest(
        tickers=["AAPL", "MSFT"], weights=[0.5, 0.5],
        benchmark="SPY", start="2025-01-01", end="2025-03-01", interval="1d",
    )
    out = pf.backtest(req)
    assert len(out["cumulative"]) >= 2
    assert set(out["per_ticker_returns"].keys()) == {"AAPL", "MSFT"}


def test_large_aggregate_book_validates():
    # 21 names (an aggregate of several portfolios) used to fail validate_tickers'
    # default max_count=20 before any data was fetched.
    tickers = [f"A{chr(ord('A') + i)}" for i in range(21)]  # AA, AB, ... AU
    req = pf.BacktestRequest(tickers=tickers, weights=[1 / 21] * 21,
                             benchmark="SPY", start="2025-01-01", end="2025-03-01")
    assert len(req.tickers) == 21
