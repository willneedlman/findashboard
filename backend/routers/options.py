import logging
logger = logging.getLogger(__name__)

import numpy as np
import pandas as pd
import yfinance as yf
from scipy.stats import norm
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field
import sys, os
sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))
from math_engine import bs_price, bs_greeks, bs_core
from cache import get_history
import fmp
import tradier as _tradier
import alpaca
from market_hours import is_market_open, is_overnight_session, session_label
import extended_quotes
from disk_cache import disk_get, disk_set
from validation import validate_ticker
from cachetools import TTLCache
import threading

try:
    from disk_cache import disk_get, disk_set
    _DISK = True
except ImportError:
    def disk_get(_k): return None   # type: ignore
    def disk_set(_k, _v, ttl=0): pass  # type: ignore
    _DISK = False

_SNAP_DISK_TTL = 600   # 10 min — same as in-memory TTL

router = APIRouter()

_snap_cache: TTLCache = TTLCache(maxsize=100, ttl=600)   # 10 min
_snap_lock = threading.Lock()


@router.get("/snapshot")
def options_snapshot(ticker: str):
    sym = validate_ticker(ticker)
    with _snap_lock:
        if sym in _snap_cache:
            return _snap_cache[sym]

    # Check disk cache before hitting any external API
    disk_key = f"snap:v2:{sym}"
    disk_val = disk_get(disk_key)
    if disk_val:
        with _snap_lock:
            _snap_cache[sym] = disk_val
        return disk_val

    tkr = yf.Ticker(sym)

    # ── Price history ─────────────────────────────────────────────────────────
    hist = get_history(sym, period="1y")
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
            return bs_core(S, K, T_y, r, sigma, "call")

        def _bs_put(S, K, T_y, r, sigma):
            return bs_core(S, K, T_y, r, sigma, "put")

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
        tradier_chain = False
        if _tradier.available():
            try:
                future_exps = [e for e in _tradier.get_expirations(sym) if _dt.date.fromisoformat(e) > today]
                tradier_chain = bool(future_exps)
            except Exception:
                future_exps = []
        else:
            future_exps = []
        if not future_exps:
            future_exps = [e for e in (tkr.options or []) if _dt.date.fromisoformat(e) > today]

        calls = puts = None
        for exp in future_exps[:12]:
            try:
                if tradier_chain:
                    chain = _tradier.get_options_chain(sym, exp, greeks=True)
                    cf = pd.DataFrame(chain["calls"]).fillna(0)
                    pf = pd.DataFrame(chain["puts"]).fillna(0)
                else:
                    chain = tkr.option_chain(exp)
                    cf = chain.calls.fillna(0)
                    pf = chain.puts.fillna(0)
                atm = cf[(cf["strike"] >= spot * 0.9) & (cf["strike"] <= spot * 1.1)]
                if not atm.empty and ((atm["lastPrice"] > 0.01).any() or (atm["volume"] > 0).any()):
                    expiry = exp
                    calls, puts = cf, pf
                    break
            except Exception:
                continue

        if calls is None and future_exps:
            expiry = future_exps[0]
            if tradier_chain:
                chain = _tradier.get_options_chain(sym, expiry, greeks=True)
                calls = pd.DataFrame(chain["calls"]).fillna(0)
                puts = pd.DataFrame(chain["puts"]).fillna(0)
            else:
                chain = tkr.option_chain(expiry)
                calls, puts = chain.calls.fillna(0), chain.puts.fillna(0)

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

                if tradier_chain and "delta" in calls and "delta" in puts:
                    d50_c = calls.iloc[(calls["delta"].abs() - 0.5).abs().argsort()[:1]]
                    d50_p = puts.iloc[(puts["delta"].abs() - 0.5).abs().argsort()[:1]]
                    d50_c_price = _best_price(d50_c)
                    d50_p_price = _best_price(d50_p)
                else:
                    d50_c_price, d50_p_price = c_price, p_price
                if d50_c_price > 0.01: d50_call = round(float(d50_c_price), 2)
                if d50_p_price > 0.01: d50_put = round(float(d50_p_price), 2)

                # Straddle price and implied move
                straddle_val = c_price + p_price
                if straddle_val > 0.01 and spot > 0:
                    straddle_px  = round(float(straddle_val), 2)
                    implied_move = round(float(straddle_val / spot * 100), 1)

                ivs = []
                if tradier_chain and "impliedVolatility" in atm_c and not atm_c.empty:
                    iv = float(atm_c.iloc[0]["impliedVolatility"])
                    if 0.01 < iv < 5.0: ivs.append(iv)
                if tradier_chain and "impliedVolatility" in atm_p and not atm_p.empty:
                    iv = float(atm_p.iloc[0]["impliedVolatility"])
                    if 0.01 < iv < 5.0: ivs.append(iv)
                if not ivs and c_price > 0.01:
                    iv = _implied_vol(c_price, spot, atm_strike, T_y, r_rate, 'c')
                    if iv and 0.01 < iv < 5.0: ivs.append(iv)
                if not ivs and p_price > 0.01:
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

    # Volatility cone: percentile bands of rolling realized vol at each lookback
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

    # IV Rank proxy: a real historical implied-vol series isn't available for
    # arbitrary tickers, so this ranks today's 21d realized vol within its own
    # trailing-1y distribution. Scaling every historical value by the same
    # atm_iv/hv_30 factor (the technique the IV Tracker's snapshot history
    # uses) would preserve this exact rank, since it's a positive affine
    # transform — so this is a defensible stand-in, not a fabricated series.
    iv_rank = None
    if '21' in vol_cone:
        c21 = vol_cone['21']
        mn, mx = c21['min'], c21['max']
        iv_rank = round((c21['current'] - mn) / (mx - mn) * 100, 1) if mx > mn else 50.0

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
        "iv_rank":        iv_rank,
        "consensus":      consensus,
        "vol_cone":       vol_cone,
        "analyst_count":  analyst_count,
        "latest_action":  latest_action,
        "price_target":   price_target,
        "options_source": "tradier" if tradier_chain else "yfinance",
    }
    with _snap_lock:
        _snap_cache[sym] = result
    disk_set(disk_key, result, ttl=_SNAP_DISK_TTL)
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
    # Floor sigma off zero: at sigma=0 the Black-Scholes d1 divides by zero,
    # giving NaN greeks that serialize to invalid JSON and break the panel.
    sigma = max(req.sigma, 1e-6)
    price = bs_price(req.S, req.K, T, req.r, sigma, req.option_type)
    greeks = bs_greeks(req.S, req.K, T, req.r, sigma, req.option_type)
    vanna, charm = _vanna_charm(req.S, req.K, T, req.r, sigma)

    # Lambda (a.k.a. omega / elasticity): percent change in option value per
    # percent change in the underlying — the option's effective leverage.
    lam = float(greeks["delta"]) * req.S / price if price > 0 else 0.0

    return {
        "price": round(float(price), 4),
        "greeks": {k: round(float(v), 4) for k, v in greeks.items()},
        "vanna": round(float(vanna), 4),
        "charm": round(float(charm), 4),
        "lambda": round(lam, 4),
    }


