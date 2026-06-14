import logging
logger = logging.getLogger(__name__)

import numpy as np
import pandas as pd
import requests
from fastapi import APIRouter, HTTPException, Depends
from pydantic import BaseModel, Field, model_validator
import sys, os
sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))
from cache import get_download
from admin_auth import require_admin
from validation import validate_tickers, validate_ticker, validate_date

_FRED_KEY = os.getenv("FRED_API_KEY", "")

router = APIRouter()

STRATEGIES = [
    "None (Base GBM / Buy & Hold)",
    "SMA Trend Following (50/200)",
    "RSI Mean Reversion (14)",
    "6-Month Price Momentum",
]


def _get_risk_free_rate() -> float:
    try:
        val = requests.get(
            "https://api.stlouisfed.org/fred/series/observations",
            params={"series_id": "DTB3", "sort_order": "desc", "limit": 1,
                    "api_key": _FRED_KEY, "file_type": "json"},
            timeout=5,
        ).json()["observations"][0]["value"]
        return float(val) / 100.0
    except Exception:
        return 0.045


def _lever_equity(cum_gross: pd.Series, leverage: float, borrow_rate: float) -> tuple[pd.Series, bool]:
    """Equity path of a portfolio that borrows (leverage-1)x its capital at borrow_rate (annual %)
    and holds it statically over the window — not a daily-rebalanced leveraged ETF. cum_gross is the
    unlevered wealth index. Returns (leveraged equity index, liquidated). On wipeout (equity <= 0)
    the position is floored at 0 from the first non-positive point onward."""
    t = np.arange(len(cum_gross))
    b_d = (1 + borrow_rate / 100.0) ** (1 / 252)
    eq = leverage * cum_gross.values - (leverage - 1) * (b_d ** t)
    liquidated = bool((eq <= 0).any())
    if liquidated:
        first = int(np.argmax(eq <= 0))
        eq = eq.copy()
        eq[first:] = 0.0
    return pd.Series(eq, index=cum_gross.index), liquidated


def _series_metrics(equity: pd.Series, bench_ret: pd.Series, rf: float) -> dict:
    """Risk/return metrics from a wealth-index series and the benchmark's daily returns."""
    years = max((equity.index[-1] - equity.index[0]).days / 365.25, 1.0)
    start_val, end_val = float(equity.iloc[0]), float(equity.iloc[-1])
    cagr = (end_val / start_val) ** (1 / years) - 1 if end_val > 0 and start_val > 0 else -1.0
    ret = equity.pct_change().replace([np.inf, -np.inf], np.nan).dropna()
    vol = float(ret.std() * np.sqrt(252)) if len(ret) > 1 else 0.0
    sharpe = (cagr - rf) / vol if vol else 0.0
    cummax = equity.cummax()
    max_dd = float(((equity - cummax) / cummax).min())
    common = ret.index.intersection(bench_ret.index)
    if len(common) > 2 and float(bench_ret.loc[common].var()) > 0:
        beta = float(np.cov(ret.loc[common].values, bench_ret.loc[common].values)[0, 1] / np.var(bench_ret.loc[common].values))
    else:
        beta = 0.0
    neg = ret[ret < 0]
    down_vol = float(neg.std() * np.sqrt(252)) if len(neg) > 1 else vol
    sortino = (cagr - rf) / down_vol if down_vol else 0.0
    calmar = cagr / abs(max_dd) if max_dd != 0 else 0.0
    return {
        "cagr": round(cagr * 100, 2), "vol": round(vol * 100, 2), "sharpe": round(sharpe, 2),
        "max_drawdown": round(max_dd * 100, 2), "sortino": round(sortino, 2),
        "calmar": round(calmar, 2), "beta": round(beta, 2),
    }


class BacktestRequest(BaseModel):
    tickers: list[str] = Field(min_length=1, max_length=20)
    weights: list[float] = Field(min_length=1, max_length=20)
    benchmark: str = "SPY"
    start: str = "2020-01-01"
    end: str = "2024-12-31"
    leverage: float = Field(default=1.0, ge=1.0, le=5.0)
    borrow_rate: float = Field(default=0.0, ge=0.0, le=30.0)

    @model_validator(mode='after')
    def _validate(self):
        self.tickers = validate_tickers(self.tickers)
        self.benchmark = validate_ticker(self.benchmark)
        validate_date(self.start); validate_date(self.end)
        return self


