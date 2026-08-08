"""Every helper beyond the block vocabulary, checked for causality.

This is the load-bearing test for the expanded library. The safety story is
"the helpers are causal, so lean on them instead of hand-rolling" — if any one
of them leaks the future, every strategy built on it inherits the leak and L3
would be catching the user's code while the tool supplied the bug.

Each helper is exercised inside a real `signal()` and put through the full
validator, whose L3 pass perturbs the data after bar k and asserts the earlier
signals are unchanged.
"""
import os
import sys

import numpy as np
import pandas as pd
import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from algo_runtime import indicators as ind                 # noqa: E402
from algo_runtime.contract import Ctx                      # noqa: E402
from algo_runtime.sandbox import make_runner               # noqa: E402
from algo_runtime.validate import validate_source          # noqa: E402

RUN = make_runner(in_process=True)


def _ctx(n=400, seed=0) -> Ctx:
    rng = np.random.default_rng(seed)
    close = 100 * np.exp(np.cumsum(rng.normal(0.0004, 0.013, n)))
    high = close * (1 + np.abs(rng.normal(0, 0.006, n)))
    low = close * (1 - np.abs(rng.normal(0, 0.006, n)))
    open_ = close * (1 + rng.normal(0, 0.004, n))
    # Lognormal, not normal: real volume is strongly right-skewed, and a normal
    # fixture makes relative_volume > 1.8 fire once in 400 bars, which would
    # make every volume-spike test vacuous.
    volume = np.exp(rng.normal(np.log(5e6), 0.45, n))
    bench = 100 * np.exp(np.cumsum(rng.normal(0.0003, 0.010, n)))
    return Ctx(
        close=close,
        index=pd.bdate_range("2022-01-03", periods=n),
        frames={"_PRIMARY_": close, "SPY": bench},
        bars={"_PRIMARY_": {"open": open_, "high": high, "low": low,
                            "close": close, "volume": volume}},
    )


# One expression per helper. Each must be causal, and each must produce a
# strategy whose signals actually move — a helper returning all-NaN would pass
# a causality check trivially.
EXPRESSIONS = {
    # rolling statistics
    "rolling_mean":     "ind.rolling_mean(c.close, 20)",
    "rolling_std":      "ind.rolling_std(c.close, 20)",
    "rolling_min":      "ind.rolling_min(c.close, 20)",
    "rolling_max":      "ind.rolling_max(c.close, 20)",
    "rolling_sum":      "ind.rolling_sum(c.close, 20)",
    "rolling_median":   "ind.rolling_median(c.close, 20)",
    "zscore":           "ind.zscore(c.close, 20)",
    "percentile_rank":  "ind.percentile_rank(c.close, 60)",
    "slope":            "ind.slope(c.close, 20)",
    "pct_returns":      "ind.pct_returns(c.close)",
    "rolling_corr":     "ind.rolling_corr(c.close, c.frame('SPY'), 60)",
    "rolling_beta":     "ind.rolling_beta(c.close, c.frame('SPY'), 60)",
    # OHLC-derived
    "true_range":       "ind.true_range(c.high, c.low, c.close)",
    "atr_true":         "ind.atr_true(c.high, c.low, c.close, 14)",
    "gap_pct":          "ind.gap_pct(c.open, c.close)",
    "range_pct":        "ind.range_pct(c.high, c.low, c.close)",
    "close_position":   "ind.close_position(c.high, c.low, c.close)",
    "typical_price":    "ind.typical_price(c.high, c.low, c.close)",
    # volume
    "relative_volume":  "ind.relative_volume(c.volume, 20)",
    "dollar_volume":    "ind.dollar_volume(c.close, c.volume)",
    "vwap":             "ind.vwap(c.close, c.volume, 20)",
    "obv":              "ind.obv(c.close, c.volume)",
    # sequencing / state
    "bars_since":       "ind.bars_since(c.close > ind.sma(c.close, 50))",
    "streak":           "ind.streak(c.close > ind.sma(c.close, 20))",
    "count_in_window":  "ind.count_in_window(c.close > ind.sma(c.close, 20), 30)",
    # drawdown / extremes
    "drawdown_pct":     "ind.drawdown_pct(c.close)",
    "runup_pct":        "ind.runup_pct(c.close)",
    # relative
    "ratio":            "ind.ratio(c.close, c.frame('SPY'))",
    "relative_strength": "ind.relative_strength(c.close, c.frame('SPY'), 63)",
    "spread_zscore":    "ind.spread_zscore(c.close, c.frame('SPY'), 60)",
    # calendar
    "day_of_week":      "ind.day_of_week(c.index, c.n)",
    "month_of_year":    "ind.month_of_year(c.index, c.n)",
    # shaping
    "clip":             "ind.clip(ind.zscore(c.close, 20), -3, 3)",
}

BOOL_EXPRESSIONS = {
    "cooldown":     "ind.cooldown(c.close > ind.sma(c.close, 20), 10)",
    "held_for":     "ind.held_for(c.close > ind.sma(c.close, 20), 3)",
    "is_new_high":  "ind.is_new_high(c.close, 60)",
    "is_new_low":   "ind.is_new_low(c.close, 60)",
    "is_month_end": "ind.is_month_end(c.index, c.n)",
    "where":        "ind.where(c.close > ind.sma(c.close, 20), True, False)",
}


