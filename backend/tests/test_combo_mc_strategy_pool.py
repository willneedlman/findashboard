"""Strategy-entry Monte Carlo: process-pool basket + horizon caps.

Run from backend/: python -m pytest tests/test_combo_mc_strategy_pool.py -q
"""
from __future__ import annotations

import numpy as np
import pytest

from routers import algo


def _hist(seed: int = 0, n: int = 120) -> np.ndarray:
    return np.cumprod(1 + np.random.default_rng(seed).normal(0, 0.01, n)) * 100


LEGS = [
    {"type": "call", "side": "sell", "moneyness": 1.0, "qty": 1},
    {"type": "put", "side": "sell", "moneyness": 1.0, "qty": 1},
]


def test_strategy_caps_allow_multi_year():
    assert algo._STRATEGY_HORIZON_CAP >= 1024
    assert algo._STRATEGY_N_SIMS_CAP >= 1000


def test_strategy_sim_job_prefetched_no_network():
    payload = {
        "ticker": "TEST",
        "legs_cfg": LEGS,
        "dte": 30,
        "horizon_days": 16,
        "r": 4.0,
        "committed_dollars": 800.0,
        "n": 40,
        "dt": 1 / 365,
        "seed": 7,
        "strategy": "momentum",
        "strategy_params": {"lookback": 20},
        "take_profit_pct": None,
        "stop_loss_pct": None,
        "max_hold_days": None,
        "strategy_rules": None,
        "spot": 100.0,
        "iv": 35.0,
        "hist_values": _hist(),
    }
    res = algo._strategy_sim_job(payload)
    assert res["ok"] is True
    assert res["pnl_path"].shape == (40, 17)
    assert res["trades_total"].shape == (40,)


def test_run_strategy_basket_in_process():
    hist = _hist()
    market = {
        "AAA": {"spot": 100.0, "iv": 30.0, "hist_values": hist},
        "BBB": {"spot": 50.0, "iv": 40.0, "hist_values": hist * 0.5},
    }
    # Below PROC_MIN_WORK → in-process path
    old = algo._STRATEGY_PROC_MIN_WORK
    algo._STRATEGY_PROC_MIN_WORK = 10**12
    try:
        pnl, _open, per, dropped = algo._run_strategy_basket(
            ["AAA", "BBB"], market, LEGS, 30, 12, 4.0, 400.0, 25, 1 / 365,
            "momentum", {"lookback": 20}, None, None, None, None,
        )
    finally:
        algo._STRATEGY_PROC_MIN_WORK = old
    assert not dropped
    assert set(per) == {"AAA", "BBB"}
    assert pnl.shape == (25, 13)
    # Aggregated basket P&L is sum of legs
    assert np.allclose(
        pnl,
        per["AAA"]["pnl_path"] + per["BBB"]["pnl_path"],
    )


def test_run_strategy_basket_process_pool():
    hist = _hist()
    market = {
        "AAA": {"spot": 100.0, "iv": 30.0, "hist_values": hist},
        "BBB": {"spot": 55.0, "iv": 40.0, "hist_values": hist * 0.5},
        "CCC": {"spot": 80.0, "iv": 28.0, "hist_values": hist * 0.8},
    }
    old = algo._STRATEGY_PROC_MIN_WORK
    algo._STRATEGY_PROC_MIN_WORK = 1  # force process pool
    try:
        pnl, _open, per, dropped = algo._run_strategy_basket(
            ["AAA", "BBB", "CCC"], market, LEGS, 30, 20, 4.0, 300.0, 30, 1 / 365,
            "rsi_mean_reversion", {"period": 14}, None, None, None, None,
        )
    finally:
        algo._STRATEGY_PROC_MIN_WORK = old
    assert not dropped, dropped
    assert set(per) == {"AAA", "BBB", "CCC"}
    assert pnl.shape == (30, 21)
