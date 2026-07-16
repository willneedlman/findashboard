"""
Vectorised indicator functions.
Each function accepts a numpy float array and returns an array of the same
length, with NaN for bars where there is insufficient history.
"""
from __future__ import annotations
import numpy as np

# Live/snapshot metric types resolved from a market context (see
# strategies/market_context.py), not from the price series. Kept as a literal
# here so this module stays dependency-free; must match market_context.
_CONTEXT_TYPES = frozenset({
    "FUND_PE", "FUND_PEG", "FUND_EPSGROWTH", "FUND_NETMARGIN", "FUND_GROSSMARGIN",
    "FUND_DEBTEQUITY", "FUND_DIVYIELD", "FUND_PB", "FUND_CURRENTRATIO", "FUND_BETA",
    "VOL_RELATIVE", "VOL_DOLLAR",
    "OPT_IV", "OPT_HV", "OPT_IVHV", "OPT_PUTCALL", "OPT_IMPLIEDMOVE",
    "OPT_DELTA", "OPT_GAMMA", "OPT_THETA", "OPT_VEGA",
    "FLOW_HORMUZ", "FLOW_SUEZ", "FLOW_PANAMA", "FLOW_MALACCA",
})

# Greeks are computed per-condition at a chosen strike level (not a single baked
# value), so get_indicator intercepts them before the constant-context path and
# derives them from the raw snapshot inputs (_OPT_SPOT/_OPT_IV/_OPT_DTE).
_GREEK_TYPES = frozenset({"OPT_DELTA", "OPT_GAMMA", "OPT_THETA", "OPT_VEGA"})
_GREEK_FIELD = {"OPT_DELTA": "delta", "OPT_GAMMA": "gamma", "OPT_THETA": "theta", "OPT_VEGA": "vega"}


def sma(prices: np.ndarray, period: int) -> np.ndarray:
    n = len(prices)
    result = np.full(n, np.nan)
    if period < 1 or period > n:
        return result
    cs = np.cumsum(np.insert(prices.astype(float), 0, 0.0))
    result[period - 1:] = (cs[period:] - cs[:n - period + 1]) / period
    return result


def ema(prices: np.ndarray, period: int) -> np.ndarray:
    n = len(prices)
    result = np.full(n, np.nan)
    if period < 1 or period > n:
        return result
    k = 2.0 / (period + 1)
    result[period - 1] = float(np.mean(prices[:period]))
    for i in range(period, n):
        result[i] = prices[i] * k + result[i - 1] * (1.0 - k)
    return result


def rsi(prices: np.ndarray, period: int = 14) -> np.ndarray:
    n = len(prices)
    result = np.full(n, np.nan)
    if n <= period:
        return result
    d = np.diff(prices.astype(float))
    gains  = np.where(d > 0, d, 0.0)
    losses = np.where(d < 0, -d, 0.0)
    ag = float(np.mean(gains[:period]))
    al = float(np.mean(losses[:period]))
    rs = ag / al if al != 0 else 1e9
    result[period] = 100.0 - 100.0 / (1.0 + rs)
    for i in range(period + 1, n):
        ag = (ag * (period - 1) + gains[i - 1]) / period
        al = (al * (period - 1) + losses[i - 1]) / period
        rs = ag / al if al != 0 else 1e9
        result[i] = 100.0 - 100.0 / (1.0 + rs)
    return result


def macd(prices: np.ndarray, fast: int = 12, slow: int = 26,
         signal_period: int = 9) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Returns (macd_line, signal_line, histogram). NaN during warmup."""
    ef = ema(prices, fast)
    es = ema(prices, slow)
    n  = len(prices)
    ml = np.full(n, np.nan)
    sl = np.full(n, np.nan)

    valid = ~(np.isnan(ef) | np.isnan(es))
    ml[valid] = ef[valid] - es[valid]

    first = int(np.argmax(valid)) if valid.any() else n
    if first >= n:
        return ml, sl, ml - sl

    ml_sub   = ml[first:]
    ml_clean = np.where(np.isnan(ml_sub), 0.0, ml_sub)
    sl_sub   = ema(ml_clean, signal_period)
    warmup   = signal_period - 1
    sl_sub[:warmup] = np.nan
    sl[first:] = sl_sub

    hist = np.full(n, np.nan)
    both = ~(np.isnan(ml) | np.isnan(sl))
    hist[both] = ml[both] - sl[both]
    return ml, sl, hist


def bollinger(prices: np.ndarray, period: int = 20,
              std_dev: float = 2.0) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Returns (upper, mid, lower)."""
    mid = sma(prices, period)
    p   = prices.astype(float)
    rolling_std = np.full(len(p), np.nan)
    for i in range(period - 1, len(p)):
        rolling_std[i] = float(np.std(p[i - period + 1:i + 1], ddof=1))
    upper = mid + std_dev * rolling_std
    lower = mid - std_dev * rolling_std
    return upper, mid, lower


def atr(prices: np.ndarray, period: int = 14) -> np.ndarray:
    """Close-to-close ATR proxy (no high/low data available here)."""
    n = len(prices)
    result = np.full(n, np.nan)
    if n <= period:
        return result
    tr = np.abs(np.diff(prices.astype(float)))
    result[period] = float(np.mean(tr[:period]))
    for i in range(period + 1, n):
        result[i] = (result[i - 1] * (period - 1) + tr[i - 1]) / period
    return result


def momentum(prices: np.ndarray, period: int = 126) -> np.ndarray:
    """Rate of change: price[i]/price[i-period] - 1."""
    n = len(prices)
    result = np.full(n, np.nan)
    p = prices.astype(float)
    for i in range(period, n):
        if p[i - period] != 0:
            result[i] = p[i] / p[i - period] - 1.0
    return result


