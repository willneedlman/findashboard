"""
Builtin RSI mean-reversion strategy.

Demonstrates the Strategy interface.  Mirrors the logic already in algo.py
but rewritten as an event-driven stateful class so on_data() can be called
tick-by-tick without external pandas.
"""
from __future__ import annotations

from collections import deque
from typing import Any

from strategies.base import MarketDataPoint, Signal, Strategy, StrategyMetadata


class RSIMeanReversionStrategy(Strategy):
    """Buy on RSI cross above oversold; sell on cross below overbought."""

    def initialize(self, params: dict[str, Any]) -> None:
        self._period    = int(params.get("period", 14))
        self._oversold  = float(params.get("oversold", 30.0))
        self._overbought = float(params.get("overbought", 70.0))

        self._prices: deque[float] = deque(maxlen=self._period + 1)
        self._avg_gain: float | None = None
        self._avg_loss: float | None = None
        self._in_trade  = False
        self._prev_rsi: float | None = None
        self._tick      = 0

    def on_data(self, data_point: MarketDataPoint) -> Signal:
        self._prices.append(data_point.price)
        self._tick += 1

        if len(self._prices) < self._period + 1:
            return Signal.HOLD

        rsi = self._compute_rsi()
        if rsi is None:
            return Signal.HOLD

        signal = Signal.HOLD
        prev = self._prev_rsi

        if prev is not None:
            if not self._in_trade and prev < self._oversold and rsi >= self._oversold:
                self._in_trade = True
                signal = Signal.BUY
            elif self._in_trade and prev > self._overbought and rsi <= self._overbought:
                self._in_trade = False
                signal = Signal.SELL
            elif self._in_trade:
                signal = Signal.BUY
            else:
                signal = Signal.HOLD

        self._prev_rsi = rsi
        return signal

    def reset(self) -> None:
        self._prices.clear()
        self._avg_gain   = None
        self._avg_loss   = None
        self._in_trade   = False
        self._prev_rsi   = None
        self._tick       = 0

    def metadata(self) -> StrategyMetadata:
        return StrategyMetadata(
            name        = "rsi_mean_reversion",
            version     = "1.0.0",
            author      = "builtin",
            description = "RSI mean-reversion: buy oversold cross, sell overbought cross.",
            parameters  = {
                "period":     {"type": "int",   "default": 14,   "min": 2,  "max": 100},
                "oversold":   {"type": "float", "default": 30.0, "min": 5,  "max": 49},
                "overbought": {"type": "float", "default": 70.0, "min": 51, "max": 95},
            },
        )

    # ── Private ───────────────────────────────────────────────────────────────

    def _compute_rsi(self) -> float | None:
        prices = list(self._prices)
        if len(prices) < self._period + 1:
            return None
        deltas = [prices[i] - prices[i - 1] for i in range(1, len(prices))]
        gains  = [max(d, 0.0) for d in deltas]
        losses = [abs(min(d, 0.0)) for d in deltas]
        if self._avg_gain is None:
            self._avg_gain = sum(gains)  / self._period
            self._avg_loss = sum(losses) / self._period
        else:
            last_g = gains[-1]
            last_l = losses[-1]
            self._avg_gain = (self._avg_gain * (self._period - 1) + last_g) / self._period
            self._avg_loss = (self._avg_loss * (self._period - 1) + last_l) / self._period
        if self._avg_loss == 0:
            return 100.0
        rs = self._avg_gain / self._avg_loss
        return 100.0 - (100.0 / (1.0 + rs))
