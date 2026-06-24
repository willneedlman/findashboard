"""
IV Tracker — Historical Implied Volatility analysis for individual options.

Historical IV strategy (yfinance provides current chains only):
  PRIMARY  : Store a snapshot every time the endpoint is hit.
             Over days/weeks this builds a real IV time-series.
  PROXY    : Immediate history via 30-day rolling Historical Volatility (HV)
             scaled to match the current IV level. Preserves relative vol
             movement while anchoring to today's actual implied vol.
"""
import json
import logging
import math
import os
import time
from datetime import date, datetime
from pathlib import Path
from threading import Lock
from typing import Optional

import sys
from fastapi import APIRouter, HTTPException, Query
from scipy.optimize import brentq

sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))
from cache import get_history
import options_data
from validation import validate_ticker
from scipy.stats import norm

logger = logging.getLogger(__name__)
router = APIRouter()

# ── Cache paths ────────────────────────────────────────────────────────────────

_CACHE_DIR   = Path(__file__).parent.parent / ".cache"
_CACHE_DIR.mkdir(exist_ok=True)
_SNAP_FILE   = _CACHE_DIR / "iv_snapshots.json"
_SNAP_LOCK   = Lock()
_MAX_SNAPS   = 17_520   # ~2 years of hourly snapshots per option

# ── Risk-free rate ─────────────────────────────────────────────────────────────

def _risk_free_rate() -> float:
    """13-week T-bill yield; falls back to a hard-coded approximation."""
    try:
        h = get_history("^IRX", period="5d")
        if not h.empty:
            return float(h["Close"].iloc[-1]) / 100.0
    except Exception:
        pass
    return 0.0525


# ── Black-Scholes engine ───────────────────────────────────────────────────────
# All inputs use standard units: sigma in [0, ∞), T in years, prices in $.

def _d1d2(S: float, K: float, T: float, r: float, sigma: float):
    d1 = (math.log(S / K) + (r + 0.5 * sigma ** 2) * T) / (sigma * math.sqrt(T))
    return d1, d1 - sigma * math.sqrt(T)


def bs_price_raw(S: float, K: float, T: float, r: float, sigma: float,
                 option_type: str) -> float:
    """European B-S price. option_type: 'call' | 'put'."""
    if T <= 0 or sigma <= 0:
        intrinsic = max(0.0, (S - K) if option_type == "call" else (K - S))
        return intrinsic
    d1, d2 = _d1d2(S, K, T, r, sigma)
    if option_type == "call":
        return S * norm.cdf(d1) - K * math.exp(-r * T) * norm.cdf(d2)
    return K * math.exp(-r * T) * norm.cdf(-d2) - S * norm.cdf(-d1)


def bs_greeks_raw(S: float, K: float, T: float, r: float, sigma: float,
                  option_type: str) -> dict:
    """Returns delta, gamma, theta ($/day), vega ($/1% IV), rho ($/1% rate)."""
    if T <= 0 or sigma <= 0:
        return {}
    d1, d2 = _d1d2(S, K, T, r, sigma)
    sqrt_T = math.sqrt(T)
    pdf_d1 = norm.pdf(d1)
    is_call = option_type == "call"
    delta = norm.cdf(d1) if is_call else norm.cdf(d1) - 1
    gamma = pdf_d1 / (S * sigma * sqrt_T)
    theta_raw = (
        -(S * pdf_d1 * sigma) / (2 * sqrt_T)
        - r * K * math.exp(-r * T) * (norm.cdf(d2) if is_call else norm.cdf(-d2))
        + (0 if is_call else r * K * math.exp(-r * T))
    )
    return {
        "delta": round(delta, 4),
        "gamma": round(gamma, 6),
        "theta": round(theta_raw / 365, 4),           # $/day
        "vega":  round(S * pdf_d1 * sqrt_T / 100, 4), # $/1% IV move
        "rho":   round(K * T * math.exp(-r * T)
                       * (norm.cdf(d2) if is_call else -norm.cdf(-d2)) / 100, 4),
    }


