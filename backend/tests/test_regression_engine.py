"""Tests for the strategy-regression / Monte-Carlo engine.

Cover the math (vs sklearn / closed form), the vectorized batch path against the
scalar loop, shape disambiguation, degeneracy handling, rolling windows, and
ingestion alignment.
"""
import os
import sys

import numpy as np
import pandas as pd
import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from regression_engine import (  # noqa: E402
    RegressionInput,
    SimulationPathData,
    batch_single_factor,
    ols,
    path_regression,
    regression_input_from_frames,
    rolling_ols,
    simulation_from_matrices,
    to_returns,
)


def _mock(seed=0, T=250, alpha=0.5, beta=1.8, noise=0.3):
    rng = np.random.default_rng(seed)
    x = rng.standard_normal(T)
    y = alpha + beta * x + noise * rng.standard_normal(T)
    return x, y


def test_ols_matches_sklearn():
    from sklearn.linear_model import LinearRegression
    x, y = _mock()
    o = ols(RegressionInput(y, x, ["mkt"]))
    sk = LinearRegression().fit(x.reshape(-1, 1), y)
    assert o.alpha == pytest.approx(sk.intercept_, rel=1e-9)
    assert o.betas[0] == pytest.approx(sk.coef_[0], rel=1e-9)
    assert o.r_squared == pytest.approx(sk.score(x.reshape(-1, 1), y), rel=1e-9)
    assert 0.0 <= o.p_values[1] <= 1.0
    assert o.n_obs == 250


def test_ols_recovers_known_coefficients():
    x, y = _mock(seed=3, T=4000, alpha=0.5, beta=1.8, noise=0.3)
    o = ols(RegressionInput(y, x, ["mkt"]))
    assert o.alpha == pytest.approx(0.5, abs=0.02)
    assert o.betas[0] == pytest.approx(1.8, abs=0.02)


def test_multifactor_ols():
    rng = np.random.default_rng(1)
    T = 500
    X = rng.standard_normal((T, 3))
    y = 0.1 + X @ np.array([1.0, -0.5, 2.0]) + 0.2 * rng.standard_normal(T)
    o = ols(RegressionInput(y, X, ["a", "b", "c"]), with_residuals=True)
    assert o.betas == pytest.approx([1.0, -0.5, 2.0], abs=0.05)
    assert o.residuals is not None and o.residuals.shape == (T,)
    assert o.f_stat is not None and o.f_stat > 0


def test_batch_matches_scalar_loop():
    x, _ = _mock(seed=5)
    Y = np.stack([_mock(seed=s)[1] for s in range(20)])
    b = batch_single_factor(Y, x)  # shared x
    for i in range(20):
        oi = ols(RegressionInput(Y[i], x, ["mkt"]))
        assert b["alpha"][i] == pytest.approx(oi.alpha, rel=1e-9)
        assert b["beta"][i] == pytest.approx(oi.betas[0], rel=1e-9)
        assert b["r_squared"][i] == pytest.approx(oi.r_squared, rel=1e-9)
        assert b["p_beta"][i] == pytest.approx(oi.p_values[1], rel=1e-6)


def test_batch_per_path_factor():
    rng = np.random.default_rng(9)
    P, T = 30, 200
    X = rng.standard_normal((P, T))
    Y = 0.2 + 1.1 * X + 0.25 * rng.standard_normal((P, T))
    b = batch_single_factor(Y, X)
    assert np.nanmean(b["beta"]) == pytest.approx(1.1, abs=0.03)
    assert np.nanmean(b["alpha"]) == pytest.approx(0.2, abs=0.02)


def test_degenerate_factor_flagged():
    T = 100
    b = batch_single_factor(np.random.default_rng(0).standard_normal((3, T)), np.ones(T))
    assert b["degenerate"].all()
    assert np.isnan(b["beta"]).all()


def test_path_regression_shared_and_perpath_agree():
    rng = np.random.default_rng(2)
    P, T = 200, 252
    mkt = rng.standard_normal(T)
    strat = 0.3 + 0.6 * mkt + 0.2 * rng.standard_normal((P, T))
    res = path_regression(SimulationPathData(strat, mkt, ["SPX"]))
    assert res.n_paths == P and res.n_obs == T and res.n_failed == 0
    assert res.betas[0].mean == pytest.approx(0.6, abs=0.02)
    assert res.alpha.mean == pytest.approx(0.3, abs=0.02)
    assert 0.0 <= res.r_squared.mean <= 1.0
    assert res.per_path is not None and res.per_path["beta"].shape == (P,)


