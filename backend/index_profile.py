"""Constituent and statistics profile for one row of the Global Markets board.

Two halves, deliberately independent:

`stats` is derived from the asset's own price history, so it works for every row
on the board — an index, a currency pair, a barrel of crude, a yield.

`constituents` needs a member list, which only exists for the indices in
data/index_members.json. Where there is no free published list (the Russell
2000, the Shanghai Composite) the payload says so in words rather than shipping
an empty table that reads like a loading failure.

Market caps are computed live as `shares x price`, not read from a stored cap:
the share count moves a few times a year, the price moves every second, and the
price is already in the batch download the member table needs anyway.
"""
from __future__ import annotations

import datetime as _dt
import json
import os

import numpy as np
import pandas as pd

from cache import get_download, cached

_DATA = os.path.join(os.path.dirname(os.path.abspath(__file__)), "data", "index_members.json")

# London quotes in pence, Johannesburg in cents. Treating GBp as GBP overstates
# every FTSE constituent by 100x, which is the kind of error that looks
# plausible on a single row and absurd on a total.
# Case matters: Yahoo writes the sub-unit in lower case ("GBp" is pence, "GBP"
# is pounds), and it is the only thing distinguishing them.
_SUBUNITS = {"GBp": 100.0, "ZAc": 100.0, "ILA": 100.0}


def _load() -> dict:
    try:
        with open(_DATA) as fh:
            return json.load(fh)
    except (OSError, ValueError):
        return {"indices": {}}


def _fx_symbol(currency: str) -> str | None:
    """Yahoo pair quoting USD per 1 unit of `currency`'s major unit."""
    cur = (currency or "").upper()
    if cur in ("USD", ""):
        return None
    if cur in ("GBP", "GBX"):
        return "GBPUSD=X"
    if cur in ("ZAC", "ZAR"):
        return "ZARUSD=X"
    return f"{cur}USD=X"


def _pct(a: float | None, b: float | None) -> float | None:
    if a is None or b in (None, 0):
        return None
    return round((a / b - 1.0) * 100.0, 2)


def _series_at_or_before(series: pd.Series, when: _dt.date) -> float | None:
    prior = series[series.index.date <= when]
    return float(prior.iloc[-1]) if len(prior) else None


# The benchmark travels with a readable name. "^GSPC" is a Yahoo symbol, and a
# label built by interpolating it puts the vendor's ticker in front of a reader
# who asked about the S&P 500.
_BENCHMARK_LABEL = "S&P 500"


def _relationship(asset: pd.Series, market: pd.Series, benchmark: str) -> dict | None:
    """Beta and correlation against the benchmark, corrected for the fact that
    most of the world does not trade while New York is open.

    A same-day comparison quietly assumes both markets saw the same news before
    they closed. Seoul closes at 06:00 UTC and New York at 21:00, so the KOSPI's
    Tuesday is a reaction to the S&P's Monday. Line the two up by calendar date
    and the measured link collapses: Korea reads 0.13 against the S&P, which
    would make one of the most cyclical markets on earth look independent of
    global risk appetite.

    Beta uses Scholes-Williams (1977), which regresses on the sum of the
    previous, current and next market return and so recovers the relationship
    however the sessions overlap. It reduces to ordinary beta where they
    already do: the correction moves the FTSE from 0.31 to 0.36 and the KOSPI
    from 0.52 to 2.02.

    Correlation cannot be summed the same way, so the lag with the strongest
    reading wins and the payload says which, rather than reporting a number
    that is only low because of a clock.
    """
    if len(asset) < 60 or market.var() <= 0:
        return None
    ln_a = np.log1p(asset.clip(lower=-0.99))
    ln_m = np.log1p(market.clip(lower=-0.99))
    mr3 = ln_m.shift(1) + ln_m + ln_m.shift(-1)
    ok = mr3.notna() & ln_a.notna()
    if ok.sum() < 30:
        return None
    denom = float(np.cov(ln_m[ok], mr3[ok])[0, 1])
    if not np.isfinite(denom) or abs(denom) < 1e-12:
        return None
    beta = float(np.cov(ln_a[ok], mr3[ok])[0, 1]) / denom

    # Lag 1 means "the asset today against the benchmark yesterday", which is
    # what an Asian close is actually responding to.
    scored = []
    for lag in (0, 1):
        value = float(asset.corr(market.shift(lag)))
        if np.isfinite(value):
            scored.append((lag, value))
    if not scored or not np.isfinite(beta):
        return None
    same = next((v for lag, v in scored if lag == 0), 0.0)
    best_lag, best = max(scored, key=lambda pair: abs(pair[1]))
    # Only move off the same-day reading when the offset is doing real work.
    if abs(best) - abs(same) < 0.05:
        best_lag, best = 0, same

    return {
        "benchmark": benchmark,
        "benchmark_label": _BENCHMARK_LABEL,
        "beta": round(beta, 2),
        "correlation": round(best, 2),
        "correlation_lag_days": best_lag,
        "session_offset": best_lag > 0,
    }


