"""Portfolio optimizer / risk tool.

Mean-variance (Markowitz) optimization plus risk-parity and the naive baselines,
computed from historical daily returns. Returns the four canonical portfolios
(max-Sharpe, min-variance, risk-parity, equal-weight), the long-only efficient
frontier, and per-asset risk decomposition + tail risk (VaR/CVaR) for the
tangency portfolio. Reuses the cached batch download; scipy SLSQP does the
constrained optimization.
"""
import logging

import numpy as np
import pandas as pd
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field, model_validator
import sys, os
sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))
from cache import get_download
from validation import validate_tickers, validate_date

logger = logging.getLogger(__name__)
router = APIRouter()

_TRADING_DAYS = 252


class OptimizeRequest(BaseModel):
    tickers: list[str] = Field(min_length=2, max_length=20)
    start: str = "2021-01-01"
    end: str = "2025-12-31"
    risk_free_rate: float = 4.0      # annual %, for Sharpe + tangency
    long_only: bool = True           # False allows shorts (weights in [-1, 1])
    # Optional current portfolio: {ticker: weight} (any scale, normalized) → scored
    # and plotted against the optimum so the user sees where they sit.
    weights: dict[str, float] | None = None

    @model_validator(mode="after")
    def _validate(self):
        self.tickers = validate_tickers(self.tickers)
        validate_date(self.start)
        validate_date(self.end)
        return self


def _aligned_returns(tickers: list[str], start: str, end: str) -> tuple[pd.DataFrame, list[str]]:
    """Date-aligned daily simple returns for the cohort of tickers that share a
    long window. A recently-listed name would otherwise collapse the inner join
    (intersection) to its short history and wreck the annualized figures, so any
    ticker with far less history than the longest is dropped and reported."""
    raw = get_download(tuple(sorted(tickers)), start, end)
    if raw is None or raw.empty:
        raise HTTPException(404, "No price data for the selected tickers and range")
    if isinstance(raw.columns, pd.MultiIndex):
        raw = raw["Close"] if "Close" in raw.columns.get_level_values(0) else raw.iloc[:, :len(tickers)]
    if isinstance(raw, pd.Series):
        raw = raw.to_frame(tickers[0])
    raw = raw.dropna(how="all").dropna(axis=1, how="all")

    # Drop short-history outliers before the intersection join.
    spans = {t: int(raw[t].dropna().shape[0]) for t in raw.columns}
    dropped: list[str] = []
    if spans:
        thresh = max(120, int(0.5 * max(spans.values())))
        keep = [t for t in raw.columns if spans[t] >= thresh]
        dropped = [str(t) for t in raw.columns if t not in keep]
        if len(keep) >= 2:
            raw = raw[keep]

    returns = raw.dropna().pct_change().dropna()
    if len(returns) < 30 or returns.shape[1] < 2:
        raise HTTPException(422, "Not enough overlapping history to optimize (need ~30+ shared days and 2+ names with a long-enough common window)")
    return returns, dropped


def _port_stats(w: np.ndarray, mu: np.ndarray, cov: np.ndarray, rf: float) -> dict:
    ret = float(w @ mu)
    vol = float(np.sqrt(max(w @ cov @ w, 1e-12)))
    return {"return": ret, "vol": vol, "sharpe": (ret - rf) / vol if vol > 0 else 0.0}


def _solve(objective, n: int, long_only: bool, extra=None):
    from scipy.optimize import minimize
    # Long-only: keep EVERY holding with a small positive floor rather than zeroing
    # names out (the user asked the optimizer not to drop holdings). The floor
    # scales down for large baskets so it stays feasible against the sum=1 budget.
    floor = min(0.01, 0.5 / n)
    bounds = [(floor, 1.0)] * n if long_only else [(-1.0, 1.0)] * n
    cons = [{"type": "eq", "fun": lambda w: np.sum(w) - 1.0}]
    if extra:
        cons.append(extra)
    res = minimize(objective, np.repeat(1.0 / n, n), method="SLSQP",
                   bounds=bounds, constraints=cons, options={"maxiter": 500, "ftol": 1e-9})
    w = res.x
    if not long_only:
        w[np.abs(w) < 1e-4] = 0.0     # clean up dust only when shorts are allowed
    s = w.sum()
    return w / s if s != 0 else np.repeat(1.0 / n, n)


def _max_sharpe(mu, cov, rf, long_only):
    def neg_sharpe(w):
        vol = np.sqrt(max(w @ cov @ w, 1e-12))
        return -(w @ mu - rf) / vol
    return _solve(neg_sharpe, len(mu), long_only)


def _min_variance(cov, long_only):
    return _solve(lambda w: w @ cov @ w, cov.shape[0], long_only)


def _risk_parity(cov):
    # Long-only equal risk contribution: minimize dispersion of the per-asset
    # risk contributions w_i·(Σw)_i. (Shorts make risk parity ill-defined.)
    n = cov.shape[0]

    def obj(w):
        port_var = w @ cov @ w
        rc = w * (cov @ w)
        target = port_var / n
        return float(np.sum((rc - target) ** 2))

    return _solve(obj, n, long_only=True)


