"""Semantic layer: is the request possible, and does the code actually do it?

L0-L6 in validate.py prove the code is safe, causal and runnable. None of them
check that it implements what was asked. Two real failures came out of that gap:

  1. "enter when the next 5 days are going to be up" produced causal code with a
     variable named `future_up` that actually meant "today was up". Validation
     passed. The user got a different strategy, silently.
  2. Nothing catches an inverted comparison, a missing condition, or a threshold
     the model rounded to something it liked better.

So: extract a machine-checkable spec from the prompt first, refuse the requests
that need a time machine, and mechanically verify the code against the spec
afterwards.

Extraction is deliberately PRECISION-BIASED. Only conditions the user stated
unambiguously (a named indicator with a comparison and a number) become
checkable. "Buy the dip" extracts nothing and conformance passes trivially —
a false accusation would train users to ignore the checker, which is worse than
missing a vague case.
"""
from __future__ import annotations

import ast
import json
import logging
import re

logger = logging.getLogger("algo_runtime.spec")

# Phrases that usually mean "read a bar that has not happened". Not a verdict on
# their own: "when momentum suggests the next week will be up" is a legitimate
# predictive strategy, while "when the next week IS up" is a time machine. They
# are passed to the model as hints, and it makes the call.
_FUTURE_HINTS = [
    r"\bnext \d+ (?:day|week|month|bar|candle)s?\b.{0,40}\b(?:are|is|will be|going to)\b",
    r"\b(?:will|going to) (?:rise|fall|rally|drop|crash|go up|go down|reverse|bounce)\b",
    r"\bbefore (?:it|the price|the stock) (?:rises|falls|rallies|drops|reverses|bounces|moves)\b",
    r"\b(?:at|near) the (?:exact )?(?:bottom|top|peak|low|high) of the (?:move|rally|drop|trend)\b",
    r"\bbuy the (?:exact )?bottom\b|\bsell the (?:exact )?top\b",
    r"\bknow(?:ing|s)? (?:in advance|beforehand|ahead of time)\b",
    r"\bperfect (?:entry|exit|timing|foresight)\b",
    r"\bavoid (?:every |all )?(?:drawdown|loss|crash)(?:es)?\b",
]

# The vocabulary a spec condition may name. Must track algo_runtime.indicators:
# when the helper library grew past the block set, this list did not, and the
# extractor started forcing rich requests onto the nearest old name — "close in
# the bottom quarter of the bar range" became `pct_below_high`, and conformance
# then rejected correct code. A checker that misreads the request is worse than
# one that stays quiet.
_INDICATORS = {
    "price", "open", "high", "low", "volume",
    "rsi", "sma", "ema", "macd_line", "macd_signal", "bb_upper", "bb_mid", "bb_lower",
    "atr", "atr_true", "momentum", "pct_change", "pct_below_high", "pct_above_low",
    "realized_vol", "iv_rank",
    "zscore", "percentile_rank", "slope", "rolling_mean", "rolling_std",
    "rolling_min", "rolling_max", "rolling_median", "rolling_corr", "rolling_beta",
    "true_range", "gap_pct", "range_pct", "close_position", "typical_price",
    "relative_volume", "dollar_volume", "vwap", "obv",
    "bars_since", "streak", "count_in_window",
    "drawdown_pct", "runup_pct", "ratio", "relative_strength", "spread_zscore",
    "day_of_week", "month_of_year",
}
_OPS = {"lt", "gt", "lte", "gte", "crosses_above", "crosses_below"}
_FLIP = {"lt": "gt", "gt": "lt", "lte": "gte", "gte": "lte",
         "crosses_above": "crosses_below", "crosses_below": "crosses_above"}
# Only the DIRECTION is checked, not the boundary. `> 72` and `>= 72` differ on
# exact equality, which is measure-zero for a float indicator and never what a
# user means by "above 72" — treating them as different findings produced a
# false positive that cost a repair round-trip and then oscillated between the
# two forms.
_DIR = {"lt": "down", "lte": "down", "gt": "up", "gte": "up"}

