import numpy as np
import pandas as pd

from routers.algo import _annualized_volatility, _compute_metrics, _mc_path_metrics, _volatility_drag


def test_volatility_annualizes_equity_return_deviation():
    returns = pd.Series([0.01, -0.02, 0.03, -0.01])

    result = _annualized_volatility(returns, 252)

    expected = returns.std() * np.sqrt(252) * 100
    assert result == round(expected, 2)


def test_volatility_drag_is_half_annualized_variance():
    returns = pd.Series([0.02, -0.01, 0.03, -0.02])

    result = _volatility_drag(returns, 12)

    assert result == round(0.5 * returns.var() * 12 * 100, 2)


def test_share_backtest_includes_volatility_metrics():
    close = pd.Series(
        [100.0, 100.0, 110.0, 90.0, 95.0],
        index=pd.date_range("2025-01-01", periods=5, freq="D"),
    )
    buy = np.array([False, True, False, False, False])
    sell = np.zeros(5, dtype=bool)

    result = _compute_metrics(buy, sell, close)
    equity = pd.Series([point["strategy"] for point in result["equity_curve"]])
    expected = _annualized_volatility(equity.pct_change(), 252)
    expected_drag = _volatility_drag(equity.pct_change(), 252)

    assert result["metrics"]["volatility"] == expected
    assert result["metrics"]["volatility_drag"] == expected_drag


def test_monte_carlo_path_metrics_include_core_backtest_statistics():
    paths = np.array([
        [100.0, 102.0, 101.0, 105.0],
        [100.0, 98.0, 103.0, 104.0],
        [100.0, 101.0, 99.0, 106.0],
    ])

    result = _mc_path_metrics(paths)

    assert set(result) == {"cagr", "volatility", "volatility_drag", "max_drawdown", "sharpe"}
    assert result["volatility"] > 0
    assert result["volatility_drag"] >= 0
    assert result["max_drawdown"] <= 0
