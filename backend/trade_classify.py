"""What kind of trade it was, read off the tape before anything is asked of a model.

Given a ticker and two dates, a language model will tell you a trade was an
earnings beat whether or not earnings happened. Everything here is measured
from price history the analysis already fetched, so the label is a fact about
the account rather than a plausible story about the market.

The one signal that costs a call is whether earnings landed inside the window.
It degrades to unknown rather than to a guess.
"""
from __future__ import annotations

import logging
from datetime import date, timedelta

import numpy as np
import pandas as pd

from trade_analytics import parse_option_symbol

logger = logging.getLogger(__name__)

# Bought inside this many sessions of a symbol's first ever print, and it is a
# new issue rather than a name that happened to be young.
_IPO_WINDOW_DAYS = 10
_NEW_LISTING_DAYS = 60
_DIP_DRAWDOWN_PCT = -15.0
_ONE_DAY_SHARE = 0.5
_LOOKBACK_DAYS = 120
_MAX_EARNINGS_LOOKUPS = 8


def earnings_dates(symbol: str) -> list[date] | None:
    """Reported earnings dates for one name, or None when the lookup fails.

    None and [] mean different things here and the labeller relies on it: an
    empty list says earnings did not land in the window, None says nobody
    knows, and only the first of those may be used to rule an earnings play out.
    """
    import cache
    try:
        import yfinance as yf
        frame = cache._run_yf(f"earnings_dates {symbol}",
                              lambda: yf.Ticker(symbol).get_earnings_dates(limit=40))
    except Exception as e:                          # noqa: BLE001 — one name must not sink the tile
        logger.info("trade classify: no earnings dates for %s (%s)", symbol, e)
        return None
    if frame is None or getattr(frame, "empty", True):
        return None
    try:
        idx = pd.to_datetime(frame.index).tz_localize(None)
        return sorted({d.date() for d in idx})
    except Exception:                               # noqa: BLE001
        return None


def _underlying(trade: dict) -> str:
    if trade.get("isOption"):
        spec = parse_option_symbol(trade["symbol"])
        if spec:
            return spec["underlying"]
    return trade["symbol"]


def features(trade: dict, prices: pd.DataFrame,
             earnings: list[date] | None) -> dict:
    """Everything about the trade that the price history already knows."""
    symbol = _underlying(trade)
    opened = date.fromisoformat(trade["opened"])
    closed = date.fromisoformat(trade["closed"]) if trade.get("closed") else None
    out: dict = {
        "heldDays": trade.get("heldDays", 0),
        "fills": trade.get("fills", 0),
        "open": bool(trade.get("open")),
        "isOption": bool(trade.get("isOption")),
        "daysSinceListing": None,
        "bestDayShare": None,
        "entryDrawdownPct": None,
        "exitPlacement": None,
        "earningsInWindow": None,
    }
    edge = None
    if trade.get("benchmarkPct") is not None:
        edge = round(trade["returnPct"] - trade["benchmarkPct"], 2)
    out["edgePts"] = edge

    if symbol not in prices.columns:
        return out
    series = prices[symbol].dropna()
    if series.empty:
        return out

    listed = series.index[0].date()
    # Only meaningful when the history actually begins after the frame does.
    # A name that already traded before the account opened has no listing date
    # we can see, and calling day one of our window its IPO would be a fiction.
    if listed > prices.index[0].date():
        out["daysSinceListing"] = (opened - listed).days

    end = closed or series.index[-1].date()
    window = series.loc[pd.Timestamp(opened):pd.Timestamp(end)]
    if len(window) >= 2:
        steps = np.diff(np.log(window.to_numpy()))
        total = float(steps.sum())
        if total > 0:
            out["bestDayShare"] = round(float(steps.max()) / total, 3)
        low, high = float(window.min()), float(window.max())
        if high > low:
            out["exitPlacement"] = round((float(window.iloc[-1]) - low) / (high - low), 3)

    before = series.loc[pd.Timestamp(opened) - timedelta(days=_LOOKBACK_DAYS):pd.Timestamp(opened)]
    if len(before) >= 20:
        peak = float(before.max())
        if peak > 0:
            out["entryDrawdownPct"] = round((float(before.iloc[-1]) / peak - 1) * 100, 2)

    if earnings is not None:
        out["earningsInWindow"] = sum(1 for d in earnings if opened <= d <= end)
    return out


def label_for(f: dict) -> tuple[str, list[str]]:
    """One name for the trade, then whatever else is true about it.

    Ordered by how much each fact explains. A same-day round trip in a stock
    that listed that morning is an IPO pop first and a day trade second, and
    saying it the other way round buries the part that matters.
    """
    since = f.get("daysSinceListing")
    held = f.get("heldDays") or 0

    if since is not None and 0 <= since <= _IPO_WINDOW_DAYS:
        primary = "IPO pop" if held <= 5 else "New issue"
    elif since is not None and 0 <= since <= _NEW_LISTING_DAYS:
        primary = "New listing"
    elif held == 0:
        primary = "Day trade"
    elif f.get("earningsInWindow") and held <= 21:
        primary = "Earnings play"
    elif (f.get("bestDayShare") or 0) >= _ONE_DAY_SHARE:
        primary = "Single-day move"
    elif (f.get("entryDrawdownPct") is not None
          and f["entryDrawdownPct"] <= _DIP_DRAWDOWN_PCT):
        primary = "Dip buy"
    elif held >= 365:
        primary = "Long hold"
    elif held >= 90:
        primary = "Position trade"
    elif held >= 10:
        primary = "Swing"
    else:
        primary = "Short swing"

    tags: list[str] = []
    if f.get("isOption"):
        tags.append("option")
    if primary != "Day trade" and held == 0:
        tags.append("same day")
    if (f.get("fills") or 0) > 8:
        tags.append("averaged in")
    if primary not in ("Earnings play",) and f.get("earningsInWindow"):
        tags.append("held through earnings")
    if (f.get("bestDayShare") or 0) >= _ONE_DAY_SHARE and primary != "Single-day move":
        tags.append("one day carried it")
    if (f.get("entryDrawdownPct") is not None
            and f["entryDrawdownPct"] <= _DIP_DRAWDOWN_PCT and primary != "Dip buy"):
        tags.append("bought the dip")
    if f.get("exitPlacement") is not None and not f.get("open"):
        if f["exitPlacement"] >= 0.9:
            tags.append("sold near the high")
        elif f["exitPlacement"] <= 0.35:
            tags.append("gave back the top")
    if f.get("edgePts") is not None:
        tags.append("beat the index" if f["edgePts"] >= 0 else "trailed the index")
    if f.get("open"):
        tags.append("still open")
    return primary, tags


def classify(trades: list[dict], prices: pd.DataFrame) -> list[dict]:
    """Label every trade in place and hand back the same list."""
    if not trades:
        return trades
    wanted = []
    for t in trades[:_MAX_EARNINGS_LOOKUPS]:
        sym = _underlying(t)
        if sym not in wanted and sym in prices.columns:
            wanted.append(sym)
    calendar = {sym: earnings_dates(sym) for sym in wanted}

    for t in trades:
        f = features(t, prices, calendar.get(_underlying(t)))
        primary, tags = label_for(f)
        t["label"] = primary
        t["tags"] = tags
        t["signals"] = f
    return trades
