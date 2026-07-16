"""Point-in-time market-context resolver for custom-strategy conditions.

Every metric here resolves to a genuine per-bar historical series aligned to
the backtest's own date index — not a single current value repeated across
the whole window. Fundamentals/liquidity/flow data all come from sources this
app already has (FMP quarterly statements, OHLCV volume, PortWatch daily
transit history, a rolling-beta regression against the benchmark), forward-
filled onto trading days the same way a real point-in-time feed would read:
the last known reading holds until the next one arrives.

Options-derived signals (implied vol, put/call ratio, implied move, greeks)
are NOT resolved here — no historical options-chain data source exists
anywhere in this app or its vendors, so a rule condition built on them can
only ever be "today's value," which the project's bar for this tool
(genuinely historical or not offered at all) rules out. IV Rank and
historical vol are still available as indicators, but as real per-bar
technical indicators computed from price alone (see strategies/indicators.py)
— not resolved through this module.

Flow/fundamentals cost a network call, so the resolver only fetches the
families a strategy actually references (see `_referenced_types`).
"""
from __future__ import annotations

import numpy as np
import pandas as pd

from cache import get_history

# Custom-rule indicator type -> FMP ratio-series metric key (see fmp._RATIO_REGISTRY).
_FUND_RATIO_FIELDS: dict[str, str] = {
    "FUND_PE": "pe", "FUND_PB": "pb", "FUND_DEBTEQUITY": "debt_equity",
    "FUND_CURRENTRATIO": "current_ratio", "FUND_DIVYIELD": "dividend_yield",
    "FUND_NETMARGIN": "net_margin", "FUND_GROSSMARGIN": "gross_margin",
}
_VOL_TYPES = {"VOL_RELATIVE", "VOL_DOLLAR"}
# Energy-flow type -> PortWatch chokepoint id; value is the daily transit count.
_FLOW_CHOKES: dict[str, str] = {
    "FLOW_HORMUZ": "hormuz", "FLOW_SUEZ": "suez", "FLOW_PANAMA": "panama", "FLOW_MALACCA": "malacca",
}
_FUND_TYPES = set(_FUND_RATIO_FIELDS) | {"FUND_EPSGROWTH", "FUND_PEG", "FUND_BETA"}

CONTEXT_TYPES: frozenset[str] = (
    frozenset(_FUND_TYPES) | frozenset(_VOL_TYPES) | frozenset(_FLOW_CHOKES)
)
# Guard against drift: the engine routes exactly these types to the context.
from strategies.indicators import _CONTEXT_TYPES as _ENGINE_CONTEXT_TYPES  # noqa: E402
assert CONTEXT_TYPES == _ENGINE_CONTEXT_TYPES, "market_context and indicators context-type sets drifted"

_BENCHMARK = "SPY"


def _referenced_types(rules: dict | None) -> set[str]:
    """The indicator types a rule set actually uses (both blocks, groups + flat).

    Tolerant of malformed rules (null conditions/groups) so it never raises, since
    resolve_context runs before the evaluator that would otherwise report it.
    """
    out: set[str] = set()
    for block in (rules or {}).values():
        if not isinstance(block, dict):
            continue
        conds = list(block.get("conditions") or [])
        for g in (block.get("groups") or []):
            if isinstance(g, dict):
                conds += (g.get("conditions") or [])
        for c in conds:
            if not isinstance(c, dict):
                continue
            for side in ("lhs", "rhs_ind"):
                t = (c.get(side) or {}).get("type")
                if t:
                    out.add(t)
    return out


def _align_series(points: list[dict], index: pd.DatetimeIndex) -> np.ndarray:
    """Forward-fill a sparse [{date, value}] series (quarterly fundamentals, daily
    flow counts with gaps) onto the backtest's trading days — the last known
    reading holds until the next one, same as a real point-in-time feed. NaN
    before the first data point."""
    if not points:
        return np.full(len(index), np.nan)
    s = pd.Series({pd.Timestamp(p["date"]): p["value"] for p in points if p.get("value") is not None})
    if s.empty:
        return np.full(len(index), np.nan)
    s = s.sort_index()
    combined = s.reindex(s.index.union(index)).ffill()
    return combined.reindex(index).to_numpy(dtype=float)


