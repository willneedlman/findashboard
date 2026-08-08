"""The `ind` namespace injected into generated code.

Every function here is causal (bar i reads only bars <= i) and vectorized. That
is the whole point: each helper the model calls instead of hand-rolling a
rolling window is a class of lookahead bug that cannot occur.

These are thin wrappers over strategies/indicators.py rather than a second
implementation. Compiled rules therefore produce bit-identical values to the
interpreter by construction, not by luck — which is what makes the differential
test in tests/test_algo_runtime_compiler.py meaningful.
"""
from __future__ import annotations

import os
import sys

import numpy as np
import pandas as pd

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from strategies import indicators as _base   # noqa: E402

# Mirrors strategy.py's _TF_RESAMPLE / _TF_MINUTES. A condition only resamples to
# a STRICTLY coarser frame than the backtest base — a same/finer frame has no
# finer data to compute from.
_TF_RESAMPLE = {"5m": "5min", "15m": "15min", "30m": "30min", "1h": "1h", "hourly": "1h",
                "daily": "D", "weekly": "W-FRI", "monthly": "ME"}
_TF_MINUTES = {"5m": 5, "15m": 15, "30m": 30, "1h": 60, "hourly": 60,
               "daily": 390, "weekly": 1950, "monthly": 8190}
_BASE_MINUTES = {"1d": 390, "1h": 60, "30m": 30, "15m": 15, "5m": 5}


def price(a: np.ndarray) -> np.ndarray:
    return np.asarray(a, dtype=float)


def sma(a: np.ndarray, period: int = 50) -> np.ndarray:
    return _base.sma(np.asarray(a, dtype=float), int(period))


def ema(a: np.ndarray, period: int = 20) -> np.ndarray:
    return _base.ema(np.asarray(a, dtype=float), int(period))


def rsi(a: np.ndarray, period: int = 14) -> np.ndarray:
    return _base.rsi(np.asarray(a, dtype=float), int(period))


def macd_line(a: np.ndarray, fast: int = 12, slow: int = 26, signal_period: int = 9) -> np.ndarray:
    return _base.macd(np.asarray(a, dtype=float), int(fast), int(slow), int(signal_period))[0]


def macd_signal(a: np.ndarray, fast: int = 12, slow: int = 26, signal_period: int = 9) -> np.ndarray:
    return _base.macd(np.asarray(a, dtype=float), int(fast), int(slow), int(signal_period))[1]


def bb_upper(a: np.ndarray, period: int = 20, std: float = 2.0) -> np.ndarray:
    return _base.bollinger(np.asarray(a, dtype=float), int(period), float(std))[0]


def bb_mid(a: np.ndarray, period: int = 20, std: float = 2.0) -> np.ndarray:
    return _base.bollinger(np.asarray(a, dtype=float), int(period), float(std))[1]


def bb_lower(a: np.ndarray, period: int = 20, std: float = 2.0) -> np.ndarray:
    return _base.bollinger(np.asarray(a, dtype=float), int(period), float(std))[2]


def atr(a: np.ndarray, period: int = 14) -> np.ndarray:
    """Close-to-close ATR proxy — the engine has no high/low series."""
    return _base.atr(np.asarray(a, dtype=float), int(period))


def momentum(a: np.ndarray, period: int = 126) -> np.ndarray:
    """price[i] / price[i-period] - 1, as a ratio."""
    return _base.momentum(np.asarray(a, dtype=float), int(period))


def pct_change(a: np.ndarray, period: int = 20) -> np.ndarray:
    """Percent change over N bars as a percentage (5.0 = +5%)."""
    return _base.momentum(np.asarray(a, dtype=float), int(period)) * 100.0


def pct_below_high(a: np.ndarray, period: int = 20) -> np.ndarray:
    return _base.pct_below_high(np.asarray(a, dtype=float), int(period))


def pct_above_low(a: np.ndarray, period: int = 20) -> np.ndarray:
    return _base.pct_above_low(np.asarray(a, dtype=float), int(period))


def realized_vol(a: np.ndarray, period: int = 21) -> np.ndarray:
    """Rolling annualized close-to-close realized vol, as a percentage."""
    return _base.realized_vol(np.asarray(a, dtype=float), int(period))


def iv_rank(a: np.ndarray, period: int = 252) -> np.ndarray:
    """Realized-vol percentile within its own trailing window."""
    return _base.iv_rank(np.asarray(a, dtype=float), rank_period=int(period))