@router.post("/surface")
def greek_surface(req: PriceRequest):
    # Floor T and sigma off zero so a 0-DTE / zero-vol contract yields finite
    # greeks instead of NaN (which serializes to invalid JSON).
    T = max(req.T, 0.001)
    sigma = max(req.sigma, 1e-6)
    spot_range = np.linspace(req.S * 0.6, req.S * 1.4, 80)
    result = {"spot": list(spot_range.round(2))}
    for key in ["delta", "gamma", "theta", "vega"]:
        vals = [bs_greeks(s, req.K, T, req.r, sigma, req.option_type)[key] for s in spot_range]
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


def _vanna_charm(S, K, T_days, r_pct, sigma_pct):
    """Second-order greeks in the same units bs_greeks uses (T in days, r/sigma in %)."""
    T_y = max(T_days, 0.001) / 365
    r_d = r_pct / 100
    sig_d = max(sigma_pct, 1e-6) / 100
    sqrtT = np.sqrt(T_y)
    d1 = (np.log(S / K) + (r_d + 0.5 * sig_d**2) * T_y) / (sig_d * sqrtT)
    d2 = d1 - sig_d * sqrtT
    vanna = -norm.pdf(d1) * (d2 / sig_d)
    charm = -norm.pdf(d1) * ((r_d / (sig_d * sqrtT)) - (d2 / (2 * T_y)))
    return float(vanna), float(charm)


class BSLeg(BaseModel):
    option_type: str = "call"
    side: int = 1          # +1 long (buy), -1 short (sell)
    qty: float = Field(1.0, gt=0)
    K: float = Field(gt=0)
    T: float               # days to expiry
    sigma: float           # implied vol, percent


class BSStrategyRequest(BaseModel):
    S: float = Field(gt=0)
    r: float
    legs: list[BSLeg] = Field(min_length=1, max_length=20)


@router.post("/multi-leg")
def price_multi_leg(req: BSStrategyRequest):
    """Net premium, greeks, expiry payoff, and greek surfaces for a multi-leg
    position. Each leg is priced with the same Black-Scholes primitives as the
    single-leg endpoints, then weighted by side (+1 long / -1 short) and quantity
    and summed. net_price > 0 is a net debit paid, < 0 a net credit received."""
    S = req.S
    strikes = [leg.K for leg in req.legs]
    lo = min([S] + strikes)
    hi = max([S] + strikes)
    # Start the grid near zero so a put leg's max profit (long) or max loss
    # (short), which sits at S -> 0, is sampled rather than read off a truncated
    # floor. Snap the strikes and current spot in too, so the payoff kinks (where
    # the extremes and breakevens actually sit) land exactly on grid points.
    base = np.linspace(0.01, hi * 1.5, 200)
    spot_range = np.unique(np.concatenate([base, strikes, [S]]))
    surf_spot = np.linspace(max(lo * 0.6, 0.01), hi * 1.4, 80)

    net = {"delta": 0.0, "gamma": 0.0, "theta": 0.0, "vega": 0.0}
    net_vanna = net_charm = net_price = 0.0
    payoff_curve = np.zeros_like(spot_range)
    surface = {k: np.zeros_like(surf_spot) for k in net}
    legs_out = []

    for leg in req.legs:
        T = max(leg.T, 0.001)
        sigma = max(leg.sigma, 1e-6)
        w = leg.side * leg.qty
        price = bs_price(S, leg.K, T, req.r, sigma, leg.option_type)
        g = bs_greeks(S, leg.K, T, req.r, sigma, leg.option_type)
        vanna, charm = _vanna_charm(S, leg.K, T, req.r, sigma)

        net_price += w * price
        for k in net:
            net[k] += w * float(g[k])
        net_vanna += w * vanna
        net_charm += w * charm

        if leg.option_type == "call":
            intrinsic = np.maximum(spot_range - leg.K, 0)
        else:
            intrinsic = np.maximum(leg.K - spot_range, 0)
        payoff_curve += w * (intrinsic - price)

        for k in surface:
            surface[k] += w * np.array(
                [bs_greeks(s, leg.K, T, req.r, sigma, leg.option_type)[k] for s in surf_spot]
            )

        legs_out.append({
            "option_type": leg.option_type, "side": leg.side, "qty": leg.qty,
            "K": leg.K, "T": leg.T, "sigma": leg.sigma,
            "price": round(float(price), 4),
            "greeks": {k: round(float(v), 4) for k, v in g.items()},
        })

    lam = net["delta"] * S / abs(net_price) if abs(net_price) > 1e-9 else 0.0

    breakevens = []
    for i in range(1, len(spot_range)):
        y0, y1 = payoff_curve[i - 1], payoff_curve[i]
        if y0 == 0:
            breakevens.append(round(float(spot_range[i - 1]), 2))
        elif y0 * y1 < 0:
            x = spot_range[i - 1] + (spot_range[i] - spot_range[i - 1]) * (-y0) / (y1 - y0)
            breakevens.append(round(float(x), 2))
    # A breakeven that coincides with a snapped strike can be caught by both the
    # exact-zero node and the adjacent crossing; dedup so the chip lists each once.
    breakevens = sorted(set(breakevens))

    imax, imin = int(np.argmax(payoff_curve)), int(np.argmin(payoff_curve))
    # Standard options only run away at the high-spot tail (S -> inf): a long call
    # has unbounded profit, a short call unbounded loss. A flat plateau at the
    # sample edge is bounded, so test the slope there, not just the extreme index.
    right_slope = float(payoff_curve[-1] - payoff_curve[-2])
    eps = 1e-3

    return {
        "net_price": round(float(net_price), 4),
        "greeks": {k: round(float(v), 4) for k, v in net.items()},
        "vanna": round(net_vanna, 4),
        "charm": round(net_charm, 4),
        "lambda": round(float(lam), 4),
        "spot": list(spot_range.round(2)),
        "payoff": list(payoff_curve.round(4)),
        "surface": {"spot": list(surf_spot.round(2)),
                    **{k: [round(float(v), 4) for v in surface[k]] for k in surface}},
        "legs": legs_out,
        "breakevens": breakevens,
        "max_profit": round(float(payoff_curve[imax]), 4),
        "max_loss": round(float(payoff_curve[imin]), 4),
        "max_profit_unbounded": right_slope > eps,
        "max_loss_unbounded": right_slope < -eps,
        "current_spot": S,
    }


