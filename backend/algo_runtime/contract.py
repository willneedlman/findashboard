"""The strategy contract — the only surface generated code sees.

Narrow, but not narrower than the data. The rule DSL only ever consumed closes,
so the first version of this exposed only closes too — which made the contract a
cage shaped like the block system it was meant to replace. The fetch has always
returned full OHLCV (routers/strategy.build_aligned_frames), so code strategies
get open/high/low/volume and can express true ranges, gaps, volume regimes and
everything else the blocks could not say.

The rule that stands: publish nothing the engine cannot fill. A field this feed
lacks is all-NaN, and NaN comparisons are False, so a strategy reading it simply
never fires rather than trading on zeros.
"""
from __future__ import annotations

from dataclasses import dataclass, field, replace
from typing import Any, Mapping

import numpy as np

PRIMARY = "_PRIMARY_"


@dataclass(frozen=True)
class Ctx:
    """One backtest's world, as arrays. All series are date-aligned and equal length.

    close/open/high/low/volume   the traded symbol's bars, float64[n]
    index    bar timestamps, datetime64[ns][n] (None when the caller has no index)
    frames   {TICKER: close[n]} for cross-ticker conditions
    bars     {TICKER: {field: array[n]}} full OHLCV for every referenced symbol
    ctx      {TICKER: {METRIC: array[n] | float}} point-in-time fundamentals,
             liquidity and flow, already resolved by strategies/market_context
    params   tunable numbers, surfaced to the UI as sliders and to the optimizer
             as axes, so knobs stay machine-readable instead of buried in source
    """
    close: np.ndarray
    index: Any = None
    frames: Mapping[str, np.ndarray] = field(default_factory=dict)
    bars: Mapping[str, Mapping[str, np.ndarray]] = field(default_factory=dict)
    ctx: Mapping[str, Mapping[str, Any]] = field(default_factory=dict)
    primary: str = PRIMARY
    params: Mapping[str, float] = field(default_factory=dict)
    base_tf: str = "1d"

    def _field(self, name: str, ticker: str | None = None) -> np.ndarray:
        tk = (ticker or self.primary or PRIMARY).upper().strip()
        row = self.bars.get(tk) or {}
        arr = row.get(name)
        if arr is None:
            # No such field from this feed (some intraday sources omit volume).
            # All-NaN keeps comparisons False instead of trading on zeros.
            return self.close.astype(float) if name == "close" and tk == (self.primary or PRIMARY) \
                else np.full(self.n, np.nan)
        return np.asarray(arr, dtype=float)

    @property
    def open(self) -> np.ndarray:
        return self._field("open")

    @property
    def high(self) -> np.ndarray:
        return self._field("high")

    @property
    def low(self) -> np.ndarray:
        return self._field("low")

    @property
    def volume(self) -> np.ndarray:
        return self._field("volume")

    def bar(self, field_name: str, ticker: str | None = None) -> np.ndarray:
        """One OHLCV field for any referenced symbol: c.bar("high", "SPY")."""
        return self._field(str(field_name).lower().strip(), ticker)

    @property
    def n(self) -> int:
        return len(self.close)

    def frame(self, ticker: str | None = None) -> np.ndarray:
        """Close series for another symbol. Unknown symbol yields all-NaN so its
        condition never fires, rather than raising mid-backtest — same rule as
        the interpreter's _resolve_series."""
        tk = (ticker or self.primary or PRIMARY).upper().strip()
        arr = self.frames.get(tk)
        if arr is None:
            return self.close.astype(float) if tk == (self.primary or PRIMARY) else np.full(self.n, np.nan)
        return np.asarray(arr, dtype=float)

    def metric(self, name: str, ticker: str | None = None) -> np.ndarray:
        """Point-in-time context metric as a per-bar array. A float reading (live
        evaluation has no historical window) broadcasts; a missing one is NaN."""
        tk = (ticker or self.primary or PRIMARY).upper().strip()
        val = (self.ctx.get(tk) or {}).get(name)
        if isinstance(val, np.ndarray) and len(val) == self.n:
            return val.astype(float)
        if isinstance(val, (int, float)) and not (isinstance(val, float) and np.isnan(val)):
            return np.full(self.n, float(val), dtype=float)
        return np.full(self.n, np.nan, dtype=float)

    def param(self, name: str, default: float = 0.0) -> float:
        try:
            return float(self.params.get(name, default))
        except (TypeError, ValueError):
            return default

    def truncate(self, k: int) -> "Ctx":
        """First k bars only. The causality check (validate.L3) runs a strategy on
        a prefix and asserts the overlapping signals are unchanged, so this must
        cut every aligned series, not just close."""
        k = max(0, min(int(k), self.n))
        return replace(
            self,
            close=self.close[:k],
            index=None if self.index is None else self.index[:k],
            frames={t: np.asarray(a, dtype=float)[:k] for t, a in self.frames.items()},
            bars={t: {f: np.asarray(a, dtype=float)[:k] for f, a in (row or {}).items()}
                  for t, row in self.bars.items()},
            ctx={
                t: {
                    m: (v[:k] if isinstance(v, np.ndarray) and len(v) == self.n else v)
                    for m, v in (metrics or {}).items()
                }
                for t, metrics in self.ctx.items()
            },
        )


@dataclass(frozen=True)
class Signals:
    """What `signal()` returns. Bool arrays, one flag per bar.

    These are RAW per-bar conditions with no position-state tracking — exactly
    what evaluate_custom_rules(raw=True) produces. The P&L engines in algo.py
    track which lots are open and decide per lot whether `exits` closes it, so a
    single boolean here does not have to represent "3 lots open, 2 should close".
    """
    entries: np.ndarray
    exits: np.ndarray
    # Optional per-bar conviction, 0..1, multiplying the configured position
    # size on the bar an entry fires. None means "every entry full size", which
    # is exactly the old behaviour. See algo._size_multiplier.
    size: np.ndarray | None = None

    def as_raw(self) -> tuple[np.ndarray, np.ndarray]:
        """The (buy_signal, sell_signal) tuple algo.py already consumes."""
        return self.entries, self.exits


def ctx_from_frames(prices, frames=None, ctx_by_ticker=None, primary=None,
                    daily_index=None, base_tf="1d", params=None, ohlcv=None) -> Ctx:
    """Build a Ctx from evaluate_custom_rules' own argument shape, so a caller can
    swap signal producers without reshaping its data."""
    close = np.asarray(prices, dtype=float)
    prim = (primary or PRIMARY).upper().strip()
    return Ctx(
        close=close,
        index=daily_index,
        frames={t.upper(): np.asarray(a, dtype=float) for t, a in (frames or {prim: close}).items()},
        bars={t.upper(): {f: np.asarray(a, dtype=float) for f, a in (row or {}).items()}
              for t, row in (ohlcv or {}).items()},
        ctx=dict(ctx_by_ticker or {}),
        primary=prim,
        params=dict(params or {}),
        base_tf=base_tf or "1d",
    )