# ── cross-bar primitives ─────────────────────────────────────────────────────

def prev(a: np.ndarray, k: int = 1) -> np.ndarray:
    """Shift forward in time by k bars: out[i] = a[i-k], leading NaN.

    The only sanctioned way to look back. There is deliberately no `future()` —
    and a negative k raises rather than quietly becoming one, since np.roll with
    a negative shift is the single most common lookahead bug.
    """
    k = int(k)
    if k < 0:
        raise ValueError("prev() cannot look forward; k must be >= 0")
    a = np.asarray(a, dtype=float)
    if k == 0:
        return a
    out = np.full(len(a), np.nan)
    if k < len(a):
        out[k:] = a[:-k]
    return out


def crosses_above(a: np.ndarray, b) -> np.ndarray:
    """a was at/below b on the previous bar and is above it now."""
    a = np.asarray(a, dtype=float)
    b = np.full(len(a), float(b)) if np.isscalar(b) else np.asarray(b, dtype=float)
    with np.errstate(invalid="ignore"):
        out = (prev(a) <= prev(b)) & (a > b)
    out[0] = False
    return out


def crosses_below(a: np.ndarray, b) -> np.ndarray:
    a = np.asarray(a, dtype=float)
    b = np.full(len(a), float(b)) if np.isscalar(b) else np.asarray(b, dtype=float)
    with np.errstate(invalid="ignore"):
        out = (prev(a) >= prev(b)) & (a < b)
    out[0] = False
    return out


def rising(a: np.ndarray, k: int = 1) -> np.ndarray:
    with np.errstate(invalid="ignore"):
        return np.asarray(a, dtype=float) > prev(a, k)


def falling(a: np.ndarray, k: int = 1) -> np.ndarray:
    with np.errstate(invalid="ignore"):
        return np.asarray(a, dtype=float) < prev(a, k)


def all_of(*flags: np.ndarray) -> np.ndarray:
    if not flags:
        return np.zeros(0, dtype=bool)
    out = np.ones(len(flags[0]), dtype=bool)
    for f in flags:
        out &= np.asarray(f, dtype=bool)
    return out


def any_of(*flags: np.ndarray) -> np.ndarray:
    if not flags:
        return np.zeros(0, dtype=bool)
    out = np.zeros(len(flags[0]), dtype=bool)
    for f in flags:
        out |= np.asarray(f, dtype=bool)
    return out


def never(n: int) -> np.ndarray:
    return np.zeros(int(n), dtype=bool)


# ── timeframe resampling ─────────────────────────────────────────────────────

_DISPATCH = {
    "price": price, "sma": sma, "ema": ema, "rsi": rsi,
    "macd_line": macd_line, "macd_signal": macd_signal,
    "bb_upper": bb_upper, "bb_mid": bb_mid, "bb_lower": bb_lower,
    "atr": atr, "momentum": momentum, "pct_change": pct_change,
    "pct_below_high": pct_below_high, "pct_above_low": pct_above_low,
    "realized_vol": realized_vol, "iv_rank": iv_rank,
}


def tf(a: np.ndarray, index, timeframe: str, fn: str, base_tf: str = "1d", **params) -> np.ndarray:
    """Compute `fn` on resampled (weekly/monthly/...) bars, then forward-fill onto
    the base index so each bar reads the latest COMPLETED coarse bar.

    Mirrors strategy.py's _tf_indicator. Forward-filling is what keeps this
    causal: a bar never sees the coarse bar it is still inside.
    """
    a = np.asarray(a, dtype=float)
    func = _DISPATCH.get(fn)
    if func is None:
        raise ValueError(f"unknown indicator {fn!r}")
    tf_l = str(timeframe or "daily").lower()
    rule = _TF_RESAMPLE.get(tf_l)
    base_min = _BASE_MINUTES.get(base_tf or "1d", 390)
    # Same or finer than the base has no finer data to compute from.
    if index is None or rule is None or _TF_MINUTES.get(tf_l, 390) <= base_min:
        return func(a, **params)
    ser = pd.Series(a, index=index)
    coarse = ser.resample(rule).last().dropna()
    if coarse.empty:
        return np.full(len(a), np.nan)
    vals = func(coarse.to_numpy(dtype=float), **params)
    return pd.Series(vals, index=coarse.index).reindex(index, method="ffill").to_numpy(dtype=float)


