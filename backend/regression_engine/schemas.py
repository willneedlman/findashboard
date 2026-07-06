"""Data contracts for the strategy-regression / Monte-Carlo integration engine.

Everything here is pure data — NumPy arrays plus light dataclasses. No I/O, no
pandas, no HTTP. The router and the demo script own serialization; the engine
only speaks arrays so it stays trivially unit-testable and fast.

Shapes (T = observations, k = factors, P = simulation paths):
  RegressionInput.X       (T, k)
  RegressionInput.y       (T,)
  SimulationPathData.strategy_paths   (P, T)
  SimulationPathData.factor_paths     (P, T, k) or (T, k) when shared by every path
"""
from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np


@dataclass
class RegressionInput:
    """One dependent series regressed on k factors.

    `y` is the outcome (a strategy's realized/simulated returns); `X` holds the
    independent factors (market index returns, macro factors, other assets).
    `meta` carries free-form strategy context that never enters the math.
    """

    y: np.ndarray
    X: np.ndarray
    factor_names: list[str]
    y_name: str = "y"
    meta: dict = field(default_factory=dict)

    def __post_init__(self) -> None:
        self.y = np.asarray(self.y, dtype=float).ravel()
        self.X = np.asarray(self.X, dtype=float)
        if self.X.ndim == 1:
            self.X = self.X.reshape(-1, 1)
        if self.X.shape[0] != self.y.shape[0]:
            raise ValueError(f"X has {self.X.shape[0]} rows but y has {self.y.shape[0]}")
        if self.X.shape[1] != len(self.factor_names):
            raise ValueError(f"{self.X.shape[1]} factors but {len(self.factor_names)} names")


@dataclass
class SimulationPathData:
    """N simulated strategy paths and the market factor(s) each is regressed on.

    `factor_paths` is normalized in `__post_init__` to one of two internal forms
    keyed off the known (P, T) strategy shape:
      shared    (T, k)     — one benchmark reused for every path.
      per-path  (P, T, k)  — a co-simulated market realization per path.
    Accepted inputs: 1-D (T,) shared single factor; 2-D (P, T) per-path single
    factor or (T, k) shared; 3-D (P, T, k) per-path. A 2-D array shaped exactly
    (P, T) is read as per-path (including the square P == T case); a shared basket
    must therefore differ from (P, T), which it does whenever the factor count
    k != T. Use the 1-D or 3-D forms for the unambiguous shared/per-path intent.
    """

    strategy_paths: np.ndarray
    factor_paths: np.ndarray
    factor_names: list[str] = field(default_factory=lambda: ["market"])
    per_path: bool = field(init=False, default=False)

    def __post_init__(self) -> None:
        self.strategy_paths = np.asarray(self.strategy_paths, dtype=float)
        if self.strategy_paths.ndim != 2:
            raise ValueError("strategy_paths must be 2-D (P, T)")
        p, t = self.strategy_paths.shape
        f = np.asarray(self.factor_paths, dtype=float)

        if f.ndim == 1:                                   # (T,) shared single factor
            if f.shape[0] != t:
                raise ValueError("shared factor length must match horizon T")
            f = f.reshape(t, 1); self.per_path = False
        elif f.ndim == 3:                                 # (P, T, k) per-path
            if f.shape[:2] != (p, t):
                raise ValueError("per-path factor_paths must be (P, T, k)")
            self.per_path = True
        elif f.ndim == 2:
            if f.shape == (p, t):                         # (P, T) per-path single factor
                f = f.reshape(p, t, 1); self.per_path = True
            elif f.shape[0] == t:                         # (T, k) shared
                self.per_path = False
            else:
                raise ValueError(f"factor_paths shape {f.shape} matches neither (T,k) nor (P,T)")
        else:
            raise ValueError("factor_paths must be 1-, 2-, or 3-D")

        self.factor_paths = f
        if f.shape[-1] != len(self.factor_names):
            raise ValueError("factor_names length must match factor count k")

    @property
    def n_paths(self) -> int:
        return self.strategy_paths.shape[0]

    @property
    def horizon(self) -> int:
        return self.strategy_paths.shape[1]

    @property
    def n_factors(self) -> int:
        return self.factor_paths.shape[-1]

    @property
    def shared(self) -> bool:
        """True when one market series is reused for every path."""
        return not self.per_path

    @property
    def single_factor(self) -> bool:
        return self.n_factors == 1


