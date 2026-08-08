"""Differential test: compiled Python must equal the interpreter, bar for bar.

This is the whole justification for the compiler. If these pass over a broad
sweep of rule shapes, migrating a saved strategy to code cannot change what it
trades — and the new engine is proven against the old one rather than reviewed
by eye.
"""
import os
import sys

import numpy as np
import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from algo_runtime import indicators as ind                      # noqa: E402
from algo_runtime.compiler import compile_rules, UnsupportedRule  # noqa: E402
from algo_runtime.contract import Signals, ctx_from_frames      # noqa: E402
from routers.strategy import evaluate_custom_rules              # noqa: E402


def _prices(n=400, seed=0, start=100.0):
    rng = np.random.default_rng(seed)
    return start * np.exp(np.cumsum(rng.normal(0.0004, 0.013, n)))


def _run_compiled(rules, ctx):
    src = compile_rules(rules)
    ns = {"ind": ind, "Signals": Signals, "np": np}
    exec(compile(src, "<compiled>", "exec"), ns)
    return ns["signal"](ctx).as_raw()


def _both(rules, prices, **kw):
    """(compiled, interpreted) raw signal pairs for the same rules and data."""
    want_buy, want_sell = evaluate_custom_rules(prices, rules, raw=True, **kw)
    ctx = ctx_from_frames(prices, **kw)
    got_buy, got_sell = _run_compiled(rules, ctx)
    return (got_buy, got_sell), (want_buy, want_sell)


def _cond(lhs, op, rhs, rhs_ind=None):
    c = {"lhs": lhs, "op": op}
    if rhs_ind is not None:
        c["rhs_type"] = "indicator"
        c["rhs_ind"] = rhs_ind
    else:
        c["rhs_type"] = "number"
        c["rhs_num"] = rhs
    return c


def _rules(buy_conds, sell_conds, buy_logic="AND", sell_logic="AND"):
    return {
        "buy": {"logic": buy_logic, "groups": [{"logic": buy_logic, "conditions": buy_conds}]},
        "sell": {"logic": sell_logic, "groups": [{"logic": sell_logic, "conditions": sell_conds}]},
    }


# Every indicator type the DSL offers, with a threshold that actually fires.
INDICATOR_CASES = [
    ({"type": "PRICE"}, "gt", 100),
    ({"type": "RSI", "period": 14}, "lt", 45),
    ({"type": "RSI", "period": 7}, "gt", 55),
    ({"type": "SMA", "period": 50}, "gt", 100),
    ({"type": "SMA", "period": 5}, "lt", 120),
    ({"type": "EMA", "period": 20}, "gt", 100),
    ({"type": "MACD_LINE"}, "gt", 0),
    ({"type": "MACD_SIGNAL"}, "lt", 0),
    ({"type": "BB_UPPER", "period": 20, "std": 2.0}, "gt", 100),
    ({"type": "BB_MID", "period": 20}, "lt", 130),
    ({"type": "BB_LOWER", "period": 20, "std": 1.5}, "lt", 110),
    ({"type": "ATR", "period": 14}, "gt", 0.5),
    ({"type": "MOMENTUM", "period": 63}, "gt", 0),
    ({"type": "PCT_CHANGE", "period": 20}, "lt", 2),
    ({"type": "PCT_BELOW_HIGH", "period": 20}, "gt", 1),
    ({"type": "PCT_ABOVE_LOW", "period": 20}, "lt", 8),
    ({"type": "OPT_HV", "period": 21}, "gt", 15),
    ({"type": "OPT_IVRANK", "period": 252}, "lt", 60),
]


@pytest.mark.parametrize("lhs,op,rhs", INDICATOR_CASES)
def test_every_indicator_matches_interpreter(lhs, op, rhs):
    prices = _prices(500, seed=7)
    rules = _rules([_cond(lhs, op, rhs)], [_cond({"type": "PRICE"}, "lt", 0)])
    got, want = _both(rules, prices)
    np.testing.assert_array_equal(got[0], want[0])
    np.testing.assert_array_equal(got[1], want[1])


