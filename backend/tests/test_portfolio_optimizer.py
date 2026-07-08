"""Portfolio optimizer math — network-free, on a synthetic covariance/mean set."""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))

import numpy as np

from routers.portfolio_optimizer import (
    _max_sharpe, _min_variance, _risk_parity, _port_stats, _weights_out, _max_dd,
)

# 3 assets: A high return/high vol, B moderate, C low return/low vol; mild correlation.
MU = np.array([0.30, 0.12, 0.05])
COV = np.array([
    [0.09, 0.01, 0.00],
    [0.01, 0.04, 0.005],
    [0.00, 0.005, 0.01],
])
RF = 0.04


def test_weights_sum_to_one_and_long_only():
    for w in (_max_sharpe(MU, COV, RF, True), _min_variance(COV, True), _risk_parity(COV)):
        assert abs(w.sum() - 1.0) < 1e-6
        assert (w >= -1e-6).all(), "long-only weights must be non-negative"


def test_min_variance_has_lowest_vol():
    mv = _min_variance(COV, True)
    ms = _max_sharpe(MU, COV, RF, True)
    ew = np.repeat(1 / 3, 3)
    vol = lambda w: _port_stats(w, MU, COV, RF)["vol"]
    assert vol(mv) <= vol(ms) + 1e-6
    assert vol(mv) <= vol(ew) + 1e-6


def test_max_sharpe_beats_equal_weight_sharpe():
    ms = _max_sharpe(MU, COV, RF, True)
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