def warmup(fn: str, **params) -> int:
    """Bars needed before `fn` yields a valid value — drives the L4 warmup check."""
    ref = {"type": {
        "price": "PRICE", "sma": "SMA", "ema": "EMA", "rsi": "RSI",
        "macd_line": "MACD_LINE", "macd_signal": "MACD_SIGNAL",
        "bb_upper": "BB_UPPER", "bb_mid": "BB_MID", "bb_lower": "BB_LOWER",
        "atr": "ATR", "momentum": "MOMENTUM", "pct_change": "PCT_CHANGE",
        "pct_below_high": "PCT_BELOW_HIGH", "pct_above_low": "PCT_ABOVE_LOW",
        "realized_vol": "OPT_HV", "iv_rank": "OPT_IVRANK",
    }.get(fn, "PRICE")}
    if "period" in params:
        ref["period"] = params["period"]
    for k in ("fast", "slow", "signal_period"):
        if k in params:
            ref[k] = params[k]
    return _base.warmup_bars(ref)


# ═══════════════════════════════════════════════════════════════════════════
# Beyond the blocks
#
# Everything above mirrors an indicator the visual rule builder already had, so
# compiled rules stay identical to the interpreter. Everything below exists only
# for code strategies: statistics, sequencing and OHLC-derived measures the
# block/boolean system had no way to express.
#
# Every function here is CAUSAL by construction — bar i reads only bars <= i —
# and returns NaN (or False) during warmup rather than a seeded guess. That is
# what lets validate.L3 pass them: a helper that peeked forward would fail the
# perturbation test the moment a strategy used it.
# ═══════════════════════════════════════════════════════════════════════════

def _win(a: np.ndarray, w: int):
    """Trailing windows: row i covers a[i-w+1 .. i], rows before w-1 are absent.
    Callers place results at indices w-1.. so the alignment stays causal."""
    a = np.asarray(a, dtype=float)
    if w < 1 or w > len(a):
        return None
    return np.lib.stride_tricks.sliding_window_view(a, w)


def _rolling(a: np.ndarray, w: int, fn) -> np.ndarray:
    a = np.asarray(a, dtype=float)
    out = np.full(len(a), np.nan)
    win = _win(a, int(w))
    if win is None:
        return out
    with np.errstate(invalid="ignore", divide="ignore"):
        out[int(w) - 1:] = fn(win)
    return out


# ── rolling statistics ───────────────────────────────────────────────────────

def rolling_mean(a: np.ndarray, period: int) -> np.ndarray:
    return _rolling(a, period, lambda w: np.nanmean(w, axis=1))


def rolling_std(a: np.ndarray, period: int) -> np.ndarray:
    """Sample standard deviation (ddof=1), matching the Bollinger convention."""
    return _rolling(a, period, lambda w: np.nanstd(w, axis=1, ddof=1))


def rolling_min(a: np.ndarray, period: int) -> np.ndarray:
    return _rolling(a, period, lambda w: np.nanmin(w, axis=1))


def rolling_max(a: np.ndarray, period: int) -> np.ndarray:
    return _rolling(a, period, lambda w: np.nanmax(w, axis=1))


def rolling_sum(a: np.ndarray, period: int) -> np.ndarray:
    return _rolling(a, period, lambda w: np.nansum(w, axis=1))


def rolling_median(a: np.ndarray, period: int) -> np.ndarray:
    return _rolling(a, period, lambda w: np.nanmedian(w, axis=1))


def zscore(a: np.ndarray, period: int = 20) -> np.ndarray:
    """(value - trailing mean) / trailing sd. How unusual this bar is against its
    own recent history — the standard way to compare a level across regimes."""
    m, s = rolling_mean(a, period), rolling_std(a, period)
    with np.errstate(invalid="ignore", divide="ignore"):
        out = (np.asarray(a, dtype=float) - m) / s
    return np.where(np.isfinite(out), out, np.nan)


def percentile_rank(a: np.ndarray, period: int = 252) -> np.ndarray:
    """Where this bar sits in its own trailing window, 0-100. Regime-free: a
    reading of 95 means the same thing in a calm year and a violent one."""
    a = np.asarray(a, dtype=float)
    out = np.full(len(a), np.nan)
    win = _win(a, int(period))
    if win is None:
        return out
    cur = a[int(period) - 1:][:, None]
    with np.errstate(invalid="ignore"):
        out[int(period) - 1:] = np.nanmean((win <= cur).astype(float), axis=1) * 100.0
    return out


