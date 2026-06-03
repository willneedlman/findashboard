import logging
logger = logging.getLogger(__name__)

import numpy as np
import pandas as pd
import datetime
from scipy.stats import norm
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
import yfinance as yf
import sys, os
sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))
from cache import get_history

router = APIRouter()


def _implied_vol(ticker: str) -> float:
    try:
        hist = get_history(ticker, period="3mo")
        if not hist.empty:
            closes = hist["Close"].dropna()
            returns = np.log(closes / closes.shift(1)).dropna()
            sigma = returns.std() * np.sqrt(252)
            return float(sigma) if sigma > 0 and not np.isnan(sigma) else 0.20
    except Exception:
        pass
    return 0.20


class ProbRequest(BaseModel):
    ticker: str = "SPY"
    target_px: float = 500.0
    expiry: str = ""


@router.post("/cone")
def probability_cone(req: ProbRequest):
    try:
        hist = get_history(req.ticker, period="1y")
        if hist.empty:
            raise HTTPException(404, "No price data")
        S0 = float(hist["Close"].dropna().iloc[-1])
    except HTTPException:
        raise
    except Exception as e:
        logger.exception("internal error"); raise HTTPException(500, "Internal server error")

    sigma = _implied_vol(req.ticker)
    r = 0.045
    try:
        from routers.rates import risk_free_rate
        r = risk_free_rate()["rate"]
    except Exception:
        pass

    today = pd.Timestamp.today().normalize()
    expiry_dt = pd.to_datetime(req.expiry) if req.expiry else today + pd.Timedelta(days=30)
    T = max((expiry_dt - today).days / 365.25, 0.001)

    n_steps = 100
    t_steps = np.linspace(0, T, n_steps)
    t_safe = np.maximum(t_steps, 1e-10)

    median_path = S0 * np.exp((r - 0.5 * sigma**2) * t_steps)
    upper = S0 * np.exp((r - 0.5 * sigma**2) * t_steps + sigma * np.sqrt(t_safe))
    lower = np.maximum(S0 * np.exp((r - 0.5 * sigma**2) * t_steps - sigma * np.sqrt(t_safe)), 0)

    mu_log = (r - 0.5 * sigma**2) * T
    std_dev = sigma * np.sqrt(T)
    prob_above = float(1 - norm.cdf(np.log(req.target_px / S0), loc=mu_log, scale=std_dev))

    future_dates = pd.date_range(start=today, periods=n_steps, freq=f"{max(1, int(T*365.25/n_steps))}D")
    cone = [
        {"date": str(d.date()), "upper": round(float(u), 2), "median": round(float(m), 2), "lower": round(float(l), 2)}
        for d, u, m, l in zip(future_dates, upper, median_path, lower)
    ]

    return {
        "S0": round(S0, 2), "sigma": round(sigma, 4), "r": round(r, 4),
        "T": round(T, 4), "prob_above": round(prob_above, 4), "cone": cone,
    }


@router.get("/chain-distribution")
def chain_distribution(ticker: str, expiry: str = ""):
    try:
        tkr = yf.Ticker(ticker.strip().upper())
        hist = get_history(ticker, period="5d")
        S0 = float(hist["Close"].dropna().iloc[-1]) if not hist.empty else None
        if not S0:
            raise HTTPException(404, "No spot price")

        expirations = tkr.options or []
        if not expirations:
            raise HTTPException(404, "No options data")

        if expiry:
            target_dt = pd.to_datetime(expiry)
            nearest = min(expirations, key=lambda d: abs((pd.to_datetime(d) - target_dt).days))
        else:
            nearest = expirations[0]

        chain = tkr.option_chain(nearest)
        calls = chain.calls[["strike", "impliedVolatility"]].dropna().sort_values("strike").reset_index(drop=True)
        puts  = chain.puts[["strike", "impliedVolatility"]].dropna()
        calls = calls[(calls["impliedVolatility"] > 0.02) & (calls["impliedVolatility"] < 3.0)]

    except HTTPException:
        raise
    except Exception as e:
        logger.exception("internal error"); raise HTTPException(500, "Internal server error")

    r = 0.045
    today = pd.Timestamp.today().normalize()
    expiry_dt = pd.to_datetime(nearest)
    T = max((expiry_dt - today).days / 365.25, 0.001)

    def bs_call_delta(K: float, iv: float) -> float:
        if iv <= 0 or T <= 0 or K <= 0:
            return float("nan")
        d1 = (np.log(S0 / K) + (r + 0.5 * iv**2) * T) / (iv * np.sqrt(T))
        return float(norm.cdf(d1))

    calls["delta"] = calls.apply(lambda row: bs_call_delta(row["strike"], row["impliedVolatility"]), axis=1)
    calls = calls.dropna(subset=["delta"])
    calls = calls[(calls["delta"] >= 0.01) & (calls["delta"] <= 0.99)]

    if len(calls) < 4:
        raise HTTPException(404, "Not enough strikes for distribution")

    strikes = calls["strike"].values
    deltas = calls["delta"].values
    n_str = len(strikes)
    win = max(5, n_str // 15)
    deltas_smooth = pd.Series(deltas).rolling(win, center=True, min_periods=1).mean().values.clip(0, 1)
    deltas_smooth = np.minimum.accumulate(deltas_smooth)

    dens_raw = np.abs(np.diff(deltas_smooth))
    dens_mid = (strikes[:-1] + strikes[1:]) / 2
    density = dens_raw / dens_raw.sum() if dens_raw.sum() > 0 else dens_raw

    d_rev = deltas_smooth[::-1]
    k_rev = strikes[::-1]
    p10 = float(np.interp(0.10, d_rev, k_rev))
    p50 = float(np.interp(0.50, d_rev, k_rev))
    p90 = float(np.interp(0.90, d_rev, k_rev))
    modal_strike = float(dens_mid[int(np.argmax(density))])

    avg_call_iv = float(calls["impliedVolatility"].mean())
    avg_put_iv  = float(puts["impliedVolatility"].mean()) if puts is not None and not puts.empty else avg_call_iv
    iv_skew = avg_put_iv - avg_call_iv

    return {
        "expiry": nearest, "S0": round(float(S0), 2), "T": round(T, 4),
        "modal_strike": round(modal_strike, 2), "p10": round(p10, 2),
        "p50": round(p50, 2), "p90": round(p90, 2),
        "iv_skew": round(iv_skew * 100, 2), "avg_call_iv": round(avg_call_iv * 100, 2),
        "density": [{"strike": round(float(s), 2), "density": round(float(d), 6)} for s, d in zip(dens_mid, density)],
        "delta_curve": [{"strike": round(float(s), 2), "delta": round(float(d), 4)} for s, d in zip(strikes, deltas_smooth)],
    }
