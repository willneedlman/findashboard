"""SMA Trend Following — Golden Cross / Death Cross (50/200)."""
from __future__ import annotations
from collections import deque
from typing import Any
from strategies.base import MarketDataPoint, Signal, Strategy, StrategyMetadata


class SMATrendStrategy(Strategy):
    """BUY when price > SMA50 > SMA200 (golden cross). SELL on death cross."""

    def initialize(self, params: dict[str, Any]) -> None:
        self._fast = int(params.get("sma_fast", 50))
        self._slow = int(params.get("sma_slow", 200))
        self._prices: deque[float] = deque(maxlen=self._slow + 1)
        self._in_trade = False

    def _sma(self, n: int) -> float | None:
        if len(self._prices) < n:
            return None
        window = list(self._prices)[-n:]
        return sum(window) / n

    def on_data(self, dp: MarketDataPoint) -> Signal:
        self._prices.append(dp.price)
        fast = self._sma(self._fast)
        slow = self._sma(self._slow)
        if fast is None or slow is None:
            return Signal.HOLD

        price = dp.price
        if price > fast and fast > slow:
            if not self._in_trade:
                self._in_trade = True
                return Signal.BUY
            return Signal.BUY
        elif price < fast and fast < slow:
            if self._in_trade:
                self._in_trade = False
                return Signal.SELL
            return Signal.SELL
        return Signal.HOLD

    def reset(self) -> None:
        self._prices.clear()
        self._in_trade = False

    def metadata(self) -> StrategyMetadata:
        return StrategyMetadata(
            name="sma_trend_following",
            version="1.0.0",
            author="builtin",
            description="Golden Cross (SMA50>SMA200) buy signal; Death Cross sell signal.",
            parameters={
                "sma_fast": {"type": "int",   "default": 50,  "min": 5,   "max": 100},
                "sma_slow": {"type": "int",   "default": 200, "min": 50,  "max": 500},
            },
        )