def implied_vol(market_price: float, S: float, K: float, T: float,
                r: float, option_type: str) -> Optional[float]:
    """
    Back out IV from a market option price using Brent's method.
    Returns None when solution cannot be found (e.g. deep ITM/OTM, zero price).
    """
    if T <= 0 or market_price <= 0:
        return None
    intrinsic = max(0.0, (S - K) if option_type == "call" else (K - S))
    if market_price < intrinsic - 1e-4:
        return None
    try:
        f = lambda s: bs_price_raw(S, K, T, r, s, option_type) - market_price
        # Check that a root exists in [lo, hi]
        lo, hi = 1e-6, 10.0
        if f(lo) * f(hi) > 0:
            return None
        iv = brentq(f, lo, hi, maxiter=200, xtol=1e-7)
        return iv if 1e-4 < iv < 9.9 else None
    except Exception:
        return None


# ── Historical Volatility (Close-to-Close) ────────────────────────────────────

def rolling_hv(close_prices: list[float], window: int = 30) -> list[Optional[float]]:
    """
    Annualised Historical Volatility via rolling standard deviation of
    log returns. Returns None for the first `window` slots (warm-up).
    """
    if len(close_prices) < 2:
        return []
    log_ret = [math.log(close_prices[i] / close_prices[i - 1])
               for i in range(1, len(close_prices))]
    result: list[Optional[float]] = [None] * window
    for i in range(window, len(log_ret)):
        window_ret = log_ret[i - window:i]
        mean = sum(window_ret) / window
        variance = sum((r - mean) ** 2 for r in window_ret) / (window - 1)
        result.append(math.sqrt(variance) * math.sqrt(252))
    # Pad to match length of close_prices
    return [None] + result


# ── Snapshot cache ────────────────────────────────────────────────────────────

def _snap_key(ticker: str, expiry: str, opt_type: str, strike: float) -> str:
    return f"{ticker.upper()}|{expiry}|{opt_type}|{strike:.2f}"


def _load_snaps() -> dict:
    with _SNAP_LOCK:
        try:
            return json.loads(_SNAP_FILE.read_text()) if _SNAP_FILE.exists() else {}
        except Exception:
            return {}


def _save_snaps(data: dict) -> None:
    with _SNAP_LOCK:
        try:
            _SNAP_FILE.write_text(json.dumps(data, indent=2))
        except Exception:
            pass


def _record_snap(ticker: str, expiry: str, opt_type: str, strike: float,
                 iv: float, stock_price: float, option_price: float) -> None:
    """Append an IV snapshot; deduplicate within the same clock-hour."""
    data = _load_snaps()
    key  = _snap_key(ticker, expiry, opt_type, strike)
    now  = int(time.time())
    entry = {
        "ts":    now,
        "iv":    round(iv, 6),
        "stock": round(stock_price, 4),
        "opt":   round(option_price, 4),
    }
    snaps = data.get(key, [])
    if snaps and now - snaps[-1]["ts"] < 3600:
        snaps[-1] = entry   # overwrite — same hour window
    else:
        snaps.append(entry)
    data[key] = snaps[-_MAX_SNAPS:]
    _save_snaps(data)


def _snaps_by_date(ticker: str, expiry: str, opt_type: str,
                   strike: float) -> dict[str, float]:
    """Return {YYYY-MM-DD: iv} from stored snapshots."""
    snaps = _load_snaps().get(_snap_key(ticker, expiry, opt_type, strike), [])
    out: dict[str, float] = {}
    for s in snaps:
        d = datetime.fromtimestamp(s["ts"]).strftime("%Y-%m-%d")
        out[d] = s["iv"]   # last snapshot of the day wins
    return out


# ── IV statistics ─────────────────────────────────────────────────────────────

def iv_rank_percentile(iv_series: list[float],
                       current_iv: float) -> dict:
    """
    iv_rank       = (current - min) / (max - min)  × 100
    iv_percentile = fraction of days where IV was below current × 100

    Both over the supplied series (typically 1 year of daily observations).
    """
    if not iv_series:
        return {"iv_rank": None, "iv_percentile": None}
    mn, mx = min(iv_series), max(iv_series)
    rank = ((current_iv - mn) / (mx - mn) * 100) if mx > mn else 50.0
    pct  = sum(1 for v in iv_series if v < current_iv) / len(iv_series) * 100
    return {
        "iv_rank":        round(rank, 1),
        "iv_percentile":  round(pct, 1),
        "iv_min":         round(mn * 100, 2),
        "iv_max":         round(mx * 100, 2),
        "iv_mean":        round(sum(iv_series) / len(iv_series) * 100, 2),
    }


# ── Endpoints ─────────────────────────────────────────────────────────────────

