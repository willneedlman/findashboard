"""
Regression Analysis — OLS linear, polynomial, and multi-variable regression
on financial time-series data from yfinance.

matplotlib generates the downloadable chart PNGs (imported lazily: it costs
tens of MB of RSS, and the 1GB VM has OOM'd before).
"""
import io, base64, logging, os, sys
import numpy as np
import pandas as pd
from scipy import stats

sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))
from cache import get_history
from sklearn.linear_model import LinearRegression
from sklearn.preprocessing import PolynomialFeatures
from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel, Field

from regression_engine import (
    RegressionInput, SimulationPathData, batch_single_factor,
    ols, path_regression, rolling_ols,
)
from regression_engine.strategies import short_vol_paths

_log = logging.getLogger(__name__)
router = APIRouter()

_VALID_PERIODS = {"1mo", "3mo", "6mo", "1y", "2y", "3y", "5y", "10y", "max"}
_VALID_MODELS  = {"linear", "polynomial"}


# ── Data layer ────────────────────────────────────────────────────────────────

def _fetch_series(ticker: str, period: str, use_returns: bool) -> pd.Series:
    ticker = ticker.upper().strip()
    df = get_history(ticker, period=period)
    if df.empty:
        raise HTTPException(404, f"No price data for {ticker}")
    closes = df["Close"].squeeze().dropna()
    if use_returns:
        return np.log(closes / closes.shift(1)).dropna().rename(ticker)
    return closes.rename(ticker)


# ── OLS statistics ────────────────────────────────────────────────────────────

def _ols_stats(X: np.ndarray, y: np.ndarray, model: LinearRegression) -> dict:
    n, k = X.shape
    y_pred = model.predict(X)
    residuals = y - y_pred

    sse = float(np.dot(residuals, residuals))
    sst = float(np.dot(y - y.mean(), y - y.mean()))
    r2 = 1.0 - sse / sst if sst > 0 else 0.0
    adj_r2 = 1.0 - (1.0 - r2) * (n - 1) / (n - k - 1) if n > k + 1 else r2

    mse = sse / (n - k - 1) if n > k + 1 else sse
    X_aug = np.column_stack([np.ones(n), X])
    try:
        cov_b = mse * np.linalg.inv(X_aug.T @ X_aug)
        se = np.sqrt(np.diag(cov_b))
    except np.linalg.LinAlgError:
        se = np.full(k + 1, float("nan"))

    coefs_full = np.concatenate([[model.intercept_], model.coef_])
    t_stats = coefs_full / se
    p_vals  = [2.0 * (1.0 - stats.t.cdf(abs(t), df=max(n - k - 1, 1))) for t in t_stats]

    f_stat: float | None = None
    if k > 0 and mse > 0:
        f_stat = round(((sst - sse) / k) / mse, 4)

    return {
        "r_squared":     round(r2, 6),
        "adj_r_squared": round(adj_r2, 6),
        "intercept":     round(float(model.intercept_), 8),
        "coefficients":  [round(float(c), 8) for c in model.coef_],
        "std_errors":    [round(float(s), 8) for s in se[1:]],
        "t_stats":       [round(float(t), 4) for t in t_stats[1:]],
        "p_values":      [round(float(p), 8) for p in p_vals[1:]],
        "intercept_p":   round(float(p_vals[0]), 8),
        "f_statistic":   f_stat,
        "mse":           round(mse, 8),
        "sse":           round(sse, 8),
        "observations":  n,
        "residuals":     [round(float(r), 8) for r in residuals],
    }


# ── Chart (matplotlib, terminal-palette colors) ───────────────────────────────

_DARK_BG   = "#101c2e"
_SURF_BG   = "#0d1826"
_GOLD      = "#c9a84c"
_TEXT      = "#d7e3fc"
_BLUE      = "#7aa2f7"
_PURPLE    = "#bb9af7"
_BORDER    = "#1e3a5f"


def _build_chart_b64(
    x_vals: list, y_vals: list, y_pred: list,
    x_label: str, y_label: str, title: str,
) -> str:
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt

    fig, (ax1, ax2) = plt.subplots(1, 2, figsize=(13, 5), facecolor=_DARK_BG)

    for ax in (ax1, ax2):
        ax.set_facecolor(_SURF_BG)
        ax.tick_params(colors=_TEXT, labelsize=8)
        ax.xaxis.label.set_color(_TEXT)
        ax.yaxis.label.set_color(_TEXT)
        ax.title.set_color(_GOLD)
        for sp in ax.spines.values():
            sp.set_edgecolor(_BORDER)

    x_arr = np.asarray(x_vals, dtype=float)
    y_arr = np.asarray(y_vals, dtype=float)
    p_arr = np.asarray(y_pred, dtype=float)
    res   = y_arr - p_arr

    ax1.scatter(x_arr, y_arr, color=_BLUE,   alpha=0.35, s=7, label="Data", zorder=2)
    sort_i = np.argsort(x_arr)
    ax1.plot(x_arr[sort_i], p_arr[sort_i], color=_GOLD, linewidth=2, label="Fit", zorder=3)
    ax1.set_xlabel(x_label); ax1.set_ylabel(y_label); ax1.set_title(title)
    ax1.legend(facecolor=_SURF_BG, labelcolor=_TEXT, fontsize=8)

    ax2.scatter(p_arr, res, color=_PURPLE, alpha=0.35, s=7, zorder=2)
    ax2.axhline(0.0, color=_GOLD, linewidth=1.4, linestyle="--", zorder=3)
    ax2.set_xlabel("Fitted"); ax2.set_ylabel("Residuals")
    ax2.set_title("Residual Plot")

    plt.tight_layout(pad=2.0)
    buf = io.BytesIO()
    plt.savefig(buf, format="png", dpi=110, bbox_inches="tight", facecolor=_DARK_BG)
    plt.close(fig)
    buf.seek(0)
    return base64.b64encode(buf.read()).decode()


