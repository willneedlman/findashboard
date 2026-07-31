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
import factor_models as fm
import crsp_data

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
    from .algo import _ear_bar_rate
    t = np.arange(len(cum_gross))
    b_d = 1 + _ear_bar_rate(borrow_rate, 252)
    eq = leverage * cum_gross.values - (leverage - 1) * (b_d ** t)
    liquidated = bool((eq <= 0).any())
    if liquidated:
        first = int(np.argmax(eq <= 0))
        eq = eq.copy()
        eq[first:] = 0.0
    return pd.Series(eq, index=cum_gross.index), liquidated


def _series_metrics(equity: pd.Series, bench_ret: pd.Series, rf: float) -> dict:
    """Risk/return metrics from a wealth-index series and the benchmark's daily returns."""
    elapsed_days = max(int((equity.index[-1] - equity.index[0]).days), 0)
    actual_years = elapsed_days / 365.25
    years = max(actual_years, 1.0)
    start_val, end_val = float(equity.iloc[0]), float(equity.iloc[-1])
    period_return = end_val / start_val - 1 if start_val > 0 else -1.0
    cagr = (end_val / start_val) ** (1 / years) - 1 if end_val > 0 and start_val > 0 else -1.0
    annualized_return = (
        (end_val / start_val) ** (1 / actual_years) - 1
        if actual_years > 0 and end_val > 0 and start_val > 0 else period_return
    )
    ret = equity.pct_change().replace([np.inf, -np.inf], np.nan).dropna()
    vol = float(ret.std() * np.sqrt(252)) if len(ret) > 1 else 0.0
    arithmetic_ann_return = float(ret.mean() * 252) if len(ret) else annualized_return
    sharpe = (arithmetic_ann_return - rf) / vol if vol else 0.0
    cummax = equity.cummax()
    max_dd = float(((equity - cummax) / cummax).min())
    common = ret.index.intersection(bench_ret.index)
    if len(common) > 2 and float(bench_ret.loc[common].var()) > 0:
        beta = float(np.cov(ret.loc[common].values, bench_ret.loc[common].values)[0, 1] / np.var(bench_ret.loc[common].values))
    else:
        beta = 0.0
    neg = ret[ret < 0]
    down_vol = float(neg.std() * np.sqrt(252)) if len(neg) > 1 else vol
    sortino = (arithmetic_ann_return - rf) / down_vol if down_vol else 0.0
    calmar = annualized_return / abs(max_dd) if max_dd != 0 else 0.0
    return {
        "period_return": round(period_return * 100, 2),
        "cagr": round(cagr * 100, 2),
        "cagr_applicable": actual_years >= 1,
        "annualized_return": round(annualized_return * 100, 2),
        "period_days": elapsed_days,
        "observations": int(len(equity)),
        "start_date": str(equity.index[0].date()),
        "end_date": str(equity.index[-1].date()),
        "cumulative_return_method": "auto-adjusted close, daily time-weighted proxy",
        "return_frequency": "daily",
        "annualization_factor": 252,
        "risk_free_rate_pct": round(rf * 100, 3),
        "vol": round(vol * 100, 2), "sharpe": round(sharpe, 2),
        "max_drawdown": round(max_dd * 100, 2), "sortino": round(sortino, 2),
        "calmar": round(calmar, 2), "beta": round(beta, 2),
    }