@pytest.mark.parametrize("op", ["gt", "lt", "gte", "lte", "crosses_above", "crosses_below"])
def test_every_operator_matches_interpreter(op):
    prices = _prices(400, seed=3)
    rules = _rules(
        [_cond({"type": "PRICE"}, op, None, rhs_ind={"type": "SMA", "period": 20})],
        [_cond({"type": "RSI", "period": 14}, "gt", 70)],
    )
    got, want = _both(rules, prices)
    np.testing.assert_array_equal(got[0], want[0])
    np.testing.assert_array_equal(got[1], want[1])


def test_crosses_fire_at_all():
    """Guard against a vacuous pass — if nothing ever crosses, equality is trivial."""
    prices = _prices(400, seed=3)
    rules = _rules(
        [_cond({"type": "PRICE"}, "crosses_above", None, rhs_ind={"type": "SMA", "period": 20})],
        [_cond({"type": "PRICE"}, "crosses_below", None, rhs_ind={"type": "SMA", "period": 20})],
    )
    got, _ = _both(rules, prices)
    assert got[0].sum() > 3 and got[1].sum() > 3


@pytest.mark.parametrize("buy_logic,sell_logic", [("AND", "AND"), ("AND", "OR"), ("OR", "AND"), ("OR", "OR")])
def test_and_or_logic_matches(buy_logic, sell_logic):
    prices = _prices(450, seed=11)
    rules = _rules(
        [_cond({"type": "RSI", "period": 14}, "lt", 50), _cond({"type": "PRICE"}, "gt", 90)],
        [_cond({"type": "RSI", "period": 14}, "gt", 50), _cond({"type": "PRICE"}, "lt", 200)],
        buy_logic, sell_logic,
    )
    got, want = _both(rules, prices)
    np.testing.assert_array_equal(got[0], want[0])
    np.testing.assert_array_equal(got[1], want[1])


def test_multi_group_nesting_matches():
    """Top-level logic across groups, each with its own inner logic."""
    prices = _prices(500, seed=5)
    rules = {
        "buy": {"logic": "AND", "groups": [
            {"logic": "OR", "conditions": [
                _cond({"type": "RSI", "period": 14}, "lt", 40),
                _cond({"type": "RSI", "period": 7}, "lt", 35),
            ]},
            {"logic": "AND", "conditions": [
                _cond({"type": "PRICE"}, "gt", None, rhs_ind={"type": "SMA", "period": 100}),
            ]},
        ]},
        "sell": {"logic": "OR", "groups": [
            {"logic": "AND", "conditions": [
                _cond({"type": "RSI", "period": 14}, "gt", 65),
                _cond({"type": "PCT_CHANGE", "period": 10}, "gt", 1),
            ]},
            {"logic": "AND", "conditions": [
                _cond({"type": "PRICE"}, "crosses_below", None, rhs_ind={"type": "EMA", "period": 20}),
            ]},
        ]},
    }
    got, want = _both(rules, prices)
    np.testing.assert_array_equal(got[0], want[0])
    np.testing.assert_array_equal(got[1], want[1])


def test_flat_conditions_backwards_compat():
    """Older saved strategies have no `groups` key, just flat `conditions`."""
    prices = _prices(300, seed=2)
    rules = {
        "buy": {"logic": "AND", "conditions": [_cond({"type": "RSI", "period": 14}, "lt", 40)]},
        "sell": {"logic": "AND", "conditions": [_cond({"type": "RSI", "period": 14}, "gt", 60)]},
    }
    got, want = _both(rules, prices)
    np.testing.assert_array_equal(got[0], want[0])
    np.testing.assert_array_equal(got[1], want[1])