# ── Request / response models ─────────────────────────────────────────────────

class RegressionRequest(BaseModel):
    y_ticker:      str
    x_tickers:    list[str]
    period:        str  = "2y"
    model_type:    str  = "linear"   # "linear" | "polynomial"
    degree:        int  = 2
    use_returns:   bool = True
    include_chart: bool = True


# ── Endpoints ─────────────────────────────────────────────────────────────────

@router.post("/analyze")
def regression_analyze(req: RegressionRequest):
    if not req.x_tickers:
        raise HTTPException(400, "x_tickers must contain at least one ticker")
    if req.period not in _VALID_PERIODS:
        raise HTTPException(400, f"period must be one of {_VALID_PERIODS}")
    if req.model_type not in _VALID_MODELS:
        raise HTTPException(400, f"model_type must be one of {_VALID_MODELS}")
    if req.degree < 1 or req.degree > 6:
        raise HTTPException(400, "degree must be between 1 and 6")

    y_series = _fetch_series(req.y_ticker, req.period, req.use_returns)
    x_series = [_fetch_series(t, req.period, req.use_returns) for t in req.x_tickers]

    df = pd.concat([y_series] + x_series, axis=1).dropna()
    if len(df) < 10:
        raise HTTPException(400, "Fewer than 10 overlapping data points — try a longer period")

    y     = df[req.y_ticker].values
    X_raw = df[req.x_tickers].values

    if req.model_type == "polynomial" and len(req.x_tickers) == 1:
        poly = PolynomialFeatures(degree=req.degree, include_bias=False)
        X_fit = poly.fit_transform(X_raw)
        feature_names = poly.get_feature_names_out([req.x_tickers[0]]).tolist()
    else:
        X_fit = X_raw
        feature_names = req.x_tickers.copy()

    mdl = LinearRegression().fit(X_fit, y)
    ols = _ols_stats(X_fit, y, mdl)
    y_pred = mdl.predict(X_fit).tolist()
    dates  = df.index.strftime("%Y-%m-%d").tolist()

    x_col = req.x_tickers[0]
    chart_b64 = None
    if req.include_chart:
        chart_b64 = _build_chart_b64(
            x_vals  = df[x_col].tolist(),
            y_vals  = y.tolist(),
            y_pred  = y_pred,
            x_label = x_col,
            y_label = req.y_ticker,
            title   = f"{req.y_ticker} ~ {' + '.join(req.x_tickers)} [{req.model_type}]",
        )

    return {
        "model_type":    req.model_type,
        "y_ticker":      req.y_ticker,
        "x_tickers":     req.x_tickers,
        "period":        req.period,
        "use_returns":   req.use_returns,
        "feature_names": feature_names,
        **ols,
        "data": {
            "dates":  dates,
            "y":      [round(float(v), 8) for v in y],
            "x":      [round(float(v), 8) for v in df[x_col].tolist()],
            "y_pred": [round(float(v), 8) for v in y_pred],
        },
        "chart_b64": chart_b64,
    }


class CorrelationRequest(BaseModel):
    tickers:        list[str]
    period:         str  = "2y"
    use_returns:    bool = True
    benchmark:      str | None = None
    rolling_window: int  = 60
    pair:           list[str] | None = None