class BacktestRequest(BaseModel):
    # Generous cap so an AGGREGATED book (several portfolios merged for the
    # homescreen Overview) validates alongside a CASH sleeve leg. min_length=0 so
    # crsp_mode (which ignores tickers/weights entirely — the S&P 500 point-in-time
    # universe stands in for them) can send empty lists.
    tickers: list[str] = Field(default_factory=list, max_length=60)
    weights: list[float] = Field(default_factory=list, max_length=60)
    benchmark: str = "SPY"
    start: str = "2020-01-01"
    end: str = "2024-12-31"
    # No upper cap — a wipeout is floored at 0 from the liquidation point.
    leverage: float = Field(default=1.0, ge=1.0)
    borrow_rate: float = Field(default=0.0, ge=0.0, le=100.0)
    cash_weight: float = 0.0   # filled from any CASH legs (see CASH_SYMBOL)
    interval: str = "1d"       # "1d" (daily) or intraday e.g. "15m" for a 1-day curve
    # Holdings drift with prices and reset to target weights at each boundary;
    # "none" = buy and hold, "daily" = constant weights (the old behavior).
    rebalance: str = "none"
    # Survivorship-bias-free mode: ignores tickers/weights/leverage-per-name and
    # instead buys the S&P 500 constituents as they actually stood on `start`
    # (WRDS CRSP data/crsp.db), correctly carrying delisted names' realized
    # outcome through the return series instead of silently dropping them.
    crsp_mode: bool = False

    @model_validator(mode='after')
    def _validate(self):
        if self.crsp_mode:
            self.benchmark = validate_ticker(self.benchmark)
            validate_date(self.start); validate_date(self.end)
            return self
        eq_t, eq_w = [], []
        for t, w in zip(self.tickers, self.weights):
            if t.strip().upper() == CASH_SYMBOL:
                self.cash_weight += w
            else:
                eq_t.append(t); eq_w.append(w)
        self.tickers = validate_tickers(eq_t, max_count=60) if eq_t else []
        self.weights = eq_w
        if not self.tickers and self.cash_weight <= 0:
            raise HTTPException(400, "No holdings provided")
        self.benchmark = validate_ticker(self.benchmark)
        validate_date(self.start); validate_date(self.end)
        if self.rebalance not in _REBAL_FREQS:
            raise HTTPException(400, f"rebalance must be one of {sorted(_REBAL_FREQS)}")
        return self


_REBAL_FREQS = {"none", "daily", "weekly", "monthly", "quarterly", "annually"}


def _rebalance_mask(index: pd.DatetimeIndex, freq: str) -> np.ndarray:
    """True on bars where the portfolio resets to target weights (period close)."""
    n = len(index)
    if freq == "daily":
        return np.ones(n, dtype=bool)
    if freq == "none" or n == 0:
        return np.zeros(n, dtype=bool)
    per = index.to_period({"weekly": "W", "monthly": "M", "quarterly": "Q", "annually": "Y"}[freq])
    mask = np.zeros(n, dtype=bool)
    mask[:-1] = per[:-1] != per[1:]
    return mask


def _walk_portfolio(growth: np.ndarray, target: np.ndarray, mask: np.ndarray) -> np.ndarray:
    """Per-bar portfolio returns from asset growth factors (T, N) with holdings
    drifting between rebalances and resetting to `target` where mask is True."""
    rets = np.empty(len(growth))
    cur = target.copy()
    for t in range(len(growth)):
        g = growth[t]
        v = float(cur @ g)
        rets[t] = v - 1.0
        cur = target if mask[t] else (cur * g / v if v > 0 else target)
    return rets


def _crsp_pit_returns(start: str, end: str) -> tuple[pd.Series, list[dict], int]:
    """S&P 500 point-in-time daily return series: constituents as of `start`,
    equal-weighted, a delisted name's realized return (already embedded in
    crsp_daily.ret) carries through and its weight silently redistributes across
    the remaining survivors from then on — the SQL-side AVG() in
    crsp_data.portfolio_returns does that for free, no rebalance bookkeeping
    needed."""
    if not crsp_data.available():
        raise HTTPException(503, "CRSP data not loaded — data/crsp.db is missing")
    members = crsp_data.point_in_time_members(start)
    if not members:
        raise HTTPException(404, f"No CRSP S&P 500 membership data as of {start}")
    permnos = [m["permno"] for m in members]
    port = crsp_data.portfolio_returns(permnos, start, end)
    if port.empty:
        raise HTTPException(404, "No CRSP price data for the selected window")

    delistings = crsp_data.delisting_summary(permnos, start, end)
    tickers = crsp_data.tickers_for_permnos([d["permno"] for d in delistings])
    for d in delistings:
        d["ticker"] = tickers.get(d["permno"], d["permno"])
    return port, delistings, len(members)


