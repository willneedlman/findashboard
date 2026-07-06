"""Monte-Carlo path regression: regress each simulated strategy path against its
market factor(s) and aggregate the coefficients into distributions.

The point of the tool: a single historical beta hides how a strategy behaves
across futures. Running the regression per simulated path turns alpha, beta and
R^2 into probability distributions (an options-selling book, for instance, shows
a tight low beta in calm paths and a fat left tail of high-beta blow-ups).

`path_regression` dispatches on factor count: the single-benchmark case (the
overwhelmingly common one) is fully vectorized via `batch_single_factor`, so
10k paths cost one matrix pass, not 10k Python regressions. Multi-factor paths
fall back to a per-path `ols` loop.
"""
from __future__ import annotations

import numpy as np

from .ols import batch_single_factor, ols
from .schemas import (
    DistributionStats,
    PathRegressionResult,
    RegressionInput,
    SimulationPathData,
)


def path_regression(
    data: SimulationPathData, keep_per_path: bool = True,
) -> PathRegressionResult:
    """Regress every strategy path on its market factor(s); aggregate stats."""
    names = list(data.factor_names)

    if data.single_factor:
        x = data.factor_paths[:, 0] if data.shared else data.factor_paths[..., 0]
        res = batch_single_factor(data.strategy_paths, x)
        keep = ~res["degenerate"]
        alpha, beta, r2 = res["alpha"][keep], res["beta"][keep], res["r_squared"][keep]
        betas_by_factor = [beta]
        # Drop degenerate paths here too, so per_path matches the distributions
        # (equal length, no NaN — which would otherwise serialize as invalid JSON).
        per_path = {"alpha": alpha, "beta": beta, "r_squared": r2}
    else:
        alpha_l, r2_l, beta_l, failed = [], [], [], 0
        for p in range(data.n_paths):
            Xp = data.factor_paths if data.shared else data.factor_paths[p]
            try:
                out = ols(RegressionInput(data.strategy_paths[p], Xp, names))
            except (ValueError, np.linalg.LinAlgError):
                failed += 1
                continue
            alpha_l.append(out.alpha); r2_l.append(out.r_squared); beta_l.append(out.betas)
        alpha = np.asarray(alpha_l)
        r2 = np.asarray(r2_l)
        beta_mat = np.asarray(beta_l).reshape(-1, len(names)) if beta_l else np.empty((0, len(names)))
        betas_by_factor = [beta_mat[:, j] for j in range(len(names))]
        per_path = {"alpha": alpha, "r_squared": r2,
                    **{f"beta_{names[j]}": betas_by_factor[j] for j in range(len(names))}}

    n_failed = int(data.n_paths - alpha.size)
    return PathRegressionResult(
        n_paths=int(data.n_paths),
        n_obs=int(data.horizon),
        factor_names=names,
        alpha=DistributionStats.from_samples(alpha),
        betas=[DistributionStats.from_samples(b) for b in betas_by_factor],
        r_squared=DistributionStats.from_samples(r2),
        n_failed=n_failed,
        per_path=per_path if keep_per_path else None,
    )
