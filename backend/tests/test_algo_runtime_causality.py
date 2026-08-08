"""L3-L6: lookahead bias, warmup, determinism, degeneracy.

L3 is the reason this layer exists. Static scanning for `.shift(-1)` is
trivially evadable — there are a dozen ways to peek at the future — so the
property itself is tested instead: a strategy reading only past data produces
identical signals when shown only a prefix of the data.

Each LOOKAHEAD case below is a distinct way to cheat, phrased so no shared
substring gives it away. All must be caught. Each CAUSAL case is something that
LOOKS suspicious but is legitimate, and must NOT be flagged — a validator that
cries wolf on honest code gets switched off.
"""
import os
import sys

import numpy as np
import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from algo_runtime.contract import Ctx                       # noqa: E402
from algo_runtime.sandbox import make_runner                # noqa: E402
from algo_runtime.validate import validate_source           # noqa: E402

RUN = make_runner(in_process=True)   # trusted, hand-written test fixtures only


def _ctx(n=300, seed=0):
    rng = np.random.default_rng(seed)
    return Ctx(close=100 * np.exp(np.cumsum(rng.normal(0.0004, 0.013, n))))


# ── strategies that cheat ────────────────────────────────────────────────────

LOOKAHEAD = {
    "next_bar_return": """
def signal(c):
    nxt = np.roll(c.close, -1)
    entries = nxt > c.close
    exits = nxt < c.close
    entries[0] = False
    exits[0] = False
    return Signals(entries, exits)
""",
    "whole_series_max": """
def signal(c):
    peak = np.max(c.close)
    entries = c.close < peak * 0.9
    exits = c.close > peak * 0.99
    return Signals(entries, exits)
""",
    "whole_series_mean": """
def signal(c):
    avg = np.mean(c.close)
    entries = c.close < avg
    exits = c.close > avg
    return Signals(entries, exits)
""",
    "reversed_cumulative": """
def signal(c):
    back = np.maximum.accumulate(c.close[::-1])[::-1]
    entries = c.close < back * 0.95
    exits = c.close >= back
    return Signals(entries, exits)
""",
    "final_bar_reference": """
def signal(c):
    last = c.close[-1]
    entries = c.close < last
    exits = c.close > last
    return Signals(entries, exits)
""",
    "percentile_over_all": """
def signal(c):
    hi = np.percentile(c.close, 80)
    entries = c.close > hi
    exits = c.close < hi
    return Signals(entries, exits)
""",
    "centered_window": """
def signal(c):
    n = c.n
    smooth = np.copy(c.close)
    for i in range(2, n - 2):
        smooth[i] = np.mean(c.close[i - 2:i + 3])
    entries = c.close > smooth
    exits = c.close < smooth
    return Signals(entries, exits)
""",
}


@pytest.mark.parametrize("name", sorted(LOOKAHEAD))
def test_lookahead_is_caught(name):
    res = validate_source(LOOKAHEAD[name], _ctx(), RUN)
    assert not res.ok, f"{name} was NOT caught"
    assert res.errors[0].level == "L3", res.errors[0].message
    assert "lookahead" in res.errors[0].message


# ── strategies that look suspicious but are honest ───────────────────────────

CAUSAL = {
    "expanding_max": """
def signal(c):
    runmax = np.maximum.accumulate(c.close)
    entries = c.close < runmax * 0.9
    exits = c.close >= runmax
    return Signals(entries, exits)
""",
    "expanding_mean": """
def signal(c):
    csum = np.cumsum(c.close)
    idx = np.arange(1, c.n + 1)
    avg = csum / idx
    entries = c.close < avg
    exits = c.close > avg
    return Signals(entries, exits)
""",
    "backward_python_loop": """
def signal(c):
    n = c.n
    out = np.zeros(n, dtype=bool)
    for i in range(20, n):
        window = c.close[i - 20:i + 1]
        out[i] = c.close[i] <= np.min(window)
    return Signals(out, ~out)
""",
    "prev_helper": """
def signal(c):
    entries = ind.rising(c.close, 3)
    exits = ind.falling(c.close, 3)
    return Signals(entries, exits)
""",
    "indicator_stack": """
def signal(c):
    r = ind.rsi(c.close, 14)
    m = ind.macd_line(c.close)
    s = ind.macd_signal(c.close)
    entries = ind.all_of(r < 45, ind.crosses_above(m, s))
    exits = ind.any_of(r > 65, ind.crosses_below(m, s))
    return Signals(entries, exits)
""",
}


@pytest.mark.parametrize("name", sorted(CAUSAL))
def test_causal_strategies_are_not_flagged(name):
    res = validate_source(CAUSAL[name], _ctx(), RUN)
    assert res.ok, f"false positive on {name}: {res.repair_prompt()}"


