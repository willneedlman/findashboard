"""MACD Crossover — EMA(12) - EMA(26), signal EMA(9)."""
from __future__ import annotations
from typing import Any
from strategies.base import MarketDataPoint, Signal, Strategy, StrategyMetadata


class MACDCrossoverStrategy(Strategy):
    """BUY on MACD cross above signal line; SELL on cross below."""

    def initialize(self, params: dict[str, Any]) -> None:
        self._fast   = int(params.get("ema_fast", 12))
        self._slow   = int(params.get("ema_slow", 26))
        self._signal = int(params.get("signal_period", 9))
        self._k_fast   = 2 / (self._fast   + 1)
        self._k_slow   = 2 / (self._slow   + 1)
        self._k_signal = 2 / (self._signal + 1)
        self._ema_fast: float | None = None
        self._ema_slow: float | None = None
        self._macd_ema: float | None = None
        self._prev_macd:   float | None = None
        self._prev_signal: float | None = None
        self._tick = 0

    def _update_ema(self, current: float | None, price: float, k: float) -> float:
        if current is None:
            return price
        return price * k + current * (1 - k)

    def on_data(self, dp: MarketDataPoint) -> Signal:
        self._tick += 1
        self._ema_fast = self._update_ema(self._ema_fast, dp.price, self._k_fast)
        self._ema_slow = self._update_ema(self._ema_slow, dp.price, self._k_slow)

        if self._tick < self._slow:
            return Signal.HOLD

        macd_val = self._ema_fast - self._ema_slow
        self._macd_ema = self._update_ema(self._macd_ema, macd_val, self._k_signal)

        if self._prev_macd is None or self._prev_signal is None:
            self._prev_macd   = macd_val
            self._prev_signal = self._macd_ema
            return Signal.HOLD

        signal = Signal.HOLD
        # Cross above signal line → BUY
        if self._prev_macd <= self._prev_signal and macd_val > self._macd_ema:
            signal = Signal.BUY
        # Cross below signal line → SELL
        elif self._prev_macd >= self._prev_signal and macd_val < self._macd_ema:
            signal = Signal.SELL

        self._prev_macd   = macd_val
        self._prev_signal = self._macd_ema
        return signal

    def reset(self) -> None:
        self._ema_fast = None
        self._ema_slow = None
        self._macd_ema = None
        self._prev_macd = None
        self._prev_signal = None
        self._tick = 0

    def metadata(self) -> StrategyMetadata:
        return StrategyMetadata(
            name="macd_crossover",
            version="1.0.0",
            author="builtin",
            description="MACD crossover: buy when MACD crosses above signal line, sell on cross below.",
            parameters={
                "ema_fast":      {"type": "int", "default": 12, "min": 3,  "max": 50},
                "ema_slow":      {"type": "int", "default": 26, "min": 10, "max": 200},
                "signal_period": {"type": "int", "default": 9,  "min": 2,  "max": 50},
            },
        )
