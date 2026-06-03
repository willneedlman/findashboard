import logging
logger = logging.getLogger(__name__)

import numpy as np
import pandas as pd
import yfinance as yf
from scipy.stats import norm
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
import sys, os
sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))
from math_engine import bs_price, bs_greeks
import fmp
from validation import validate_ticker
from cachetools import TTLCache
import threading

router = APIRouter()

_snap_cache: TTLCache = TTLCache(maxsize=100, ttl=120)
_snap_lock = threading.Lock()


@router.get("/snapshot")
def options_snapshot(ticker: str):
    sym = validate_ticker(ticker)
    with _snap_lock:
        if sym in _snap_cache:
            return _snap_cache[sym]

    tkr = yf.Ticker(sym)

    # ── Price history ─────────────────────────────────────────────────────────
    hist = tkr.history(period="1y")
    if hist.empty:
        raise HTTPException(404, "No price history")

    closes   = hist["Close"].dropna()
    spot     = float(closes.iloc[-1])
    log_ret  = np.log(closes / closes.shift(1)).dropna()

    # 30-day HV (21 trading days ≈ 30 calendar)
    hv_30 = float(log_ret.tail(21).std() * np.sqrt(252) * 100) if len(log_ret) >= 21 else None

    # ── Options chain ─────────────────────────────────────────────────────────
    expiry       = None
    atm_iv       = None
    d50_call     = None   # Price of the ~delta-0.50 (ATM) call
    d50_put      = None   # Price of the ~delta-0.50 (ATM) put
    straddle_px  = None   # ATM straddle dollar price
    pc_vol       = None   # Put/call volume ratio
    implied_move = None

    try:
        import datetime as _dt
        from scipy.optimize import brentq

        def _bs_call(S, K, T_y, r, sigma):
            if T_y <= 0 or sigma <= 0: return max(S - K, 0)
            d1 = (np.log(S / K) + (r + 0.5 * sigma**2) * T_y) / (sigma * np.sqrt(T_y))
            d2 = d1 - sigma * np.sqrt(T_y)
            return S * norm.cdf(d1) - K * np.exp(-r * T_y) * norm.cdf(d2)

        def _bs_put(S, K, T_y, r, sigma):
            if T_y <= 0 or sigma <= 0: return max(K - S, 0)
            d1 = (np.log(S / K) + (r + 0.5 * sigma**2) * T_y) / (sigma * np.sqrt(T_y))
            d2 = d1 - sigma * np.sqrt(T_y)
            return K * np.exp(-r * T_y) * norm.cdf(-d2) - S * norm.cdf(-d1)

        def _implied_vol(price, S, K, T_y, r, flag):
            fn = _bs_call if flag == 'c' else _bs_put
            intrinsic = max(S - K, 0) if flag == 'c' else max(K - S, 0)
            if price <= intrinsic + 1e-6: return None
            try:
                return brentq(lambda v: fn(S, K, T_y, r, v) - price, 0.001, 20.0, xtol=1e-4)
            except Exception:
                return None

        today = _dt.date.today()
        r_rate = 0.045
        future_exps = [e for e in (tkr.options or []) if _dt.date.fromisoformat(e) > today]

        # Pick the first expiry that has any real ATM lastPrice data (lastPrice > 0)
        calls = puts = None
        for exp in future_exps[:12]:
            try:
                c   = tkr.option_chain(exp)
                cf  = c.calls.fillna(0)
                pf  = c.puts.fillna(0)
                atm = cf[(cf["strike"] >= spot * 0.9) & (cf["strike"] <= spot * 1.1)]
                if (atm["lastPrice"] > 0.01).any() or (atm["volume"] > 0).any():
                    expiry = exp
                    calls, puts = cf, pf
                    break
            except Exception:
                continue

        if calls is None and future_exps:
            expiry = future_exps[0]
            c = tkr.option_chain(expiry)
            calls, puts = c.calls.fillna(0), c.puts.fillna(0)

        if calls is not None and expiry:
            exp_dt = _dt.date.fromisoformat(expiry)
            T_y    = max((exp_dt - today).days / 365.25, 1 / 365.25)

            # P/C volume ratio
            call_vol = calls["volume"].sum()
            put_vol  = puts["volume"].sum()
            if call_vol > 0:
                pc_vol = round(float(put_vol / call_vol), 2)

            # ATM strike nearest to spot
            all_strikes = sorted(set(calls["strike"].tolist()) | set(puts["strike"].tolist()))
            if all_strikes:
                atm_strike = min(all_strikes, key=lambda k: abs(k - spot))
                atm_c = calls[calls["strike"] == atm_strike]
                atm_p = puts[puts["strike"] == atm_strike]

                def _best_price(rows):
                    if rows.empty: return 0.0
                    r = rows.iloc[0]
                    bid, ask, last = float(r["bid"]), float(r["ask"]), float(r["lastPrice"])
                    if bid > 0 and ask > 0: return (bid + ask) / 2
                    if ask > 0: return ask
                    return last

                c_price = _best_price(atm_c)
                p_price = _best_price(atm_p)

                # D50 prices — ATM call and put (delta ≈ 0.50 at ATM)
                if c_price > 0.01: d50_call = round(float(c_price), 2)
                if p_price > 0.01: d50_put  = round(float(p_price), 2)

                # Straddle price and implied move
                straddle_val = c_price + p_price
                if straddle_val > 0.01 and spot > 0:
                    straddle_px  = round(float(straddle_val), 2)
                    implied_move = round(float(straddle_val / spot * 100), 1)

                # ATM IV — back-calculate from best available price via B-S inversion
                ivs = []
                if c_price > 0.01:
                    iv = _implied_vol(c_price, spot, atm_strike, T_y, r_rate, 'c')
                    if iv and 0.01 < iv < 5.0: ivs.append(iv)
                if p_price > 0.01:
                    iv = _implied_vol(p_price, spot, atm_strike, T_y, r_rate, 'p')
                    if iv and 0.01 < iv < 5.0: ivs.append(iv)
                if ivs:
                    atm_iv = round(float(np.mean(ivs) * 100), 1)

    except Exception:
        pass

    # Fallback implied move from ATM IV when straddle unavailable
    if implied_move is None and atm_iv is not None and expiry:
        import datetime as _dt2
        T_days = max((_dt2.date.fromisoformat(expiry) - _dt2.date.today()).days, 1)
        implied_move = round(float((atm_iv / 100) * np.sqrt(T_days / 365) * 100), 1)

    # IV premium over HV
    iv_vs_hv = round(float(atm_iv / hv_30), 2) if atm_iv and hv_30 and hv_30 > 0 else None

    # Break-even range: spot ± straddle
    be_upper = round(spot + straddle_px, 2) if straddle_px else None
    be_lower = round(spot - straddle_px, 2) if straddle_px else None

    # Volatility cone: percentile bands of rolling realised vol at each lookback
    vol_cone: dict = {}
    windows = [10, 21, 63, 126, 252]
    for w in windows:
        if len(log_ret) >= w * 2:
            rv = log_ret.rolling(w).std().dropna() * np.sqrt(252) * 100
            vol_cone[str(w)] = {
                'min':     round(float(rv.min()), 1),
                'p25':     round(float(rv.quantile(0.25)), 1),
                'p50':     round(float(rv.median()), 1),
                'p75':     round(float(rv.quantile(0.75)), 1),
                'max':     round(float(rv.max()), 1),
                'current': round(float(rv.iloc[-1]), 1),
            }

    # ── Analyst consensus via yfinance recommendations_summary ───────────────
    consensus      = None
    analyst_count  = None
    latest_action  = None   # e.g. "Needham → Buy  $270"
    price_target   = None

    try:
        summary = tkr.recommendations_summary
        if summary is not None and not summary.empty:
            row = summary.iloc[0]  # current month
            sb  = int(row.get("strongBuy",  0))
            b   = int(row.get("buy",        0))
            h   = int(row.get("hold",       0))
            s   = int(row.get("sell",       0))
            ss  = int(row.get("strongSell", 0))
            total = sb + b + h + s + ss
            if total > 0:
                analyst_count = total
                bull = sb + b
                bear = s + ss
                bull_pct = bull / total
                if bull_pct >= 0.70:
                    consensus = f"Strong Buy  ({sb}SB·{b}B·{h}H·{s+ss}S)"
                elif bull_pct >= 0.50:
                    consensus = f"Moderate Buy  ({sb}SB·{b}B·{h}H·{s+ss}S)"
                elif bear / total >= 0.40:
                    consensus = f"Underperform  ({sb+b}B·{h}H·{s}S·{ss}SS)"
                else:
                    consensus = f"Hold  ({sb+b}B·{h}H·{s+ss}S)"
    except Exception:
        pass

    # Latest upgrade/downgrade with price target
    try:
        ud = tkr.upgrades_downgrades
        if ud is not None and not ud.empty:
            latest = ud.iloc[0]
            firm   = latest.get("Firm", "")
            grade  = latest.get("ToGrade", "")
            pt     = latest.get("currentPriceTarget")
            if firm and grade:
                latest_action = f"{firm}: {grade}"
                if pt and float(pt) > 0:
                    price_target = round(float(pt), 2)
    except Exception:
        pass

    # FMP override if available (more structured)
    if fmp.available():
        try:
            rec = fmp.get_analyst_ratings(sym)
            fmp_rec = rec.get("ratingRecommendation") or rec.get("rating")
            if fmp_rec:
                consensus = fmp_rec
        except Exception:
            pass

    result = {
        "ticker":         sym,
        "spot":           round(spot, 2),
        "expiry":         expiry,
        "atm_iv":         atm_iv,
        "hv_30":          round(hv_30, 1) if hv_30 else None,
        "iv_vs_hv":       iv_vs_hv,
        "d50_call":       d50_call,
        "d50_put":        d50_put,
        "straddle_px":    straddle_px,
        "pc_vol":         pc_vol,
        "be_upper":       be_upper,
        "be_lower":       be_lower,
        "implied_move":   implied_move,
        "consensus":      consensus,
        "vol_cone":       vol_cone,
        "analyst_count":  analyst_count,
        "latest_action":  latest_action,
        "price_target":   price_target,
    }
    with _snap_lock:
        _snap_cache[sym] = result
    return result


