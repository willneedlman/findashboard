"""Strategy path generators for the Monte-Carlo integration layer.

The regression engine itself is strategy-agnostic — it only regresses. These
helpers turn a matrix of simulated MARKET returns into a matrix of STRATEGY
returns with a known economic shape, so both the demo script and the API
endpoint co-simulate a strategy against its benchmark from one definition.
"""
from __future__ import annotations

import numpy as np


def short_vol_paths(
    market: np.ndarray,
    premium: float,
    participation: float,
    short_gamma: float,
    crash_threshold: float,
    idio_sigma: float,
    rng: np.random.Generator,
) -> np.ndarray:
    """Options-selling / short-vol proxy over a (P, T) market-returns matrix.

        r_strat = premium + participation * r_mkt
                  - short_gamma * relu(-r_mkt - crash_threshold)^2 + idio

    `premium` is the daily theta (the alpha source), `participation` is the
    intended linear beta (< 1), the convex term is short gamma (fattens the left
    tail and lifts realized beta on stressed paths), and `idio` is basis risk
    that keeps R^2 below 1. Returns a (P, T) strategy-returns matrix.
    """
    m = np.asarray(market, dtype=float)
    convex_loss = short_gamma * np.maximum(-m - crash_threshold, 0.0) ** 2
    idio = idio_sigma * rng.standard_normal(m.shape)
    return premium + participation * m - convex_loss + idio