def rolling_corr(a: np.ndarray, b: np.ndarray, period: int = 60) -> np.ndarray:
    """Trailing Pearson correlation between two series — pair trading, regime
    detection, and 'is my hedge still working'."""
    a, b = np.asarray(a, dtype=float), np.asarray(b, dtype=float)
    n = min(len(a), len(b))
    out = np.full(len(a), np.nan)
    wa, wb = _win(a[:n], int(period)), _win(b[:n], int(period))
    if wa is None or wb is None:
        return out
    with np.errstate(invalid="ignore", divide="ignore"):
        da = wa - np.nanmean(wa, axis=1, keepdims=True)
        db = wb - np.nanmean(wb, axis=1, keepdims=True)
        num = np.nansum(da * db, axis=1)
        den = np.sqrt(np.nansum(da ** 2, axis=1) * np.nansum(db ** 2, axis=1))
        vals = np.where(den > 0, num / den, np.nan)
    out[int(period) - 1:n] = vals
    return out


def rolling_beta(a: np.ndarray, benchmark: np.ndarray, period: int = 60) -> np.ndarray:
    """Trailing beta of a's returns to the benchmark's. Computed on returns, not
    levels — beta on price levels is a meaningless number that looks plausible."""
    ra, rb = pct_returns(a), pct_returns(benchmark)
    n = min(len(ra), len(rb))
    out = np.full(len(np.asarray(a)), np.nan)
    wa, wb = _win(ra[:n], int(period)), _win(rb[:n], int(period))
    if wa is None or wb is None:
        return out
    with np.errstate(invalid="ignore", divide="ignore"):
        da = wa - np.nanmean(wa, axis=1, keepdims=True)
        db = wb - np.nanmean(wb, axis=1, keepdims=True)
        var = np.nansum(db ** 2, axis=1)
        vals = np.where(var > 0, np.nansum(da * db, axis=1) / var, np.nan)
    out[int(period) - 1:n] = vals
    return out


def slope(a: np.ndarray, period: int = 20) -> np.ndarray:
    """Least-squares slope over the trailing window, in units per bar. A cleaner
    trend read than comparing two moving averages."""
    a = np.asarray(a, dtype=float)
    out = np.full(len(a), np.nan)
    w = int(period)
    win = _win(a, w)
    if win is None:
        return out
    x = np.arange(w, dtype=float)
    xc = x - x.mean()
    denom = float(np.sum(xc ** 2)) or np.nan
    with np.errstate(invalid="ignore"):
        yc = win - np.nanmean(win, axis=1, keepdims=True)
        out[w - 1:] = (yc * xc).sum(axis=1) / denom
    return out


def pct_returns(a: np.ndarray) -> np.ndarray:
    """Simple bar-over-bar returns, leading NaN."""
    a = np.asarray(a, dtype=float)
    out = np.full(len(a), np.nan)
    if len(a) > 1:
        with np.errstate(invalid="ignore", divide="ignore"):
            out[1:] = np.where(a[:-1] != 0, a[1:] / a[:-1] - 1.0, np.nan)
    return out


# ── OHLC-derived (impossible with a close-only DSL) ──────────────────────────

def true_range(high: np.ndarray, low: np.ndarray, close: np.ndarray) -> np.ndarray:
    """max(H-L, |H-prevC|, |L-prevC|) — the real thing, not the close-to-close
    proxy the block engine had to use."""
    h, l, c = (np.asarray(x, dtype=float) for x in (high, low, close))
    pc = prev(c)
    with np.errstate(invalid="ignore"):
        return np.nanmax(np.vstack([h - l, np.abs(h - pc), np.abs(l - pc)]), axis=0)


def atr_true(high: np.ndarray, low: np.ndarray, close: np.ndarray, period: int = 14) -> np.ndarray:
    """Wilder's ATR over the true range."""
    tr = true_range(high, low, close)
    n = len(tr)
    out = np.full(n, np.nan)
    p = int(period)
    if n <= p:
        return out
    seed = np.nanmean(tr[1:p + 1])
    out[p] = seed
    for i in range(p + 1, n):
        prev_v = out[i - 1]
        cur = tr[i]
        out[i] = prev_v if np.isnan(cur) else (prev_v * (p - 1) + cur) / p
    return out


