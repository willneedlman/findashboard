"""Flexible ingestion: turn heterogeneous sources into the engine's array
contracts. Dependent (Y) and independent (X) series load independently and are
aligned on a shared index before regression, so a strategy's returns and a
benchmark pulled from different files line up by date.

Sources accepted by `load_frame`: a pandas DataFrame/Series (passthrough), a
path to a `.csv`/`.json` file, or a dict/records list. Prices are optionally
converted to log or simple returns.
"""
from __future__ import annotations

from typing import Any

import numpy as np
import pandas as pd

from .schemas import RegressionInput, SimulationPathData


def to_returns(values: np.ndarray, kind: str = "log", axis: int = -1) -> np.ndarray:
    """Price levels -> returns along `axis`. `kind` is 'log' or 'simple'.

    The output loses one observation along `axis` (the first has no predecessor).
    """
    v = np.asarray(values, dtype=float)
    prev = np.take(v, range(0, v.shape[axis] - 1), axis=axis)
    cur = np.take(v, range(1, v.shape[axis]), axis=axis)
    if kind == "log":
        return np.log(cur / prev)
    if kind == "simple":
        return cur / prev - 1.0
    raise ValueError("kind must be 'log' or 'simple'")


def load_frame(source: Any) -> pd.DataFrame:
    """Coerce a supported source into a DataFrame without transforming values."""
    if isinstance(source, pd.DataFrame):
        return source.copy()
    if isinstance(source, pd.Series):
        return source.to_frame()
    if isinstance(source, str):
        if source.lower().endswith(".csv"):
            return pd.read_csv(source, index_col=0)
        if source.lower().endswith(".json"):
            return pd.read_json(source)
        raise ValueError("file source must be .csv or .json")
    if isinstance(source, dict):
        return pd.DataFrame(source)
    if isinstance(source, (list, tuple)):
        return pd.DataFrame(list(source))
    raise TypeError(f"unsupported source type: {type(source).__name__}")


def regression_input_from_frames(
    y_source: Any,
    x_source: Any,
    y_col: str,
    x_cols: list[str],
    use_returns: bool = True,
    return_kind: str = "log",
) -> RegressionInput:
    """Align a dependent column and independent columns (possibly from separate
    sources) on their shared index, optionally convert to returns, drop NaN rows."""
    ydf, xdf = load_frame(y_source), load_frame(x_source)
    merged = pd.concat([ydf[[y_col]], xdf[x_cols]], axis=1)
    merged = merged.loc[:, ~merged.columns.duplicated()].dropna()
    if use_returns:
        merged = np.log(merged / merged.shift(1)) if return_kind == "log" \
            else (merged / merged.shift(1) - 1.0)
        # A zero/negative price makes log return -inf/NaN; dropna alone misses inf.
        merged = merged.replace([np.inf, -np.inf], np.nan).dropna()
    if len(merged) < len(x_cols) + 2:
        raise ValueError("too few overlapping observations after alignment")
    return RegressionInput(
        y=merged[y_col].to_numpy(),
        X=merged[x_cols].to_numpy(),
        factor_names=list(x_cols),
        y_name=y_col,
        meta={"observations": int(len(merged)), "use_returns": use_returns},
    )


def simulation_from_matrices(
    strategy_paths: Any,
    market: Any,
    factor_names: list[str] | None = None,
    as_returns_kind: str | None = None,
) -> SimulationPathData:
    """Build `SimulationPathData` from a strategy path matrix (P, T) and a market
    factor that is either shared (T,) / (T, k) or per-path (P, T) / (P, T, k).

    `as_returns_kind` ('log'/'simple') converts price-level paths to returns first;
    pass None when the inputs are already returns.
    """
    S = np.asarray(strategy_paths, dtype=float)
    M = np.asarray(market, dtype=float)
    if as_returns_kind:
        p, t = S.shape[0], S.shape[1]
        S = to_returns(S, as_returns_kind, axis=1)
        M = to_returns(M, as_returns_kind, axis=_market_time_axis(M, p, t))
    names = factor_names or ["market"]
    return SimulationPathData(strategy_paths=S, factor_paths=M, factor_names=names)


def _market_time_axis(M: np.ndarray, p: int, t: int) -> int:
    """Axis along which a market factor array runs over time, using the strategy
    (P, T) shape to disambiguate a 2-D array (matches SimulationPathData rules)."""
    if M.ndim == 1:
        return 0
    if M.ndim == 3:
        return 1
    if M.shape == (p, t) and p != t:
        return 1
    if M.shape[0] == t:
        return 0
    if M.shape[0] == p:
        return 1
    raise ValueError(f"market shape {M.shape} matches neither (T,k) nor (P,T)")
