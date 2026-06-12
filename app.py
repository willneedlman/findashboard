import ssl
import os
import logging
import pathlib
from pathlib import Path
import appdirs as ad
import datetime
import requests
import io
import time

CACHE_DIR = ".cache"
ad.user_cache_dir = lambda *args: CACHE_DIR
Path(CACHE_DIR).mkdir(exist_ok=True)

import streamlit as st
import yfinance as yf
import numpy as np
import pandas as pd
import plotly.graph_objects as go
from plotly.subplots import make_subplots
from math_engine import bs_price, bs_greeks, duration_convexity
from scipy.stats import norm, lognorm

# ── API KEYS ─────────────────────────────────────────────────────────────────
try:
    TWELVE_API_KEY = st.secrets["TWELVE_API_KEY"]
except (KeyError, FileNotFoundError):
    TWELVE_API_KEY = os.environ.get("TWELVE_API_KEY", "")

# ── DATA FETCHERS ─────────────────────────────────────────────────────────────

@st.cache_resource
def get_cached_ticker(ticker):
    return yf.Ticker(ticker.strip().upper())

@st.cache_data(ttl=3600)
def get_cached_history(ticker):
    return yf.Ticker(ticker.strip().upper()).history(period="1y")

@st.cache_data(ttl=1800)
def get_cached_ticker_news(ticker):
    try:
        return yf.Ticker(ticker.strip().upper()).news
    except Exception:
        return []

@st.cache_data(ttl=3600)
def get_twelve_market_data(ticker, apikey=TWELVE_API_KEY):
    sym = ticker.strip().upper()
    url = f"https://api.twelvedata.com/time_series?symbol={sym}&interval=1day&outputsize=5000&apikey={apikey}"
    try:
        response = requests.get(url)
        res_json = response.json()
        if "values" not in res_json:
            if "message" in res_json:
                st.error(f"Twelve Data API Error: {res_json['message']}")
            return pd.DataFrame()
        raw_data = res_json["values"]
        df = pd.DataFrame(raw_data)
        df["datetime"] = pd.to_datetime(df["datetime"])
        df = df.set_index("datetime").sort_index()
        df["close"] = pd.to_numeric(df["close"], errors="coerce")
        return df[["close"]].dropna()
    except Exception as e:
        st.error(f"Terminal Connection Error: {str(e)}")
        return pd.DataFrame()

@st.cache_data(ttl=1800)
def get_twelve_time_series(ticker, start_date, end_date, apikey=TWELVE_API_KEY):
    clean_sym = ticker.strip().upper().replace("-", "/")
    url = f"https://api.twelvedata.com/time_series?symbol={clean_sym}&interval=1day&outputsize=5000&apikey={apikey}"
    try:
        response = requests.get(url).json()
        if "values" not in response:
            return pd.Series(dtype=float)
        df = pd.DataFrame(response["values"])
        df["datetime"] = pd.to_datetime(df["datetime"])
        df = df.set_index("datetime").sort_index()
        df["close"] = pd.to_numeric(df["close"], errors="coerce")
        mask = (df.index >= pd.to_datetime(start_date)) & (df.index <= pd.to_datetime(end_date))
        return df.loc[mask, "close"]
    except Exception as e:
        logging.warning(f"get_twelve_time_series({ticker}): {e}")
        return pd.Series(dtype=float)

@st.cache_data(ttl=86400)
def get_twelve_shares_outstanding(ticker, apikey=TWELVE_API_KEY):
    sym = ticker.strip().upper()
    url = f"https://api.twelvedata.com/profile?symbol={sym}&apikey={apikey}"
    try:
        response = requests.get(url).json()
        return float(response.get("shares_outstanding", 345930000))
    except Exception:
        return 345930000.0

@st.cache_data(ttl=1800)
def get_yf_market_data(ticker):
    try:
        tkr = yf.Ticker(ticker.strip().upper())
        df = tkr.history(period="5y")
        if not df.empty:
            if df.index.tz is not None:
                df.index = df.index.tz_convert(None)
            df = df.rename(columns={"Close": "close"})
            return df[["close"]].dropna()
    except Exception as e:
        logging.warning(f"get_yf_market_data({ticker}): {e}")
    return pd.DataFrame()

@st.cache_data(ttl=3600)
def get_yf_implied_vol(ticker):
    try:
        tkr = yf.Ticker(ticker.strip().upper())
        df = tkr.history(period="3mo")
        if not df.empty:
            closes = df["Close"].dropna()
            returns = np.log(closes / closes.shift(1)).dropna()
            sigma = returns.std() * np.sqrt(252)
            return sigma if (sigma > 0 and not pd.isna(sigma)) else 0.20
    except Exception:
        pass
    return 0.20

@st.cache_data(ttl=1800)
def get_yf_backtest_series(ticker, start_date, end_date):
    try:
        tkr = yf.Ticker(ticker.strip().upper())
        adjusted_end = pd.to_datetime(end_date) + pd.Timedelta(days=1)
        df = tkr.history(start=start_date, end=adjusted_end)
        if not df.empty:
            if df.index.tz is not None:
                df.index = df.index.tz_convert(None)
            return df['Close']
    except Exception as e:
        logging.warning(f"get_yf_backtest_series({ticker}): {e}")
    return pd.Series(dtype=float)

STRATEGIES = [
    "None (Base GBM / Buy & Hold)",
    "SMA Trend Following (50/200)",
    "RSI Mean Reversion (14)",
    "6-Month Price Momentum",
    "Value — Trailing P/E",
    "Earnings Growth Momentum",
]