def gap_pct(open_: np.ndarray, close: np.ndarray) -> np.ndarray:
    """Overnight gap: this bar's open against the previous close, in percent."""
    o, c = np.asarray(open_, dtype=float), np.asarray(close, dtype=float)
    pc = prev(c)
    with np.errstate(invalid="ignore", divide="ignore"):
        return np.where(pc != 0, (o - pc) / pc * 100.0, np.nan)


def range_pct(high: np.ndarray, low: np.ndarray, close: np.ndarray) -> np.ndarray:
    """Bar range as a percent of close — intrabar volatility, per bar."""
    h, l, c = (np.asarray(x, dtype=float) for x in (high, low, close))
    with np.errstate(invalid="ignore", divide="ignore"):
        return np.where(c != 0, (h - l) / c * 100.0, np.nan)


def close_position(high: np.ndarray, low: np.ndarray, close: np.ndarray) -> np.ndarray:
    """Where the close sits inside the bar's range, 0 (at the low) to 1 (at the
    high). Distinguishes a strong close from a weak one at the same price."""
    h, l, c = (np.asarray(x, dtype=float) for x in (high, low, close))
    span = h - l
    with np.errstate(invalid="ignore", divide="ignore"):
        return np.where(span > 0, (c - l) / span, np.nan)


def typical_price(high: np.ndarray, low: np.ndarray, close: np.ndarray) -> np.ndarray:
    return (np.asarray(high, dtype=float) + np.asarray(low, dtype=float)
            + np.asarray(close, dtype=float)) / 3.0


# ── volume ───────────────────────────────────────────────────────────────────

def relative_volume(volume: np.ndarray, period: int = 20) -> np.ndarray:
    """Today's volume against its trailing average. 1.0 = typical, 3.0 = a
    three-times-normal day."""
    v = np.asarray(volume, dtype=float)
    avg = rolling_mean(prev(v), period)      # prev() so today is not in its own average
    with np.errstate(invalid="ignore", divide="ignore"):
        return np.where(avg > 0, v / avg, np.nan)


def dollar_volume(close: np.ndarray, volume: np.ndarray) -> np.ndarray:
    return np.asarray(close, dtype=float) * np.asarray(volume, dtype=float)


def vwap(price: np.ndarray, volume: np.ndarray, period: int = 20) -> np.ndarray:
    """Rolling volume-weighted average price over a trailing window."""
    p, v = np.asarray(price, dtype=float), np.asarray(volume, dtype=float)
    pv = rolling_sum(p * v, period)
    vv = rolling_sum(v, period)
    with np.errstate(invalid="ignore", divide="ignore"):
        return np.where(vv > 0, pv / vv, np.nan)


def obv(close: np.ndarray, volume: np.ndarray) -> np.ndarray:
    """On-balance volume: cumulative signed volume."""
    c, v = np.asarray(close, dtype=float), np.asarray(volume, dtype=float)
    d = np.sign(np.diff(c, prepend=c[0] if len(c) else 0.0))
    return np.nancumsum(np.where(np.isnan(v), 0.0, v) * d)


# ── sequencing and state (no equivalent in a stateless boolean DSL) ──────────

def bars_since(flag: np.ndarray) -> np.ndarray:
    """Bars elapsed since `flag` was last True, NaN before it ever was.

    Unlocks the whole class of rules the block system cannot state: "only enter
    if we have not entered in 10 bars", "exit 5 bars after the signal", "the
    second dip inside a month".
    """
    f = np.asarray(flag, dtype=bool)
    n = len(f)
    out = np.full(n, np.nan)
    last = -1
    for i in range(n):
        if f[i]:
            last = i
        if last >= 0:
            out[i] = i - last
    return out


def cooldown(flag: np.ndarray, bars: int) -> np.ndarray:
    """`flag` with any firing suppressed for `bars` after a previous one — the
    rate limiter a stateless rule cannot express."""
    f = np.asarray(flag, dtype=bool)
    n, k = len(f), int(bars)
    out = np.zeros(n, dtype=bool)
    blocked_until = -1
    for i in range(n):
        if f[i] and i > blocked_until:
            out[i] = True
            blocked_until = i + k
    return out


def streak(flag: np.ndarray) -> np.ndarray:
    """Length of the current run of True, 0 where False."""
    f = np.asarray(flag, dtype=bool)
    out = np.zeros(len(f), dtype=float)
    run = 0
    for i, v in enumerate(f):
        run = run + 1 if v else 0
        out[i] = run
    return out