def _crsp_backtest_series(req: BacktestRequest) -> tuple[pd.Series, pd.Series, list[dict], int]:
    """CRSP point-in-time portfolio + the live benchmark (a real, currently-
    tradable index fund — not something CRSP needs to correct)."""
    port, delistings, constituent_count = _crsp_pit_returns(req.start, req.end)

    try:
        dl = get_download((req.benchmark,), req.start, req.end)
        braw = dl["Close"] if isinstance(dl.columns, pd.MultiIndex) and "Close" in dl.columns.get_level_values(0) else dl
        if isinstance(braw, pd.Series):
            braw = braw.to_frame(req.benchmark)
        if braw.index.tz is not None:
            braw.index = braw.index.tz_convert(None)
    except Exception:
        logger.exception("internal error"); raise HTTPException(500, "Internal server error")
    bench = braw[req.benchmark].dropna().pct_change().dropna()

    common = port.index.intersection(bench.index)
    port, bench = port.loc[common], bench.loc[common]
    if port.empty:
        raise HTTPException(404, "No overlapping data between CRSP universe and benchmark")
    return port, bench, delistings, constituent_count


@router.post("/backtest")
def backtest(req: BacktestRequest):
    if req.crsp_mode:
        port, bench, delistings, constituent_count = _crsp_backtest_series(req)
    else:
        eq_w = np.array(req.weights, dtype=float) if req.tickers else np.array([])

        all_tickers = list(dict.fromkeys(req.tickers + [req.benchmark]))
        try:
            dl = get_download(tuple(sorted(all_tickers)), req.start, req.end, req.interval)
            raw = dl["Close"] if isinstance(dl.columns, pd.MultiIndex) and "Close" in dl.columns.get_level_values(0) else dl
            if isinstance(raw, pd.Series):
                raw = raw.to_frame(all_tickers[0])
            if raw.index.tz is not None:
                raw.index = raw.index.tz_convert(None)
        except Exception:
            logger.exception("internal error"); raise HTTPException(500, "Internal server error")

        # Drop names with no fetched data at all (bad / newly listed / delisted
        # symbol). Without this, a single all-NaN column makes the row-wise dropna
        # below collapse the whole overlapping window to empty — exactly why a wide
        # aggregated book charted "No performance data". The rest of the book still
        # charts, and the surviving equity weights renormalize.
        raw = raw[[c for c in raw.columns if raw[c].notna().any()]]
        if req.benchmark not in raw.columns:
            raise HTTPException(404, "No benchmark price data for the selected window")
        kept_idx = [i for i, t in enumerate(req.tickers) if t in raw.columns]
        req.tickers = [req.tickers[i] for i in kept_idx]
        eq_w = eq_w[kept_idx] if len(eq_w) else eq_w
        if not req.tickers and req.cash_weight <= 0:
            raise HTTPException(404, "No price data for the provided holdings")

        # Normalize equity + cash weights together so a cash sleeve dilutes exposure.
        total_w = float(eq_w.sum()) + req.cash_weight
        if total_w <= 0:
            total_w = 1.0

        raw = raw.dropna()
        if raw.empty:
            raise HTTPException(404, "No overlapping data")

        daily = raw.pct_change().dropna()
        cash_daily = (1 + _get_risk_free_rate()) ** (1 / 252) - 1   # zero-vol cash sleeve
        # Cash rides along as an asset column so buy-and-hold lets it drift too.
        cols, target = [], []
        if len(eq_w):
            cols.append((1 + daily[req.tickers]).to_numpy())
            target.extend(eq_w / total_w)
        if req.cash_weight > 0:
            cols.append(np.full((len(daily), 1), 1 + cash_daily))
            target.append(req.cash_weight / total_w)
        growth = np.hstack(cols)
        mask = _rebalance_mask(daily.index, req.rebalance)
        port = pd.Series(_walk_portfolio(growth, np.array(target), mask), index=daily.index)
        bench = daily[req.benchmark]
        delistings, constituent_count = [], 0

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
        "rebalance": req.rebalance,
        "liquidated": liquidated,
        "cumulative": [
            # Intraday needs the full timestamp so bars don't collapse onto one date.
            {"date": str(d.date()) if req.interval == "1d" else d.isoformat(), "portfolio": round(float(p), 2), "benchmark": round(float(b), 2)}
            for d, p, b in zip(cum_port.index, cum_port, cum_bench)
        ],
        "daily_returns": [{"date": str(d.date()), "value": round(float(v) * 100, 4)} for d, v in lev_ret.items()],
        "rolling_beta": [{"date": str(d.date()), "value": round(float(v), 4)} for d, v in rolling_beta.dropna().items()],
        # per_ticker_returns is only meaningful (and small) for an explicit few-name
        # book — a 500-constituent CRSP universe reports delistings/count instead.
        "per_ticker_returns": {} if req.crsp_mode else {
            ticker: [{"date": str(d.date()), "value": round(float(v) * 100, 6)} for d, v in daily[ticker].items()]
            for ticker in req.tickers
        },
        "crsp_mode": req.crsp_mode,
        "constituent_count": constituent_count,
        "delistings": delistings,
    }