def _rolling_vol_relative(volume: np.ndarray, window: int = 20) -> np.ndarray:
    """Each bar's volume against the mean of the PRIOR `window` bars (excluding
    itself, so a huge volume day doesn't inflate its own baseline)."""
    v = pd.Series(volume, dtype=float)
    avg = v.rolling(window).mean().shift(1)
    with np.errstate(divide="ignore", invalid="ignore"):
        return (v / avg).to_numpy(dtype=float)


def _rolling_beta(close: np.ndarray, bench_close: np.ndarray, window: int = 60) -> np.ndarray:
    """Per-bar rolling beta of `close`'s daily returns against the benchmark's,
    same cov/var-ratio the Portfolio Backtester's rolling-beta chart already
    uses. Aligned to `close`'s own length (NaN through the warmup window)."""
    ret = pd.Series(close, dtype=float).pct_change()
    bench_ret = pd.Series(bench_close, dtype=float).pct_change()
    cov = ret.rolling(window).cov(bench_ret)
    var = bench_ret.rolling(window).var()
    with np.errstate(divide="ignore", invalid="ignore"):
        return (cov / var).to_numpy(dtype=float)


def _eps_growth_points(eps_points: list[dict]) -> list[dict]:
    """YoY EPS growth % from a quarterly EPS series (4 quarters back), oldest-first."""
    out = []
    for i in range(4, len(eps_points)):
        prior = eps_points[i - 4]["value"]
        cur = eps_points[i]["value"]
        if prior is None or cur is None or prior == 0:
            continue
        out.append({"date": eps_points[i]["date"], "value": (cur - prior) / abs(prior) * 100.0})
    return out


def resolve_context(ticker: str, rules: dict | None, index: pd.DatetimeIndex,
                     close: np.ndarray | None = None, volume: np.ndarray | None = None) -> dict[str, np.ndarray]:
    """Point-in-time fundamental / liquidity / flow metrics for one ticker, each a
    per-bar array aligned to `index` (the backtest's own trading days).

    `rules` limits fetching to the metric families actually referenced (fundamentals
    and flows each cost a network call). A metric with no data source, or dates
    before its first observation, reads NaN — the condition never fires rather than
    silently using an unrelated value. Never raises.
    """
    t = (ticker or "").upper().strip()
    n = len(index)
    needed = _referenced_types(rules) if rules is not None else None
    want = lambda types: needed is None or bool(needed & types)  # noqa: E731
    ctx: dict[str, np.ndarray] = {}

    if want(_FUND_TYPES) and t:
        import fmp
        for key, metric in _FUND_RATIO_FIELDS.items():
            if needed is not None and key not in needed:
                continue
            try:
                pts = fmp.get_ratio_series(t, metric, period="quarter", limit=32)
                ctx[key] = _align_series(pts, index)
            except Exception:
                pass
        if needed is None or "FUND_EPSGROWTH" in needed or "FUND_PEG" in needed:
            try:
                eps_pts = fmp.get_fundamental_series(t, "eps", period="quarter", limit=32)
                growth_pts = _eps_growth_points(eps_pts)
                if needed is None or "FUND_EPSGROWTH" in needed:
                    ctx["FUND_EPSGROWTH"] = _align_series(growth_pts, index)
                if needed is None or "FUND_PEG" in needed:
                    pe_pts = fmp.get_ratio_series(t, "pe", period="quarter", limit=32)
                    pe_arr = _align_series(pe_pts, index)
                    growth_arr = _align_series(growth_pts, index)
                    with np.errstate(divide="ignore", invalid="ignore"):
                        peg = pe_arr / growth_arr
                    peg[~np.isfinite(peg)] = np.nan
                    ctx["FUND_PEG"] = peg
            except Exception:
                pass
        if (needed is None or "FUND_BETA" in needed) and close is not None:
            try:
                bench = get_history(_BENCHMARK, start=str(index[0].date()), end=str(index[-1].date()))
                if not bench.empty and "Close" in bench:
                    bench_close = bench["Close"].reindex(index).ffill().to_numpy(dtype=float)
                    ctx["FUND_BETA"] = _rolling_beta(np.asarray(close, dtype=float), bench_close)
            except Exception:
                pass

    if want(_VOL_TYPES) and volume is not None and close is not None:
        try:
            volume = np.asarray(volume, dtype=float)
            close_arr = np.asarray(close, dtype=float)
            if needed is None or "VOL_RELATIVE" in needed:
                ctx["VOL_RELATIVE"] = _rolling_vol_relative(volume)
            if needed is None or "VOL_DOLLAR" in needed:
                ctx["VOL_DOLLAR"] = close_arr * volume / 1e6
        except Exception:
            pass

    if want(frozenset(_FLOW_CHOKES)):
        try:
            from routers.maritime import _portwatch_ids, _pw_history
            mapping = _portwatch_ids()
            span_days = max((pd.Timestamp.now(tz="UTC").tz_localize(None) - index[0]).days + 10, 30)
            for key, cid in _FLOW_CHOKES.items():
                if needed is not None and key not in needed:
                    continue
                m = mapping.get(cid)
                if not m:
                    continue
                pts = [{"date": p["d"], "value": p["total"]} for p in _pw_history(m["portid"], span_days)
                       if p.get("total") is not None]
                ctx[key] = _align_series(pts, index)
        except Exception:
            pass

    return {k: v for k, v in ctx.items() if isinstance(v, np.ndarray) and len(v) == n}