def count_in_window(flag: np.ndarray, period: int) -> np.ndarray:
    """How many times `flag` fired in the trailing window."""
    return rolling_sum(np.asarray(flag, dtype=float), period)


def held_for(flag: np.ndarray, bars: int) -> np.ndarray:
    """True once `flag` has been continuously true for `bars` bars — a filter
    against one-bar noise."""
    return streak(flag) >= int(bars)


# ── drawdown and extremes ────────────────────────────────────────────────────

def drawdown_pct(a: np.ndarray) -> np.ndarray:
    """Percent below the running (expanding) peak. Causal: the peak only ever
    looks backwards."""
    a = np.asarray(a, dtype=float)
    peak = np.maximum.accumulate(np.where(np.isnan(a), -np.inf, a))
    with np.errstate(invalid="ignore", divide="ignore"):
        out = np.where(peak > 0, (a - peak) / peak * 100.0, np.nan)
    return np.where(np.isfinite(out), out, np.nan)


def runup_pct(a: np.ndarray) -> np.ndarray:
    """Percent above the running trough."""
    a = np.asarray(a, dtype=float)
    trough = np.minimum.accumulate(np.where(np.isnan(a), np.inf, a))
    with np.errstate(invalid="ignore", divide="ignore"):
        out = np.where(trough > 0, (a - trough) / trough * 100.0, np.nan)
    return np.where(np.isfinite(out), out, np.nan)


def is_new_high(a: np.ndarray, period: int = 252) -> np.ndarray:
    """At a new trailing-window high, this bar included."""
    with np.errstate(invalid="ignore"):
        return np.asarray(a, dtype=float) >= rolling_max(a, period)


def is_new_low(a: np.ndarray, period: int = 252) -> np.ndarray:
    with np.errstate(invalid="ignore"):
        return np.asarray(a, dtype=float) <= rolling_min(a, period)


# ── relative / cross-ticker ──────────────────────────────────────────────────

def ratio(a: np.ndarray, b: np.ndarray) -> np.ndarray:
    a, b = np.asarray(a, dtype=float), np.asarray(b, dtype=float)
    with np.errstate(invalid="ignore", divide="ignore"):
        return np.where(b != 0, a / b, np.nan)


def relative_strength(a: np.ndarray, benchmark: np.ndarray, period: int = 63) -> np.ndarray:
    """a's return over the window minus the benchmark's, in percentage points."""
    return (momentum(a, period) - momentum(benchmark, period)) * 100.0


def spread_zscore(a: np.ndarray, b: np.ndarray, period: int = 60) -> np.ndarray:
    """Z-score of the a/b ratio — the pair-trading entry signal, in one call."""
    return zscore(ratio(a, b), period)


# ── calendar (needs c.index) ─────────────────────────────────────────────────

def _dt_attr(index, attr: str, n: int) -> np.ndarray:
    if index is None:
        return np.full(n, np.nan)
    try:
        idx = pd.DatetimeIndex(index)
        return getattr(idx, attr).to_numpy().astype(float)
    except Exception:
        return np.full(n, np.nan)


def day_of_week(index, n: int) -> np.ndarray:
    """Monday=0 .. Friday=4. NaN when the caller has no index."""
    return _dt_attr(index, "dayofweek", n)


def month_of_year(index, n: int) -> np.ndarray:
    return _dt_attr(index, "month", n)


def is_month_end(index, n: int) -> np.ndarray:
    """Last bar of its calendar month — decided from this bar and the NEXT bar's
    month, which is a lookahead of exactly one bar, so it is computed from the
    PREVIOUS bar instead: true on the first bar of a new month."""
    if index is None:
        return np.zeros(n, dtype=bool)
    m = month_of_year(index, n)
    return np.concatenate([[False], m[1:] != m[:-1]]) if n > 1 else np.zeros(n, dtype=bool)


# ── shaping ──────────────────────────────────────────────────────────────────

def clip(a: np.ndarray, lo: float, hi: float) -> np.ndarray:
    return np.clip(np.asarray(a, dtype=float), lo, hi)


def where(cond: np.ndarray, a, b) -> np.ndarray:
    return np.where(np.asarray(cond, dtype=bool), a, b)


def fill_missing(a: np.ndarray, value: float = 0.0) -> np.ndarray:
    """Replace NaN with a value. Use sparingly: NaN during warmup is correct,
    and filling it makes a strategy fire before its indicators are ready."""
    return np.nan_to_num(np.asarray(a, dtype=float), nan=float(value))