class MonteCarloRequest(BaseModel):
    # min_length=0 so crsp_mode (which ignores tickers/weights — the S&P 500
    # point-in-time universe stands in for them) can send an empty list.
    tickers: list[str] = Field(default_factory=list, max_length=20)
    weights: list[float] | None = None
    start: str = "2020-01-01"
    end: str = "2024-12-31"
    n_sims: int = Field(default=500, ge=10, le=1000)
    horizon_days: int = Field(default=252, ge=1, le=2520)
    # No upper cap — wiped-out simulation paths are floored at 0 (see monte_carlo).
    leverage: float = Field(default=1.0, ge=1.0)
    borrow_rate: float = Field(default=0.0, ge=0.0, le=100.0)
    # Survivorship-bias-free mode: estimates the GBM drift/vol from the S&P 500's
    # actual point-in-time constituent history (WRDS CRSP) instead of a typed
    # basket — a delisted name's realized wipeout or buyout premium is embedded
    # in the historical return series and correctly fattens the risk estimate.
    crsp_mode: bool = False

    @model_validator(mode='after')
    def _validate(self):
        if self.crsp_mode:
            validate_date(self.start); validate_date(self.end)
            return self
        self.tickers = validate_tickers(self.tickers)
        if not self.tickers:
            raise HTTPException(400, "No tickers provided")
        validate_date(self.start); validate_date(self.end)
        if not self.weights or len(self.weights) != len(self.tickers):
            self.weights = [1.0] * len(self.tickers)
        return self


@router.post("/montecarlo")
def monte_carlo(req: MonteCarloRequest):
    """GBM simulation of a (optionally levered) portfolio. Returns terminal equity as a growth
    multiple of starting capital (1.0 = breakeven)."""
    delistings, constituent_count = [], 0
    if req.crsp_mode:
        port_ret, delistings, constituent_count = _crsp_pit_returns(req.start, req.end)
    else:
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
        "crsp_mode": req.crsp_mode,
        "constituent_count": constituent_count,
        "delistings": delistings,
    }


# ── Multi-portfolio comparison ──────────────────────────────────────────────────

class ComparePortfolio(BaseModel):
    name: str = "Portfolio"
    # 25 (not 20) so a full 20-name book plus a CASH sleeve leg survives field
    # validation; _validate strips CASH out before the 20-cap validate_tickers.
    tickers: list[str] = Field(min_length=1, max_length=25)
    weights: list[float] = Field(min_length=1, max_length=25)
    # No upper cap on leverage — a wipeout is handled gracefully by flooring the
    # equity at 0 from the liquidation point onward (see _lever_equity).
    leverage: float = Field(default=1.0, ge=1.0)
    borrow_rate: float = Field(default=0.0, ge=0.0, le=100.0)
    # Filled by CompareRequest._validate from any "CASH" legs (see CASH_SYMBOL):
    # the weight allocated to a zero-volatility cash sleeve, growing at the
    # risk-free rate. Kept out of `tickers` so it never hits ticker validation.
    cash_weight: float = 0.0