@st.cache_data(ttl=1800)
def compute_strategy_data(ticker, strategy, start_date=None, end_date=None, params=None):
    """
    Returns (drift_adj_pct, signal_series, label, detail).
    params — dict of user-adjustable parameters for the selected strategy.
    """
    p         = params or {}
    empty_sig = pd.Series(dtype=float)
    if strategy == "None (Base GBM / Buy & Hold)":
        return 0.0, empty_sig, "No signal", "Buy & hold — no strategy filter applied."
    try:
        tkr   = yf.Ticker(ticker.strip().upper())
        hist  = tkr.history(period="5y") if start_date is None else \
                tkr.history(start=str(start_date), end=str(end_date or datetime.date.today()))
        close = hist["Close"].dropna()
        if close.index.tz is not None:
            close.index = close.index.tz_convert(None)
        if len(close) < 20:
            return 0.0, empty_sig, "Insufficient data", "Need at least 20 days of price history."

        if strategy == "SMA Trend Following (50/200)":
            fast = int(p.get("sma_fast", 50))
            slow = int(p.get("sma_slow", 200))
            bull_adj = float(p.get("bull_drift_adj", 6.0))
            bear_adj = float(p.get("bear_drift_adj", -6.0))
            sma_f = close.rolling(fast,  min_periods=max(10, fast//3)).mean()
            sma_s = close.rolling(slow,  min_periods=max(20, slow//4)).mean()
            sig   = ((close > sma_f) & (sma_f > sma_s)).astype(float).fillna(0.0)
            cur, cur_f, cur_s = float(close.iloc[-1]), float(sma_f.iloc[-1]), float(sma_s.iloc[-1])
            if cur > cur_f and cur_f > cur_s:
                adj, label = bull_adj, "Uptrend"
            elif cur > cur_s:
                adj, label = bull_adj * 0.4, "Weak Uptrend"
            elif cur < cur_f and cur_f < cur_s:
                adj, label = bear_adj, "Downtrend"
            else:
                adj, label = bear_adj * 0.4, "Weak Downtrend"
            detail = (f"Price ${cur:.2f} | SMA{fast} ${cur_f:.2f} | SMA{slow} ${cur_s:.2f} — "
                      f"{label} (drift adj {adj:+.1f}%)")
            return adj, sig, label, detail

        elif strategy == "RSI Mean Reversion (14)":
            period      = int(p.get("rsi_period", 14))
            ob_thresh   = float(p.get("overbought", 70))
            os_thresh   = float(p.get("oversold",   30))
            ob_adj      = float(p.get("ob_drift_adj", -7.0))
            os_adj      = float(p.get("os_drift_adj",  7.0))
            delta = close.diff()
            gain  = delta.clip(lower=0).rolling(period, min_periods=period//2).mean()
            loss  = (-delta.clip(upper=0)).rolling(period, min_periods=period//2).mean()
            rsi   = 100 - 100 / (1 + gain / loss.replace(0, 1e-9))
            sig   = (rsi < ob_thresh).astype(float).fillna(1.0)
            cur_rsi = float(rsi.iloc[-1]) if not pd.isna(rsi.iloc[-1]) else 50.0
            ob_severe = ob_thresh + (100 - ob_thresh) * 0.33
            os_severe = os_thresh - os_thresh * 0.33
            if cur_rsi >= ob_severe:   adj, label = ob_adj,        "Severely Overbought"
            elif cur_rsi >= ob_thresh: adj, label = ob_adj * 0.43, "Overbought"
            elif cur_rsi <= os_severe: adj, label = os_adj,        "Severely Oversold"
            elif cur_rsi <= os_thresh: adj, label = os_adj * 0.43, "Oversold"
            else:                      adj, label = 0.0,            "Neutral"
            detail = f"RSI({period}) = {cur_rsi:.1f} — {label} (drift adj {adj:+.1f}%)"
            return adj, sig, label, detail

        elif strategy == "6-Month Price Momentum":
            lookback  = int(p.get("lookback_days", 126))
            adj_scale = float(p.get("adj_scale", 0.25))
            adj_cap   = float(p.get("adj_cap", 8.0))
            threshold = float(p.get("threshold_pct", 0.0)) / 100
            mom_raw   = close / close.shift(lookback) - 1
            sig       = (mom_raw > threshold).astype(float).fillna(0.0)
            mom       = float(mom_raw.iloc[-1]) * 100 if not pd.isna(mom_raw.iloc[-1]) else 0.0
            adj       = float(np.clip(mom * adj_scale, -adj_cap, adj_cap))
            label     = "Positive Momentum" if mom > threshold * 100 else "Negative Momentum"
            detail    = (f"{lookback}-day return {mom:+.1f}% | threshold {threshold*100:+.1f}% "
                         f"— {label} (drift adj {adj:+.1f}%)")
            return adj, sig, label, detail

        elif strategy == "Value — Trailing P/E":
            pe_in_thresh  = float(p.get("pe_in_threshold",  35.0))
            pe_deep_val   = float(p.get("pe_deep_value",    12.0))
            pe_fair       = float(p.get("pe_fair_value",    20.0))
            pe_expensive  = float(p.get("pe_expensive",     50.0))
            bull_adj      = float(p.get("bull_drift_adj",    6.0))
            bear_adj      = float(p.get("bear_drift_adj",   -6.0))
            info = tkr.info
            pe   = info.get("trailingPE") or info.get("forwardPE")
            if pe is None or pe <= 0:
                return 0.0, empty_sig, "P/E Unavailable", "No P/E data for this ticker."
            if   pe < pe_deep_val:  adj, label = bull_adj,        "Deep Value"
            elif pe < pe_fair:      adj, label = bull_adj * 0.5,  "Fairly Valued"
            elif pe < pe_in_thresh: adj, label = 0.0,             "Neutral"
            elif pe < pe_expensive: adj, label = bear_adj * 0.5,  "Expensive"
            else:                   adj, label = bear_adj,        "Very Expensive"
            sig_val = 1.0 if pe < pe_in_thresh else 0.0
            sig     = pd.Series(sig_val, index=close.index)
            detail  = (f"Trailing P/E = {pe:.1f} | in-market threshold P/E < {pe_in_thresh:.0f} "
                       f"— {label} (drift adj {adj:+.1f}%)")
            return adj, sig, label, detail

        elif strategy == "Earnings Growth Momentum":
            exit_threshold = float(p.get("exit_threshold_pct", -5.0)) / 100
            adj_scale      = float(p.get("adj_scale", 60.0))
            adj_cap        = float(p.get("adj_cap", 10.0))
            info = tkr.info
            eg   = info.get("earningsQuarterlyGrowth")
            if eg is None:
                return 0.0, empty_sig, "EPS Data Unavailable", "No quarterly earnings growth data."
            adj     = float(np.clip(eg * adj_scale, -adj_cap, adj_cap))
            sig_val = 1.0 if eg > exit_threshold else 0.0
            sig     = pd.Series(sig_val, index=close.index)
            label   = f"EPS Growth {eg*100:+.1f}%"
            detail  = (f"Quarterly EPS growth {eg*100:+.1f}% | exit when below {exit_threshold*100:.1f}% "
                       f"— {label} (drift adj {adj:+.1f}%)")
            return adj, sig, label, detail

    except Exception as e:
        return 0.0, empty_sig, "Signal Error", str(e)
    return 0.0, empty_sig, "No Signal", ""

@st.cache_data(ttl=86400)
def get_live_risk_free_rate():
    try:
        url = "https://api.stlouisfed.org/fred/series/observations?series_id=DTB3&sort_order=desc&limit=1&api_key=43da5562d1e0d74cef700a41a30ff11c&file_type=json"
        res = requests.get(url).json()
        val = res["observations"][0]["value"]
        return float(val) / 100.0
    except Exception:
        return 0.045

@st.cache_data(ttl=3600)
def get_twelve_implied_vol(ticker, apikey=TWELVE_API_KEY):
    sym = ticker.strip().upper()
    url = f"https://api.twelvedata.com/time_series?symbol={sym}&interval=1day&outputsize=60&apikey={apikey}"
    try:
        res = requests.get(url).json()
        if "values" not in res:
            return 0.20
        df = pd.DataFrame(res["values"])
        df["close"] = pd.to_numeric(df["close"])
        returns = np.log(df["close"] / df["close"].shift(-1)).dropna()
        sigma = returns.std() * np.sqrt(252)
        return sigma if (sigma > 0 and not pd.isna(sigma)) else 0.20
    except Exception:
        return 0.20

@st.cache_data(ttl=1800)
def get_twelve_batch_yield_curve(apikey=TWELVE_API_KEY):
    market_backstop = {"1Y": 3.78, "2Y": 4.03, "5Y": 4.16, "10Y": 4.46, "20Y": 4.72, "30Y": 4.98}
    # yfinance treasury tickers (% values — divide by 100)
    yf_map = {"1Y": "^IRX", "2Y": "^FVX", "5Y": "^FVX", "10Y": "^TNX", "20Y": "^TYX", "30Y": "^TYX"}
    # More precise mapping using CBOE tickers
    yf_precise = [("1Y","^IRX"), ("2Y","^FVX"), ("5Y","^FVX"), ("10Y","^TNX"), ("30Y","^TYX")]
    try:
        curve_row = {}
        for label, sym in [("1Y","^IRX"), ("5Y","^FVX"), ("10Y","^TNX"), ("30Y","^TYX")]:
            hist = yf.Ticker(sym).history(period="5d")
            if not hist.empty:
                val = float(hist["Close"].dropna().iloc[-1])
                curve_row[label] = val if val < 20.0 else val / 100.0
        # Interpolate missing tenors
        if "1Y" in curve_row and "5Y" in curve_row:
            curve_row["2Y"] = curve_row["1Y"] * 0.6 + curve_row["5Y"] * 0.4
        if "10Y" in curve_row and "30Y" in curve_row:
            curve_row["20Y"] = curve_row["10Y"] * 0.5 + curve_row["30Y"] * 0.5
        if len(curve_row) >= 5:
            return pd.DataFrame([{k: curve_row.get(k, market_backstop[k]) for k in market_backstop}])
    except Exception as e:
        logging.warning(f"get_twelve_batch_yield_curve (yf): {e}")
    return pd.DataFrame([market_backstop])

@st.cache_data(show_spinner=False)
def convert_df_to_csv(df):
    return df.to_csv(index=True).encode('utf-8')

def fmt_large(val_m):
    """Format a $M value, auto-scaling to B or T."""
    abs_v = abs(val_m)
    if abs_v >= 1_000_000:
        return f"${val_m/1_000_000:.2f}T"
    elif abs_v >= 1_000:
        return f"${val_m/1_000:.1f}B"
    return f"${val_m:,.0f}M"

@st.cache_data(ttl=3600)
def get_dcf_fundamentals(ticker):
    try:
        t = yf.Ticker(ticker.strip().upper())
        info = t.info

        revenue     = (info.get("totalRevenue") or 0) / 1e6
        op_margin   = ((info.get("operatingMargins") or 0.15)) * 100
        shares      = (info.get("sharesOutstanding") or 0) / 1e6
        total_debt  = (info.get("totalDebt") or 0) / 1e6
        total_cash  = (info.get("totalCash") or 0) / 1e6
        net_debt    = total_debt - total_cash
        rev_growth  = ((info.get("revenueGrowth") or 0.10)) * 100

        capex_pct, da_pct = 5.0, 4.0
        try:
            cf = t.cashflow
            if not cf.empty and revenue > 0:
                for k in ["Capital Expenditure", "CapEx"]:
                    if k in cf.index:
                        capex_pct = abs(float(cf.loc[k].iloc[0])) / (revenue * 1e6) * 100
                        break
                for k in ["Depreciation And Amortization", "Depreciation"]:
                    if k in cf.index:
                        da_pct = float(cf.loc[k].iloc[0]) / (revenue * 1e6) * 100
                        break
        except Exception:
            pass

        tax_rate = 21.0
        try:
            fin = t.financials
            if not fin.empty:
                tp_key = next((k for k in fin.index if "tax" in k.lower() and "provision" in k.lower()), None)
                pi_key = next((k for k in fin.index if "pretax" in k.lower()), None)
                if tp_key and pi_key:
                    tp = float(fin.loc[tp_key].iloc[0])
                    pi = float(fin.loc[pi_key].iloc[0])
                    if pi > 0:
                        tax_rate = max(0.0, min(tp / pi * 100, 40.0))
        except Exception:
            pass

        beta     = float(info.get("beta") or 1.0)
        de_raw   = float(info.get("debtToEquity") or 0.0)
        de_ratio = de_raw / 100.0 if de_raw > 5 else de_raw
        mkt_px   = float(info.get("currentPrice") or info.get("regularMarketPrice") or 0) or None

        return {
            "revenue":      max(0.0, round(revenue, 0)),
            "op_margin":    round(op_margin, 1),
            "shares":       max(0.1, round(shares, 1)),
            "net_debt":     round(net_debt, 0),
            "rev_growth":   round(rev_growth, 1),
            "capex_pct":    round(max(0.0, capex_pct), 1),
            "da_pct":       round(max(0.0, da_pct), 1),
            "tax_rate":     round(tax_rate, 1),
            "beta":         round(max(0.1, beta), 2),
            "de_ratio":     round(max(0.0, de_ratio), 3),
            "market_price": mkt_px,
        }
    except Exception as e:
        st.toast(f"Failed to fetch fundamentals: {e}", icon="")
        return None

# ── MSTR BITCOIN HOLDINGS SCRAPER (strategy.com) ─────────────────────────────
@st.cache_data(ttl=3600)
def get_mstr_bitcoin_holdings():
    """
    Scrapes live BTC holdings from Strategy (MicroStrategy) investor relations page.
    Falls back to last known figure if scraping fails.
    """
    FALLBACK_BTC = 553555.0
    FALLBACK_AVG_COST = 68459.0
    try:
        headers = {"User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36"}
        url = "https://www.strategy.com/bitcoin"
        resp = requests.get(url, headers=headers, timeout=6)
        text = resp.text

        import re
        # Try to extract total BTC from the page text
        btc_match = re.search(r'([\d,]+)\s*(?:BTC|bitcoin)', text, re.IGNORECASE)
        cost_match = re.search(r'\$\s*([\d,]+)\s*(?:average|avg)', text, re.IGNORECASE)

        btc_holdings = float(btc_match.group(1).replace(",", "")) if btc_match else FALLBACK_BTC
        avg_cost = float(cost_match.group(1).replace(",", "")) if cost_match else FALLBACK_AVG_COST

        # Sanity check — MSTR holds hundreds of thousands
        if btc_holdings < 100000 or btc_holdings > 5000000:
            btc_holdings = FALLBACK_BTC

        return {"btc_holdings": btc_holdings, "avg_cost_basis": avg_cost, "source": "strategy.com (live)"}
    except Exception:
        return {"btc_holdings": FALLBACK_BTC, "avg_cost_basis": FALLBACK_AVG_COST, "source": "fallback (cached)"}

# ── TWELVE DATA RATE LIMIT GUARD ──────────────────────────────────────────────
_twelve_call_timestamps = []
TWELVE_RATE_LIMIT = 8  # calls per minute on free tier

def twelve_rate_guard():
    """Simple token-bucket guard for Twelve Data free tier (8 calls/min)."""
    global _twelve_call_timestamps
    now = time.time()
    _twelve_call_timestamps = [t for t in _twelve_call_timestamps if now - t < 60]
    if len(_twelve_call_timestamps) >= TWELVE_RATE_LIMIT:
        wait = 60 - (now - _twelve_call_timestamps[0])
        if wait > 0:
            st.toast(f" Twelve Data rate limit — waiting {wait:.0f}s...", icon="")
            time.sleep(wait)
    _twelve_call_timestamps.append(time.time())

# ── UNIFIED PRICE DISPATCHER ──────────────────────────────────────────────────
def get_price_series(ticker, start_date=None, end_date=None, source="auto"):
    """
    Unified dispatcher: tries Twelve Data first, falls back to yfinance.
    Handles crypto cross pairs and avoids silent failures.
    """
    sym = ticker.strip().upper()
    start = start_date or (pd.Timestamp.now() - pd.Timedelta(days=365))
    end = end_date or pd.Timestamp.now()

    # yfinance only — Twelve Data removed (DNS unreachable)
    try:
        series = get_yf_backtest_series(sym, start, end)
        if not series.empty:
            return series, "Yahoo Finance"
    except Exception:
        pass

    return pd.Series(dtype=float), "unavailable"

# ── OPTIONS CHAIN FETCHER (yfinance) ─────────────────────────────────────────
@st.cache_data(ttl=900)
def get_options_chain(ticker):
    """Fetches live options chain via yfinance. Returns nearest expiry chain."""
    try:
        tkr = yf.Ticker(ticker.strip().upper())
        expirations = tkr.options
        if not expirations:
            return None, None, None
        nearest = expirations[0]
        chain = tkr.option_chain(nearest)
        return chain.calls, chain.puts, nearest
    except Exception:
        return None, None, None

# ── DEALER GEX (yfinance) ────────────────────────────────────────────────────
@st.cache_data(ttl=900)
def get_gex_data(ticker):
    """
    Returns (spot, df_gex) where df_gex has columns:
      strike, expiry, call_oi, put_oi, call_gamma, put_gamma,
      call_gex, put_gex, net_gex  (all in $ per 1% move, millions)
    Gamma is approximated via Black-Scholes on the OI-weighted chain.
    """
    from scipy.stats import norm as _norm
    sym = ticker.strip().upper()
    tkr = yf.Ticker(sym)
    try:
        hist = tkr.history(period="5d")
        spot = float(hist["Close"].dropna().iloc[-1]) if not hist.empty else None
    except Exception:
        spot = None
    if spot is None or spot <= 0:
        return None, pd.DataFrame()

    r      = 0.045
    rows   = []
    today  = pd.Timestamp.today().normalize()

    for exp in (tkr.options or []):
        exp_dt = pd.to_datetime(exp)
        T      = max((exp_dt - today).days / 365.25, 1 / 365.25)
        try:
            chain = tkr.option_chain(exp)
        except Exception:
            continue
        for side, df_side, sign in [("call", chain.calls, 1), ("put", chain.puts, -1)]:
            df_side = df_side[["strike", "openInterest", "impliedVolatility"]].dropna()
            df_side = df_side[(df_side["impliedVolatility"] > 0.01) &
                              (df_side["impliedVolatility"] < 5.0) &
                              (df_side["openInterest"] > 0)]
            for _, row in df_side.iterrows():
                K, oi, iv = float(row["strike"]), float(row["openInterest"]), float(row["impliedVolatility"])
                if K <= 0 or iv <= 0:
                    continue
                try:
                    d1    = (np.log(spot / K) + (r + 0.5 * iv**2) * T) / (iv * np.sqrt(T))
                    gamma = _norm.pdf(d1) / (spot * iv * np.sqrt(T))
                    # GEX in $ millions: OI × 100 shares × gamma × spot² × 0.01 (1% move)
                    gex_m = sign * oi * 100 * gamma * spot * spot * 0.01 / 1e6
                    rows.append({"strike": K, "expiry": exp, "side": side, "gex_m": gex_m})
                except Exception:
                    continue

    if not rows:
        return spot, pd.DataFrame()

    df = pd.DataFrame(rows)
    pivot = (df.groupby(["strike", "side"])["gex_m"].sum()
               .unstack(fill_value=0)
               .rename(columns={"call": "call_gex", "put": "put_gex"}))
    for col in ["call_gex", "put_gex"]:
        if col not in pivot.columns:
            pivot[col] = 0.0
    pivot["net_gex"] = pivot["call_gex"] + pivot["put_gex"]
    pivot = pivot.reset_index().sort_values("strike")
    return spot, pivot

# ── SHORT INTEREST & INSIDER FLOW (yfinance) ─────────────────────────────────
@st.cache_data(ttl=86400)
def get_short_interest(ticker):
    try:
        tkr = yf.Ticker(ticker.strip().upper())
        info = tkr.info
        return {
            "shortRatio": info.get("shortRatio", None),
            "shortPercentOfFloat": info.get("shortPercentOfFloat", None),
            "sharesShort": info.get("sharesShort", None),
            "sharesShortPriorMonth": info.get("sharesShortPriorMonth", None),
        }
    except Exception:
        return {}

@st.cache_data(ttl=86400)
def get_insider_transactions(ticker):
    try:
        tkr = yf.Ticker(ticker.strip().upper())
        return tkr.insider_transactions
    except Exception:
        return pd.DataFrame()

# ── PAGE CONFIGURATION ────────────────────────────────────────────────────────
st.set_page_config(page_title="Alphatape Terminal", layout="wide")

# ── THEME STATE ───────────────────────────────────────────────────────────────
# ── SESSION STATE ROUTING ─────────────────────────────────────────────────────
if 'main_nav' not in st.session_state:
    st.session_state.main_nav = "Finance Dashboard"

def go_home():    st.session_state.main_nav = "Finance Dashboard"
def go_market():  st.session_state.main_nav = "Market Data"
def go_options(): st.session_state.main_nav = "Options Pricer"
def go_bond():    st.session_state.main_nav = "Bond Analytics"
def go_nav():     st.session_state.main_nav = "NAV Proxy Tracker"
def go_port():    st.session_state.main_nav = "Portfolio Backtester"
def go_prob():    st.session_state.main_nav = "Options Implied Probability"
def go_fed():     st.session_state.main_nav = "Fed Rate Projections"
def go_earn():    st.session_state.main_nav = "Earnings Calendar"
def go_dcf():     st.session_state.main_nav = "DCF Valuation"
def go_chain():   st.session_state.main_nav = "Options Chain Scanner"
def go_corr():     st.session_state.main_nav = "Correlation Matrix"
def go_strategy(): st.session_state.main_nav = "Strategy Builder"
def go_monte():    st.session_state.main_nav = "Monte Carlo Simulator"
def go_gex():      st.session_state.main_nav = "Dealer GEX"

p_home    = st.Page(go_home,    title="Home")
p_market  = st.Page(go_market,  title="Market Data")
p_options = st.Page(go_options, title="Options Pricer")
p_bond    = st.Page(go_bond,    title="Bond Analytics")
p_nav     = st.Page(go_nav,     title="NAV Proxy Tracker")
p_port    = st.Page(go_port,    title="Portfolio Backtester")
p_prob    = st.Page(go_prob,    title="Implied Probability")
p_fed     = st.Page(go_fed,     title="Fed Rate Projections")
p_earn    = st.Page(go_earn,    title="Corporate Hub")
p_dcf     = st.Page(go_dcf,     title="DCF Valuation")
p_chain    = st.Page(go_chain,    title="Options Chain Scanner")
p_corr     = st.Page(go_corr,    title="Correlation Matrix")
p_strategy = st.Page(go_strategy, title="Strategy Builder")
p_monte    = st.Page(go_monte,    title="Monte Carlo Simulator")
p_gex      = st.Page(go_gex,      title="Dealer GEX")

# ── CSS INJECTION ─────────────────────────────────────────────────────────────
st.markdown("""
<style>
@import url('https://fonts.googleapis.com/css2?family=Lora:ital,wght@0,400;0,500;0,600;0,700;1,400&family=Cinzel:wght@600;700&display=swap');

/* ── BACKGROUNDS ── */
html, body { background-color: #0a1628 !important; }
[data-testid="stAppViewContainer"],
[data-testid="stMain"],
.main, .block-container { background-color: #0a1628 !important; }
[data-testid="stHeader"] {
    background-color: #0a1628 !important;
    border-bottom: none !important;
    border-top: none !important;
    box-shadow: none !important;
}

/* ── SIDEBAR ── */
[data-testid="stSidebar"],
[data-testid="stSidebarContent"] {
    background-color: #080f1e !important;
    border-right: 1px solid rgba(201,168,76,0.18) !important;
}
[data-testid="stSidebarNavLink"] {
    color: #5e768f !important;
    font-size: 0.88rem !important;
    border-radius: 4px !important;
    transition: all 0.15s ease !important;
    padding: 6px 12px !important;
}
[data-testid="stSidebarNavLink"] p,
[data-testid="stSidebarNavLink"] span:not([class*="material"]) {
    font-family: 'Lora', serif !important;
}
[data-testid="stSidebarNavLink"]:hover { color: #c9a84c !important; background-color: rgba(201,168,76,0.07) !important; }
[data-testid="stSidebarNavLink"][aria-current="page"] {
    color: #c9a84c !important;
    background-color: rgba(201,168,76,0.11) !important;
    border-left: 2px solid #c9a84c !important;
    font-weight: 600 !important;
}
[data-testid="stSidebarNavSeparator"] { border-color: rgba(255,255,255,0.06) !important; }
[data-testid="stSidebarNavItems"] { padding-top: 8px !important; }


/* nav section group labels */
[data-testid="stSidebarNavItems"] [data-testid="stText"] p,
.st-emotion-cache-16txtl3 h3 {
    color: #3d526b !important;
    font-size: 0.62rem !important;
    letter-spacing: 0.16em !important;
    text-transform: uppercase !important;
    font-weight: 700 !important;
    margin-top: 18px !important;
    margin-bottom: 4px !important;
}

/* ── GLOBAL TYPOGRAPHY — target text elements only, never broad containers ── */
p, li, td, th { font-family: 'Lora', serif !important; color: #dce3ed; }
h1, h2, h3, h4, h5, h6 { font-family: 'Lora', serif !important; }
input, textarea, select { font-family: 'Lora', serif !important; color: #dce3ed; }
[data-testid="stMarkdownContainer"] p,
[data-testid="stMarkdownContainer"] li,
[data-testid="stMarkdownContainer"] h1,
[data-testid="stMarkdownContainer"] h2,
[data-testid="stMarkdownContainer"] h3,
[data-testid="stMarkdownContainer"] h4,
[data-testid="stMarkdownContainer"] h5,
[data-testid="stMarkdownContainer"] h6 { font-family: 'Lora', serif !important; }
[data-testid="stMetricLabel"] p,
[data-testid="stMetricValue"] div,
[data-testid="stMetricDelta"] div { font-family: 'Lora', serif !important; }
h1 {
    font-family: 'Lora', serif !important;
    font-weight: 700 !important;
    color: #dce3ed !important;
    letter-spacing: 0.02em !important;
    border-bottom: 1px solid rgba(201,168,76,0.22) !important;
    padding-bottom: 16px !important;
    margin-bottom: 36px !important;
}
h2, h3, h4 { font-family: 'Lora', serif !important; color: #dce3ed !important; font-weight: 600 !important; }
h2 { font-weight: 400 !important; text-align: center !important; margin-bottom: 30px !important; }
/* ##### subheaders become gold labels */
[data-testid="stMarkdownContainer"] h5 {
    color: #c9a84c !important;
    font-size: 0.68rem !important;
    font-weight: 700 !important;
    letter-spacing: 0.16em !important;
    text-transform: uppercase !important;
    margin-bottom: 14px !important;
}

/* ── CONTAINERS ── */
[data-testid="stVerticalBlockBorderWrapper"] > div {
    background-color: #0f1d31 !important;
    border: 1px solid rgba(255,255,255,0.07) !important;
    border-radius: 8px !important;
}

/* ── METRIC CARDS ── */
[data-testid="stMetricLabel"] p {
    color: #5e768f !important;
    font-size: 0.67rem !important;
    font-weight: 700 !important;
    letter-spacing: 0.12em !important;
    text-transform: uppercase !important;
}
[data-testid="stMetricValue"] {
    color: #dce3ed !important;
    font-variant-numeric: tabular-nums !important;
    font-weight: 600 !important;
}
[data-testid="stMetricDelta"] { font-variant-numeric: tabular-nums !important; font-size: 0.8rem !important; }

/* ── BUTTONS ── */
[data-testid="stButton"] > button,
[data-testid="stFormSubmitButton"] > button {
    background-color: transparent !important;
    border: 1px solid rgba(201,168,76,0.38) !important;
    color: #c9a84c !important;
    font-family: 'Lora', serif !important;
    font-size: 0.8rem !important;
    letter-spacing: 0.08em !important;
    font-weight: 500 !important;
    border-radius: 4px !important;
    transition: all 0.18s ease !important;
}
[data-testid="stButton"] > button:hover,
[data-testid="stFormSubmitButton"] > button:hover {
    background-color: rgba(201,168,76,0.13) !important;
    border-color: #c9a84c !important;
}

/* ── TEXT & NUMBER INPUTS ── */
[data-testid="stTextInput"] input,
[data-testid="stNumberInput"] input,
textarea {
    background-color: #0a1628 !important;
    border: 1px solid rgba(255,255,255,0.09) !important;
    color: #dce3ed !important;
    font-family: 'Lora', serif !important;
    font-variant-numeric: tabular-nums !important;
    border-radius: 4px !important;
}
[data-testid="stTextInput"] input:focus,
[data-testid="stNumberInput"] input:focus {
    border-color: rgba(201,168,76,0.45) !important;
    box-shadow: 0 0 0 2px rgba(201,168,76,0.08) !important;
    outline: none !important;
}
button[data-testid="stNumberInputStepDown"],
button[data-testid="stNumberInputStepUp"] {
    background-color: #0a1628 !important;
    border-color: rgba(255,255,255,0.09) !important;
    color: #5e768f !important;
}

/* ── SELECT / DROPDOWN ── */
[data-testid="stSelectbox"] > div > div,
[data-baseweb="select"] > div {
    background-color: #0a1628 !important;
    border-color: rgba(255,255,255,0.09) !important;
    color: #dce3ed !important;
    border-radius: 4px !important;
}

/* ── DATE INPUT ── */
[data-testid="stDateInput"] input {
    background-color: #0a1628 !important;
    border: 1px solid rgba(255,255,255,0.09) !important;
    color: #dce3ed !important;
}

/* ── SLIDER ── */
[data-baseweb="slider"] [role="slider"] {
    background-color: #c9a84c !important;
    border-color: #c9a84c !important;
}

/* ── TABS ── */
[data-baseweb="tab-list"] {
    background-color: transparent !important;
    border-bottom: 1px solid rgba(255,255,255,0.07) !important;
    gap: 2px !important;
}
[data-baseweb="tab"] {
    background-color: transparent !important;
    color: #5e768f !important;
    font-family: 'Lora', serif !important;
    font-size: 0.8rem !important;
    letter-spacing: 0.07em !important;
    border-radius: 0 !important;
    padding: 8px 18px !important;
    border-bottom: 2px solid transparent !important;
}
[data-baseweb="tab"]:hover { color: #dce3ed !important; }
[aria-selected="true"][data-baseweb="tab"] {
    color: #c9a84c !important;
    border-bottom: 2px solid #c9a84c !important;
    font-weight: 600 !important;
}
[data-baseweb="tab-highlight"] { background-color: #c9a84c !important; height: 2px !important; }
[data-baseweb="tab-border"] { background-color: rgba(255,255,255,0.07) !important; }

/* ── DIVIDERS ── */
hr { border-color: rgba(255,255,255,0.07) !important; }

/* ── CAPTIONS ── */
[data-testid="stCaptionContainer"] p { color: #5e768f !important; font-size: 0.76rem !important; }

/* ── RADIO ── */
[data-testid="stRadio"] label p { color: #dce3ed !important; }
[data-testid="stRadio"] [data-testid="stWidgetLabel"] p {
    color: #5e768f !important; font-size: 0.67rem !important;
    text-transform: uppercase !important; letter-spacing: 0.12em !important;
}

/* ── TOGGLE ── */
[data-testid="stToggle"] p { color: #dce3ed !important; }

/* ── ALERTS ── */
[data-testid="stAlert"] { border-radius: 6px !important; border-left-width: 3px !important; }

/* ── DATAFRAME / TABLE ── */
[data-testid="stDataFrame"], input, table { font-variant-numeric: tabular-nums !important; }

/* ── SCROLLBAR ── */
::-webkit-scrollbar { width: 4px; height: 4px; }
::-webkit-scrollbar-track { background: #0a1628; }
::-webkit-scrollbar-thumb { background: rgba(201,168,76,0.28); border-radius: 2px; }
::-webkit-scrollbar-thumb:hover { background: rgba(201,168,76,0.5); }

/* legacy sidebar radio (fallback) */
[data-testid="stSidebar"] [data-testid="stRadio"] div[role="radiogroup"] > label > div:first-child { display: none !important; }
[data-testid="stSidebar"] [data-testid="stRadio"] div[role="radiogroup"] label p {
    font-size: 1.0rem !important; font-weight: 500 !important;
    padding: 5px 0; margin: 0 !important; cursor: pointer; color: #5e768f !important;
}
[data-testid="stSidebar"] [data-testid="stRadio"] div[role="radiogroup"] > label:first-child p {
    font-size: 22px !important; font-weight: 700 !important;
    padding-bottom: 18px !important; margin-bottom: 12px !important;
    border-bottom: 1px solid rgba(201,168,76,0.22) !important; color: #dce3ed !important;
}
[data-testid="stSidebar"] [data-testid="stRadio"] div[role="radiogroup"] > label:not(:first-child):hover p { color: #c9a84c !important; }

/* ── SIDEBAR COLLAPSE / TOGGLE BUTTON ── */
[data-testid="stSidebarCollapseButton"] button,
[data-testid="stSidebarCollapsedControl"] button,
[data-testid="stSidebarCollapsedControl"],
button[aria-label="Close sidebar"],
button[aria-label="Open sidebar"],
button[aria-label="collapse sidebar navigation"],
button[aria-label="expand sidebar navigation"] {
    background-color: #0f1d31 !important;
    border: 1.5px solid rgba(255,255,255,0.55) !important;
    color: #ffffff !important;
    border-radius: 4px !important;
}
[data-testid="stSidebarCollapseButton"] button svg path,
[data-testid="stSidebarCollapsedControl"] button svg path,
[data-testid="stSidebarCollapseButton"] svg,
[data-testid="stSidebarCollapsedControl"] svg {
    fill: rgba(255,255,255,0.80) !important;
    stroke: rgba(255,255,255,0.80) !important;
    color: rgba(255,255,255,0.80) !important;
}

/* ── BUTTON HOVER — explicit gold text, no white bleed ── */
[data-testid="stButton"] > button:hover,
[data-testid="stFormSubmitButton"] > button:hover {
    background-color: rgba(201,168,76,0.13) !important;
    border-color: #c9a84c !important;
    color: #c9a84c !important;
}
[data-testid="stButton"] > button:active,
[data-testid="stButton"] > button:focus,
[data-testid="stFormSubmitButton"] > button:active,
[data-testid="stFormSubmitButton"] > button:focus {
    color: #c9a84c !important;
    background-color: rgba(201,168,76,0.18) !important;
    outline: none !important;
    box-shadow: none !important;
}

/* ── METRIC CARDS — gold top accent, dark surface ── */
[data-testid="stMetric"] {
    background: #0f1d31 !important;
    border: 1px solid rgba(255,255,255,0.07) !important;
    border-top: 2px solid rgba(201,168,76,0.45) !important;
    border-radius: 6px !important;
    padding: 14px 18px !important;
}

/* ── CONTAINERS — gold top accent ── */
[data-testid="stVerticalBlockBorderWrapper"] > div {
    border-top: 2px solid rgba(201,168,76,0.28) !important;
}

/* ── SECTION SUBHEADERS — gold left rule ── */
[data-testid="stMarkdownContainer"] h5 {
    border-left: 3px solid #c9a84c !important;
    padding-left: 10px !important;
}

/* ── WIDGET / INPUT LABELS ── */
[data-testid="stWidgetLabel"] p {
    color: #5e768f !important;
    font-size: 0.72rem !important;
    letter-spacing: 0.08em !important;
    text-transform: uppercase !important;
    font-family: 'Lora', serif !important;
}

/* ── CHECKBOXES ── */
[data-testid="stCheckbox"] p { color: #dce3ed !important; font-size: 0.85rem !important; text-transform: none !important; letter-spacing: 0 !important; }

/* ── SPINNER ── */
[data-testid="stSpinner"] p { color: #5e768f !important; }

/* ── SUCCESS / WARNING / ERROR text ── */
[data-testid="stAlert"] p { font-size: 0.82rem !important; }

/* ── PLOTLY CHART BORDER ── */
[data-testid="stPlotlyChart"] {
    border: 1px solid rgba(255, 255, 255, 0.10) !important;
    border-radius: 8px !important;
    padding: 12px 16px !important;
    background-color: #0f1d31 !important;
}

/* ── IMPROVED TEXT READABILITY ── */
p, li, td, th { line-height: 1.65 !important; font-size: 0.92rem !important; }
[data-testid="stMarkdownContainer"] p { line-height: 1.65 !important; font-size: 0.92rem !important; }
[data-testid="stCaptionContainer"] p { font-size: 0.80rem !important; line-height: 1.55 !important; color: #7a92a8 !important; }
[data-testid="stWidgetLabel"] p { font-size: 0.75rem !important; letter-spacing: 0.09em !important; }
[data-testid="stMetricLabel"] p { font-size: 0.70rem !important; letter-spacing: 0.13em !important; }
[data-testid="stMetricValue"] { font-size: 1.6rem !important; }
h1 { font-size: 1.9rem !important; }
h2 { font-size: 1.3rem !important; }
h3 { font-size: 1.1rem !important; }
[data-testid="stSidebarNavLink"] p { font-size: 0.92rem !important; }
[data-testid="stAlert"] p { font-size: 0.86rem !important; line-height: 1.5 !important; }
[data-testid="stVerticalBlockBorderWrapper"] > div { padding: 18px 20px !important; }
</style>
""", unsafe_allow_html=True)

# ── SIDEBAR NAVIGATION ────────────────────────────────────────────────────────
pages = {
    "": [p_home],
    "Data & Dashboards":    [p_market, p_earn, p_corr],
    "Valuation & Analysis": [p_dcf, p_chain],
    "Derivatives & Rates":  [p_options, p_strategy, p_prob, p_gex, p_fed, p_bond],
    "Portfolio Tools":      [p_nav, p_port, p_monte],
}

pg = st.navigation(pages)

# ── SIDEBAR LOGO ──────────────────────────────────────────────────────────────
import base64 as _b64
_logo_svg = """\
<svg xmlns="http://www.w3.org/2000/svg" width="220" height="52" viewBox="0 0 220 52">
  <text x="3" y="28" font-family="Georgia,'Times New Roman',serif"
        font-size="20" font-weight="700" fill="#c9a84c" letter-spacing="2.4">ALPHATAPE</text>
  <line x1="3" y1="33" x2="120" y2="33" stroke="#c9a84c" stroke-width="0.7" opacity="0.55"/>
  <text x="4" y="46" font-family="Georgia,'Times New Roman',serif"
        font-size="9.5" fill="#8a9ab0" letter-spacing="7">TERMINAL</text>
</svg>"""
_icon_svg = """\
<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40" viewBox="0 0 40 40">
  <text x="20" y="30" font-family="Georgia,'Times New Roman',serif"
        font-size="26" font-weight="700" fill="#c9a84c" text-anchor="middle">A</text>
</svg>"""
st.logo(
    "data:image/svg+xml;base64," + _b64.b64encode(_logo_svg.encode()).decode(),
    icon_image="data:image/svg+xml;base64," + _b64.b64encode(_icon_svg.encode()).decode(),
)

pg.run()


selected_tab = st.session_state.main_nav

# ── ERROR BOUNDARY WRAPPER ────────────────────────────────────────────────────
def safe_tab(fn):
    try:
        fn()
    except Exception as e:
        st.error(f"Module error: {str(e)}")
        st.caption("Please check your inputs and try again. If the issue persists, verify API connectivity.")

# ══════════════════════════════════════════════════════════════════════════════
# TAB 0 — HOME
# ══════════════════════════════════════════════════════════════════════════════
def render_home():
    st.markdown("""
    <div style='padding: 2rem 0 1.2rem 0;'>
      <div style='font-family:"Cinzel",Georgia,serif;font-size:2.1rem;font-weight:700;
                  letter-spacing:0.08em;color:#c9a84c;line-height:1.1;'>
        ALPHATAPE TERMINAL
      </div>
      <div style='margin-top:0.5rem;font-size:0.95rem;color:#5e768f;letter-spacing:0.04em;'>
        Select a module to launch the respective model.
      </div>
    </div>
    """, unsafe_allow_html=True)

    # ── section helper ─────────────────────────────────────────────────────────
    def _section(label):
        st.markdown(
            f"<div style='margin:2rem 0 0.6rem 0;font-size:0.65rem;font-weight:700;"
            f"letter-spacing:0.18em;text-transform:uppercase;color:#3d526b;"
            f"border-bottom:1px solid rgba(255,255,255,0.05);padding-bottom:6px;'>"
            f"{label}</div>",
            unsafe_allow_html=True,
        )

    # ── card helper ────────────────────────────────────────────────────────────
    def _card(col, accent, title, body, btn_label, page):
        with col:
            st.markdown(
                f"""<div style='border:1px solid rgba(255,255,255,0.07);
                    border-top:2px solid {accent};
                    border-radius:6px;background:#0d1a2d;
                    padding:18px 18px 10px 18px;min-height:130px;'>
                  <div style='font-family:Lora,serif;font-size:1.0rem;font-weight:700;
                              color:#dce3ed;margin-bottom:8px;'>{title}</div>
                  <div style='font-size:0.82rem;color:#5e768f;line-height:1.55;'>{body}</div>
                </div>""",
                unsafe_allow_html=True,
            )
            if st.button(btn_label, use_container_width=True, key=f"home_{title}"):
                st.switch_page(page)

    # ── Markets & Data ─────────────────────────────────────────────────────────
    _section("Markets & Data")
    c1, c2, c3 = st.columns(3)
    _card(c1, "#1f5673", "Market Data",
          "Historical price action, rolling volatility, and peak drawdown structural analysis.",
          "Open", p_market)
    _card(c2, "#1f5673", "Corporate Hub",
          "Dynamic calendar aggregating earnings, news, short interest, and insider flow.",
          "Open", p_earn)
    _card(c3, "#1f5673", "Correlation Matrix",
          "Rolling correlation heatmap across any custom basket of tickers.",
          "Open", p_corr)

    # ── Derivatives & Rates ────────────────────────────────────────────────────
    _section("Derivatives & Rates")
    c1, c2, c3 = st.columns(3)
    _card(c1, "#7b5ea7", "Options Pricer",
          "Black-Scholes pricing with dynamic Greek calculator and payoff diagrams.",
          "Open", p_options)
    _card(c2, "#7b5ea7", "Options Chain Scanner",
          "Live chains with IV rank, open interest skew, and put/call ratio by strike.",
          "Open", p_chain)
    _card(c3, "#7b5ea7", "Options Implied Probability",
          "Risk-neutral probability distributions derived from live options chains.",
          "Open", p_prob)

    c1, c2, c3 = st.columns(3)
    _card(c1, "#7b5ea7", "Strategy Builder",
          "Build and visualise multi-leg options strategies with live P&L profiles.",
          "Open", p_strategy)
    _card(c2, "#7b5ea7", "Dealer GEX",
          "Gamma exposure aggregated across all expiries — identifies pin and trend-amplification zones.",
          "Open", p_gex)
    _card(c3, "#7b5ea7", "Bond Analytics",
          "Bond valuation, yield-to-maturity tracking, duration sensitivity, and cash flow schedules.",
          "Open", p_bond)

    c1, c2, _ = st.columns(3)
    _card(c1, "#7b5ea7", "Macro Rate Engine",
          "Implied Fed rate path projections and scenario analysis across FOMC meetings.",
          "Open", p_fed)

    # ── Portfolio & Valuation ──────────────────────────────────────────────────
    _section("Portfolio & Valuation")
    c1, c2, c3 = st.columns(3)
    _card(c1, "#2f6b4b", "Portfolio Backtester",
          "Backtest custom-weighted equity baskets against benchmarks with institutional risk metrics.",
          "Open", p_port)
    _card(c2, "#2f6b4b", "Monte Carlo Simulator",
          "GBM path simulation with strategy overlays, VaR, CVaR, and benchmark comparison.",
          "Open", p_monte)
    _card(c3, "#2f6b4b", "DCF Valuation Engine",
          "Discounted cash flow model with revenue growth, WACC, and terminal value vs market price.",
          "Open", p_dcf)

    c1, c2, _ = st.columns(3)
    _card(c1, "#2f6b4b", "NAV Proxy Tracker",
          "Sum-of-the-parts NAV engine with live MSTR Bitcoin holdings from strategy.com.",
          "Open", p_nav)

# ══════════════════════════════════════════════════════════════════════════════
# TAB 1 — MARKET DATA
# ══════════════════════════════════════════════════════════════════════════════
def render_market():
    st.header("Market Data & Drawdown Analysis")

    with st.container(border=True):
        st.markdown("##### Query Parameters")
        col1, col2, col3 = st.columns([1, 1, 1])
        final_ticker = col1.text_input("Ticker Symbol", value="SPY", key="market_ticker_sel").strip().upper()
        start = col2.date_input("Filter Start Date", value=pd.to_datetime("2020-01-01"))
        end   = col3.date_input("Filter End Date",   value=pd.to_datetime("2024-12-31"))
        _, colB = st.columns([5, 1])
        load_data = colB.button("Load Data", use_container_width=True)

    if load_data:
        with st.spinner(f"Fetching data for {final_ticker}..."):
            raw_df = get_yf_market_data(final_ticker)

        if not raw_df.empty:
            mask = (raw_df.index >= pd.to_datetime(start)) & (raw_df.index <= pd.to_datetime(end))
            df_filtered = raw_df.loc[mask]

            if df_filtered.empty:
                st.error("No trading data matches the selected time range filter.")
            else:
                prices      = df_filtered["close"]
                returns     = np.log(prices / prices.shift(1)).dropna()
                rolling_vol = returns.rolling(30).std() * np.sqrt(252)
                wealth_idx  = (1 + prices.pct_change().fillna(0)).cumprod()
                drawdown    = (wealth_idx - wealth_idx.cummax()) / wealth_idx.cummax()

                # Summary metrics
                total_return = (prices.iloc[-1] / prices.iloc[0] - 1) * 100
                max_dd       = drawdown.min() * 100
                ann_vol      = returns.std() * np.sqrt(252) * 100

                with st.container(border=True):
                    m1, m2, m3, m4 = st.columns(4)
                    m1.metric("Total Return",   f"{total_return:.2f}%")
                    m2.metric("Max Drawdown",   f"{max_dd:.2f}%")
                    m3.metric("Ann. Volatility",f"{ann_vol:.2f}%")
                    m4.metric("Current Price",  f"${prices.iloc[-1]:,.2f}")

                st.markdown("<br>", unsafe_allow_html=True)
                _, exp_col2 = st.columns([4, 1])
                with exp_col2:
                    st.download_button(" Export to CSV", data=convert_df_to_csv(df_filtered),
                        file_name=f"{final_ticker}_historical_pricing.csv", mime="text/csv", use_container_width=True)

                fig = make_subplots(rows=3, cols=1, shared_xaxes=True,
                    subplot_titles=("Price (EOD Close)", "30D Rolling Volatility (Annualized)", "Peak Drawdown"),
                    vertical_spacing=0.08)
                fig.add_trace(go.Scatter(x=prices.index, y=prices, name="Price", line=dict(color="#1f5673", width=2.5)), row=1, col=1)
                fig.add_trace(go.Scatter(x=rolling_vol.index, y=rolling_vol, name="Vol", line=dict(color="#d97736", width=2)), row=2, col=1)
                fig.add_trace(go.Scatter(x=drawdown.index, y=drawdown, name="Drawdown", fill="tozeroy", line=dict(color="#8c2e36", width=1.5)), row=3, col=1)
                fig.update_layout(height=750, hovermode="x unified", showlegend=False,
                    font=dict(family="Lora, serif"), plot_bgcolor="rgba(0,0,0,0)", paper_bgcolor="rgba(0,0,0,0)")
                fig.update_xaxes(showgrid=True, gridcolor="rgba(128,128,128,0.1)")
                fig.update_yaxes(showgrid=True, gridcolor="rgba(128,128,128,0.1)", row=1, col=1)
                fig.update_yaxes(showgrid=True, gridcolor="rgba(128,128,128,0.1)", tickformat=".1%", row=2, col=1)
                fig.update_yaxes(showgrid=True, gridcolor="rgba(128,128,128,0.1)", tickformat=".1%", row=3, col=1)
                st.plotly_chart(fig, use_container_width=True)
        else:
            st.error("Data tracking failed. Confirm the ticker exists and that your API key is accurate.")

# ══════════════════════════════════════════════════════════════════════════════
# TAB 2 — OPTIONS PRICER
# ══════════════════════════════════════════════════════════════════════════════
def render_options():
    st.header("Black-Scholes Advanced Options Pricer")

    with st.container(border=True):
        st.markdown("##### Pricing Parameters")
        col1, col2, col3 = st.columns(3)
        S           = col1.number_input("Spot Price",       value=100.0, step=1.0)
        K           = col1.number_input("Strike Price",     value=100.0, step=1.0)
        T_days      = col2.number_input("Days to Expiry",   value=30.0)
        sigma_pct   = col2.number_input("Volatility %",     value=20.0)
        r_pct       = col3.number_input("Risk-free Rate %", value=5.0)
        option_type = col3.selectbox("Option Type", ["call", "put"])

    T     = max(T_days / 365.25, 0.0001)
    sigma = max(sigma_pct / 100.0, 0.0001)
    r     = r_pct / 100.0

    d1 = (np.log(S / K) + (r + 0.5 * sigma**2) * T) / (sigma * np.sqrt(T))
    d2 = d1 - sigma * np.sqrt(T)

    price = bs_price(S, K, T_days, r_pct, sigma_pct, option_type)
    g     = bs_greeks(S, K, T_days, r_pct, sigma_pct, option_type)

    vanna = -norm.pdf(d1) * (d2 / sigma)
    if option_type == 'call':
        charm = -norm.pdf(d1) * ((r / (sigma * np.sqrt(T))) - (d2 / (2 * T)))
    else:
        charm = -norm.pdf(d1) * ((r / (sigma * np.sqrt(T))) - (d2 / (2 * T))) + r * np.exp(-r * T)

    with st.container(border=True):
        st.markdown(f"### Option Premium: **${price:.4f}**")
        st.divider()
        c1, c2, c3, c4, c5, c6 = st.columns(6)
        c1.metric("Delta", f"{g['delta']:.4f}")
        c2.metric("Gamma", f"{g['gamma']:.4f}")
        c3.metric("Theta", f"{g['theta']:.4f}")
        c4.metric("Vega",  f"{g['vega']:.4f}")
        c5.metric("Vanna", f"{vanna:.4f}", help="Delta sensitivity to Volatility")
        c6.metric("Charm", f"{charm:.4f}", help="Delta sensitivity to Time")

    # ── Payoff Diagram ────────────────────────────────────────────────────────
    st.markdown("<br>", unsafe_allow_html=True)
    st.markdown("##### Expiry Payoff Diagram")
    spot_range_payoff = np.linspace(S * 0.5, S * 1.5, 400)

    if option_type == "call":
        long_payoff = np.maximum(spot_range_payoff - K, 0) - price
    else:
        long_payoff = np.maximum(K - spot_range_payoff, 0) - price

    fig_payoff = go.Figure()
    fig_payoff.add_trace(go.Scatter(x=spot_range_payoff, y=long_payoff, name=f"Long {option_type.capitalize()}", line=dict(color="#2f6b4b", width=2.5)))
    fig_payoff.add_hline(y=0, line_dash="dash", line_color="rgba(128,128,128,0.5)")
    fig_payoff.add_vline(x=K, line_dash="dot", line_color="#d97736", annotation_text="Strike")
    fig_payoff.add_vline(x=S, line_dash="solid", line_color="rgba(128,128,128,0.6)", annotation_text="Spot")
    fig_payoff.update_layout(height=400, hovermode="x unified", font=dict(family="Lora, serif"),
        plot_bgcolor="rgba(0,0,0,0)", paper_bgcolor="rgba(0,0,0,0)",
        yaxis_title="P&L at Expiry ($)", xaxis_title="Spot Price at Expiry ($)",
        legend=dict(orientation="h", yanchor="bottom", y=1.02, xanchor="right", x=1))
    st.plotly_chart(fig_payoff, use_container_width=True)

    st.markdown("##### Greek Dynamics & Structural Mapping")
    view_toggle = st.radio("Visualization Mode", ["Standard 2D Greeks", "3D Delta Surface Topography"], horizontal=True, label_visibility="collapsed")

    if view_toggle == "Standard 2D Greeks":
        spot_range = np.linspace(S*0.6, S*1.4, 300)
        metrics = {"delta": [], "gamma": [], "theta": [], "vega": []}
        for spot in spot_range:
            gg = bs_greeks(spot, K, T_days, r_pct, sigma_pct, option_type)
            for key in metrics:
                metrics[key].append(gg[key])

        fig2 = make_subplots(rows=2, cols=2, subplot_titles=("Delta", "Gamma", "Theta", "Vega"))
        positions = [(1,1),(1,2),(2,1),(2,2)]
        for (row,col),(name,vals) in zip(positions, metrics.items()):
            vals_arr = np.array(vals)
            sr = np.array(spot_range)
            fig2.add_trace(go.Scatter(x=sr[sr<=S], y=vals_arr[sr<=S], line=dict(color="#8c2e36", width=2.5),
                fill='tozeroy', fillcolor="rgba(140,46,54,0.15)"), row=row, col=col)
            fig2.add_trace(go.Scatter(x=sr[sr>=S], y=vals_arr[sr>=S], line=dict(color="#2f6b4b", width=2.5),
                fill='tozeroy', fillcolor="rgba(47,107,75,0.15)"), row=row, col=col)
            fig2.add_vline(x=K, line_dash="dash", line_color="rgba(128,128,128,0.5)",
                annotation_text="Strike", annotation_position="top left", row=row, col=col)
            fig2.add_vline(x=S, line_dash="solid", line_color="rgba(128,128,128,0.8)",
                annotation_text="Spot", annotation_position="top right", row=row, col=col)
        fig2.update_layout(height=600, showlegend=False, hovermode="x unified",
            font=dict(family="Lora, serif"), plot_bgcolor="rgba(0,0,0,0)", paper_bgcolor="rgba(0,0,0,0)")
        st.plotly_chart(fig2, use_container_width=True)
    else:
        spot_axis = np.linspace(S*0.7, S*1.3, 40)
        time_axis = np.linspace(1, max(T_days * 1.5, 90), 40)
        X, Y = np.meshgrid(spot_axis, time_axis)
        Z_delta = np.zeros_like(X)
        for i in range(X.shape[0]):
            for j in range(X.shape[1]):
                gg_3d = bs_greeks(X[i,j], K, Y[i,j], r_pct, sigma_pct, option_type)
                Z_delta[i,j] = gg_3d['delta']
        fig3d = go.Figure(data=[go.Surface(z=Z_delta, x=X, y=Y, colorscale='RdYlGn', opacity=0.9,
            contours=dict(z=dict(show=True, usecolormap=True, highlightcolor="white", project_z=True)))])
        fig3d.update_layout(title=f"3D Delta Surface ({option_type.upper()})",
            scene=dict(xaxis_title='Spot Price ($)', yaxis_title='Days to Expiry', zaxis_title='Delta',
                camera=dict(eye=dict(x=1.5, y=-1.5, z=0.8))),
            height=700, margin=dict(l=0, r=0, b=0, t=40))
        st.plotly_chart(fig3d, use_container_width=True)

# ══════════════════════════════════════════════════════════════════════════════
# TAB 3 — BOND ANALYTICS
# ══════════════════════════════════════════════════════════════════════════════
def render_bond():
    st.header("Bond Analytics")

    def solve_ytm(face, coupon_rate, market_price, maturity, guess=0.05):
        coupon = face * (coupon_rate / 100)
        ytm = guess
        for _ in range(100):
            periods = np.arange(1, maturity + 1)
            price_estimate = (coupon / ((1 + ytm) ** periods)).sum() + face / ((1 + ytm) ** maturity)
            error = market_price - price_estimate
            if abs(error) < 1e-6:
                break
            ytm -= error / (market_price * maturity)
        return max(ytm, 0.0001)

    with st.container(border=True):
        st.markdown("##### Bond Parameters")
        col1, col2 = st.columns(2)
        face         = col1.number_input("Face Value ($)",    min_value=100.0, step=100.0, value=1000.0)
        coupon_rate  = col1.number_input("Coupon Rate (%)",   min_value=0.0, max_value=20.0, step=0.25, value=5.0)
        market_price = col2.number_input("Market Price ($)",  min_value=100.0, step=1.0, value=1000.0)
        maturity     = col2.number_input("Maturity (Years)",  min_value=1, max_value=50, step=1, value=10)

    implied_ytm     = solve_ytm(face, coupon_rate, market_price, int(maturity))
    implied_ytm_pct = implied_ytm * 100
    d               = duration_convexity(face, coupon_rate, maturity, implied_ytm_pct)

    cf_years        = np.arange(1, int(maturity) + 1)
    coupon_payment  = face * (coupon_rate / 100)
    nominal_cfs     = np.full(int(maturity), coupon_payment)
    nominal_cfs[-1]+= face
    pv_cfs          = nominal_cfs / ((1 + implied_ytm) ** cf_years)

    bond_type = "Premium Bond" if market_price > face else ("Discount Bond" if market_price < face else "Par Bond")

    with st.container(border=True):
        st.markdown(f"### {bond_type}")
        st.divider()
        m1, m2, m3, m4 = st.columns(4)
        m1.metric("Implied YTM",       f"{implied_ytm_pct:.2f}%")
        m2.metric("Bond Price",        f"${market_price:,.2f}")
        m3.metric("Modified Duration", f"{d['mod_duration']:.2f}")
        m4.metric("Convexity",         f"{d['convexity']:.2f}")

    # ── Duration Price Sensitivity (Interactive) ──────────────────────────────
    st.markdown("<br>", unsafe_allow_html=True)
    st.markdown("##### Duration-Adjusted Price Sensitivity")
    shift_bps = st.slider("Rate Shift (basis points)", min_value=-300, max_value=300, value=0, step=5)

    new_ytm   = max(implied_ytm + shift_bps / 10000, 0.0001)
    new_price = sum(nominal_cfs[i-1] / ((1 + new_ytm) ** i) for i in cf_years)
    pct_chg   = (new_price - market_price) / market_price * 100

    sm1, sm2, sm3 = st.columns(3)
    sm1.metric("Rate Shift", f"{shift_bps:+d} bps")
    sm2.metric("New Price",  f"${new_price:,.2f}", delta=f"{pct_chg:+.2f}%")
    sm3.metric("New YTM",    f"{new_ytm*100:.2f}%")

    curve_shifts = np.arange(-300, 305, 5)
    curve_prices = [
        sum(nominal_cfs[i-1] / ((1 + max(implied_ytm + s / 10000, 0.0001)) ** i) for i in cf_years)
        for s in curve_shifts
    ]
    fig_sens = go.Figure()
    fig_sens.add_trace(go.Scatter(x=curve_shifts, y=curve_prices, mode="lines",
        line=dict(color="#1f5673", width=2.5)))
    fig_sens.add_vline(x=shift_bps, line_dash="dash", line_color="#d97736",
        annotation_text=f"{shift_bps:+d} bps  ${new_price:,.2f}")
    fig_sens.add_hline(y=market_price, line_dash="dot", line_color="rgba(128,128,128,0.5)",
        annotation_text="Current Price")
    fig_sens.update_layout(height=360, hovermode="x unified", font=dict(family="Lora, serif"),
        xaxis_title="Rate Shift (bps)", yaxis_title="Bond Price ($)",
        plot_bgcolor="rgba(0,0,0,0)", paper_bgcolor="rgba(0,0,0,0)",
        xaxis=dict(showgrid=True, gridcolor="rgba(128,128,128,0.1)"),
        yaxis=dict(showgrid=True, gridcolor="rgba(128,128,128,0.1)", tickprefix="$", tickformat=",.0f"),
        showlegend=False)
    st.plotly_chart(fig_sens, use_container_width=True)

    st.markdown("<br>", unsafe_allow_html=True)
    fig_cf = go.Figure()
    fig_cf.add_trace(go.Bar(x=cf_years, y=nominal_cfs, name="Nominal Cash Flow", marker_color="#1f5673"))
    fig_cf.add_trace(go.Bar(x=cf_years, y=pv_cfs, name="Present Value", marker_color="#d97736"))
    fig_cf.update_layout(title="Bond Cash Flow Schedule: Nominal vs Discounted",
        xaxis_title="Year", yaxis_title="Cash Flow ($)", barmode='group', height=550, hovermode="x unified",
        font=dict(family="Lora, serif"), plot_bgcolor="rgba(0,0,0,0)", paper_bgcolor="rgba(0,0,0,0)",
        legend=dict(orientation="h", yanchor="bottom", y=1.02, xanchor="right", x=1))
    fig_cf.update_xaxes(tickmode='linear', tick0=1, dtick=1)
    st.plotly_chart(fig_cf, use_container_width=True)

    with st.container(border=True):
        st.markdown("### Bond Structure Overview")
        st.divider()
        c1, c2, c3 = st.columns(3)
        c1.metric("Coupon Payment",        f"${coupon_payment:,.2f}")
        c2.metric("Years Remaining",       f"{int(maturity)}")
        c3.metric("Coupon vs Yield Spread",f"{(coupon_rate - implied_ytm_pct):.2f}%")

# ══════════════════════════════════════════════════════════════════════════════
# TAB 4 — NAV PROXY TRACKER (with live strategy.com data)
# ══════════════════════════════════════════════════════════════════════════════
def render_nav():
    st.header("Sum-of-the-Parts: NAV Proxy & Premium Tracker")

    with st.container(border=True):
        st.markdown("##### Target & Treasury Parameters")
        col1, col2 = st.columns([1, 1])
        target_ticker = col1.text_input("Target Ticker", value="MSTR", key="nav_target_ticker_input")
        asset_ticker  = col2.text_input("Proxy Asset",   value="BTC-USD", key="nav_asset_ticker_input")

        cA, cB = st.columns(2)
        start_nav = cA.date_input("Analysis Start", value=pd.to_datetime("2023-01-01"), key="nav_start_date")
        end_nav   = cB.date_input("Analysis End",   value=pd.to_datetime("today"), key="nav_end_date")

        # Live BTC holdings toggle for MSTR
        is_mstr = target_ticker.strip().upper() == "MSTR"
        if is_mstr:
            with st.container(border=True):
                st.markdown("##### Strategy.com Live Data Integration")
                col_a, col_b, col_c = st.columns([2, 1, 1])
                use_live = col_a.toggle("Pull live BTC holdings from strategy.com", value=True)
                corporate_debt_input = col_b.number_input("Gross Debt ($M)", value=4200.0, step=100.0)
                corporate_cash_input = col_c.number_input("Cash Reserves ($M)", value=150.0, step=10.0)
            if use_live:
                with st.spinner("Fetching live Bitcoin holdings from strategy.com..."):
                    mstr_data = get_mstr_bitcoin_holdings()
                holdings_count   = mstr_data["btc_holdings"]
                avg_cost_basis   = mstr_data["avg_cost_basis"]
                data_source_label = mstr_data["source"]
                st.success(f" BTC Holdings: **{holdings_count:,.0f} BTC** | Avg Cost: **${avg_cost_basis:,.0f}** | Source: *{data_source_label}*")
            else:
                holdings_count    = st.number_input("Manual BTC Holdings Override", value=553555.0, step=1000.0)
                avg_cost_basis    = st.number_input("Avg Cost Basis ($/BTC)", value=68459.0, step=100.0)
                data_source_label = "manual override"
            corporate_debt = corporate_debt_input
            corporate_cash = corporate_cash_input
        else:
            holdings_count    = st.number_input("Asset Holdings Count", value=1000.0, step=100.0)
            avg_cost_basis    = 0.0
            data_source_label = "manual"
            corporate_debt    = st.number_input("Corporate Debt ($M)", value=0.0)
            corporate_cash    = st.number_input("Corporate Cash ($M)", value=0.0)

        _, colY = st.columns([5, 1])
        run_proxy = colY.button("Execute SOTP Matrix", use_container_width=True)

    if run_proxy:
        with st.spinner(f"Processing structural balance sheet matrices for {target_ticker.upper()}..."):
            tkr_obj    = yf.Ticker(target_ticker.strip().upper())
            shares_out = tkr_obj.info.get("sharesOutstanding", None) or tkr_obj.info.get("impliedSharesOutstanding", 345_930_000)
            target_series = get_yf_backtest_series(target_ticker, start_nav, end_nav)
            asset_series  = get_yf_backtest_series(asset_ticker,  start_nav, end_nav)

        if target_series.empty or asset_series.empty:
            st.error("Data synchronization failed. Verify tickers are valid.")
        else:
            df = pd.concat([target_series, asset_series], axis=1, join='inner')
            df.columns = ["Target", "Asset"]

            df["Gross_Asset_Value_Per_Share"] = (holdings_count * df["Asset"]) / shares_out
            net_debt         = corporate_debt - corporate_cash
            net_debt_per_shr = (net_debt * 1_000_000) / shares_out

            df["Asset_Value_Per_Share"] = df["Gross_Asset_Value_Per_Share"] - net_debt_per_shr
            df["Premium_Discount"]      = (df["Target"] - df["Asset_Value_Per_Share"]) / df["Asset_Value_Per_Share"]

            current_target  = df["Target"].iloc[-1]
            current_gav     = df["Gross_Asset_Value_Per_Share"].iloc[-1]
            current_nav     = df["Asset_Value_Per_Share"].iloc[-1]
            current_premium = df["Premium_Discount"].iloc[-1]
            current_btc_px  = df["Asset"].iloc[-1]

            # Unrealized gain if MSTR
            if is_mstr and avg_cost_basis > 0:
                unrealized_pnl = (current_btc_px - avg_cost_basis) * holdings_count
                unrealized_pct = (current_btc_px / avg_cost_basis - 1) * 100
            else:
                unrealized_pnl = 0.0
                unrealized_pct = 0.0

            with st.container(border=True):
                st.markdown("##### SOTP Capital Structure Valuation Matrix")
                st.caption(f"Shares Outstanding: {shares_out:,.0f} | Debt: ${corporate_debt:,.1f}M | Cash: ${corporate_cash:,.1f}M | Data: {data_source_label}")
                st.divider()
                m1, m2, m3, m4, m5, m6 = st.columns(6)
                m1.metric(f"{target_ticker.upper()} Price", f"${current_target:,.2f}")
                m2.metric("Gross Asset / Shr",              f"${current_gav:,.2f}")
                m3.metric("Net Debt / Shr",                 f"${net_debt_per_shr:,.2f}")
                m4.metric("True Net NAV / Shr",             f"${current_nav:,.2f}")
                m5.metric("Implied Premium",                f"{current_premium*100:+.2f}%")
                m6.metric(f"{asset_ticker.upper()} Spot",  f"${current_btc_px:,.2f}")

            if is_mstr and avg_cost_basis > 0:
                with st.container(border=True):
                    st.markdown("##### Bitcoin Treasury Unrealized P&L")
                    st.divider()
                    p1, p2, p3 = st.columns(3)
                    p1.metric("Holdings",           f"{holdings_count:,.0f} BTC")
                    p2.metric("Avg Cost Basis",     f"${avg_cost_basis:,.0f}")
                    p3.metric("Unrealized P&L",     f"${unrealized_pnl/1e9:.2f}B", f"{unrealized_pct:+.1f}%")

            st.markdown("<br>", unsafe_allow_html=True)
            fig4 = make_subplots(rows=2, cols=1, shared_xaxes=True,
                subplot_titles=("Market Price vs SOTP Net NAV Floor", "Historical Premium / Discount %"),
                vertical_spacing=0.1, row_heights=[0.7, 0.3])
            fig4.add_trace(go.Scatter(x=df.index, y=df["Target"], name="Equity Spot", line=dict(color="#1f5673", width=2.5)), row=1, col=1)
            fig4.add_trace(go.Scatter(x=df.index, y=df["Asset_Value_Per_Share"], name="Leverage-Adjusted NAV Floor", line=dict(color="#d97736", width=2, dash="dot")), row=1, col=1)
            fig4.add_trace(go.Scatter(x=df.index, y=df["Premium_Discount"]*100, name="Premium %", fill="tozeroy", line=dict(color="#2f6b4b", width=1.5)), row=2, col=1)
            fig4.update_layout(height=650, hovermode="x unified", font=dict(family="Lora, serif"),
                plot_bgcolor="rgba(0,0,0,0)", paper_bgcolor="rgba(0,0,0,0)",
                legend=dict(orientation="h", yanchor="bottom", y=1.02, xanchor="right", x=1))
            fig4.update_yaxes(showgrid=True, gridcolor="rgba(128,128,128,0.1)", row=1, col=1)
            fig4.update_yaxes(showgrid=True, gridcolor="rgba(128,128,128,0.1)", ticksuffix="%", row=2, col=1)
            st.plotly_chart(fig4, use_container_width=True)

# ══════════════════════════════════════════════════════════════════════════════
# TAB 5 — PORTFOLIO BACKTESTER (with extended metrics)
# ══════════════════════════════════════════════════════════════════════════════
def render_portfolio():
    st.header("Custom Portfolio vs. Benchmark Backtester")

    with st.container(border=True):
        st.markdown("##### Portfolio Allocation")

        # Number of assets
        n_bt = st.slider("Number of assets", 1, 10,
                         value=st.session_state.get("bt_n_assets", 4), key="bt_n_assets")

        bt_defaults = [
            ("MSFT", 40.0), ("AAPL", 30.0), ("GOOGL", 20.0), ("AMZN", 10.0),
            ("NVDA", 0.0), ("META", 0.0), ("TSLA", 0.0), ("BRK-B", 0.0),
            ("JPM", 0.0), ("V", 0.0),
        ]

        # Header
        bh1, bh2 = st.columns([3, 1])
        bh1.markdown("<small style='color:#5e768f'>TICKER</small>", unsafe_allow_html=True)
        bh2.markdown("<small style='color:#5e768f'>WEIGHT %</small>", unsafe_allow_html=True)

        bt_tickers_input = []
        bt_weights_input = []
        for i in range(n_bt):
            def_tk, def_wt = bt_defaults[i] if i < len(bt_defaults) else ("", 0.0)
            b1, b2 = st.columns([3, 1])
            tk = b1.text_input("", value=st.session_state.get(f"bt_tk_{i}", def_tk),
                               key=f"bt_tk_{i}", label_visibility="collapsed",
                               placeholder=f"Ticker {i+1}")
            wt = b2.number_input("", value=st.session_state.get(f"bt_wt_{i}", def_wt),
                                 min_value=0.0, max_value=100.0, step=1.0,
                                 key=f"bt_wt_{i}", label_visibility="collapsed")
            bt_tickers_input.append(tk.strip().upper())
            bt_weights_input.append(wt)

        st.markdown("---")
        bc1, bc2, bc3 = st.columns(3)
        final_bench = bc1.text_input("Benchmark Ticker", value="SPY", key="bench_sel").strip().upper()
        start_date  = bc2.date_input("Start Date", value=pd.to_datetime("2020-01-01"), key="backtester_start")
        end_date    = bc3.date_input("End Date",   value=pd.to_datetime("today"),      key="backtester_end")

        st.markdown("---")
        bt_strategy, bt_params = _strategy_selector("bt")
        st.markdown("")
        run_backtest = st.button("Run Portfolio Engine", use_container_width=True)

    if run_backtest:
        with st.spinner("Synchronizing market data arrays..."):
            valid_pairs  = [(t, w) for t, w in zip(bt_tickers_input, bt_weights_input)
                            if t and w > 0]
            if not valid_pairs:
                st.error("Add at least one asset with a non-zero weight.")
                st.stop()
            port_tickers = [p[0] for p in valid_pairs]
            raw_weights  = np.array([p[1] for p in valid_pairs])

            weights = raw_weights / raw_weights.sum()
            if abs(raw_weights.sum() - 100.0) > 0.01:
                st.info(f"Weights summed to {raw_weights.sum():.1f}%. Rebalanced to 100% proportionally.")

            unique_tickers = list(dict.fromkeys(port_tickers + [final_bench]))
            try:
                raw_dl = yf.download(unique_tickers, start=str(start_date),
                                     end=str(end_date), auto_adjust=True, progress=False)["Close"]
                if isinstance(raw_dl, pd.Series):
                    raw_dl = raw_dl.to_frame(unique_tickers[0])
                raw_dl.index = raw_dl.index.tz_convert(None) if raw_dl.index.tz is not None else raw_dl.index
                series_dict = {t: raw_dl[t].dropna() for t in unique_tickers if t in raw_dl.columns}
            except Exception:
                series_dict = {}
                for t in unique_tickers:
                    s = get_yf_backtest_series(t, start_date, end_date)
                    if not s.empty:
                        series_dict[t] = s

            missing = set(unique_tickers) - set(series_dict.keys())
            if missing:
                st.warning(f" Could not pull data for: {', '.join(missing)}")

            valid_port = [t for t in port_tickers if t in series_dict]
            if not valid_port or final_bench not in series_dict:
                st.error("Critical error mapping historical series.")
                st.stop()

            if len(valid_port) != len(port_tickers):
                valid_w = np.array([clean_df.loc[clean_df["Ticker"].str.upper()==t,"Weight (%)"].values[0] for t in valid_port])
                weights = valid_w / valid_w.sum()

            raw_data = pd.DataFrame(series_dict).dropna()
            if raw_data.empty:
                st.error("No overlapping trading dates found.")
                st.stop()

            daily_returns = raw_data.pct_change().dropna()
            port_returns  = (daily_returns[valid_port] * weights).sum(axis=1)
            bench_returns = daily_returns[final_bench]

            cum_port  = (1 + port_returns).cumprod() * 100
            cum_bench = (1 + bench_returns).cumprod() * 100

            # ── Strategy overlay ─────────────────────────────────────────────
            bt_strat = bt_strategy  # already read from widget above
            strat_returns = None
            strat_label   = ""
            strat_detail  = ""
            if bt_strat != STRATEGIES[0] and valid_port:
                primary_tk = valid_port[0]
                with st.spinner(f"Computing {bt_strat} signal for {primary_tk}..."):
                    _, sig_series, strat_label, strat_detail = compute_strategy_data(
                        primary_tk, bt_strat, start_date, end_date, params=bt_params)
                rf_daily = get_live_risk_free_rate() / 252
                if not sig_series.empty:
                    sig_aligned = sig_series.reindex(port_returns.index, method="ffill").fillna(1.0)
                    strat_returns = sig_aligned * port_returns + (1 - sig_aligned) * rf_daily
                    cum_strat = (1 + strat_returns).cumprod() * 100

            days   = (cum_port.index[-1] - cum_port.index[0]).days
            years  = max(days / 365.25, 1.0)

            port_cagr    = (cum_port.iloc[-1]/100)**(1/years) - 1
            bench_cagr   = (cum_bench.iloc[-1]/100)**(1/years) - 1
            port_vol     = port_returns.std() * np.sqrt(252)
            bench_vol    = bench_returns.std() * np.sqrt(252)
            port_sharpe  = port_cagr / port_vol if port_vol else 0
            bench_sharpe = bench_cagr / bench_vol if bench_vol else 0

            # Extended metrics
            rf = get_live_risk_free_rate()
            downside_returns = port_returns[port_returns < 0]
            downside_vol     = downside_returns.std() * np.sqrt(252) if len(downside_returns) > 0 else port_vol
            sortino          = (port_cagr - rf) / downside_vol if downside_vol else 0

            wealth_idx    = cum_port / 100
            max_dd_series = (wealth_idx - wealth_idx.cummax()) / wealth_idx.cummax()
            max_dd        = max_dd_series.min()
            calmar        = port_cagr / abs(max_dd) if max_dd != 0 else 0

            cov_with_bench = np.cov(port_returns.values, bench_returns.values)
            beta           = cov_with_bench[0,1] / cov_with_bench[1,1] if cov_with_bench[1,1] != 0 else 1.0
            rolling_beta   = port_returns.rolling(60).cov(bench_returns) / bench_returns.rolling(60).var()

        # Strategy signal banner
        if strat_returns is not None and strat_label:
            st.markdown(
                f"<div style='padding:10px 14px;border-left:3px solid #2f6b4b;"
                f"background:rgba(255,255,255,0.04);border-radius:4px;margin-bottom:10px'>"
                f"<b style='color:#4caf7d'>{bt_strat} — {strat_label}</b><br>"
                f"<span style='color:#8a9ab0;font-size:0.87rem'>{strat_detail}</span></div>",
                unsafe_allow_html=True)

        with st.container(border=True):
            st.markdown(f"### Portfolio vs. {final_bench}")
            st.divider()
            m1, m2, m3, m4 = st.columns(4)
            m1.metric("Portfolio CAGR",   f"{port_cagr*100:.2f}%", f"{(port_cagr-bench_cagr)*100:+.2f}% vs {final_bench}")
            m2.metric("Benchmark CAGR",   f"{bench_cagr*100:.2f}%")
            m3.metric("Portfolio Sharpe", f"{port_sharpe:.2f}", f"{(port_sharpe-bench_sharpe):+.2f}")
            m4.metric("Ann. Volatility",  f"{port_vol*100:.2f}%")

        if strat_returns is not None:
            strat_cagr   = (cum_strat.iloc[-1]/100)**(1/years) - 1
            strat_vol    = strat_returns.std() * np.sqrt(252)
            strat_sharpe = (strat_cagr - get_live_risk_free_rate()) / strat_vol if strat_vol else 0
            strat_w      = (1 + strat_returns).cumprod()
            strat_dd     = ((strat_w - strat_w.cummax()) / strat_w.cummax()).min()
            with st.container(border=True):
                st.markdown(f"##### Strategy: {bt_strat}")
                st.divider()
                s1, s2, s3, s4 = st.columns(4)
                s1.metric("Strategy CAGR",   f"{strat_cagr*100:.2f}%",
                           f"{(strat_cagr-port_cagr)*100:+.2f}% vs portfolio",
                           help="CAGR of the strategy-filtered portfolio (invested when signal is bullish, cash otherwise)")
                s2.metric("Strategy Sharpe", f"{strat_sharpe:.2f}",
                           f"{strat_sharpe-port_sharpe:+.2f} vs portfolio")
                s3.metric("Strategy Vol",    f"{strat_vol*100:.2f}%",
                           help="Lower than buy-and-hold if strategy avoids bearish periods")
                s4.metric("Strategy Max DD",  f"{strat_dd*100:.2f}%",
                           help="Worst peak-to-trough drawdown under the strategy filter")

        with st.container(border=True):
            st.markdown("##### Extended Risk Metrics")
            st.divider()
            e1, e2, e3, e4 = st.columns(4)
            e1.metric("Sortino Ratio", f"{sortino:.2f}", help="Return / downside deviation")
            e2.metric("Max Drawdown",  f"{max_dd*100:.2f}%")
            e3.metric("Calmar Ratio",  f"{calmar:.2f}", help="CAGR / Max Drawdown")
            e4.metric("Beta",          f"{beta:.2f}", help="vs benchmark")

        st.markdown("<br>", unsafe_allow_html=True)

        export_df = pd.DataFrame({
            "Custom Portfolio %": cum_port, f"Benchmark ({final_bench}) %": cum_bench,
            "Portfolio Daily Return": port_returns, "Benchmark Daily Return": bench_returns
        })
        _, exp_col2 = st.columns([4, 1])
        with exp_col2:
            st.download_button(" Export CSV", data=convert_df_to_csv(export_df),
                file_name="portfolio_backtest_vectors.csv", mime="text/csv", use_container_width=True)

        n_rows = 4 if strat_returns is not None else 3
        subplot_titles = ["Cumulative Return", "Daily Portfolio Returns", "Rolling 60D Beta vs Benchmark"]
        row_heights    = [0.45, 0.2, 0.2]
        if strat_returns is not None:
            subplot_titles.append("Strategy In-Market Signal (1=Invested, 0=Cash)")
            row_heights.append(0.15)

        fig1 = make_subplots(rows=n_rows, cols=1, shared_xaxes=True,
            subplot_titles=subplot_titles,
            vertical_spacing=0.06, row_heights=row_heights)
        fig1.add_trace(go.Scatter(x=cum_port.index, y=cum_port, name="Portfolio", line=dict(color="#1f5673", width=2.5)), row=1, col=1)
        fig1.add_trace(go.Scatter(x=cum_bench.index, y=cum_bench, name=f"{final_bench}", line=dict(color="#d97736", width=2, dash="dot")), row=1, col=1)
        if strat_returns is not None:
            fig1.add_trace(go.Scatter(x=cum_strat.index, y=cum_strat,
                name=f"Strategy ({bt_strat[:20]})",
                line=dict(color="#4caf7d", width=2, dash="dashdot")), row=1, col=1)
        fig1.add_trace(go.Bar(x=port_returns.index, y=port_returns*100, name="Daily Return %", marker=dict(color="#6c757d")), row=2, col=1)
        fig1.add_trace(go.Scatter(x=rolling_beta.index, y=rolling_beta, name="Rolling Beta", line=dict(color="#2f6b4b", width=1.5)), row=3, col=1)
        fig1.add_hline(y=1.0, line_dash="dash", line_color="rgba(128,128,128,0.4)", row=3, col=1)
        if strat_returns is not None:
            sig_plot = sig_aligned.reindex(port_returns.index, method="ffill").fillna(1.0)
            fig1.add_trace(go.Scatter(x=sig_plot.index, y=sig_plot,
                fill="tozeroy", fillcolor="rgba(76,175,125,0.18)",
                line=dict(color="rgba(76,175,125,0.6)", width=1),
                name="In-Market Signal", showlegend=False), row=4, col=1)
        fig1.update_layout(height=950 if strat_returns is not None else 800, hovermode="x unified", font=dict(family="Lora, serif"),
            plot_bgcolor="rgba(0,0,0,0)", paper_bgcolor="rgba(0,0,0,0)",
            legend=dict(orientation="h", yanchor="bottom", y=1.02, xanchor="right", x=1))
        fig1.update_yaxes(showgrid=True, gridcolor="rgba(128,128,128,0.1)")
        fig1.update_yaxes(ticksuffix="%", row=2, col=1)
        st.plotly_chart(fig1, use_container_width=True)

# ══════════════════════════════════════════════════════════════════════════════
# TAB 6 — OPTIONS IMPLIED PROBABILITY
# ══════════════════════════════════════════════════════════════════════════════
def render_prob():
    st.header("Options Implied Probability")

    with st.container(border=True):
        st.markdown("##### Distribution Parameters")
        col1, col2, col3 = st.columns([1,1,1])
        final_prob_ticker = col1.text_input("Target Ticker", value="SPY", key="prob_ticker_sel").strip().upper()

        with st.spinner("Fetching spot price..."):
            hist_prices = get_yf_market_data(final_prob_ticker)

        if not hist_prices.empty:
            current_spot  = float(hist_prices["close"].iloc[-1])
            default_target = float(round(current_spot / 5.0) * 5.0)
        else:
            current_spot  = 400.0
            default_target = 400.0

        target_expiry = col2.date_input(
            "Target Expiry Date",
            value=pd.Timestamp.now() + pd.Timedelta(days=30),
            min_value=datetime.date.today() + datetime.timedelta(days=1),
            max_value=datetime.date.today() + datetime.timedelta(days=1825))
        target_px     = col3.number_input("Custom Target Price ($)", value=default_target, step=5.0)
        run_prob      = st.button("Generate Probability Cone", use_container_width=True)

    if run_prob:
        with st.spinner("Executing Black-Scholes risk-neutral matrix models..."):
            hist  = get_yf_market_data(final_prob_ticker)
            if hist.empty:
                st.error("Could not retrieve data for the targeted symbol.")
                st.stop()

            S0    = float(hist['close'].iloc[-1])
            r     = get_live_risk_free_rate()
            sigma = get_yf_implied_vol(final_prob_ticker)

            last_date    = hist.index[-1].tz_convert(None) if hist.index[-1].tzinfo else hist.index[-1]
            expiry_date  = pd.to_datetime(target_expiry)
            T            = max((expiry_date - last_date).days / 365.25, 0.001)
            future_dates = pd.date_range(start=last_date, end=expiry_date, periods=100)
            t_steps      = np.linspace(0, T, 100)

            median_path  = S0 * np.exp((r - 0.5*sigma**2) * t_steps)
            upper_bound  = S0 * np.exp((r - 0.5*sigma**2) * t_steps + 1.04*sigma*np.sqrt(t_steps))
            lower_bound  = np.maximum(S0 * np.exp((r - 0.5*sigma**2) * t_steps - 1.04*sigma*np.sqrt(t_steps)), 0)
            mean_path    = S0 * np.exp(r * t_steps)

            mu_log       = (r - 0.5*sigma**2) * T
            std_dev      = sigma * np.sqrt(T)
            prob_above   = 1 - norm.cdf(np.log(target_px / S0), loc=mu_log, scale=std_dev)

        m1, m2, m3, m4 = st.columns(4)
        m1.metric("Current Spot",            f"${S0:.2f}")
        m2.metric("ATM Implied Vol",          f"{sigma*100:.1f}%")
        m3.metric(f"Prob. Above ${target_px:.0f}", f"{prob_above*100:.1f}%")
        m4.metric("Risk Free Rate",           f"{r*100:.2f}%")

        st.caption("**Methodology Note:** Black-Scholes risk-neutral pricing. Reflects market hedging cost, not a directional forecast.")
        st.divider()

        # ── Volatility Cone ───────────────────────────────────────────────────
        try:
            _t_safe     = np.maximum(t_steps, 1e-10)
            _prob_tgt_t = np.where(
                t_steps > 0,
                1 - norm.cdf((np.log(target_px / S0) - (r - 0.5*sigma**2)*t_steps) / (sigma*np.sqrt(_t_safe))),
                1.0 if target_px <= S0 else 0.0)

            fig6 = go.Figure()
            fig6.add_trace(go.Scatter(x=list(future_dates)+list(future_dates)[::-1], y=list(upper_bound)+[S0]*100,
                fill='toself', fillcolor="rgba(47,107,75,0.15)", line=dict(width=0), showlegend=False, hoverinfo="skip"))
            fig6.add_trace(go.Scatter(x=list(future_dates)+list(future_dates)[::-1], y=list(lower_bound)+[S0]*100,
                fill='toself', fillcolor="rgba(140,46,54,0.15)", line=dict(width=0), showlegend=False, hoverinfo="skip"))
            fig6.add_trace(go.Scatter(
                x=future_dates, y=upper_bound, name="Upper Bound (~85th pct)",
                line=dict(color="#2f6b4b", width=1.5),
                customdata=_prob_tgt_t,
                hovertemplate=(
                    f"<b>Upper Bound</b>  $%{{y:,.2f}}<span style='color:#5e768f'>  ·  ~85th pct</span><br>"
                    f"<span style='color:#a0b0c0'>P(Above ${target_px:.0f})</span>  <b>%{{customdata:.1%}}</b>"
                    "<extra></extra>")))
            fig6.add_trace(go.Scatter(
                x=future_dates, y=mean_path, name="Mean",
                line=dict(color="#1f5673", width=2, dash="dot"),
                hovertemplate="<b>Mean Path</b>  $%{y:,.2f}<span style='color:#5e768f'>  ·  Expected path</span><extra></extra>"))
            fig6.add_trace(go.Scatter(
                x=future_dates, y=median_path, name="Median",
                line=dict(color="#9aa8b8", width=2, dash="dash"),
                hovertemplate="<b>Median</b>  $%{y:,.2f}<span style='color:#5e768f'>  ·  50th pct</span><extra></extra>"))
            fig6.add_trace(go.Scatter(
                x=future_dates, y=lower_bound, name="Lower Bound (~15th pct)",
                line=dict(color="#8c2e36", width=1.5),
                hovertemplate="<b>Lower Bound</b>  $%{y:,.2f}<span style='color:#5e768f'>  ·  ~15th pct</span><extra></extra>"))
            fig6.add_hline(y=target_px, line_dash="dot", line_color="#d97736",
                annotation_text=f"Target ${target_px:.0f}")
            cone_min, cone_max = max(0, float(lower_bound[-1])), float(upper_bound[-1])
            buffer = (cone_max - cone_min) * 0.10
            fig6.update_layout(
                title=f"Volatility Cone — {final_prob_ticker}", height=700, hovermode="x unified",
                hoverlabel=dict(bgcolor="#0f1d31", bordercolor="rgba(201,168,76,0.5)",
                    font=dict(family="Lora, serif", size=13, color="#dce3ed"), align="left", namelength=0),
                legend=dict(orientation="h", yanchor="bottom", y=1.02, xanchor="center", x=0.5),
                xaxis=dict(showgrid=True, gridcolor="rgba(128,128,128,0.1)"),
                yaxis=dict(range=[max(0, cone_min-buffer), cone_max+buffer], showgrid=True, gridcolor="rgba(128,128,128,0.1)"),
                plot_bgcolor="rgba(0,0,0,0)", paper_bgcolor="rgba(0,0,0,0)")
            st.plotly_chart(fig6, use_container_width=True)
        except Exception as _cone_err:
            st.warning(f" Volatility Cone unavailable: {_cone_err}")

        # ── Shared options chain fetch (used by both charts below) ────────────
        st.markdown("<br>", unsafe_allow_html=True)
        _tkr = _expirations = _nearest = _calls = _puts = None
        with st.spinner(f"Fetching options chain for {final_prob_ticker}..."):
            try:
                _tkr         = yf.Ticker(final_prob_ticker)
                _expirations = _tkr.options or []
                if _expirations:
                    _expiry_ts = pd.to_datetime(target_expiry)
                    _nearest   = min(_expirations, key=lambda d: abs((pd.to_datetime(d) - _expiry_ts).days))
                    _chain     = _tkr.option_chain(_nearest)
                    _calls     = (_chain.calls[["strike", "impliedVolatility"]]
                                  .dropna().sort_values("strike").reset_index(drop=True))
                    _puts      = _chain.puts[["strike", "impliedVolatility"]].dropna()

                    def _bs_call_delta(K, iv):
                        if iv <= 0 or T <= 0 or K <= 0:
                            return np.nan
                        d1 = (np.log(S0 / K) + (r + 0.5 * iv**2) * T) / (iv * np.sqrt(T))
                        return norm.cdf(d1)

                    _calls["delta"] = _calls.apply(
                        lambda row: _bs_call_delta(row["strike"], row["impliedVolatility"]), axis=1)
                    _calls = _calls.dropna(subset=["delta"])
                    _calls = _calls[(_calls["impliedVolatility"] > 0.02) & (_calls["impliedVolatility"] < 3.0)]
                    _calls = _calls[(_calls["delta"] >= 0.01) & (_calls["delta"] <= 0.99)]
            except Exception as _fetch_err:
                st.warning(f" Options chain unavailable for {final_prob_ticker}: {_fetch_err}")

        # ── Market-Implied Probability Distribution ───────────────────────────
        st.markdown("### Market-Implied Probability Distribution")
        st.caption("Derived from live options chain. Call delta ≈ risk-neutral P(S_T > K). Density bars show where the market concentrates probability mass.")

        if _calls is None or len(_calls) < 4:
            st.info(" Density chart unavailable — no options data or insufficient strikes for the selected expiry.")
        else:
            try:
                _strikes = _calls["strike"].values
                _n_str   = len(_strikes)

                # Adaptive smoothing: wider window for densely-spaced strikes (e.g. SPY $1 apart)
                _delta_win = max(5, _n_str // 15)
                _deltas = (pd.Series(_calls["delta"].values)
                           .rolling(_delta_win, center=True, min_periods=1).mean()
                           .values.clip(0, 1))
                # Enforce monotone decreasing (call delta must decrease as strike increases)
                _deltas = np.minimum.accumulate(_deltas)

                _dens_raw  = np.abs(np.diff(_deltas))
                _dens_mid  = (_strikes[:-1] + _strikes[1:]) / 2
                _density   = _dens_raw / _dens_raw.sum() if _dens_raw.sum() > 0 else _dens_raw
                _modal_str = _dens_mid[int(np.argmax(_density))]

                _d_rev = _deltas[::-1]
                _k_rev = _strikes[::-1]
                _p10   = float(np.interp(0.10, _d_rev, _k_rev))
                _p50   = float(np.interp(0.50, _d_rev, _k_rev))
                _p90   = float(np.interp(0.90, _d_rev, _k_rev))

                _avg_call_iv = float(_calls["impliedVolatility"].mean())
                _avg_put_iv  = float(_puts["impliedVolatility"].mean()) if _puts is not None and not _puts.empty else _avg_call_iv
                _iv_skew     = _avg_put_iv - _avg_call_iv

                _mc1, _mc2, _mc3, _mc4, _mc5 = st.columns(5)
                _mc1.metric("Modal Strike",  f"${_modal_str:,.0f}", help="Strike bucket with highest probability mass")
                _mc2.metric("P10 Strike",    f"${_p10:,.0f}",       help="Market implies 10% chance of finishing above")
                _mc3.metric("P50 Strike",    f"${_p50:,.0f}",       help="Market implies 50% chance of finishing above")
                _mc4.metric("P90 Strike",    f"${_p90:,.0f}",       help="Market implies 90% chance of finishing above")
                _mc5.metric("IV Skew (P−C)", f"{_iv_skew*100:+.1f}%", help="Avg put IV minus avg call IV — positive = put skew")
                st.caption(f"Expiry matched to: **{_nearest}** | {len(_calls)} call strikes loaded")

                # Step 1: compute density over the FULL strike range (no clipping yet)
                _pdf_raw    = -np.diff(_deltas) / np.diff(_strikes)
                _pdf_str_f  = (_strikes[:-1] + _strikes[1:]) / 2
                _pdf_win    = max(7, _n_str // 12)
                _pdf_s_f    = np.clip(
                    pd.Series(_pdf_raw).rolling(_pdf_win, center=True, min_periods=1).mean().values,
                    0, None)
                _dx_f       = np.diff(_pdf_str_f).mean() if len(_pdf_str_f) > 1 else 1
                _pdf_n_f    = _pdf_s_f / ((_pdf_s_f * _dx_f).sum() or 1)

                # Step 2: find y-range from where density ≥ 1% of peak value
                # This guarantees the curve tapers naturally inside the chart.
                _pk = _pdf_n_f.max()
                if _pk > 0:
                    _sig  = _pdf_n_f >= _pk * 0.01
                    _lo_i = int(np.argmax(_sig))
                    _hi_i = int(len(_sig) - 1 - np.argmax(_sig[::-1]))
                    _lo_s = float(_pdf_str_f[_lo_i])
                    _hi_s = float(_pdf_str_f[_hi_i])
                else:
                    _lo_s, _hi_s = float(_pdf_str_f[0]), float(_pdf_str_f[-1])
                _rng   = max(_hi_s - _lo_s, 1.0)
                _y_min = max(1.0, _lo_s - _rng * 0.15)
                _y_max = _hi_s + _rng * 0.15

                # Step 3: clip display data to y-range
                _vis         = (_pdf_str_f >= _y_min) & (_pdf_str_f <= _y_max)
                _pdf_strikes = _pdf_str_f[_vis]
                _pdf_norm    = _pdf_n_f[_vis]

                # BS lognormal over the visible y range
                _k_range    = np.linspace(_y_min, _y_max, 400)
                _mu_ln      = (r - 0.5 * sigma**2) * T
                _std_ln     = sigma * np.sqrt(T)
                _ln_pdf     = ((1 / (_k_range * _std_ln * np.sqrt(2 * np.pi)))
                               * np.exp(-0.5 * ((np.log(np.maximum(_k_range, 1e-9) / S0) - _mu_ln) / _std_ln) ** 2))
                _prob_above_mid = np.interp(_pdf_strikes, _strikes, _deltas)

                # P10 label = strike where 10% chance of finishing above (high strike)
                # P90 label = strike where 90% chance of finishing above (low strike)
                # Band spans low→high, so mask needs _p90 (low) to _p10 (high)
                _band_lo   = min(_p10, _p90)
                _band_hi   = max(_p10, _p90)
                _band_mask = (_pdf_strikes >= _band_lo) & (_pdf_strikes <= _band_hi)
                _band_ys   = _pdf_strikes[_band_mask]
                _band_xs   = _pdf_norm[_band_mask]

                _fig_dist = go.Figure()
                # Full curve fill — explicit closed polygon (bottom→top along curve, top→bottom along x=0)
                _fig_dist.add_trace(go.Scatter(
                    x=np.concatenate([_pdf_norm, np.zeros(len(_pdf_norm))]),
                    y=np.concatenate([_pdf_strikes, _pdf_strikes[::-1]]),
                    fill="toself", fillcolor="rgba(31,86,115,0.20)",
                    line=dict(width=0), showlegend=False, hoverinfo="skip"))
                # P10–P90 band overlay (darker shade), same closed-polygon approach
                if len(_band_ys) > 1:
                    _fig_dist.add_trace(go.Scatter(
                        x=np.concatenate([_band_xs, np.zeros(len(_band_xs))]),
                        y=np.concatenate([_band_ys, _band_ys[::-1]]),
                        fill="toself", fillcolor="rgba(31,86,115,0.28)",
                        line=dict(width=0), showlegend=False, hoverinfo="skip"))
                _fig_dist.add_trace(go.Scatter(
                    x=_ln_pdf, y=_k_range,
                    name="BS Lognormal (model)",
                    line=dict(color="#8c2e36", width=2, dash="dash"),
                    hoverinfo="skip"))
                _fig_dist.add_trace(go.Scatter(
                    x=_pdf_norm, y=_pdf_strikes,
                    fill=None,
                    name="Market-Implied Density",
                    line=dict(color="#4a9abe", width=2.5),
                    customdata=_prob_above_mid,
                    hovertemplate=(
                        "<b>  Strike   $%{y:,.0f}  </b><br>"
                        "<span style='color:#a0b0c0'>P(Finish Above)  </span>  <b>%{customdata:.1%}</b><br>"
                        "<span style='color:#a0b0c0'>Market Density   </span>  %{x:.4%}"
                        "<extra></extra>")))
                if _y_min <= S0 <= _y_max:
                    _fig_dist.add_hline(y=S0, line_dash="dash", line_color="rgba(128,128,128,0.5)")
                    _fig_dist.add_annotation(y=S0, x=0.98, xref="paper",
                        text="Spot", showarrow=False,
                        font=dict(color="rgba(190,190,190,0.9)", size=11),
                        yanchor="bottom", xanchor="right",
                        bgcolor="rgba(10,22,40,0.75)", borderpad=3)
                if _y_min <= target_px <= _y_max:
                    _fig_dist.add_hline(y=target_px, line_dash="dot", line_color="#d97736")
                    _fig_dist.add_annotation(y=target_px, x=0.98, xref="paper",
                        text=f"Target ${target_px:.0f}", showarrow=False,
                        font=dict(color="#d97736", size=11),
                        yanchor="bottom", xanchor="right",
                        bgcolor="rgba(10,22,40,0.75)", borderpad=3)

                # Right-axis percentage ticks — only those within visible range
                _prob_ticks   = [0.90, 0.80, 0.70, 0.60, 0.50, 0.40, 0.30, 0.20, 0.10]
                _strike_ticks = np.interp(_prob_ticks, _deltas[::-1], _strikes[::-1])
                _vis_pairs    = [(p, float(sv)) for p, sv in zip(_prob_ticks, _strike_ticks)
                                 if _y_min <= float(sv) <= _y_max]
                _tv = [sv for _, sv in _vis_pairs]
                _tt = [f"{int(p*100)}%" for p, _ in _vis_pairs]

                # Activate yaxis2 with real boundary coordinates
                _fig_dist.add_trace(go.Scatter(
                    x=[0, 0], y=[_y_min, _y_max], yaxis="y2",
                    mode="markers", marker=dict(size=0.001, opacity=0),
                    showlegend=False, hoverinfo="skip"))

                _fig_dist.update_layout(
                    title=f"Market-Implied Probability Density — {final_prob_ticker} (Expiry: {_nearest})",
                    height=700, hovermode="y unified",
                    hoverlabel=dict(bgcolor="#0f1d31", bordercolor="rgba(201,168,76,0.5)",
                        font=dict(family="Lora, serif", size=13, color="#dce3ed"),
                        align="left", namelength=0),
                    font=dict(family="Lora, serif"),
                    xaxis=dict(title="Probability Density",
                               showgrid=True, gridcolor="rgba(128,128,128,0.1)"),
                    yaxis=dict(title="Strike Price ($)", tickprefix="$", tickformat=",.0f",
                               range=[_y_min, _y_max], autorange=False,
                               showgrid=True, gridcolor="rgba(128,128,128,0.1)"),
                    yaxis2=dict(overlaying="y", side="right",
                        range=[_y_min, _y_max], autorange=False,
                        tickvals=_tv, ticktext=_tt,
                        showgrid=False, title="",
                        tickfont=dict(color="#5e768f", size=11, family="Lora, serif")),
                    margin=dict(r=60, t=60, b=50, l=70),
                    plot_bgcolor="rgba(0,0,0,0)", paper_bgcolor="rgba(0,0,0,0)",
                    legend=dict(orientation="h", yanchor="bottom", y=1.02, xanchor="right", x=1))
                st.plotly_chart(_fig_dist, use_container_width=True)
            except Exception as _dist_err:
                st.warning(f" Density chart unavailable: {_dist_err}")

        # ── Market-Implied Forward Price Curve ────────────────────────────────
        st.markdown("<br>", unsafe_allow_html=True)
        st.markdown("### Market-Implied Forward Price Curve")
        st.caption("P10 / P50 / P90 strikes from live options chains across all available expiries — the market's implied price trajectory.")

        if _tkr is None or not _expirations:
            st.info(" Forward curve unavailable — no options data for this ticker.")
        else:
            try:
                with st.spinner("Building forward curve across expiries..."):
                    _today_date = pd.Timestamp(datetime.date.today())
                    _fwd_dates  = [_today_date]
                    _fwd_p10    = [S0]
                    _fwd_p50    = [S0]
                    _fwd_p90    = [S0]
                    _today_ts   = _today_date
                    _target_dt  = pd.to_datetime(target_expiry)

                    # Use ALL available expiries (not limited to target_expiry) so
                    # the forward curve shows the full market-implied trajectory.
                    # Sample intelligently: near-term every expiry, then monthly,
                    # then quarterly. Cap at 30 chains total.
                    _now_clean   = _today_date
                    _sampled, _last_included = [], None
                    for _e in _expirations:
                        _e_dt = pd.to_datetime(_e)
                        _days_out = (_e_dt - _now_clean).days
                        if _days_out <= 0:        # skip today/past expiries
                            continue
                        if _last_included is None:
                            _sampled.append(_e)
                        elif _days_out <= 90:          # near-term: every expiry
                            _sampled.append(_e)
                        elif _days_out <= 365:         # mid-term: ~monthly gap
                            if (_e_dt - pd.to_datetime(_last_included)).days >= 25:
                                _sampled.append(_e)
                        else:                          # long-term: ~quarterly gap
                            if (_e_dt - pd.to_datetime(_last_included)).days >= 80:
                                _sampled.append(_e)
                        if _sampled and _sampled[-1] == _e:
                            _last_included = _e
                        if len(_sampled) >= 30:
                            break
                    _exp_filtered = _sampled

                    for _exp in _exp_filtered:
                        try:
                            _exp_dt = pd.to_datetime(_exp)
                            if (_exp_dt - _now_clean).days <= 0:
                                continue
                            _T_exp  = max((_exp_dt - _now_clean).days / 365.25, 0.001)
                            _ec     = (_tkr.option_chain(_exp).calls[["strike", "impliedVolatility"]]
                                       .dropna().sort_values("strike").reset_index(drop=True))
                            _ec     = _ec[(_ec["impliedVolatility"] > 0.02) & (_ec["impliedVolatility"] < 3.0)]

                            def _fwd_delta(K, iv):
                                if iv <= 0 or K <= 0:
                                    return np.nan
                                d1 = (np.log(S0 / K) + (r + 0.5*iv**2)*_T_exp) / (iv*np.sqrt(_T_exp))
                                return norm.cdf(d1)

                            _ec["delta"] = _ec.apply(
                                lambda row: _fwd_delta(row["strike"], row["impliedVolatility"]), axis=1)
                            _ec = _ec.dropna(subset=["delta"])
                            _ec = _ec[(_ec["delta"] >= 0.01) & (_ec["delta"] <= 0.99)]

                            if len(_ec) < 4:
                                continue

                            _dr = _ec["delta"].values[::-1]
                            _kr = _ec["strike"].values[::-1]
                            _fwd_dates.append(_exp_dt)
                            _fwd_p10.append(float(np.interp(0.10, _dr, _kr)))
                            _fwd_p50.append(float(np.interp(0.50, _dr, _kr)))
                            _fwd_p90.append(float(np.interp(0.90, _dr, _kr)))
                        except Exception:
                            continue

                # Extend to target_expiry with BS model if beyond last options expiry
                _last_chain_dt = _fwd_dates[-1]
                _T_tgt = max((_target_dt - _now_clean).days / 365.25, 0.001)
                if _target_dt > _last_chain_dt:
                    _fwd_dates.append(_target_dt)
                    _fwd_p10.append(float(S0 * np.exp((r - 0.5*sigma**2)*_T_tgt + norm.ppf(0.90)*sigma*np.sqrt(_T_tgt))))
                    _fwd_p50.append(float(S0 * np.exp((r - 0.5*sigma**2)*_T_tgt)))
                    _fwd_p90.append(max(0.0, float(S0 * np.exp((r - 0.5*sigma**2)*_T_tgt + norm.ppf(0.10)*sigma*np.sqrt(_T_tgt)))))

                if len(_fwd_dates) >= 3:
                    # Use ordinal integers for all date arithmetic — zero pandas involvement
                    _t0_ord   = datetime.date.fromtimestamp(
                        pd.Timestamp(_fwd_dates[0]).timestamp()).toordinal()
                    _tgt_ord  = datetime.date.fromtimestamp(
                        pd.Timestamp(_target_dt).timestamp()).toordinal()
                    _fwd_ords = np.array([
                        datetime.date.fromtimestamp(
                            pd.Timestamp(d).timestamp()).toordinal() - _t0_ord
                        for d in _fwd_dates], dtype=float)
                    _n_days   = max(int(_tgt_ord - _t0_ord) + 1, 2)
                    _dense_nums = np.arange(_n_days, dtype=float)
                    _dense_strs = [
                        datetime.date.fromordinal(_t0_ord + i).isoformat()
                        for i in range(_n_days)]
                    _p10_arr  = np.array(_fwd_p10, dtype=float)
                    _p50_arr  = np.array(_fwd_p50, dtype=float)
                    _p90_arr  = np.array(_fwd_p90, dtype=float)
                    _dense_p10 = np.interp(_dense_nums, _fwd_ords, _p10_arr)
                    _dense_p50 = np.interp(_dense_nums, _fwd_ords, _p50_arr)
                    _dense_p90 = np.maximum(np.interp(_dense_nums, _fwd_ords, _p90_arr), 0.0)

                    _x_fill = _dense_strs + list(reversed(_dense_strs))
                    _y_fill = [float(v) for v in _dense_p10] + [float(v) for v in reversed(_dense_p90)]
                    _x_lines = list(_dense_strs)
                    _y10 = [float(v) for v in _dense_p10]
                    _y50 = [float(v) for v in _dense_p50]
                    _y90 = [float(v) for v in _dense_p90]

                    _fig_fwd = go.Figure()
                    _fig_fwd.add_trace(go.Scatter(
                        x=_x_fill, y=_y_fill,
                        fill="toself", fillcolor="rgba(47,107,75,0.13)",
                        line=dict(width=0), showlegend=False, hoverinfo="skip"))
                    _fig_fwd.add_trace(go.Scatter(
                        x=_x_lines, y=_y10, name="P10 — Upper Band",
                        line=dict(color="#2f6b4b", width=1.5),
                        hovertemplate=(
                            "<b>%{x|%b %d, %Y}</b><br>"
                            "<b>Upper Band (P10)</b>  $%{y:,.2f}<br>"
                            "<span style='color:#a0b0c0'>10% chance of finishing above</span>"
                            "<extra></extra>")))
                    _fig_fwd.add_trace(go.Scatter(
                        x=_x_lines, y=_y50, name="P(50)",
                        line=dict(color="#1f5673", width=2.5),
                        hovertemplate=(
                            "<b>%{x|%b %d, %Y}</b><br>"
                            "<b>P(50)</b>  $%{y:,.2f}<br>"
                            "<span style='color:#a0b0c0'>50% chance of finishing above</span>"
                            "<extra></extra>")))
                    _fig_fwd.add_trace(go.Scatter(
                        x=_x_lines, y=_y90, name="P90 — Lower Band",
                        line=dict(color="#8c2e36", width=1.5),
                        hovertemplate=(
                            "<b>%{x|%b %d, %Y}</b><br>"
                            "<b>Lower Band (P90)</b>  $%{y:,.2f}<br>"
                            "<span style='color:#a0b0c0'>90% chance of finishing above</span>"
                            "<extra></extra>")))
                    _fig_fwd.add_hline(y=float(target_px), line_dash="dot",
                        line_color="#d97736", annotation_text=f"Target ${target_px:.0f}")
                    # Mark the user's selected target expiry date
                    _tgt_str_ann = pd.Timestamp(_target_dt).date().isoformat()
                    if _tgt_str_ann in _dense_strs:
                        _fig_fwd.add_vline(x=_tgt_str_ann, line_dash="dash",
                            line_color="rgba(201,168,76,0.5)",
                            annotation_text=f"Expiry {_tgt_str_ann}",
                            annotation_position="top right")
                    _last_ord = datetime.date.fromtimestamp(
                        pd.Timestamp(_last_chain_dt).timestamp()).toordinal()
                    if _tgt_ord > _last_ord:
                        _vline_x = datetime.date.fromordinal(_last_ord).isoformat()
                        # Full-height vertical line using a shape (spans entire y range)
                        _fig_fwd.add_shape(
                            type="line",
                            x0=_vline_x, x1=_vline_x,
                            y0=0, y1=1, yref="paper",
                            line=dict(dash="dot", color="rgba(201,168,76,0.4)", width=1))
                        _fig_fwd.add_annotation(
                            x=_vline_x, y=0.98, yref="paper",
                            text="← Options  |  BS model →",
                            showarrow=False, xanchor="left",
                            font=dict(color="rgba(201,168,76,0.6)", size=10),
                            bgcolor="rgba(10,22,40,0.6)", borderpad=2)
                    _fwd_all  = _y10 + _y90
                    _fwd_buf  = (max(_fwd_all) - min(_fwd_all)) * 0.10
                    _fwd_ymin = max(0.0, min(_fwd_all) - _fwd_buf)
                    _fwd_ymax = max(_fwd_all) + _fwd_buf

                    # Right-side percentage axis: ticks at P10/P50/P90 final values
                    _pct_tickvals = [float(_y90[-1]), float(_y50[-1]), float(_y10[-1])]
                    _pct_ticktext = ["90%", "50%", "10%"]
                    _fig_fwd.add_trace(go.Scatter(
                        x=[_x_lines[0], _x_lines[0]],
                        y=[_fwd_ymin, _fwd_ymax],
                        yaxis="y2", mode="markers",
                        marker=dict(size=0.001, opacity=0, color="rgba(0,0,0,0)"),
                        showlegend=False, hoverinfo="skip"))

                    _fig_fwd.update_layout(
                        title=f"Market-Implied Forward Price Curve — {final_prob_ticker}",
                        height=600, hovermode="x unified",
                        hoverlabel=dict(bgcolor="#0f1d31", bordercolor="rgba(201,168,76,0.5)",
                            font=dict(family="Lora, serif", size=13, color="#dce3ed"),
                            align="left", namelength=0),
                        font=dict(family="Lora, serif"),
                        xaxis=dict(showgrid=True, gridcolor="rgba(128,128,128,0.1)"),
                        yaxis=dict(title="Implied Price ($)", tickprefix="$", tickformat=",.0f",
                            range=[_fwd_ymin, _fwd_ymax],
                            showgrid=True, gridcolor="rgba(128,128,128,0.1)"),
                        yaxis2=dict(
                            overlaying="y", side="right",
                            range=[_fwd_ymin, _fwd_ymax],
                            tickvals=_pct_tickvals,
                            ticktext=_pct_ticktext,
                            showgrid=False, zeroline=False, title="",
                            tickfont=dict(color="#5e768f", size=11, family="Lora, serif")),
                        margin=dict(r=65, t=60, b=50, l=70),
                        plot_bgcolor="rgba(0,0,0,0)", paper_bgcolor="rgba(0,0,0,0)",
                        legend=dict(orientation="h", yanchor="bottom", y=1.02, xanchor="center", x=0.5))
                    st.plotly_chart(_fig_fwd, use_container_width=True)
                else:
                    st.info(" Not enough expiry dates with valid options data to build a forward curve.")
            except Exception as _fwd_err:
                st.warning(f" Forward curve unavailable: {_fwd_err}")

# ══════════════════════════════════════════════════════════════════════════════
# TAB 7 — FED RATE PROJECTIONS
# ══════════════════════════════════════════════════════════════════════════════
def render_fed():
    st.header("Macroeconomic Implied Rate Engine")

    container_metrics = st.container()
    container_probs   = st.container()
    container_slider  = st.container()
    container_fed     = st.container()
    container_yc      = st.container()

    with container_slider:
        st.markdown("<br>", unsafe_allow_html=True)
        st.markdown("##### Global Rate Sensitivity Engine")
        twist_factor = st.slider("Front-End Shift Matrix (bps)", min_value=-200, max_value=200, value=0, step=5, key="fed_twist_slider")
        st.markdown("<br>", unsafe_allow_html=True)

    base_data  = {'June 2026': 3.65, 'July 2026': 3.68, 'Sept 2026': 3.72, 'Nov 2026': 3.75, 'Dec 2026': 3.82, 'Jan 2027': 3.85}
    meetings   = list(base_data.keys())
    base_rates = list(base_data.values())
    fed_weights= [1.0, 0.9, 0.7, 0.5, 0.3, 0.1]
    rates      = [r + (twist_factor/100 * w) for r, w in zip(base_rates, fed_weights)]

    with container_metrics:
        st.markdown("##### Forward Rate Projections Summary")
        m1, m2, m3 = st.columns(3)
        m1.metric("Next Meeting Implied", f"{rates[0]:.2f}%", f"{twist_factor*fed_weights[0]:+.1f} bps")
        m2.metric("Year-End 2026",        f"{rates[4]:.2f}%")
        m3.metric("Total Projected Move", f"{(rates[-1]-rates[0])*100:+.0f} bps")
        st.divider()

    with container_probs:
        st.markdown("##### Next FOMC Meeting Probability Breakdown")
        c1, c2, c3, c4 = st.columns(4)
        c1.metric("Hike +50bps","2%"); c2.metric("Hike +25bps","10%")
        c3.metric("Hold","82%", delta_color="off"); c4.metric("Cut -25bps","6%")
        st.divider()

    with container_fed:
        with st.container(border=True):
            st.markdown("##### Market Implied Fed Funds Path")
            fig1 = go.Figure()
            fig1.add_trace(go.Scatter(x=meetings, y=base_rates, mode='lines', name="Base Path", line=dict(color="#64748B", dash="dot")))
            fig1.add_trace(go.Scatter(x=meetings, y=rates, mode='lines+markers', name="Adjusted Path",
                line=dict(color='#1f5673', width=3.5), marker=dict(size=10, color='#d97736')))
            fig1.update_layout(height=400, hovermode="x unified", font=dict(family="Lora, serif"),
                plot_bgcolor="rgba(0,0,0,0)", paper_bgcolor="rgba(0,0,0,0)",
                yaxis=dict(title="Implied Rate", ticksuffix="%", showgrid=True, gridcolor="rgba(128,128,128,0.1)"),
                legend=dict(orientation="h", yanchor="bottom", y=1.02, xanchor="right", x=1))
            st.plotly_chart(fig1, use_container_width=True)

    with container_yc:
        with st.container(border=True):
            st.markdown("##### US Treasury Yield Curve")
            with st.spinner("Fetching Twelve Data Bond Matrix..."):
                yc_data = get_twelve_batch_yield_curve(TWELVE_API_KEY)
            latest    = yc_data.iloc[0]
            mats      = [1, 2, 5, 10, 20, 30]
            yc_labels = ["1Y","2Y","5Y","10Y","20Y","30Y"]
            rate_cols = st.columns(len(yc_labels))
            for i, label in enumerate(yc_labels):
                rate_cols[i].metric(label=label, value=f"{latest[label]:.2f}%")
            st.markdown("<br>", unsafe_allow_html=True)
            yc_weights  = [.98, 0.85, 0.40, 0.1, -0.19, -0.325]
            adjusted_yc = [max(0.1, latest[lbl] + (twist_factor/100*w)) for lbl, w in zip(yc_labels, yc_weights)]
            current_yc  = [latest[lbl] for lbl in yc_labels]
            all_vals    = current_yc + adjusted_yc
            yc_min      = min(all_vals)
            yc_max      = max(all_vals)
            yc_pad      = max((yc_max - yc_min) * 0.3, 0.1)
            fig2 = go.Figure()
            fig2.add_trace(go.Scatter(x=mats, y=current_yc, mode="lines+markers", name="Current Curve",
                line=dict(color="#64748B", dash="dot"), marker=dict(size=7)))
            fig2.add_trace(go.Scatter(x=mats, y=adjusted_yc, mode="lines+markers", name="Adjusted Structure",
                line=dict(color="#1f5673", width=3.5), marker=dict(size=10, color="#d97736")))
            fig2.update_layout(height=450, hovermode="x unified", font=dict(family="Lora, serif"),
                plot_bgcolor="rgba(0,0,0,0)", paper_bgcolor="rgba(0,0,0,0)",
                xaxis=dict(tickvals=mats, ticktext=yc_labels, showgrid=True, gridcolor="rgba(128,128,128,0.1)"),
                yaxis=dict(range=[yc_min - yc_pad, yc_max + yc_pad], tickformat=".2f", ticksuffix="%",
                           showgrid=True, gridcolor="rgba(128,128,128,0.1)"),
                legend=dict(orientation="h", yanchor="bottom", y=1.02, xanchor="right", x=1))
            st.plotly_chart(fig2, use_container_width=True)

# ══════════════════════════════════════════════════════════════════════════════
# TAB 8 — CORPORATE MONITORING HUB
# ══════════════════════════════════════════════════════════════════════════════
def render_earnings():
    st.markdown("##### Portfolio & Tracking Suite:")
    st.title("Corporate Monitoring Hub")
    st.markdown("---")

    main_layout_left, right_notes_panel = st.columns([3, 1])

    with main_layout_left:
        with st.form(key="corporate_hub_form"):
            st.markdown("##### Public Watchlist Scanner")
            ticker_input_string = st.text_input("Enter Custom Ticker Symbols (Comma Separated)", value="NVDA, AAPL, SLS, MSTR, TOST, VST, OWL, AMZN")
            f1, f2 = st.columns(2)
            sort_by       = f1.selectbox("Sort Table By", ["Ticker","Options Implied Move","Forward PE / Valuation Ratio"])
            fiscal_filter = f2.selectbox("Reporting Window Focus", ["All Horizons","Confirmed Future Releases"])

            # Short interest & insider toggle
            show_short    = st.checkbox("Show Short Interest Data", value=True)
            show_insider  = st.checkbox("Show Insider Transactions", value=False)
            submit        = st.form_submit_button("Execute Watchlist Scan", use_container_width=True)

        active_tickers = [tk.strip().upper() for tk in ticker_input_string.split(",") if tk.strip()]
        parsed_rows = []

        if active_tickers:
            with st.spinner("Compiling structural risk and valuation models..."):
                est_release  = (pd.Timestamp.now() + pd.Timedelta(days=45)).strftime("%B %d, %Y")
                horizon_lbl  = f"Q2 {pd.Timestamp.now().year}"

                for tk in active_tickers:
                    try:
                        spot_df = get_cached_history(tk)
                        if spot_df is not None and not spot_df.empty:
                            close = spot_df['Close'].squeeze()
                            current_spot   = float(close.iloc[-1])
                            log_returns    = np.log(close / close.shift(1))
                            realized_vol   = log_returns.std() * np.sqrt(252)
                            implied_move   = float((realized_vol * np.sqrt(7/365)) * 100)
                            trailing_qtr   = float((close.iloc[-1]/close.iloc[-60]-1)) if len(close)>=60 else 0.05
                            forward_pe     = max(5.0, min(22.4+(trailing_qtr*12) if current_spot>250 else 15.8+(trailing_qtr*8), 140.0))
                            ps_ratio       = max(0.2, min(7.2+(trailing_qtr*3)   if current_spot>250 else 3.1+(trailing_qtr*1.5), 45.0))
                        else:
                            current_spot, implied_move, forward_pe, ps_ratio = 120.0, 4.5, 24.5, 4.2

                        consensus = "Strong Buy" if forward_pe<18 else ("Moderate Buy" if forward_pe<32 else ("Hold" if forward_pe<55 else "Underperform"))
                        parsed_rows.append({"Ticker": tk, "Company": f"{tk} Corporation", "Date": est_release,
                            "Horizon": horizon_lbl, "Implied Move": implied_move, "Valuation Metric": forward_pe,
                            "Consensus Indicator": ps_ratio, "Analyst Consensus": consensus, "Is Confirmed": True})
                    except Exception:
                        parsed_rows.append({"Ticker": tk, "Company": f"{tk} Systems", "Date": "N/A", "Horizon": "N/A",
                            "Implied Move": 0.0, "Valuation Metric": None, "Consensus Indicator": None,
                            "Analyst Consensus": "Hold", "Is Confirmed": False})

            df_earnings = pd.DataFrame(parsed_rows).drop(columns=["Company"])
            if fiscal_filter == "Confirmed Future Releases":
                df_earnings = df_earnings[df_earnings["Is Confirmed"]]
            if sort_by == "Options Implied Move":
                df_earnings = df_earnings.sort_values("Implied Move", ascending=False)
            elif sort_by == "Forward PE / Valuation Ratio":
                df_earnings = df_earnings.sort_values("Valuation Metric", ascending=True, na_position='last')
            else:
                df_earnings = df_earnings.sort_values("Ticker")

            st.dataframe(df_earnings, column_config={
                "Implied Move":        st.column_config.ProgressColumn("Implied ±%", format="%.1f%%", min_value=0, max_value=20),
                "Valuation Metric":    st.column_config.NumberColumn("Forward P/E", format="%.2f x"),
                "Consensus Indicator": st.column_config.NumberColumn("P/S Ratio",   format="%.2f x"),
            }, hide_index=True, use_container_width=True)

            # ── Short Interest Panel ──────────────────────────────────────────
            if show_short:
                st.markdown("<br>", unsafe_allow_html=True)
                st.markdown("##### Short Interest Monitor")
                short_rows = []
                for tk in active_tickers:
                    si = get_short_interest(tk)
                    if si:
                        short_rows.append({
                            "Ticker":              tk,
                            "Short % of Float":    f"{si.get('shortPercentOfFloat', 0)*100:.1f}%" if si.get('shortPercentOfFloat') else "N/A",
                            "Short Ratio (Days)":  f"{si.get('shortRatio', 0):.1f}" if si.get('shortRatio') else "N/A",
                            "Shares Short":        f"{si.get('sharesShort', 0):,.0f}" if si.get('sharesShort') else "N/A",
                            "Prior Month Short":   f"{si.get('sharesShortPriorMonth', 0):,.0f}" if si.get('sharesShortPriorMonth') else "N/A",
                        })
                if short_rows:
                    st.dataframe(pd.DataFrame(short_rows), hide_index=True, use_container_width=True)

            # ── Insider Transactions Panel ────────────────────────────────────
            if show_insider:
                st.markdown("<br>", unsafe_allow_html=True)
                st.markdown("##### Insider Transaction Flow")
                for tk in active_tickers[:4]:  # limit to avoid rate limits
                    insider_df = get_insider_transactions(tk)
                    if insider_df is not None and not insider_df.empty:
                        st.markdown(f"**{tk}**")
                        st.dataframe(insider_df.head(5), use_container_width=True, hide_index=True)

    with right_notes_panel:
        with st.container(height=650, border=True):
            st.markdown("#### **Terminal Intelligence Brief**")
            st.caption(f"Live Desk Feed — {pd.Timestamp.now().strftime('%b %d, %Y')}")
            st.divider()

            def extract_url(node):
                if isinstance(node, str):
                    if (node.startswith("http://") or node.startswith("https://")) and not any(node.lower().endswith(e) for e in [".jpg",".jpeg",".png",".gif",".webp"]):
                        return node
                if isinstance(node, dict):
                    for k in ["link","clickThroughUrl","url"]:
                        if k in node:
                            r = extract_url(node[k])
                            if r: return r
                    for k, v in node.items():
                        if k == "thumbnail": continue
                        r = extract_url(v)
                        if r: return r
                if isinstance(node, list):
                    for item in node:
                        r = extract_url(item)
                        if r: return r
                return None

            def extract_title(node):
                if isinstance(node, dict):
                    for k in ["title","headline","text"]:
                        if k in node and isinstance(node[k], str) and node[k].strip():
                            return node[k].strip()
                    for v in node.values():
                        r = extract_title(v)
                        if r: return r
                if isinstance(node, list):
                    for item in node:
                        r = extract_title(item)
                        if r: return r
                return None

            def extract_source(node):
                if isinstance(node, dict):
                    for k in ["publisher","source","provider","creator","author"]:
                        if k in node:
                            v = node[k]
                            if isinstance(v, dict):
                                for sk in ["name","title","displayName"]:
                                    if sk in v and isinstance(v[sk], str) and v[sk].strip():
                                        return v[sk].strip()
                            elif isinstance(v, str) and v.strip():
                                return v.strip()
                    for v in node.values():
                        r = extract_source(v)
                        if r: return r
                if isinstance(node, list):
                    for item in node:
                        r = extract_source(item)
                        if r: return r
                return None

            if active_tickers:
                st.markdown('<div style="max-height: 520px; overflow-y: auto; padding-right: 5px;">', unsafe_allow_html=True)
                for tk in active_tickers:
                    try:
                        news_stream = get_cached_ticker_news(tk)
                        if news_stream:
                            st.markdown(f"##### **{tk} News Wire**")
                            for article in news_stream[:2]:
                                title  = extract_title(article)  or "Market Update"
                                source = extract_source(article) or "Financial Wire"
                                url    = extract_url(article)
                                if url:
                                    st.markdown(f'<p style="margin-bottom:2px;"><a href="{url}" target="_blank" style="color:#d97736; text-decoration:none; font-weight:600;">{title}</a></p>', unsafe_allow_html=True)
                                else:
                                    st.markdown(f"**{title}**")
                                st.caption(f"Source: {source}")
                            st.markdown("---")
                    except Exception:
                        continue
                st.markdown('</div>', unsafe_allow_html=True)

# ══════════════════════════════════════════════════════════════════════════════
# TAB 9 — DCF VALUATION ENGINE
# ══════════════════════════════════════════════════════════════════════════════
def render_dcf():
    st.header("Discounted Cash Flow Valuation Engine")

    # Initialize session state defaults
    for k, v in [
        ("dcf_revenue_base", 5000.0), ("dcf_margin", 20.0), ("dcf_tax_rate", 21.0),
        ("dcf_capex_pct", 5.0), ("dcf_da_pct", 4.0), ("dcf_wc_pct", 2.0),
        ("dcf_shares_out", 1000.0), ("dcf_net_debt", 0.0),
        ("dcf_growth_1", 15.0), ("dcf_growth_2", 10.0), ("dcf_growth_3", 5.0),
        ("dcf_wacc", 9.0), ("dcf_terminal_g", 2.5),
    ]:
        st.session_state.setdefault(k, v)

    with st.container(border=True):
        st.markdown("##### Company Parameters")
        t_col, f_col = st.columns([3, 1])
        final_dcf     = t_col.text_input("Ticker (for market price)", value="AAPL", key="dcf_ticker").strip().upper()
        fetch_clicked = f_col.button("Fetch Data", use_container_width=True)

        if fetch_clicked and final_dcf:
            with st.spinner(f"Fetching fundamentals for {final_dcf}..."):
                fundamentals = get_dcf_fundamentals(final_dcf)
                rf = get_live_risk_free_rate()
            if fundamentals:
                # Company parameters
                st.session_state["dcf_revenue_base"] = fundamentals["revenue"]
                st.session_state["dcf_margin"]       = fundamentals["op_margin"]
                st.session_state["dcf_tax_rate"]     = fundamentals["tax_rate"]
                st.session_state["dcf_capex_pct"]    = fundamentals["capex_pct"]
                st.session_state["dcf_da_pct"]       = fundamentals["da_pct"]
                st.session_state["dcf_shares_out"]   = fundamentals["shares"]
                st.session_state["dcf_net_debt"]     = fundamentals["net_debt"]
                # Growth assumptions — cap trailing growth at 35% (beyond that it's noise, not signal)
                g1_seed = min(fundamentals["rev_growth"], 35.0)
                st.session_state["dcf_growth_1"]     = round(g1_seed, 1)
                st.session_state["dcf_growth_2"]     = round(g1_seed * 0.6, 1)
                st.session_state["dcf_growth_3"]     = round(g1_seed * 0.3, 1)
                # WACC via simplified CAPM + D/E weighting
                erp      = 0.055
                ke       = rf + fundamentals["beta"] * erp
                kd       = rf + 0.02
                de       = fundamentals["de_ratio"]
                e_w      = 1.0 / (1.0 + de) if de > 0 else 1.0
                d_w      = de / (1.0 + de) if de > 0 else 0.0
                wacc_est = (ke * e_w + kd * (1 - fundamentals["tax_rate"] / 100) * d_w) * 100
                st.session_state["dcf_wacc"]         = round(max(5.0, min(20.0, wacc_est)), 2)
                st.session_state["dcf_terminal_g"]   = 2.5
                st.session_state["dcf_market_price"]  = fundamentals["market_price"]
                st.session_state["dcf_market_ticker"] = final_dcf
                st.success(f"Auto-populated from yFinance for {final_dcf} (β={fundamentals['beta']:.2f}, Rf={rf*100:.1f}%)")
            else:
                st.warning(f"Could not fetch fundamentals for {final_dcf}.")

        col1, col2, col3 = st.columns(3)
        revenue_base = col1.number_input("Base Revenue ($M)",           step=100.0, min_value=0.0, key="dcf_revenue_base")
        shares_out_m = col1.number_input("Shares Outstanding (M)",      step=10.0,  min_value=0.1, key="dcf_shares_out")
        margin       = col2.number_input("Operating Margin (%)",        step=0.5,                   key="dcf_margin")
        tax_rate     = col2.number_input("Tax Rate (%)",                step=0.5,  min_value=0.0, max_value=60.0, key="dcf_tax_rate")
        capex_pct    = col3.number_input("CapEx % of Revenue",          step=0.5,  min_value=0.0,  key="dcf_capex_pct")
        da_pct       = col3.number_input("D&A % of Revenue",            step=0.5,  min_value=0.0,  key="dcf_da_pct")
        wc_pct       = col3.number_input("Working Capital Change % Rev",step=0.5,                   key="dcf_wc_pct")

    with st.container(border=True):
        st.markdown("##### Growth & Discount Assumptions")
        g1, g2, g3 = st.columns(3)
        growth_rates = []
        growth_rates.append(g1.number_input("Year 1-3 Growth (%)",  step=0.5, key="dcf_growth_1"))
        growth_rates.append(g2.number_input("Year 4-7 Growth (%)",  step=0.5, key="dcf_growth_2"))
        growth_rates.append(g3.number_input("Year 8-10 Growth (%)", step=0.5, key="dcf_growth_3"))

        w1, w2, w3 = st.columns(3)
        wacc       = w1.number_input("WACC (%)",                           step=0.25, min_value=1.0, max_value=30.0, key="dcf_wacc")
        terminal_g = w2.number_input("Terminal Growth Rate (%)",           step=0.25, min_value=0.0, max_value=10.0, key="dcf_terminal_g")
        net_debt_m = w3.number_input("Net Debt ($M, negative = net cash)", step=100.0, key="dcf_net_debt")

        run_dcf = st.button("Run DCF Model", use_container_width=True)

    if run_dcf:
        # Use market price from Fetch Data if same ticker, else fall back to Twelve Data
        if st.session_state.get("dcf_market_ticker") == final_dcf and st.session_state.get("dcf_market_price"):
            market_price = st.session_state["dcf_market_price"]
        else:
            with st.spinner(f"Fetching {final_dcf} market data..."):
                mkt_hist = get_yf_market_data(final_dcf)
                market_price = float(mkt_hist["close"].iloc[-1]) if not mkt_hist.empty else None

        # Build year-by-year FCF projections
        yearly_growth = (
            [growth_rates[0]/100]*3 +
            [growth_rates[1]/100]*4 +
            [growth_rates[2]/100]*3
        )

        fcf_rows = []
        rev = revenue_base
        for yr, g in enumerate(yearly_growth, start=1):
            rev        = rev * (1 + g)
            ebit       = rev * (margin/100)
            nopat      = ebit * (1 - tax_rate/100)
            da         = rev * (da_pct/100)
            capex      = rev * (capex_pct/100)
            delta_wc   = rev * (wc_pct/100)
            fcf        = nopat + da - capex - delta_wc
            fcf_rows.append({"Year": yr, "Revenue ($M)": rev, "EBIT ($M)": ebit, "NOPAT ($M)": nopat, "FCF ($M)": fcf})

        fcf_df = pd.DataFrame(fcf_rows)

        # Discount FCFs
        r_wacc   = wacc / 100
        r_tg     = terminal_g / 100
        pv_fcfs  = [row["FCF ($M)"] / ((1+r_wacc)**row["Year"]) for _, row in fcf_df.iterrows()]
        terminal_val  = fcf_rows[-1]["FCF ($M)"] * (1 + r_tg) / (r_wacc - r_tg)
        pv_terminal   = terminal_val / ((1+r_wacc)**10)
        enterprise_val = sum(pv_fcfs) + pv_terminal
        equity_val    = enterprise_val - net_debt_m
        intrinsic_ps  = equity_val / shares_out_m if shares_out_m > 0 else 0

        with st.container(border=True):
            st.markdown("### DCF Intrinsic Value Summary")
            st.divider()
            v1, v2, v3, v4, v5 = st.columns(5)
            v1.metric("Enterprise Value",     fmt_large(enterprise_val))
            v2.metric("Equity Value",         fmt_large(equity_val))
            v3.metric("Intrinsic Value/Share",f"${intrinsic_ps:,.2f}")
            if market_price:
                updown = (intrinsic_ps / market_price - 1) * 100
                v4.metric("Market Price",     f"${market_price:,.2f}")
                v5.metric("Upside / Downside",f"{updown:+.1f}%",
                    delta_color="normal" if updown >= 0 else "inverse")
            v3_val = pv_terminal / enterprise_val * 100 if enterprise_val else 0
            st.caption(f"Terminal value represents **{v3_val:.1f}%** of enterprise value. "
                       f"Sensitivity to WACC and terminal growth rate is high beyond this threshold.")

        st.markdown("<br>", unsafe_allow_html=True)

        # FCF waterfall chart
        fig_dcf = make_subplots(rows=1, cols=2,
            subplot_titles=("Free Cash Flow Projections ($M)", "PV Breakdown"),
            column_widths=[0.6, 0.4],
            specs=[[{"type": "xy"}, {"type": "domain"}]])
        fig_dcf.add_trace(go.Bar(x=fcf_df["Year"], y=fcf_df["FCF ($M)"], name="FCF",
            marker_color="#1f5673", showlegend=False), row=1, col=1)
        fig_dcf.add_trace(go.Bar(x=fcf_df["Year"], y=pv_fcfs, name="PV of FCF",
            marker_color="#d97736", showlegend=False), row=1, col=1)

        # Pie: PV FCFs vs terminal
        fig_dcf.add_trace(go.Pie(
            labels=["PV of FCFs", "PV of Terminal Value"],
            values=[sum(pv_fcfs), pv_terminal],
            marker=dict(colors=["#1f5673","#d97736"]),
            textinfo="label+percent",
            hole=0.4), row=1, col=2)

        fig_dcf.update_layout(height=450, font=dict(family="Lora, serif"),
            plot_bgcolor="rgba(0,0,0,0)", paper_bgcolor="rgba(0,0,0,0)",
            showlegend=False)
        st.plotly_chart(fig_dcf, use_container_width=True)

        # Sensitivity heatmap: intrinsic value across Yr 1-3 growth × operating margin
        st.markdown("##### Revenue Growth × Operating Margin Sensitivity")
        growth_range = [growth_rates[0] + d for d in [-6, -3, 0, 3, 6]]
        margin_range = [margin + d for d in [-6, -3, 0, 3, 6]]

        heat_z, text_z = [], []
        for g_early in growth_range:
            row_z, row_t = [], []
            for m in margin_range:
                yr_growths = [g_early/100]*3 + [growth_rates[1]/100]*4 + [growth_rates[2]/100]*3
                rev_s, fcfs_s = revenue_base, []
                for i_yr, g_s in enumerate(yr_growths, start=1):
                    rev_s  = rev_s * (1 + g_s)
                    fcf_s  = (rev_s*(m/100)*(1-tax_rate/100)
                              + rev_s*(da_pct/100)
                              - rev_s*(capex_pct/100)
                              - rev_s*(wc_pct/100))
                    fcfs_s.append(fcf_s)
                pv_f_s  = sum(fcfs_s[i] / ((1+r_wacc)**(i+1)) for i in range(10))
                tv_s    = fcfs_s[-1] * (1+r_tg) / (r_wacc - r_tg) if r_wacc > r_tg else 0
                pv_tv_s = tv_s / ((1+r_wacc)**10)
                ips_s   = ((pv_f_s + pv_tv_s) - net_debt_m) / shares_out_m if shares_out_m else 0
                row_z.append(round(ips_s, 2))
                row_t.append(f"${ips_s:.2f}")
            heat_z.append(row_z)
            text_z.append(row_t)

        x_labels = [f"{m:.1f}%" for m in margin_range]
        y_labels = [f"{g:.1f}%" for g in growth_range]

        fig_sens = go.Figure(data=go.Heatmap(
            z=heat_z, x=x_labels, y=y_labels,
            colorscale="RdYlGn",
            text=text_z, texttemplate="%{text}",
            colorbar=dict(title="$/share")
        ))
        fig_sens.update_layout(
            title=dict(text="Intrinsic Value per Share ($/share) — all other inputs held constant",
                       font=dict(size=13)),
            xaxis_title="Operating Margin (%)", yaxis_title="Year 1–3 Revenue Growth (%)",
            height=420, font=dict(family="Lora, serif"),
            plot_bgcolor="rgba(0,0,0,0)", paper_bgcolor="rgba(0,0,0,0)"
        )
        st.plotly_chart(fig_sens, use_container_width=True)

        # CSV export
        _, ex2 = st.columns([4,1])
        with ex2:
            st.download_button(" Export FCF Schedule", data=convert_df_to_csv(fcf_df),
                file_name=f"{final_dcf}_dcf_schedule.csv", mime="text/csv", use_container_width=True)

# ══════════════════════════════════════════════════════════════════════════════
# TAB 10 — OPTIONS CHAIN SCANNER
# ══════════════════════════════════════════════════════════════════════════════
def render_chain():
    st.header("Options Chain Scanner")
    st.caption("Data sourced from Yahoo Finance options feed. Shows nearest expiry chain.")

    with st.container(border=True):
        st.markdown("##### Scanner Parameters")
        col1, col2 = st.columns([2, 1])
        final_chain = col1.text_input("Target Ticker", value="SPY", key="chain_ticker_sel").strip().upper()
        top_n_strikes = col2.number_input("Strikes to Display (each side of ATM)", value=10, min_value=3, max_value=30, step=1)
        run_chain     = st.button("Load Options Chain", use_container_width=True)

    if run_chain:
        with st.spinner(f"Fetching live options chain for {final_chain}..."):
            calls, puts, expiry = get_options_chain(final_chain)
            spot_hist = get_yf_market_data(final_chain)
            spot_px   = float(spot_hist["close"].iloc[-1]) if not spot_hist.empty else None

        if calls is None or puts is None:
            st.error("Could not retrieve options chain. Verify the ticker supports options trading.")
            st.stop()

        st.markdown(f"**Expiry: {expiry}** | Spot: {'${:,.2f}'.format(spot_px) if spot_px else 'N/A'}")

        # Filter to strikes near ATM
        if spot_px:
            calls = calls.copy()
            puts  = puts.copy()
            calls["dist"] = abs(calls["strike"] - spot_px)
            puts["dist"]  = abs(puts["strike"]  - spot_px)
            calls = calls.nsmallest(int(top_n_strikes * 2), "dist").sort_values("strike")
            puts  = puts.nsmallest(int(top_n_strikes * 2),  "dist").sort_values("strike")

        # Summary metrics
        total_call_oi = calls["openInterest"].sum() if "openInterest" in calls.columns else 0
        total_put_oi  = puts["openInterest"].sum()  if "openInterest" in puts.columns  else 0
        pc_ratio      = total_put_oi / total_call_oi if total_call_oi > 0 else 0
        avg_call_iv   = calls["impliedVolatility"].mean() if "impliedVolatility" in calls.columns else 0
        avg_put_iv    = puts["impliedVolatility"].mean()  if "impliedVolatility" in puts.columns  else 0
        iv_skew       = avg_put_iv - avg_call_iv

        with st.container(border=True):
            st.markdown("##### Chain Summary Metrics")
            st.divider()
            s1, s2, s3, s4 = st.columns(4)
            s1.metric("Put / Call OI Ratio", f"{pc_ratio:.2f}", help=">1 = more put OI (bearish skew)")
            s2.metric("Total Call OI",        f"{total_call_oi:,.0f}")
            s3.metric("Total Put OI",         f"{total_put_oi:,.0f}")
            s4.metric("IV Skew (Put-Call)",   f"{iv_skew*100:.1f}%", help="Positive = puts more expensive than calls")

        tab_calls, tab_puts, tab_oi, tab_iv = st.tabs(["Calls", "Puts", "Open Interest Chart", "IV Skew Chart"])

        display_cols = [c for c in ["strike","lastPrice","bid","ask","impliedVolatility","openInterest","volume","delta","gamma"] if c in calls.columns]

        with tab_calls:
            calls_display = calls[display_cols].copy()
            if "impliedVolatility" in calls_display.columns:
                calls_display["impliedVolatility"] = calls_display["impliedVolatility"].apply(lambda x: f"{x*100:.1f}%")
            if spot_px:
                def highlight_atm(row):
                    return ['background-color: rgba(31,86,115,0.2)' if abs(row['strike'] - spot_px) == calls['dist'].min() else '' for _ in row]
            st.dataframe(calls_display, hide_index=True, use_container_width=True)

        with tab_puts:
            puts_display = puts[display_cols if all(c in puts.columns for c in display_cols) else [c for c in display_cols if c in puts.columns]].copy()
            if "impliedVolatility" in puts_display.columns:
                puts_display["impliedVolatility"] = puts_display["impliedVolatility"].apply(lambda x: f"{x*100:.1f}%")
            st.dataframe(puts_display, hide_index=True, use_container_width=True)

        with tab_oi:
            fig_oi = go.Figure()
            if "openInterest" in calls.columns:
                fig_oi.add_trace(go.Bar(x=calls["strike"], y=calls["openInterest"], name="Call OI", marker_color="#2f6b4b", opacity=0.8))
            if "openInterest" in puts.columns:
                fig_oi.add_trace(go.Bar(x=puts["strike"],  y=puts["openInterest"],  name="Put OI",  marker_color="#8c2e36", opacity=0.8))
            if spot_px:
                fig_oi.add_vline(x=spot_px, line_dash="dash", line_color="#d97736", annotation_text="Spot")
            fig_oi.update_layout(barmode='overlay', height=450, hovermode="x unified",
                xaxis_title="Strike", yaxis_title="Open Interest",
                font=dict(family="Lora, serif"), plot_bgcolor="rgba(0,0,0,0)", paper_bgcolor="rgba(0,0,0,0)",
                legend=dict(orientation="h", yanchor="bottom", y=1.02, xanchor="right", x=1))
            st.plotly_chart(fig_oi, use_container_width=True)

        with tab_iv:
            fig_iv = go.Figure()
            if "impliedVolatility" in calls.columns:
                fig_iv.add_trace(go.Scatter(x=calls["strike"], y=calls["impliedVolatility"]*100, name="Call IV %", line=dict(color="#2f6b4b", width=2)))
            if "impliedVolatility" in puts.columns:
                fig_iv.add_trace(go.Scatter(x=puts["strike"],  y=puts["impliedVolatility"]*100,  name="Put IV %",  line=dict(color="#8c2e36", width=2)))
            if spot_px:
                fig_iv.add_vline(x=spot_px, line_dash="dash", line_color="#d97736", annotation_text="Spot")
            fig_iv.update_layout(height=450, hovermode="x unified",
                xaxis_title="Strike", yaxis_title="Implied Volatility (%)",
                font=dict(family="Lora, serif"), plot_bgcolor="rgba(0,0,0,0)", paper_bgcolor="rgba(0,0,0,0)",
                legend=dict(orientation="h", yanchor="bottom", y=1.02, xanchor="right", x=1))
            st.plotly_chart(fig_iv, use_container_width=True)

# ══════════════════════════════════════════════════════════════════════════════
# TAB 11 — CORRELATION MATRIX
# ══════════════════════════════════════════════════════════════════════════════
def render_correlation():
    st.header("Rolling Correlation Matrix")

    with st.container(border=True):
        st.markdown("##### Basket Configuration")
        col1, col2 = st.columns([3, 1])
        ticker_str = col1.text_input("Tickers (comma separated)", value="SPY, QQQ, GLD, TLT, BTC-USD, NVDA, AAPL")
        window     = col2.number_input("Rolling Window (days)", value=60, min_value=10, max_value=252, step=5)

        c1, c2, c3 = st.columns(3)
        start_corr = c1.date_input("Start Date", value=pd.to_datetime("2022-01-01"), key="corr_start")
        end_corr   = c2.date_input("End Date",   value=pd.to_datetime("today"),      key="corr_end")
        run_corr   = c3.button("Generate Matrix", use_container_width=True)

    if run_corr:
        tickers = [t.strip().upper() for t in ticker_str.split(",") if t.strip()]
        if len(tickers) < 2:
            st.error("Please enter at least 2 tickers.")
            st.stop()

        with st.spinner("Fetching historical price arrays..."):
            series_dict = {}
            for t in tickers:
                s, src = get_price_series(t, start_corr, end_corr)
                if not s.empty:
                    series_dict[t] = s
                else:
                    st.warning(f" Could not fetch data for {t} — skipping.")

        if len(series_dict) < 2:
            st.error("Need at least 2 valid tickers to compute correlations.")
            st.stop()

        price_df  = pd.DataFrame(series_dict).dropna()
        returns   = price_df.pct_change().dropna()
        corr_full = returns.corr()
        st.session_state["corr_returns"] = returns
        st.session_state["corr_full"]    = corr_full

    if "corr_full" in st.session_state:
        returns   = st.session_state["corr_returns"]
        corr_full = st.session_state["corr_full"]

        # Full correlation heatmap
        z_vals = corr_full.values
        labels = corr_full.columns.tolist()

        fig_heat = go.Figure(data=go.Heatmap(
            z=z_vals, x=labels, y=labels,
            colorscale="RdBu", zmid=0, zmin=-1, zmax=1,
            text=[[f"{z_vals[i][j]:.2f}" for j in range(len(labels))] for i in range(len(labels))],
            texttemplate="%{text}",
            colorbar=dict(title="Correlation")
        ))
        fig_heat.update_layout(title="Full-Period Correlation Matrix", height=550,
            font=dict(family="Lora, serif"), plot_bgcolor="rgba(0,0,0,0)", paper_bgcolor="rgba(0,0,0,0)")
        st.plotly_chart(fig_heat, use_container_width=True)

        # Rolling pairwise correlation for top pair
        st.markdown("##### Rolling Pairwise Correlation")
        pair_options = [f"{a} / {b}" for i, a in enumerate(labels) for b in labels[i+1:]]
        selected_pair = st.selectbox("Select pair", options=pair_options)
        if selected_pair:
            a_tick, b_tick = [x.strip() for x in selected_pair.split("/")]
            if a_tick in returns.columns and b_tick in returns.columns:
                rolling_corr = returns[a_tick].rolling(int(window)).corr(returns[b_tick])
                fig_roll = go.Figure()
                fig_roll.add_trace(go.Scatter(x=rolling_corr.index, y=rolling_corr,
                    name=f"{window}D Rolling Corr", line=dict(color="#1f5673", width=2),
                    fill='tozeroy', fillcolor="rgba(31,86,115,0.1)"))
                fig_roll.add_hline(y=0, line_dash="dash", line_color="rgba(128,128,128,0.5)")
                fig_roll.update_layout(title=f"{window}D Rolling Correlation: {a_tick} vs {b_tick}",
                    height=400, hovermode="x unified",
                    yaxis=dict(range=[-1,1], tickformat=".2f", showgrid=True, gridcolor="rgba(128,128,128,0.1)"),
                    xaxis=dict(showgrid=True, gridcolor="rgba(128,128,128,0.1)"),
                    font=dict(family="Lora, serif"), plot_bgcolor="rgba(0,0,0,0)", paper_bgcolor="rgba(0,0,0,0)")
                st.plotly_chart(fig_roll, use_container_width=True)

        # Export
        _, ex2 = st.columns([4,1])
        with ex2:
            st.download_button(" Export Correlation Matrix", data=convert_df_to_csv(corr_full),
                file_name="correlation_matrix.csv", mime="text/csv", use_container_width=True)

# ══════════════════════════════════════════════════════════════════════════════
# TAB 12 — MULTI-LEG OPTIONS STRATEGY BUILDER
# ══════════════════════════════════════════════════════════════════════════════
def render_strategy_builder():
    st.header("Multi-Leg Options Strategy Builder")

    # ── session state defaults ────────────────────────────────────────────────
    st.session_state.setdefault("strat_spot",         500.0)
    st.session_state.setdefault("strat_iv",            20.0)
    st.session_state.setdefault("strat_rf",             4.5)
    st.session_state.setdefault("strat_leg_count",        0)
    st.session_state.setdefault("strat_calc_premiums", False)

    # ── process pending premium calculation BEFORE any widgets are rendered ───
    if st.session_state["strat_calc_premiums"]:
        st.session_state["strat_calc_premiums"] = False
        n    = st.session_state["strat_leg_count"]
        spot = st.session_state["strat_spot"]
        iv   = st.session_state["strat_iv"]
        rf   = st.session_state["strat_rf"]
        for i in range(n):
            try:
                p = bs_price(
                    spot,
                    st.session_state[f"sl_{i}_strike"],
                    st.session_state[f"sl_{i}_dte"],
                    rf, iv,
                    st.session_state[f"sl_{i}_type"].lower()
                )
                st.session_state[f"sl_{i}_premium"] = round(float(p), 2)
            except Exception as e:
                st.toast(f"Leg {i+1} pricing failed: {e}", icon="")

    # ── Underlying & pricing params ───────────────────────────────────────────
    with st.container(border=True):
        st.markdown("##### Underlying & Pricing")
        # Row 1 — ticker + fetch button
        r1, r2 = st.columns([3, 1])
        ticker    = r1.text_input("Ticker", value="SPY", key="strat_ticker")
        fetch_btn = r2.button("Fetch Spot & IV", use_container_width=True)

        # Modify session state BEFORE the number_input widgets are instantiated
        if fetch_btn:
            with st.spinner(f"Fetching {ticker}..."):
                hist = get_yf_market_data(ticker.strip().upper())
                if not hist.empty:
                    st.session_state["strat_spot"] = round(float(hist["close"].iloc[-1]), 2)
                fetched_iv = get_yf_implied_vol(ticker.strip().upper())
                st.session_state["strat_iv"] = round(fetched_iv * 100, 1)

        # Row 2 — number inputs (rendered after any session state updates above)
        n1, n2, n3 = st.columns(3)
        spot = n1.number_input("Spot ($)",           min_value=0.01, step=1.0,  key="strat_spot")
        iv   = n2.number_input("Implied Vol (%)",    min_value=0.1,  step=0.5,  key="strat_iv")
        rf   = n3.number_input("Risk-Free Rate (%)", min_value=0.0,  step=0.25, key="strat_rf")

    # ── helper: set legs from a preset ───────────────────────────────────────
    def set_preset(legs_spec):
        # legs_spec: list of (direction, opt_type, strike_mult, dte, qty)
        n = len(legs_spec)
        st.session_state["strat_leg_count"] = n
        for i, (direction, opt_type, mult, dte, qty) in enumerate(legs_spec):
            K = round(spot * mult / 5) * 5
            st.session_state.update({
                f"sl_{i}_dir":     direction,
                f"sl_{i}_type":    opt_type,
                f"sl_{i}_strike":  float(K),
                f"sl_{i}_dte":     dte,
                f"sl_{i}_qty":     qty,
                f"sl_{i}_premium": 0.0,
            })

    # ── Strategy presets ──────────────────────────────────────────────────────
    with st.container(border=True):
        st.markdown("##### Presets")
        p1,p2,p3,p4,p5,p6,p7 = st.columns(7)
        if p1.button("Bull Call Spread",   use_container_width=True):
            set_preset([("Long","Call",1.00,45,1),("Short","Call",1.05,45,1)])
        if p2.button("Bear Put Spread",    use_container_width=True):
            set_preset([("Long","Put",1.00,45,1),("Short","Put",0.95,45,1)])
        if p3.button("Straddle",           use_container_width=True):
            set_preset([("Long","Call",1.00,30,1),("Long","Put",1.00,30,1)])
        if p4.button("Strangle",           use_container_width=True):
            set_preset([("Long","Call",1.05,30,1),("Long","Put",0.95,30,1)])
        if p5.button("Iron Condor",        use_container_width=True):
            set_preset([("Long","Put",0.90,45,1),("Short","Put",0.95,45,1),
                        ("Short","Call",1.05,45,1),("Long","Call",1.10,45,1)])
        if p6.button("Iron Butterfly",     use_container_width=True):
            set_preset([("Long","Put",0.90,30,1),("Short","Put",1.00,30,1),
                        ("Short","Call",1.00,30,1),("Long","Call",1.10,30,1)])
        if p7.button("Butterfly Spread",   use_container_width=True):
            set_preset([("Long","Call",0.95,30,1),("Short","Call",1.00,30,2),
                        ("Long","Call",1.05,30,1)])

    # ── Leg builder ───────────────────────────────────────────────────────────
    n_legs = st.session_state["strat_leg_count"]

    with st.container(border=True):
        st.markdown("##### Legs")

        if n_legs > 0:
            hcols = st.columns([1.2, 1, 1.2, 1, 0.8, 1.2, 0.5])
            for col, label in zip(hcols, ["Direction","Type","Strike ($)","DTE","Qty","Premium ($/sh)",""]):
                col.markdown(
                    f"<p style='color:#5e768f;font-size:0.65rem;text-transform:uppercase;"
                    f"letter-spacing:0.09em;margin-bottom:4px'>{label}</p>",
                    unsafe_allow_html=True)

        remove_idx = None
        for i in range(n_legs):
            st.session_state.setdefault(f"sl_{i}_dir",     "Long")
            st.session_state.setdefault(f"sl_{i}_type",    "Call")
            st.session_state.setdefault(f"sl_{i}_strike",  float(spot))
            st.session_state.setdefault(f"sl_{i}_dte",     30)
            st.session_state.setdefault(f"sl_{i}_qty",     1)
            st.session_state.setdefault(f"sl_{i}_premium", 0.0)

            lc = st.columns([1.2, 1, 1.2, 1, 0.8, 1.2, 0.5])
            lc[0].selectbox("",  ["Long","Short"],         key=f"sl_{i}_dir",     label_visibility="collapsed")
            lc[1].selectbox("",  ["Call","Put"],            key=f"sl_{i}_type",    label_visibility="collapsed")
            lc[2].number_input("", min_value=0.01, step=1.0,                      key=f"sl_{i}_strike",  label_visibility="collapsed")
            lc[3].number_input("", min_value=1, max_value=730, step=1,            key=f"sl_{i}_dte",     label_visibility="collapsed")
            lc[4].number_input("", min_value=1, max_value=100, step=1,            key=f"sl_{i}_qty",     label_visibility="collapsed")
            lc[5].number_input("", min_value=0.0, step=0.01, format="%.2f",       key=f"sl_{i}_premium", label_visibility="collapsed")
            if lc[6].button("x", key=f"sl_{i}_rm"):
                remove_idx = i

        if remove_idx is not None:
            for j in range(remove_idx, n_legs - 1):
                for f in ["dir","type","strike","dte","qty","premium"]:
                    st.session_state[f"sl_{j}_{f}"] = st.session_state[f"sl_{j+1}_{f}"]
            st.session_state["strat_leg_count"] -= 1
            st.rerun()

        ba1, ba2, ba3 = st.columns(3)
        if ba1.button("+ Add Leg", use_container_width=True) and n_legs < 4:
            i = n_legs
            st.session_state.update({
                f"sl_{i}_dir": "Long", f"sl_{i}_type": "Call",
                f"sl_{i}_strike": float(spot), f"sl_{i}_dte": 30,
                f"sl_{i}_qty": 1, f"sl_{i}_premium": 0.0,
            })
            st.session_state["strat_leg_count"] += 1
            st.rerun()

        if ba2.button("Calculate Premiums (BS)", use_container_width=True) and n_legs > 0:
            st.session_state["strat_calc_premiums"] = True
            st.rerun()

        if ba3.button("Clear All", use_container_width=True):
            st.session_state["strat_leg_count"] = 0
            st.rerun()

    if n_legs == 0:
        st.caption("Add a leg or select a preset to get started.")
        return

    # ── Collect legs & compute payoff ─────────────────────────────────────────
    legs = [{
        "direction": st.session_state[f"sl_{i}_dir"],
        "type":      st.session_state[f"sl_{i}_type"],
        "strike":    st.session_state[f"sl_{i}_strike"],
        "dte":       st.session_state[f"sl_{i}_dte"],
        "qty":       st.session_state[f"sl_{i}_qty"],
        "premium":   st.session_state[f"sl_{i}_premium"],
    } for i in range(n_legs)]

    spot_range    = np.linspace(spot * 0.6, spot * 1.4, 600)
    total_payoff  = np.zeros_like(spot_range)
    leg_colors    = ["#1f5673", "#d97736", "#2f6b4b", "#8c2e36"]

    fig = go.Figure()
    for i, leg in enumerate(legs):
        K        = leg["strike"]
        qty      = leg["qty"]
        premium  = leg["premium"]
        if leg["type"] == "Call":
            intrinsic = np.maximum(spot_range - K, 0)
        else:
            intrinsic = np.maximum(K - spot_range, 0)
        leg_pnl = ((intrinsic - premium) if leg["direction"] == "Long" else (premium - intrinsic)) * qty * 100
        total_payoff += leg_pnl
        fig.add_trace(go.Scatter(
            x=spot_range, y=leg_pnl,
            name=f"Leg {i+1}: {leg['direction']} {leg['type']} K={K:.0f}",
            line=dict(color=leg_colors[i % 4], width=1.5, dash="dot"), opacity=0.55
        ))

    fig.add_trace(go.Scatter(
        x=spot_range, y=total_payoff, name="Combined P&L",
        line=dict(color="#c9a84c", width=3),
        fill="tozeroy", fillcolor="rgba(201,168,76,0.07)"
    ))
    fig.add_vline(x=spot, line_dash="dash", line_color="rgba(255,255,255,0.25)", annotation_text="Spot")
    fig.add_hline(y=0,    line_dash="dot",  line_color="rgba(128,128,128,0.35)")
    fig.update_layout(
        height=460, hovermode="x unified", font=dict(family="Lora, serif"),
        xaxis_title="Underlying Price at Expiry ($)", yaxis_title="P&L ($)",
        plot_bgcolor="rgba(0,0,0,0)", paper_bgcolor="rgba(0,0,0,0)",
        xaxis=dict(showgrid=True, gridcolor="rgba(128,128,128,0.1)"),
        yaxis=dict(showgrid=True, gridcolor="rgba(128,128,128,0.1)", tickprefix="$", tickformat=",.0f"),
        legend=dict(orientation="h", yanchor="bottom", y=1.02, xanchor="right", x=1)
    )
    st.plotly_chart(fig, use_container_width=True)

    # ── Summary metrics ───────────────────────────────────────────────────────
    max_profit  = float(np.max(total_payoff))
    max_loss    = float(np.min(total_payoff))
    net_premium = sum(
        leg["premium"] * leg["qty"] * 100 * (1 if leg["direction"] == "Long" else -1)
        for leg in legs
    )
    sign_changes = np.where(np.diff(np.sign(total_payoff)))[0]
    breakevens   = []
    for idx in sign_changes:
        x1, x2 = spot_range[idx], spot_range[idx + 1]
        y1, y2 = total_payoff[idx], total_payoff[idx + 1]
        if y2 != y1:
            breakevens.append(x1 - y1 * (x2 - x1) / (y2 - y1))

    with st.container(border=True):
        st.markdown("##### Strategy Summary")
        st.divider()
        s1, s2, s3, s4 = st.columns(4)
        s1.metric("Max Profit",   f"${max_profit:,.0f}"  if max_profit < 999_000 else "Unlimited")
        s2.metric("Max Loss",     f"${max_loss:,.0f}"    if max_loss > -999_000  else "Unlimited")
        s3.metric("Net Premium",  f"${abs(net_premium):,.0f} {'paid' if net_premium > 0 else 'received'}")
        s4.metric("Breakeven(s)", " / ".join(f"${b:.2f}" for b in breakevens) if breakevens else "None in range")

# ══════════════════════════════════════════════════════════════════════════════
# ROUTE TO ACTIVE TAB (with error boundaries)
# ══════════════════════════════════════════════════════════════════════════════
# ══════════════════════════════════════════════════════════════════════════════
# TAB 13 — MONTE CARLO PRICE PATH SIMULATOR
# ══════════════════════════════════════════════════════════════════════════════
def _mc_comparison(paths_strat, paths_nostrat, paths_bench, S0, strat_label, bench_tk):
    """Overlay median paths and show a side-by-side metrics table for strategy vs base vs benchmark."""
    if paths_nostrat is None and paths_bench is None:
        return

    st.markdown("##### Comparison — Strategy vs No Strategy vs Benchmark")
    t_axis = np.arange(paths_strat.shape[0])

    fig_c = go.Figure()
    # No-strategy baseline
    if paths_nostrat is not None:
        med_base = np.median(paths_nostrat, axis=1)
        p5_base  = np.percentile(paths_nostrat, 5, axis=1)
        p95_base = np.percentile(paths_nostrat, 95, axis=1)
        fig_c.add_trace(go.Scatter(
            x=np.concatenate([t_axis, t_axis[::-1]]),
            y=np.concatenate([p95_base, p5_base[::-1]]),
            fill="toself", fillcolor="rgba(108,117,125,0.10)",
            line=dict(color="rgba(0,0,0,0)"), showlegend=False, hoverinfo="skip"))
        fig_c.add_trace(go.Scatter(x=t_axis, y=med_base, mode="lines",
            name="No Strategy (Median)", line=dict(color="#6c757d", width=2, dash="dot")))
    # Benchmark
    if paths_bench is not None:
        med_bench = np.median(paths_bench, axis=1)
        fig_c.add_trace(go.Scatter(x=t_axis, y=med_bench, mode="lines",
            name=f"{bench_tk} (Median)", line=dict(color="#d97736", width=2, dash="dash")))
    # Strategy (on top)
    med_strat = np.median(paths_strat, axis=1)
    p5_strat  = np.percentile(paths_strat, 5, axis=1)
    p95_strat = np.percentile(paths_strat, 95, axis=1)
    fig_c.add_trace(go.Scatter(
        x=np.concatenate([t_axis, t_axis[::-1]]),
        y=np.concatenate([p95_strat, p5_strat[::-1]]),
        fill="toself", fillcolor="rgba(31,86,115,0.12)",
        line=dict(color="rgba(0,0,0,0)"), showlegend=False, hoverinfo="skip"))
    fig_c.add_trace(go.Scatter(x=t_axis, y=med_strat, mode="lines",
        name=f"{strat_label or 'Strategy'} (Median)",
        line=dict(color="#1f5673", width=2.5)))
    fig_c.add_hline(y=S0, line_dash="dash", line_color="rgba(255,255,255,0.2)", annotation_text="Entry")
    fig_c.update_layout(
        title="Median Path Comparison (shaded = P5–P95 band)",
        height=380, hovermode="x unified", font=dict(family="Lora, serif"),
        xaxis_title="Trading Days",
        yaxis_title="Price ($)" if S0 != 100.0 else "Normalised Value ($)",
        plot_bgcolor="rgba(0,0,0,0)", paper_bgcolor="rgba(0,0,0,0)",
        xaxis=dict(showgrid=True, gridcolor="rgba(128,128,128,0.1)"),
        yaxis=dict(showgrid=True, gridcolor="rgba(128,128,128,0.1)", tickprefix="$", tickformat=",.2f"),
        legend=dict(orientation="h", yanchor="bottom", y=1.02, xanchor="right", x=1))
    st.plotly_chart(fig_c, use_container_width=True)

    # Side-by-side metrics table
    def _stats(paths, s0):
        t = paths[-1, :]
        med = float(np.median(t))
        prob = float(np.mean(t > s0) * 100)
        p5v  = float(np.percentile(t, 5))
        p95v = float(np.percentile(t, 95))
        cagr = float(np.log(med / s0) / (paths.shape[0] / 252)) * 100
        return med, prob, p5v, p95v, cagr

    cols = []
    labels = []
    if strat_label and strat_label != "No Signal":
        cols.append(paths_strat);   labels.append(strat_label or "Strategy")
    if paths_nostrat is not None:
        cols.append(paths_nostrat); labels.append("No Strategy")
    if paths_bench is not None:
        cols.append(paths_bench);   labels.append(bench_tk)

    if len(cols) > 1:
        with st.container(border=True):
            st.markdown("##### Key Metrics Comparison")
            header = st.columns(len(cols) + 1)
            header[0].markdown("**Metric**")
            for i, lbl in enumerate(labels):
                header[i+1].markdown(f"**{lbl}**")

            rows = [
                ("Median Final",  lambda p: f"${_stats(p, S0)[0]:,.2f}"),
                ("Prob of Profit", lambda p: f"{_stats(p, S0)[1]:.1f}%"),
                ("P5 (tail loss)", lambda p: f"${_stats(p, S0)[2]:,.2f}"),
                ("P95 (upside)",  lambda p: f"${_stats(p, S0)[3]:,.2f}"),
                ("Implied CAGR",  lambda p: f"{_stats(p, S0)[4]:+.1f}%"),
            ]
            for metric_name, fn in rows:
                row = st.columns(len(cols) + 1)
                row[0].markdown(metric_name)
                vals = [_stats(p, S0) for p in cols]
                med_vals = [v[0] for v in vals]  # use median final for colouring
                best_idx = int(np.argmax(med_vals))
                for i, p in enumerate(cols):
                    cell_val = fn(p)
                    if i == best_idx:
                        row[i+1].markdown(f"**{cell_val}** ")
                    else:
                        row[i+1].markdown(cell_val)


def _mc_risk_metrics(terminal, S0):
    median_px   = float(np.median(terminal))
    mean_px     = float(np.mean(terminal))
    prob_profit = float(np.mean(terminal > S0) * 100)
    pct5  = float(np.percentile(terminal, 5))
    pct1  = float(np.percentile(terminal, 1))
    var_95  = S0 - pct5
    var_99  = S0 - pct1
    cvar_95 = S0 - float(np.mean(terminal[terminal <= pct5]))
    best  = float(np.max(terminal))
    worst = float(np.min(terminal))
    with st.container(border=True):
        st.markdown("##### Results")
        st.divider()
        m1, m2, m3, m4 = st.columns(4)
        m1.metric("Median Final Price", f"${median_px:,.2f}", delta=f"{(median_px/S0-1)*100:+.1f}%",
                  help="Middle outcome — half of paths end above, half below. More robust than mean.")
        m2.metric("Prob of Profit", f"{prob_profit:.1f}%",
                  help="% of paths finishing above the starting price.")
        m3.metric("VaR 95%", f"${var_95:,.2f}",
                  help="Max dollar loss in 95% of paths. Worst 5% exceed this.")
        m4.metric("CVaR 95%", f"${cvar_95:,.2f}",
                  help="Average loss across the worst 5% of paths — the tail beyond VaR.")
        m5, m6, m7, m8 = st.columns(4)
        m5.metric("Mean Final Price", f"${mean_px:,.2f}",
                  help="Simple average — can be skewed by extreme winning paths.")
        m6.metric("VaR 99%", f"${var_99:,.2f}",
                  help="Max dollar loss in 99% of paths — rarer, more severe tail.")
        m7.metric("Best Path",  f"${best:,.2f}",
                  help="Single highest terminal price across all simulations.")
        m8.metric("Worst Path", f"${worst:,.2f}",
                  help="Single lowest terminal price — maximum drawdown exposure.")

def _mc_draw_paths(paths, S0, label="Price ($)"):
    t_axis   = np.arange(paths.shape[0])
    terminal = paths[-1, :]
    col_paths, col_dist = st.columns([3, 2])
    with col_paths:
        fig_p = go.Figure()
        n_show   = min(300, paths.shape[1])
        idx_show = np.random.choice(paths.shape[1], n_show, replace=False)
        for i in idx_show:
            fig_p.add_trace(go.Scatter(x=t_axis, y=paths[:, i], mode="lines",
                line=dict(color="rgba(31,86,115,0.10)", width=1),
                showlegend=False, hoverinfo="skip"))
        for pct, color, name, show in [(5,"#8c2e36","P5",True),(25,"rgba(201,168,76,0.55)","P25",False),
                                        (50,"#c9a84c","Median",False),(75,"rgba(201,168,76,0.55)","P75",False),
                                        (95,"#2f6b4b","P95",True)]:
            fig_p.add_trace(go.Scatter(x=t_axis, y=np.percentile(paths, pct, axis=1),
                mode="lines", name=name, showlegend=show,
                line=dict(color=color, width=2.5 if pct==50 else 1.5,
                          dash="solid" if pct in (5,50,95) else "dot")))
        fig_p.add_hline(y=S0, line_dash="dash", line_color="rgba(255,255,255,0.2)", annotation_text="Entry")
        fig_p.update_layout(title="Simulated Paths", height=430, hovermode="x unified",
            font=dict(family="Lora, serif"), xaxis_title="Trading Days", yaxis_title=label,
            plot_bgcolor="rgba(0,0,0,0)", paper_bgcolor="rgba(0,0,0,0)",
            xaxis=dict(showgrid=True, gridcolor="rgba(128,128,128,0.1)"),
            yaxis=dict(showgrid=True, gridcolor="rgba(128,128,128,0.1)", tickprefix="$", tickformat=",.2f"),
            legend=dict(orientation="h", yanchor="bottom", y=1.02, xanchor="right", x=1))
        st.plotly_chart(fig_p, use_container_width=True)
    with col_dist:
        fig_h = go.Figure()
        fig_h.add_trace(go.Histogram(x=terminal, nbinsx=60, marker_color="#1f5673", opacity=0.85))
        # Stagger annotation heights so labels don't overlap when lines are close together
        vlines = []
        for pct, color, lbl in [(5,"#8c2e36","P5"),(50,"#c9a84c","Median"),(95,"#2f6b4b","P95")]:
            vlines.append((float(np.percentile(terminal, pct)), color, lbl))
        vlines.append((float(S0), "rgba(255,255,255,0.4)", "Entry"))
        vlines.sort(key=lambda x: x[0])
        y_levels = [0.97, 0.88, 0.79, 0.70]
        for (v, color, lbl), y_paper in zip(vlines, y_levels):
            fig_h.add_vline(x=v, line_color=color,
                            line_dash="dash" if lbl == "Entry" else "dot")
            fig_h.add_annotation(x=v, y=y_paper, yref="paper",
                                 text=f"{lbl}<br>${v:,.0f}" if lbl != "Entry" else "Entry",
                                 showarrow=False, xanchor="left", xshift=4,
                                 font=dict(color=color, size=11),
                                 bgcolor="rgba(15,22,36,0.7)", borderpad=2)
        fig_h.update_layout(title="Terminal Distribution", height=430, font=dict(family="Lora, serif"),
            xaxis_title="Final Value ($)", yaxis_title="Frequency",
            plot_bgcolor="rgba(0,0,0,0)", paper_bgcolor="rgba(0,0,0,0)",
            xaxis=dict(showgrid=True, gridcolor="rgba(128,128,128,0.1)", tickprefix="$", tickformat=",.0f"),
            yaxis=dict(showgrid=True, gridcolor="rgba(128,128,128,0.1)"), showlegend=False)
        st.plotly_chart(fig_h, use_container_width=True)
    return terminal

def _strategy_selector(key_prefix):
    """
    Renders strategy picker, plain description, and adjustable parameters.
    Returns (strategy_string, params_dict).
    """
    st.markdown("##### Strategy Overlay")

    DESCRIPTIONS = {
        "SMA Trend Following (50/200)":
            "Stays invested when the stock is trending up — price above its short-term average, "
            "which is itself above the long-term average. Steps to cash when the trend breaks down.",
        "RSI Mean Reversion (14)":
            "Steps out when a stock has risen too fast and looks overextended. "
            "Re-enters once momentum cools off. Works best in range-bound markets.",
        "6-Month Price Momentum":
            "Stays with stocks that have been going up over the past several months. "
            "Exits when the trend turns negative. Simple — what's been working keeps working.",
        "Value — Trailing P/E":
            "Favours stocks trading at lower valuations relative to earnings. "
            "Reduces or exits exposure when a stock looks expensive by P/E.",
        "Earnings Growth Momentum":
            "Tracks whether a company's profits are growing or shrinking quarter over quarter. "
            "Exits positions when earnings start declining meaningfully.",
    }

    strat = st.selectbox("Strategy", STRATEGIES, key=f"{key_prefix}_strategy")
    params = {}

    if strat != STRATEGIES[0]:
        st.caption(DESCRIPTIONS.get(strat, ""))
        with st.expander("Parameters & how it works", expanded=False):
            p1, p2, p3 = st.columns(3)

            if strat == "SMA Trend Following (50/200)":
                params["sma_fast"]       = p1.number_input("Fast SMA (days)", 5, 100, 50, 5,
                                                            key=f"{key_prefix}_sma_fast",
                                                            help="Shorter moving average — reacts quickly to recent price changes. "
                                                                 "Common values: 20, 50. Lower = more responsive but more noise.")
                params["sma_slow"]       = p2.number_input("Slow SMA (days)", 50, 400, 200, 10,
                                                            key=f"{key_prefix}_sma_slow",
                                                            help="Longer moving average — reflects the broader trend. "
                                                                 "Common values: 100, 200. Must be greater than Fast SMA.")
                params["bull_drift_adj"] = p3.number_input("Bullish drift adj (%)", 0.0, 15.0, 6.0, 0.5,
                                                            key=f"{key_prefix}_bull_adj",
                                                            help="Extra annualised drift added to the GBM when in an uptrend (fast > slow). "
                                                                 "E.g. +6% shifts simulated paths upward to reflect positive momentum.")
                _, p4, _ = st.columns(3)
                params["bear_drift_adj"] = p4.number_input("Bearish drift adj (%)", -15.0, 0.0, -6.0, 0.5,
                                                            key=f"{key_prefix}_bear_adj",
                                                            help="Drift penalty applied when in a downtrend (fast < slow). "
                                                                 "Should be negative. E.g. −6% pulls simulated paths downward.")
                _f = int(params["sma_fast"]); _s = int(params["sma_slow"])
                _ba = params["bull_drift_adj"]; _da = params["bear_drift_adj"]
                st.info(
                    f"**What it trades:**\n\n"
                    f" **Buy / stay invested** — when the {_f}-day SMA crosses above the {_s}-day SMA "
                    f"('Golden Cross'). Drift is boosted by +{_ba:.1f}% per year in the simulation. "
                    f"A weak uptrend (price above {_s}-day but {_f}-day not yet above) applies a reduced +{_ba*0.4:.1f}% boost.\n\n"
                    f" **Sell / go to cash** — when the {_f}-day SMA crosses below the {_s}-day SMA "
                    f"('Death Cross'). Drift is penalised by {_da:.1f}% per year. "
                    f"A weak downtrend applies a reduced {_da*0.4:.1f}% penalty."
                )

            elif strat == "RSI Mean Reversion (14)":
                params["rsi_period"]   = p1.number_input("RSI period (days)", 5, 30, 14, 1,
                                                          key=f"{key_prefix}_rsi_period",
                                                          help="Number of days used to compute RSI. "
                                                               "14 is the standard Wilder setting. Lower values are more sensitive; higher values smoother.")
                params["overbought"]   = p2.number_input("Overbought level", 55.0, 90.0, 70.0, 1.0,
                                                          key=f"{key_prefix}_ob",
                                                          help="RSI level above which the stock is considered overbought. "
                                                               "Signal steps toward cash when RSI exceeds this. Classic value: 70.")
                params["oversold"]     = p3.number_input("Oversold level", 10.0, 45.0, 30.0, 1.0,
                                                          key=f"{key_prefix}_os",
                                                          help="RSI level below which the stock is considered oversold. "
                                                               "Signal re-enters when RSI drops below this. Classic value: 30.")
                p4, p5, _ = st.columns(3)
                params["ob_drift_adj"] = p4.number_input("Overbought drift adj (%)", -15.0, 0.0, -7.0, 0.5,
                                                          key=f"{key_prefix}_ob_adj",
                                                          help="Drift penalty applied when RSI is overbought. Should be negative — "
                                                               "pulls simulated paths lower to reflect likely mean reversion.")
                params["os_drift_adj"] = p5.number_input("Oversold drift adj (%)", 0.0, 15.0, 7.0, 0.5,
                                                          key=f"{key_prefix}_os_adj",
                                                          help="Drift boost applied when RSI is oversold. Should be positive — "
                                                               "shifts simulated paths higher to reflect likely bounce.")
                _rp = int(params["rsi_period"]); _ob = params["overbought"]; _os = params["oversold"]
                _oba = params["ob_drift_adj"]; _osa = params["os_drift_adj"]
                _ob_sev = _ob + (100 - _ob) * 0.33; _os_sev = _os - _os * 0.33
                st.info(
                    f"**What it trades (based on {_rp}-day RSI):**\n\n"
                    f" **Stay invested / re-enter** — RSI is between {_os:.0f} and {_ob:.0f} (neutral zone). "
                    f"No drift adjustment is applied.\n\n"
                    f" **Oversold bounce** — RSI drops below {_os:.0f}: apply +{_osa:.1f}% drift boost. "
                    f"RSI below {_os_sev:.0f} (severely oversold): full +{_osa:.1f}% boost.\n\n"
                    f" **Sell / reduce exposure** — RSI rises above {_ob:.0f} (overbought): apply {_oba:.1f}% drift penalty. "
                    f"RSI above {_ob_sev:.0f} (severely overbought): full {_oba:.1f}% penalty. "
                    f"Works best in range-bound markets, not strong trending ones."
                )

            elif strat == "6-Month Price Momentum":
                params["lookback_days"]   = p1.number_input("Lookback (days)", 21, 252, 126, 5,
                                                             key=f"{key_prefix}_lookback",
                                                             help="How far back to measure price return. "
                                                                  "126 ≈ 6 months, 252 ≈ 1 year. Shorter windows are noisier; longer capture bigger trends.")
                params["threshold_pct"]   = p2.number_input("Entry threshold (%)", -20.0, 20.0, 0.0, 0.5,
                                                             key=f"{key_prefix}_thresh",
                                                             help="Minimum return over the lookback period required to stay invested. "
                                                                  "0% = stay in as long as positive. Raise to require stronger momentum before entering.")
                params["adj_scale"]       = p3.number_input("Drift sensitivity", 0.05, 0.5, 0.25, 0.05,
                                                             key=f"{key_prefix}_adj_scale",
                                                             help="Scales how strongly momentum translates into a drift adjustment. "
                                                                  "E.g. 0.25 means a +20% 6-month return adds +5% annualised drift (20 × 0.25).")
                _, p4, _ = st.columns(3)
                params["adj_cap"]         = p4.number_input("Max drift adj (%)", 1.0, 20.0, 8.0, 0.5,
                                                             key=f"{key_prefix}_adj_cap",
                                                             help="Maximum absolute drift adjustment allowed in either direction. "
                                                                  "Prevents extreme momentum from dominating the simulation.")
                _lb = int(params["lookback_days"]); _thr = params["threshold_pct"]
                _sc = params["adj_scale"]; _cap = params["adj_cap"]
                _ex_ret = 20.0; _ex_adj = min(_ex_ret * _sc, _cap)
                st.info(
                    f"**What it trades (measuring return over the past {_lb} days):**\n\n"
                    f" **Buy / stay invested** — {_lb}-day return is above {_thr:+.1f}%. "
                    f"Drift is boosted proportionally: e.g. a +{_ex_ret:.0f}% return → +{_ex_adj:.1f}% drift boost (capped at +{_cap:.1f}%).\n\n"
                    f" **Sell / go to cash** — {_lb}-day return falls below {_thr:+.1f}%. "
                    f"Drift penalty mirrors the return scaled by {_sc} (capped at −{_cap:.1f}%). "
                    f"Signal resets each day, so the position switches back as soon as momentum recovers."
                )

            elif strat == "Value — Trailing P/E":
                params["pe_deep_value"]   = p1.number_input("Deep value P/E below", 1.0, 25.0, 12.0, 1.0,
                                                             key=f"{key_prefix}_pe_dv",
                                                             help="P/E below this level is considered deep value — maximum bullish drift is applied. "
                                                                  "Historically, stocks with P/E < 10–15 have been considered cheap.")
                params["pe_fair_value"]   = p2.number_input("Fair value P/E below", 5.0, 50.0, 20.0, 1.0,
                                                             key=f"{key_prefix}_pe_fv",
                                                             help="P/E below this is considered fairly valued — half the bullish drift boost is applied. "
                                                                  "S&P 500 long-run average P/E is around 15–20.")
                params["pe_in_threshold"] = p3.number_input("Exit above this P/E", 10.0, 100.0, 35.0, 1.0,
                                                             key=f"{key_prefix}_pe_in",
                                                             help="Step to cash and apply a bearish drift penalty when trailing P/E exceeds this level. "
                                                                  "Above this the stock is considered expensive.")
                p4, p5, _ = st.columns(3)
                params["pe_expensive"]    = p4.number_input("Very expensive P/E above", 20.0, 200.0, 50.0, 5.0,
                                                             key=f"{key_prefix}_pe_exp",
                                                             help="P/E above this level is considered severely overvalued — maximum bearish drift penalty is applied.")
                params["bull_drift_adj"]  = p5.number_input("Max bullish drift adj (%)", 0.0, 15.0, 6.0, 0.5,
                                                             key=f"{key_prefix}_pe_bull",
                                                             help="Drift boost added to GBM when the stock is in deep-value territory (P/E < deep value threshold).")
                _, p6, _ = st.columns(3)
                params["bear_drift_adj"]  = p6.number_input("Max bearish drift adj (%)", -15.0, 0.0, -6.0, 0.5,
                                                             key=f"{key_prefix}_pe_bear",
                                                             help="Drift penalty applied when the stock is expensive (P/E > exit threshold). Should be negative.")
                _dv = params["pe_deep_value"]; _fv = params["pe_fair_value"]
                _in = params["pe_in_threshold"]; _exp = params["pe_expensive"]
                _bull = params["bull_drift_adj"]; _bear = params["bear_drift_adj"]
                st.info(
                    f"**What it trades (using trailing P/E ratio):**\n\n"
                    f" **Deep value — max buy** — P/E < {_dv:.0f}: stay fully invested, drift +{_bull:.1f}% per year.\n\n"
                    f" **Fair value — hold** — P/E {_dv:.0f}–{_fv:.0f}: stay invested, drift +{_bull*0.5:.1f}% (half boost).\n\n"
                    f" **Neutral** — P/E {_fv:.0f}–{_in:.0f}: stay invested, no drift adjustment.\n\n"
                    f" **Expensive — reduce** — P/E {_in:.0f}–{_exp:.0f}: go to cash, drift {_bear*0.5:.1f}% per year.\n\n"
                    f" **Very expensive — sell** — P/E > {_exp:.0f}: go to cash, drift {_bear:.1f}% (full penalty). "
                    f"Note: P/E is a snapshot — this strategy updates whenever the app reruns, not daily."
                )

            elif strat == "Earnings Growth Momentum":
                params["exit_threshold_pct"] = p1.number_input("Exit when EPS growth below (%)", -30.0, 0.0, -5.0, 0.5,
                                                                key=f"{key_prefix}_eps_thresh",
                                                                help="Step to cash when quarterly EPS growth (YoY) falls below this level. "
                                                                     "E.g. −5% means exit if earnings have declined more than 5% vs a year ago.")
                params["adj_scale"]          = p2.number_input("Drift sensitivity", 10.0, 120.0, 60.0, 5.0,
                                                                key=f"{key_prefix}_eps_scale",
                                                                help="Multiplier applied to the EPS growth rate to produce a drift adjustment. "
                                                                     "E.g. scale=60 with +10% EPS growth → +6% drift boost (0.10 × 60).")
                params["adj_cap"]            = p3.number_input("Max drift adj (%)", 1.0, 20.0, 10.0, 0.5,
                                                                key=f"{key_prefix}_eps_cap",
                                                                help="Maximum absolute drift adjustment in either direction. "
                                                                     "Prevents extreme EPS swings from producing unrealistic simulation paths.")
                _thr = params["exit_threshold_pct"]; _sc = params["adj_scale"]; _cap = params["adj_cap"]
                _ex_eg = 10.0; _ex_adj = min(_ex_eg / 100 * _sc, _cap)
                st.info(
                    f"**What it trades (using quarterly EPS growth vs prior year):**\n\n"
                    f" **Buy / stay invested** — EPS growth is above {_thr:.1f}%. "
                    f"Drift is boosted proportionally: e.g. +{_ex_eg:.0f}% EPS growth → +{_ex_adj:.1f}% drift boost (capped at +{_cap:.1f}%).\n\n"
                    f" **Sell / go to cash** — EPS growth falls below {_thr:.1f}% "
                    f"(earnings down more than {abs(_thr):.1f}% vs a year ago). "
                    f"Drift penalty applied symmetrically (capped at −{_cap:.1f}%). "
                    f"Signal is updated from live Yahoo Finance data each session — it reflects the most recent reported quarter."
                )

    return strat, params

def render_monte_carlo():
    st.header("Monte Carlo Price Path Simulator")
    st.caption("GBM simulation — single asset or correlated portfolio, with optional technical/fundamental strategy overlay.")

    mode = st.radio("Mode", ["Single Asset", "Portfolio"], horizontal=True, key="mc_mode")
    st.markdown("---")

    if mode == "Single Asset":
        st.session_state.setdefault("mc_spot",  100.0)
        st.session_state.setdefault("mc_vol",    25.0)
        st.session_state.setdefault("mc_drift",   8.0)

        r1, r2 = st.columns([3, 1])
        mc_ticker = r1.text_input("Ticker", value="SPY", key="mc_ticker")
        if r2.button("Fetch Price & Vol", use_container_width=True, key="mc_fetch_sa"):
            with st.spinner("Fetching..."):
                h = get_yf_market_data(mc_ticker.strip().upper())
            if not h.empty:
                st.session_state["mc_spot"] = round(float(h["close"].iloc[-1]), 2)
                lr = np.log(h["close"] / h["close"].shift(1)).dropna()
                if len(lr) > 10:
                    st.session_state["mc_vol"] = round(float(lr.std() * np.sqrt(252) * 100), 1)
            else:
                st.toast(f"Could not fetch {mc_ticker.strip().upper()}", icon="")

        c1, c2, c3 = st.columns(3)
        spot  = c1.number_input("Spot Price ($)",        min_value=0.01, step=1.0,   key="mc_spot")
        vol   = c2.number_input("Annual Volatility (%)", min_value=0.1,  step=0.5,   key="mc_vol",
                                help="Annualised standard deviation of daily log-returns. "
                                     "Controls the width of the path fan — higher vol = wider spread of outcomes. "
                                     "Click Fetch to pull the historical figure from Yahoo Finance.")
        drift = c3.number_input("Annual Drift (%)",      min_value=-50.0, max_value=100.0, step=0.5, key="mc_drift",
                                help="Expected annualised return — the centre of the distribution. "
                                     "This is your assumption about where the stock is headed on average, "
                                     "before randomness is applied. "
                                     "A strategy overlay below will shift this up or down based on a live signal.")
        st.caption(
            f"Drift sets the median path: at {st.session_state.get('mc_drift', 8.0):.1f}% drift over 252 days "
            f"the median simulated price is roughly ${st.session_state.get('mc_spot', 100.0) * (1 + st.session_state.get('mc_drift', 8.0)/100):.2f}. "
            "Volatility then spreads paths around that centre — it does not change the median."
        )

    else:  # Portfolio
        n_assets = st.slider("Number of assets", 2, 8,
                             value=st.session_state.get("mc_n_assets", 4), key="mc_n_assets")

        wt_mode = st.radio("Position sizing", ["Weight %", "Dollar value ($)"],
                           horizontal=True, key="mc_wt_mode",
                           help="Switch between entering portfolio weights (%) or the actual dollar value of each position. "
                                "Dollar values are converted to weights automatically.")

        mc_tickers  = []
        mc_weights  = []
        mc_drifts   = []
        mc_vols_inp = []

        defaults = [
            ("SPY",     40.0, 8.0,  15.0, 40_000.0),
            ("QQQ",     30.0, 10.0, 18.0, 30_000.0),
            ("GLD",     15.0, 4.0,  12.0, 15_000.0),
            ("TLT",     15.0, 3.0,  10.0, 15_000.0),
            ("BTC-USD",  0.0, 20.0, 60.0,      0.0),
            ("AAPL",     0.0, 9.0,  22.0,      0.0),
            ("AMZN",     0.0, 11.0, 25.0,      0.0),
            ("IWM",      0.0, 7.0,  18.0,      0.0),
        ]

        use_dollars = (wt_mode == "Dollar value ($)")
        h2_label = "VALUE ($)" if use_dollars else "WEIGHT %"

        # Header row
        h1, h2, h3, h4, h5 = st.columns([2, 1, 1, 1, 0.6])
        h1.markdown(f"<small style='color:#5e768f'>TICKER</small>", unsafe_allow_html=True)
        h2.markdown(f"<small style='color:#5e768f'>{h2_label}</small>", unsafe_allow_html=True)
        h3.markdown("<small style='color:#5e768f'>DRIFT % /yr</small>", unsafe_allow_html=True)
        h4.markdown("<small style='color:#5e768f'>VOL % /yr</small>", unsafe_allow_html=True)
        h5.markdown("<small style='color:#5e768f'>FETCH</small>", unsafe_allow_html=True)

        for i in range(n_assets):
            def_tk, def_wt, def_dr, def_vl, def_val = defaults[i] if i < len(defaults) else ("", 0.0, 8.0, 20.0, 0.0)
            a1, a2, a3, a4, a5 = st.columns([2, 1, 1, 1, 0.6])
            tk = a1.text_input("", value=st.session_state.get(f"mc_tk_{i}", def_tk),
                               key=f"mc_tk_{i}", label_visibility="collapsed",
                               placeholder=f"Ticker {i+1}")
            if use_dollars:
                raw = a2.number_input("", value=st.session_state.get(f"mc_val_{i}", def_val),
                                      min_value=0.0, step=1000.0, format="%.0f",
                                      key=f"mc_val_{i}", label_visibility="collapsed")
                mc_weights.append(raw)
            else:
                wt = a2.number_input("", value=st.session_state.get(f"mc_wt_{i}", def_wt),
                                     min_value=0.0, max_value=100.0, step=1.0,
                                     key=f"mc_wt_{i}", label_visibility="collapsed")
                mc_weights.append(wt)
            dr = a3.number_input("", value=st.session_state.get(f"mc_dr_{i}", def_dr),
                                 min_value=-50.0, max_value=100.0, step=0.5,
                                 key=f"mc_dr_{i}", label_visibility="collapsed")
            vl = a4.number_input("", value=st.session_state.get(f"mc_vl_{i}", def_vl),
                                 min_value=0.1, max_value=200.0, step=0.5,
                                 key=f"mc_vl_{i}", label_visibility="collapsed")
            if a5.button("↻", key=f"mc_fetch_{i}", help=f"Fetch live vol for {tk}"):
                if tk.strip():
                    with st.spinner(f"Fetching {tk.strip().upper()}..."):
                        h = get_yf_market_data(tk.strip().upper())
                    if not h.empty:
                        lr = np.log(h["close"] / h["close"].shift(1)).dropna()
                        st.session_state[f"mc_vl_{i}"] = round(float(lr.std()*np.sqrt(252)*100), 1)
                        st.rerun()
            mc_tickers.append(tk.strip().upper())
            mc_drifts.append(dr)
            mc_vols_inp.append(vl)

        # Show computed weights when in dollar mode
        if use_dollars:
            total_val = sum(mc_weights)
            if total_val > 0:
                parts = []
                for i, (tk, val) in enumerate(zip(mc_tickers, mc_weights)):
                    if tk and val > 0:
                        parts.append(f"{tk} {val/total_val*100:.1f}%")
                st.caption(f"Total: ${total_val:,.0f}  —  {',  '.join(parts) if parts else 'no positions entered'}")
            else:
                st.caption("Enter dollar values above to see computed weights.")
        else:
            total_wt = sum(mc_weights)
            st.caption(f"Total weight entered: {total_wt:.1f}% — normalised to 100% automatically.")

    st.markdown("---")
    c4, c5 = st.columns(2)
    horizon = c4.slider("Time Horizon (trading days)", 5, 504,
                         st.session_state.get("mc_horizon_val", 252), 5, key="mc_horizon_val")
    n_sims  = c5.slider("Simulations", 200, 5000,
                         st.session_state.get("mc_nsims_val", 1000), 100, key="mc_nsims_val")

    st.markdown("---")
    c4, c5 = st.columns(2)
    horizon = c4.slider("Time Horizon (trading days)", 5, 504,
                         st.session_state.get("mc_horizon_val", 252), 5, key="mc_horizon_val")
    n_sims  = c5.slider("Simulations", 200, 5000,
                         st.session_state.get("mc_nsims_val", 1000), 100, key="mc_nsims_val")

    st.markdown("---")
    mc_strat, mc_params = _strategy_selector("mc")

    st.markdown("---")
    bench_col, _ = st.columns([1, 2])
    bench_col.text_input("Benchmark Ticker", value="SPY", key="mc_bench_ticker",
                         help="Ticker used as the benchmark comparison line in results (e.g. SPY, QQQ, AGG). "
                              "Its historical drift and volatility are estimated from 5 years of data.")
    run_btn = st.button("Run Simulation", use_container_width=True, key="mc_run")

    active_strat    = mc_strat
    active_params   = mc_params
    active_horizon  = horizon
    active_nsims    = n_sims
    active_bench_tk = st.session_state.get("mc_bench_ticker", "SPY").strip().upper() or "SPY"

    if not run_btn and "mc_paths" not in st.session_state:
        st.caption("Configure parameters above and click **Run Simulation**.")
        return

    # ── Simulation ────────────────────────────────────────────────────────────
    if run_btn:
        dt   = 1 / 252
        mode = st.session_state.get("mc_mode", "Single Asset")

        if mode == "Single Asset":
            mc_ticker_run = st.session_state.get("mc_ticker", "SPY")
            spot_run  = st.session_state.get("mc_spot",  100.0)
            vol_run   = st.session_state.get("mc_vol",    25.0)
            drift_run = st.session_state.get("mc_drift",   8.0)

            adj, _, sig_label, sig_detail = compute_strategy_data(
                mc_ticker_run.strip().upper(), active_strat, params=active_params)
            sigma = vol_run / 100

            # Strategy-adjusted paths
            mu    = (drift_run + adj) / 100
            Z         = np.random.normal(0, 1, (active_horizon, active_nsims))
            log_steps = (mu - 0.5*sigma**2)*dt + sigma*np.sqrt(dt)*Z
            paths     = np.vstack([np.full(active_nsims, spot_run),
                                   spot_run * np.exp(np.cumsum(log_steps, axis=0))])

            # Base paths — same params, no strategy drift adjustment
            mu_base       = drift_run / 100
            Z_base        = np.random.normal(0, 1, (active_horizon, active_nsims))
            log_steps_base = (mu_base - 0.5*sigma**2)*dt + sigma*np.sqrt(dt)*Z_base
            paths_nostrat  = np.vstack([np.full(active_nsims, spot_run),
                                        spot_run * np.exp(np.cumsum(log_steps_base, axis=0))])

            # Benchmark paths — fetched from historical data, normalised to same spot
            with st.spinner(f"Fetching {active_bench_tk} for benchmark..."):
                bench_h = get_yf_market_data(active_bench_tk)
            if not bench_h.empty and len(bench_h) > 50:
                _blr      = np.log(bench_h["close"] / bench_h["close"].shift(1)).dropna()
                bench_vol_r = float(_blr.std() * np.sqrt(252))
                bench_dr    = float(np.log(bench_h["close"].iloc[-1] / bench_h["close"].iloc[0])
                                    / (len(bench_h) / 252))
            else:
                bench_vol_r, bench_dr = 0.15, 0.08
            Z_bench        = np.random.normal(0, 1, (active_horizon, active_nsims))
            log_steps_bench = (bench_dr - 0.5*bench_vol_r**2)*dt + bench_vol_r*np.sqrt(dt)*Z_bench
            paths_bench    = np.vstack([np.full(active_nsims, spot_run),
                                        spot_run * np.exp(np.cumsum(log_steps_bench, axis=0))])

            st.session_state.update({
                "mc_paths": paths, "mc_paths_nostrat": paths_nostrat, "mc_paths_bench": paths_bench,
                "mc_spot_used": spot_run, "mc_bench_tk_saved": active_bench_tk,
                "mc_mode_saved": "single", "mc_sig_label": sig_label,
                "mc_sig_detail": sig_detail, "mc_adj": adj,
                "mc_strategy_saved": active_strat,
            })

        else:  # Portfolio
            n_a = st.session_state.get("mc_n_assets", 4)
            tickers  = [st.session_state.get(f"mc_tk_{i}", "").strip().upper() for i in range(n_a)]
            weights  = np.array([float(st.session_state.get(f"mc_wt_{i}", 0.0)) for i in range(n_a)])
            drifts_r = np.array([float(st.session_state.get(f"mc_dr_{i}", 8.0)) for i in range(n_a)])
            vols_r   = np.array([float(st.session_state.get(f"mc_vl_{i}", 20.0)) for i in range(n_a)])

            valid = [i for i, t in enumerate(tickers) if t and weights[i] > 0]
            if not valid:
                st.error("Add at least one asset with a non-zero weight.")
                st.stop()

            tickers  = [tickers[i]  for i in valid]
            weights  = weights[valid];  weights  = weights / weights.sum()
            drifts_r = drifts_r[valid] / 100
            vols_r   = vols_r[valid]   / 100
            n        = len(tickers)

            adj, _, sig_label, sig_detail = compute_strategy_data(tickers[0], active_strat, params=active_params)
            drifts_r_base = drifts_r.copy()          # original, no strategy adj
            drifts_r      = drifts_r + adj / 100     # strategy-adjusted

            # Batch-fetch 2-year history for correlation — one yf.download call
            with st.spinner("Fetching correlation data..."):
                try:
                    raw = yf.download(tickers,
                                      start=str(datetime.date.today() - datetime.timedelta(days=730)),
                                      end=str(datetime.date.today()),
                                      auto_adjust=True, progress=False)["Close"]
                    if isinstance(raw, pd.Series):
                        raw = raw.to_frame(tickers[0])
                    log_rets = np.log(raw / raw.shift(1)).dropna()
                    avail    = [t for t in tickers if t in log_rets.columns]
                    corr     = log_rets[avail].corr().reindex(index=tickers, columns=tickers).fillna(0).values
                except Exception:
                    corr = np.eye(n)

            corr = (corr + corr.T) / 2
            np.fill_diagonal(corr, 1.0)
            try:
                L = np.linalg.cholesky(corr)
            except np.linalg.LinAlgError:
                L = np.eye(n)

            # Strategy-adjusted portfolio paths
            Z_raw   = np.random.normal(0, 1, (n, active_horizon, active_nsims))
            corr_Z  = np.einsum("ij,jks->iks", L, Z_raw)
            log_ret = ((drifts_r - 0.5*vols_r**2)[:, None, None]*dt
                       + vols_r[:, None, None]*np.sqrt(dt)*corr_Z)
            cum_ret    = np.concatenate([np.zeros((n, 1, active_nsims)),
                                         np.cumsum(log_ret, axis=1)], axis=1)
            asset_paths = np.exp(cum_ret)
            paths       = np.einsum("i,ijk->jk", weights, asset_paths) * 100.0

            # Base portfolio paths (no strategy drift adjustment)
            Z_raw_b  = np.random.normal(0, 1, (n, active_horizon, active_nsims))
            corr_Z_b = np.einsum("ij,jks->iks", L, Z_raw_b)
            log_ret_b = ((drifts_r_base - 0.5*vols_r**2)[:, None, None]*dt
                         + vols_r[:, None, None]*np.sqrt(dt)*corr_Z_b)
            cum_ret_b   = np.concatenate([np.zeros((n, 1, active_nsims)),
                                          np.cumsum(log_ret_b, axis=1)], axis=1)
            paths_nostrat = np.einsum("i,ijk->jk", weights, np.exp(cum_ret_b)) * 100.0

            # Benchmark paths
            with st.spinner(f"Fetching {active_bench_tk} for benchmark..."):
                bench_h = get_yf_market_data(active_bench_tk)
            if not bench_h.empty and len(bench_h) > 50:
                _blr        = np.log(bench_h["close"] / bench_h["close"].shift(1)).dropna()
                bench_vol_r = float(_blr.std() * np.sqrt(252))
                bench_dr    = float(np.log(bench_h["close"].iloc[-1] / bench_h["close"].iloc[0])
                                    / (len(bench_h) / 252))
            else:
                bench_vol_r, bench_dr = 0.15, 0.08
            Z_bench         = np.random.normal(0, 1, (active_horizon, active_nsims))
            log_steps_bench = (bench_dr - 0.5*bench_vol_r**2)*dt + bench_vol_r*np.sqrt(dt)*Z_bench
            paths_bench     = np.vstack([np.full(active_nsims, 100.0),
                                         100.0 * np.exp(np.cumsum(log_steps_bench, axis=0))])

            st.session_state.update({
                "mc_paths": paths, "mc_paths_nostrat": paths_nostrat, "mc_paths_bench": paths_bench,
                "mc_spot_used": 100.0, "mc_bench_tk_saved": active_bench_tk,
                "mc_mode_saved": "portfolio", "mc_port_tickers": tickers,
                "mc_port_weights": weights.tolist(), "mc_asset_paths": asset_paths,
                "mc_sig_label": sig_label, "mc_sig_detail": sig_detail,
                "mc_adj": adj, "mc_strategy_saved": active_strat,
            })

    # ── Results ───────────────────────────────────────────────────────────────
    paths      = st.session_state["mc_paths"]
    S0         = st.session_state["mc_spot_used"]
    mode_sv    = st.session_state.get("mc_mode_saved", "single")
    sig_label  = st.session_state.get("mc_sig_label", "")
    sig_detail = st.session_state.get("mc_sig_detail", "")
    adj        = st.session_state.get("mc_adj", 0.0)
    strat_sv   = st.session_state.get("mc_strategy_saved", STRATEGIES[0])

    if strat_sv != STRATEGIES[0] and sig_label:
        color = "#2e7d4f" if adj >= 0 else "#8c2e36"
        st.markdown(
            f"<div style='padding:10px 14px;border-left:3px solid {color};"
            f"background:rgba(255,255,255,0.04);border-radius:4px;margin-bottom:10px'>"
            f"<b style='color:{color}'>{strat_sv} — {sig_label}</b>&nbsp;&nbsp;"
            f"<b style='color:{color}'>Drift adj: {adj:+.1f}%</b><br>"
            f"<span style='color:#8a9ab0;font-size:0.87rem'>{sig_detail}</span></div>",
            unsafe_allow_html=True)

    if mode_sv == "portfolio" and "mc_asset_paths" in st.session_state:
        tks = st.session_state["mc_port_tickers"]
        wts = st.session_state["mc_port_weights"]
        ap  = st.session_state["mc_asset_paths"]
        with st.expander("Individual Asset Median Paths", expanded=False):
            fig_a = go.Figure()
            for i, (tk, w) in enumerate(zip(tks, wts)):
                med = np.median(ap[i], axis=1) * 100
                fig_a.add_trace(go.Scatter(x=np.arange(len(med)), y=med, mode="lines",
                    name=f"{tk} ({w*100:.0f}%)",
                    line=dict(color=["#1f5673","#c9a84c","#2f6b4b","#8c2e36",
                                     "#7b5ea7","#d97736","#3d8eb9","#b5432a"][i % 8], width=2)))
            fig_a.update_layout(title="Median Path per Asset (normalised $100)",
                height=300, font=dict(family="Lora, serif"), xaxis_title="Trading Days",
                yaxis_title="Normalised Value ($)",
                plot_bgcolor="rgba(0,0,0,0)", paper_bgcolor="rgba(0,0,0,0)",
                xaxis=dict(showgrid=True, gridcolor="rgba(128,128,128,0.1)"),
                yaxis=dict(showgrid=True, gridcolor="rgba(128,128,128,0.1)", tickprefix="$"),
                legend=dict(orientation="h", yanchor="bottom", y=1.02, xanchor="right", x=1))
            st.plotly_chart(fig_a, use_container_width=True)

    terminal = _mc_draw_paths(paths, S0,
        label="Portfolio Value ($)" if mode_sv == "portfolio" else "Price ($)")
    _mc_risk_metrics(terminal, S0)

    paths_nostrat = st.session_state.get("mc_paths_nostrat")
    paths_bench   = st.session_state.get("mc_paths_bench")
    bench_tk_sv   = st.session_state.get("mc_bench_tk_saved", "SPY")
    _mc_comparison(paths, paths_nostrat, paths_bench, S0,
                   strat_sv if strat_sv != STRATEGIES[0] else "No Strategy",
                   bench_tk_sv)

def render_gex():
    st.header("Dealer GEX & Options Positioning")
    st.caption("Gamma Exposure (GEX) aggregated across all expiries. Positive net GEX = dealers long gamma (pin / mean-reversion). Negative = dealers short gamma (trend amplification).")

    with st.container(border=True):
        st.markdown("##### Parameters")
        col1, col2 = st.columns([2, 1])
        gex_ticker  = col1.text_input("Ticker", value="SPY", key="gex_ticker").strip().upper()
        spot_range  = col2.number_input("Strike range around spot (% each side)", value=15, min_value=5, max_value=50, step=5)
        run_gex     = st.button("Load GEX Profile", use_container_width=True)

    if run_gex:
        with st.spinner(f"Fetching all expiry chains for {gex_ticker} — this may take 20-40 seconds..."):
            spot, df_gex = get_gex_data(gex_ticker)

        if spot is None or df_gex.empty:
            st.error("Could not retrieve options data. Verify the ticker supports listed options.")
            st.stop()

        # Filter strikes to ±range% of spot
        lo = spot * (1 - spot_range / 100)
        hi = spot * (1 + spot_range / 100)
        df_plot = df_gex[(df_gex["strike"] >= lo) & (df_gex["strike"] <= hi)].copy()

        total_net   = float(df_gex["net_gex"].sum())
        total_call  = float(df_gex["call_gex"].sum())
        total_put   = float(df_gex["put_gex"].sum())

        # Gamma flip: first strike crossing from positive to negative net GEX
        cumulative  = df_gex.sort_values("strike")["net_gex"].cumsum().values
        strikes_all = df_gex.sort_values("strike")["strike"].values
        flip_level  = None
        for i in range(len(cumulative) - 1):
            if cumulative[i] * cumulative[i + 1] < 0:
                flip_level = float(strikes_all[i])
                break

        # Determine tick decimal places from actual strike spacing
        _strike_gaps = df_plot["strike"].sort_values().diff().dropna().abs()
        _min_gap = float(_strike_gaps.min()) if not _strike_gaps.empty else 1.0
        _tick_dec = 0 if _min_gap >= 1.0 else (1 if _min_gap >= 0.1 else 2)
        _strike_fmt = f",.{_tick_dec}f"
        _hover_fmt  = f"$%{{x:,.{_tick_dec}f}}"

        m1, m2, m3, m4 = st.columns(4)
        m1.metric("Spot Price",       f"${spot:,.2f}")
        m2.metric("Net GEX",          f"${total_net:+,.1f}M",
                  help="Positive = dealers long gamma. Negative = dealers short gamma.")
        m3.metric("Call GEX",         f"${total_call:+,.1f}M")
        m4.metric("Gamma Flip",
                  f"${flip_level:,.0f}" if flip_level else "N/A",
                  help="Strike where cumulative net GEX crosses zero — key support/resistance level.")
        st.divider()

        # ── Chart 1: Net GEX by strike ──────────────────────────────────────
        st.markdown("### Net Dealer GEX by Strike")
        st.caption("Bars show net gamma exposure at each strike. Green = positive (dealers long). Red = negative (dealers short). Tall bars = key price magnets or repulsion zones.")

        colors = ["#2e7d4f" if v >= 0 else "#8c2e36" for v in df_plot["net_gex"]]
        fig_net = go.Figure()
        fig_net.add_trace(go.Bar(
            x=df_plot["strike"], y=df_plot["net_gex"],
            marker_color=colors,
            name="Net GEX",
            hovertemplate=f"<b>Strike {_hover_fmt}</b><br>Net GEX: $%{{y:+,.2f}}M<extra></extra>"))
        fig_net.add_vline(x=spot, line_dash="dash", line_color="rgba(201,168,76,0.8)",
                          annotation_text=f"Spot ${spot:,.{_tick_dec}f}",
                          annotation_font_color="#c9a84c")
        if flip_level:
            fig_net.add_vline(x=flip_level, line_dash="dot", line_color="rgba(200,100,50,0.7)",
                              annotation_text=f"Flip ${flip_level:,.{_tick_dec}f}",
                              annotation_font_color="#d97736",
                              annotation_position="top left")
        fig_net.update_layout(
            height=420, bargap=0.1,
            xaxis=dict(title="Strike ($)", tickprefix="$", tickformat=_strike_fmt,
                       showgrid=True, gridcolor="rgba(128,128,128,0.1)"),
            yaxis=dict(title="Net GEX ($M)", tickprefix="$", tickformat=",.1f",
                       showgrid=True, gridcolor="rgba(128,128,128,0.1)"),
            font=dict(family="Lora, serif"),
            plot_bgcolor="rgba(0,0,0,0)", paper_bgcolor="rgba(0,0,0,0)",
            margin=dict(t=30, b=50, l=70, r=30),
            legend=dict(orientation="h", yanchor="bottom", y=1.02, xanchor="right", x=1))
        st.plotly_chart(fig_net, use_container_width=True)

        # ── Chart 2: Call vs Put GEX stacked ────────────────────────────────
        st.markdown("### Call vs Put GEX by Strike")
        st.caption("Call GEX (green) and put GEX (red) side-by-side. Large put GEX at a strike = strong support / dealers will buy dips there. Large call GEX = resistance / dealers sell rallies.")

        fig_cp = go.Figure()
        fig_cp.add_trace(go.Bar(
            x=df_plot["strike"], y=df_plot["call_gex"],
            name="Call GEX", marker_color="rgba(46,125,79,0.75)",
            hovertemplate=f"<b>Strike {_hover_fmt}</b><br>Call GEX: $%{{y:+,.2f}}M<extra></extra>"))
        fig_cp.add_trace(go.Bar(
            x=df_plot["strike"], y=df_plot["put_gex"],
            name="Put GEX", marker_color="rgba(140,46,54,0.75)",
            hovertemplate=f"<b>Strike {_hover_fmt}</b><br>Put GEX: $%{{y:+,.2f}}M<extra></extra>"))
        fig_cp.add_vline(x=spot, line_dash="dash", line_color="rgba(201,168,76,0.8)")
        if flip_level:
            fig_cp.add_vline(x=flip_level, line_dash="dot", line_color="rgba(200,100,50,0.7)")
        fig_cp.update_layout(
            barmode="relative", height=400, bargap=0.1,
            xaxis=dict(title="Strike ($)", tickprefix="$", tickformat=_strike_fmt,
                       showgrid=True, gridcolor="rgba(128,128,128,0.1)"),
            yaxis=dict(title="GEX ($M)", tickprefix="$", tickformat=",.1f",
                       showgrid=True, gridcolor="rgba(128,128,128,0.1)"),
            font=dict(family="Lora, serif"),
            plot_bgcolor="rgba(0,0,0,0)", paper_bgcolor="rgba(0,0,0,0)",
            margin=dict(t=30, b=50, l=70, r=30),
            legend=dict(orientation="h", yanchor="bottom", y=1.02, xanchor="right", x=1))
        st.plotly_chart(fig_cp, use_container_width=True)

        # ── Chart 3: Open Interest walls ─────────────────────────────────────
        st.markdown("### Open Interest Walls")
        st.caption("Raw OI aggregated across all expiries. High OI strikes act as gravitational price levels — markets tend to pin near large OI clusters heading into expiry.")

        try:
            tkr_obj = yf.Ticker(gex_ticker)
            oi_rows = []
            for exp in (tkr_obj.options or []):
                try:
                    ch = tkr_obj.option_chain(exp)
                    for side, df_s in [("call", ch.calls), ("put", ch.puts)]:
                        df_s = df_s[["strike", "openInterest"]].dropna()
                        df_s = df_s[df_s["openInterest"] > 0]
                        df_s["side"] = side
                        oi_rows.append(df_s)
                except Exception:
                    continue
            if oi_rows:
                df_oi = pd.concat(oi_rows)
                df_oi_piv = (df_oi.groupby(["strike", "side"])["openInterest"].sum()
                             .unstack(fill_value=0))
                for c in ["call", "put"]:
                    if c not in df_oi_piv.columns:
                        df_oi_piv[c] = 0
                df_oi_piv = df_oi_piv.reset_index()
                df_oi_piv = df_oi_piv[(df_oi_piv["strike"] >= lo) & (df_oi_piv["strike"] <= hi)]

                fig_oi = go.Figure()
                fig_oi.add_trace(go.Bar(
                    x=df_oi_piv["strike"], y=df_oi_piv["call"] / 1e3,
                    name="Call OI", marker_color="rgba(46,125,79,0.65)",
                    hovertemplate=f"<b>Strike {_hover_fmt}</b><br>Call OI: %{{y:,.0f}}K<extra></extra>"))
                fig_oi.add_trace(go.Bar(
                    x=df_oi_piv["strike"], y=-df_oi_piv["put"] / 1e3,
                    name="Put OI", marker_color="rgba(140,46,54,0.65)",
                    hovertemplate=f"<b>Strike {_hover_fmt}</b><br>Put OI: %{{y:,.0f}}K<extra></extra>"))
                fig_oi.add_vline(x=spot, line_dash="dash", line_color="rgba(201,168,76,0.8)",
                                 annotation_text=f"Spot ${spot:,.{_tick_dec}f}",
                                 annotation_font_color="#c9a84c")
                fig_oi.update_layout(
                    barmode="overlay", height=400, bargap=0.05,
                    xaxis=dict(title="Strike ($)", tickprefix="$", tickformat=_strike_fmt,
                               showgrid=True, gridcolor="rgba(128,128,128,0.1)"),
                    yaxis=dict(title="Open Interest (000s)",
                               showgrid=True, gridcolor="rgba(128,128,128,0.1)"),
                    font=dict(family="Lora, serif"),
                    plot_bgcolor="rgba(0,0,0,0)", paper_bgcolor="rgba(0,0,0,0)",
                    margin=dict(t=30, b=50, l=70, r=30),
                    legend=dict(orientation="h", yanchor="bottom", y=1.02, xanchor="right", x=1))
                st.plotly_chart(fig_oi, use_container_width=True)
        except Exception as _oi_err:
            st.caption(f"OI wall chart unavailable: {_oi_err}")

tab_map = {
    "Finance Dashboard":         render_home,
    "Market Data":               render_market,
    "Options Pricer":            render_options,
    "Bond Analytics":            render_bond,
    "NAV Proxy Tracker":         render_nav,
    "Portfolio Backtester":      render_portfolio,
    "Options Implied Probability": render_prob,
    "Fed Rate Projections":      render_fed,
    "Earnings Calendar":         render_earnings,
    "DCF Valuation":             render_dcf,
    "Options Chain Scanner":     render_chain,
    "Correlation Matrix":        render_correlation,
    "Strategy Builder":          render_strategy_builder,
    "Monte Carlo Simulator":     render_monte_carlo,
    "Dealer GEX":                render_gex,
}

if selected_tab in tab_map:
    safe_tab(tab_map[selected_tab])