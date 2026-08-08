"""Market breadth from index constituents.

Breadth answers a question the index level cannot: is the move carried by the
whole market or by five names. An index at a high with 40% of its members below
their 200-day average is a different market from the same high with 80% above.

Everything here is computed from the member lists in data/index_members.json
and one batched daily download, so there is no new feed and no new vendor.

The A/D line is cumulative net advancers, rebased to zero at the window start.
Its level is meaningless in isolation; its divergence from price is the signal,
which is why the payload carries the index series alongside it.
"""
from __future__ import annotations

import datetime as _dt

import numpy as np
import pandas as pd

from cache import get_download, cached
from index_profile import _load

# Enough history to compute a 200-day average on the first plotted bar, plus a
# margin for holidays and half-days.
_LOOKBACK_DAYS = 420
_WINDOW_SESSIONS = 126        # roughly six months of plotted breadth


def _closes(symbols: list[str]) -> pd.DataFrame | None:
    end = (_dt.date.today() + _dt.timedelta(days=1)).isoformat()
    start = (_dt.date.today() - _dt.timedelta(days=_LOOKBACK_DAYS)).isoformat()
    frame = get_download(tuple(symbols), start, end, "1d", cache_ttl=900)
    if frame is None or frame.empty:
        return None
    closes = frame.get("Close")
    if closes is None:
        return None
    if isinstance(closes, pd.Series):
        closes = closes.to_frame(name=symbols[0])
    # A member Yahoo never priced would otherwise count as unchanged on every
    # bar and flatten the whole measure.
    return closes.dropna(axis=1, how="all")


def _series(frame: pd.DataFrame, index_symbol: str) -> dict:
    """The plotted history: A/D line, participation, and the index beside it."""
    members = frame.drop(columns=[c for c in (index_symbol,) if c in frame.columns])
    if members.empty:
        return {}

    daily = members.diff()
    advancing = (daily > 0).sum(axis=1)
    declining = (daily < 0).sum(axis=1)
    net = (advancing - declining).astype(float)

    above50 = (members > members.rolling(50).mean()).sum(axis=1)
    above200 = (members > members.rolling(200).mean()).sum(axis=1)
    priced = members.notna().sum(axis=1).replace(0, np.nan)

    # A 52-week extreme needs a full year behind it, so the rolling windows are
    # sized in sessions rather than calendar days.
    high52 = (members >= members.rolling(252, min_periods=60).max()).sum(axis=1)
    low52 = (members <= members.rolling(252, min_periods=60).min()).sum(axis=1)

    tail = members.index[-_WINDOW_SESSIONS:]
    ad_line = net.loc[tail].cumsum()

    index_series = frame[index_symbol].loc[tail] if index_symbol in frame.columns else None
    points = []
    for stamp in tail:
        row = {
            "date": stamp.date().isoformat(),
            "ad_line": round(float(ad_line.loc[stamp]), 1),
            "net_advancers": int(net.loc[stamp]) if pd.notna(net.loc[stamp]) else None,
            "pct_above_50": _pct_of(above50, priced, stamp),
            "pct_above_200": _pct_of(above200, priced, stamp),
            "new_highs": int(high52.loc[stamp]),
            "new_lows": int(low52.loc[stamp]),
        }
        if index_series is not None and pd.notna(index_series.loc[stamp]):
            row["index"] = round(float(index_series.loc[stamp]), 2)
        points.append(row)
    return {"points": points}


def _pct_of(count: pd.Series, priced: pd.Series, stamp) -> float | None:
    denom = priced.loc[stamp]
    if pd.isna(denom) or denom == 0:
        return None
    return round(float(count.loc[stamp]) / float(denom) * 100, 1)


@cached(ttl=1800, maxsize=32, persist=True)
def breadth(index_symbol: str, schema: int = 1) -> dict:
    entry = _load().get("indices", {}).get(index_symbol)
    if not entry or entry.get("unavailable") or not entry.get("members"):
        return {"available": False,
                "reason": (entry or {}).get("unavailable")
                or "Breadth needs a member list, and none is tracked for this index."}

    symbols = [m["ticker"] for m in entry["members"]]
    frame = _closes(symbols + [index_symbol])
    if frame is None or frame.shape[1] < 5:
        return {"available": False, "reason": "Constituent prices are unavailable right now."}

    history = _series(frame, index_symbol)
    points = history.get("points") or []
    if not points:
        return {"available": False, "reason": "Not enough overlapping history to compute breadth."}

    latest = points[-1]
    prior = points[-2] if len(points) > 1 else latest
    members = frame.drop(columns=[c for c in (index_symbol,) if c in frame.columns])
    last_change = members.diff().iloc[-1]
    advancing = int((last_change > 0).sum())
    declining = int((last_change < 0).sum())
    unchanged = int((last_change == 0).sum())

    return {
        "available": True,
        "index": index_symbol,
        "as_of": latest["date"],
        "coverage": {"listed": len(entry["members"]), "priced": int(members.notna().iloc[-1].sum())},
        "today": {
            "advancing": advancing,
            "declining": declining,
            "unchanged": unchanged,
            # Undefined rather than infinite on a day nothing fell.
            "ad_ratio": round(advancing / declining, 2) if declining else None,
            "new_highs": latest["new_highs"],
            "new_lows": latest["new_lows"],
        },
        "participation": {
            "pct_above_50": latest["pct_above_50"],
            "pct_above_200": latest["pct_above_200"],
            "pct_above_50_change": _delta(latest["pct_above_50"], prior["pct_above_50"]),
            "pct_above_200_change": _delta(latest["pct_above_200"], prior["pct_above_200"]),
        },
        "divergence": _divergence(points),
        "history": points,
    }


def _delta(now: float | None, before: float | None) -> float | None:
    if now is None or before is None:
        return None
    return round(now - before, 1)


def _divergence(points: list[dict]) -> dict | None:
    """Index and A/D line pulling in opposite directions over the last month.

    This is the whole reason to plot breadth: a new index high that fewer names
    are participating in. Stated as a plain comparison of two one-month changes,
    not a score, so the reader can check it against the chart directly.
    """
    window = [p for p in points[-21:] if "index" in p]
    if len(window) < 10:
        return None
    index_change = window[-1]["index"] - window[0]["index"]
    ad_change = window[-1]["ad_line"] - window[0]["ad_line"]
    if index_change > 0 and ad_change < 0:
        state = "narrowing"
    elif index_change < 0 and ad_change > 0:
        state = "broadening"
    else:
        state = "aligned"
    return {
        "state": state,
        "sessions": len(window),
        "index_change_pct": round(index_change / window[0]["index"] * 100, 2) if window[0]["index"] else None,
        "ad_line_change": round(ad_change, 1),
    }


def tracked_indices() -> list[dict]:
    """Indices with a member list, so the picker only offers what will render."""
    out = []
    for symbol, entry in _load().get("indices", {}).items():
        if entry.get("members"):
            out.append({"symbol": symbol, "members": len(entry["members"])})
    return sorted(out, key=lambda item: -item["members"])
