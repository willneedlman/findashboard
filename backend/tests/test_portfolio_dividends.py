import os
import sys

import numpy as np
import pandas as pd

sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))

from routers import portfolio as pf  # noqa: E402


def _action_frame() -> pd.DataFrame:
    index = pd.bdate_range("2025-01-02", periods=4)
    columns = pd.MultiIndex.from_product([["Close", "Dividends"], ["AAPL", "SPY"]])
    frame = pd.DataFrame(0.0, index=index, columns=columns)
    frame[("Close", "AAPL")] = 100.0
    frame[("Close", "SPY")] = 100.0
    frame.loc[index[1], ("Dividends", "AAPL")] = 1.0
    frame.loc[index[2], ("Dividends", "AAPL")] = 1.0
    return frame


def _patch(monkeypatch) -> None:
    monkeypatch.setattr(pf, "get_download", lambda *args, **kwargs: _action_frame())
    monkeypatch.setattr(pf, "_get_risk_free_rate", lambda: 0.0)


def _backtest(mode: str) -> dict:
    return pf.backtest(pf.BacktestRequest(
        tickers=["AAPL"], weights=[1.0], benchmark="SPY",
        start="2025-01-02", end="2025-01-10", dividend_mode=mode,
    ))


def test_backtest_dividend_modes_post_and_report_payments(monkeypatch):
    _patch(monkeypatch)
    reinvest = _backtest("reinvest")
    cash = _backtest("cash")
    exclude = _backtest("exclude")

    assert reinvest["cumulative"][-1]["portfolio"] > cash["cumulative"][-1]["portfolio"]
    assert cash["cumulative"][-1]["portfolio"] > exclude["cumulative"][-1]["portfolio"]
    assert exclude["cumulative"][-1]["portfolio"] == 100.0
    assert len(cash["dividend_payments"]) == 2
    assert cash["dividend_total_pct"] == 2.0
    assert exclude["dividend_total_pct"] == 2.0


def test_monte_carlo_reports_mode_yield_and_dividend_income(monkeypatch):
    _patch(monkeypatch)
    out = pf.monte_carlo(pf.MonteCarloRequest(
        tickers=["AAPL"], weights=[1.0], start="2025-01-02", end="2025-01-10",
        n_sims=20, horizon_days=10, dividend_mode="cash",
    ))

    assert out["dividend_mode"] == "cash"
    assert out["dividend_yield_pct"] > 0
    assert out["median_dividend_income_pct"] > 0
    assert np.isfinite(out["percentiles"]["p50"])
    terminal_path = out["percentile_paths"][-1]
    assert terminal_path["day"] == 10
    for key in ("p5", "p25", "p50", "p75", "p95"):
        assert terminal_path[key] == out["percentiles"][key]
    assert out["long_maintenance_margin"] == 0.25
    assert "pct_margin_called" in out
    assert "pct_forced_liquidation" in out


def test_margin_ledger_forces_deleveraging_when_requirement_exceeds_equity():
    gross = np.ones((3, 2))
    equity, called, liquidated, insolvent, max_util = pf._margin_equity_paths(
        gross, leverage=5.0, borrow_rate=0.0, maintenance_margin=0.25,
    )

    assert called.all()
    assert liquidated.all()
    assert not insolvent.any()
    assert np.allclose(equity, 1.0)
    assert np.allclose(max_util, 1.25)


def test_margin_ledger_fully_liquidates_nonpositive_equity():
    gross = np.array([[1.0], [0.5], [0.4]])
    equity, called, liquidated, insolvent, _ = pf._margin_equity_paths(
        gross, leverage=2.0, borrow_rate=0.0, maintenance_margin=0.25,
    )

    assert not called[0]
    assert liquidated[0]
    assert insolvent[0]
    assert equity[-1, 0] == 0