EXTRACT_SYSTEM = """You turn a trading-strategy request into a strict JSON spec. You never write code.

Return ONLY this JSON:
{
  "feasible": true | false,
  "reason": "if not feasible, one sentence on what is impossible",
  "alternative": "if not feasible, a CONCRETE causal substitute naming real indicators and levels",
  "entry": [ {"indicator": "...", "period": N, "op": "...", "value": N} ],
  "exit":  [ ... same shape ... ]
}

feasible = false ONLY when the request needs data from bars that have not
happened yet. Examples that are NOT feasible:
  "buy when the next 5 days are up"        (needs future bars)
  "sell at the exact top of the move"      (the top is only known afterwards)
  "enter right before the rally starts"    (needs to know a rally follows)
Examples that ARE feasible, because they only use history:
  "buy when RSI is oversold"
  "buy when momentum suggests a rally is likely"
  "sell when price falls 5% from its recent high"
The distinction is knowing versus predicting. Predicting from past data is fine.

When you set feasible=false, "alternative" must name actual indicators and
numbers the user could trade tomorrow — never a reworded version of the
impossible request. Rewording it is useless to them.
  BAD:  "enter when the next 5 days are predicted to be up"
  GOOD: "enter when RSI(14) crosses back above 30 while price is above its
         200-day SMA, and exit when RSI(14) reaches 70"

Extract into entry/exit ONLY conditions that are a SINGLE named quantity
compared to a SINGLE number or another single named quantity. Everything else is
omitted. In particular, OMIT a condition when:
  * it involves arithmetic between series
    ("price more than 1.5 ATR below its 20-day average" — omit)
  * no indicator is named ("buy the dip" — omit)
  * no threshold is given and none is implied ("when volume is high" — omit)
  * you would have to substitute a different indicator to make it fit

That last one matters most. If the closest name in the list does not mean the
same thing as what the user said, OMIT the condition. A wrong extraction makes
the checker reject correct code, which is far worse than checking nothing.

indicator must be one of: price, open, high, low, volume, rsi, sma, ema,
macd_line, macd_signal, bb_upper, bb_mid, bb_lower, atr, atr_true, momentum,
pct_change, pct_below_high, pct_above_low, realized_vol, iv_rank, zscore,
percentile_rank, slope, rolling_mean, rolling_std, rolling_min, rolling_max,
rolling_median, rolling_corr, rolling_beta, true_range, gap_pct, range_pct,
close_position, typical_price, relative_volume, dollar_volume, vwap, obv,
bars_since, streak, count_in_window, drawdown_pct, runup_pct, ratio,
relative_strength, spread_zscore, day_of_week, month_of_year
op must be one of: lt, gt, lte, gte, crosses_above, crosses_below
Use "period" for the indicator's lookback when the user gave one; omit otherwise.
For a cross, "indicator" is the thing that MOVES and "against" is what it moves
across. "price crosses above its 200 day moving average" is
  {"indicator": "price", "op": "crosses_above", "against": "sma", "period": 200}
where "period" describes the "against" side. Never reverse the two: crossing is
directional, and naming the wrong subject inverts the condition.
Keep it simple: one row per stated condition."""


def future_hints(prompt: str) -> list[str]:
    """Deterministic red flags, shown to the model rather than acted on alone."""
    p = (prompt or "").lower()
    return [h for h in _FUTURE_HINTS if re.search(h, p)]


def extract(prompt: str, model: str | None = None) -> dict:
    """Prompt -> spec. Degrades to 'feasible, nothing checkable' on any failure:
    a broken extractor must not block generation."""
    from ai_client import groq_chat, MODEL_FAST, parse_json

    hints = future_hints(prompt)
    msgs = [{"role": "system", "content": EXTRACT_SYSTEM}]
    if hints:
        msgs.append({"role": "system", "content":
                     "The request contains phrasing that often means future data is needed. "
                     "Judge carefully whether it is knowing (not feasible) or predicting (feasible)."})
    msgs.append({"role": "user", "content": prompt})

    try:
        resp = groq_chat(msgs, model=model or MODEL_FAST, max_tokens=600, temperature=0)
        raw = parse_json((resp.choices[0].message.content or "").strip())
    except Exception:
        logger.exception("spec extraction failed; continuing without a spec")
        return {"feasible": True, "entry": [], "exit": [], "degraded": True}

    if not isinstance(raw, dict):
        return {"feasible": True, "entry": [], "exit": [], "degraded": True}

    return {
        "feasible": bool(raw.get("feasible", True)),
        "reason": str(raw.get("reason") or "").strip() or None,
        "alternative": str(raw.get("alternative") or "").strip() or None,
        "entry": _clean(raw.get("entry")),
        "exit": _clean(raw.get("exit")),
        "hints": hints,
        "degraded": False,
    }


def _clean(rows) -> list[dict]:
    """Keep only fully-specified, in-vocabulary conditions."""
    out = []
    for r in (rows or [])[:6]:
        if not isinstance(r, dict):
            continue
        ind = str(r.get("indicator") or "").lower().strip()
        op = str(r.get("op") or "").lower().strip()
        if ind not in _INDICATORS or op not in _OPS:
            continue
        val = r.get("value")
        try:
            val = None if val is None else float(val)
        except (TypeError, ValueError):
            val = None
        per = r.get("period")
        try:
            per = None if per in (None, "") else int(float(per))
        except (TypeError, ValueError):
            per = None
        against = str(r.get("against") or "").lower().strip() or None
        if against not in _INDICATORS:
            against = None
        out.append({"indicator": ind, "period": per, "op": op, "value": val, "against": against})
    return out