def test_empty_block_never_fires():
    """An empty buy block must be False everywhere. `all([])` is True in Python,
    so a naive compiler would invert the strategy into always-buy."""
    prices = _prices(200, seed=1)
    rules = {"buy": {"logic": "AND", "groups": []},
             "sell": {"logic": "AND", "conditions": [_cond({"type": "RSI", "period": 14}, "gt", 70)]}}
    got, want = _both(rules, prices)
    assert not got[0].any()
    np.testing.assert_array_equal(got[0], want[0])
    np.testing.assert_array_equal(got[1], want[1])


def test_bar_zero_is_always_false():
    """The interpreter loops from i=1, so bar 0 never signals however true the
    condition is there."""
    prices = _prices(200, seed=4)
    rules = _rules([_cond({"type": "PRICE"}, "gt", 0)], [_cond({"type": "PRICE"}, "gt", 0)])
    got, want = _both(rules, prices)
    assert got[0][0] == False and got[1][0] == False   # noqa: E712
    np.testing.assert_array_equal(got[0], want[0])
    assert got[0][1:].all()


def test_cross_ticker_matches():
    prices = _prices(400, seed=8)
    spy = _prices(400, seed=9)
    frames = {"AAPL": prices, "SPY": spy}
    rules = _rules(
        [_cond({"type": "RSI", "period": 14, "ticker": "SPY"}, "lt", 45),
         _cond({"type": "PRICE"}, "gt", None, rhs_ind={"type": "SMA", "period": 50})],
        [_cond({"type": "PRICE", "ticker": "SPY"}, "lt", None, rhs_ind={"type": "SMA", "period": 20, "ticker": "SPY"})],
    )
    kw = dict(frames=frames, ctx_by_ticker={"AAPL": {}, "SPY": {}}, primary="AAPL")
    got, want = _both(rules, prices, **kw)
    np.testing.assert_array_equal(got[0], want[0])
    np.testing.assert_array_equal(got[1], want[1])


def test_unknown_ticker_is_all_nan_not_a_crash():
    prices = _prices(200, seed=6)
    rules = _rules([_cond({"type": "PRICE", "ticker": "NOPE"}, "gt", 1)],
                   [_cond({"type": "PRICE"}, "lt", 0)])
    kw = dict(frames={"AAPL": prices}, ctx_by_ticker={"AAPL": {}}, primary="AAPL")
    got, want = _both(rules, prices, **kw)
    assert not got[0].any()
    np.testing.assert_array_equal(got[0], want[0])


def test_context_metric_array_matches():
    prices = _prices(300, seed=12)
    pe = np.linspace(10, 40, 300)
    rules = _rules([_cond({"type": "FUND_PE"}, "lt", 25)], [_cond({"type": "FUND_PE"}, "gt", 35)])
    kw = dict(frames={"AAPL": prices}, ctx_by_ticker={"AAPL": {"FUND_PE": pe}}, primary="AAPL")
    got, want = _both(rules, prices, **kw)
    np.testing.assert_array_equal(got[0], want[0])
    np.testing.assert_array_equal(got[1], want[1])
    assert got[0].any() and got[1].any()


def test_missing_context_metric_never_fires():
    prices = _prices(200, seed=13)
    rules = _rules([_cond({"type": "FUND_PEG"}, "lt", 2)], [_cond({"type": "PRICE"}, "lt", 0)])
    kw = dict(frames={"AAPL": prices}, ctx_by_ticker={"AAPL": {}}, primary="AAPL")
    got, want = _both(rules, prices, **kw)
    assert not got[0].any()
    np.testing.assert_array_equal(got[0], want[0])