@router.get("/chain")
def options_chain(ticker: str, expiry: str | None = None):
    import datetime as _dt
    try:
        sym = ticker.strip().upper()

        # ── Tradier: get expirations + spot ───────────────────────────────────
        try:
            expirations = _tradier.get_expirations(sym)
            quote = _tradier.get_quote(sym)
            spot = float(quote.get("last") or quote.get("close") or 0) or None
        except Exception as e:
            logger.warning("Tradier chain fallback to yfinance: %s", e)
            expirations = []
            spot = None

        # Fall back to yfinance for expirations/spot if Tradier fails
        if not expirations:
            tkr = yf.Ticker(sym)
            expirations = list(tkr.options or [])
            if not spot:
                try:
                    hist = get_history(sym, period="2d")
                    spot = float(hist["Close"].dropna().iloc[-1]) if not hist.empty else None
                except Exception:
                    pass

        if not expirations:
            return {"calls": [], "puts": [], "expiry": None, "expirations": [], "spot": None}

        today = _dt.date.today()
        # Include today's expiry so 0-DTE contracts are tradeable in the chain.
        future_exps = [e for e in expirations if _dt.date.fromisoformat(e) >= today]
        valid_exps  = future_exps if future_exps else list(expirations)
        target = expiry if (expiry and expiry in valid_exps) else valid_exps[0]

        # ── Fetch chain from Tradier, fall back to yfinance ──────────────────
        try:
            chain = _tradier.get_options_chain(sym, target)
            calls, puts = chain["calls"], chain["puts"]
        except Exception as e:
            logger.warning("Tradier chain fetch failed, falling back to yfinance: %s", e)
            calls, puts = [], []

        if not calls and not puts:
            try:
                yf_chain = yf.Ticker(sym).option_chain(target)
                def _yf_rows(df):
                    out = []
                    for _, r in df.fillna(0).iterrows():
                        out.append({
                            "strike":            float(r.get("strike", 0)),
                            "lastPrice":         float(r.get("lastPrice", 0)),
                            "bid":               float(r.get("bid", 0)),
                            "ask":               float(r.get("ask", 0)),
                            "volume":            int(r.get("volume", 0)),
                            "openInterest":      int(r.get("openInterest", 0)),
                            "impliedVolatility": float(r.get("impliedVolatility", 0)),
                            "delta": 0, "gamma": 0,
                        })
                    return out
                calls = _yf_rows(yf_chain.calls)
                puts  = _yf_rows(yf_chain.puts)
            except Exception as e2:
                logger.warning("yfinance chain fallback failed: %s", e2)

        exp_dt = _dt.date.fromisoformat(target)
        dte    = max((exp_dt - today).days, 0)   # 0 = expires today

        # Precise time to expiry in days. For 0-DTE the calendar-day count is 0,
        # which prices the option at pure intrinsic; instead measure the hours
        # left until the 4:00 PM ET close so the model still reflects the
        # remaining intraday time value. Multi-day contracts keep whole days.
        t_days = float(dte)
        if dte == 0:
            try:
                from zoneinfo import ZoneInfo
                ny = ZoneInfo("America/New_York")
                close = _dt.datetime.combine(exp_dt, _dt.time(16, 0), tzinfo=ny)
                secs_left = (close - _dt.datetime.now(ny)).total_seconds()
                t_days = max(secs_left / 86400.0, 1.0 / 1440)   # floor at ~1 minute
            except Exception:
                t_days = 1.0 / 24   # ~1 hour if the tz lookup fails

        # Tradier returns IV as a decimal (smv_vol); convert to pct and compute missing greeks
        r_pct = 5.0
        g_dte = max(t_days, 1.0 / 1440)   # keep greeks math off T=0
        def _enrich(rows: list[dict], flag: str) -> list[dict]:
            for row in rows:
                iv_dec = float(row.get("impliedVolatility") or 0)
                iv_pct = iv_dec * 100 if iv_dec < 1.0 else iv_dec  # already pct if >= 1.0
                if iv_pct < 0.5:
                    iv_pct = 25.0
                row["impliedVolatility"] = round(iv_pct / 100, 4)  # keep as decimal for UI compat
                if not row.get("gamma") and spot and spot > 0:
                    try:
                        g = bs_greeks(spot, float(row["strike"]), g_dte, r_pct, iv_pct, flag)
                        row.setdefault("delta", round(g["delta"], 4))
                        row.setdefault("gamma", round(g["gamma"], 4))
                        row["theta"] = round(g["theta"], 4)
                        row["vega"]  = round(g["vega"],  4)
                    except Exception:
                        pass
            return rows

        return {
            "expiry":      target,
            "expirations": valid_exps[:12],
            "spot":        round(spot, 2) if spot else None,
            "dte":         dte,
            "t_days":      round(t_days, 4),
            "calls":       _enrich(calls, "call"),
            "puts":        _enrich(puts,  "put"),
        }
    except Exception:
        logger.exception("chain error"); raise HTTPException(500, "Internal server error")


class MarkLeg(BaseModel):
    underlying:   str
    expiry:       str            # YYYY-MM-DD
    strike:       float
    option_type:  str            # 'call' | 'put'


class MarksRequest(BaseModel):
    legs: list[MarkLeg] = Field(min_length=1, max_length=50)


