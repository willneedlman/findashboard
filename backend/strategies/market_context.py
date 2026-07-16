"""Live market-context resolver for custom-strategy conditions.

Fundamentals, liquidity, options and energy-flow metrics are CURRENT values, not
point-in-time history, so a strategy condition built on them is a live / paper
signal. In a historical backtest each metric is held at its current value (a
constant series), so it gates the whole backtest on today's number rather than
pretending we have the historical one. The builder flags these as live signals.

Options and flow metrics cost a network call, so the resolver only fetches the
families a strategy actually references (see `_referenced_types`). Fundamentals
are a local lookup and are always cheap.
"""
from __future__ import annotations

from cache import get_history

_FUND: dict | None = None

# Custom-rule indicator type -> field in us_fundamentals.json.
_FUND_FIELDS: dict[str, str] = {
    "FUND_PE": "peRatio", "FUND_PEG": "pegRatio", "FUND_EPSGROWTH": "epsGrowth",
    "FUND_NETMARGIN": "netMargin", "FUND_GROSSMARGIN": "grossMargin",
    "FUND_DEBTEQUITY": "debtEquity", "FUND_DIVYIELD": "dividendYield",
    "FUND_PB": "pbRatio", "FUND_CURRENTRATIO": "currentRatio", "FUND_BETA": "beta",
}
_VOL_TYPES = {"VOL_RELATIVE", "VOL_DOLLAR"}
# Options-snapshot field per type (OPT_IVHV is derived from atm_iv / hv_30).
_OPT_FIELDS: dict[str, str] = {
    "OPT_IV": "atm_iv", "OPT_HV": "hv_30", "OPT_PUTCALL": "pc_vol", "OPT_IMPLIEDMOVE": "implied_move",
    "OPT_IVRANK": "iv_rank",
}
# ATM greeks derived from the snapshot (spot + ATM IV + expiry) via Black-Scholes.
_OPT_GREEKS = {"OPT_DELTA", "OPT_GAMMA", "OPT_THETA", "OPT_VEGA"}
_OPT_TYPES = set(_OPT_FIELDS) | {"OPT_IVHV"} | _OPT_GREEKS
# Energy-flow type -> PortWatch chokepoint id; value is the latest daily transit.
_FLOW_CHOKES: dict[str, str] = {
    "FLOW_HORMUZ": "hormuz", "FLOW_SUEZ": "suez", "FLOW_PANAMA": "panama", "FLOW_MALACCA": "malacca",
}

CONTEXT_TYPES: frozenset[str] = (
    frozenset(_FUND_FIELDS) | frozenset(_VOL_TYPES) | frozenset(_OPT_TYPES) | frozenset(_FLOW_CHOKES)
)
# Guard against drift: the engine routes exactly these types to the context.
from strategies.indicators import _CONTEXT_TYPES as _ENGINE_CONTEXT_TYPES  # noqa: E402
assert CONTEXT_TYPES == _ENGINE_CONTEXT_TYPES, "market_context and indicators context-type sets drifted"


def _fundamentals() -> dict:
    """Reuse the screener's already-loaded snapshot rather than parsing the same
    ~900-name file a second time (prod memory is tight)."""
    global _FUND
    if _FUND is None:
        try:
            from routers.screener import _US_FUND
            _FUND = _US_FUND or {}
        except Exception:
            _FUND = {}
    return _FUND


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


def resolve_context(ticker: str, rules: dict | None = None) -> dict[str, float]:
    """Current fundamental / liquidity / options / flow metrics for one ticker.

    When `rules` is given, only the metric families it references are fetched
    (options and flows each cost a network call). Missing metrics are absent, so
    a condition on an unavailable metric reads NaN and never fires. Never raises.
    """
    t = (ticker or "").upper().strip()
    needed = _referenced_types(rules) if rules is not None else None
    want = lambda types: needed is None or bool(needed & types)  # noqa: E731
    ctx: dict[str, float] = {}

    rec = _fundamentals().get(t, {})
    for key, field in _FUND_FIELDS.items():
        v = rec.get(field)
        if isinstance(v, (int, float)):
            ctx[key] = float(v)

    if want(_VOL_TYPES):
        try:
            df = get_history(t, period="3mo")
            if not df.empty and "Volume" in df and "Close" in df:
                vol, close = df["Volume"].dropna(), df["Close"].dropna()
                if len(vol) >= 21:
                    avg20 = float(vol.iloc[-21:-1].mean())
                    last_vol = float(vol.iloc[-1])
                    if avg20 > 0:
                        ctx["VOL_RELATIVE"] = round(last_vol / avg20, 4)
                    ctx["VOL_DOLLAR"] = round(float(close.iloc[-1]) * last_vol / 1e6, 2)  # $M
        except Exception:
            pass

    if want(_OPT_TYPES):
        try:
            from routers.options import options_snapshot
            snap = options_snapshot(t)
            for key, field in _OPT_FIELDS.items():
                v = snap.get(field)
                if isinstance(v, (int, float)):
                    ctx[key] = float(v)
            iv, hv = snap.get("atm_iv"), snap.get("hv_30")
            if isinstance(iv, (int, float)) and isinstance(hv, (int, float)) and hv > 0:
                ctx["OPT_IVHV"] = round(iv / hv, 3)
            # Raw inputs for leveled greeks: the engine computes delta/gamma/theta/
            # vega per-condition at the chosen strike level + call/put (see
            # indicators.get_indicator), so a single baked ATM value isn't stored.
            # Live snapshot values, held constant across the backtest.
            if needed is None or (needed & _OPT_GREEKS):
                spot, expiry = snap.get("spot"), snap.get("expiry")
                if isinstance(iv, (int, float)) and isinstance(spot, (int, float)) and spot > 0 and expiry:
                    try:
                        import datetime as _dt
                        dte = (_dt.date.fromisoformat(str(expiry)) - _dt.date.today()).days
                        if dte > 0:
                            ctx["_OPT_SPOT"] = float(spot)
                            ctx["_OPT_IV"]   = float(iv)
                            ctx["_OPT_DTE"]  = float(dte)
                    except Exception:
                        pass
        except Exception:
            pass

    if want(frozenset(_FLOW_CHOKES)):
        try:
            from routers.maritime import _portwatch_ids, _pw_history
            mapping = _portwatch_ids()
            for key, cid in _FLOW_CHOKES.items():
                if needed is not None and key not in needed:
                    continue
                m = mapping.get(cid)
                if not m:
                    continue
                totals = [p["total"] for p in _pw_history(m["portid"], 30) if p.get("total") is not None]
                if totals:
                    ctx[key] = float(totals[-1])
        except Exception:
            pass

    return ctx
