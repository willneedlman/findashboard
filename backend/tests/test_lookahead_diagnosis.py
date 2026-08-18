"""A killed sandbox run is not evidence of lookahead.

The Copilot generated a multi-factor strategy, the causality check re-ran it on
perturbed data, the sandbox killed that run on its 10s CPU limit, and the
checker reported "The strategy behaves differently depending on future values."
generate.py treats an L3 error as a failed attempt, so it retried and gave up,
leaving the default rule-builder code in the editor. The strategy was never
shown to look ahead; it was never allowed to finish.
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))

import numpy as np  # noqa: E402

from algo_runtime import validate as V  # noqa: E402
from algo_runtime.sandbox import SandboxError  # noqa: E402


def _signals(n, entries=None, exits=None):
    class S:
        pass
    s = S()
    s.entries = np.zeros(n, dtype=bool) if entries is None else entries
    s.exits = np.zeros(n, dtype=bool) if exits is None else exits
    return s


def _dataclass_ctx(n=200):
    # The real Ctx: the checker also truncates, which touches fields a stub lacks.
    from algo_runtime.contract import Ctx
    return Ctx(close=np.linspace(100.0, 120.0, n))


def test_a_sandbox_kill_is_reported_as_unverified_not_as_lookahead():
    calls = {"n": 0}

    def run(ctx):
        calls["n"] += 1
        if calls["n"] == 1:
            return _signals(ctx.n)          # the base run completes
        raise SandboxError("strategy killed by signal 15 — likely the 10s CPU limit")

    diags = V._causality_check(run, _dataclass_ctx())
    assert len(diags) == 1
    d = diags[0]
    assert d.severity == "warning", "a killed run must not block generation"
    assert "could not be verified" in d.message
    assert "behaves differently" not in d.message


def test_a_logic_fault_on_future_data_is_still_an_error():
    calls = {"n": 0}

    def run(ctx):
        calls["n"] += 1
        if calls["n"] == 1:
            return _signals(ctx.n)
        raise IndexError("index 200 is out of bounds")

    diags = V._causality_check(run, _dataclass_ctx())
    assert diags[0].severity == "error"
    assert "behaves differently depending on future values" in diags[0].message


def test_a_genuinely_causal_strategy_still_passes():
    def run(ctx):
        # Depends only on the first bar, which perturbation never touches.
        return _signals(ctx.n)

    diags = V._causality_check(run, _dataclass_ctx())
    assert [d for d in diags if d.severity == "error"] == []