@router.post("/marks")
def option_marks(req: MarksRequest):
    """Current mark + delta per option leg, for portfolio mark-to-market.

    During regular hours: live chain mid (bid/ask), then last trade, then
    Black-Scholes off the chain's spot and IV if the contract isn't listed.

    Once the session closes the chain's quotes are frozen prints from a market
    that has stopped trading, so they cannot show what the underlying did after
    the bell. When an extended-hours price exists for the underlying, the mark is
    re-derived with Black-Scholes off that spot at the chain's IV. It is not a
    traded price and is labelled so, but it moves with the book, which a stale
    closing mid does not.

    One chain fetch per unique (underlying, expiry) is reused across legs."""
    _RF = 5.0  # risk-free %, matches the chain endpoint
    chain_cache: dict[tuple[str, str], dict] = {}
    market_open = is_market_open()
    overnight_active = is_overnight_session()
    use_extended_spot = not market_open and session_label() in {"pre-market", "after-hours"}
    underlyings = tuple(dict.fromkeys(leg.underlying.strip().upper() for leg in req.legs))
    overnight_quotes = alpaca.get_latest_overnight_quotes(underlyings) if overnight_active else {}
    ext_cache: dict[str, float | None] = {}

    def get_extended_spot(sym: str) -> tuple[float | None, str | None]:
        if overnight_active:
            quote = overnight_quotes.get(sym) or {}
            return quote.get("price"), "overnight" if quote.get("price") else None
        if not use_extended_spot:
            return None, None
        if sym not in ext_cache:
            ext_cache[sym] = extended_quotes.extended_spot(sym)
        return ext_cache[sym], "extended" if ext_cache[sym] else None

    def get_chain(sym: str, exp: str) -> dict:
        key = (sym, exp)
        if key not in chain_cache:
            try:
                chain_cache[key] = options_chain(ticker=sym, expiry=exp)
            except Exception:
                chain_cache[key] = {"calls": [], "puts": [], "spot": None, "dte": 1}
        return chain_cache[key]

    out = []
    for leg in req.legs:
        sym  = leg.underlying.strip().upper()
        flag = "put" if leg.option_type.lower().startswith("p") else "call"
        chain = get_chain(sym, leg.expiry)
        rows = (chain.get("puts") if flag == "put" else chain.get("calls")) or []
        spot = chain.get("spot")
        dte  = chain.get("dte") or 1

        match = next((r for r in rows if abs(float(r.get("strike") or 0) - leg.strike) < 0.01), None)
        mark = None
        iv   = float(match.get("impliedVolatility") or 0) if match else 0.0
        source = None

        # Overnight the underlying keeps moving while the chain does not, so a
        # price derived off the extended spot beats the frozen closing quote.
        ext_spot, spot_source = get_extended_spot(sym)
        eff_spot = ext_spot if ext_spot and ext_spot > 0 else spot

        if match and ext_spot is None:
            bid, ask = float(match.get("bid") or 0), float(match.get("ask") or 0)
            last = float(match.get("lastPrice") or 0)
            if bid > 0 and ask > 0:
                mark, source = round((bid + ask) / 2, 4), "chain"
            elif last > 0:
                mark, source = round(last, 4), "chain"

        if mark is None and eff_spot and eff_spot > 0:
            if iv <= 0:
                ivs = [float(r.get("impliedVolatility") or 0) for r in rows if float(r.get("impliedVolatility") or 0) > 0]
                iv = (sum(ivs) / len(ivs)) if ivs else 0.30
            iv_pct = iv * 100 if iv < 1.0 else iv
            try:
                mark = round(float(bs_price(eff_spot, leg.strike, dte, _RF, iv_pct, flag)), 4)
                source = "bs-overnight" if spot_source == "overnight" else "bs-extended" if ext_spot else "bs"
            except Exception:
                mark = None

        delta = None
        # A chain delta is quoted against the chain's spot, so it is only valid
        # while that is the spot we are marking against.
        if match and match.get("delta") and ext_spot is None:
            delta = round(float(match["delta"]), 4)
        elif eff_spot and eff_spot > 0:
            iv_pct = (iv * 100 if 0 < iv < 1.0 else (iv or 30.0))
            try:
                delta = round(float(bs_greeks(eff_spot, leg.strike, dte, _RF, iv_pct, flag)["delta"]), 4)
            except Exception:
                delta = None

        out.append({"mark": mark, "iv": round(iv, 4) if iv else None,
                    "delta": delta, "source": source,
                    "spot": round(float(eff_spot), 4) if eff_spot else None})
    return {"marks": out}


def _gex_levels(pivot: pd.DataFrame, spot: float) -> dict:
    ordered = pivot.sort_values("strike").reset_index(drop=True)
    flip_candidates: list[float] = []
    for i, row in ordered.iterrows():
        strike = float(row["strike"])
        net = float(row["net_gex"])
        if net == 0:
            flip_candidates.append(strike)
        if i == len(ordered) - 1:
            continue
        next_row = ordered.iloc[i + 1]
        next_net = float(next_row["net_gex"])
        if net * next_net < 0:
            next_strike = float(next_row["strike"])
            flip_candidates.append(strike - net * (next_strike - strike) / (next_net - net))

    positive = ordered[ordered["net_gex"] > 0]
    negative = ordered[ordered["net_gex"] < 0]
    pos_row = positive.loc[positive["net_gex"].idxmax()] if not positive.empty else None
    neg_row = negative.loc[negative["net_gex"].idxmin()] if not negative.empty else None

    def level(row) -> dict | None:
        if row is None:
            return None
        return {"strike": round(float(row["strike"]), 4), "gex_m": round(float(row["net_gex"]), 4)}

    return {
        "flip": round(min(flip_candidates, key=lambda value: abs(value - spot)), 4) if flip_candidates else None,
        "max_positive_gex": level(pos_row),
        "max_negative_gex": level(neg_row),
        "total_net_gex": round(float(ordered["net_gex"].sum()), 4),
    }


