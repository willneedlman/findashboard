"""
Strategy interface contract.

All user-supplied and builtin strategies must subclass Strategy and implement
the three abstract methods below.  The engine never calls anything else on an
imported strategy object; all other methods are opt-in.

Data contract
─────────────
on_data() receives a single MarketDataPoint per tick.  The engine guarantees
the fields are populated and that price/size are finite, positive floats.
"""

from __future__ import annotations

import abc
from dataclasses import dataclass, field
from enum import Enum
from typing import Any


class Signal(str, Enum):
    BUY  = "BUY"
    SELL = "SELL"
    HOLD = "HOLD"


@dataclass(frozen=True)
class MarketDataPoint:
    """Normalized tick passed to every strategy on each event."""
    timestamp: float        # UTC epoch seconds
    symbol:    str          # uppercase ticker, e.g. "AAPL"
    price:     float        # last trade / mid price
    size:      float        # trade size or 0.0 for quotes
    side:      str = ""     # "buy" | "sell" | "trade" | ""

    def __post_init__(self) -> None:
        if self.price <= 0:
            raise ValueError(f"MarketDataPoint price must be positive, got {self.price}")
        if self.size < 0:
            raise ValueError(f"MarketDataPoint size must be >= 0, got {self.size}")


@dataclass
class StrategyMetadata:
    """Returned by Strategy.metadata() so the engine can log provenance."""
    name:        str
    version:     str                    = "0.1.0"
    author:      str                    = "unknown"
    description: str                    = ""
    parameters:  dict[str, Any]        = field(default_factory=dict)


@dataclass
class SignalEvent:
    """What the engine records for every on_data() call."""
    strategy_name: str
    timestamp:     float
    symbol:        str
    signal:        Signal
    price:         float
    notes:         str = ""


class Strategy(abc.ABC):
    """
    Abstract base class every strategy must implement.

    Lifecycle called by the engine:
        1. initialize(params)   — once, before replay starts
        2. on_data(point)       — once per tick, returns Signal
        3. reset()              — between separate replay runs (optional)
        4. metadata()           — called at registration time; must be pure
    """

    # ── Required ──────────────────────────────────────────────────────────────

    @abc.abstractmethod
    def initialize(self, params: dict[str, Any]) -> None:
        """
        Set up internal state, indicators, and lookback buffers.

        params is the dict provided at registration time.  Store a reference
        if the strategy needs to refer to its own parameters later.
        """

    @abc.abstractmethod
    def on_data(self, data_point: MarketDataPoint) -> Signal:
        """
        Core signal logic.  Called once per market tick.

        Must return Signal.BUY, Signal.SELL, or Signal.HOLD.
        Must not raise — return Signal.HOLD on any internal error.
        Must be stateless w.r.t. anything outside self (no file I/O, no HTTP).
        """

    @abc.abstractmethod
    def metadata(self) -> StrategyMetadata:
        """
        Return static metadata.  Called once at load time.

        Must be a pure function — no side effects, no I/O.
        """

    # ── Optional ──────────────────────────────────────────────────────────────

    def reset(self) -> None:
        """
        Called between replay runs.  Re-implement to clear buffers/state.
        Default is a no-op; strategies that keep rolling windows must override.
        """