@dataclass
class RegressionOutputs:
    """OLS results for a single regression."""

    alpha: float                 # intercept
    betas: np.ndarray            # (k,) slope per factor
    factor_names: list[str]
    r_squared: float
    adj_r_squared: float
    std_errors: np.ndarray       # (k+1,) intercept then betas
    t_stats: np.ndarray          # (k+1,)
    p_values: np.ndarray         # (k+1,)
    n_obs: int
    f_stat: float | None = None
    residuals: np.ndarray | None = None

    def to_dict(self, include_residuals: bool = False) -> dict:
        out = {
            "alpha": round(float(self.alpha), 8),
            "alpha_p": round(float(self.p_values[0]), 8),
            "betas": [round(float(b), 8) for b in self.betas],
            "factor_names": list(self.factor_names),
            "r_squared": round(float(self.r_squared), 6),
            "adj_r_squared": round(float(self.adj_r_squared), 6),
            "std_errors": [round(float(s), 8) for s in self.std_errors],
            "t_stats": [round(float(t), 4) for t in self.t_stats],
            "p_values": [round(float(p), 8) for p in self.p_values],
            "n_obs": int(self.n_obs),
            "f_stat": None if self.f_stat is None else round(float(self.f_stat), 4),
        }
        if include_residuals and self.residuals is not None:
            out["residuals"] = [round(float(r), 8) for r in self.residuals]
        return out


@dataclass
class DistributionStats:
    """Summary of one statistic across many Monte-Carlo paths."""

    mean: float
    std: float
    min: float
    p5: float
    p25: float
    p50: float
    p75: float
    p95: float
    max: float
    prob_positive: float         # share of paths with a value > 0

    @classmethod
    def from_samples(cls, values: np.ndarray) -> "DistributionStats":
        v = np.asarray(values, dtype=float)
        v = v[np.isfinite(v)]
        if v.size == 0:
            return cls(*([float("nan")] * 9), prob_positive=float("nan"))
        q = np.percentile(v, [5, 25, 50, 75, 95])
        return cls(
            mean=float(v.mean()), std=float(v.std(ddof=1) if v.size > 1 else 0.0),
            min=float(v.min()), p5=float(q[0]), p25=float(q[1]), p50=float(q[2]),
            p75=float(q[3]), p95=float(q[4]), max=float(v.max()),
            prob_positive=float((v > 0).mean()),
        )

    def to_dict(self) -> dict:
        return {k: (None if v != v else round(float(v), 8)) for k, v in self.__dict__.items()}


@dataclass
class PathRegressionResult:
    """Aggregated regression statistics across all simulation paths.

    `alpha` and `r_squared` are scalar distributions; `betas` is one
    distribution per factor. `per_path` optionally carries the raw per-path
    arrays so callers can build histograms.
    """

    n_paths: int
    n_obs: int
    factor_names: list[str]
    alpha: DistributionStats
    betas: list[DistributionStats]
    r_squared: DistributionStats
    n_failed: int = 0            # paths dropped for degeneracy (zero-variance factor)
    per_path: dict[str, np.ndarray] | None = None

    def to_dict(self, include_per_path: bool = False) -> dict:
        out = {
            "n_paths": int(self.n_paths),
            "n_obs": int(self.n_obs),
            "n_failed": int(self.n_failed),
            "factor_names": list(self.factor_names),
            "alpha": self.alpha.to_dict(),
            "betas": [b.to_dict() for b in self.betas],
            "r_squared": self.r_squared.to_dict(),
        }
        if include_per_path and self.per_path is not None:
            out["per_path"] = {k: [round(float(x), 8) for x in v] for k, v in self.per_path.items()}
        return out