@router.get("/expirations")
def get_expirations(ticker: str = Query(..., description="e.g. AAPL")):
    """List all future expiration dates available for a ticker."""
    sym = validate_ticker(ticker)
    try:
        exps  = options_data.get_expirations(sym)
        today = date.today().isoformat()
        future = [e for e in exps if e >= today]
        if not future:
            raise HTTPException(404, f"No options data found for {sym}")
        return {"ticker": sym, "expirations": future}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(500, str(e))


@router.get("/strikes")
def get_strikes(
    ticker:      str = Query(...),
    expiry:      str = Query(...),
    option_type: str = Query("call", pattern="^(call|put)$"),
):
    """Return all available strikes for a given expiry + type, plus the ATM strike."""
    sym = validate_ticker(ticker)
    try:
        chain = options_data.get_chain(sym, expiry)
        df    = chain.calls if option_type == "call" else chain.puts
        if df.empty:
            raise HTTPException(404, "No option chain data")
        strikes = sorted(float(s) for s in df["strike"].tolist())
        hist    = get_history(sym, period="2d")
        spot    = float(hist["Close"].iloc[-1]) if not hist.empty else 0.0
        atm     = min(strikes, key=lambda s: abs(s - spot))
        return {
            "ticker":      sym,
            "expiry":      expiry,
            "option_type": option_type,
            "spot":        round(spot, 2),
            "strikes":     [round(s, 2) for s in strikes],
            "atm_strike":  round(atm, 2),
        }
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(500, str(e))


@router.get("/history")
def get_iv_history(
    ticker:      str   = Query(..., description="Ticker symbol"),
    expiry:      str   = Query(..., description="Expiration date YYYY-MM-DD"),
    option_type: str   = Query("call", pattern="^(call|put)$"),
    strike:      float = Query(..., description="Strike price"),
    days:        int   = Query(90, ge=7, le=365, description="Historical lookback in trading days"),
):
    """
    Primary endpoint. Returns:
      - current IV, bid/ask, greeks, IV rank, IV percentile
      - time_series: daily {date, stock_price, iv, hv_30d, source}
    """
    sym = ticker.strip().upper()
    try:
        # ── 1. Fetch current option chain ────────────────────────────────────
        chain   = options_data.get_chain(sym, expiry)
        df      = chain.calls if option_type == "call" else chain.puts

        if df.empty:
            raise HTTPException(404, f"No {option_type} chain for {sym} exp={expiry}")

        # Snap to nearest available strike
        df = df.copy()
        df["_dist"] = (df["strike"] - strike).abs()
        row = df.sort_values("_dist").iloc[0]
        actual_strike = float(row["strike"])

        current_iv     = float(row.get("impliedVolatility") or 0)
        bid            = float(row.get("bid")              or 0)
        ask            = float(row.get("ask")              or 0)
        last           = float(row.get("lastPrice")        or 0)
        mid            = (bid + ask) / 2 if bid > 0 and ask > 0 else last
        open_interest  = int(row.get("openInterest")  or 0)
        volume         = int(row.get("volume")        or 0)

        # ── 2. Historical stock data ──────────────────────────────────────────
        # Fetch extra days for the 30d HV warm-up window
        fetch_period = f"{days + 90}d"
        hist = get_history(sym, period=fetch_period)
        if hist.empty:
            raise HTTPException(404, f"No price history for {sym}")

        hist.index     = hist.index.tz_localize(None)
        closes         = hist["Close"].tolist()
        date_strs      = [d.strftime("%Y-%m-%d") for d in hist.index]

        spot = closes[-1]

        # ── 3. Rolling 30d HV ────────────────────────────────────────────────
        hv_all = rolling_hv(closes, window=30)  # len == len(closes)
        # Current HV: last non-None value
        current_hv = next((v for v in reversed(hv_all) if v is not None), None)

        # Scale factor: keep IV/HV ratio constant so HV proxy mirrors IV shape
        if current_hv and current_iv > 0 and current_hv > 0:
            scale = current_iv / current_hv
        else:
            scale = 1.0

        # ── 4. Stored snapshots ───────────────────────────────────────────────
        snap_by_date = _snaps_by_date(sym, expiry, option_type, actual_strike)

        # ── 5. Build aligned time-series (last `days` rows) ─────────────────
        tail_closes   = closes[-days:]
        tail_dates    = date_strs[-days:]
        tail_hv       = hv_all[-days:]

        time_series: list[dict] = []
        iv_vals_for_stats: list[float] = []

        for d_str, price, hv_val in zip(tail_dates, tail_closes, tail_hv):
            if d_str in snap_by_date:
                iv_pt  = snap_by_date[d_str]
                source = "snapshot"
            elif hv_val is not None:
                iv_pt  = hv_val * scale
                source = "hv_proxy"
            else:
                iv_pt  = None
                source = "unavailable"

            if iv_pt is not None:
                iv_vals_for_stats.append(iv_pt)

            time_series.append({
                "date":        d_str,
                "stock_price": round(price, 2),
                "iv":          round(iv_pt * 100, 2) if iv_pt is not None else None,
                "hv_30d":      round(hv_val * 100, 2) if hv_val is not None else None,
                "source":      source,
            })

        # ── 6. IV Rank / IV Percentile ────────────────────────────────────────
        stats = iv_rank_percentile(iv_vals_for_stats, current_iv) if iv_vals_for_stats else {}

        # ── 7. Greeks ────────────────────────────────────────────────────────
        r_free  = _risk_free_rate()
        exp_dt  = datetime.strptime(expiry, "%Y-%m-%d").date()
        T_years = max((exp_dt - date.today()).days / 365.0, 1 / 365)
        greeks  = {}
        if current_iv > 0:
            greeks = bs_greeks_raw(spot, actual_strike, T_years, r_free,
                                   current_iv, option_type)

        # ── 8. Record this query as a live snapshot ───────────────────────────
        if current_iv > 0 and mid > 0:
            _record_snap(sym, expiry, option_type, actual_strike,
                         current_iv, spot, mid)

        # ── 9. IV premium over HV (IV – HV) ─────────────────────────────────
        iv_premium = (
            round((current_iv - current_hv) * 100, 2)
            if current_hv and current_iv else None
        )

        # Expected (implied) move through this expiry, from the ATM straddle.
        im = options_data.implied_move(sym, spot=spot, expiry=expiry)

        return {
            "ticker":       sym,
            "expiry":       expiry,
            "option_type":  option_type,
            "strike":       actual_strike,
            "spot":         round(spot, 2),
            "implied_move": im["move_pct"] if im else None,
            "straddle":     im["straddle"] if im else None,
            # Current option data
            "current_iv":   round(current_iv * 100, 2),
            "bid":          round(bid, 2),
            "ask":          round(ask, 2),
            "mid":          round(mid, 2),
            "open_interest": open_interest,
            "volume":        volume,
            "dte":          (exp_dt - date.today()).days,
            # Vol context
            "current_hv_30d": round(current_hv * 100, 2) if current_hv else None,
            "iv_premium":     iv_premium,
            "risk_free_rate": round(r_free * 100, 2),
            # IV rank / percentile
            **stats,
            # Greeks
            "greeks":       greeks,
            # Chart data
            "time_series":  time_series,
        }

    except HTTPException:
        raise
    except Exception as e:
        logger.exception("iv_history error for %s", sym)
        raise HTTPException(500, str(e))


