"""L7: is the request possible, and does the code do what was asked?

These cover the two failures L0-L6 let through:
  * an impossible request answered with a different, possible strategy
  * code that runs, is causal, and quietly implements the wrong thing

conformance() is deterministic (AST only), so it is tested directly. Extraction
uses the model and is exercised in the live checks rather than here.
"""
import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from algo_runtime.spec import _clean, conformance, future_hints, refusal   # noqa: E402


def _spec(entry=None, exit=None, feasible=True, **kw):
    return {"feasible": feasible, "entry": entry or [], "exit": exit or [], **kw}


def _c(indicator, op, value=None, period=None, against=None):
    return {"indicator": indicator, "op": op, "value": value,
            "period": period, "against": against}


GOOD = """
def signal(c):
    rsi = ind.rsi(c.close, period=14)
    ma = ind.sma(c.close, period=200)
    entries = ind.all_of(rsi < 30, c.close > ma)
    exits = rsi > 65
    return Signals(entries, exits)
"""


def test_matching_code_has_no_findings():
    spec = _spec(entry=[_c("rsi", "lt", 30, 14)], exit=[_c("rsi", "gt", 65, 14)])
    assert conformance(GOOD, spec) == []


def test_missing_indicator_is_caught():
    """The user asked for a 200d MA and the code has none."""
    src = """
def signal(c):
    rsi = ind.rsi(c.close, period=14)
    return Signals(rsi < 30, rsi > 65)
"""
    out = conformance(src, _spec(entry=[_c("sma", "gt", None, 200)]))
    assert len(out) == 1 and "never uses sma" in out[0]["message"]


def test_wrong_threshold_is_caught():
    """Runs fine, causal, and silently trades a different level."""
    src = """
def signal(c):
    rsi = ind.rsi(c.close, period=14)
    return Signals(rsi < 40, rsi > 65)
"""
    out = conformance(src, _spec(entry=[_c("rsi", "lt", 30, 14)]))
    assert len(out) == 1
    assert "asked for rsi(14) lt 30" in out[0]["message"] and "compares rsi against 40" in out[0]["message"]


def test_inverted_comparison_is_caught():
    """The classic silent bug: buy when RSI is HIGH because the sign flipped."""
    src = """
def signal(c):
    rsi = ind.rsi(c.close, period=14)
    return Signals(rsi > 30, rsi > 65)
"""
    out = conformance(src, _spec(entry=[_c("rsi", "lt", 30, 14)]))
    assert len(out) == 1 and "inverted" in out[0]["message"]


def test_inverted_cross_is_caught():
    src = """
def signal(c):
    ma = ind.sma(c.close, period=50)
    return Signals(ind.crosses_below(c.close, ma), ind.crosses_above(c.close, ma))
"""
    out = conformance(src, _spec(entry=[_c("price", "crosses_above", None, 50, against="sma")]))
    assert out and "wrong way" in out[0]["message"]


def test_cross_matches_from_either_subject():
    """"price crosses above the 50d MA" and "the 50d MA crosses below price" are
    the same event, so both phrasings must match the same code — but "sma
    crosses ABOVE price" is the opposite event and must not."""
    src = """
def signal(c):
    ma = ind.sma(c.close, period=50)
    return Signals(ind.crosses_above(c.close, ma), ind.crosses_below(c.close, ma))
"""
    assert conformance(src, _spec(entry=[_c("price", "crosses_above", against="sma")])) == []
    assert conformance(src, _spec(entry=[_c("sma", "crosses_below", against="price")])) == []
    assert conformance(src, _spec(entry=[_c("sma", "crosses_above", against="price")])) != []


