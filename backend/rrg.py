"""Relative Rotation Graph coordinates.

An RRG plots two numbers per instrument against a benchmark: how strong it is
relative to that benchmark (RS-Ratio, the x axis) and whether that strength is
building or fading (RS-Momentum, the y axis). Both are centred on 100, which
splits the plane into four quadrants a reader can name:

    leading    strong and still strengthening   (x > 100, y > 100)
    weakening  strong but losing steam          (x > 100, y < 100)
    lagging    weak and still weakening         (x < 100, y < 100)
    improving  weak but turning up              (x < 100, y > 100)

Rotation is normally clockwise, which is why the tail matters more than the
dot: a name in "weakening" that arrived from "leading" is a different trade
from one that arrived from "lagging".

The published RRG is proprietary in its exact smoothing. This uses the standard
public construction: smooth the relative-strength line, normalise it, take the
multi-week change of that, normalise again, and smooth the result. Each pass
earns its place — without them the weekly coordinates swing several points at
random and eleven overlapping tails read as a mesh.
"""
from __future__ import annotations

import datetime as _dt

import numpy as np
import pandas as pd

from cache import get_download, cached

_QUADRANTS = ("lagging", "weakening", "leading", "improving")


# The published construction smooths at three points, and skipping that is the
# difference between readable arcs and a hairball. Momentum taken as the
# one-week change in an unsmoothed z-score is almost pure noise: the sectors
# were swinging two to four points a week and eleven of those overlap into a
# mesh.
_SMOOTH_WEEKS = 10      # EMA on the relative-strength line before normalising
_NORM_WEEKS = 52        # baseline for the z-score, one year of weekly bars
_MOMENTUM_WEEKS = 4     # lookback for the rate of change of the ratio
_TRAIL_SMOOTH = 3       # final pass, so a single week cannot kink the tail


def _normalise(series: pd.Series, window: int) -> pd.Series:
    """Centre a series on 100 by its own rolling mean and standard deviation.

    A shorter window makes the baseline itself move every bar, so a sector can
    drift across a quadrant boundary without its relative performance changing
    at all. A year of weekly bars keeps the reference steady.
    """
    mean = series.rolling(window, min_periods=window // 2).mean()
    std = series.rolling(window, min_periods=window // 2).std()
    return 100 + (series - mean) / std.replace(0, np.nan)


def quadrant(x: float, y: float) -> str:
    if x >= 100:
        return "leading" if y >= 100 else "weakening"
    return "improving" if y >= 100 else "lagging"


# Bump on any change to the coordinates. The persisted tier outlives a deploy,
# so a maths fix otherwise ships to an image that keeps serving the old shape.
_SCHEMA = 2


def rrg(tickers: tuple[str, ...], benchmark: str = "SPY", tail: int = 8) -> dict:
    return _rrg(tickers, benchmark, tail, _SCHEMA)


@cached(ttl=3600, maxsize=32, persist=True)
def _rrg(tickers: tuple[str, ...], benchmark: str, tail: int, schema: int) -> dict:
    """Weekly RRG coordinates with a `tail`-week trail per instrument."""
    end = _dt.date.today()
    # A year of baseline, the momentum lookback, the smoothing run-up and the
    # tail, with margin for holidays.
    start = end - _dt.timedelta(weeks=(_NORM_WEEKS + _MOMENTUM_WEEKS + _SMOOTH_WEEKS + tail + 20))
    symbols = tuple(dict.fromkeys(list(tickers) + [benchmark]))
    frame = get_download(symbols, start.isoformat(), (end + _dt.timedelta(days=1)).isoformat(),
                         "1d", cache_ttl=3600)
    closes = frame.get("Close") if frame is not None and not frame.empty else None
    if closes is None:
        return {"available": False, "reason": "Price history is unavailable right now."}
    if isinstance(closes, pd.Series):
        closes = closes.to_frame(name=symbols[0])
    if benchmark not in closes.columns:
        return {"available": False, "reason": f"No history for the benchmark {benchmark}."}

    weekly = closes.resample("W-FRI").last().ffill()
    bench = weekly[benchmark]
    if bench.dropna().shape[0] < _NORM_WEEKS // 2 + _MOMENTUM_WEEKS + tail:
        return {"available": False, "reason": "Not enough weekly history to build the ratio."}

    series: list[dict] = []
    for symbol in tickers:
        if symbol not in weekly.columns:
            continue
        rel = (weekly[symbol] / bench).dropna()
        if len(rel) < _NORM_WEEKS // 2 + _MOMENTUM_WEEKS + tail:
            continue
        # Smooth the relative line, normalise it, then smooth again. Each pass
        # is in the published recipe and each one matters here.
        smoothed = rel.ewm(span=_SMOOTH_WEEKS, adjust=False).mean()
        ratio = _normalise(smoothed, _NORM_WEEKS).rolling(_TRAIL_SMOOTH, min_periods=1).mean()
        # Momentum is the multi-week change in the ratio, not a one-week
        # difference. The ratio sits near 100 by construction, so a difference
        # in ratio points is the meaningful quantity, not a percentage of it.
        momentum = _normalise(ratio.diff(_MOMENTUM_WEEKS), _NORM_WEEKS) \
            .rolling(_TRAIL_SMOOTH, min_periods=1).mean()
        pts = pd.concat([ratio, momentum], axis=1, keys=["x", "y"]).dropna()
        if len(pts) < 2:
            continue
        trail = pts.tail(tail)
        points = [
            {"date": stamp.date().isoformat(), "x": round(float(row.x), 2), "y": round(float(row.y), 2)}
            for stamp, row in trail.iterrows()
        ]
        last = points[-1]
        first = points[0]
        series.append({
            "ticker": symbol,
            "x": last["x"],
            "y": last["y"],
            "quadrant": quadrant(last["x"], last["y"]),
            "from_quadrant": quadrant(first["x"], first["y"]),
            "tail": points,
        })

    if not series:
        return {"available": False, "reason": "Not enough overlapping history for these symbols."}

    return {
        "available": True,
        "benchmark": benchmark,
        "as_of": weekly.index[-1].date().isoformat(),
        "tail_weeks": tail,
        "window_weeks": _NORM_WEEKS,
        "series": sorted(series, key=lambda s: -s["x"]),
        "counts": {q: sum(1 for s in series if s["quadrant"] == q) for q in _QUADRANTS},
    }