@router.post("/backtest")
def backtest(req: BacktestRequest):
    if not req.tickers:
        raise HTTPException(400, "No tickers provided")
    w = np.array(req.weights)
    w = w / w.sum()

    all_tickers = list(dict.fromkeys(req.tickers + [req.benchmark]))
    try:
        dl = get_download(tuple(sorted(all_tickers)), req.start, req.end)
        raw = dl["Close"] if isinstance(dl.columns, pd.MultiIndex) and "Close" in dl.columns.get_level_values(0) else dl
        if isinstance(raw, pd.Series):
            raw = raw.to_frame(all_tickers[0])
        if raw.index.tz is not None:
            raw.index = raw.index.tz_convert(None)
    except Exception:
        logger.exception("internal error"); raise HTTPException(500, "Internal server error")

    raw = raw.dropna()
    if raw.empty:
        raise HTTPException(404, "No overlapping data")

    daily = raw.pct_change().dropna()
    port = (daily[req.tickers] * w).sum(axis=1)
    bench = daily[req.benchmark]

    cum_gross = (1 + port).cumprod()
    equity, liquidated = _lever_equity(cum_gross, req.leverage, req.borrow_rate)
    cum_port = equity * 100
    cum_bench = (1 + bench).cumprod() * 100

    rf = _get_risk_free_rate()
    m = _series_metrics(equity, bench, rf)
    bench_m = _series_metrics((1 + bench).cumprod(), bench, rf)

    lev_ret = equity.pct_change().replace([np.inf, -np.inf], np.nan).dropna()
    window = 60
    rolling_beta = lev_ret.rolling(window).cov(bench) / bench.rolling(window).var()

    return {
        "metrics": {
            "port_cagr": m["cagr"],
            "bench_cagr": bench_m["cagr"],
            "port_sharpe": m["sharpe"],
            "port_vol": m["vol"],
            "max_drawdown": m["max_drawdown"],
            "sortino": m["sortino"],
            "calmar": m["calmar"],
            "beta": m["beta"],
        },
        "leverage": req.leverage,
        "borrow_rate": req.borrow_rate,
        "liquidated": liquidated,
        "cumulative": [
            {"date": str(d.date()), "portfolio": round(float(p), 2), "benchmark": round(float(b), 2)}
            for d, p, b in zip(cum_port.index, cum_port, cum_bench)
        ],
        "daily_returns": [{"date": str(d.date()), "value": round(float(v) * 100, 4)} for d, v in lev_ret.items()],
        "rolling_beta": [{"date": str(d.date()), "value": round(float(v), 4)} for d, v in rolling_beta.dropna().items()],
        "per_ticker_returns": {
            ticker: [{"date": str(d.date()), "value": round(float(v) * 100, 6)} for d, v in daily[ticker].items()]
            for ticker in req.tickers
        },
    }


class MonteCarloRequest(BaseModel):
    tickers: list[str] = Field(min_length=1, max_length=20)
    weights: list[float] | None = None
    start: str = "2020-01-01"
    end: str = "2024-12-31"
    n_sims: int = Field(default=500, ge=10, le=1000)
    horizon_days: int = Field(default=252, ge=1, le=2520)
    leverage: float = Field(default=1.0, ge=1.0, le=5.0)
    borrow_rate: float = Field(default=0.0, ge=0.0, le=30.0)

    @model_validator(mode='after')
    def _validate(self):
        self.tickers = validate_tickers(self.tickers)
        validate_date(self.start); validate_date(self.end)
        if not self.weights or len(self.weights) != len(self.tickers):
            self.weights = [1.0] * len(self.tickers)
        return self