# ── conformance: does the code do what the spec says? ────────────────────────

class _Scope:
    """Comparisons and crosses reachable from ONE expression.

    Per-side on purpose. A normal strategy enters on a cross up and exits on the
    cross down, so pooling both sides makes an inverted entry indistinguishable
    from a correct one — the exit supplies the missing direction and the check
    silently passes. That was the first thing these tests caught.
    """

    def __init__(self) -> None:
        self.compares: list[tuple[str, str, float | None]] = []
        self.crosses: list[tuple[str, str, str | None]] = []   # (subject, direction, object)
        self.used: set[str] = set()


class _Reader:
    """Resolves `entries` / `exits` back through local assignments, so a
    condition written three variables away from the return is still attributed
    to the right side."""

    def __init__(self, tree: ast.AST) -> None:
        self.assigns: dict[str, ast.AST] = {}
        self.bindings: dict[str, tuple[str, int | None]] = {}
        for node in ast.walk(tree):
            if isinstance(node, ast.Assign) and len(node.targets) == 1 \
                    and isinstance(node.targets[0], ast.Name):
                name = node.targets[0].id
                self.assigns[name] = node.value
                got = self._ind_of(node.value)
                if got:
                    self.bindings[name] = got

        self.entries, self.exits = _Scope(), _Scope()
        ret = next((n for n in ast.walk(tree) if isinstance(n, ast.Return) and n.value is not None), None)
        if ret is not None and isinstance(ret.value, ast.Call) and len(ret.value.args) >= 2:
            self._collect(ret.value.args[0], self.entries, set())
            self._collect(ret.value.args[1], self.exits, set())
        else:                                   # unusual shape: fall back to both
            for name, scope in (("entries", self.entries), ("exits", self.exits)):
                if name in self.assigns:
                    self._collect(self.assigns[name], scope, set())

    def _ind_of(self, node) -> tuple[str, int | None] | None:
        """(indicator, period) for an ind.* call, a bound local, or c.close."""
        if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute) \
                and isinstance(node.func.value, ast.Name) and node.func.value.id == "ind":
            fn = node.func.attr
            period = None
            for kw in node.keywords:
                if kw.arg in ("period", "slow") and isinstance(kw.value, ast.Constant) \
                        and isinstance(kw.value.value, (int, float)):
                    period = int(kw.value.value)
            if period is None:
                for a in node.args[1:]:
                    if isinstance(a, ast.Constant) and isinstance(a.value, (int, float)):
                        period = int(a.value)
                        break
            return (fn, period)
        if isinstance(node, ast.Name) and node.id in self.bindings:
            return self.bindings[node.id]
        if isinstance(node, ast.Attribute) and node.attr in ("close", "open", "high", "low", "volume"):
            return ("price" if node.attr == "close" else node.attr, None)
        return None

    def _collect(self, node, scope: _Scope, seen: set[str]) -> None:
        if node is None:
            return
        # Follow a plain name back to what it was assigned, once.
        if isinstance(node, ast.Name):
            got = self.bindings.get(node.id)
            if got:
                scope.used.add(got[0])
            if node.id in self.assigns and node.id not in seen:
                self._collect(self.assigns[node.id], scope, seen | {node.id})
            return

        got = self._ind_of(node)
        if got:
            scope.used.add(got[0])

        if isinstance(node, ast.Call):
            fn = node.func.attr if isinstance(node.func, ast.Attribute) else None
            if fn in ("crosses_above", "crosses_below") and len(node.args) >= 2:
                a, b = self._ind_of(node.args[0]), self._ind_of(node.args[1])
                if a:
                    scope.crosses.append((a[0], fn, b[0] if b else None))
                    scope.used.add(a[0])
                if b:
                    # "price crosses above SMA" is the same event as "SMA
                    # crosses below price" — record that equivalence so a spec
                    # phrased from the other subject still matches.
                    scope.crosses.append((b[0], _FLIP[fn], a[0] if a else None))
                    scope.used.add(b[0])
            for a in list(node.args) + [k.value for k in node.keywords]:
                self._collect(a, scope, seen)
            return

        if isinstance(node, ast.Compare) and len(node.ops) == 1 and len(node.comparators) == 1:
            op = {ast.Lt: "lt", ast.Gt: "gt", ast.LtE: "lte", ast.GtE: "gte"}.get(type(node.ops[0]))
            left, right = node.left, node.comparators[0]
            li, ri = self._ind_of(left), self._ind_of(right)
            if op:
                if li and isinstance(right, ast.Constant) and isinstance(right.value, (int, float)):
                    scope.compares.append((li[0], op, float(right.value)))
                elif ri and isinstance(left, ast.Constant) and isinstance(left.value, (int, float)):
                    scope.compares.append((ri[0], _FLIP[op], float(left.value)))
                elif li and ri:
                    scope.compares.append((li[0], op, None))
                    scope.compares.append((ri[0], _FLIP[op], None))
            for side in (left, right):
                self._collect(side, scope, seen)
            return

        for child in ast.iter_child_nodes(node):
            self._collect(child, scope, seen)


