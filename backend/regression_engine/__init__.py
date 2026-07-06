"""Advanced strategy-regression / Monte-Carlo integration engine.

Pure NumPy/SciPy, no I/O. `ols` and `rolling_ols` cover static series; the
Monte-Carlo layer regresses each simulated strategy path against its market
factor and aggregates alpha/beta/R^2 into distributions.
"""
from .ingest import (
    load_frame,
    regression_input_from_frames,
    simulation_from_matrices,
    to_returns,
)
from .montecarlo import path_regression
from .ols import batch_single_factor, ols, rolling_ols
from .schemas import (
    DistributionStats,
    PathRegressionResult,
    RegressionInput,
    RegressionOutputs,
    SimulationPathData,
)

__all__ = [
    "RegressionInput", "SimulationPathData", "RegressionOutputs",
    "PathRegressionResult", "DistributionStats",
    "ols", "batch_single_factor", "rolling_ols", "path_regression",
    "to_returns", "load_frame", "regression_input_from_frames", "simulation_from_matrices",
]