def asset_stats(ticker: str, benchmark: str = "^GSPC") -> dict:
    """Range, return ladder, realised risk, and the relationship to the S&P.

    All of it comes out of one five-year daily download, so the panel costs a
    single request no matter how many numbers it prints.
    """
    end = (_dt.date.today() + _dt.timedelta(days=1)).isoformat()
    start = (_dt.date.today() - _dt.timedelta(days=5 * 366)).isoformat()
    want = (ticker,) if ticker == benchmark else (ticker, benchmark)
    frame = get_download(want, start, end, "1d", cache_ttl=900)
    closes = frame.get("Close") if frame is not None and not frame.empty else None
    if closes is None:
        return {}
    if isinstance(closes, pd.Series):
        closes = closes.to_frame(name=ticker)
    if ticker not in closes.columns:
        return {}

    px = closes[ticker].dropna()
    if len(px) < 5:
        return {}
    last = float(px.iloc[-1])
    today = px.index[-1].date()

    windows = {"1w": 7, "1m": 31, "3m": 93, "6m": 183, "1y": 366, "3y": 1096, "5y": 1826}
    bases = {key: _series_at_or_before(px, today - _dt.timedelta(days=days))
             for key, days in windows.items()}
    bases["ytd"] = _series_at_or_before(px, _dt.date(today.year, 1, 1))
    returns = {key: _pct(last, base) for key, base in bases.items()}
    # A yield that goes 4.0 to 4.66 has not returned 16%. The caller renders
    # basis points off these instead, so both readings come from one payload.
    changes_abs = {key: (round(last - base, 4) if base is not None else None)
                   for key, base in bases.items()}

    year = px[px.index.date >= today - _dt.timedelta(days=366)]
    low, high = (float(year.min()), float(year.max())) if len(year) else (None, None)
    band = (high - low) if (high is not None and high > low) else None

    daily = px.pct_change().dropna()
    recent = daily.tail(30)
    vol30 = round(float(recent.std() * np.sqrt(252) * 100), 2) if len(recent) > 5 else None
    peak = year.cummax() if len(year) else None
    max_dd = round(float(((year / peak) - 1).min() * 100), 2) if peak is not None and len(year) else None

    vs = None
    if ticker != benchmark and benchmark in closes.columns:
        pair = pd.concat([px, closes[benchmark].dropna()], axis=1, keys=["a", "b"]).dropna()
        pair = pair.tail(253).pct_change().dropna()
        vs = _relationship(pair["a"], pair["b"], benchmark)

    return {
        "last": last,
        "as_of": today.isoformat(),
        "returns": returns,
        "changes_abs": changes_abs,
        "range_52w": {
            "low": low, "high": high,
            # Where the last price sits inside the year's band, 0 at the low.
            "position_pct": round((last - low) / band * 100, 1) if band else None,
            "from_high_pct": _pct(last, high),
            "from_low_pct": _pct(last, low),
        },
        "vol_30d": vol30,
        "max_drawdown_1y": max_dd,
        "vs_benchmark": vs,
    }


def _price_members(members: list[dict], currency: str | None) -> tuple[list[dict], float | None]:
    """Live price, day change and USD market cap for each member, from one
    batched download shared by the whole index."""
    symbols = [m["ticker"] for m in members]
    fx_sym = _fx_symbol(currency or "USD")
    end = (_dt.date.today() + _dt.timedelta(days=1)).isoformat()
    start = (_dt.date.today() - _dt.timedelta(days=12)).isoformat()
    frame = get_download(tuple(symbols + ([fx_sym] if fx_sym else [])), start, end, "1d", cache_ttl=300)
    closes = frame.get("Close") if frame is not None and not frame.empty else None
    if closes is None:
        return [], None
    if isinstance(closes, pd.Series):
        closes = closes.to_frame(name=symbols[0])

    fx = None
    if fx_sym and fx_sym in closes.columns:
        series = closes[fx_sym].dropna()
        if len(series):
            fx = float(series.iloc[-1])
    if not fx_sym:
        fx = 1.0
    # Pence and cents quote at a hundredth of the currency the pair prices.
    if fx is not None and currency in _SUBUNITS:
        fx = fx / _SUBUNITS[currency]

    rows: list[dict] = []
    for member in members:
        sym = member["ticker"]
        if sym not in closes.columns:
            continue
        series = closes[sym].dropna()
        if series.empty:
            continue
        price = float(series.iloc[-1])
        prev = float(series.iloc[-2]) if len(series) > 1 else None
        shares = member.get("shares")
        rows.append({
            "ticker": sym,
            "name": member.get("name") or sym,
            "sector": member.get("sector"),
            "price": round(price, 2),
            "change_pct": _pct(price, prev),
            "market_cap_usd": round(shares * price * fx) if (shares and fx) else None,
        })
    return rows, fx