class PriceRequest(BaseModel):
    S: float
    K: float
    T: float
    r: float
    sigma: float
    option_type: str = "call"


@router.post("/price")
def price_option(req: PriceRequest):
    T = max(req.T, 0.001)
    price = bs_price(req.S, req.K, T, req.r, req.sigma, req.option_type)
    greeks = bs_greeks(req.S, req.K, T, req.r, req.sigma, req.option_type)

    T_y = T / 365
    r_d = req.r / 100
    sig_d = req.sigma / 100
    d1 = (np.log(req.S / req.K) + (r_d + 0.5 * sig_d**2) * T_y) / (sig_d * np.sqrt(T_y))
    d2 = d1 - sig_d * np.sqrt(T_y)
    vanna = -norm.pdf(d1) * (d2 / sig_d)
    if req.option_type == "call":
        charm = -norm.pdf(d1) * ((r_d / (sig_d * np.sqrt(T_y))) - (d2 / (2 * T_y)))
    else:
        charm = -norm.pdf(d1) * ((r_d / (sig_d * np.sqrt(T_y))) - (d2 / (2 * T_y))) + r_d * np.exp(-r_d * T_y)

    return {
        "price": round(float(price), 4),
        "greeks": {k: round(float(v), 4) for k, v in greeks.items()},
        "vanna": round(float(vanna), 4),
        "charm": round(float(charm), 4),
    }


