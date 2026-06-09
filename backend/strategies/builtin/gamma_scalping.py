"""
Builtin Gamma Scalping strategy — IV/RV regime proxy.

Uses short-term (5-day) vs long-term (20-day) realized volatility ratio as
a directional signal. When recent price moves exceed the historical baseline
(vol expanding), enters long (scalping the gamma). When vol collapses, exits.

Repurposed from the Gamma Scalping simulator's IV > RV / RV > IV logic.
"""
from __future__ import annotations

import math
from collections import deque
from typing import Any

from strategies.base import MarketDataPoint, Signal, Strategy, StrategyMetadata


class GammaScalpingStrategy(Strategy):
    """
    BUY  when short_vol / long_vol > entry_ratio  (vol expanding, long gamma regime)
    SELL when short_vol / long_vol < exit_ratio   (vol collapsing, short gamma regime)
    """

    def initialize(self, params: dict[str, Any]) -> None:
        self._short_window = int(params.get("short_window", 5))
        self._long_window  = int(params.get("long_window", 20))
        self._entry_ratio  = float(params.get("entry_ratio", 1.3))
        self._exit_ratio   = float(params.get("exit_ratio", 0.8))

        self._prices: deque[float] = deque(maxlen=self._long_window + 1)
        self._in_trade = False

    def on_data(self, data_point: MarketDataPoint) -> Signal:
        self._prices.append(data_point.price)

        if len(self._prices) < self._long_window + 1:
            return Signal.HOLD

        prices  = list(self._prices)
        returns = [math.log(prices[i] / prices[i - 1]) for i in range(1, len(prices))]

        def annualized_vol(rets: list[float]) -> float:
            n = len(rets)
            if n < 2:
                return 0.0
            mean = sum(rets) / n
            variance = sum((r - mean) ** 2 for r in rets) / (n - 1)
            return math.sqrt(variance * 252)

        sv = annualized_vol(returns[-self._short_window:])
        lv = annualized_vol(returns[-self._long_window:])

        if lv < 1e-8:
            return Signal.HOLD

        ratio = sv / lv

        if not self._in_trade and ratio >= self._entry_ratio:
            self._in_trade = True
            return Signal.BUY
        if self._in_trade and ratio <= self._exit_ratio:
            self._in_trade = False
            return Signal.SELL
        if self._in_trade:
            return Signal.BUY

        return Signal.HOLD

    def reset(self) -> None:
        self._prices.clear()
        self._in_trade = False

    def metadata(self) -> StrategyMetadata:
        return StrategyMetadata(
            name        = "gamma_scalping",
            version     = "1.0.0",
            author      = "builtin",
            description = "IV/RV proxy: buy when short-term vol expands above long-term baseline (long gamma); sell on compression.",
            parameters  = {
                "short_window": {"type": "int",   "default": 5,   "min": 2,  "max": 20},
                "long_window":  {"type": "int",   "default": 20,  "min": 10, "max": 60},
                "entry_ratio":  {"type": "float", "default": 1.3, "min": 1.1, "max": 2.5},
                "exit_ratio":   {"type": "float", "default": 0.8, "min": 0.3, "max": 0.95},
            },
        )