def _sector_mix(rows: list[dict], total_cap: float | None) -> list[dict]:
    """Weight, member count and cap-weighted day move per sector.

    The taxonomy is whichever one the index itself publishes, so the buckets
    are not comparable across indices: the Hang Seng ships four, the FTSE
    forty-four. Relabelling them into a common scheme would be inventing a
    classification the source never made.
    """
    if not total_cap:
        return []
    buckets: dict[str, dict] = {}
    for row in rows:
        name = row.get("sector")
        cap = row.get("market_cap_usd")
        if not name or not cap:
            continue
        bucket = buckets.setdefault(name, {"sector": name, "cap": 0.0, "count": 0, "moved": 0.0})
        bucket["cap"] += cap
        bucket["count"] += 1
        if row.get("change_pct") is not None:
            bucket["moved"] += cap * row["change_pct"]
    out = [
        {
            "sector": b["sector"],
            "weight_pct": round(b["cap"] / total_cap * 100, 2),
            "count": b["count"],
            "change_pct": round(b["moved"] / b["cap"], 2) if b["cap"] else None,
        }
        for b in buckets.values()
    ]
    return sorted(out, key=lambda s: s["weight_pct"], reverse=True)


# Bump whenever the payload gains or loses a field. The persisted tier lives on
# a Fly volume that survives a deploy, so without this a shape change ships to
# an image that then serves the previous shape from disk until the TTL expires:
# new code, old JSON, and a panel missing a column for half an hour.
_SCHEMA = 2


def index_profile(symbol: str) -> dict:
    return _index_profile(symbol, _SCHEMA)


# Half an hour, not the usual five minutes. Pricing 500 names takes Yahoo about
# fifteen seconds, and a member's day change does not need to be fresher than
# the wait it costs. Persisted so a restart does not make the first visitor pay
# it again.
@cached(ttl=1800, maxsize=64, persist=True)
def _index_profile(symbol: str, schema: int) -> dict:
    """Members of `symbol` priced live, plus the aggregates worth reading off
    them: who is carrying the index, who is dragging it, and how many names are
    actually participating."""
    entry = _load().get("indices", {}).get(symbol)
    if not entry:
        # Not an index. A currency pair has no members, and saying so would be
        # answering a question the reader never asked.
        return {"available": False}
    if entry.get("unavailable"):
        return {"available": False, "reason": entry["unavailable"]}

    members = entry.get("members") or []
    currency = entry.get("currency")
    rows, fx = _price_members(members, currency)
    if not rows:
        return {"available": False, "reason": "Constituent prices are unavailable right now."}

    capped = [r for r in rows if r["market_cap_usd"]]
    total_cap = sum(r["market_cap_usd"] for r in capped) or None
    for row in rows:
        cap = row["market_cap_usd"]
        row["weight_pct"] = round(cap / total_cap * 100, 2) if (cap and total_cap) else None

    by_cap = sorted(rows, key=lambda r: r["market_cap_usd"] or -1, reverse=True)
    moved = [r for r in rows if r["change_pct"] is not None]
    ranked = sorted(moved, key=lambda r: r["change_pct"], reverse=True)

    advancing = sum(1 for r in moved if r["change_pct"] > 0)
    declining = sum(1 for r in moved if r["change_pct"] < 0)

    sectors = _sector_mix(rows, total_cap)

    def share(n: int) -> float | None:
        if not total_cap:
            return None
        return round(sum(r["market_cap_usd"] or 0 for r in by_cap[:n]) / total_cap * 100, 1)

    return {
        "available": True,
        # A price-weighted index is not moved by its biggest company, it is moved
        # by its highest-priced share. Saying which it is stops the weight column
        # being read as influence.
        "weighting": entry.get("weighting"),
        "currency": currency,
        "as_of": entry.get("as_of"),
        "source": entry.get("source"),
        "note": entry.get("note"),
        "coverage": {"listed": len(members), "priced": len(rows)},
        "total_market_cap_usd": total_cap,
        "breadth": {"advancing": advancing, "declining": declining,
                    "unchanged": len(moved) - advancing - declining, "priced": len(moved)},
        "concentration": {"top5_pct": share(5), "top10_pct": share(10)},
        "sectors": sectors,
        "members": by_cap,
        "leaders": ranked[:5],
        "laggards": list(reversed(ranked[-5:])) if len(ranked) > 5 else [],
    }