@pytest.mark.parametrize("tf,thresh", [("weekly", 60), ("monthly", 80)])
def test_coarser_timeframe_matches(tf, thresh):
    """Resampled indicators must match, AND the resample path must be the one
    taken — a compiler that quietly ignored `timeframe` would also pass an
    equality check if the daily and coarse series happened to agree."""
    import pandas as pd
    n = 500
    prices = _prices(n, seed=14)
    idx = pd.bdate_range("2022-01-03", periods=n)
    rules = _rules(
        [_cond({"type": "RSI", "period": 14, "timeframe": tf}, "lt", thresh)],
        [_cond({"type": "SMA", "period": 10, "timeframe": tf}, "gt", 1e9)],
    )
    kw = dict(frames={"AAPL": prices}, ctx_by_ticker={"AAPL": {}}, primary="AAPL",
              daily_index=idx, base_tf="1d")
    got, want = _both(rules, prices, **kw)
    np.testing.assert_array_equal(got[0], want[0])
    np.testing.assert_array_equal(got[1], want[1])
    assert f"ind.tf(" in compile_rules(rules) and f"{tf!r}" in compile_rules(rules)
    assert got[0].any(), "threshold never fires — the comparison would be vacuous"


def test_same_or_finer_timeframe_does_not_resample():
    """A daily condition on a daily backtest has no finer data to compute from,
    so it must run on the base bars (strategy.py's _TF_MINUTES gate)."""
    import pandas as pd
    n = 300
    prices = _prices(n, seed=15)
    idx = pd.bdate_range("2022-01-03", periods=n)
    rules = _rules([_cond({"type": "RSI", "period": 14, "timeframe": "daily"}, "lt", 45)],
                   [_cond({"type": "PRICE"}, "lt", 0)])
    kw = dict(frames={"AAPL": prices}, ctx_by_ticker={"AAPL": {}}, primary="AAPL",
              daily_index=idx, base_tf="1d")
    got, want = _both(rules, prices, **kw)
    np.testing.assert_array_equal(got[0], want[0])
    assert "ind.tf(" not in compile_rules(rules)


@pytest.mark.parametrize("seed", range(12))
def test_random_rule_sweep_matches(seed):
    """Randomly shaped rules over random walks — the broad net that catches
    combinations the hand-written cases miss."""
    rng = np.random.default_rng(seed)
    prices = _prices(420, seed=seed + 100)

    def rand_ind():
        lhs, _, _ = INDICATOR_CASES[rng.integers(len(INDICATOR_CASES))]
        return dict(lhs)

    def rand_cond():
        lhs = rand_ind()
        op = ["gt", "lt", "gte", "lte", "crosses_above", "crosses_below"][rng.integers(6)]
        if rng.random() < 0.5:
            return _cond(lhs, op, float(rng.uniform(0, 120)))
        return _cond(lhs, op, None, rhs_ind=rand_ind())

    def rand_block():
        return {
            "logic": "AND" if rng.random() < 0.5 else "OR",
            "groups": [
                {"logic": "AND" if rng.random() < 0.5 else "OR",
                 "conditions": [rand_cond() for _ in range(1 + int(rng.integers(3)))]}
                for _ in range(1 + int(rng.integers(2)))
            ],
        }

    rules = {"buy": rand_block(), "sell": rand_block()}
    got, want = _both(rules, prices)
    np.testing.assert_array_equal(got[0], want[0])
    np.testing.assert_array_equal(got[1], want[1])


def test_unsupported_rule_raises_rather_than_approximating():
    with pytest.raises(UnsupportedRule):
        compile_rules({"buy": {"conditions": [_cond({"type": "NOT_A_THING"}, "gt", 1)]}, "sell": {}})
    with pytest.raises(UnsupportedRule):
        compile_rules({"buy": {"conditions": [_cond({"type": "PRICE"}, "sideways", 1)]}, "sell": {}})


def test_shared_series_is_computed_once():
    """Two conditions on the same indicator bind one local, so compiled code is
    not slower than the interpreter's per-ref cache."""
    rules = _rules(
        [_cond({"type": "RSI", "period": 14}, "lt", 40), _cond({"type": "RSI", "period": 14}, "gt", 10)],
        [_cond({"type": "RSI", "period": 14}, "gt", 70)],
    )
    src = compile_rules(rules)
    assert src.count("ind.rsi(") == 1
