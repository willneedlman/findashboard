"""Mock Monte-Carlo strategy-regression demo.

Simulates P paths of a systematic options-selling strategy (short-vol: collects
daily premium, gives up upside participation, and takes convex losses on sharp
down days) alongside a co-simulated S&P 500, then regresses every strategy path
against its own market path and reports the alpha / beta / R^2 distributions.

Run:  python -m scripts.mc_regression_demo          (from backend/)
      python scripts/mc_regression_demo.py --n-sims 1000 --horizon 252
"""
from __future__ import annotations

import argparse
import os
import sys
import time

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from regression_engine import (  # noqa: E402
    RegressionInput,
    SimulationPathData,
    ols,
    path_regression,
    rolling_ols,
)
from regression_engine.strategies import short_vol_paths  # noqa: E402

TRADING_DAYS = 252


def simulate(n_sims: int, horizon: int, seed: int) -> tuple[np.ndarray, np.ndarray]:
    """Return (strategy_paths, market_paths), each (n_sims, horizon) daily returns.

    Market: GBM daily returns. Strategy per day:
        r_strat = theta + participation * r_mkt - penalty * relu(-r_mkt - crash) + idio
    Premium `theta` is the alpha source; `participation` (<1) is the intended beta;
    the convex crash term is short gamma, which fattens the left tail and lifts
    realized beta in stressed paths; `idio` is basis risk that caps R^2 below 1.
    """
    rng = np.random.default_rng(seed)

    mkt_mu_ann, mkt_sig_ann = 0.08, 0.16
    mu_d = mkt_mu_ann / TRADING_DAYS
    sig_d = mkt_sig_ann / np.sqrt(TRADING_DAYS)
    market = mu_d + sig_d * rng.standard_normal((n_sims, horizon))

    strategy = short_vol_paths(
        market, premium=0.0008, participation=0.45, short_gamma=20.0,
        crash_threshold=0.005, idio_sigma=0.0010, rng=rng,
    )
    return strategy, market


def _fmt(d) -> str:
    return (f"mean={d.mean:+.4f}  sd={d.std:.4f}  "
            f"[p5 {d.p5:+.4f} | p50 {d.p50:+.4f} | p95 {d.p95:+.4f}]  "
            f"P(>0)={d.prob_positive:.2%}")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--n-sims", type=int, default=1000)
    ap.add_argument("--horizon", type=int, default=TRADING_DAYS)
    ap.add_argument("--seed", type=int, default=7)
    args = ap.parse_args()

    strat, mkt = simulate(args.n_sims, args.horizon, args.seed)

    t0 = time.perf_counter()
    result = path_regression(SimulationPathData(strat, mkt, ["SPX"]))
    dt = (time.perf_counter() - t0) * 1e3

    print(f"\nOptions-selling strategy vs mock S&P 500")
    print(f"  paths={result.n_paths}  obs/path={result.n_obs}  "
          f"regressed in {dt:.1f} ms  ({result.n_failed} degenerate)\n")
    print(f"  ALPHA (daily)  {_fmt(result.alpha)}")
    print(f"  BETA  (SPX)    {_fmt(result.betas[0])}")
    print(f"  R^2            {_fmt(result.r_squared)}")

    ann = result.alpha.mean * TRADING_DAYS
    print(f"\n  annualized mean alpha ~ {ann:+.2%}, mean beta ~ {result.betas[0].mean:.2f}")
    print(f"  left-tail beta (p95 of path betas) ~ {result.betas[0].p95:.2f} "
          f"-> short-gamma tail visible\n")

    # Pooled single regression (all paths flattened) for the static baseline.
    pooled = ols(RegressionInput(strat.ravel(), mkt.ravel().reshape(-1, 1), ["SPX"]))
    print(f"  pooled OLS: alpha={pooled.alpha:+.5f} (p={pooled.p_values[0]:.1e})  "
          f"beta={pooled.betas[0]:.3f}  R^2={pooled.r_squared:.3f}")

    # Rolling beta on the first path to show regime drift.
    roll = rolling_ols(RegressionInput(strat[0], mkt[0].reshape(-1, 1), ["SPX"]), window=63)
    b = roll["betas"][:, 0]
    print(f"  rolling beta (63d, path 0): min={np.nanmin(b):.2f} max={np.nanmax(b):.2f} "
          f"over {b.size} windows\n")


if __name__ == "__main__":
    main()