@router.post("/surface")
def greek_surface(req: PriceRequest):
    spot_range = np.linspace(req.S * 0.6, req.S * 1.4, 80)
    result = {"spot": list(spot_range.round(2))}
    for key in ["delta", "gamma", "theta", "vega"]:
        vals = [bs_greeks(s, req.K, req.T, req.r, req.sigma, req.option_type)[key] for s in spot_range]
        result[key] = [round(float(v), 4) for v in vals]
    return result


@router.post("/payoff")
def payoff(req: PriceRequest):
    spot_range = np.linspace(req.S * 0.5, req.S * 1.5, 200)
    price = bs_price(req.S, req.K, req.T, req.r, req.sigma, req.option_type)
    if req.option_type == "call":
        payoffs = np.maximum(spot_range - req.K, 0) - price
    else:
        payoffs = np.maximum(req.K - spot_range, 0) - price
    return {
        "spot": list(spot_range.round(2)),
        "payoff": list(payoffs.round(4)),
        "strike": req.K,
        "current_spot": req.S,
    }


@router.get("/chain")
def options_chain(ticker: str):
    try:
        tkr = yf.Ticker(ticker.strip().upper())
        expirations = tkr.options
        if not expirations:
            return {"calls": [], "puts": [], "expiry": None, "expirations": []}
        nearest = expirations[0]
        chain = tkr.option_chain(nearest)
        calls = chain.calls[["strike", "lastPrice", "bid", "ask", "volume", "openInterest", "impliedVolatility"]].fillna(0)
        puts = chain.puts[["strike", "lastPrice", "bid", "ask", "volume", "openInterest", "impliedVolatility"]].fillna(0)
        return {
            "expiry": nearest,
            "expirations": list(expirations[:8]),
            "calls": calls.to_dict(orient="records"),
            "puts": puts.to_dict(orient="records"),
        }
    except Exception as e:
        logger.exception("internal error"); raise HTTPException(500, "Internal server error")