def test_path_regression_counts_degenerate():
    rng = np.random.default_rng(4)
    P, T = 10, 120
    strat = rng.standard_normal((P, T))
    mkt = rng.standard_normal((P, T))
    mkt[0] = 0.0  # one path's factor is constant -> dropped
    res = path_regression(SimulationPathData(strat, mkt, ["SPX"]))
    assert res.n_failed == 1
    assert res.betas[0].mean == res.betas[0].mean  # not NaN (degenerate excluded)
    # per_path must be filtered to match the distributions (no NaN, equal length).
    assert res.per_path is not None
    assert res.per_path["beta"].shape[0] == P - res.n_failed
    assert np.isfinite(res.per_path["beta"]).all()


def test_square_matrix_treated_as_per_path():
    P = T = 64  # square (P == T): must read as per-path, not shared
    rng = np.random.default_rng(0)
    mkt = rng.standard_normal((P, T))
    strat = 0.2 + 0.7 * mkt + 0.2 * rng.standard_normal((P, T))
    sim = SimulationPathData(strat, mkt, ["SPX"])
    assert sim.per_path and sim.single_factor
    res = path_regression(sim)
    assert res.n_paths == P and res.betas[0].mean == pytest.approx(0.7, abs=0.05)


def test_path_regression_multifactor():
    rng = np.random.default_rng(6)
    P, T, k = 50, 300, 2
    factors = rng.standard_normal((T, k))  # shared (T, k)
    coefs = np.array([0.8, -0.4])
    strat = 0.1 + factors @ coefs + 0.2 * rng.standard_normal((P, T))
    res = path_regression(SimulationPathData(strat, factors, ["A", "B"]))
    assert len(res.betas) == 2
    assert res.betas[0].mean == pytest.approx(0.8, abs=0.03)
    assert res.betas[1].mean == pytest.approx(-0.4, abs=0.03)


def test_shape_disambiguation():
    P, T = 8, 60
    strat = np.random.default_rng(0).standard_normal((P, T))
    assert SimulationPathData(strat, np.ones(T), ["m"]).shared          # (T,)
    assert SimulationPathData(strat, np.ones((T, 2)), ["a", "b"]).shared  # (T,k)
    assert SimulationPathData(strat, np.ones((P, T)), ["m"]).per_path    # (P,T)
    assert SimulationPathData(strat, np.ones((P, T, 1)), ["m"]).per_path  # (P,T,k)


def test_rolling_ols_alignment():
    x, y = _mock(seed=8, T=300)
    roll = rolling_ols(RegressionInput(y, x, ["mkt"]), window=60, step=1)
    assert roll["betas"].shape == (300 - 60 + 1, 1)
    assert roll["end_idx"][0] == 59 and roll["end_idx"][-1] == 299
    assert np.nanmean(roll["betas"][:, 0]) == pytest.approx(1.8, abs=0.1)


def test_rolling_multifactor_matches_single_window():
    rng = np.random.default_rng(11)
    T = 200
    X = rng.standard_normal((T, 2))
    y = X @ np.array([1.0, -1.0]) + 0.1 * rng.standard_normal(T)
    roll = rolling_ols(RegressionInput(y, X, ["a", "b"]), window=80)
    direct = ols(RegressionInput(y[:80], X[:80], ["a", "b"]))
    assert roll["betas"][0] == pytest.approx(direct.betas, rel=1e-9)


def test_to_returns_and_ingest_alignment():
    prices = np.array([100.0, 101.0, 102.0, 100.0])
    log_r = to_returns(prices, "log")
    assert log_r.shape == (3,)
    assert log_r[0] == pytest.approx(np.log(101 / 100))

    idx = pd.date_range("2024-01-01", periods=50)
    ydf = pd.DataFrame({"STRAT": np.linspace(100, 120, 50)}, index=idx)
    xdf = pd.DataFrame({"SPX": np.linspace(4000, 4400, 50)}, index=idx[::-1].sort_values())
    inp = regression_input_from_frames(ydf, xdf, "STRAT", ["SPX"], use_returns=True)
    assert inp.y.shape[0] == inp.X.shape[0] == 49
    assert inp.factor_names == ["SPX"]


def test_simulation_from_price_matrices():
    rng = np.random.default_rng(0)
    strat_px = 100 * np.cumprod(1 + 0.01 * rng.standard_normal((5, 50)), axis=1)
    mkt_px = 4000 * np.cumprod(1 + 0.01 * rng.standard_normal((5, 50)), axis=1)
    sim = simulation_from_matrices(strat_px, mkt_px, ["SPX"], as_returns_kind="log")
    assert sim.strategy_paths.shape == (5, 49)
    assert sim.per_path and sim.single_factor


def test_determinism():
    x, y = _mock(seed=1)
    a = ols(RegressionInput(y, x, ["m"])).to_dict()
    b = ols(RegressionInput(y, x, ["m"])).to_dict()
    assert a == b
