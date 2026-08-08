"""Per-bar position sizing through the P&L engines.

This is the first change that reaches INSIDE _compute_metrics rather than
sitting behind an existing interface, so the first duty of these tests is to
prove nothing moved: size=None must be bit-identical to the engine as it was.
Only then is it worth showing that sizing does anything.
"""
import os
import sys

import numpy as np
import pandas as pd
import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from algo_runtime import indicators as ind                     # noqa: E402
from algo_runtime.contract import Ctx, Signals                 # noqa: E402
from algo_runtime.sandbox import make_runner, run_signal       # noqa: E402
from algo_runtime.validate import validate_source              # noqa: E402
from routers.algo import (_compute_combo_metrics, _compute_metrics,   # noqa: E402
                          _compute_option_metrics, _size_multiplier)

RUN = make_runner(in_process=True)


def _world(n=400, seed=5):
    rng = np.random.default_rng(seed)
    close = 100 * np.exp(np.cumsum(rng.normal(0.0004, 0.013, n)))
    idx = pd.bdate_range("2022-01-03", periods=n)
    series = pd.Series(close, index=idx, name="AAPL")
    fast, slow = ind.sma(close, 10), ind.sma(close, 30)
    buy = ind.crosses_above(fast, slow)
    sell = ind.crosses_below(fast, slow)
    return series, buy, sell


# ── the multiplier itself ────────────────────────────────────────────────────

def test_none_is_all_ones():
    np.testing.assert_array_equal(_size_multiplier(None, 5), np.ones(5))


def test_clamped_to_a_fraction_of_the_configured_size():
    """position_size stays a hard ceiling the user set: a strategy may scale down
    from it, never silently past it."""
    out = _size_multiplier(np.array([-1.0, 0.0, 0.5, 1.0, 4.0]), 5)
    np.testing.assert_array_equal(out, [0.0, 0.0, 0.5, 1.0, 1.0])


def test_nan_funds_nothing():
    """NaN means an indicator was not warm. Funding a position off it would size
    a trade on a number that does not exist yet."""
    np.testing.assert_array_equal(_size_multiplier(np.array([np.nan, 0.5]), 2), [0.0, 0.5])


def test_wrong_shape_is_rejected():
    from fastapi import HTTPException
    with pytest.raises(HTTPException):
        _size_multiplier(np.ones(3), 10)


# ── the guarantee: nothing moved ─────────────────────────────────────────────

@pytest.mark.parametrize("seed", range(6))
def test_size_none_is_bit_identical_to_all_ones(seed):
    """The backwards-compatibility contract, over several random books."""
    series, buy, sell = _world(seed=seed)
    base = _compute_metrics(buy, sell, series, 100, 10_000)
    ones = _compute_metrics(buy, sell, series, 100, 10_000, size=np.ones(len(series)))
    assert base["metrics"] == ones["metrics"]
    np.testing.assert_array_equal([p["strategy"] for p in base["equity_curve"]],
                                  [p["strategy"] for p in ones["equity_curve"]])


def test_existing_callers_are_untouched():
    """Every current caller omits `size`, so their results must be exactly what
    they were before the parameter existed."""
    series, buy, sell = _world()
    r = _compute_metrics(buy, sell, series, 100, 10_000,
                         stop_loss=5, take_profit=10, max_hold_bars=20)
    assert r["metrics"]["num_trades"] > 0
    same = _compute_metrics(buy, sell, series, 100, 10_000,
                            stop_loss=5, take_profit=10, max_hold_bars=20, size=None)
    assert r["metrics"] == same["metrics"]


# ── the guarantee: sizing does something ─────────────────────────────────────

def test_half_size_commits_less_capital():
    series, buy, sell = _world()
    full = _compute_metrics(buy, sell, series, 100, 10_000)
    half = _compute_metrics(buy, sell, series, 100, 10_000, size=np.full(len(series), 0.5))
    assert full["metrics"]["num_trades"] == half["metrics"]["num_trades"] > 0
    # Same trades, smaller stake: the return has to shrink toward zero, and keep
    # its sign — a smaller bet on the same bets cannot flip a winner to a loser.
    assert abs(half["metrics"]["total_return"]) < abs(full["metrics"]["total_return"])
    assert np.sign(half["metrics"]["total_return"]) == np.sign(full["metrics"]["total_return"])