def _numeric_strategy(expr: str) -> str:
    return f"""
def signal(c):
    x = {expr}
    m = ind.rolling_median(x, 40)
    entries = x > m
    exits = x < m
    return Signals(entries, exits)
"""


def _bool_strategy(expr: str) -> str:
    return f"""
def signal(c):
    f = {expr}
    entries = f
    exits = ~f
    return Signals(entries, exits)
"""


@pytest.mark.parametrize("name", sorted(EXPRESSIONS))
def test_numeric_helper_is_causal(name):
    res = validate_source(_numeric_strategy(EXPRESSIONS[name]), _ctx(), RUN)
    assert res.ok, f"{name}: {res.repair_prompt()}"


@pytest.mark.parametrize("name", sorted(BOOL_EXPRESSIONS))
def test_boolean_helper_is_causal(name):
    res = validate_source(_bool_strategy(BOOL_EXPRESSIONS[name]), _ctx(), RUN)
    assert res.ok, f"{name}: {res.repair_prompt()}"


@pytest.mark.parametrize("name", sorted(EXPRESSIONS))
def test_numeric_helper_actually_produces_values(name):
    """A helper that returned all-NaN would pass every causality check while
    being useless, so the sweep above would be vacuous without this."""
    ctx = _ctx()
    ns = {"ind": ind, "np": np, "c": ctx}
    val = np.asarray(eval(EXPRESSIONS[name], ns), dtype=float)   # noqa: S307 — fixtures
    assert val.shape == (ctx.n,), f"{name} returned {val.shape}"
    finite = np.isfinite(val).sum()
    assert finite > ctx.n * 0.2, f"{name} produced only {finite}/{ctx.n} finite values"


def test_ohlc_is_really_populated():
    """The point of the OHLCV unlock: high != low != close, so bar-shape
    strategies are expressible at all."""
    ctx = _ctx()
    assert np.isfinite(ctx.high).all() and np.isfinite(ctx.low).all()
    assert (ctx.high >= ctx.close).all() and (ctx.low <= ctx.close).all()
    assert np.isfinite(ctx.volume).all()


def test_missing_ohlc_field_is_nan_not_zero():
    """A feed without volume must make volume conditions never fire, not fire on
    zeros. NaN comparisons are False, which is the behaviour we want."""
    ctx = Ctx(close=np.arange(1.0, 51.0))
    assert np.isnan(ctx.volume).all()
    assert not (ctx.volume > 0).any()


def test_true_atr_differs_from_the_close_only_proxy():
    """If these agreed, exposing high/low would have bought nothing."""
    ctx = _ctx()
    real = ind.atr_true(ctx.high, ctx.low, ctx.close, 14)
    proxy = ind.atr(ctx.close, 14)
    both = np.isfinite(real) & np.isfinite(proxy)
    assert both.sum() > 100
    assert not np.allclose(real[both], proxy[both])
    # The true range includes the intrabar span, so it cannot be smaller on average.
    assert np.nanmean(real[both]) > np.nanmean(proxy[both])


def test_bars_since_counts_from_the_last_occurrence():
    flag = np.array([False, True, False, False, True, False], dtype=bool)
    np.testing.assert_array_equal(ind.bars_since(flag)[1:], [0, 1, 2, 0, 1])
    assert np.isnan(ind.bars_since(flag)[0])


def test_cooldown_suppresses_within_the_window():
    flag = np.ones(10, dtype=bool)
    out = ind.cooldown(flag, 3)
    assert out.tolist() == [True, False, False, False, True, False, False, False, True, False]


def test_streak_counts_consecutive_truths():
    flag = np.array([True, True, False, True, True, True], dtype=bool)
    np.testing.assert_array_equal(ind.streak(flag), [1, 2, 0, 1, 2, 3])


def test_prev_still_refuses_to_look_forward():
    with pytest.raises(ValueError):
        ind.prev(np.arange(10.0), -1)


def test_a_strategy_the_block_system_could_not_express():
    """The whole justification for this layer: entry needs a volume spike, a real
    ATR-normalised range, a z-score, and a rate limiter — none of which the
    condition DSL can state, and all of which must still pass every check."""
    src = """
def signal(c):
    z = ind.zscore(c.close, 20)
    rv = ind.relative_volume(c.volume, 20)
    atr = ind.atr_true(c.high, c.low, c.close, 14)
    stretched = ind.ratio(c.close - ind.sma(c.close, 20), atr)
    raw = ind.all_of(z < -1.0, rv > 1.3, stretched < -0.5)
    entries = ind.cooldown(raw, 10)
    exits = ind.any_of(z > 1.0, ind.bars_since(entries) > 15)
    return Signals(entries, exits)
"""
    ctx = _ctx()
    res = validate_source(src, ctx, RUN)
    assert res.ok, res.repair_prompt()
    sig = RUN(src, ctx)
    assert sig.entries.sum() > 0, "strategy never trades — the test proves nothing"