@router.post("/montecarlo")
def monte_carlo(req: MonteCarloRequest):
    """GBM simulation of a (optionally levered) portfolio. Returns terminal equity as a growth
    multiple of starting capital (1.0 = breakeven)."""
    try:
        dl = get_download(tuple(sorted(req.tickers)), req.start, req.end)
        raw = dl["Close"] if isinstance(dl.columns, pd.MultiIndex) and "Close" in dl.columns.get_level_values(0) else dl
        if isinstance(raw, pd.Series):
            raw = raw.to_frame(req.tickers[0])
        if raw.index.tz is not None:
            raw.index = raw.index.tz_convert(None)
    except Exception:
        logger.exception("internal error"); raise HTTPException(500, "Internal server error")
    raw = raw[req.tickers].dropna()
    if raw.empty:
        raise HTTPException(404, "No data")

    w = np.array(req.weights, dtype=float); w = w / w.sum()
    port_ret = (raw.pct_change().dropna() * w).sum(axis=1)
    log_ret = np.log1p(port_ret)
    mu = float(log_ret.mean()); sigma = float(log_ret.std())
    n_sims = min(req.n_sims, 1000); T = req.horizon_days
    L = req.leverage; b_d = (1 + req.borrow_rate / 100.0) ** (1 / 252)

    rng = np.random.default_rng()
    shocks = (mu - 0.5 * sigma ** 2) + sigma * rng.standard_normal((T, n_sims))
    gross = np.vstack([np.ones((1, n_sims)), np.exp(np.cumsum(shocks, axis=0))])   # (T+1, n_sims), starts at 1.0
    tcol = np.arange(T + 1).reshape(-1, 1)
    equity = L * gross - (L - 1) * (b_d ** tcol)
    equity = np.where(np.cumsum(equity <= 0, axis=0) > 0, 0.0, equity)             # floor wiped-out paths

    final = equity[-1, :]
    p5 = float(np.percentile(final, 5))
    percentiles = {k: round(float(np.percentile(final, q)), 3)
                   for k, q in [("p5", 5), ("p25", 25), ("p50", 50), ("p75", 75), ("p95", 95)]}
    var_95 = round(float((1.0 - p5) * 100), 2)
    tail = final[final <= p5]
    cvar_95 = round(float((1.0 - tail.mean()) * 100), 2) if len(tail) else var_95

    step = max(1, n_sims // 50)
    sample = equity[:, ::step]
    return {
        "mu": round(mu * 252, 4),
        "sigma": round(sigma * np.sqrt(252), 4),
        "leverage": L,
        "borrow_rate": req.borrow_rate,
        "percentiles": percentiles,
        "var_95": var_95,
        "cvar_95": cvar_95,
        "pct_wiped": round(float((final <= 0).mean() * 100), 1),
        "sample_paths": [[round(float(v), 3) for v in row] for row in sample],
        "histogram": sorted([round(float(v), 3) for v in final]),
    }


# ── Multi-portfolio comparison ──────────────────────────────────────────────────

class ComparePortfolio(BaseModel):
    name: str = "Portfolio"
    tickers: list[str] = Field(min_length=1, max_length=20)
    weights: list[float] = Field(min_length=1, max_length=20)
    # No upper cap on leverage — a wipeout is handled gracefully by flooring the
    # equity at 0 from the liquidation point onward (see _lever_equity).
    leverage: float = Field(default=1.0, ge=1.0)
    borrow_rate: float = Field(default=0.0, ge=0.0, le=30.0)


class CompareRequest(BaseModel):
    portfolios: list[ComparePortfolio] = Field(min_length=2, max_length=4)
    benchmark: str = "SPY"
    start: str = "2020-01-01"
    end: str = "2024-12-31"

    @model_validator(mode='after')
    def _validate(self):
        for p in self.portfolios:
            p.tickers = validate_tickers(p.tickers)
        self.benchmark = validate_ticker(self.benchmark)
        validate_date(self.start); validate_date(self.end)
        return self


@router.post("/compare")
def compare(req: CompareRequest):
    """Leveraged equity curves + metrics for 2-4 portfolios on a common date range."""
    union = list(dict.fromkeys([t for p in req.portfolios for t in p.tickers] + [req.benchmark]))
    try:
        dl = get_download(tuple(sorted(union)), req.start, req.end)
        raw = dl["Close"] if isinstance(dl.columns, pd.MultiIndex) and "Close" in dl.columns.get_level_values(0) else dl
        if isinstance(raw, pd.Series):
            raw = raw.to_frame(union[0])
        if raw.index.tz is not None:
            raw.index = raw.index.tz_convert(None)
    except Exception:
        logger.exception("internal error"); raise HTTPException(500, "Internal server error")
    raw = raw.dropna()
    if raw.empty:
        raise HTTPException(404, "No overlapping data")

    daily = raw.pct_change().dropna()
    rf = _get_risk_free_rate()
    bench_ret = daily[req.benchmark]
    cum_bench = (1 + bench_ret).cumprod() * 100

    series, metrics = [], []
    for p in req.portfolios:
        wv = np.array(p.weights, dtype=float); wv = wv / wv.sum()
        port = (daily[p.tickers] * wv).sum(axis=1)
        equity, liquidated = _lever_equity((1 + port).cumprod(), p.leverage, p.borrow_rate)
        idx = equity * 100
        series.append({"name": p.name,
                       "points": [{"date": str(d.date()), "value": round(float(v), 2)} for d, v in idx.items()]})
        metrics.append({"name": p.name, "leverage": p.leverage, "borrow_rate": p.borrow_rate,
                        "liquidated": liquidated, **_series_metrics(equity, bench_ret, rf)})

    return {
        "benchmark": req.benchmark,
        "benchmark_points": [{"date": str(d.date()), "value": round(float(v), 2)} for d, v in cum_bench.items()],
        "series": series,
        "metrics": metrics,
    }


# ── Portfolio Stress Tester ────────────────────────────────────────────────────

SCENARIOS = {
    "gfc": {
        "label": "2008 Financial Crisis",
        "start": "2008-09-15",
        "end":   "2009-03-09",
        "desc":  "Lehman collapse to market bottom",
    },
    "covid": {
        "label": "COVID Crash",
        "start": "2020-02-19",
        "end":   "2020-03-23",
        "desc":  "33-day fastest bear market in history",
    },
    "rate_hike_2022": {
        "label": "2022 Rate Hike Bear",
        "start": "2022-01-03",
        "end":   "2022-10-13",
        "desc":  "Fed hiking cycle crushes growth stocks",
    },
    "dotcom": {
        "label": "Dot-com Bust",
        "start": "2000-03-10",
        "end":   "2002-10-09",
        "desc":  "Nasdaq peak to trough, -78%",
    },
    "q4_2018": {
        "label": "2018 Q4 Selloff",
        "start": "2018-09-20",
        "end":   "2018-12-24",
        "desc":  "Fed tightening + trade war fears",
    },
    "debt_ceiling_2011": {
        "label": "2011 Debt Ceiling Crisis",
        "start": "2011-07-22",
        "end":   "2011-10-03",
        "desc":  "US credit downgrade shock",
    },
    "black_monday": {
        "label": "1987 Black Monday",
        "start": "1987-10-14",
        "end":   "1987-10-20",
        "desc":  "Single-week 30% crash",
    },
    "svb_2023": {
        "label": "SVB Banking Crisis",
        "start": "2023-03-08",
        "end":   "2023-03-24",
        "desc":  "Silicon Valley Bank collapse contagion",
    },
}


class Holding(BaseModel):
    ticker: str
    weight: float = Field(gt=0, le=1)

class StressRequest(BaseModel):
    holdings: list[Holding] = Field(min_length=1, max_length=20)
    scenarios: list[str] = Field(default_factory=lambda: list(SCENARIOS.keys()))
    custom_start: str | None = None
    custom_end:   str | None = None

    @model_validator(mode="after")
    def check_weights(self):
        total = sum(h.weight for h in self.holdings)
        if not (0.99 <= total <= 1.01):
            raise ValueError(f"Weights must sum to 1.0 (got {total:.3f})")
        return self


def _period_return(prices: pd.Series, start: str, end: str) -> float | None:
    try:
        sub = prices.loc[start:end].dropna()
        if len(sub) < 2:
            return None
        return float((sub.iloc[-1] / sub.iloc[0]) - 1) * 100
    except Exception:
        return None


@router.post("/stress-test", dependencies=[Depends(require_admin)])
def stress_test(req: StressRequest):
    tickers = [h.ticker.upper() for h in req.holdings]
    weights = {h.ticker.upper(): h.weight for h in req.holdings}

    # Fetch price history — need data back to 1987 for Black Monday
    try:
        from datetime import date as _date
        raw = get_download(tuple(tickers + ["SPY"]), start="1986-01-01", end=_date.today().isoformat())
        if isinstance(raw.columns, pd.MultiIndex):
            prices = raw["Close"]
        else:
            prices = raw[["Close"]] if "Close" in raw.columns else raw
        prices = prices.ffill()
    except Exception as e:
        raise HTTPException(500, f"Price fetch failed: {e}")

    # Ensure SPY is present
    if "SPY" not in prices.columns:
        raise HTTPException(500, "Could not fetch SPY benchmark data")

    # Build scenario list
    scenario_keys = [s for s in req.scenarios if s in SCENARIOS]
    results = []

    for key in scenario_keys:
        sc = SCENARIOS[key]
        start, end = sc["start"], sc["end"]

        holding_results = []
        portfolio_return = 0.0
        all_valid = True

        for ticker in tickers:
            if ticker not in prices.columns:
                holding_results.append({"ticker": ticker, "return": None, "contribution": None})
                all_valid = False
                continue
            ret = _period_return(prices[ticker], start, end)
            weight = weights[ticker]
            contribution = (ret * weight) if ret is not None else None
            if ret is not None:
                portfolio_return += contribution
            else:
                all_valid = False
            holding_results.append({
                "ticker":       ticker,
                "weight":       round(weight * 100, 1),
                "return":       round(ret, 2) if ret is not None else None,
                "contribution": round(contribution, 2) if contribution is not None else None,
            })

        spy_ret = _period_return(prices["SPY"], start, end)

        results.append({
            "key":              key,
            "label":            sc["label"],
            "period":           f"{sc['start']} → {sc['end']}",
            "desc":             sc["desc"],
            "portfolio_return": round(portfolio_return, 2) if all_valid else None,
            "spy_return":       round(spy_ret, 2) if spy_ret is not None else None,
            "alpha":            round(portfolio_return - spy_ret, 2) if (all_valid and spy_ret is not None) else None,
            "holdings":         holding_results,
            "partial":          not all_valid,
        })

    # Custom scenario
    if req.custom_start and req.custom_end:
        start, end = req.custom_start, req.custom_end
        holding_results = []
        portfolio_return = 0.0
        all_valid = True
        for ticker in tickers:
            if ticker not in prices.columns:
                holding_results.append({"ticker": ticker, "return": None, "contribution": None})
                all_valid = False
                continue
            ret = _period_return(prices[ticker], start, end)
            weight = weights[ticker]
            contribution = (ret * weight) if ret is not None else None
            if ret is not None:
                portfolio_return += contribution
            else:
                all_valid = False
            holding_results.append({
                "ticker":       ticker,
                "weight":       round(weight * 100, 1),
                "return":       round(ret, 2) if ret is not None else None,
                "contribution": round(contribution, 2) if contribution is not None else None,
            })
        spy_ret = _period_return(prices["SPY"], start, end)
        results.append({
            "key":              "custom",
            "label":            "Custom Period",
            "period":           f"{start} → {end}",
            "desc":             "User-defined stress period",
            "portfolio_return": round(portfolio_return, 2) if all_valid else None,
            "spy_return":       round(spy_ret, 2) if spy_ret is not None else None,
            "alpha":            round(portfolio_return - spy_ret, 2) if (all_valid and spy_ret is not None) else None,
            "holdings":         holding_results,
            "partial":          not all_valid,
        })

    return {
        "holdings": [{"ticker": t, "weight": round(weights[t] * 100, 1)} for t in tickers],
        "results":  results,
    }