@router.get("/gex")
def dealer_gex(ticker: str, expiry: str | None = None):
    import datetime as _dt
    sym = ticker.strip().upper()
    open_now = is_market_open()
    # v2: GEX now sources chains from Tradier 24/7 (reliable OI + greeks) rather
    # than yfinance-only when closed; bump invalidates stale near-empty caches.
    cache_key = f"gex:v3:{sym}:{expiry or 'all'}"

    # Market closed → the profile can't change intraday, so serve the last cached
    # one instead of refetching. BUT only if that cache reflects the most recent
    # close: a cache built before the latest session closed (e.g. pre-market)
    # carries a stale spot/profile. Validate against the latest close and recompute
    # when a newer session has closed since.
    if not open_now:
        cached = disk_get(cache_key)
        if cached:
            stale = False
            try:
                latest_close = float(get_history(sym, period="5d")["Close"].dropna().iloc[-1])
                stale = bool(cached.get("spot")) and abs(float(cached["spot"]) - latest_close) > 0.01
            except Exception:
                stale = False   # can't verify → cached profile beats failing
            if not stale:
                cached["delayed"] = True
                return cached

    # ── Spot price (Tradier only while live; else yfinance) ─────────────────────
    spot = None
    quote_ms = None
    if open_now:
        try:
            quote = _tradier.get_quote(sym)
            spot = float(quote.get("last") or quote.get("close") or 0) or None
            quote_ms = quote.get("trade_date")  # epoch ms of the last quote — the true "as of"
        except Exception:
            pass
    if not spot:
        try:
            hist = get_history(sym, period="5d")
            spot = float(hist["Close"].dropna().iloc[-1]) if not hist.empty else None
        except Exception:
            pass
    if not spot:
        raise HTTPException(404, "Could not fetch spot price")

    # ── Expirations (Tradier first for chain-string parity; else yfinance) ──────
    all_expirations = []
    try:
        all_expirations = _tradier.get_expirations(sym)
    except Exception:
        pass
    if not all_expirations:
        try:
            all_expirations = list(yf.Ticker(sym).options or [])
        except Exception:
            all_expirations = []

    today = _dt.date.today()
    future_exps = [e for e in all_expirations if _dt.date.fromisoformat(e) > today]
    # A requested expiry only narrows the scan if it actually exists for this
    # symbol; otherwise we aggregate (and report expiry=None so the UI doesn't
    # claim a single-expiry profile it didn't compute). Off-hours we cap the
    # fan-out lower — gamma is near-term dominated and the data can't change.
    used_expiry = expiry if (expiry and expiry in all_expirations) else None
    exps_to_process = ([used_expiry] if used_expiry
                       else future_exps[:(18 if open_now else 8)])

    r = 0.045
    rows = []
    used_yf_fallback = False

    for exp in exps_to_process:
        exp_dt   = _dt.date.fromisoformat(exp)
        days_out = max((exp_dt - today).days, 1)
        T        = days_out / 365.25

        # ── Fetch chain via Tradier (24/7 — reliable OI + greeks), else yfinance ──
        chain = None
        try:
            chain = _tradier.get_options_chain(sym, exp, greeks=True)
        except Exception as e:
            logger.warning("Tradier GEX chain %s %s: %s", sym, exp, e)

        if not chain or (not chain.get("calls") and not chain.get("puts")):
            used_yf_fallback = True
            try:
                yf_chain = yf.Ticker(sym).option_chain(exp)
                def _yf_gex_rows(df):
                    out = []
                    for _, r in df.fillna(0).iterrows():
                        out.append({
                            "strike":            float(r.get("strike", 0)),
                            "openInterest":      int(r.get("openInterest", 0)),
                            "impliedVolatility": float(r.get("impliedVolatility", 0)),
                            "gamma": 0,
                        })
                    return out
                chain = {"calls": _yf_gex_rows(yf_chain.calls), "puts": _yf_gex_rows(yf_chain.puts)}
            except Exception as e2:
                logger.warning("yfinance GEX fallback %s %s: %s", sym, exp, e2)
                continue

        for side, options, sign in [("call", chain["calls"], 1), ("put", chain["puts"], -1)]:
            for o in options:
                K   = float(o.get("strike") or 0)
                oi  = float(o.get("openInterest") or 0)
                if K <= 0 or oi <= 0:
                    continue

                # Use Tradier's gamma directly if available; otherwise compute from IV
                gamma = float(o.get("gamma") or 0)
                if not gamma:
                    iv_dec = float(o.get("impliedVolatility") or 0)
                    iv = iv_dec if iv_dec >= 0.05 else 0.20
                    try:
                        d1 = (np.log(spot / K) + (r + 0.5 * iv**2) * T) / (iv * np.sqrt(T))
                        gamma = float(norm.pdf(d1) / (spot * iv * np.sqrt(T)))
                    except Exception:
                        continue

                gex_m = sign * oi * 100 * gamma * spot * spot * 0.01 / 1e6
                rows.append({"strike": K, "side": side, "gex_m": gex_m})

    # ── Data-freshness metadata — this tool must be transparent about staleness ──
    _env = os.getenv("TRADIER_ENV", "sandbox")
    _qdt = None
    if quote_ms:
        try:
            _qdt = _dt.datetime.fromtimestamp(int(quote_ms) / 1000, _dt.timezone.utc)
        except Exception:
            pass
    # "delayed" reflects the ACTUAL age of the quote, not assumptions about the feed.
    _age_s = (_dt.datetime.now(_dt.timezone.utc) - _qdt).total_seconds() if _qdt else None
    _delayed = (_age_s is None) or (_age_s > 180)
    if used_yf_fallback:
        _source = "yfinance"
    elif _env == "production":
        _source = "Tradier"
    else:
        _source = "Tradier sandbox"
    _meta = {
        "as_of": _dt.datetime.now(_dt.timezone.utc).isoformat(),
        "quote_time": _qdt.isoformat() if _qdt else None,
        "source": _source,
        "delayed": _delayed,
    }

    if not rows:
        return {
            "spot": spot,
            "data": [],
            "expirations": all_expirations,
            "expiry": used_expiry,
            "flip": None,
            "max_positive_gex": None,
            "max_negative_gex": None,
            "total_net_gex": 0,
            **_meta,
        }

    df = pd.DataFrame(rows)
    pivot = (df.groupby(["strike", "side"])["gex_m"].sum()
               .unstack(fill_value=0).rename(columns={"call": "call_gex", "put": "put_gex"}))
    for col in ["call_gex", "put_gex"]:
        if col not in pivot.columns:
            pivot[col] = 0.0
    pivot["net_gex"] = pivot["call_gex"] + pivot["put_gex"]
    pivot = pivot.reset_index().sort_values("strike")
    levels = _gex_levels(pivot, float(spot))
    result = {
        "spot": spot,
        "data": pivot.round(4).to_dict(orient="records"),
        "expirations": all_expirations,
        "expiry": used_expiry,
        **levels,
        **_meta,
    }
    disk_set(cache_key, result, ttl=86400)   # reuse while the market is closed
    # Full-chain profiles feed the accruing daily GEX history (Chart Studio).
    if expiry is None:
        try:
            from routers.snapshots import record_point
            net = float(pivot["net_gex"].sum())
            point = {"v": round(net, 2), "spot": round(float(spot), 2) if spot else None}
            # Record the flip too — without it the accrued history can't answer
            # "was this level defended?", only "was net gamma up or down".
            if levels.get("flip") is not None:
                point["flip"] = round(float(levels["flip"]), 2)
            record_point("gex", sym, point)
        except Exception:
            pass
    return result


_expo_cache: TTLCache = TTLCache(maxsize=32, ttl=300)   # 5 min while the market is open


def _next_monthly_opex(expiries: list[str], today) -> str | None:
    """The next monthly OPEX (third Friday) that is actually listed.

    Gamma is near-term dominated, so a window of the N nearest expiries is the
    right default — but on a name with daily expiries that window can end days
    before the monthly, which is the single biggest open-interest concentration
    on the board. This pulls it back in whatever N is.
    """
    import calendar as _cal
    import datetime as _dt
    for offset in (0, 1, 2):
        m = today.month + offset
        y = today.year + (m - 1) // 12
        m = (m - 1) % 12 + 1
        fridays = [d for d in range(1, _cal.monthrange(y, m)[1] + 1)
                   if _dt.date(y, m, d).weekday() == 4]
        if len(fridays) < 3:
            continue
        third = _dt.date(y, m, fridays[2])
        if third < today:
            continue
        if third.isoformat() in expiries:
            return third.isoformat()
    return None


