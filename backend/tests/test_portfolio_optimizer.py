"""Portfolio optimizer math — network-free, on a synthetic covariance/mean set."""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))

import numpy as np
import pytest

from routers.portfolio_optimizer import (
    _max_sharpe, _min_variance, _risk_parity, _port_stats, _weights_out, _max_dd, _resolve_bounds,
)

# 3 assets: A high return/high vol, B moderate, C low return/low vol; mild correlation.
MU = np.array([0.30, 0.12, 0.05])
COV = np.array([
    [0.09, 0.01, 0.00],
    [0.01, 0.04, 0.005],
    [0.00, 0.005, 0.01],
])
RF = 0.04
LONG_ONLY_BOUNDS = _resolve_bounds([], "long_only", None, 3)


def test_weights_sum_to_one_and_long_only():
    for w in (_max_sharpe(MU, COV, RF, LONG_ONLY_BOUNDS), _min_variance(COV, LONG_ONLY_BOUNDS), _risk_parity(COV)):
        assert abs(w.sum() - 1.0) < 1e-6
        assert (w >= -1e-6).all(), "long-only weights must be non-negative"


def test_min_variance_has_lowest_vol():
    mv = _min_variance(COV, LONG_ONLY_BOUNDS)
    ms = _max_sharpe(MU, COV, RF, LONG_ONLY_BOUNDS)
    ew = np.repeat(1 / 3, 3)
    vol = lambda w: _port_stats(w, MU, COV, RF)["vol"]
    assert vol(mv) <= vol(ms) + 1e-6
    assert vol(mv) <= vol(ew) + 1e-6


def test_max_sharpe_beats_equal_weight_sharpe():
    ms = _max_sharpe(MU, COV, RF, LONG_ONLY_BOUNDS)
    ew = np.repeat(1 / 3, 3)
    assert _port_stats(ms, MU, COV, RF)["sharpe"] >= _port_stats(ew, MU, COV, RF)["sharpe"] - 1e-6


def test_risk_parity_equalizes_risk_contributions():
    w = _risk_parity(COV)
    rows = _weights_out(["A", "B", "C"], w, COV)
    rc = [r["risk_contribution"] for r in rows]
    # Every asset carries roughly the same share of portfolio risk (~33% each).
    assert max(rc) - min(rc) < 12.0, f"risk contributions not balanced: {rc}"


def test_max_drawdown_sign_and_bounds():
    up = np.full(50, 0.01)          # only-up series → no drawdown
    down = np.array([0.05, -0.20, -0.10, 0.02])
    assert _max_dd(up) == 0.0
    assert -1.0 <= _max_dd(down) < 0.0


def test_concentrated_bounds_infeasible_for_too_few_names():
    # ±10% preset needs >=10 names to reach 100% at all (10 x 0.10 = 1.0); with
    # only 3, the budget constraint is unreachable and should error clearly
    # rather than silently returning an out-of-bounds "solution".
    from fastapi import HTTPException
    from routers.portfolio_optimizer import _validate_bounds_feasible
    bounds = _resolve_bounds([], "concentrated", None, 3)
    assert bounds == [(-0.10, 0.10)] * 3
    with pytest.raises(HTTPException):
        _validate_bounds_feasible(bounds)


def test_concentrated_bounds_respected_with_enough_names():
    # With 12 names the ±10% budget IS reachable (12 x 0.10 = 1.2 >= 1.0); this
    # also exercises the feasible-x0 fix (equal-weight 1/12=0.083 is within
    # bounds here, but the fix must still hold for tighter cases generally).
    n = 12
    mu = np.linspace(0.05, 0.30, n)
    cov = np.eye(n) * 0.04 + 0.005
    bounds = _resolve_bounds([], "concentrated", None, n)
    w = _max_sharpe(mu, cov, RF, bounds)
    assert abs(w.sum() - 1.0) < 1e-6
    assert (w >= -0.10 - 1e-6).all() and (w <= 0.10 + 1e-6).all()


def test_custom_bounds_per_ticker():
    bounds = _resolve_bounds(["A", "B", "C"], "custom", {"A": [0.0, 0.5], "B": [0.0, 0.2]}, 3)
    assert bounds == [(0.0, 0.5), (0.0, 0.2), (0.0, 1.0)]   # C not listed -> default [0,1]


def test_capital_allocation_moderate_risk_aversion():
    from routers.portfolio_optimizer import _capital_allocation
    # A=45 is "moderate" under this module's calibration (see _capital_allocation's
    # docstring) — the WRDS doc's literal 0.1/0.05 coefficients on DECIMAL returns
    # need A roughly 10-80 to produce a non-clipped, non-trivial allocation.
    out = _capital_allocation(r_tang=0.15, sigma_tang=0.20, rf=0.04, risk_aversion=45.0,
                              allow_leverage=False, max_frontier_vol=0.25)
    assert 0.0 < out["weight_tangency"] < 100.0
    assert out["weight_tangency"] + out["weight_risk_free"] == 100.0
    # Complete portfolio return must sit between rf and tangency return for a
    # long-only (no leverage) allocation.
    assert 4.0 <= out["complete_portfolio"]["return"] <= 15.0
    assert len(out["indifference_curve"]) == 30
    assert out["cal_line"][0] == {"vol": 0.0, "return": 4.0}


def test_capital_allocation_clips_without_leverage():
    # Low risk aversion implies >100% in the tangency portfolio; without leverage
    # allowed, weight_tangency must clip at 100%.
    from routers.portfolio_optimizer import _capital_allocation
    out = _capital_allocation(r_tang=0.15, sigma_tang=0.20, rf=0.04, risk_aversion=5.0,
                              allow_leverage=False, max_frontier_vol=0.25)
    assert out["weight_tangency"] == 100.0
    assert out["complete_portfolio"]["return"] == 15.0


def test_capital_allocation_leverage_extends_cal():
    # High risk tolerance (low A) with leverage allowed should push past 100%
    # (capped at 300%) and extend the CAL line past the tangency point.
    from routers.portfolio_optimizer import _capital_allocation
    out = _capital_allocation(r_tang=0.15, sigma_tang=0.20, rf=0.04, risk_aversion=5.0,
                              allow_leverage=True, max_frontier_vol=0.25)
    assert out["weight_tangency"] > 100.0
    assert len(out["cal_line"]) == 3   # extended past the tangency point