def test_expanding_and_whole_series_differ_only_by_causality():
    """The pair that proves the test discriminates rather than pattern-matching:
    np.maximum.accumulate is fine, np.max is not, and they look almost identical."""
    ctx = _ctx()
    assert validate_source(CAUSAL["expanding_max"], ctx, RUN).ok
    assert not validate_source(LOOKAHEAD["whole_series_max"], ctx, RUN).ok


# ── L4 warmup ────────────────────────────────────────────────────────────────

def test_signal_before_warmup_is_caught():
    """Entry fires at bar 3 on a 50-bar indicator. Exits are held to warmup 0, so
    only the entry block can trip the check."""
    src = """
def signal(c):
    slow = ind.sma(c.close, 50)
    entries = np.zeros(c.n, dtype=bool)
    entries[3] = True
    exits = c.close < slow
    return Signals(entries, exits)
"""
    res = validate_source(src, _ctx(), RUN, warmup={"entries": 50, "exits": 0})
    assert not res.ok
    assert res.errors[0].level == "L4" and "warmup" in res.errors[0].message
    assert "entries" in res.errors[0].message


def test_warm_indicator_passes_warmup():
    src = """
def signal(c):
    slow = ind.sma(c.close, 50)
    entries = c.close > slow
    exits = c.close < slow
    return Signals(entries, exits)
"""
    res = validate_source(src, _ctx(), RUN, warmup=50)
    assert res.ok, res.repair_prompt()


# ── L5 determinism ───────────────────────────────────────────────────────────

def test_unseeded_randomness_is_caught():
    src = """
def signal(c):
    noise = np.random.random(c.n)
    entries = noise > 0.7
    exits = noise < 0.3
    return Signals(entries, exits)
"""
    res = validate_source(src, _ctx(), RUN)
    assert not res.ok
    assert any(d.level == "L5" for d in res.errors), res.repair_prompt()


def test_seeded_randomness_is_allowed():
    src = """
def signal(c):
    rng = np.random.default_rng(42)
    noise = rng.random(c.n)
    entries = noise > 0.7
    exits = noise < 0.3
    return Signals(entries, exits)
"""
    assert validate_source(src, _ctx(), RUN).ok


# ── L6 degeneracy ────────────────────────────────────────────────────────────

def test_never_trading_warns_but_does_not_block():
    src = "def signal(c):\n    return Signals(ind.never(c.n), ind.never(c.n))"
    res = validate_source(src, _ctx(), RUN)
    assert res.ok
    assert any("never trades" in d.message for d in res.warnings)


def test_always_entering_warns():
    src = """
def signal(c):
    entries = np.ones(c.n, dtype=bool)
    exits = ind.crosses_below(c.close, ind.sma(c.close, 20))
    return Signals(entries, exits)
"""
    res = validate_source(src, _ctx(), RUN)
    assert res.ok
    assert any("vacuous" in d.message for d in res.warnings), res.diagnostics


def test_hardcoded_bar_index_is_caught_as_length_dependent():
    """A strategy that indexes an absolute bar breaks the moment it sees a
    different amount of history — caught, with a message that says why."""
    src = """
def signal(c):
    entries = np.zeros(c.n, dtype=bool)
    entries[250] = True
    exits = ind.falling(c.close, 1)
    return Signals(entries, exits)
"""
    res = validate_source(src, _ctx(300), RUN)
    assert not res.ok
    assert res.errors[0].level == "L3"
    assert "length" in res.errors[0].message or "future" in res.errors[0].message


def test_short_series_warns_instead_of_failing():
    """Fewer bars than the causality test can use should not read as a pass."""
    res = validate_source(CAUSAL["prev_helper"], _ctx(40), RUN)
    assert res.ok
    assert any(d.level == "L3" and d.severity == "warning" for d in res.diagnostics)


def test_compiled_rules_survive_full_validation():
    """The compiler's own output must pass every layer — it is the model's
    house-style example, so a violation there teaches the violation."""
    from algo_runtime.compiler import compile_rules
    rules = {
        "buy": {"logic": "AND", "groups": [{"logic": "AND", "conditions": [
            {"lhs": {"type": "RSI", "period": 14}, "op": "lt", "rhs_type": "number", "rhs_num": 35},
            {"lhs": {"type": "PRICE"}, "op": "crosses_above", "rhs_type": "indicator",
             "rhs_ind": {"type": "SMA", "period": 50}},
        ]}]},
        "sell": {"logic": "OR", "groups": [{"logic": "OR", "conditions": [
            {"lhs": {"type": "RSI", "period": 14}, "op": "gt", "rhs_type": "number", "rhs_num": 70},
        ]}]},
    }
    from algo_runtime.compiler import rules_warmup
    src = compile_rules(rules)
    warm = rules_warmup(rules)
    assert warm == {"entries": 50, "exits": 16}, warm   # SMA-50 entry, RSI-14 exit
    res = validate_source(src, _ctx(400), RUN, warmup=warm)
    assert res.ok, res.repair_prompt()
