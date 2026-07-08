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
    return_model: str = "historical"  # "historical" (realized) | "capm" (forward)
    market_return: float = 10.0      # expected market return (annual %); ERP = this − rf
    # Optional current portfolio: {ticker: weight} (any scale, normalized) → scored
    # and plotted against the optimum so the user sees where they sit.
    weights: dict[str, float] | None = None

    @model_validator(mode="after")
    def _validate(self):
        self.tickers = validate_tickers(self.tickers)
        validate_date(self.start)
        validate_date(self.end)
        return self


def _aligned_returns(tickers: list[str], start: str, end: str,
                     require_long: bool = True) -> tuple[pd.DataFrame, list[str]]:
    """Date-aligned daily simple returns for the tickers that share a window.

    `require_long` (historical mode): a recently-listed name would collapse the
    inner join to its short history and wreck the ANNUALIZED returns, so anything
    far shorter than the longest is dropped and reported. CAPM mode sets it False —
    expected returns come from beta there, which only needs a modest sample, so a
    short-history name is kept (only genuinely tiny samples are dropped)."""
    raw = get_download(tuple(sorted(tickers)), start, end)
    if raw is None or raw.empty:
        raise HTTPException(404, "No price data for the selected tickers and range")
    if isinstance(raw.columns, pd.MultiIndex):
        raw = raw["Close"] if "Close" in raw.columns.get_level_values(0) else raw.iloc[:, :len(tickers)]
    if isinstance(raw, pd.Series):
        raw = raw.to_frame(tickers[0])
    raw = raw.dropna(how="all").dropna(axis=1, how="all")

    spans = {t: int(raw[t].dropna().shape[0]) for t in raw.columns}
    dropped: list[str] = []
    if spans:
        # Historical: needs a long window (floor 150d, or 40% of the longest).
        # CAPM: keep anything with enough to estimate a beta (floor 40d).
        thresh = max(150, int(0.4 * max(spans.values()))) if require_long else 40
        keep = [t for t in raw.columns if spans[t] >= thresh]
        dropped = [f"{t} ({spans[t]}d)" for t in raw.columns if t not in keep]
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
    """The EFFICIENT frontier: min-variance portfolio at each target return from the
    global minimum-variance return up to the max asset return. The branch below the
    min-variance point is inefficient (more risk for less return), so it's omitted."""
    from scipy.optimize import minimize
    lo = float(_min_variance(cov, long_only) @ mu)   # global min-variance return
    hi = float(mu.max())
    if hi <= lo:
        hi = lo + max(abs(lo) * 0.5, 0.01)
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


def _betas(tickers: list[str], start: str, end: str, benchmark: str = "SPY") -> dict[str, float]:
    """Beta of each ticker vs the market (SPY), measured over that ticker's OWN
    full history — NOT the truncated common window, which would make betas noise
    when a short-history name is in the basket (e.g. NFLX printing 0.07). Uses
    pandas pairwise-complete covariance, so each beta spans its longest overlap."""
    try:
        syms = tuple(sorted(set(tickers) | {benchmark}))
        raw = get_download(syms, start, end)
        if raw is None or raw.empty:
            return {}
        close = raw["Close"] if isinstance(raw.columns, pd.MultiIndex) and "Close" in raw.columns.get_level_values(0) else raw
        if isinstance(close, pd.Series):
            close = close.to_frame(syms[0])
        rets = close.pct_change()
        if benchmark not in rets.columns:
            return {}
        rm = rets[benchmark]
        out: dict[str, float] = {}
        for t in tickers:
            if t in rets.columns:
                pair = pd.concat([rets[t], rm], axis=1).dropna()
                if len(pair) >= 30:
                    vm = float(pair.iloc[:, 1].var()) or 1e-9
                    out[t] = float(pair.iloc[:, 0].cov(pair.iloc[:, 1])) / vm
        return out
    except Exception as e:
        logger.warning("beta computation failed: %s", e)
        return {}


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
    returns, dropped = _aligned_returns(req.tickers, req.start, req.end,
                                        require_long=(req.return_model != "capm"))
    tickers = list(returns.columns)
    rf = req.risk_free_rate / 100.0

    cov = returns.cov().to_numpy() * _TRADING_DAYS               # annualized covariance
    n = len(tickers)

    # Expected returns: realized (geometric, backward) or CAPM (rf + beta·ERP,
    # forward). CAPM smooths out a single asset's lucky/unlucky run.
    logret = np.log1p(returns.clip(lower=-0.99))
    hist_mu = np.expm1(logret.mean().to_numpy() * _TRADING_DAYS)          # annualized
    total_ret = np.expm1(logret.sum().to_numpy())                        # cumulative over window
    # Beta per asset over its OWN full history (computed regardless of model so the
    # popup can show it). CAPM expected return = rf + beta·(market_return − rf).
    beta_map = _betas(tickers, req.start, req.end)
    betas = np.array([beta_map.get(t, np.nan) for t in tickers])
    erp = (req.market_return - req.risk_free_rate) / 100.0
    if req.return_model == "capm" and beta_map:
        mu = rf + np.nan_to_num(betas, nan=1.0) * erp   # unknown beta → market beta 1
        model = "capm"
    else:
        mu, model = hist_mu, "historical"

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
        "market_return": req.market_return,
        "long_only": req.long_only,
        "return_model": model,
        "portfolios": portfolios,
        "frontier": _frontier(mu, cov, rf, req.long_only),
        "assets": [
            {"ticker": t, "return": round(float(mu[i]) * 100, 2),
             "total_return": round(float(total_ret[i]) * 100, 1),
             "vol": round(float(np.sqrt(cov[i, i])) * 100, 2),
             "beta": (None if np.isnan(betas[i]) else round(float(betas[i]), 2))}
            for i, t in enumerate(tickers)
        ],
    }