def _expo_greeks(S: float, K: float, T: float, r: float, iv: float, is_call: bool) -> dict:
    """d1/d2-derived greeks for one contract. Vanna and charm are never supplied
    by the feed, so they are always modelled; delta and gamma are modelled only
    when the feed omits them, so GEX here ties out to /gex exactly.

    With no dividend, put delta is call delta minus one, so vanna (dDelta/dSigma)
    and charm (dDelta/dt) are identical for both sides — the call/put sign in the
    exposure sums, not the greek, carries the dealer-positioning assumption.
    """
    sqrt_t = np.sqrt(T)
    d1 = (np.log(S / K) + (r + 0.5 * iv ** 2) * T) / (iv * sqrt_t)
    d2 = d1 - iv * sqrt_t
    pdf = float(norm.pdf(d1))
    return {
        "delta": float(norm.cdf(d1)) if is_call else float(norm.cdf(d1)) - 1.0,
        "gamma": pdf / (S * iv * sqrt_t),
        "vanna": -pdf * d2 / iv,                                           # per 1.00 of vol
        "charm": -(pdf * (2 * r * T - d2 * iv * sqrt_t) / (2 * T * iv * sqrt_t)) / 365,   # per calendar day
    }


@router.get("/exposure")
def dealer_exposure(ticker: str, expiries: int = 8, min_volume: int = 250, min_vol_oi: float = 1.0):
    """Dealer positioning across the expiry term structure: gamma, delta, vanna
    and charm exposure per strike and per expiry, plus the vol/OI flow screen —
    all off ONE pass over the same chains.

    /gex answers "where are dealers positioned" one expiry at a time. Dealer
    books are the sum across expiries, and the greeks that say how that book
    moves when vol or time changes (vanna, charm) come free from the same rows.
    """
    import datetime as _dt
    sym = validate_ticker(ticker)
    n_exp = max(1, min(int(expiries), 32))
    open_now = is_market_open()
    cache_key = f"gexpo:v3:{sym}:{n_exp}:{min_volume}:{min_vol_oi}"

    if open_now:
        hit = _expo_cache.get(cache_key)
        if hit:
            return hit
    else:
        cached = disk_get(cache_key)
        if cached:
            # A cache built before the last session closed carries a stale spot.
            try:
                latest_close = float(get_history(sym, period="5d")["Close"].dropna().iloc[-1])
                stale = bool(cached.get("spot")) and abs(float(cached["spot"]) - latest_close) > 0.01
            except Exception:
                stale = False
            if not stale:
                cached["delayed"] = True
                return cached

    # ── Spot ────────────────────────────────────────────────────────────────
    spot, quote_ms = None, None
    if open_now:
        try:
            q = _tradier.get_quote(sym)
            spot = float(q.get("last") or q.get("close") or 0) or None
            quote_ms = q.get("trade_date")
        except Exception:
            pass
    if not spot:
        try:
            hist = get_history(sym, period="5d")
            spot = float(hist["Close"].dropna().iloc[-1]) if not hist.empty else None
        except Exception:
            pass
    if not spot:
        raise HTTPException(404, "Could not fetch spot price")

    # ── Expirations ─────────────────────────────────────────────────────────
    all_exps: list[str] = []
    try:
        all_exps = _tradier.get_expirations(sym)
    except Exception:
        pass
    if not all_exps:
        try:
            all_exps = list(yf.Ticker(sym).options or [])
        except Exception:
            all_exps = []
    today = _dt.date.today()
    future = [e for e in all_exps if _dt.date.fromisoformat(e) >= today]
    if not future:
        raise HTTPException(404, "No listed expirations")
    processed = future[:n_exp]
    opex = _next_monthly_opex(future, today)
    if opex and opex not in processed:
        processed = sorted(set(processed + [opex]))

    # Strikes far from spot carry no dealer risk worth charting and would triple
    # the payload, so the window is fixed here rather than in the client.
    lo, hi = spot * 0.65, spot * 1.35
    r = 0.045
    used_yf = False
    per_exp: list[dict] = []
    by_exp_strike: dict[str, list[dict]] = {}
    flow: list[dict] = []

    def _blank(strike: float) -> dict:
        return {"strike": strike, "call_gex": 0.0, "put_gex": 0.0, "net_gex": 0.0,
                "net_dex": 0.0, "net_vanna": 0.0, "net_charm": 0.0,
                "call_oi": 0, "put_oi": 0, "call_vol": 0, "put_vol": 0}

    for exp in processed:
        exp_dt = _dt.date.fromisoformat(exp)
        dte = max((exp_dt - today).days, 0)
        T = max(dte, 1) / 365.25

        chain = None
        try:
            chain = _tradier.get_options_chain(sym, exp, greeks=True)
        except Exception as e:
            logger.warning("Tradier exposure chain %s %s: %s", sym, exp, e)
        if not chain or (not chain.get("calls") and not chain.get("puts")):
            used_yf = True
            try:
                yc = yf.Ticker(sym).option_chain(exp)

                def _rows(df):
                    return [{
                        "strike": float(x.get("strike", 0)),
                        "openInterest": int(x.get("openInterest", 0)),
                        "volume": int(x.get("volume", 0)),
                        "impliedVolatility": float(x.get("impliedVolatility", 0)),
                        "bid": float(x.get("bid", 0)), "ask": float(x.get("ask", 0)),
                        "lastPrice": float(x.get("lastPrice", 0)),
                        "delta": 0, "gamma": 0,
                    } for _, x in df.fillna(0).iterrows()]
                chain = {"calls": _rows(yc.calls), "puts": _rows(yc.puts)}
            except Exception as e2:
                logger.warning("yfinance exposure fallback %s %s: %s", sym, exp, e2)
                continue

        strikes: dict[float, dict] = {}
        for side, rows, sign in (("call", chain["calls"], 1), ("put", chain["puts"], -1)):
            is_call = side == "call"
            for o in rows:
                K = float(o.get("strike") or 0)
                if K <= 0 or not (lo <= K <= hi):
                    continue
                oi = float(o.get("openInterest") or 0)
                vol = float(o.get("volume") or 0)
                if oi <= 0 and vol <= 0:
                    continue

                iv_dec = float(o.get("impliedVolatility") or 0)
                iv = iv_dec if iv_dec >= 0.05 else 0.20
                try:
                    g = _expo_greeks(spot, K, T, r, iv, is_call)
                except Exception:
                    continue
                gamma = float(o.get("gamma") or 0) or g["gamma"]
                delta = float(o.get("delta") or 0) or g["delta"]

                row = strikes.setdefault(K, _blank(K))
                row[f"{side}_oi"] += int(oi)
                row[f"{side}_vol"] += int(vol)
                if oi > 0:
                    notional = oi * 100 * spot
                    gex = sign * notional * gamma * spot * 0.01 / 1e6      # $M per 1% move
                    row[f"{side}_gex"] += gex
                    row["net_gex"] += gex
                    # Put delta is already negative, so the call/put sign is not
                    # reapplied here — net DEX reads call-heavy vs put-heavy.
                    row["net_dex"] += notional * delta / 1e6               # $M of delta
                    row["net_vanna"] += sign * notional * g["vanna"] * 0.01 / 1e6   # $M delta per vol pt
                    row["net_charm"] += sign * notional * g["charm"] / 1e6          # $M delta per day

                if vol >= min_volume:
                    ratio = vol / oi if oi > 0 else vol
                    if oi <= 0 or ratio >= min_vol_oi:
                        mid = ((float(o.get("bid") or 0) + float(o.get("ask") or 0)) / 2
                               or float(o.get("lastPrice") or 0))
                        flow.append({
                            "expiry": exp, "dte": dte, "type": side, "strike": K,
                            "volume": int(vol), "oi": int(oi), "vol_oi": round(ratio, 2),
                            # The feed's own IV, not the 20% model floor — a
                            # defaulted vol must not be shown as a quoted one.
                            "iv": round(iv_dec * 100, 1) if iv_dec >= 0.05 else None,
                            "mid": round(mid, 2),
                            "premium": round(vol * mid * 100, 0),
                            "moneyness": round((K / spot - 1) * 100, 2),
                        })

        ordered = sorted(strikes.values(), key=lambda x: x["strike"])
        if not ordered:
            continue
        by_exp_strike[exp] = [{k: (round(v, 4) if isinstance(v, float) else v) for k, v in row.items()}
                              for row in ordered]
        per_exp.append({
            "expiry": exp, "dte": dte,
            **_expo_summary(ordered, spot),
        })

    if not per_exp:
        raise HTTPException(404, "No option data with open interest for this ticker")

    # ── Aggregate across every processed expiry — the actual dealer book ─────
    agg: dict[float, dict] = {}
    for rows in by_exp_strike.values():
        for row in rows:
            a = agg.setdefault(row["strike"], _blank(row["strike"]))
            for k, v in row.items():
                if k != "strike":
                    a[k] += v
    by_strike = sorted(agg.values(), key=lambda x: x["strike"])

    _env = os.getenv("TRADIER_ENV", "sandbox")
    _qdt = None
    if quote_ms:
        try:
            _qdt = _dt.datetime.fromtimestamp(int(quote_ms) / 1000, _dt.timezone.utc)
        except Exception:
            pass
    _age = (_dt.datetime.now(_dt.timezone.utc) - _qdt).total_seconds() if _qdt else None

    # Summaries above are computed over the full +/-35% window so the totals
    # describe the whole book. The per-strike arrays are what the payload weighs,
    # and nothing renders beyond +/-15%, so only those are trimmed.
    ship_lo, ship_hi = spot * 0.85, spot * 1.15
    def _ship(rows: list[dict]) -> list[dict]:
        return [{k: (round(v, 4) if isinstance(v, float) else v) for k, v in row.items()}
                for row in rows if ship_lo <= row["strike"] <= ship_hi]

    result = {
        "ticker": sym,
        "spot": round(spot, 2),
        "expirations": all_exps,
        "processed": [p["expiry"] for p in per_exp],
        "per_expiry": per_exp,
        "by_strike": _ship(by_strike),
        "by_expiry_strike": {e: _ship(rows) for e, rows in by_exp_strike.items()},
        "flow": sorted(flow, key=lambda f: f["premium"], reverse=True)[:150],
        "totals": _expo_summary(by_strike, spot),
        "screen": {"min_volume": min_volume, "min_vol_oi": min_vol_oi},
        "as_of": _dt.datetime.now(_dt.timezone.utc).isoformat(),
        "quote_time": _qdt.isoformat() if _qdt else None,
        "source": "yfinance" if used_yf else ("Tradier" if _env == "production" else "Tradier sandbox"),
        "delayed": (_age is None) or (_age > 180),
    }

    if open_now:
        _expo_cache[cache_key] = result
    else:
        disk_set(cache_key, result, ttl=86400)
    return result