def test_zero_size_never_funds_an_entry():
    series, buy, sell = _world()
    out = _compute_metrics(buy, sell, series, 100, 10_000, size=np.zeros(len(series)))
    assert out["metrics"]["num_trades"] == 0
    assert out["metrics"]["total_return"] == 0


def test_volatility_targeting_changes_the_risk_profile():
    """The strategy this whole feature exists for: stake inversely to volatility,
    so a violent regime gets a smaller bet. Same entries, different drawdown."""
    series, buy, sell = _world()
    close = series.to_numpy()
    vol = ind.realized_vol(close, 21)
    conviction = np.clip(np.nan_to_num(20.0 / np.where(vol > 0, vol, np.nan), nan=0.0), 0, 1)

    flat = _compute_metrics(buy, sell, series, 100, 10_000)
    sized = _compute_metrics(buy, sell, series, 100, 10_000, size=conviction)

    assert sized["metrics"]["num_trades"] == flat["metrics"]["num_trades"] > 0
    assert sized["metrics"]["total_return"] != flat["metrics"]["total_return"]
    # Sizing down in high vol should not make the drawdown worse.
    assert sized["metrics"]["max_drawdown"] >= flat["metrics"]["max_drawdown"]


def _one_shot(n=400, seed=5):
    """Exactly one entry and one exit, so position size is the only variable.

    The multi-signal case confounds it: option lots are independent and cash
    funded, so a smaller stake leaves cash to fund entries a full-size run could
    not afford, and the trade COUNT legitimately differs. Isolating a single
    round trip makes the P&L comparison mean what it looks like it means.
    """
    series, _, _ = _world(n, seed)
    buy = np.zeros(n, dtype=bool)
    sell = np.zeros(n, dtype=bool)
    buy[60] = True
    sell[200] = True
    return series, buy, sell


def test_option_engine_honours_size():
    series, buy, sell = _one_shot()
    inst = {"kind": "option", "type": "call", "moneyness": 1.0, "dte": 30}
    full = _compute_option_metrics(buy, sell, series, inst, 25.0, 100, 10_000)
    half = _compute_option_metrics(buy, sell, series, inst, 25.0, 100, 10_000,
                                   size=np.full(len(series), 0.5))
    assert full["metrics"]["num_trades"] == half["metrics"]["num_trades"] == 1
    # One lot at half the premium: the P&L on it is half, within rounding.
    assert half["metrics"]["total_pnl"] == pytest.approx(full["metrics"]["total_pnl"] / 2, rel=0.02)


def test_option_engine_size_none_is_unchanged():
    series, buy, sell = _world()
    inst = {"kind": "option", "type": "call", "moneyness": 1.0, "dte": 30}
    a = _compute_option_metrics(buy, sell, series, inst, 25.0, 100, 10_000)
    b = _compute_option_metrics(buy, sell, series, inst, 25.0, 100, 10_000,
                                size=np.ones(len(series)))
    assert a["metrics"] == b["metrics"]


def test_combo_engine_honours_size():
    series, buy, sell = _one_shot()
    combo = {"kind": "combo", "legs": [
        {"type": "call", "side": "sell", "moneyness": 1.0, "qty": 1},
        {"type": "put", "side": "sell", "moneyness": 1.0, "qty": 1},
    ], "dte": 30}
    full = _compute_combo_metrics(buy, sell, series, combo, 25.0, 100, 10_000)
    half = _compute_combo_metrics(buy, sell, series, combo, 25.0, 100, 10_000,
                                  size=np.full(len(series), 0.5))
    ones = _compute_combo_metrics(buy, sell, series, combo, 25.0, 100, 10_000,
                                  size=np.ones(len(series)))
    assert full["metrics"] == ones["metrics"]          # unchanged when unsized
    assert full["metrics"]["num_trades"] == half["metrics"]["num_trades"] == 1
    assert half["metrics"]["total_pnl"] == pytest.approx(full["metrics"]["total_pnl"] / 2, rel=0.02)