@router.get("/surface")
def get_iv_surface(ticker: str = Query(...)):
    """
    Current IV surface: all expirations × all strikes for a quick 3-D overview.
    Returns a flat list of {expiry, strike, iv, delta} rows for the nearest
    4 expirations.
    """
    sym = ticker.strip().upper()
    try:
        exps     = options_data.get_expirations(sym)
        today    = date.today().isoformat()
        future   = [e for e in exps if e >= today][:4]
        if not future:
            raise HTTPException(404, f"No options for {sym}")

        hist = get_history(sym, period="2d")
        spot = float(hist["Close"].iloc[-1]) if not hist.empty else 0.0
        r    = _risk_free_rate()
        rows = []

        for exp in future:
            try:
                chain = options_data.get_chain(sym, exp)
                T = max((datetime.strptime(exp, "%Y-%m-%d").date()
                         - date.today()).days / 365.0, 1 / 365)
                for opt_type, df in [("call", chain.calls), ("put", chain.puts)]:
                    for _, row in df.iterrows():
                        iv = float(row.get("impliedVolatility") or 0)
                        if iv <= 0:
                            continue
                        K = float(row["strike"])
                        g = bs_greeks_raw(spot, K, T, r, iv, opt_type)
                        rows.append({
                            "expiry":      exp,
                            "option_type": opt_type,
                            "strike":      round(K, 2),
                            "iv":          round(iv * 100, 2),
                            "delta":       g.get("delta"),
                        })
            except Exception:
                continue

        return {"ticker": sym, "spot": round(spot, 2), "surface": rows}

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(500, str(e))
