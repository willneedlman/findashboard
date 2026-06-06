import logging
logger = logging.getLogger(__name__)

import numpy as np
import pandas as pd
import requests
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field, model_validator
import sys, os
sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))
from cache import get_download
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


class BacktestRequest(BaseModel):
    tickers: list[str] = Field(min_length=1, max_length=20)
    weights: list[float] = Field(min_length=1, max_length=20)
    benchmark: str = "SPY"
    start: str = "2020-01-01"
    end: str = "2024-12-31"

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
    except Exception as e:
        logger.exception("internal error"); raise HTTPException(500, "Internal server error")

    raw = raw.dropna()
    if raw.empty:
        raise HTTPException(404, "No overlapping data")

    daily = raw.pct_change().dropna()
    port = (daily[req.tickers] * w).sum(axis=1)
    bench = daily[req.benchmark]

    cum_port = (1 + port).cumprod() * 100
    cum_bench = (1 + bench).cumprod() * 100

    years = max((cum_port.index[-1] - cum_port.index[0]).days / 365.25, 1.0)
    port_cagr = (cum_port.iloc[-1] / 100) ** (1 / years) - 1
    bench_cagr = (cum_bench.iloc[-1] / 100) ** (1 / years) - 1
    port_vol = float(port.std() * np.sqrt(252))
    rf = _get_risk_free_rate()
    port_sharpe = (port_cagr - rf) / port_vol if port_vol else 0

    wealth = cum_port / 100
    max_dd = float(((wealth - wealth.cummax()) / wealth.cummax()).min())
    beta = float(np.cov(port.values, bench.values)[0, 1] / np.var(bench.values))
    down_vol = float(port[port < 0].std() * np.sqrt(252)) if len(port[port < 0]) > 0 else port_vol
    sortino = (port_cagr - rf) / down_vol if down_vol else 0
    calmar = port_cagr / abs(max_dd) if max_dd != 0 else 0

    window = 60
    rolling_cov = port.rolling(window).cov(bench)
    rolling_var = bench.rolling(window).var()
    rolling_beta = rolling_cov / rolling_var

    return {
        "metrics": {
            "port_cagr": round(port_cagr * 100, 2),
            "bench_cagr": round(bench_cagr * 100, 2),
            "port_sharpe": round(port_sharpe, 2),
            "port_vol": round(port_vol * 100, 2),
            "max_drawdown": round(max_dd * 100, 2),
            "sortino": round(sortino, 2),
            "calmar": round(calmar, 2),
            "beta": round(beta, 2),
        },
        "cumulative": [
            {"date": str(d.date()), "portfolio": round(float(p), 2), "benchmark": round(float(b), 2)}
            for d, p, b in zip(cum_port.index, cum_port, cum_bench)
        ],
        "daily_returns": [{"date": str(d.date()), "value": round(float(v) * 100, 4)} for d, v in port.items()],
        "rolling_beta": [{"date": str(d.date()), "value": round(float(v), 4)} for d, v in rolling_beta.dropna().items()],
        "per_ticker_returns": {
            ticker: [{"date": str(d.date()), "value": round(float(v) * 100, 6)} for d, v in daily[ticker].items()]
            for ticker in req.tickers
        },
    }


class MonteCarloRequest(BaseModel):
    ticker: str
    start: str = "2020-01-01"
    end: str = "2024-12-31"
    n_sims: int = Field(default=500, ge=10, le=1000)
    horizon_days: int = Field(default=252, ge=1, le=2520)

    @model_validator(mode='after')
    def _validate(self):
        self.ticker = validate_ticker(self.ticker)
        validate_date(self.start); validate_date(self.end)
        return self


@router.post("/montecarlo")
def monte_carlo(req: MonteCarloRequest):
    try:
        tkr = yf.Ticker(req.ticker.strip().upper())
        hist = tkr.history(start=req.start, end=req.end)
        if hist.empty:
            raise HTTPException(404, "No data")
        closes = hist["Close"].dropna()
        if closes.index.tz is not None:
            closes.index = closes.index.tz_convert(None)
    except Exception as e:
        logger.exception("internal error"); raise HTTPException(500, "Internal server error")

    log_returns = np.log(closes / closes.shift(1)).dropna()
    mu = float(log_returns.mean())
    sigma = float(log_returns.std())
    S0 = float(closes.iloc[-1])
    n_sims = min(req.n_sims, 1000)
    T = req.horizon_days

    rng = np.random.default_rng()
    paths = S0 * np.exp(np.cumsum(
        (mu - 0.5 * sigma**2) + sigma * rng.standard_normal((T, n_sims)), axis=0
    ))

    final = paths[-1, :]
    percentiles = {
        "p5":  round(float(np.percentile(final, 5)), 2),
        "p25": round(float(np.percentile(final, 25)), 2),
        "p50": round(float(np.percentile(final, 50)), 2),
        "p75": round(float(np.percentile(final, 75)), 2),
        "p95": round(float(np.percentile(final, 95)), 2),
    }
    var_95 = round(float((S0 - np.percentile(final, 5)) / S0 * 100), 2)
    cvar_95 = round(float((S0 - final[final <= np.percentile(final, 5)].mean()) / S0 * 100), 2)

    # Return sample paths (every 10th sim to limit payload)
    sample = paths[:, ::max(1, n_sims // 50)].tolist()

    return {
        "S0": S0,
        "mu": round(mu * 252, 4),
        "sigma": round(sigma * np.sqrt(252), 4),
        "percentiles": percentiles,
        "var_95": var_95,
        "cvar_95": cvar_95,
        "sample_paths": [[round(v, 2) for v in row] for row in sample],
        "histogram": sorted([round(float(v), 2) for v in final]),
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


@router.post("/stress-test")
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