def _expo_summary(rows: list[dict], spot: float) -> dict:
    """Net exposures plus the three levels that read off a gamma profile: the
    flip (nearest per-strike sign change), and the call/put gamma walls."""
    net_gex = sum(r["net_gex"] for r in rows)
    ordered = sorted(rows, key=lambda r: r["strike"])
    flip = None
    for a, b in zip(ordered, ordered[1:]):
        if a["net_gex"] * b["net_gex"] < 0:
            cand = a["strike"] if abs(a["strike"] - spot) <= abs(b["strike"] - spot) else b["strike"]
            if flip is None or abs(cand - spot) < abs(flip - spot):
                flip = cand
    calls = [r for r in ordered if r["call_gex"] > 0]
    puts = [r for r in ordered if r["put_gex"] < 0]
    return {
        "net_gex": round(net_gex, 2),
        "call_gex": round(sum(r["call_gex"] for r in rows), 2),
        "put_gex": round(sum(r["put_gex"] for r in rows), 2),
        "net_dex": round(sum(r["net_dex"] for r in rows), 2),
        "net_vanna": round(sum(r["net_vanna"] for r in rows), 4),
        "net_charm": round(sum(r["net_charm"] for r in rows), 4),
        "call_oi": sum(r["call_oi"] for r in rows),
        "put_oi": sum(r["put_oi"] for r in rows),
        "call_vol": sum(r["call_vol"] for r in rows),
        "put_vol": sum(r["put_vol"] for r in rows),
        "flip": round(float(flip), 2) if flip is not None else None,
        "call_wall": max(calls, key=lambda r: r["call_gex"])["strike"] if calls else None,
        "put_wall": min(puts, key=lambda r: r["put_gex"])["strike"] if puts else None,
    }


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


class GreeksPosition(BaseModel):
    ticker:        str
    strike:        float
    expiry:        str
    qty:           float
    option_type:   str = "call"
    position_type: str = "long"


class GreeksAggregateRequest(BaseModel):
    positions: list[GreeksPosition]


