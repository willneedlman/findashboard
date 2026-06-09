"""Earnings Growth Momentum — stay invested when EPS grows YoY."""
from __future__ import annotations
from typing import Any
from strategies.base import MarketDataPoint, Signal, Strategy, StrategyMetadata


class EarningsGrowthStrategy(Strategy):
    """BUY when quarterly EPS growth is positive; SELL when it turns negative."""

    def initialize(self, params: dict[str, Any]) -> None:
        self._exit_threshold = float(params.get("exit_threshold_pct", -5.0)) / 100
        self._ticker = str(params.get("ticker", "")).upper()
        self._eg: float | None = None
        self._in_trade = False

        if self._ticker:
            try:
                import yfinance as yf
                info = yf.Ticker(self._ticker).info
                eg = info.get("earningsQuarterlyGrowth")
                if eg is not None:
                    self._eg = float(eg)
                    self._in_trade = self._eg > self._exit_threshold
            except Exception:
                pass

    def on_data(self, dp: MarketDataPoint) -> Signal:
        if self._eg is None:
            return Signal.HOLD

        if self._eg > self._exit_threshold:
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
        pass  # fundamental data static per session

    def metadata(self) -> StrategyMetadata:
        return StrategyMetadata(
            name="earnings_growth",
            version="1.0.0",
            author="builtin",
            description="EPS growth momentum: hold when quarterly earnings grow, exit when EPS declines past threshold. Set ticker param.",
            parameters={
                "ticker":               {"type": "str",   "default": "AAPL"},
                "exit_threshold_pct":   {"type": "float", "default": -5.0, "min": -30, "max": 0},
            },
        )
