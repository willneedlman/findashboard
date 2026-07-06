"""Vectorized OLS execution engine.

Three entry points, cheapest first:

- `ols(X, y)`            one multi-factor regression with full inference.
- `batch_single_factor`  alpha/beta/R^2/t/p for P paths at once, no Python loop
                         over paths — closed-form column algebra. This is the hot
                         path for Monte-Carlo (thousands of single-benchmark runs).
- `rolling_ols`          a regression per sliding window to expose regime shifts.

p-values are two-sided Student-t. We compute coefficients with `lstsq` (SVD,
stable on near-collinear factors) and inference from the normal-equations
inverse, matching the existing `routers/regression.py` conventions.
"""
from __future__ import annotations

import numpy as np
from scipy import stats

from .schemas import RegressionInput, RegressionOutputs

_EPS = 1e-12


def ols(inp: RegressionInput, with_residuals: bool = False) -> RegressionOutputs:
    """Ordinary least squares of `y` on `[1, X]` with full inference."""
    X, y = inp.X, inp.y
    n, k = X.shape
    if n < k + 2:
        raise ValueError(f"need at least k+2={k + 2} observations, got {n}")

    Xa = np.column_stack([np.ones(n), X])
    coef, *_ = np.linalg.lstsq(Xa, y, rcond=None)
    resid = y - Xa @ coef
    sse = float(resid @ resid)
    sst = float(((y - y.mean()) ** 2).sum())
    r2 = 1.0 - sse / sst if sst > _EPS else 0.0
    dof = n - k - 1
    adj_r2 = 1.0 - (1.0 - r2) * (n - 1) / dof if dof > 0 else r2
    mse = sse / dof if dof > 0 else float("nan")

    try:
        xtx_inv = np.linalg.inv(Xa.T @ Xa)
        se = np.sqrt(np.maximum(np.diag(mse * xtx_inv), 0.0))
    except np.linalg.LinAlgError:
        se = np.full(k + 1, np.nan)

    with np.errstate(divide="ignore", invalid="ignore"):
        t_stats = coef / se
    p_values = 2.0 * stats.t.sf(np.abs(t_stats), df=max(dof, 1))
    f_stat = float(((sst - sse) / k) / mse) if k > 0 and mse > _EPS else None

    return RegressionOutputs(
        alpha=float(coef[0]), betas=coef[1:], factor_names=list(inp.factor_names),
        r_squared=r2, adj_r_squared=adj_r2, std_errors=se, t_stats=t_stats,
        p_values=p_values, n_obs=n, f_stat=f_stat,
        residuals=resid if with_residuals else None,
    )


def batch_single_factor(
    Y: np.ndarray, x: np.ndarray,
) -> dict[str, np.ndarray]:
    """Regress every row of `Y` (P, T) on one factor, fully vectorized.

    `x` is either shared `(T,)` — the same benchmark for all paths — or per-path
    `(P, T)`. Returns per-path arrays: alpha, beta, r_squared, se_alpha, se_beta,
    t_alpha, t_beta, p_alpha, p_beta, and a `degenerate` mask. A path is degenerate
    when either the factor or the outcome has ~zero variance (inference undefined);
    the caller counts and drops those.
    """
    Y = np.asarray(Y, dtype=float)
    P, T = Y.shape
    x = np.asarray(x, dtype=float)
    X = np.broadcast_to(x, (P, T)) if x.ndim == 1 else x
    if X.shape != (P, T):
        raise ValueError("x must be (T,) shared or (P, T) per-path")
    if T < 3:
        raise ValueError("need at least 3 observations per path")

    xbar = X.mean(axis=1, keepdims=True)
    ybar = Y.mean(axis=1, keepdims=True)
    xc, yc = X - xbar, Y - ybar
    sxx = (xc * xc).sum(axis=1)
    sxy = (xc * yc).sum(axis=1)
    syy = (yc * yc).sum(axis=1)

    degenerate = (sxx <= _EPS) | (syy <= _EPS)
    sxx_safe = np.where(sxx <= _EPS, np.nan, sxx)

    beta = sxy / sxx_safe
    alpha = ybar.ravel() - beta * xbar.ravel()
    sse = np.maximum(syy - beta * sxy, 0.0)
    with np.errstate(divide="ignore", invalid="ignore"):
        r2 = np.where(syy > _EPS, 1.0 - sse / syy, 0.0)
        mse = sse / (T - 2)
        se_beta = np.sqrt(mse / sxx_safe)
        se_alpha = np.sqrt(mse * (1.0 / T + xbar.ravel() ** 2 / sxx_safe))
        t_beta = beta / se_beta
        t_alpha = alpha / se_alpha

    p_beta = 2.0 * stats.t.sf(np.abs(t_beta), df=T - 2)
    p_alpha = 2.0 * stats.t.sf(np.abs(t_alpha), df=T - 2)

    return {
        "alpha": alpha, "beta": beta, "r_squared": r2,
        "se_alpha": se_alpha, "se_beta": se_beta,
        "t_alpha": t_alpha, "t_beta": t_beta,
        "p_alpha": p_alpha, "p_beta": p_beta,
        "degenerate": degenerate,
    }


def rolling_ols(
    inp: RegressionInput, window: int, step: int = 1,
) -> dict[str, np.ndarray]:
    """Rolling regression over a sliding lookback to surface regime shifts.

    Returns arrays aligned to the window END index: `end_idx`, `alpha`, per-factor
    `betas` (window_count, k), and `r_squared`. A single-factor input takes the
    vectorized path; multi-factor loops `ols` per window.
    """
    X, y = inp.X, inp.y
    n, k = X.shape
    if window < k + 2:
        raise ValueError(f"window must be >= k+2 ({k + 2})")
    if window > n:
        raise ValueError("window larger than the series")

    starts = np.arange(0, n - window + 1, step)
    ends = starts + window - 1

    if k == 1:
        Y = np.stack([y[s:s + window] for s in starts])
        Xw = np.stack([X[s:s + window, 0] for s in starts])
        res = batch_single_factor(Y, Xw)
        return {
            "end_idx": ends,
            "alpha": res["alpha"],
            "betas": res["beta"].reshape(-1, 1),
            "r_squared": res["r_squared"],
        }

    alphas, betas, r2s = [], [], []
    for s in starts:
        sub = RegressionInput(y[s:s + window], X[s:s + window], inp.factor_names)
        out = ols(sub)
        alphas.append(out.alpha); betas.append(out.betas); r2s.append(out.r_squared)
    return {
        "end_idx": ends,
        "alpha": np.asarray(alphas),
        "betas": np.asarray(betas),
        "r_squared": np.asarray(r2s),
    }
