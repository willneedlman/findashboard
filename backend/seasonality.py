"""Calendar patterns in a price series.

Pure arithmetic on history the terminal already downloads. The whole value of a
seasonality view is in the honesty of its denominators, so every figure carries
the sample it came from: an average January built on nine observations is a
different claim from one built on forty, and the panel has to say which.

No significance test is reported and none is implied. With ten to forty
observations per bucket, a monthly seasonal is descriptive, and dressing it up
with a p-value would give it authority the sample cannot support.
"""
from __future__ import annotations

import datetime as _dt

import numpy as np
import pandas as pd

from cache import get_download, cached

MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri"]


def _bucket(returns: pd.Series, label: str) -> dict:
    """Mean, median, hit rate and spread for one calendar bucket."""
    clean = returns.dropna()
    n = len(clean)
    if n == 0:
        return {"label": label, "n": 0, "mean_pct": None, "median_pct": None,
                "hit_rate_pct": None, "best_pct": None, "worst_pct": None}
    return {
        "label": label,
        "n": n,
        "mean_pct": round(float(clean.mean()) * 100, 2),
        "median_pct": round(float(clean.median()) * 100, 2),
        "hit_rate_pct": round(float((clean > 0).sum()) / n * 100, 1),
        "best_pct": round(float(clean.max()) * 100, 2),
        "worst_pct": round(float(clean.min()) * 100, 2),
    }


@cached(ttl=6 * 3600, maxsize=128, persist=True)
def seasonality(ticker: str, years: int = 20) -> dict:
    end = _dt.date.today()
    start = end - _dt.timedelta(days=int(years) * 366 + 10)
    frame = get_download((ticker,), start.isoformat(), (end + _dt.timedelta(days=1)).isoformat(),
                         "1d", cache_ttl=6 * 3600)
    closes = frame.get("Close") if frame is not None and not frame.empty else None
    if closes is None:
        return {"available": False, "reason": "No price history for this symbol."}
    if isinstance(closes, pd.DataFrame):
        if ticker not in closes.columns:
            return {"available": False, "reason": "No price history for this symbol."}
        closes = closes[ticker]
    px = closes.dropna()
    if len(px) < 400:
        return {"available": False, "reason": "Needs at least two years of history to show a seasonal."}

    daily = px.pct_change().dropna()

    # Month buckets are month-end to month-end, not an average of daily moves:
    # a monthly seasonal is about the move you would have captured holding the
    # month, and averaging dailies understates it by dropping compounding.
    monthly = px.resample("ME").last().pct_change().dropna()
    months = [_bucket(monthly[monthly.index.month == i + 1], name) for i, name in enumerate(MONTHS)]

    weekdays = [_bucket(daily[daily.index.dayofweek == i], name) for i, name in enumerate(WEEKDAYS)]

    # Turn of the month: the last session of a month and the first three of the
    # next. A long-documented pattern and cheap to check against this series.
    is_tom = pd.Series(False, index=daily.index)
    by_month = daily.groupby([daily.index.year, daily.index.month])
    for _, group in by_month:
        is_tom.loc[group.index[:3]] = True
        is_tom.loc[group.index[-1:]] = True
    turn = {
        "turn_of_month": _bucket(daily[is_tom], "Turn of month"),
        "rest_of_month": _bucket(daily[~is_tom], "Rest of month"),
    }

    # Year-by-year monthly grid, so a reader can see whether an average is a
    # consistent pattern or one enormous year dragging the mean.
    grid: dict[int, dict[str, float | None]] = {}
    for stamp, value in monthly.items():
        grid.setdefault(stamp.year, {})[MONTHS[stamp.month - 1]] = round(float(value) * 100, 2)
    years_rows = [{"year": year, **cells} for year, cells in sorted(grid.items(), reverse=True)]

    ranked = [m for m in months if m["n"] >= 3]
    ranked.sort(key=lambda m: m["mean_pct"] or 0)

    return {
        "available": True,
        "ticker": ticker,
        "first_date": px.index[0].date().isoformat(),
        "last_date": px.index[-1].date().isoformat(),
        "sessions": int(len(px)),
        "years_covered": round(len(px) / 252, 1),
        "months": months,
        "weekdays": weekdays,
        "turn_of_month": turn,
        "year_grid": years_rows,
        "best_month": ranked[-1] if ranked else None,
        "worst_month": ranked[0] if ranked else None,
        # Whether the current month has historically been kind, stated with its
        # own sample so it cannot be read as a forecast.
        "current_month": months[_dt.date.today().month - 1],
    }