# Reserved leg symbol the Portfolio Manager import uses for a cash allocation.
CASH_SYMBOL = "CASH"


class CompareRequest(BaseModel):
    portfolios: list[ComparePortfolio] = Field(min_length=2, max_length=4)
    benchmark: str = "SPY"
    start: str = "2020-01-01"
    end: str = "2024-12-31"

    @model_validator(mode='after')
    def _validate(self):
        for p in self.portfolios:
            # Pull any CASH legs out into cash_weight before ticker validation.
            eq_t, eq_w = [], []
            for t, w in zip(p.tickers, p.weights):
                if t.strip().upper() == CASH_SYMBOL:
                    p.cash_weight += w
                else:
                    eq_t.append(t); eq_w.append(w)
            p.tickers = validate_tickers(eq_t) if eq_t else []
            p.weights = eq_w
            if not p.tickers and p.cash_weight <= 0:
                raise HTTPException(400, f"Portfolio '{p.name}' has no holdings")
        self.benchmark = validate_ticker(self.benchmark)
        validate_date(self.start); validate_date(self.end)
        return self


# ── Factor / risk decomposition ─────────────────────────────────────────────
# Return-based factor proxies. All liquid ETFs so one batched download covers
# them, and betas read in return space (a market beta near 1, a duration beta,
# a credit beta, an oil beta, a dollar beta). Factors are correlated, so betas
# are PARTIAL exposures holding the others fixed — that is the point.
_FACTORS = [
    ("Market", "SPY"),
    ("Rates", "TLT"),
    ("Credit", "HYG"),
    ("Oil", "USO"),
    ("Dollar", "UUP"),
]

# Equity style factors (Fama-French / Carhart), sourced from the Ken French
# Data Library via factor_models.py. A different lens from the macro ETF
# factors above: style tilt (size/value/momentum) rather than macro
# sensitivity (rates/credit/oil/dollar).
_STYLE_LABELS = {
    "mktrf": ("Market", "Ken French Mkt-RF"),
    "smb":   ("Size", "Ken French SMB"),
    "hml":   ("Value", "Ken French HML"),
    "umd":   ("Momentum", "Ken French UMD"),
}


class FactorHolding(BaseModel):
    ticker: str
    shares: float | None = None
    weight: float | None = None      # percent, used directly when shares absent


class FactorRequest(BaseModel):
    holdings: list[FactorHolding] = Field(..., min_length=1, max_length=100)
    lookback_days: int = Field(365, ge=90, le=14600)  # up to ~40y — as deep as yfinance goes
    mode: str = Field("macro", pattern="^(macro|style)$")
    benchmark: str = Field("SPY", min_length=1, max_length=12)


