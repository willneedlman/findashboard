import logging
logger = logging.getLogger(__name__)

import numpy as np
import pandas as pd
from scipy.stats import norm
from scipy.optimize import brentq
from scipy.interpolate import PchipInterpolator
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
import yfinance as yf
import sys, os
sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))
from cache import get_history, cached
import options_data
from validation import validate_ticker

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
    req.ticker = validate_ticker(req.ticker)
    try:
        hist = get_history(req.ticker, period="1y")
        if hist.empty:
            raise HTTPException(404, "No price data")
        S0 = float(hist["Close"].dropna().iloc[-1])
    except HTTPException:
        raise
    except Exception:
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
@cached(ttl=600, maxsize=256)
def chain_distribution(ticker: str, expiry: str = ""):
    ticker = validate_ticker(ticker)
    try:
        tkr = yf.Ticker(ticker)
        hist = get_history(ticker, period="5d")
        S0 = float(hist["Close"].dropna().iloc[-1]) if not hist.empty else None
        if not S0:
            raise HTTPException(404, "No spot price")

        expirations = options_data.get_expirations(ticker)
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

        chain = options_data.get_chain(ticker, nearest)

    except HTTPException:
        raise
    except Exception:
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

    # Widen solver range for long-dated options (T > 6 months)
    iv_max = 10.0 if T > 0.5 else 5.0

    def _iv_from_price(K: float, price: float, is_put: bool) -> float | None:
        if price < 0.005:
            return None
        fn = _bs_put if is_put else _bs_call
        intrinsic = max((K * np.exp(-r * T) - S0) if is_put else (S0 - K * np.exp(-r * T)), 0)
        if price <= intrinsic + 0.001:
            return None
        try:
            return float(brentq(lambda sig: fn(K, sig) - price, 1e-4, iv_max, maxiter=100))
        except Exception:
            return None

    def _call_delta(K: float, iv: float) -> float:
        d1 = (np.log(S0 / K) + (r + 0.5 * iv**2) * T) / (iv * np.sqrt(T))
        return float(norm.cdf(d1))

    def _enrich(df: pd.DataFrame, is_put: bool) -> pd.DataFrame:
        df = df[["strike", "bid", "ask", "lastPrice"]].copy().dropna(subset=["strike"])
        # For LEAPS (bid=0), prefer ask*0.95 over stale lastPrice
        df["mid"] = np.where(
            df["bid"] > 0,
            (df["bid"] + df["ask"]) / 2,
            np.where(df["ask"] > 0.005, df["ask"] * 0.95, df["lastPrice"].fillna(0)),
        )
        df = df[df["mid"] >= 0.005]
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

    # Fall back to Black-Scholes synthetic distribution when options chain is too sparse
    if len(combined) < 4:
        # Best available ATM IV: nearest call/put IV, then yf.info, then HV
        atm_iv: float = 0.0
        if len(calls_df) > 0:
            atm_calls = calls_df[calls_df["strike"] <= S0 * 1.05]
            atm_iv = float(atm_calls["iv"].iloc[0]) if len(atm_calls) > 0 else float(calls_df["iv"].iloc[0])
        if atm_iv == 0.0 and len(puts_df) > 0:
            atm_puts = puts_df[puts_df["strike"] >= S0 * 0.95]
            atm_iv = float(atm_puts["iv"].iloc[-1]) if len(atm_puts) > 0 else float(puts_df["iv"].iloc[-1])
        if atm_iv == 0.0:
            try:
                raw_iv = tkr.info.get("impliedVolatility")
                atm_iv = float(raw_iv) if raw_iv else 0.0
            except Exception:
                pass
        if atm_iv == 0.0:
            atm_iv = _implied_vol(ticker)

        # Synthetic delta curve via Black-Scholes across ±3.5σ
        n_synth = 80
        lo = S0 * np.exp(-3.5 * atm_iv * np.sqrt(T))
        hi = S0 * np.exp(+3.5 * atm_iv * np.sqrt(T))
        synth_strikes = np.linspace(lo, hi, n_synth)
        synth_deltas  = np.array([_call_delta(float(k), atm_iv) for k in synth_strikes])
        combined = pd.DataFrame({"strike": synth_strikes, "delta": synth_deltas})
        combined = combined[(combined["delta"] >= 0.01) & (combined["delta"] <= 0.99)]
        avg_call_iv = atm_iv
        avg_put_iv  = atm_iv
        iv_skew = 0.0

    # ── Implied risk-neutral density ──────────────────────────────────────────
    # The risk-neutral probability that S_T > K is N(d2) — NOT the call delta
    # N(d1), which the old method used and which overstates the probability.
    # We fit the observed IV smile (so skew is kept), evaluate N(d2) per strike
    # with that strike's own vol to get the survival curve P(S_T > K), then take a
    # single derivative for the density. This fixes the delta bias the feedback
    # flagged while staying stable (unlike a raw Breeden-Litzenberger second
    # derivative, which is pure noise on retail option quotes).
    method = "delta-derivative"
    dens_mid = density = None
    try:
        smile = pd.concat([puts_df[["strike", "iv"]], calls_df[["strike", "iv"]]]) \
            .dropna(subset=["iv"]).sort_values("strike").drop_duplicates("strike")
        smile = smile[(smile["iv"] > 0.01) & (smile["iv"] < iv_max)]
        # Window to a sane strike range around spot (wider crash tail than upside)
        # so deep-OTM noise doesn't create phantom mass.
        atm_iv = float(np.nanmean([avg_call_iv, avg_put_iv])) or 0.2
        move   = max(atm_iv, 0.05) * np.sqrt(T)
        lo_k, hi_k = S0 * np.exp(-5.0 * move), S0 * np.exp(4.0 * move)
        smile = smile[(smile["strike"] >= lo_k * 0.9) & (smile["strike"] <= hi_k * 1.1)]
        if len(smile) >= 4:
            ks  = smile["strike"].to_numpy(dtype=float)
            ivs = smile["iv"].to_numpy(dtype=float)
            iv_fit  = PchipInterpolator(ks, ivs, extrapolate=True)
            grid    = np.linspace(max(ks.min(), lo_k), min(ks.max(), hi_k), 400)
            iv_grid = np.clip(iv_fit(grid), 0.01, iv_max)
            # Survival P(S_T > K) = N(d2) with the strike's own IV (skew-aware).
            sig_rt  = iv_grid * np.sqrt(T)
            d2      = (np.log(S0 / grid) + (r - 0.5 * iv_grid ** 2) * T) / sig_rt
            surv_g  = np.clip(norm.cdf(d2), 0.0, 1.0)
            surv_g  = np.minimum.accumulate(surv_g)   # enforce monotone-decreasing in K
            dens    = np.clip(-np.diff(surv_g) / np.diff(grid), 0.0, None)
            bl_mid  = (grid[:-1] + grid[1:]) / 2
            k_win   = max(5, len(dens) // 30)
            dens    = pd.Series(dens).rolling(k_win, center=True, min_periods=1).mean().to_numpy()
            area    = float(np.sum((dens[:-1] + dens[1:]) / 2 * np.diff(bl_mid)))
            if area > 0:
                dens = dens / area
                dens_mid, density = bl_mid, dens
                method = "risk-neutral N(d2)"
    except Exception:
        logger.exception("N(d2) density failed; using delta method")

    if dens_mid is None:
        # Fallback: delta-derivative on the (possibly synthetic) delta curve.
        strikes = combined["strike"].values
        deltas  = combined["delta"].values
        win = max(5, len(strikes) // 15)
        deltas_smooth = pd.Series(deltas).rolling(win, center=True, min_periods=1).mean().values.clip(0, 1)
        deltas_smooth = np.minimum.accumulate(deltas_smooth)
        dens_raw = np.abs(np.diff(deltas_smooth))
        dens_mid = (strikes[:-1] + strikes[1:]) / 2
        density  = dens_raw / dens_raw.sum() if dens_raw.sum() > 0 else dens_raw

    # Percentiles from the survival function P(S_T > K) (decreasing in K).
    step = np.diff(dens_mid)
    pdf_mid = (density[:-1] + density[1:]) / 2
    cdf = np.concatenate([[0.0], np.cumsum(pdf_mid * step)])
    if cdf[-1] > 0:
        cdf = cdf / cdf[-1]
    surv = 1.0 - cdf
    def _strike_at(p: float) -> float:
        return float(np.interp(p, surv[::-1], dens_mid[::-1]))
    p10, p50, p90 = _strike_at(0.10), _strike_at(0.50), _strike_at(0.90)
    modal_strike = float(dens_mid[int(np.argmax(density))])

    # Survival curve P(S_T > K) — the true risk-neutral CDF (replaces the old
    # N(d1) delta curve). cdf is aligned to dens_mid (same length).
    surv_curve = np.clip(surv, 0.0, 1.0)

    # Downsample density + survival for the chart payload.
    if len(dens_mid) > 160:
        idx = np.linspace(0, len(dens_mid) - 1, 160).astype(int)
        out_mid, out_den, out_surv = dens_mid[idx], density[idx], surv_curve[idx]
    else:
        out_mid, out_den, out_surv = dens_mid, density, surv_curve

    return {
        "expiry": nearest, "S0": round(float(S0), 2), "T": round(T, 4),
        "method": method,
        "modal_strike": round(modal_strike, 2),
        "p10": round(p10, 2), "p50": round(p50, 2), "p90": round(p90, 2),
        "iv_skew": round(iv_skew * 100, 2), "avg_call_iv": round(avg_call_iv * 100, 2),
        "density": [{"strike": round(float(s), 2), "density": round(float(d), 6)} for s, d in zip(out_mid, out_den)],
        "delta_curve": [{"strike": round(float(s), 2), "delta": round(float(d), 4)} for s, d in zip(out_mid, out_surv)],
    }


@router.get("/skew")
@cached(ttl=600, maxsize=128)
def skew_surface(ticker: str):
    """Vol-skew + term-structure tool for premium sellers.

    For each near expiry: ATM IV, 25-delta risk reversal (IV_25dPut - IV_25dCall,
    the directional/crash-fear gauge), and the 25-delta butterfly (wing richness).
    Plus the front-expiry smile (IV vs % moneyness) and a rich/cheap read.
    """
    sym = validate_ticker(ticker)
    try:
        hist = get_history(sym, period="5d")
        S0   = float(hist["Close"].dropna().iloc[-1]) if not hist.empty else None
        if not S0:
            raise HTTPException(404, "No spot price")
        expirations = options_data.get_expirations(sym)
        if not expirations:
            raise HTTPException(404, "No options data")
    except HTTPException:
        raise
    except Exception:
        logger.exception("internal error"); raise HTTPException(500, "Internal server error")

    r = 0.045
    try:
        from routers.rates import risk_free_rate
        r = risk_free_rate()["rate"]
    except Exception:
        pass

    today = pd.Timestamp.today().normalize()
    fut = sorted([e for e in expirations if (pd.to_datetime(e) - today).days >= 3],
                 key=lambda e: pd.to_datetime(e))
    if not fut:
        fut = sorted(expirations, key=lambda e: pd.to_datetime(e))[:6]
    # Span the whole term, not just the near-term cluster: keep the first 6 expiries
    # (weekly granularity) and then evenly sample the rest out to the longest listed
    # (monthlies / quarterlies / LEAPS), so the dropdown covers ~1 week to 1-2 years.
    MAX_EXP = 16
    if len(fut) <= MAX_EXP:
        future = fut
    else:
        head, tail = fut[:6], fut[6:]
        idx = sorted(set(np.linspace(0, len(tail) - 1, MAX_EXP - 6).astype(int).tolist()))
        future = head + [tail[i] for i in idx]

    def _call_delta(K, iv, T):
        if iv <= 0 or T <= 0:
            return np.nan
        d1 = (np.log(S0 / K) + (r + 0.5 * iv ** 2) * T) / (iv * np.sqrt(T))
        return float(norm.cdf(d1))

    term = []
    front_smile = None
    for exp in future:
        T = max((pd.to_datetime(exp) - today).days / 365.25, 1 / 365)
        try:
            ch = options_data.get_chain(sym, exp)
        except Exception:
            continue

        # yfinance's IV column is unreliable (often ~0), so solve IV from the mid
        # price. Window strikes around spot to bound the number of root solves.
        def _bs_c(K, sig):
            d1 = (np.log(S0 / K) + (r + 0.5 * sig ** 2) * T) / (sig * np.sqrt(T))
            return float(S0 * norm.cdf(d1) - K * np.exp(-r * T) * norm.cdf(d1 - sig * np.sqrt(T)))
        def _bs_p(K, sig):
            d1 = (np.log(S0 / K) + (r + 0.5 * sig ** 2) * T) / (sig * np.sqrt(T))
            return float(K * np.exp(-r * T) * norm.cdf(-(d1 - sig * np.sqrt(T))) - S0 * norm.cdf(-d1))
        def _solve(K, mid, is_put):
            fn = _bs_p if is_put else _bs_c
            intrinsic = max((K * np.exp(-r * T) - S0) if is_put else (S0 - K * np.exp(-r * T)), 0)
            if mid < 0.05 or mid <= intrinsic + 0.01:
                return None
            try:
                return float(brentq(lambda s: fn(K, s) - mid, 1e-4, 5.0, maxiter=80))
            except Exception:
                return None
        def _smile_side(df, is_put):
            d = df[["strike", "bid", "ask", "lastPrice"]].copy().dropna(subset=["strike"])
            d["mid"] = np.where(d["bid"] > 0, (d["bid"] + d["ask"]) / 2,
                                np.where(d["ask"] > 0.05, d["ask"] * 0.95, d["lastPrice"].fillna(0)))
            side = d[d["strike"] < S0] if is_put else d[d["strike"] >= S0]
            side = side[(side["strike"] > S0 * 0.6) & (side["strike"] < S0 * 1.6) & (side["mid"] >= 0.05)]
            if side.empty:
                return side.assign(iv=[])[["strike", "iv"]]
            side = side.copy()
            side["iv"] = side.apply(lambda row: _solve(row["strike"], row["mid"], is_put), axis=1)
            return side.dropna(subset=["iv"])[["strike", "iv"]]

        calls = _smile_side(ch.calls, is_put=False)
        puts  = _smile_side(ch.puts,  is_put=True)
        smile = pd.concat([puts, calls]).sort_values("strike").drop_duplicates("strike")
        smile = smile[(smile["strike"] > S0 * 0.5) & (smile["strike"] < S0 * 1.8)]
        if len(smile) < 4:
            continue
        ks  = smile["strike"].to_numpy(float)
        ivs = smile["iv"].to_numpy(float)
        # Fit a smooth quadratic smile in log-moneyness so noisy individual strikes
        # (sparse/stale retail quotes near ATM) don't drive the read. Exclude the
        # innermost ±2% band where put-call quotes disagree the most.
        m = np.log(ks / S0)
        wing = np.abs(m) > 0.02
        mw, ivw = (m[wing], ivs[wing]) if wing.sum() >= 4 else (m, ivs)
        # Need enough distinct moneyness points or the quadratic is ill-conditioned
        # and extrapolates to garbage skew on thin chains.
        if len(np.unique(np.round(mw, 3))) < 3:
            continue
        try:
            c2, c1, c0 = np.polyfit(mw, ivw, 2)
        except Exception:
            continue
        def _fit(mm):
            return float(c2 * mm * mm + c1 * mm + c0)
        atm_iv = max(_fit(0.0), 0.01)
        iv_p10 = max(_fit(float(np.log(0.90))), 0.01)   # 10% OTM put
        iv_c10 = max(_fit(float(np.log(1.10))), 0.01)   # 10% OTM call
        rr = (iv_p10 - iv_c10) * 100                     # put-skew (>0 = downside richer)
        bf = ((iv_p10 + iv_c10) / 2 - atm_iv) * 100      # wing convexity
        # The smoothed fit, sampled across ±15% moneyness — one smile per expiry so
        # the UI can switch expiries instantly without refetching.
        mm = np.linspace(np.log(0.85), np.log(1.15), 60)
        smile_pts = [
            {"moneyness": round(float(np.exp(x) - 1) * 100, 2), "iv": round(max(_fit(float(x)), 0.01) * 100, 2)}
            for x in mm
        ]
        term.append({
            "expiry": exp, "dte": int((pd.to_datetime(exp) - today).days),
            "atm_iv": round(atm_iv * 100, 2), "_atm_raw": atm_iv * 100,
            "rr_25": round(rr, 2), "bf_25": round(bf, 2),
            "smile": smile_pts,
        })
        if front_smile is None:
            front_smile = smile_pts

    if not term:
        raise HTTPException(404, "Insufficient options data for skew")

    front = term[0]
    back  = term[-1]
    ts_slope = round(back["_atm_raw"] - front["_atm_raw"], 2)   # +ve = contango (normal)
    for t_ in term:
        t_.pop("_atm_raw", None)
    rr = front["rr_25"]
    skew_word = "a lot" if rr > 4 else "somewhat" if rr > 1.5 else "barely"
    read = (
        f"Right now, downside protection on {sym} costs {skew_word} more than upside "
        f"({rr:+.0f} vol points). "
        + ("The market is paying up to hedge a drop — that fear premium is richest in out-of-the-money puts."
           if rr > 4 else
           "There's a mild premium for downside, but no strong crash fear priced in."
           if rr > 1.5 else
           "There's little extra cost for downside — the market isn't pricing much crash risk.")
        + " "
        + ("Near-term volatility is running higher than longer-dated, which usually means an event is expected soon and tends to settle back down."
           if ts_slope < -0.5 else
           "Longer-dated volatility is higher than near-term — the normal, calm pattern."
           if ts_slope > 0.5 else
           "Volatility is fairly even across expiries.")
    )

    return {
        "ticker": sym, "spot": round(S0, 2),
        "front_expiry": front["expiry"],
        "atm_iv": front["atm_iv"], "rr_25": front["rr_25"], "bf_25": front["bf_25"],
        "ts_slope": ts_slope,
        "term_structure": term,
        "front_smile": front_smile or [],
        "read": read,
    }