@router.post("/correlation")
def regression_correlation(req: CorrelationRequest):
    """Cross-asset correlation across any basket of tickers (stocks/ETFs/crypto/
    indices). Returns the Pearson matrix, a diversification summary, per-asset beta
    vs an optional benchmark, and a rolling correlation series for one pair."""
    tickers = list(dict.fromkeys(t.upper().strip() for t in req.tickers if t.strip()))
    if len(tickers) < 2:
        raise HTTPException(400, "Provide at least 2 distinct tickers")
    if len(tickers) > 12:
        raise HTTPException(400, "Maximum 12 tickers")
    if req.period not in _VALID_PERIODS:
        raise HTTPException(400, f"period must be one of {_VALID_PERIODS}")
    if not 5 <= req.rolling_window <= 252:
        raise HTTPException(400, "rolling_window must be between 5 and 252")

    benchmark = req.benchmark.upper().strip() if req.benchmark else None
    fetch_list = list(tickers)
    if benchmark and benchmark not in fetch_list:
        fetch_list.append(benchmark)

    df = pd.concat([_fetch_series(t, req.period, req.use_returns) for t in fetch_list], axis=1)
    df = df.loc[:, ~df.columns.duplicated()].dropna()
    if len(df) < 10:
        raise HTTPException(400, "Fewer than 10 overlapping data points — try a longer period")

    corr_df = df[tickers].corr()
    matrix = [
        {"row": t1, "col": t2, "value": round(float(corr_df.loc[t1, t2]), 4)}
        for t1 in tickers for t2 in tickers
    ]

    # Unique off-diagonal pairs drive the summary + interpretation.
    pairs = [
        {"a": tickers[i], "b": tickers[j], "value": round(float(corr_df.iloc[i, j]), 4)}
        for i in range(len(tickers)) for j in range(i + 1, len(tickers))
    ]
    avg_abs = round(float(np.mean([abs(p["value"]) for p in pairs])), 4) if pairs else 0.0
    strongest = max(pairs, key=lambda p: p["value"]) if pairs else None
    most_negative = min(pairs, key=lambda p: p["value"]) if pairs else None

    # Per-asset beta + R² vs the benchmark (the bridge to the regression tab).
    betas = None
    if benchmark and benchmark in df.columns:
        bench = df[benchmark].values.reshape(-1, 1)
        betas = []
        for t in tickers:
            if t == benchmark:
                betas.append({"ticker": t, "beta": 1.0, "r_squared": 1.0})
                continue
            m = LinearRegression().fit(bench, df[t].values)
            betas.append({
                "ticker":    t,
                "beta":      round(float(m.coef_[0]), 4),
                "r_squared": round(float(m.score(bench, df[t].values)), 4),
            })

    # Rolling correlation + scatter for one pair — defaults to the strongest |r| pair.
    if req.pair and len(req.pair) == 2:
        pa, pb = req.pair[0].upper().strip(), req.pair[1].upper().strip()
    elif pairs:
        sp = max(pairs, key=lambda p: abs(p["value"]))
        pa, pb = sp["a"], sp["b"]
    else:
        pa = pb = None

    rolling = scatter = None
    if pa and pb and pa != pb and pa in df.columns and pb in df.columns:
        rc = df[pa].rolling(req.rolling_window).corr(df[pb]).dropna()
        rolling = {
            "pair":   [pa, pb],
            "window": req.rolling_window,
            "dates":  rc.index.strftime("%Y-%m-%d").tolist(),
            "corr":   [round(float(v), 4) for v in rc.values],
        }
        scatter = {
            "pair": [pa, pb],
            "x":    [round(float(v), 8) for v in df[pa].tolist()],
            "y":    [round(float(v), 8) for v in df[pb].tolist()],
        }

    return {
        "tickers":      tickers,
        "benchmark":    benchmark,
        "period":       req.period,
        "use_returns":  req.use_returns,
        "observations": int(len(df)),
        "matrix":       matrix,
        "pairs":        pairs,
        "summary": {
            "avg_abs_correlation": avg_abs,
            "strongest_pair":      strongest,
            "most_negative_pair":  most_negative,
        },
        "betas":   betas,
        "rolling": rolling,
        "scatter": scatter,
    }


@router.get("/quick")
def regression_quick(
    y:       str  = Query(..., description="Dependent variable ticker"),
    x:       str  = Query(..., description="Independent variable ticker"),
    period:  str  = Query("1y"),
    returns: bool = Query(True, description="Use log returns (True) or raw prices (False)"),
):
    """Single-variable OLS — quick endpoint for scatter chart."""
    req = RegressionRequest(
        y_ticker      = y,
        x_tickers     = [x],
        period        = period,
        model_type    = "linear",
        use_returns   = returns,
        include_chart = True,
    )
    return regression_analyze(req)


# ── Monte-Carlo strategy regression ──────────────────────────────────────────

class MCRegressionRequest(BaseModel):
    """Co-simulate a short-vol strategy against a benchmark calibrated from real
    history, then regress every path. Defaults describe a systematic options
    seller: collects premium, ~0.45 delta, convex losses on sharp down days."""
    benchmark:           str   = "SPY"
    period:              str   = "2y"
    n_sims:              int   = Field(default=1000, ge=50, le=3000)
    horizon_days:        int   = Field(default=252, ge=20, le=1260)
    premium_bps:         float = Field(default=8.0,  ge=0.0, le=100.0)   # daily theta
    participation:       float = Field(default=0.45, ge=-2.0, le=2.0)    # intended beta
    short_gamma:         float = Field(default=20.0, ge=0.0, le=200.0)   # convex penalty
    crash_threshold_bps: float = Field(default=50.0, ge=0.0, le=1000.0)
    idio_bps:            float = Field(default=10.0, ge=0.0, le=200.0)
    seed:                int | None = None


