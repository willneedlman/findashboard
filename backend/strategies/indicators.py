"""
Vectorised indicator functions.
Each function accepts a numpy float array and returns an array of the same
length, with NaN for bars where there is insufficient history.
"""
from __future__ import annotations
import numpy as np


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


def get_indicator(ind: dict, prices: np.ndarray) -> np.ndarray:
    """Dispatch an IndicatorRef dict to the appropriate function."""
    t = ind.get("type", "PRICE")
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
    return prices.astype(float)


def warmup_bars(ind: dict) -> int:
    """Minimum bars needed before this indicator produces a valid value."""
    t = ind.get("type", "PRICE")
    if t == "PRICE":                         return 1
    if t == "RSI":                           return int(ind.get("period", 14)) + 2
    if t in ("SMA", "BB_UPPER", "BB_MID", "BB_LOWER"): return int(ind.get("period", 20))
    if t == "EMA":                           return int(ind.get("period", 20))
    if t in ("MACD_LINE", "MACD_SIGNAL"):
        return int(ind.get("slow", 26)) + int(ind.get("signal_period", 9)) + 2
    if t == "ATR":                           return int(ind.get("period", 14)) + 2
    if t == "MOMENTUM":                      return int(ind.get("period", 126)) + 1
    return 30