def test_shares_engine_scales_pnl_linearly():
    """The cleanest statement of what sizing does: same one trade, half the
    stake, half the P&L."""
    series, buy, sell = _one_shot()
    full = _compute_metrics(buy, sell, series, 100, 10_000)
    half = _compute_metrics(buy, sell, series, 100, 10_000, size=np.full(len(series), 0.5))
    assert full["metrics"]["num_trades"] == half["metrics"]["num_trades"] == 1
    # abs=0.01 because the engine rounds reported P&L to cents; the underlying
    # scaling is exact.
    assert half["metrics"]["total_pnl"] == pytest.approx(full["metrics"]["total_pnl"] / 2, abs=0.01)


# ── the contract end to end ──────────────────────────────────────────────────

def _ctx(n=300, seed=0):
    rng = np.random.default_rng(seed)
    close = 100 * np.exp(np.cumsum(rng.normal(0.0004, 0.013, n)))
    high = close * (1 + np.abs(rng.normal(0, 0.006, n)))
    low = close * (1 - np.abs(rng.normal(0, 0.006, n)))
    return Ctx(close=close, bars={"_PRIMARY_": {"high": high, "low": low, "close": close}})


SIZED = """
def signal(c):
    fast = ind.sma(c.close, 10)
    slow = ind.sma(c.close, 30)
    entries = ind.crosses_above(fast, slow)
    exits = ind.crosses_below(fast, slow)
    vol = ind.realized_vol(c.close, 21)
    conviction = ind.clip(ind.ratio(np.full(c.n, 20.0), vol), 0, 1)
    return Signals(entries, exits, conviction)
"""


def test_a_sized_strategy_round_trips_through_the_sandbox():
    ctx = _ctx()
    sig = run_signal(SIZED, ctx)
    assert sig.size is not None and sig.size.shape == (ctx.n,)
    assert np.nanmax(sig.size) <= 1.0


def test_a_sized_strategy_passes_every_validator_layer():
    res = validate_source(SIZED, _ctx(), RUN)
    assert res.ok, res.repair_prompt()


def test_omitting_size_still_validates():
    """Two-argument Signals must keep working — most strategies never size."""
    src = """
def signal(c):
    fast = ind.sma(c.close, 10)
    slow = ind.sma(c.close, 30)
    return Signals(ind.crosses_above(fast, slow), ind.crosses_below(fast, slow))
"""
    ctx = _ctx()
    assert validate_source(src, ctx, RUN).ok
    assert run_signal(src, ctx).size is None


def test_negative_size_is_caught_by_the_validator():
    """A short is expressed with `side`, not a negative stake — a negative here
    is a misunderstanding of the field, so it is refused rather than clamped."""
    src = """
def signal(c):
    e = ind.crosses_above(ind.sma(c.close, 10), ind.sma(c.close, 30))
    return Signals(e, ~e, np.full(c.n, -0.5))
"""
    res = validate_source(src, _ctx(), RUN)
    assert not res.ok and "negative" in res.errors[0].message


def test_all_nan_size_is_caught():
    src = """
def signal(c):
    e = ind.crosses_above(ind.sma(c.close, 10), ind.sma(c.close, 30))
    return Signals(e, ~e, np.full(c.n, np.nan))
"""
    res = validate_source(src, _ctx(), RUN)
    assert not res.ok and "NaN" in res.errors[0].message


def test_wrong_size_shape_is_caught():
    src = """
def signal(c):
    e = ind.crosses_above(ind.sma(c.close, 10), ind.sma(c.close, 30))
    return Signals(e, ~e, np.ones(7))
"""
    res = validate_source(src, _ctx(), RUN)
    assert not res.ok and "size has shape" in res.errors[0].message