@router.post("/aggregate-greeks")
def aggregate_greeks(req: GreeksAggregateRequest):
    import datetime as _dt

    def days_to_expiry(expiry: str) -> float:
        try:
            exp = _dt.datetime.strptime(expiry, "%Y-%m-%d").date()
            dte = (exp - _dt.date.today()).days
            return max(float(dte), 0.5)
        except Exception:
            return 30.0

    def get_spot(sym: str) -> float:
        try:
            hist = get_history(sym, period="2d")
            if not hist.empty:
                return float(hist["Close"].iloc[-1])
        except Exception:
            pass
        return 100.0

    r_rate  = 5.0
    sigma   = 25.0

    rows = []
    net: dict[str, float] = {"delta": 0.0, "gamma": 0.0, "theta": 0.0, "vega": 0.0}

    spots: dict[str, float] = {}
    for pos in req.positions:
        sym = pos.ticker.strip().upper()
        if sym not in spots:
            spots[sym] = get_spot(sym)

    for pos in req.positions:
        sym  = pos.ticker.strip().upper()
        spot = spots[sym]
        dte  = days_to_expiry(pos.expiry)
        sign = 1.0 if pos.position_type == "long" else -1.0
        g    = bs_greeks(spot, pos.strike, dte, r_rate, sigma, pos.option_type)
        scaled = {k: round(v * pos.qty * sign, 4) for k, v in g.items()}
        for k in net:
            net[k] += scaled.get(k, 0.0)
        rows.append({
            "ticker":        sym,
            "strike":        pos.strike,
            "expiry":        pos.expiry,
            "qty":           pos.qty,
            "option_type":   pos.option_type,
            "position_type": pos.position_type,
            "spot":          round(spot, 2),
            "dte":           round(dte, 0),
            **{k: round(v, 4) for k, v in g.items()},
            "scaled_delta":  scaled.get("delta", 0.0),
            "scaled_gamma":  scaled.get("gamma", 0.0),
            "scaled_theta":  scaled.get("theta", 0.0),
            "scaled_vega":   scaled.get("vega",  0.0),
        })

    net = {k: round(v, 4) for k, v in net.items()}
    return {"positions": rows, "net": net}


# ── Unusual options activity scanner ──────────────────────────────────────────

_UNUSUAL_DEFAULT = [
    "SPY", "QQQ", "IWM", "AAPL", "NVDA", "TSLA", "AMD", "MSFT", "AMZN",
    "META", "GOOGL", "NFLX", "COIN", "PLTR", "MSTR",
]
_unusual_cache: TTLCache = TTLCache(maxsize=64, ttl=300)   # 5 min
_unusual_lock = threading.Lock()


def _scan_ticker_unusual(sym: str, expiries: int, min_volume: int, min_vol_oi: float) -> list[dict]:
    import datetime as _dt
    today = _dt.date.today()
    try:
        exps = _tradier.get_expirations(sym)
    except Exception as e:
        logger.warning("unusual: expirations failed %s: %s", sym, e)
        return []
    future = [e for e in exps if _dt.date.fromisoformat(e) > today][:expiries]
    if not future:
        return []
    try:
        q = _tradier.get_quote(sym)
        spot = float(q.get("last") or q.get("close") or 0) or None
    except Exception:
        spot = None

    out: list[dict] = []
    for exp in future:
        try:
            chain = _tradier.get_options_chain(sym, exp)
        except Exception as e:
            logger.warning("unusual: chain failed %s %s: %s", sym, exp, e)
            continue
        dte = max((_dt.date.fromisoformat(exp) - today).days, 0)
        for typ, contracts in (("call", chain["calls"]), ("put", chain["puts"])):
            for c in contracts:
                vol = int(c.get("volume") or 0)
                oi  = int(c.get("openInterest") or 0)
                if vol < min_volume:
                    continue
                # No prior OI ⇒ freshly opened position; always notable. Otherwise gate on ratio.
                vol_oi = (vol / oi) if oi > 0 else float(vol)
                if oi > 0 and vol_oi < min_vol_oi:
                    continue
                strike = float(c.get("strike") or 0)
                mid = ((c.get("bid") or 0) + (c.get("ask") or 0)) / 2 or float(c.get("lastPrice") or 0)
                out.append({
                    "ticker":       sym,
                    "type":         typ,
                    "strike":       round(strike, 2),
                    "expiry":       exp,
                    "dte":          dte,
                    "spot":         round(spot, 2) if spot else None,
                    "moneyness":    round((strike / spot - 1) * 100, 1) if spot else None,
                    "volume":       vol,
                    "openInterest": oi,
                    "volOiRatio":   round(vol_oi, 2),
                    "iv":           round(float(c.get("impliedVolatility") or 0) * 100, 1),
                    "mid":          round(mid, 2),
                    "premium":      round(vol * mid * 100),
                })
    return out


@router.get("/unusual")
def unusual_activity(
    tickers: str | None = None,
    expiries: int = 2,
    min_volume: int = 300,
    min_vol_oi: float = 1.5,
    limit: int = 60,
):
    """Scan option chains for unusual activity: high volume and volume/OI spikes.

    Sorted by traded premium (volume × mid × 100), descending.
    """
    import datetime as _dt
    from concurrent.futures import ThreadPoolExecutor

    syms = [s.strip().upper() for s in (tickers.split(",") if tickers else _UNUSUAL_DEFAULT) if s.strip()]
    syms = [s for s in dict.fromkeys(syms)][:25]   # dedupe, cap
    expiries   = max(1, min(expiries, 4))
    min_volume = max(0, min_volume)
    limit      = max(1, min(limit, 200))

    valid = []
    for s in syms:
        try:
            validate_ticker(s)
            valid.append(s)
        except Exception:
            continue

    cache_key = f"{','.join(valid)}|{expiries}|{min_volume}|{min_vol_oi}|{limit}"
    with _unusual_lock:
        cached = _unusual_cache.get(cache_key)
    if cached is not None:
        return cached

    rows: list[dict] = []
    with ThreadPoolExecutor(max_workers=8) as pool:
        results = pool.map(
            lambda s: _scan_ticker_unusual(s, expiries, min_volume, min_vol_oi),
            valid,
        )
        for r in results:
            rows.extend(r)

    rows.sort(key=lambda r: r["premium"], reverse=True)
    result = {
        "asOf":    _dt.datetime.utcnow().isoformat() + "Z",
        "scanned": valid,
        "count":   len(rows[:limit]),
        "rows":    rows[:limit],
        "params":  {"expiries": expiries, "minVolume": min_volume, "minVolOi": min_vol_oi},
    }
    with _unusual_lock:
        _unusual_cache[cache_key] = result
    return result
