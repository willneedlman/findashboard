"""6-Month Price Momentum — ride winners, exit losers."""
from __future__ import annotations
from collections import deque
from typing import Any
from strategies.base import MarketDataPoint, Signal, Strategy, StrategyMetadata


class MomentumStrategy(Strategy):
    """BUY when N-day return > threshold; SELL when negative."""

    def initialize(self, params: dict[str, Any]) -> None:
        self._lookback  = int(params.get("lookback_days", 126))
        self._threshold = float(params.get("threshold_pct", 0.0)) / 100
        self._prices: deque[float] = deque(maxlen=self._lookback + 1)
        self._in_trade = False

    def on_data(self, dp: MarketDataPoint) -> Signal:
        self._prices.append(dp.price)
        if len(self._prices) < self._lookback + 1:
            return Signal.HOLD

        past_price = list(self._prices)[0]
        if past_price <= 0:
            return Signal.HOLD

        momentum = (dp.price / past_price) - 1

        if momentum > self._threshold:
            if not self._in_trade:
                self._in_trade = True
                return Signal.BUY
            return Signal.BUY
        else:
            if self._in_trade:
                self._in_trade = False
                return Signal.SELL
            return Signal.HOLD

    def reset(self) -> None:
        self._prices.clear()
        self._in_trade = False

    def metadata(self) -> StrategyMetadata:
        return StrategyMetadata(
            name="momentum",
            version="1.0.0",
            author="builtin",
            description="6-month price momentum: buy positive momentum, sell when return turns negative.",
            parameters={
                "lookback_days":  {"type": "int",   "default": 126, "min": 20,  "max": 252},
                "threshold_pct":  {"type": "float", "default": 0.0, "min": -10, "max": 20},
            },
        )
