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
public construction — normalise the relative-strength line, then take its rate
of change and normalise that the same way — and says so rather than implying it
reproduces the commercial product tick for tick.
"""
from __future__ import annotations

import datetime as _dt

import numpy as np
import pandas as pd

from cache import get_download, cached

_QUADRANTS = ("lagging", "weakening", "leading", "improving")


def _normalise(series: pd.Series, window: int) -> pd.Series:
    """Centre a series on 100 by its own rolling mean and standard deviation.

    Deviation in standard deviations, scaled to 1 point of index per 0.1 sigma,
    which is the convention that makes the quadrant boundaries readable.
    """
    mean = series.rolling(window).mean()
    std = series.rolling(window).std()
    z = (series - mean) / std.replace(0, np.nan)
    return 100 + z


def quadrant(x: float, y: float) -> str:
    if x >= 100:
        return "leading" if y >= 100 else "weakening"
    return "improving" if y >= 100 else "lagging"


@cached(ttl=3600, maxsize=32, persist=True)
def rrg(tickers: tuple[str, ...], benchmark: str = "SPY", tail: int = 8, window: int = 12) -> dict:
    """Weekly RRG coordinates with a `tail`-week trail per instrument."""
    end = _dt.date.today()
    # Enough weeks for two rolling windows plus the tail, in calendar days.
    start = end - _dt.timedelta(weeks=(window * 2 + tail + 12))
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
    if bench.dropna().shape[0] < window * 2 + tail:
        return {"available": False, "reason": "Not enough weekly history to build the ratio."}

    series: list[dict] = []
    for symbol in tickers:
        if symbol not in weekly.columns:
            continue
        rel = (weekly[symbol] / bench).dropna()
        if len(rel) < window * 2 + tail:
            continue
        ratio = _normalise(rel, window)
        # Momentum is the rate of change of the *normalised* ratio, normalised
        # again. Taking it off the raw relative line instead would let a
        # high-volatility sector dominate the y axis on noise alone.
        momentum = _normalise(ratio.pct_change(), window)
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
        "window_weeks": window,
        "series": sorted(series, key=lambda s: -s["x"]),
        "counts": {q: sum(1 for s in series if s["quadrant"] == q) for q in _QUADRANTS},
    }
