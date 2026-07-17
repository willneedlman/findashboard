"""Algo Strategy rules must evaluate correctly inside options Monte Carlo paths.

Covers the failure modes that previously left equity flat at $100:
  - OPT_IVRANK(252) needs ~272 bars (hist lookback / pad)
  - groups-form rules from CustomStrategyModal
  - path vol max(ATM IV, HV) so rare crash entries can realize
"""
from __future__ import annotations

import numpy as np
import pytest

from routers.algo import (
    _STRATEGY_HIST_MIN_BARS,
    _normalize_mc_strategy_rules,
    _path_vol_and_drift,
    _strategy_sim_job,
    _synthetic_hist,
)


CRASH_RULES = {
    "buy": {
        "logic": "AND",
        "groups": [{
            "logic": "AND",
            "conditions": [
                {"lhs": {"type": "OPT_IVRANK", "period": 252}, "op": "gt", "rhs_type": "number", "rhs_num": 80},
                {"lhs": {"type": "PCT_CHANGE", "period": 30}, "op": "lt", "rhs_type": "number", "rhs_num": -20},
                {"lhs": {"type": "PCT_CHANGE", "period": 10}, "op": "lt", "rhs_type": "number", "rhs_num": -10},
            ],
        }],
    },
    "sell": {
        "logic": "AND",
        "groups": [{
            "logic": "AND",
            "conditions": [
                {"lhs": {"type": "OPT_IVRANK", "period": 252}, "op": "lt", "rhs_type": "number", "rhs_num": 50},
            ],
        }],
    },
}

LEGS = [
    {"type": "call", "side": "sell", "moneyness": 1.2, "qty": 1},
    {"type": "put", "side": "sell", "moneyness": 0.8, "qty": 1},
]


def test_normalize_rules_strips_ticker_and_coerces_numbers():
    raw = {
        "buy": {
            "logic": "AND",
            "conditions": [{
                "lhs": {"type": "OPT_IVRANK", "period": "252", "ticker": "SPY"},
                "op": "gt",
                "rhs_type": "number",
                "rhs_num": "80",
            }],
        },
        "sell": {"logic": "AND", "conditions": []},
    }
    n = _normalize_mc_strategy_rules(raw)
    assert n is not None
    cond = n["buy"]["groups"][0]["conditions"][0]
    assert "ticker" not in cond["lhs"]
    assert cond["lhs"]["period"] == 252
    assert cond["rhs_num"] == 80.0


def test_path_vol_uses_at_least_hist_rv():
    hist = _synthetic_hist(100.0, 400, seed=1)
    # Amp the end so HV is elevated
    hist = np.concatenate([hist, hist[-1] * np.cumprod(1 + np.random.default_rng(2).normal(0, 0.04, 40))])
    sigma, mu = _path_vol_and_drift(hist, atm_iv=20.0)
    assert sigma >= 0.20  # at least the ATM floor / elevated HV
    assert -0.4 <= mu <= 0.4


def test_crash_rules_fire_on_mc_paths():
    """IVR∧crash rules must produce some entries when path vol is realistic."""
    hist = _synthetic_hist(100.0, 400, seed=3)
    hist = np.concatenate([hist[:-1], hist[-1] * np.cumprod(1 + np.random.default_rng(4).normal(0, 0.03, 50))])
    res = _strategy_sim_job({
        "ticker": "TEST",
        "legs_cfg": LEGS,
        "dte": 30,
        "horizon_days": 126,
        "r": 4.0,
        "committed_dollars": 2000.0,
        "n": 200,
        "dt": 1 / 365,
        "seed": 9,
        "strategy": None,
        "strategy_params": None,
        "take_profit_pct": None,
        "stop_loss_pct": None,
        "max_hold_days": 30,
        "strategy_rules": CRASH_RULES,
        "spot": float(hist[-1]),
        "iv": 55.0,
        "hist_values": hist,
    })
    assert res["ok"] is True
    pct = float((res["trades_total"] > 0).mean() * 100)
    assert pct > 0, f"expected some crash-rule entries, got {pct}%"
    assert float(np.std(res["pnl_path"][:, -1])) > 0


def test_short_hist_padded_for_ivrank():
    # Deliberately short series (not _synthetic_hist which floors at MIN_BARS)
    rng = np.random.default_rng(5)
    short = 100.0 * np.cumprod(1 + rng.normal(0.0002, 0.015, 80))
    assert short.size < _STRATEGY_HIST_MIN_BARS
    # IVR>=0 always true once warmed — must enter after pad
    rules = {
        "buy": {"logic": "AND", "groups": [{"logic": "AND", "conditions": [
            {"lhs": {"type": "OPT_IVRANK", "period": 252}, "op": "gte", "rhs_type": "number", "rhs_num": 0},
        ]}]},
        "sell": {"logic": "AND", "groups": [{"logic": "AND", "conditions": [
            {"lhs": {"type": "PRICE"}, "op": "lt", "rhs_type": "number", "rhs_num": 0},
        ]}]},
    }
    res = _strategy_sim_job({
        "ticker": "PAD",
        "legs_cfg": LEGS[:1],
        "dte": 20,
        "horizon_days": 40,
        "r": 4.0,
        "committed_dollars": 1000.0,
        "n": 20,
        "dt": 1 / 365,
        "seed": 1,
        "strategy": None,
        "strategy_params": None,
        "take_profit_pct": None,
        "stop_loss_pct": None,
        "max_hold_days": 15,
        "strategy_rules": rules,
        "spot": 100.0,
        "iv": 30.0,
        "hist_values": short,
    })
    assert res["ok"]
    assert float((res["trades_total"] > 0).mean()) > 0.5