@router.get("/gex")
def dealer_gex(ticker: str):
    sym = ticker.strip().upper()
    tkr = yf.Ticker(sym)
    try:
        hist = tkr.history(period="5d")
        spot = float(hist["Close"].dropna().iloc[-1]) if not hist.empty else None
    except Exception:
        spot = None
    if not spot:
        raise HTTPException(404, "Could not fetch spot price")

    r = 0.045
    rows = []
    today = pd.Timestamp.today().normalize()
    for exp in (tkr.options or []):
        exp_dt = pd.to_datetime(exp)
        T = max((exp_dt - today).days / 365.25, 1 / 365.25)
        try:
            chain = tkr.option_chain(exp)
        except Exception:
            continue
        for side, df_side, sign in [("call", chain.calls, 1), ("put", chain.puts, -1)]:
            df_side = df_side[["strike", "openInterest", "impliedVolatility"]].dropna()
            df_side = df_side[(df_side["impliedVolatility"] > 0.01) & (df_side["openInterest"] > 0)]
            for _, row in df_side.iterrows():
                K, oi, iv = float(row["strike"]), float(row["openInterest"]), float(row["impliedVolatility"])
                if K <= 0 or iv <= 0:
                    continue
                try:
                    d1 = (np.log(spot / K) + (r + 0.5 * iv**2) * T) / (iv * np.sqrt(T))
                    gamma = norm.pdf(d1) / (spot * iv * np.sqrt(T))
                    gex_m = sign * oi * 100 * gamma * spot * spot * 0.01 / 1e6
                    rows.append({"strike": K, "side": side, "gex_m": gex_m})
                except Exception:
                    continue

    if not rows:
        return {"spot": spot, "data": []}

    df = pd.DataFrame(rows)
    pivot = (df.groupby(["strike", "side"])["gex_m"].sum()
               .unstack(fill_value=0).rename(columns={"call": "call_gex", "put": "put_gex"}))
    for col in ["call_gex", "put_gex"]:
        if col not in pivot.columns:
            pivot[col] = 0.0
    pivot["net_gex"] = pivot["call_gex"] + pivot["put_gex"]
    pivot = pivot.reset_index().sort_values("strike")
    return {"spot": spot, "data": pivot.round(4).to_dict(orient="records")}


class StrategyLeg(BaseModel):
    option_type: str
    action: str  # "buy" | "sell"
    K: float
    premium: float
    quantity: int = 1


class StrategyRequest(BaseModel):
    S: float
    legs: list[StrategyLeg]


@router.post("/strategy")
def strategy_payoff(req: StrategyRequest):
    spot_range = np.linspace(req.S * 0.5, req.S * 1.5, 300)
    total_payoff = np.zeros(len(spot_range))
    for leg in req.legs:
        sign = 1 if leg.action == "buy" else -1
        if leg.option_type == "call":
            intrinsic = np.maximum(spot_range - leg.K, 0)
        else:
            intrinsic = np.maximum(leg.K - spot_range, 0)
        total_payoff += sign * (intrinsic - leg.premium) * leg.quantity
    return {
        "spot": list(spot_range.round(2)),
        "payoff": list(total_payoff.round(4)),
        "breakeven": float(req.S),
    }
