"""JSON rule DSL -> readable Python source.

Three jobs, in order of importance:

1. Migration. Every saved strategy becomes code with no user action, so the
   block builder can retire without anyone losing work.
2. Differential testing. Compiled source and the interpreter must produce
   identical signal arrays over real history; that is how the new engine is
   proven correct rather than hoped correct (tests/test_algo_runtime_compiler).
3. Few-shot corpus. The output is what the model is shown as house style.

Semantics mirrored from routers/strategy.py exactly, including the parts that
look like accidents but are load-bearing:

  * the interpreter loops `for i in range(1, n)`, so bar 0 is ALWAYS False
  * a NaN on either side of a comparison yields False (numpy already does this)
  * an empty condition list yields False, not True — an empty buy block never
    fires, so `all([])`-style vacuous truth would invert the strategy
  * crosses_* need bar i-1; at i=0 they are False
"""
from __future__ import annotations

import re
from typing import Any

# type -> (helper name, ordered param names with their DSL keys and defaults)
_IND_FN: dict[str, tuple[str, tuple[tuple[str, str, Any], ...]]] = {
    "PRICE":          ("price", ()),
    "RSI":            ("rsi", (("period", "period", 14),)),
    "SMA":            ("sma", (("period", "period", 50),)),
    "EMA":            ("ema", (("period", "period", 20),)),
    "MACD_LINE":      ("macd_line", (("fast", "fast", 12), ("slow", "slow", 26), ("signal_period", "signal_period", 9))),
    "MACD_SIGNAL":    ("macd_signal", (("fast", "fast", 12), ("slow", "slow", 26), ("signal_period", "signal_period", 9))),
    "BB_UPPER":       ("bb_upper", (("period", "period", 20), ("std", "std", 2.0))),
    "BB_MID":         ("bb_mid", (("period", "period", 20), ("std", "std", 2.0))),
    "BB_LOWER":       ("bb_lower", (("period", "period", 20), ("std", "std", 2.0))),
    "ATR":            ("atr", (("period", "period", 14),)),
    "MOMENTUM":       ("momentum", (("period", "period", 126),)),
    "PCT_CHANGE":     ("pct_change", (("period", "period", 20),)),
    "PCT_BELOW_HIGH": ("pct_below_high", (("period", "period", 20),)),
    "PCT_ABOVE_LOW":  ("pct_above_low", (("period", "period", 20),)),
    "OPT_HV":         ("realized_vol", (("period", "period", 21),)),
    "OPT_IVRANK":     ("iv_rank", (("period", "period", 252),)),
}

_CONTEXT_TYPES = frozenset({
    "FUND_PE", "FUND_PEG", "FUND_EPSGROWTH", "FUND_NETMARGIN", "FUND_GROSSMARGIN",
    "FUND_DEBTEQUITY", "FUND_DIVYIELD", "FUND_PB", "FUND_CURRENTRATIO", "FUND_BETA",
    "VOL_RELATIVE", "VOL_DOLLAR",
    "FLOW_HORMUZ", "FLOW_SUEZ", "FLOW_PANAMA", "FLOW_MALACCA",
})

# Types that resample to a coarser timeframe (strategy.py's _TF_TYPES).
_TF_TYPES = frozenset({
    "PRICE", "RSI", "SMA", "EMA", "MACD_LINE", "MACD_SIGNAL",
    "BB_UPPER", "BB_MID", "BB_LOWER", "ATR", "MOMENTUM", "PCT_CHANGE",
    "PCT_BELOW_HIGH", "PCT_ABOVE_LOW", "OPT_HV", "OPT_IVRANK",
})

_CMP = {"gt": ">", "lt": "<", "gte": ">=", "lte": "<="}
_IDENT = re.compile(r"[^0-9a-zA-Z_]+")


class UnsupportedRule(Exception):
    """A rule the compiler will not translate.

    Raised rather than emitting an approximation: a strategy that silently
    changes meaning on migration is worse than one that keeps running on the
    interpreter.
    """


def _int_param(ind: dict, key: str, default: int) -> int:
    v = ind.get(key)
    if v is None or v == "":
        return default
    try:
        p = int(float(v))
    except (TypeError, ValueError, OverflowError):
        return default
    return p if p > 0 else default


def _float_param(ind: dict, key: str, default: float) -> float:
    v = ind.get(key)
    if v is None or v == "":
        return default
    try:
        p = float(v)
    except (TypeError, ValueError, OverflowError):
        return default
    import math
    return p if math.isfinite(p) and p > 0 else default


def _num(v: float) -> str:
    f = float(v)
    return str(int(f)) if f == int(f) else repr(f)


class _Emitter:
    """Collects indicator expressions into named locals so a series referenced by
    several conditions is computed once — the interpreter caches per (ticker,
    ref), and the compiled form should not be slower than what it replaces."""

    def __init__(self) -> None:
        self.lines: list[str] = []
        self._by_expr: dict[str, str] = {}
        self._names: set[str] = set()

    def bind(self, expr: str, hint: str) -> str:
        if expr in self._by_expr:
            return self._by_expr[expr]
        base = _IDENT.sub("_", hint).strip("_").lower() or "s"
        name = base
        i = 2
        while name in self._names:
            name = f"{base}_{i}"
            i += 1
        self._names.add(name)
        self._by_expr[expr] = name
        self.lines.append(f"    {name} = {expr}")
        return name