# ── Live/paper-trading context ────────────────────────────────────────────────
# The scheduler polls a strategy every ~60s (see paper_scheduler._POLL_INTERVAL);
# fundamentals/flows move at a daily-or-slower cadence, so re-resolving a full
# aligned series on every tick would be wasted network calls (and would blow
# through FMP's free-tier daily quota fast). This resolves the same context
# resolve_context does, once per ticker per hour, and hands back just the
# latest reading — a live scalar, not a point-in-time series, since a live
# strategy legitimately wants "the fundamentals as of right now."
_LIVE_CTX_TTL = 3600  # 1h
_live_ctx_cache: dict[str, tuple[float, dict[str, float]]] = {}


def resolve_live_context(ticker: str, rules: dict | None) -> dict[str, float]:
    """Latest point-in-time reading per context type this rule set references,
    for one ticker — cached for _LIVE_CTX_TTL so a strategy polled every ~60s
    doesn't re-fetch fundamentals/flow data on every tick. Never raises; serves
    the last good cache entry (even if stale) rather than nothing on a fetch
    failure, same "stale beats empty" convention fmp.py's own cache already uses."""
    t = (ticker or "").upper().strip()
    if not t:
        return {}
    import time
    now = time.time()
    cached = _live_ctx_cache.get(t)
    if cached and now - cached[0] < _LIVE_CTX_TTL:
        return cached[1]
    try:
        hist = get_history(t, period="1y")
        if hist.empty or "Close" not in hist:
            return cached[1] if cached else {}
        close = hist["Close"].dropna()
        volume = hist["Volume"].reindex(close.index) if "Volume" in hist else None
        arrays = resolve_context(
            t, rules, close.index, close=close.to_numpy(),
            volume=volume.to_numpy() if volume is not None else None,
        )
        latest = {k: float(v[-1]) for k, v in arrays.items() if len(v) and not np.isnan(v[-1])}
        _live_ctx_cache[t] = (now, latest)
        return latest
    except Exception:
        return cached[1] if cached else {}