def _check_side(conds: list[dict], scope: _Scope, side: str) -> list[dict]:
    out: list[dict] = []
    for cond in conds:
        ind, op, val, per = cond["indicator"], cond["op"], cond["value"], cond["period"]
        label = f"{ind}{f'({per})' if per else ''} {op}{f' {val:g}' if val is not None else ''}"
        where = f"the {side} rule"

        if ind not in scope.used:
            out.append(_d(f"you asked for {label} on {side}, but {where} never uses {ind} "
                          f"— check this is expressed some other way",
                          severity="warning"))
            continue

        if op in ("crosses_above", "crosses_below"):
            against = cond.get("against")
            def hit(direction: str) -> bool:
                return any(i == ind and o == direction and (against is None or t is None or t == against)
                           for i, o, t in scope.crosses)
            if not hit(op):
                if hit(_FLIP[op]):
                    out.append(_d(f"{where} crosses {ind} the wrong way — you asked for "
                                  f"{ind} to cross {'above' if op == 'crosses_above' else 'below'}"
                                  f"{' ' + against if against else ''}"))
                else:
                    out.append(_d(f"you asked for {ind} {op}"
                                  f"{' ' + against if against else ''} on {side}, "
                                  f"but {where} never tests that cross", severity="warning"))
            continue

        want = _DIR[op]
        matches = [(i, o, v) for i, o, v in scope.compares if i == ind]
        if val is None:
            if matches and not any(_DIR.get(o) == want for _, o, _ in matches) \
                    and any(_DIR.get(o) and _DIR[o] != want for _, o, _ in matches):
                out.append(_d(f"the {ind} comparison in {where} is inverted — you asked for {op}"))
            continue

        exact = [m for m in matches if m[2] is not None and abs(m[2] - val) < 1e-6]
        if not exact:
            near = sorted({m[2] for m in matches if m[2] is not None})
            if near:
                out.append(_d(f"you asked for {label} on {side}, but {where} compares {ind} against "
                              f"{', '.join(f'{v:g}' for v in near)}"))
            else:
                out.append(_d(f"you asked for {label} on {side}, but {where} never compares {ind} "
                              f"to a number — check this is expressed some other way",
                              severity="warning"))
            continue

        if not any(_DIR.get(o) == want for _, o, _ in exact):
            out.append(_d(f"{where} is inverted — you asked for {ind} {op} {val:g}, "
                          f"the code has {ind} {exact[0][1]} {val:g}"))
    return out


def conformance(source: str, spec: dict) -> list[dict]:
    """Mechanically check the code against the extracted spec.

    Four kinds of finding, all of which pass L0-L6 unnoticed:
      * the indicator the user named is not used on that side
      * it is used, but against a different threshold
      * the comparison is inverted
      * the cross runs the wrong way
    """
    entry, exit_ = list(spec.get("entry") or []), list(spec.get("exit") or [])
    if not entry and not exit_:
        return []
    try:
        tree = ast.parse(source)
    except SyntaxError:
        return []

    r = _Reader(tree)
    return _check_side(entry, r.entries, "entry") + _check_side(exit_, r.exits, "exit")


def _d(message: str, severity: str = "error") -> dict:
    return {"level": "L7", "severity": severity, "message": message, "line": None}


def refusal(spec: dict, prompt: str) -> dict:
    """The response for a request that needs a time machine.

    Says what is impossible and what the nearest real strategy would be, rather
    than quietly writing something else and calling it done.
    """
    reason = spec.get("reason") or ("That needs prices from bars that have not happened yet.")
    alt = spec.get("alternative")
    text = f"That can't be backtested honestly: {reason}"
    if alt:
        text += f"\n\nThe closest thing that only uses past data: {alt}\n\nWant me to write that instead?"
    else:
        text += ("\n\nEvery condition has to be decidable on the bar it fires, using only history. "
                 "Tell me what observable signal should stand in for it.")
    return {"ok": False, "infeasible": True, "source": None,
            "diagnostics": [{"level": "L7", "severity": "error",
                             "message": reason, "line": None}],
            "attempts": 0, "intent": "refuse", "explanation": text}
