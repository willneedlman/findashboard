"""
Builtin EMA Micro-Scalp strategy.

Very short-term EMA(3)/EMA(8) crossover. Enters when the fast EMA crosses above
the slow EMA (burst of upward momentum); exits on the reverse cross. Optional
ATR filter suppresses signals when the market is too quiet.
"""
from __future__ import annotations

from collections import deque
from typing import Any

from strategies.base import MarketDataPoint, Signal, Strategy, StrategyMetadata


class MicroScalpStrategy(Strategy):
    """BUY on EMA(fast) cross above EMA(slow); SELL on cross below."""

    def initialize(self, params: dict[str, Any]) -> None:
        self._fast       = int(params.get("ema_fast", 3))
        self._slow       = int(params.get("ema_slow", 8))
        self._atr_period = int(params.get("atr_period", 5))
        self._atr_mult   = float(params.get("atr_mult", 0.3))

        self._ema_f: float | None = None
        self._ema_s: float | None = None
        self._prev_f: float | None = None
        self._prev_s: float | None = None
        self._prices: deque[float] = deque(maxlen=self._atr_period + 1)
        self._in_trade = False
        self._tick     = 0

    def on_data(self, data_point: MarketDataPoint) -> Signal:
        p = data_point.price
        self._prices.append(p)
        self._tick += 1

        k_f = 2.0 / (self._fast + 1)
        k_s = 2.0 / (self._slow + 1)

        prev_f, prev_s = self._ema_f, self._ema_s

        self._ema_f = k_f * p + (1 - k_f) * self._ema_f if self._ema_f is not None else p
        self._ema_s = k_s * p + (1 - k_s) * self._ema_s if self._ema_s is not None else p

        if prev_f is None or prev_s is None or self._tick < self._slow + 2:
            return Signal.HOLD

        # ATR filter: skip signals when the market is too quiet
        if self._atr_mult > 0 and len(self._prices) >= 2:
            moves = [abs(self._prices[i] - self._prices[i - 1]) for i in range(1, len(self._prices))]
            atr = sum(moves) / len(moves)
            avg_p = sum(self._prices) / len(self._prices)
            if avg_p > 0 and (atr / avg_p) * 100 < self._atr_mult:
                if self._in_trade:
                    return Signal.BUY
                return Signal.HOLD

        was_above = prev_f > prev_s
        is_above  = self._ema_f > self._ema_s

        if not self._in_trade and not was_above and is_above:
            self._in_trade = True
            return Signal.BUY
        if self._in_trade and was_above and not is_above:
            self._in_trade = False
            return Signal.SELL
        if self._in_trade:
            return Signal.BUY
        return Signal.HOLD

    def reset(self) -> None:
        self._ema_f    = None
        self._ema_s    = None
        self._prev_f   = None
        self._prev_s   = None
        self._prices.clear()
        self._in_trade = False
        self._tick     = 0

    def metadata(self) -> StrategyMetadata:
        return StrategyMetadata(
            name        = "micro_scalp",
            version     = "1.0.0",
            author      = "builtin",
            description = "EMA(3/8) micro-scalp: buy on fast/slow EMA bullish cross, sell on bearish cross. ATR filter avoids quiet markets.",
            parameters  = {
                "ema_fast":   {"type": "int",   "default": 3,   "min": 2,   "max": 10},
                "ema_slow":   {"type": "int",   "default": 8,   "min": 4,   "max": 30},
                "atr_period": {"type": "int",   "default": 5,   "min": 2,   "max": 20},
                "atr_mult":   {"type": "float", "default": 0.3, "min": 0.0, "max": 2.0},
            },
        )
