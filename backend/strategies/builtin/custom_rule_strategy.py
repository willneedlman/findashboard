"""
Custom rule-based strategy.
Interprets a JSON rules definition at runtime so users can build strategies
in the frontend without writing Python.

Rules schema (matches frontend CustomStrategyDef):
{
  "name": "my_strategy",
  "buy":  { "logic": "AND"|"OR", "conditions": [ <ConditionRow>, ... ] },
  "sell": { "logic": "AND"|"OR", "conditions": [ <ConditionRow>, ... ] }
}

ConditionRow:
{
  "lhs":      IndicatorRef,
  "op":       "gt"|"lt"|"gte"|"lte"|"crosses_above"|"crosses_below",
  "rhs_type": "number"|"indicator",
  "rhs_num":  <float>          (if rhs_type == "number"),
  "rhs_ind":  IndicatorRef     (if rhs_type == "indicator")
}

IndicatorRef: { "type": "RSI"|"SMA"|..., "period": int, ... }
"""
from __future__ import annotations

from collections import deque
from typing import Any

import numpy as np

from strategies.base import MarketDataPoint, Signal, Strategy, StrategyMetadata
from strategies.indicators import get_indicator, warmup_bars


def _all_conditions(block: dict):
    """Yield every ConditionRow regardless of whether block uses groups or flat conditions."""
    groups = block.get("groups")
    if groups:
        for g in groups:
            yield from g.get("conditions", [])
    else:
        yield from block.get("conditions", [])


def _rules_warmup(rules: dict) -> int:
    needed = 2
    for block in (rules.get("buy", {}), rules.get("sell", {})):
        for cond in _all_conditions(block):
            needed = max(needed, warmup_bars(cond.get("lhs", {})))
            if cond.get("rhs_type") == "indicator":
                needed = max(needed, warmup_bars(cond.get("rhs_ind", {})))
    return needed + 10


def _eval_cond(cond: dict, prices: np.ndarray) -> bool:
    lhs_arr = get_indicator(cond.get("lhs", {"type": "PRICE"}), prices)
    i = len(lhs_arr) - 1
    lhs = lhs_arr[i]
    if np.isnan(lhs):
        return False

    op       = cond.get("op", "gt")
    rhs_type = cond.get("rhs_type", "number")

    if rhs_type == "number":
        rhs      = float(cond.get("rhs_num", 0))
        prev_rhs = rhs
    else:
        rhs_arr = get_indicator(cond.get("rhs_ind", {"type": "PRICE"}), prices)
        rhs = rhs_arr[i]
        if np.isnan(rhs):
            return False
        prev_rhs = rhs_arr[i - 1] if i > 0 else np.nan

    if op == "gt":  return lhs > rhs
    if op == "lt":  return lhs < rhs
    if op == "gte": return lhs >= rhs
    if op == "lte": return lhs <= rhs

    # Crossover ops need previous bar
    if i < 1:
        return False
    prev_lhs = lhs_arr[i - 1]
    if np.isnan(prev_lhs) or np.isnan(prev_rhs):
        return False
    if op == "crosses_above": return prev_lhs <= prev_rhs and lhs > rhs
    if op == "crosses_below": return prev_lhs >= prev_rhs and lhs < rhs
    return False


def _eval_group(group: dict, prices: np.ndarray) -> bool:
    conds = group.get("conditions", [])
    if not conds:
        return False
    logic   = group.get("logic", "AND")
    results = [_eval_cond(c, prices) for c in conds]
    return all(results) if logic == "AND" else any(results)


def _eval_block(block: dict, prices: np.ndarray) -> bool:
    groups = block.get("groups")
    # backwards compat: flat conditions → treat as single group
    if not groups:
        flat = block.get("conditions", [])
        if not flat:
            return False
        groups = [{"logic": block.get("logic", "AND"), "conditions": flat}]
    top_logic = block.get("logic", "AND")
    results   = [_eval_group(g, prices) for g in groups]
    return all(results) if top_logic == "AND" else any(results)


class CustomRuleStrategy(Strategy):
    """
    Stateful strategy backed by a JSON rule definition.
    Compatible with the paper trading engine (tick-by-tick) and
    the offline scheduler.
    """

    def initialize(self, params: dict[str, Any]) -> None:
        self._rules    = params.get("rules", {"buy": {"logic": "AND", "conditions": []},
                                              "sell": {"logic": "AND", "conditions": []}})
        self._strat_name = str(params.get("name", "custom_rule")).strip() or "custom_rule"
        self._buf_size = _rules_warmup(self._rules)
        self._prices: deque[float] = deque(maxlen=self._buf_size)
        self._in_trade = False

    def on_data(self, dp: MarketDataPoint) -> Signal:
        self._prices.append(dp.price)
        if len(self._prices) < max(3, self._buf_size // 2):
            return Signal.HOLD

        prices = np.array(self._prices, dtype=float)

        if not self._in_trade:
            if _eval_block(self._rules.get("buy", {}), prices):
                self._in_trade = True
                return Signal.BUY
        else:
            if _eval_block(self._rules.get("sell", {}), prices):
                self._in_trade = False
                return Signal.SELL
            return Signal.BUY  # remain invested

        return Signal.HOLD

    def reset(self) -> None:
        self._prices.clear()
        self._in_trade = False

    def metadata(self) -> StrategyMetadata:
        name = getattr(self, "_strat_name", "custom_rule")
        return StrategyMetadata(
            name        = name,
            version     = "1.0.0",
            author      = "custom",
            description = "User-defined rule-based strategy",
            parameters  = {},
        )