@router.post("/factor-decomposition")
def factor_decomposition(req: FactorRequest):
    """Regress a book's daily returns on either macro factors (market, rates,
    credit, oil, dollar — mode='macro', the default) or equity style factors
    (Fama-French/Carhart market, size, value, momentum — mode='style').
    Returns partial factor betas with t-stats, each factor's share of return
    variance, the idiosyncratic remainder, and concentration stats.

    Weights come from `weight` when given (paste mode); otherwise from
    shares x last close (the saved Portfolio Manager book)."""
    holds: dict[str, FactorHolding] = {}
    for h in req.holdings:
        sym = validate_ticker(h.ticker)
        if sym.upper() == "CASH":
            continue
        holds[sym] = h                                    # dedup, last wins
    if not holds:
        raise HTTPException(400, "No priceable holdings")

    tickers = sorted(holds)
    benchmark = validate_ticker(req.benchmark)
    factors = [("Market", benchmark), *((label, symbol) for label, symbol in _FACTORS[1:] if symbol != benchmark)]
    factor_syms = [s for _, s in factors] if req.mode == "macro" else []
    union = tuple(sorted(set(tickers) | set(factor_syms)))
    import datetime as _dt
    end = (_dt.date.today() + _dt.timedelta(days=1)).isoformat()
    start = (_dt.date.today() - _dt.timedelta(days=req.lookback_days + 10)).isoformat()
    try:
        dl = get_download(union, start, end)
        raw = dl["Close"] if isinstance(dl.columns, pd.MultiIndex) and "Close" in dl.columns.get_level_values(0) else dl
        if isinstance(raw, pd.Series):
            raw = raw.to_frame(union[0])
        if raw.index.tz is not None:
            raw.index = raw.index.tz_convert(None)
    except Exception:
        logger.exception("factor download failed"); raise HTTPException(500, "Internal server error")
    raw = raw.dropna(how="all")
    if raw.empty:
        raise HTTPException(404, "No price data")

    priced = [t for t in tickers if t in raw.columns and raw[t].notna().sum() > 20]
    dropped = [t for t in tickers if t not in priced]
    if not priced:
        raise HTTPException(404, "None of the holdings could be priced")

    # Weights: direct percent, else market value from the latest close.
    use_weight = all(holds[t].weight is not None for t in priced)
    if use_weight:
        mv = {t: max(0.0, float(holds[t].weight or 0)) for t in priced}
    else:
        mv = {}
        for t in priced:
            last = float(raw[t].dropna().iloc[-1])
            mv[t] = max(0.0, float(holds[t].shares or 0)) * last
    total = sum(mv.values())
    if total <= 0:
        raise HTTPException(400, "Holdings have zero total value")
    weights = {t: mv[t] / total for t in priced}

    daily = raw.pct_change().dropna(how="all")
    port = sum(daily[t].fillna(0.0) * weights[t] for t in priced)

    if req.mode == "style":
        keys = ["mktrf", "smb", "hml", "umd"]
        style_factors = fm.get_factors("daily")[keys].dropna()
        labels = {k: _STYLE_LABELS[k][0] for k in keys}
        proxies = {k: _STYLE_LABELS[k][1] for k in keys}
        fac_frame_for_merge = style_factors
        source_label = f"Ken French FF4/Carhart factors ({'/'.join(keys)})"
    else:
        fac_cols = [(lbl, s) for lbl, s in factors if s in daily.columns and daily[s].notna().sum() > 20]
        keys = [lbl.lower() for lbl, _ in fac_cols]
        labels = {lbl.lower(): lbl for lbl, _ in fac_cols}
        proxies = {lbl.lower(): s for lbl, s in fac_cols}
        fac_frame_for_merge = pd.concat([daily[s].rename(lbl.lower()) for lbl, s in fac_cols], axis=1)
        source_label = f"yfinance factor ETFs ({'/'.join(symbol for _, symbol in factors)})"

    frame = pd.concat([port.rename("port"), fac_frame_for_merge], axis=1).dropna()
    if len(frame) < 60:
        raise HTTPException(422, "Not enough overlapping history for a stable fit")

    # Output keys are always the lowercased display label (consistent across
    # modes and matching book_betas below), even though `keys` — used to pull
    # columns out of `frame`/X — are the raw factor codes for style mode.
    out_keys = [labels[k].lower() for k in keys]

    y = frame["port"].to_numpy()
    X = frame[keys].to_numpy()
    n, k = X.shape
    # Shared OLS core (backend/factor_models.py) — same regression math CAPM/
    # FF3/FF4 use, just fed raw portfolio/factor returns instead of a
    # CAPM-style excess-return frame (this isn't an alpha/excess-return
    # model, it's a factor-exposure decomposition).
    fit = fm.ols_fit(y, X, out_keys)
    if not fit.get("available"):
        raise HTTPException(422, "Not enough overlapping history for a stable fit")
    var_p = float(np.var(y, ddof=1)) or 1e-12

    factors = []
    for i, key in enumerate(keys):
        ok = out_keys[i]
        b = fit["betas"][ok]
        cov = float(np.cov(X[:, i], y, ddof=1)[0, 1])
        contrib = b * cov / var_p                          # sums to R^2 across factors
        factors.append({
            "factor": labels[key], "proxy": proxies[key], "beta": round(b, 3),
            "t_stat": fit["t_stats"][ok],
            "risk_pct": round(contrib * 100, 1),
        })
    factors.sort(key=lambda f: abs(f["risk_pct"]), reverse=True)

    ann_vol = float(np.std(y, ddof=1)) * (252 ** 0.5)
    hhi = sum(w * w for w in weights.values())
    top = sorted(({"ticker": t, "weight": round(weights[t] * 100, 1)} for t in priced),
                 key=lambda x: x["weight"], reverse=True)

    # Rolling 60-day factor betas: refit the multivariate OLS on each trailing
    # window so the drift in each exposure is visible. Downsampled to ~180 pts.
    fdates = [str(d.date()) for d in frame.index]
    roll_win = min(60, max(20, n // 4))
    rolling: dict[str, list] = {k: [] for k in out_keys}
    for e in range(roll_win, n + 1):
        sl = slice(e - roll_win, e)
        rfit = fm.ols_fit(y[sl], X[sl], out_keys)
        if not rfit.get("available"):
            continue
        for ok in out_keys:
            rolling[ok].append({"date": fdates[e - 1], "beta": rfit["betas"][ok]})
    rstep = max(1, (n - roll_win) // 180)
    rolling = {k: v[::rstep] for k, v in rolling.items()}

    # Per-holding regression on the same factors: betas, idiosyncratic share, and
    # each name's share of book return variance (weight x cov(name, book)/var).
    holdings_detail = []
    for t in priced:
        ri = daily[t].reindex(frame.index).fillna(0.0).to_numpy()
        hfit = fm.ols_fit(ri, X, out_keys)
        if not hfit.get("available"):
            continue
        cov_ip = float(np.cov(ri, y, ddof=1)[0, 1])
        holdings_detail.append({
            "ticker": t, "weight": round(weights[t] * 100, 1),
            "betas": {ok: hfit["betas"][ok] for ok in out_keys},
            "idiosyncratic_pct": round((1 - hfit["r_squared"]) * 100),
            "book_var_share_pct": round(weights[t] * cov_ip / var_p * 100, 1),
        })
    holdings_detail.sort(key=lambda h: h["weight"], reverse=True)
    book_betas = {f["factor"].lower(): f["beta"] for f in factors}

    return {
        "mode": req.mode,
        "benchmark": benchmark,
        "factors": factors,
        "rolling": rolling,
        "holdings_detail": holdings_detail,
        "book_betas": book_betas,
        "roll_window": roll_win,
        "r_squared": fit["r_squared"],
        "systematic_pct": round(fit["r_squared"] * 100, 1),
        "idiosyncratic_pct": round((1 - fit["r_squared"]) * 100, 1),
        "ann_vol_pct": round(ann_vol * 100, 1),
        "alpha_ann_pct": round(fit["alpha"] * 252 * 100, 2),
        "concentration": {
            "holdings": len(priced),
            "hhi": round(hhi, 4),
            "effective_n": round(1 / hhi, 1) if hhi else None,
            "top_weight": top[0]["weight"] if top else None,
            "top": top,
        },
        "observations": n,
        "lookback_days": req.lookback_days,
        "weighting": "direct" if use_weight else "market value",
        "dropped": dropped,
        "source": source_label,
    }


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
    cash_daily = (1 + rf) ** (1 / 252) - 1   # zero-vol cash sleeve return
    bench_ret = daily[req.benchmark]
    cum_bench = (1 + bench_ret).cumprod() * 100

    series, metrics = [], []
    for p in req.portfolios:
        # Normalize equity + cash weights together so a cash sleeve dilutes the
        # equity exposure (true cash drag) rather than being dropped.
        eq_w = np.array(p.weights, dtype=float) if p.tickers else np.array([])
        total_w = eq_w.sum() + p.cash_weight
        if total_w <= 0:
            total_w = 1.0
        if len(eq_w):
            port = (daily[p.tickers] * (eq_w / total_w)).sum(axis=1)
        else:
            port = pd.Series(0.0, index=daily.index)
        if p.cash_weight > 0:
            port = port + (p.cash_weight / total_w) * cash_daily
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