@router.post("/montecarlo")
def regression_montecarlo(req: MCRegressionRequest):
    """Distribution of alpha, beta and R^2 across simulated futures of a strategy."""
    if req.period not in _VALID_PERIODS:
        raise HTTPException(400, f"period must be one of {_VALID_PERIODS}")
    # Bound total simulated cells: the engine holds several (n_sims, horizon)
    # matrices at once and the prod VM runs on a tight memory budget.
    if req.n_sims * req.horizon_days > 1_000_000:
        raise HTTPException(400, "n_sims x horizon_days exceeds 1,000,000; reduce one to fit memory")

    bench = req.benchmark.upper().strip()
    rets = _fetch_series(bench, req.period, use_returns=True)
    if len(rets) < 30:
        raise HTTPException(400, f"Too little history for {bench} to calibrate")
    mu_d, sig_d = float(rets.mean()), float(rets.std())
    if sig_d <= 0:
        raise HTTPException(400, "Benchmark has zero volatility")

    rng = np.random.default_rng(req.seed)
    P, T = req.n_sims, req.horizon_days
    market = mu_d + sig_d * rng.standard_normal((P, T))
    strat = short_vol_paths(
        market, premium=req.premium_bps / 1e4, participation=req.participation,
        short_gamma=req.short_gamma, crash_threshold=req.crash_threshold_bps / 1e4,
        idio_sigma=req.idio_bps / 1e4, rng=rng,
    )

    result = path_regression(SimulationPathData(strat, market, [bench]))
    # Pooled regression over all paths stacked. Reuse the vectorized single-factor
    # path (one row of P*T points) so no (P*T, 2) design matrix is allocated.
    flat_x, flat_y = market.ravel(), strat.ravel()
    pv = batch_single_factor(flat_y[None, :], flat_x)
    p_alpha, p_beta = float(pv["alpha"][0]), float(pv["beta"][0])
    window = min(T - 1, max(10, min(63, T // 3)))
    roll = rolling_ols(RegressionInput(strat[0], market[0].reshape(-1, 1), [bench]), window=window)

    # Downsample the pooled (market, strategy) return cloud for a scatter of the
    # regression itself, plus two points defining the fitted line. Sample with
    # replacement (dup probability is negligible) to avoid materializing a full
    # permutation of the millions-of-points population on the memory-tight VM.
    pick = np.arange(flat_x.size) if flat_x.size <= 1500 else rng.integers(0, flat_x.size, size=1500)
    sx = flat_x[pick]
    lo, hi = float(flat_x.min()), float(flat_x.max())

    ann = float(np.sqrt(252))
    return {
        "benchmark": bench,
        "n_sims": P,
        "horizon_days": T,
        "calibration": {
            "mu_annual": round(mu_d * 252, 4),
            "sigma_annual": round(sig_d * ann, 4),
            "observations": int(len(rets)),
        },
        "distributions": result.to_dict(include_per_path=True),
        "pooled": {
            "alpha": round(p_alpha, 8), "alpha_p": round(float(pv["p_alpha"][0]), 8),
            "beta": round(p_beta, 6), "r_squared": round(float(pv["r_squared"][0]), 6),
        },
        "scatter": {
            "x": [round(float(v), 6) for v in sx],
            "y": [round(float(v), 6) for v in flat_y[pick]],
            "line": [{"x": round(lo, 6), "y": round(p_alpha + p_beta * lo, 6)},
                     {"x": round(hi, 6), "y": round(p_alpha + p_beta * hi, 6)}],
        },
        "rolling_beta": {
            "window": window,
            "end_idx": [int(i) for i in roll["end_idx"]],
            "beta": [round(float(b), 6) for b in roll["betas"][:, 0]],
            "alpha": [round(float(a), 8) for a in roll["alpha"]],
        },
    }


class RollingRegressionRequest(BaseModel):
    y_ticker:    str
    x_ticker:    str
    period:      str = "2y"
    window:      int = Field(default=60, ge=10, le=252)
    use_returns: bool = True


@router.post("/rolling")
def regression_rolling(req: RollingRegressionRequest):
    """Rolling single-factor OLS (beta/alpha/R^2 over a sliding window) to expose
    regime shifts between two tickers."""
    if req.period not in _VALID_PERIODS:
        raise HTTPException(400, f"period must be one of {_VALID_PERIODS}")

    y = _fetch_series(req.y_ticker, req.period, req.use_returns)
    x = _fetch_series(req.x_ticker, req.period, req.use_returns)
    df = pd.concat([y, x], axis=1).dropna()
    df = df.loc[:, ~df.columns.duplicated()]
    if df.shape[1] < 2:
        raise HTTPException(400, "y_ticker and x_ticker must be different")
    if len(df) < req.window + 2:
        raise HTTPException(400, f"Need > {req.window + 2} overlapping points for this window")

    inp = RegressionInput(df.iloc[:, 0].to_numpy(), df.iloc[:, 1].to_numpy(), [req.x_ticker.upper()])
    roll = rolling_ols(inp, window=req.window)
    dates = df.index.strftime("%Y-%m-%d").to_numpy()
    return {
        "y_ticker": req.y_ticker.upper(), "x_ticker": req.x_ticker.upper(),
        "period": req.period, "window": req.window, "observations": int(len(df)),
        "series": [
            {"date": str(dates[int(e)]), "beta": round(float(b), 6),
             "alpha": round(float(a), 8), "r_squared": round(float(r), 6)}
            for e, b, a, r in zip(roll["end_idx"], roll["betas"][:, 0], roll["alpha"], roll["r_squared"])
        ],
    }


# ── Import real portfolio / algo-strategy returns and regress vs the market ───

class ImportHolding(BaseModel):
    ticker: str
    weight: float = 1.0


class ImportRegressionRequest(BaseModel):
    source:         str                          # "portfolio" | "algo"
    benchmark:      str = "SPY"
    period:         str = "2y"                    # portfolio path
    rolling_window: int = Field(default=60, ge=10, le=252)
    holdings:       list[ImportHolding] | None = None     # portfolio path
    ticker:         str | None = None                     # algo path
    rules:          dict | None = None                    # algo path
    start:          str | None = None
    end:            str | None = None


def _simple_returns(ticker: str, period: str) -> pd.Series:
    df = get_history(ticker.upper().strip(), period=period)
    if df.empty:
        raise HTTPException(404, f"No price data for {ticker}")
    return df["Close"].squeeze().dropna().pct_change().dropna()


def _portfolio_returns(holdings: list[ImportHolding], period: str) -> pd.Series:
    """Daily-rebalanced weighted return of a book (weights aggregated per ticker)."""
    agg: dict[str, float] = {}
    for h in holdings:
        agg[h.ticker.upper().strip()] = agg.get(h.ticker.upper().strip(), 0.0) + h.weight
    tickers = [t for t in agg if t]
    if not tickers:
        raise HTTPException(400, "No valid holdings")
    # Keep the sign so short legs contribute negatively; normalize by gross
    # exposure so a long/short book stays stable when net exposure is near zero.
    w = np.array([agg[t] for t in tickers], dtype=float)
    gross = float(np.abs(w).sum())
    w = w / gross if gross > 0 else np.full(len(tickers), 1.0 / len(tickers))
    df = pd.concat([_simple_returns(t, period) for t in tickers], axis=1).dropna()
    if df.empty:
        raise HTTPException(400, "No overlapping history across the holdings")
    return pd.Series(df.to_numpy() @ w, index=df.index, name="Y")


@router.post("/import")
def regression_import(req: ImportRegressionRequest):
    """Regress a real portfolio's or algo strategy's realized returns on the
    benchmark. Portfolios come from the holdings book; algo strategies are the
    saved custom-rule signals (no risk-control overlay applied here)."""
    if req.source not in ("portfolio", "algo"):
        raise HTTPException(400, "source must be 'portfolio' or 'algo'")
    if req.period not in _VALID_PERIODS:
        raise HTTPException(400, f"period must be one of {_VALID_PERIODS}")
    bench = req.benchmark.upper().strip()

    if req.source == "portfolio":
        if not req.holdings:
            raise HTTPException(400, "portfolio source needs holdings")
        y = _portfolio_returns(req.holdings, req.period)
        x = _simple_returns(bench, req.period)
        y_name = "Portfolio"
    else:
        if not req.ticker or not req.rules:
            raise HTTPException(400, "algo source needs ticker and rules")
        import datetime
        from .strategy import _fetch_close, evaluate_custom_rules
        from strategies.market_context import resolve_context
        start = req.start or "2022-01-01"
        end = req.end or datetime.date.today().isoformat()
        close = _fetch_close(req.ticker, start, end)
        if len(close) < 60:
            raise HTTPException(422, "Insufficient price history for the strategy")
        sig = evaluate_custom_rules(close.to_numpy().astype(float), req.rules, resolve_context(req.ticker, req.rules))
        signal = pd.Series(sig, index=close.index)
        # Yesterday's signal earns today's move (no look-ahead).
        y = (signal.shift(1).fillna(0.0) * close.pct_change()).dropna().rename("Y")
        x = _fetch_close(bench, start, end).pct_change().dropna()
        y_name = f"{req.ticker.upper().strip()} strategy"

    df = pd.concat([y.rename("Y"), x.rename(bench)], axis=1).dropna()
    if len(df) < max(10, req.rolling_window + 2):
        raise HTTPException(400, "Too few overlapping observations to regress")
    if float(df["Y"].std()) == 0.0:
        raise HTTPException(400, "The strategy has no return variation over this window (always in cash?)")
    if float(df[bench].std()) == 0.0:
        raise HTTPException(400, "Benchmark has zero volatility over this window")

    inp = RegressionInput(df["Y"].to_numpy(), df[bench].to_numpy().reshape(-1, 1), [bench])
    o = ols(inp, with_residuals=False)
    roll = rolling_ols(inp, window=req.rolling_window)
    # A window where the strategy sat entirely in cash has no beta; emit null so
    # the JSON stays valid and the chart shows a gap rather than a broken point.
    roll_beta = [None if not np.isfinite(b) else round(float(b), 6) for b in roll["betas"][:, 0]]
    dates = df.index.strftime("%Y-%m-%d").to_numpy()
    return {
        "source": req.source,
        "y_name": y_name,
        "benchmark": bench,
        "observations": int(len(df)),
        "alpha": round(o.alpha, 8),
        "alpha_annualized": round(o.alpha * 252, 6),
        "alpha_p": round(float(o.p_values[0]), 8),
        "beta": round(float(o.betas[0]), 6),
        "beta_p": round(float(o.p_values[1]), 8),
        "r_squared": round(o.r_squared, 6),
        "adj_r_squared": round(o.adj_r_squared, 6),
        "scatter": {
            "x": [round(float(v), 6) for v in df[bench].to_numpy()],
            "y": [round(float(v), 6) for v in df["Y"].to_numpy()],
            "line": [
                {"x": round(float(df[bench].min()), 6), "y": round(o.alpha + float(o.betas[0]) * float(df[bench].min()), 6)},
                {"x": round(float(df[bench].max()), 6), "y": round(o.alpha + float(o.betas[0]) * float(df[bench].max()), 6)},
            ],
        },
        "rolling_beta": {
            "window": req.rolling_window,
            "dates": [str(dates[int(e)]) for e in roll["end_idx"]],
            "beta": roll_beta,
        },
    }


# ── Pairs / spread trading (cointegration + z-score) ────────────────────────
# statsmodels is not installed, so the ADF t-stat and the OU half-life are
# computed directly with numpy. Critical values are the standard Dickey-Fuller
# constants (constant, no trend); the spread is a fitted residual so treat the
# test as indicative, not a formal Engle-Granger with corrected criticals.
_DF_CRIT = {"1%": -3.43, "5%": -2.86, "10%": -2.57}


def _ols_beta_se(X: np.ndarray, y: np.ndarray):
    """Return (coefs, std_errors) for y = X b with X already including a const."""
    b, *_ = np.linalg.lstsq(X, y, rcond=None)
    resid = y - X @ b
    n, k = X.shape
    dof = max(n - k, 1)
    s2 = float(resid @ resid) / dof
    try:
        se = np.sqrt(np.diag(s2 * np.linalg.inv(X.T @ X)))
    except np.linalg.LinAlgError:
        se = np.full(k, float("nan"))
    return b, se, resid


def _adf_tstat(y: np.ndarray, lags: int = 1):
    """ADF regression Δy = c + γ y_{t-1} + Σ φ_i Δy_{t-i}; return γ's t-stat."""
    dy = np.diff(y)
    n = len(dy)
    if n <= lags + 3:
        return None
    yl = y[lags:-1] if lags else y[:-1]
    rows = n - lags
    cols = [np.ones(rows), y[lags:len(y) - 1]]
    for i in range(1, lags + 1):
        cols.append(dy[lags - i:len(dy) - i])
    X = np.column_stack(cols)
    target = dy[lags:]
    b, se, _ = _ols_beta_se(X, target)
    gamma, se_g = b[1], se[1]
    return float(gamma / se_g) if se_g and not np.isnan(se_g) else None


def _rolling_hedge(la: np.ndarray, lb: np.ndarray, win: int):
    """Time-varying hedge ratio from a trailing-window OLS of la on lb. Leading
    points (before a full window) reuse the first fitted beta. Returns
    (spread, beta_series) where spread_t = la_t - (alpha_t + beta_t*lb_t)."""
    n = len(la)
    beta = np.full(n, np.nan); alpha = np.full(n, np.nan)
    for t in range(n):
        s = max(0, t - win + 1)
        m = t - s + 1
        if m < 20:
            continue
        Xw = np.column_stack([np.ones(m), lb[s:t + 1]])
        try:
            b, *_ = np.linalg.lstsq(Xw, la[s:t + 1], rcond=None)
        except np.linalg.LinAlgError:
            continue
        alpha[t], beta[t] = b[0], b[1]
    first = next((i for i in range(n) if not np.isnan(beta[i])), None)
    if first is None:
        raise HTTPException(422, "Not enough history for a rolling hedge fit")
    beta[:first] = beta[first]; alpha[:first] = alpha[first]
    return la - (alpha + beta * lb), beta


def _kalman_hedge(la: np.ndarray, lb: np.ndarray):
    """Kalman-filter hedge ratio (Chan's dynamic pairs setup): the state
    [slope, intercept] follows a random walk and is updated on each close. The
    spread is the one-step measurement innovation (no lookahead); the reported
    beta is the latest filtered slope. Warm-started from an OLS fit on the head."""
    n = len(la)
    warm = min(60, n)
    Xw = np.column_stack([lb[:warm], np.ones(warm)])
    try:
        b0, *_ = np.linalg.lstsq(Xw, la[:warm], rcond=None)
    except np.linalg.LinAlgError:
        b0 = np.array([1.0, 0.0])
    state = np.array([b0[0], b0[1]], dtype=float)
    resid0 = la[:warm] - Xw @ b0
    Ve = max(1e-6, float(np.var(resid0)))              # observation variance
    delta = 1e-4
    Vw = delta / (1 - delta)                            # state-drift variance
    P = np.zeros((2, 2))
    betas = np.full(n, np.nan); e = np.full(n, np.nan)
    for t in range(n):
        x = np.array([lb[t], 1.0])
        R = P + Vw * np.eye(2)                          # predicted state cov
        et = float(la[t] - x @ state)                  # innovation = spread
        Q = float(x @ R @ x + Ve)
        K = R @ x / Q                                   # Kalman gain
        state = state + K * et
        P = R - np.outer(K, x @ R)
        betas[t] = state[0]; e[t] = et
    return e, betas


def _half_life(spread: np.ndarray):
    """OU mean-reversion half-life from Δs = c + λ s_{t-1}. None if not reverting."""
    s_lag = spread[:-1]; ds = np.diff(spread)
    X = np.column_stack([np.ones(len(s_lag)), s_lag])
    b, _, _ = _ols_beta_se(X, ds)
    lam = b[1]
    if lam >= 0:
        return None
    return round(float(-np.log(2) / lam), 1)


@router.get("/pairs")
def pairs_analysis(
    a: str = Query(...), b: str = Query(...),
    lookback_days: int = Query(365, ge=90, le=14600),  # up to ~40y — as deep as yfinance goes
    entry_z: float = Query(2.0, ge=0.5, le=4.0),
    exit_z: float = Query(0.5, ge=0.0, le=3.0),
    z_window: int = Query(60, ge=10, le=250),
    costs_bps: float = Query(5.0, ge=0.0, le=100.0),
    hedge_method: str = Query("ols"),
):
    """Cointegration test, mean-reversion half-life, and a z-score backtest for a
    pair. The spread is log(A) - beta*log(B) with beta the OLS hedge ratio; the
    backtest goes long the spread below -entry_z, short above +entry_z, and flat
    inside exit_z, with a rolling z-window to limit lookahead."""
    a = a.upper().strip(); b = b.upper().strip()
    if not a or not b or a == b:
        raise HTTPException(400, "Provide two distinct tickers")
    period = "6mo" if lookback_days <= 190 else "1y" if lookback_days <= 380 else "2y" if lookback_days <= 760 else "5y"
    ca = _fetch_series(a, period, use_returns=False)
    cb = _fetch_series(b, period, use_returns=False)
    df = pd.concat([ca, cb], axis=1).dropna()
    if len(df) > lookback_days:
        df = df.iloc[-lookback_days:]
    if len(df) < max(60, z_window + 20):
        raise HTTPException(422, "Not enough overlapping history for this pair")

    la = np.log(df[a].to_numpy()); lb = np.log(df[b].to_numpy())
    method = hedge_method.lower()
    if method == "roll":
        hwin = min(120, max(40, len(la) // 5))
        spread, beta_series = _rolling_hedge(la, lb, hwin)
        beta = float(beta_series[-1])
    elif method == "kalman":
        spread, beta_series = _kalman_hedge(la, lb)
        beta = float(beta_series[-1])
    else:
        method = "ols"
        X = np.column_stack([np.ones(len(lb)), lb])
        (alpha, beta_ols), _, _ = _ols_beta_se(X, la)
        beta = float(beta_ols)
        spread = la - (alpha + beta * lb)

    ra = np.diff(la); rb = np.diff(lb)
    corr = float(np.corrcoef(ra, rb)[0, 1]) if len(ra) > 2 else None
    adf_t = _adf_tstat(spread, lags=1)
    stationary = adf_t is not None and adf_t < _DF_CRIT["5%"]
    half_life = _half_life(spread)

    sp = pd.Series(spread, index=df.index)
    roll_mean = sp.rolling(z_window).mean()
    roll_std = sp.rolling(z_window).std(ddof=0)
    z = ((sp - roll_mean) / roll_std).to_numpy()

    # Backtest: position in {-1,0,+1} on the spread, entered at |z|>=entry,
    # exited inside exit. dspread is the spread's daily change (the pair P&L per
    # unit long A / short beta*B). Position lags one day (no lookahead). Each
    # round-trip nets transaction costs: 2 legs, entered and exited, at costs_bps.
    dates = [str(d.date()) for d in df.index]
    dspread = np.diff(spread)
    trip_cost = 2 * 2 * (costs_bps / 1e4)           # 2 legs x (entry + exit)
    pos = np.zeros(len(z))
    cur = 0
    for i in range(len(z)):
        zi = z[i]
        if np.isnan(zi):
            pos[i] = 0; continue
        if cur == 0:
            if zi >= entry_z: cur = -1
            elif zi <= -entry_z: cur = 1
        elif abs(zi) <= exit_z:
            cur = 0
        pos[i] = cur
    gross = pos[:-1] * dspread                       # gross daily P&L (position into next move)

    # Walk the position path: record each round-trip, net costs at close, and
    # build a daily net-equity curve.
    equity = np.zeros(len(df))
    trade_recs, markers = [], []
    open_i, open_side, open_cum = None, 0, 0.0
    running = 0.0

    def _close(exit_i):
        nonlocal running
        cost = trip_cost
        net = open_cum - cost
        running_local = net
        trade_recs.append({
            "n": len(trade_recs) + 1,
            "entered": dates[open_i], "exited": dates[exit_i],
            "side": "long" if open_side > 0 else "short",
            "z_in": round(float(z[open_i]), 2), "z_out": round(float(z[exit_i]), 2),
            "days": exit_i - open_i,
            "pnl": round(net, 4), "open": False,
        })
        markers.append({"date": dates[open_i], "z": round(float(z[open_i]), 3),
                        "side": "long" if open_side > 0 else "short", "kind": "entry"})
        markers.append({"date": dates[exit_i], "z": round(float(z[exit_i]), 3), "kind": "exit"})
        return running_local

    for i in range(len(df)):
        if i > 0:
            running += gross[i - 1] if (i - 1) < len(gross) and not np.isnan(gross[i - 1]) else 0.0
        prev = pos[i - 1] if i > 0 else 0.0
        if pos[i] != prev:
            if prev != 0 and open_i is not None:      # a position just closed/flipped
                net = _close(i)
                running += -trip_cost                 # book the round-trip cost into equity
                open_i = None; open_cum = 0.0
            if pos[i] != 0:                            # a new position opened
                open_i, open_side, open_cum = i, pos[i], 0.0
        if pos[i] != 0 and i > 0 and (i - 1) < len(gross) and not np.isnan(gross[i - 1]):
            open_cum += gross[i - 1]
        equity[i] = running
    if open_i is not None:                             # mark an open position in the log
        trade_recs.append({
            "n": len(trade_recs) + 1, "entered": dates[open_i], "exited": None,
            "side": "long" if open_side > 0 else "short",
            "z_in": round(float(z[open_i]), 2), "z_out": None,
            "days": len(df) - 1 - open_i, "pnl": round(open_cum, 4), "open": True,
        })
        markers.append({"date": dates[open_i], "z": round(float(z[open_i]), 3),
                        "side": "long" if open_side > 0 else "short", "kind": "entry"})

    valid = ~np.isnan(gross)
    gnet = gross[valid]
    total = float(equity[-1])
    sharpe = float(np.mean(gnet) / np.std(gnet) * np.sqrt(252)) if gnet.size and np.std(gnet) > 0 else None
    exposure = float(np.mean(np.abs(pos[:-1][valid]))) if gnet.size else 0.0
    closed = [t for t in trade_recs if not t["open"]]
    wins = sum(1 for t in closed if t["pnl"] > 0)

    z_now = next((float(v) for v in z[::-1] if not np.isnan(v)), None)
    signal = "flat"
    if z_now is not None:
        if z_now >= entry_z: signal = "short_spread"
        elif z_now <= -entry_z: signal = "long_spread"

    # Downsample the z / equity / normalized-legs series to ~250 points.
    a_px = df[a].to_numpy(); b_px = df[b].to_numpy()
    a_norm = a_px / a_px[0] * 100; b_norm = b_px / b_px[0] * 100
    step = max(1, len(df) // 250)
    idxs = list(range(0, len(df), step))
    if idxs[-1] != len(df) - 1:
        idxs.append(len(df) - 1)
    series = [{"date": dates[i], "z": round(float(z[i]), 3) if not np.isnan(z[i]) else None} for i in idxs]
    equity_series = [{"date": dates[i], "v": round(float(equity[i]) * 100, 3)} for i in idxs]   # % of gross
    legs_series = [{"date": dates[i], "a": round(float(a_norm[i]), 2), "b": round(float(b_norm[i]), 2)} for i in idxs]

    return {
        "a": a, "b": b, "hedge_ratio": round(float(beta), 4), "correlation": round(corr, 3) if corr is not None else None,
        "adf": {"stat": round(adf_t, 3) if adf_t is not None else None, "crit_5": _DF_CRIT["5%"], "stationary": bool(stationary)},
        "half_life_days": half_life,
        "zscore": {"current": round(z_now, 2) if z_now is not None else None, "entry": entry_z, "exit": exit_z, "window": z_window},
        "signal": signal,
        "hedge_method": method,
        "costs_bps": costs_bps,
        "last": {"a": round(float(a_px[-1]), 2), "b": round(float(b_px[-1]), 2)},
        "leg_return": {"a": round(float(a_norm[-1] - 100), 1), "b": round(float(b_norm[-1] - 100), 1)},
        "backtest": {
            "sharpe": round(sharpe, 2) if sharpe is not None else None,
            "total_spread_return": round(total, 4),
            "trades": len(closed),
            "wins": wins,
            "win_rate": round(wins / len(closed) * 100, 1) if closed else None,
            "exposure_pct": round(exposure * 100, 1),
        },
        "trades": trade_recs,
        "markers": markers,
        "series": series,
        "equity": equity_series,
        "legs": legs_series,
        "observations": len(df),
        "lookback_days": lookback_days,
        "source": "yfinance closes; OLS hedge ratio, numpy ADF + OU half-life",
    }
