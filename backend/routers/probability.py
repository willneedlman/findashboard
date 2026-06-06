import logging
logger = logging.getLogger(__name__)

import numpy as np
import pandas as pd
import datetime
from scipy.stats import norm
from scipy.optimize import brentq
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

        today = pd.Timestamp.today().normalize()
        # Prefer expiries at least 14 days out for reliable IV data
        pool = [e for e in expirations if (pd.to_datetime(e) - today).days >= 14] or expirations
        if expiry:
            target_dt = pd.to_datetime(expiry)
            nearest = min(pool, key=lambda d: abs((pd.to_datetime(d) - target_dt).days))
        else:
            nearest = pool[0]

        chain = tkr.option_chain(nearest)

    except HTTPException:
        raise
    except Exception as e:
        logger.exception("internal error"); raise HTTPException(500, "Internal server error")

    r = 0.045
    try:
        from routers.rates import risk_free_rate
        r = risk_free_rate()["rate"]
    except Exception:
        pass

    expiry_dt = pd.to_datetime(nearest)
    T = max((expiry_dt - today).days / 365.25, 0.001)

    def _bs_call(K: float, sigma: float) -> float:
        d1 = (np.log(S0 / K) + (r + 0.5 * sigma**2) * T) / (sigma * np.sqrt(T))
        d2 = d1 - sigma * np.sqrt(T)
        return float(S0 * norm.cdf(d1) - K * np.exp(-r * T) * norm.cdf(d2))

    def _bs_put(K: float, sigma: float) -> float:
        d1 = (np.log(S0 / K) + (r + 0.5 * sigma**2) * T) / (sigma * np.sqrt(T))
        d2 = d1 - sigma * np.sqrt(T)
        return float(K * np.exp(-r * T) * norm.cdf(-d2) - S0 * norm.cdf(-d1))

    def _iv_from_price(K: float, price: float, is_put: bool) -> float | None:
        if price < 0.01:
            return None
        fn = _bs_put if is_put else _bs_call
        intrinsic = max((K * np.exp(-r * T) - S0) if is_put else (S0 - K * np.exp(-r * T)), 0)
        if price <= intrinsic + 0.001:
            return None
        try:
            return float(brentq(lambda sig: fn(K, sig) - price, 1e-4, 5.0, maxiter=50))
        except Exception:
            return None

    def _call_delta(K: float, iv: float) -> float:
        d1 = (np.log(S0 / K) + (r + 0.5 * iv**2) * T) / (iv * np.sqrt(T))
        return float(norm.cdf(d1))

    def _enrich(df: pd.DataFrame, is_put: bool) -> pd.DataFrame:
        df = df[["strike", "bid", "ask", "lastPrice"]].copy().dropna(subset=["strike"])
        df["mid"] = np.where(df["bid"] > 0, (df["bid"] + df["ask"]) / 2, df["lastPrice"].fillna(0))
        df = df[df["mid"] > 0.01]
        df["iv"] = df.apply(lambda row: _iv_from_price(row["strike"], row["mid"], is_put), axis=1)
        df = df.dropna(subset=["iv"])
        df["delta"] = df.apply(lambda row: _call_delta(row["strike"], row["iv"]), axis=1)
        return df

    # OTM calls (K >= S0) and OTM puts (K < S0) give the most reliable IV data
    calls_df = _enrich(chain.calls[chain.calls["strike"] >= S0], is_put=False)
    puts_df  = _enrich(chain.puts[chain.puts["strike"]  <  S0], is_put=True)

    avg_call_iv = float(calls_df["iv"].mean()) if len(calls_df) > 0 else 0.20
    avg_put_iv  = float(puts_df["iv"].mean())  if len(puts_df)  > 0 else avg_call_iv
    iv_skew = avg_put_iv - avg_call_iv

    combined = pd.concat([
        puts_df[["strike", "delta"]],
        calls_df[["strike", "delta"]],
    ]).sort_values("strike").drop_duplicates("strike").dropna(subset=["delta"])
    combined = combined[(combined["delta"] >= 0.01) & (combined["delta"] <= 0.99)]

    if len(combined) < 4:
        raise HTTPException(404, "Not enough strikes for distribution")

    strikes = combined["strike"].values
    deltas  = combined["delta"].values
    win = max(5, len(strikes) // 15)
    deltas_smooth = pd.Series(deltas).rolling(win, center=True, min_periods=1).mean().values.clip(0, 1)
    deltas_smooth = np.minimum.accumulate(deltas_smooth)

    dens_raw  = np.abs(np.diff(deltas_smooth))
    dens_mid  = (strikes[:-1] + strikes[1:]) / 2
    density   = dens_raw / dens_raw.sum() if dens_raw.sum() > 0 else dens_raw
    modal_strike = float(dens_mid[int(np.argmax(density))])

    d_rev = deltas_smooth[::-1]
    k_rev = strikes[::-1]
    p10 = float(np.interp(0.10, d_rev, k_rev))
    p50 = float(np.interp(0.50, d_rev, k_rev))
    p90 = float(np.interp(0.90, d_rev, k_rev))

    return {
        "expiry": nearest, "S0": round(float(S0), 2), "T": round(T, 4),
        "modal_strike": round(modal_strike, 2),
        "p10": round(p10, 2), "p50": round(p50, 2), "p90": round(p90, 2),
        "iv_skew": round(iv_skew * 100, 2), "avg_call_iv": round(avg_call_iv * 100, 2),
        "density":     [{"strike": round(float(s), 2), "density": round(float(d), 6)} for s, d in zip(dens_mid, density)],
        "delta_curve": [{"strike": round(float(s), 2), "delta":   round(float(d), 4)} for s, d in zip(strikes, deltas_smooth)],
    }
