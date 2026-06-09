"""
Regression Analysis — OLS linear, polynomial, and multi-variable regression
on financial time-series data from yfinance.  Playwright available as a
scraping fallback for JS-rendered data sources.

taste (matplotlib wrapper) + matplotlib generate downloadable chart PNGs.
"""
import io, base64, logging
import numpy as np
import pandas as pd
import yfinance as yf
from scipy import stats
from sklearn.linear_model import LinearRegression
from sklearn.preprocessing import PolynomialFeatures
from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt

_log = logging.getLogger(__name__)
router = APIRouter()

_VALID_PERIODS = {"1mo", "3mo", "6mo", "1y", "2y", "3y", "5y"}
_VALID_MODELS  = {"linear", "polynomial"}


# ── Data layer ────────────────────────────────────────────────────────────────

def _fetch_series(ticker: str, period: str, use_returns: bool) -> pd.Series:
    ticker = ticker.upper().strip()
    df = yf.download(ticker, period=period, auto_adjust=True, progress=False)
    if df.empty:
        raise HTTPException(404, f"No price data for {ticker}")
    closes = df["Close"].squeeze().dropna()
    if use_returns:
        return np.log(closes / closes.shift(1)).dropna().rename(ticker)
    return closes.rename(ticker)


async def _scrape_series_playwright(url: str, css_selector: str) -> list[float]:
    """
    Playwright fallback: navigate to a JS-rendered page, extract numeric
    values from matching elements.  Used when yfinance lacks a series
    (e.g. custom macro indexes on web dashboards).
    """
    from playwright.async_api import async_playwright
    results: list[float] = []
    async with async_playwright() as pw:
        browser = await pw.chromium.launch(headless=True)
        page = await browser.new_page()
        try:
            await page.goto(url, timeout=25_000)
            await page.wait_for_selector(css_selector, timeout=10_000)
            elements = await page.query_selector_all(css_selector)
            for el in elements:
                text = (await el.inner_text()).strip().replace(",", "")
                try:
                    results.append(float(text))
                except ValueError:
                    pass
        finally:
            await browser.close()
    return results


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


# ── Chart (matplotlib / taste-palette colors) ─────────────────────────────────

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