def test_entry_and_exit_are_checked_separately():
    """The bug that made a per-side scope necessary: a symmetric strategy has
    both cross directions present, so pooling them hides an inverted entry."""
    src = """
def signal(c):
    ma = ind.sma(c.close, period=50)
    return Signals(ind.crosses_below(c.close, ma), ind.crosses_above(c.close, ma))
"""
    ok = _spec(entry=[_c("price", "crosses_below", against="sma")],
               exit=[_c("price", "crosses_above", against="sma")])
    assert conformance(src, ok) == []
    swapped = _spec(entry=[_c("price", "crosses_above", against="sma")],
                    exit=[_c("price", "crosses_below", against="sma")])
    out = conformance(src, swapped)
    assert len(out) == 2 and all("wrong way" in d["message"] for d in out)


@pytest.mark.parametrize("code_op,spec_op", [(">=", "gt"), (">", "gte"), ("<=", "lt"), ("<", "lte")])
def test_strict_and_inclusive_bounds_are_the_same_condition(code_op, spec_op):
    """`> 72` and `>= 72` differ only at exact equality — measure-zero on a float
    indicator, and never what "above 72" means. Flagging it produced a false
    positive that cost a repair round-trip and then oscillated between forms."""
    src = f"""
def signal(c):
    rsi = ind.rsi(c.close, period=14)
    return Signals(rsi < 25, rsi {code_op} 72)
"""
    assert conformance(src, _spec(exit=[_c("rsi", spec_op, 72, 14)])) == []


def test_direction_reversal_is_still_caught():
    """Loosening the boundary must not blunt the check that matters."""
    src = """
def signal(c):
    rsi = ind.rsi(c.close, period=14)
    return Signals(rsi < 25, rsi <= 72)
"""
    out = conformance(src, _spec(exit=[_c("rsi", "gt", 72, 14)]))
    assert len(out) == 1 and "inverted" in out[0]["message"]


def test_indicator_to_indicator_comparison_matches():
    src = """
def signal(c):
    fast = ind.sma(c.close, period=20)
    slow = ind.sma(c.close, period=50)
    return Signals(fast > slow, fast < slow)
"""
    assert conformance(src, _spec(entry=[_c("sma", "gt", None, 20)])) == []


def test_constant_on_the_left_still_matches():
    """`30 > rsi` is the same condition as `rsi < 30`."""
    src = """
def signal(c):
    rsi = ind.rsi(c.close, period=14)
    return Signals(30 > rsi, rsi > 65)
"""
    assert conformance(src, _spec(entry=[_c("rsi", "lt", 30, 14)])) == []


def test_empty_spec_never_complains():
    """A vague request extracts nothing, so there is nothing to be wrong about.
    A false accusation would teach users to ignore the checker."""
    assert conformance(GOOD, _spec()) == []
    assert conformance("def signal(c):\n    return Signals(ind.never(c.n), ind.never(c.n))", _spec()) == []


def test_broken_source_is_not_double_reported():
    """Syntax errors belong to L0; L7 stays quiet so one bug is one message."""
    assert conformance("def signal(c)\n  bad", _spec(entry=[_c("rsi", "lt", 30)])) == []


def test_multiple_conditions_report_independently():
    src = """
def signal(c):
    rsi = ind.rsi(c.close, period=14)
    return Signals(rsi > 30, rsi > 65)
"""
    out = conformance(src, _spec(entry=[_c("rsi", "lt", 30, 14), _c("sma", "gt", None, 200)]))
    assert len(out) == 2
    assert any("inverted" in d["message"] for d in out)
    assert any("never uses sma" in d["message"] for d in out)


# ── extraction hygiene ───────────────────────────────────────────────────────

