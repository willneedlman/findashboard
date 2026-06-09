"""Value — Trailing P/E strategy. Fetches fundamentals at initialize time."""
from __future__ import annotations
from typing import Any
from strategies.base import MarketDataPoint, Signal, Strategy, StrategyMetadata


class ValuePEStrategy(Strategy):
    """Invest when P/E < fair value; step to SELL when P/E is very expensive."""

    def initialize(self, params: dict[str, Any]) -> None:
        self._pe_deep_value = float(params.get("pe_deep_value", 12.0))
        self._pe_fair       = float(params.get("pe_fair_value", 20.0))
        self._pe_expensive  = float(params.get("pe_expensive", 35.0))
        self._pe_very_exp   = float(params.get("pe_very_expensive", 50.0))
        self._ticker        = str(params.get("ticker", "")).upper()
        self._pe: float | None = None
        self._invested = True

        if self._ticker:
            try:
                import yfinance as yf
                info = yf.Ticker(self._ticker).info
                pe = info.get("trailingPE") or info.get("forwardPE")
                if pe and pe > 0:
                    self._pe = float(pe)
                    # Determine initial stance
                    self._invested = self._pe < self._pe_expensive
            except Exception:
                pass

    def on_data(self, dp: MarketDataPoint) -> Signal:
        if self._pe is None:
            # No P/E data — default to hold
            return Signal.HOLD

        pe = self._pe
        if pe < self._pe_deep_value:
            return Signal.BUY          # deep value — strong buy
        elif pe < self._pe_fair:
            return Signal.BUY          # fairly valued — buy
        elif pe < self._pe_expensive:
            return Signal.HOLD         # neutral zone
        else:
            return Signal.SELL         # expensive — reduce/exit

    def reset(self) -> None:
        pass  # P/E doesn't change per tick; keep the fetched value

    def metadata(self) -> StrategyMetadata:
        return StrategyMetadata(
            name="value_pe",
            version="1.0.0",
            author="builtin",
            description="P/E value strategy: buy when cheap (<fair value), sell when expensive (>35x). Set ticker param.",
            parameters={
                "ticker":           {"type": "str",   "default": "SPY"},
                "pe_deep_value":    {"type": "float", "default": 12.0, "min": 5,  "max": 30},
                "pe_fair_value":    {"type": "float", "default": 20.0, "min": 10, "max": 40},
                "pe_expensive":     {"type": "float", "default": 35.0, "min": 20, "max": 80},
                "pe_very_expensive":{"type": "float", "default": 50.0, "min": 30, "max": 100},
            },
        )