def pct_below_high(prices: np.ndarray, period: int = 20) -> np.ndarray:
    """Percent below the rolling N-bar high, as a positive percentage (20.0 =
    20% below the high; 0 = at the high). period counts in bars (trading days
    for daily data), so "1m" ≈ 21, "1w" ≈ 5, matching the rest of the engine's
    bar-count convention (SMA/RSI/etc)."""
    n = len(prices)
    result = np.full(n, np.nan)
    p = prices.astype(float)
    for i in range(period - 1, n):
        window_high = float(np.max(p[i - period + 1:i + 1]))
        if window_high > 0:
            result[i] = (window_high - p[i]) / window_high * 100.0
    return result


def pct_above_low(prices: np.ndarray, period: int = 20) -> np.ndarray:
    """Percent above the rolling N-bar low, as a positive percentage (20.0 =
    20% above the low; 0 = at the low)."""
    n = len(prices)
    result = np.full(n, np.nan)
    p = prices.astype(float)
    for i in range(period - 1, n):
        window_low = float(np.min(p[i - period + 1:i + 1]))
        if window_low > 0:
            result[i] = (p[i] - window_low) / window_low * 100.0
    return result


def get_indicator(ind: dict, prices: np.ndarray, context: dict | None = None) -> np.ndarray:
    """Dispatch an IndicatorRef dict to the appropriate function.

    `context` carries resolved live/snapshot metrics (fundamentals, liquidity);
    those types return a constant series at the current value (NaN when the metric
    is unavailable, so the condition never fires)."""
    t = ind.get("type", "PRICE")
    if t in _GREEK_TYPES:
        # Leveled greek: computed per-condition at strike = level × spot for the
        # chosen call/put, so it isn't pinned to ~0.5 ATM delta. Raw inputs
        # (spot/IV/DTE) come from the live snapshot via market_context.
        ctx = context or {}
        spot, iv, dte = ctx.get("_OPT_SPOT"), ctx.get("_OPT_IV"), ctx.get("_OPT_DTE")
        if not (isinstance(spot, (int, float)) and spot > 0
                and isinstance(iv, (int, float)) and iv > 0
                and isinstance(dte, (int, float)) and dte > 0):
            return np.full(len(prices), float("nan"), dtype=float)
        level = float(ind.get("level", 1.0)) or 1.0
        opt_type = "put" if str(ind.get("opt_type", "call")).lower().startswith("p") else "call"
        from math_engine import bs_greeks
        g = bs_greeks(float(spot), float(spot) * level, float(dte), 4.0, float(iv), opt_type)
        return np.full(len(prices), float(g[_GREEK_FIELD[t]]), dtype=float)
    if t in _CONTEXT_TYPES:
        val = (context or {}).get(t, float("nan"))
        return np.full(len(prices), float(val), dtype=float)
    if t == "PRICE":       return prices.astype(float)
    if t == "RSI":         return rsi(prices, int(ind.get("period", 14)))
    if t == "SMA":         return sma(prices, int(ind.get("period", 50)))
    if t == "EMA":         return ema(prices, int(ind.get("period", 20)))
    if t in ("MACD_LINE", "MACD_SIGNAL"):
        ml, sl, _ = macd(prices, int(ind.get("fast", 12)),
                         int(ind.get("slow", 26)), int(ind.get("signal_period", 9)))
        return ml if t == "MACD_LINE" else sl
    if t == "BB_UPPER":    return bollinger(prices, int(ind.get("period", 20)), float(ind.get("std", 2.0)))[0]
    if t == "BB_MID":      return bollinger(prices, int(ind.get("period", 20)), float(ind.get("std", 2.0)))[1]
    if t == "BB_LOWER":    return bollinger(prices, int(ind.get("period", 20)), float(ind.get("std", 2.0)))[2]
    if t == "ATR":         return atr(prices, int(ind.get("period", 14)))
    if t == "MOMENTUM":    return momentum(prices, int(ind.get("period", 126)))
    # Percent change over N bars, expressed as a percentage (5.0 = +5%), so a
    # rule can compare it to a plain number ("% change 20d > 5").
    if t == "PCT_CHANGE":  return momentum(prices, int(ind.get("period", 20))) * 100.0
    if t == "PCT_BELOW_HIGH": return pct_below_high(prices, int(ind.get("period", 20)))
    if t == "PCT_ABOVE_LOW":  return pct_above_low(prices, int(ind.get("period", 20)))
    return prices.astype(float)


def warmup_bars(ind: dict) -> int:
    """Minimum bars needed before this indicator produces a valid value."""
    t = ind.get("type", "PRICE")
    if t in _CONTEXT_TYPES:                  return 1
    if t == "PRICE":                         return 1
    if t == "RSI":                           return int(ind.get("period", 14)) + 2
    if t in ("SMA", "BB_UPPER", "BB_MID", "BB_LOWER"): return int(ind.get("period", 20))
    if t == "EMA":                           return int(ind.get("period", 20))
    if t in ("MACD_LINE", "MACD_SIGNAL"):
        return int(ind.get("slow", 26)) + int(ind.get("signal_period", 9)) + 2
    if t == "ATR":                           return int(ind.get("period", 14)) + 2
    if t == "MOMENTUM":                      return int(ind.get("period", 126)) + 1
    if t == "PCT_CHANGE":                    return int(ind.get("period", 20)) + 1
    if t in ("PCT_BELOW_HIGH", "PCT_ABOVE_LOW"): return int(ind.get("period", 20))
    return 30
