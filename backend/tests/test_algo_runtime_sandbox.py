"""L0-L2 static validation and the execution sandbox.

The escape attempts below are the point: each one is a real technique for
getting out of a naive `exec(code, {"__builtins__": {}})` jail, and each must be
refused at the AST layer before anything runs.
"""
import os
import sys

import numpy as np
import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from algo_runtime.contract import Ctx, Signals            # noqa: E402
from algo_runtime.sandbox import run_signal, SandboxError, make_runner  # noqa: E402
from algo_runtime.validate import validate_source         # noqa: E402


def _ctx(n=200, seed=0):
    rng = np.random.default_rng(seed)
    return Ctx(close=100 * np.exp(np.cumsum(rng.normal(0.0004, 0.013, n))))


GOOD = """
def signal(c):
    fast = ind.sma(c.close, 10)
    slow = ind.sma(c.close, 30)
    entries = ind.crosses_above(fast, slow)
    exits = ind.crosses_below(fast, slow)
    return Signals(entries, exits)
"""


def test_good_strategy_validates_and_runs():
    ctx = _ctx()
    res = validate_source(GOOD, ctx, make_runner(in_process=True), warmup=30)
    assert res.ok, res.repair_prompt()
    sig = run_signal(GOOD, ctx, in_process=True)
    assert sig.entries.dtype == np.bool_ and sig.entries.shape == (ctx.n,)


# ── L1: escape attempts ──────────────────────────────────────────────────────

ESCAPES = [
    ("import os\ndef signal(c):\n    return Signals(ind.never(c.n), ind.never(c.n))", "import"),
    ("from os import system\ndef signal(c):\n    return Signals(ind.never(c.n), ind.never(c.n))", "import"),
    # The classic: walk __class__ -> __subclasses__ to reach any type in the
    # interpreter, which defeats an empty-builtins jail entirely.
    ("def signal(c):\n    x = ().__class__.__bases__[0].__subclasses__()\n    return Signals(ind.never(c.n), ind.never(c.n))", "dunder"),
    ("def signal(c):\n    return eval('1+1')", "eval"),
    ("def signal(c):\n    exec('x=1')\n    return Signals(ind.never(c.n), ind.never(c.n))", "exec"),
    ("def signal(c):\n    open('/etc/passwd').read()\n    return Signals(ind.never(c.n), ind.never(c.n))", "open"),
    ("def signal(c):\n    m = __import__('os')\n    return Signals(ind.never(c.n), ind.never(c.n))", "__import__"),
    ("def signal(c):\n    g = globals()\n    return Signals(ind.never(c.n), ind.never(c.n))", "globals"),
    ("def signal(c):\n    f = getattr(c, 'close')\n    return Signals(ind.never(c.n), ind.never(c.n))", "getattr"),
    ("def signal(c):\n    return Signals(socket.socket(), ind.never(c.n))", "unknown name"),
    ("class Evil:\n    pass\ndef signal(c):\n    return Signals(ind.never(c.n), ind.never(c.n))", "class"),
    ("async def signal(c):\n    return Signals(ind.never(c.n), ind.never(c.n))", "async"),
]


@pytest.mark.parametrize("src,needle", ESCAPES)
def test_escape_attempts_are_refused_statically(src, needle):
    res = validate_source(src, deep=False)
    assert not res.ok
    assert any(needle in d.message for d in res.errors), [d.message for d in res.errors]


def test_syntax_error_is_L0():
    res = validate_source("def signal(c)\n    return 1", deep=False)
    assert not res.ok and res.errors[0].level == "L0"


# ── L2: contract ─────────────────────────────────────────────────────────────

@pytest.mark.parametrize("src,needle", [
    ("def notsignal(c):\n    return Signals(ind.never(c.n), ind.never(c.n))", "no function named `signal`"),
    ("def signal(c, extra):\n    return Signals(ind.never(c.n), ind.never(c.n))", "exactly one argument"),
    ("def signal(c):\n    pass", "never returns"),
])
def test_contract_violations_are_L2(src, needle):
    res = validate_source(src, deep=False)
    assert not res.ok and needle in res.errors[0].message


def test_wrong_shape_is_caught():
    src = "def signal(c):\n    return Signals(ind.never(5), ind.never(5))"
    res = validate_source(src, _ctx(), make_runner(in_process=True))
    assert not res.ok and "shape" in res.errors[0].message


def test_wrong_dtype_is_caught():
    src = "def signal(c):\n    return Signals(c.close, c.close)"
    res = validate_source(src, _ctx(), make_runner(in_process=True))
    assert not res.ok and "dtype" in res.errors[0].message


def test_runtime_exception_becomes_a_diagnostic():
    src = "def signal(c):\n    x = 1 / 0\n    return Signals(ind.never(c.n), ind.never(c.n))"
    res = validate_source(src, _ctx(), make_runner(in_process=True))
    assert not res.ok and "ZeroDivisionError" in res.errors[0].message


# ── the sandbox process ──────────────────────────────────────────────────────

def test_subprocess_runs_and_returns_arrays():
    ctx = _ctx()
    sig = run_signal(GOOD, ctx)
    assert sig.entries.shape == (ctx.n,) and sig.entries.dtype == np.bool_
    ref = run_signal(GOOD, ctx, in_process=True)
    np.testing.assert_array_equal(sig.entries, ref.entries)
    np.testing.assert_array_equal(sig.exits, ref.exits)


def test_infinite_loop_is_killed_not_hung():
    src = "def signal(c):\n    while True:\n        pass\n    return Signals(ind.never(c.n), ind.never(c.n))"
    with pytest.raises(SandboxError):
        run_signal(src, _ctx(60), timeout=3)


def test_child_crash_does_not_kill_the_parent():
    src = "def signal(c):\n    raise ValueError('boom')"
    with pytest.raises(SandboxError) as e:
        run_signal(src, _ctx(60))
    assert "boom" in str(e.value)
    # parent still healthy
    assert run_signal(GOOD, _ctx(60)).entries.shape == (60,)


def test_missing_signal_function_in_sandbox():
    with pytest.raises(SandboxError):
        run_signal("x = 1", _ctx(60))


def test_repair_prompt_names_the_failing_check():
    res = validate_source("import os\ndef signal(c):\n    return Signals(1, 2)", deep=False)
    prompt = res.repair_prompt()
    assert "[L1]" in prompt and "import" in prompt