def _series_expr(ref: dict, em: _Emitter, primary_only: bool) -> str:
    """One condition side -> a bound local holding its array."""
    t = str(ref.get("type") or "PRICE").upper()
    ticker = str(ref.get("ticker") or "").upper().strip()
    tf = str(ref.get("timeframe") or "daily").lower()

    if t in _CONTEXT_TYPES:
        tk = f", {ticker!r}" if ticker else ""
        return em.bind(f"c.metric({t!r}{tk})", f"{t}_{ticker or 'p'}")

    if t not in _IND_FN:
        raise UnsupportedRule(f"unknown indicator type {t!r}")

    fn, params = _IND_FN[t]
    kwargs = []
    for name, key, default in params:
        val = _float_param(ref, key, default) if isinstance(default, float) else _int_param(ref, key, default)
        kwargs.append(f"{name}={_num(val)}")

    src = "c.close" if not ticker else f"c.frame({ticker!r})"
    if ticker:
        src = em.bind(src, f"{ticker}_close")

    hint = f"{t}_{'_'.join(k.split('=')[1] for k in kwargs)}_{ticker or 'p'}"

    # Coarser timeframe -> resample. Only for price-derived types; context types
    # are pre-resolved per bar and never resample (strategy.py's _TF_TYPES gate).
    if tf not in ("", "daily") and t in _TF_TYPES:
        kw = (", " + ", ".join(kwargs)) if kwargs else ""
        expr = f"ind.tf({src}, c.index, {tf!r}, {fn!r}, base_tf=c.base_tf{kw})"
        return em.bind(expr, f"{hint}_{tf}")

    args = ", ".join([src] + kwargs)
    return em.bind(f"ind.{fn}({args})", hint)


def _cond_expr(cond: dict, em: _Emitter, primary_only: bool) -> str:
    lhs = _series_expr(cond.get("lhs") or {"type": "PRICE"}, em, primary_only)
    op = str(cond.get("op") or "gt")
    rhs_type = str(cond.get("rhs_type") or "number")

    if rhs_type == "number":
        try:
            rhs = _num(float(cond.get("rhs_num", 0)))
        except (TypeError, ValueError):
            rhs = "0"
    else:
        rhs = _series_expr(cond.get("rhs_ind") or {"type": "PRICE"}, em, primary_only)

    if op in _CMP:
        # NaN on either side compares False in numpy, matching _eval_cond_at's
        # explicit isnan guards.
        return f"({lhs} {_CMP[op]} {rhs})"
    if op == "crosses_above":
        return f"ind.crosses_above({lhs}, {rhs})"
    if op == "crosses_below":
        return f"ind.crosses_below({lhs}, {rhs})"
    raise UnsupportedRule(f"unknown operator {op!r}")


def _group_expr(group: dict, em: _Emitter, primary_only: bool) -> str | None:
    conds = group.get("conditions") or []
    if not conds:
        return None                      # empty group is False, never vacuous-true
    parts = [_cond_expr(c, em, primary_only) for c in conds]
    if len(parts) == 1:
        return parts[0]
    joiner = "ind.all_of" if str(group.get("logic") or "AND").upper() == "AND" else "ind.any_of"
    return f"{joiner}({', '.join(parts)})"


def _block_expr(block: dict, em: _Emitter, primary_only: bool) -> str:
    groups = block.get("groups")
    if not groups:
        flat = block.get("conditions") or []
        if not flat:
            return "ind.never(c.n)"
        groups = [{"logic": block.get("logic", "AND"), "conditions": flat}]

    parts = [g for g in (_group_expr(gr, em, primary_only) for gr in groups) if g is not None]
    if not parts:
        return "ind.never(c.n)"
    if len(parts) == 1:
        return parts[0]
    joiner = "ind.all_of" if str(block.get("logic") or "AND").upper() == "AND" else "ind.any_of"
    return f"{joiner}({', '.join(parts)})"


def compile_rules(rules: dict, name: str = "strategy") -> str:
    """Compile a {buy, sell} rule dict into `signal(c) -> Signals` source."""
    if not isinstance(rules, dict):
        raise UnsupportedRule("rules must be a dict")

    em = _Emitter()
    buy = _block_expr(rules.get("buy") or {}, em, primary_only=True)
    sell = _block_expr(rules.get("sell") or {}, em, primary_only=True)

    body = em.lines[:]
    body.append("")
    body.append(f"    entries = {buy}")
    body.append(f"    exits = {sell}")
    body.append("")
    body.append("    # Bar 0 has no previous bar; the interpreter's loop starts at 1.")
    body.append("    entries[0] = False")
    body.append("    exits[0] = False")
    body.append("    return Signals(entries, exits)")

    header = (
        f'"""{name} — compiled from the visual rule builder.\n\n'
        "    Edit freely: this is now the strategy. `c` is the Ctx (c.close, c.frame(...),\n"
        "    c.metric(...), c.params), `ind` holds causal indicators, and the returned\n"
        "    Signals carry one entry/exit flag per bar.\n"
        '    """'
    )
    return "def signal(c):\n    " + header + "\n" + "\n".join(body) + "\n"


def rules_warmup(rules: dict) -> dict:
    """Bars of history each block needs before it can legitimately fire.

    Per-block on purpose: an entry rule on a 200-day SMA and an exit rule on
    RSI-14 have very different warmups, and holding the exit to the entry's
    would fail honest strategies (validate._warmup_check).
    """
    from strategies.indicators import warmup_bars

    def block(b: dict) -> int:
        groups = b.get("groups") or ([{"conditions": b.get("conditions") or []}] if b.get("conditions") else [])
        need = 0
        for g in groups:
            for cond in (g.get("conditions") or []):
                for side in ("lhs", "rhs_ind"):
                    ref = cond.get(side)
                    if isinstance(ref, dict) and ref.get("type"):
                        need = max(need, int(warmup_bars(ref)))
        return need

    return {"entries": block(rules.get("buy") or {}), "exits": block(rules.get("sell") or {})}


def compilable(rules: dict) -> bool:
    try:
        compile_rules(rules)
        return True
    except UnsupportedRule:
        return False