def test_severity_split_blocks_only_demonstrable_mismatches():
    """A wrong threshold or inverted comparison is provable — the indicator is
    right there and the code does something else, so it blocks. "Never uses X"
    is not: the extractor may have named the wrong helper for what the user
    described (raw `volume` for "2x normal volume", which is relative_volume).
    Blocking correct code on a misread request is the worst thing this checker
    can do, so that class only warns."""
    src = """
def signal(c):
    rsi = ind.rsi(c.close, period=14)
    return Signals(rsi < 40, rsi > 65)
"""
    wrong_threshold = conformance(src, _spec(entry=[_c("rsi", "lt", 30, 14)]))
    assert wrong_threshold[0]["severity"] == "error"

    inverted = conformance(src, _spec(entry=[_c("rsi", "gt", 40, 14)]))
    assert inverted and inverted[0]["severity"] == "error"

    missing = conformance(src, _spec(entry=[_c("relative_volume", "gt", 2)]))
    assert missing and missing[0]["severity"] == "warning"


def test_bar_fields_are_recognised():
    """c.volume / c.high / c.low were invisible to the reader, so any bar-field
    condition read as "never used" and warned on correct code."""
    src = """
def signal(c):
    return Signals(c.volume > 1000000, c.high < 50)
"""
    assert conformance(src, _spec(entry=[_c("volume", "gt", 1000000)])) == []
    assert conformance(src, _spec(exit=[_c("high", "lt", 50)])) == []


def test_spec_vocabulary_tracks_the_helper_library():
    """The extractor's vocabulary must not fall behind `ind`.

    When the helper library grew past the block set and this list did not, the
    extractor forced rich requests onto the nearest old name ("close in the
    bottom quarter of the bar range" -> pct_below_high) and conformance then
    rejected correct code. Every name here must exist as a helper, and the
    helpers a user is likely to name must appear here.
    """
    from algo_runtime import indicators as ind
    from algo_runtime.spec import _INDICATORS
    fields = {"price", "open", "high", "low", "volume"}
    for name in _INDICATORS - fields:
        assert hasattr(ind, name), f"spec names {name!r}, which is not a helper"
    for expected in ("zscore", "close_position", "relative_volume", "atr_true",
                     "bars_since", "drawdown_pct", "slope", "spread_zscore"):
        assert expected in _INDICATORS, f"{expected} is a helper but not extractable"


def test_clean_drops_unusable_conditions():
    rows = [
        {"indicator": "rsi", "op": "lt", "value": 30, "period": 14},     # keep
        {"indicator": "moon_phase", "op": "lt", "value": 3},             # not in vocabulary
        {"indicator": "rsi", "op": "vibes", "value": 30},                # not an operator
        "not a dict",
    ]
    out = _clean(rows)
    assert len(out) == 1 and out[0]["indicator"] == "rsi"


def test_clean_coerces_loose_numbers():
    out = _clean([{"indicator": "sma", "op": "gt", "value": "200.0", "period": "200"}])
    assert out[0]["value"] == 200.0 and out[0]["period"] == 200


# ── feasibility ──────────────────────────────────────────────────────────────

@pytest.mark.parametrize("prompt", [
    "buy when the next 5 days are going to be up",
    "sell at the exact top of the move",
    "enter right before it rallies",
    "buy the exact bottom",
    "a strategy that will avoid every drawdown",
])
def test_future_phrasing_is_flagged_for_review(prompt):
    assert future_hints(prompt), prompt


@pytest.mark.parametrize("prompt", [
    "buy when RSI is oversold",
    "buy when momentum suggests a rally is likely",
    "sell when price falls 5% from its recent high",
    "enter on a golden cross",
])
def test_ordinary_requests_are_not_flagged(prompt):
    assert not future_hints(prompt), prompt


def test_refusal_explains_and_offers_an_alternative():
    out = refusal({"reason": "it needs tomorrow's close.",
                   "alternative": "enter when RSI turns up from oversold."}, "buy the bottom")
    assert out["ok"] is False and out["infeasible"] is True
    assert out["source"] is None                      # nothing is silently written
    assert "tomorrow's close" in out["explanation"]
    assert "RSI turns up" in out["explanation"]


def test_refusal_without_an_alternative_still_explains_the_rule():
    out = refusal({"reason": "it needs future bars."}, "x")
    assert "decidable on the bar it fires" in out["explanation"]
