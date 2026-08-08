"""The seam: swapping signal producers must not change a backtest.

_run_custom_rules is the single place a strategy becomes two boolean arrays.
Everything downstream — multi-lot tracking, risk controls, financing, option
pricing — is untouched, so if the arrays match the P&L must match too. These
tests assert that at both levels.
"""
import os
import sys

import numpy as np
import pandas as pd
import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from algo_runtime.compiler import compile_rules              # noqa: E402
from algo_runtime.contract import ctx_from_frames            # noqa: E402
from routers import strategy as strat                        # noqa: E402

RULES = {
    "buy": {"logic": "AND", "groups": [{"logic": "AND", "conditions": [
        {"lhs": {"type": "RSI", "period": 14}, "op": "lt", "rhs_type": "number", "rhs_num": 55},
        {"lhs": {"type": "PRICE"}, "op": "gt", "rhs_type": "indicator",
         "rhs_ind": {"type": "SMA", "period": 20}},
    ]}]},
    "sell": {"logic": "OR", "groups": [{"logic": "OR", "conditions": [
        {"lhs": {"type": "RSI", "period": 14}, "op": "gt", "rhs_type": "number", "rhs_num": 65},
        {"lhs": {"type": "PRICE"}, "op": "crosses_below", "rhs_type": "indicator",
         "rhs_ind": {"type": "EMA", "period": 30}},
    ]}]},
}


def _world(n=500, seed=3):
    rng = np.random.default_rng(seed)
    close = 100 * np.exp(np.cumsum(rng.normal(0.0004, 0.013, n)))
    index = pd.bdate_range("2022-01-03", periods=n)
    return close, index, {"AAPL": close}, {"AAPL": {}}


def _signals(engine, signal_source=None, monkeypatch=None):
    close, index, frames, ctxs = _world()
    if monkeypatch is not None:
        monkeypatch.setattr(strat, "_engine", lambda: engine)
    return strat._signals_for(close, RULES, frames, ctxs, "AAPL", index, "1d", signal_source)


def test_compiled_engine_matches_interpreter_through_the_seam(monkeypatch):
    interp = _signals("interpreter", monkeypatch=monkeypatch)
    compiled = _signals("compiled", monkeypatch=monkeypatch)
    np.testing.assert_array_equal(compiled[0], interp[0])
    np.testing.assert_array_equal(compiled[1], interp[1])
    assert interp[0].any() and interp[1].any(), "vacuous comparison"


def test_explicit_source_overrides_the_engine_setting(monkeypatch):
    """Hand-written code runs even when the server default is the interpreter."""
    src = compile_rules(RULES)
    interp = _signals("interpreter", monkeypatch=monkeypatch)
    coded = _signals("interpreter", signal_source=src, monkeypatch=monkeypatch)
    np.testing.assert_array_equal(coded[0], interp[0])
    np.testing.assert_array_equal(coded[1], interp[1])


def test_broken_author_code_raises_rather_than_falling_back(monkeypatch):
    """Silently backtesting different logic than the user wrote is the worst
    outcome available, so author code fails loudly."""
    from fastapi import HTTPException
    with pytest.raises(HTTPException) as e:
        _signals("interpreter", signal_source="def signal(c):\n    return Signals(1, 2)",
                 monkeypatch=monkeypatch)
    assert e.value.status_code == 422


def test_compiled_engine_falls_back_when_rules_do_not_compile(monkeypatch):
    """A rule with no code equivalent keeps working on the interpreter instead of
    breaking the user's saved strategy.

    Note the behavioural difference this exposes: strategies/indicators.get_indicator
    ends with `return prices`, so the interpreter silently treats an unknown
    indicator type as PRICE. The compiler refuses instead (UnsupportedRule). The
    compiler is stricter on purpose; the fallback is what preserves the old
    behaviour for anything already saved.
    """
    close, index, frames, ctxs = _world()
    odd = {"buy": {"logic": "AND", "conditions": [
               {"lhs": {"type": "NOT_REAL"}, "op": "gt", "rhs_type": "number", "rhs_num": 1}]},
           "sell": {"logic": "AND", "conditions": []}}

    monkeypatch.setattr(strat, "_engine", lambda: "interpreter")
    want = strat._signals_for(close, odd, frames, ctxs, "AAPL", index, "1d", None)
    monkeypatch.setattr(strat, "_engine", lambda: "compiled")
    got = strat._signals_for(close, odd, frames, ctxs, "AAPL", index, "1d", None)

    np.testing.assert_array_equal(got[0], want[0])
    np.testing.assert_array_equal(got[1], want[1])
    assert got[0].shape == (len(close),)


def test_compiler_refuses_what_the_interpreter_silently_coerces():
    """Pinning the difference above, so a future change to either side is a
    deliberate decision rather than a surprise."""
    from algo_runtime.compiler import UnsupportedRule
    with pytest.raises(UnsupportedRule):
        compile_rules({"buy": {"conditions": [
            {"lhs": {"type": "NOT_REAL"}, "op": "gt", "rhs_type": "number", "rhs_num": 1}]},
            "sell": {}})


def test_pnl_is_identical_across_engines(monkeypatch):
    """The point of keeping one P&L engine: identical signals must produce an
    identical equity curve, trade count and return."""
    from routers.algo import _compute_metrics

    close, index, _, _ = _world()
    series = pd.Series(close, index=index, name="AAPL")

    interp = _signals("interpreter", monkeypatch=monkeypatch)
    compiled = _signals("compiled", monkeypatch=monkeypatch)

    a = _compute_metrics(interp[0], interp[1], series, 100, 10_000)
    b = _compute_metrics(compiled[0], compiled[1], series, 100, 10_000)

    assert a["metrics"]["num_trades"] == b["metrics"]["num_trades"] > 0
    assert a["metrics"]["total_return"] == b["metrics"]["total_return"]
    assert a["metrics"]["max_drawdown"] == b["metrics"]["max_drawdown"]


def test_default_engine_is_the_interpreter():
    """The rollout plan is interpreter-by-default for one release; this is the
    tripwire if that flips by accident."""
    os.environ.pop("ALGO_ENGINE", None)
    assert strat._engine() == "interpreter"