def _frontier(mu, cov, rf, long_only, points: int = 24):
    """Min-variance portfolio at each of `points` target returns → (vol, ret)."""
    from scipy.optimize import minimize
    lo, hi = float(mu.min()), float(mu.max())
    targets = np.linspace(lo, hi, points)
    n = len(mu)
    bounds = [(0.0, 1.0)] * n if long_only else [(-1.0, 1.0)] * n
    out = []
    for t in targets:
        cons = [{"type": "eq", "fun": lambda w: np.sum(w) - 1.0},
                {"type": "eq", "fun": lambda w, t=t: w @ mu - t}]
        res = minimize(lambda w: w @ cov @ w, np.repeat(1.0 / n, n), method="SLSQP",
                       bounds=bounds, constraints=cons, options={"maxiter": 400, "ftol": 1e-9})
        if res.success:
            vol = float(np.sqrt(max(res.x @ cov @ res.x, 1e-12)))
            out.append({"vol": round(vol * 100, 3), "return": round(t * 100, 3),
                        "sharpe": round((t - rf) / vol, 3) if vol > 0 else 0.0})
    return out


def _weights_out(tickers, w, cov):
    """Per-asset weight + share of portfolio risk (risk contribution)."""
    port_var = float(w @ cov @ w) or 1e-12
    marginal = cov @ w
    out = []
    for i, t in enumerate(tickers):
        rc = float(w[i] * marginal[i]) / port_var       # fraction of variance
        out.append({"ticker": t, "weight": round(float(w[i]) * 100, 2),
                    "risk_contribution": round(rc * 100, 2)})
    return sorted(out, key=lambda x: -abs(x["weight"]))


def _tail_risk(returns: pd.DataFrame, w: np.ndarray, conf: float = 0.95) -> dict:
    """Historical 1-day VaR/CVaR of the weighted portfolio return series (%)."""
    port = returns.to_numpy() @ w
    q = float(np.quantile(port, 1 - conf))
    cvar = float(port[port <= q].mean()) if np.any(port <= q) else q
    return {"var_95": round(-q * 100, 3), "cvar_95": round(-cvar * 100, 3),
            "max_drawdown": round(_max_dd(port) * 100, 2)}


def _max_dd(daily: np.ndarray) -> float:
    curve = np.cumprod(1 + daily)
    peak = np.maximum.accumulate(curve)
    return float((curve / peak - 1).min())


def _port_payload(w, tickers, mu, cov, rf, returns):
    stats = _port_stats(w, mu, cov, rf)
    return {
        "return": round(stats["return"] * 100, 2),
        "vol": round(stats["vol"] * 100, 2),
        "sharpe": round(stats["sharpe"], 3),
        "weights": _weights_out(tickers, w, cov),
        **_tail_risk(returns, w),
    }


@router.post("/optimize")
def optimize(req: OptimizeRequest):
    returns, dropped = _aligned_returns(req.tickers, req.start, req.end)
    tickers = list(returns.columns)
    rf = req.risk_free_rate / 100.0

    # Geometric (compound) annualized return per asset — the realized return.
    # Arithmetic mean × 252 massively overstates volatile names (volatility drag),
    # which inflated the expected-return stat and the frontier's top end.
    mu = np.expm1(np.log1p(returns.clip(lower=-0.99)).mean().to_numpy() * _TRADING_DAYS)
    cov = returns.cov().to_numpy() * _TRADING_DAYS               # annualized covariance
    n = len(tickers)

    portfolios = {}
    for name, w in (
        ("max_sharpe", _max_sharpe(mu, cov, rf, req.long_only)),
        ("min_variance", _min_variance(cov, req.long_only)),
        ("risk_parity", _risk_parity(cov)),
        ("equal_weight", np.repeat(1.0 / n, n)),
    ):
        portfolios[name] = _port_payload(w, tickers, mu, cov, rf, returns)

    # Current portfolio: normalize the supplied weights and score them on the same
    # frontier so the user sees where their allocation sits vs the optimum.
    if req.weights:
        wmap = {str(k).upper(): float(v) for k, v in req.weights.items() if v}
        w_cur = np.array([wmap.get(t, 0.0) for t in tickers])
        if w_cur.sum() > 0:
            portfolios["current"] = _port_payload(w_cur / w_cur.sum(), tickers, mu, cov, rf, returns)

    return {
        "tickers": tickers,
        "dropped": dropped,
        "days": int(len(returns)),
        "span": {"start": str(returns.index[0].date()), "end": str(returns.index[-1].date())},
        "risk_free_rate": req.risk_free_rate,
        "long_only": req.long_only,
        "portfolios": portfolios,
        "frontier": _frontier(mu, cov, rf, req.long_only),
        "assets": [
            {"ticker": t, "return": round(float(mu[i]) * 100, 2),
             "vol": round(float(np.sqrt(cov[i, i])) * 100, 2)}
            for i, t in enumerate(tickers)
        ],
    }
