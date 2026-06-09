"""Bollinger Bands Breakout — buy upper break, sell lower break."""
from __future__ import annotations
from collections import deque
from typing import Any
import math
from strategies.base import MarketDataPoint, Signal, Strategy, StrategyMetadata


class BollingerBreakoutStrategy(Strategy):
    """BUY when price closes above upper band; SELL when below lower band."""

    def initialize(self, params: dict[str, Any]) -> None:
        self._period  = int(params.get("period", 20))
        self._std_dev = float(params.get("std_dev", 2.0))
        self._prices: deque[float] = deque(maxlen=self._period)
        self._in_trade = False
        self._prev_above: bool | None = None
        self._prev_below: bool | None = None

    def _bands(self) -> tuple[float, float, float] | None:
        if len(self._prices) < self._period:
            return None
        data = list(self._prices)
        mean = sum(data) / len(data)
        variance = sum((x - mean) ** 2 for x in data) / len(data)
        std = math.sqrt(variance)
        return mean - self._std_dev * std, mean, mean + self._std_dev * std

    def on_data(self, dp: MarketDataPoint) -> Signal:
        self._prices.append(dp.price)
        bands = self._bands()
        if bands is None:
            return Signal.HOLD

        lower, mid, upper = bands
        price = dp.price

        above_upper = price > upper
        below_lower = price < lower

        signal = Signal.HOLD
        if above_upper and not self._in_trade:
            self._in_trade = True
            signal = Signal.BUY
        elif below_lower and self._in_trade:
            self._in_trade = False
            signal = Signal.SELL
        elif self._in_trade and price > mid:
            signal = Signal.BUY

        return signal

    def reset(self) -> None:
        self._prices.clear()
        self._in_trade = False

    def metadata(self) -> StrategyMetadata:
        return StrategyMetadata(
            name="bollinger_breakout",
            version="1.0.0",
            author="builtin",
            description="Bollinger Bands breakout: enter on upper-band break, exit below lower band.",
            parameters={
                "period":  {"type": "int",   "default": 20,  "min": 5,   "max": 100},
                "std_dev": {"type": "float", "default": 2.0, "min": 0.5, "max": 4.0},
            },
        )
