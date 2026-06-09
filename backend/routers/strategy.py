import logging
logger = logging.getLogger(__name__)

"""
Strategy signal computation for backtester and Monte Carlo overlays.
Each strategy returns a daily signal (1=invested, 0=cash) and a drift adjustment (%).
"""
import numpy as np
import pandas as pd
import yfinance as yf
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, field_validator, model_validator
import sys, os
sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))
from validation import validate_ticker, validate_date

router = APIRouter()

STRATEGIES = [
    "None (Base GBM / Buy & Hold)",
    "SMA Trend Following (50/200)",
    "RSI Mean Reversion (14)",
    "6-Month Price Momentum",
    "Bollinger Breakout (20,2)",
    "MACD Crossover (12,26,9)",
    "Value — Trailing P/E",
    "Earnings Growth Momentum",
]


def _fetch_close(ticker: str, start: str, end: str) -> pd.Series:
    tkr = yf.Ticker(ticker.strip().upper())
    hist = tkr.history(start=start, end=end)
    if hist.empty:
        return pd.Series(dtype=float)
    if hist.index.tz is not None:
        hist.index = hist.index.tz_localize(None)
    return hist["Close"].dropna()


def compute_signal(close: pd.Series, strategy: str, params: dict) -> tuple[pd.Series, float, str, str]:
    """Returns (signal_series, drift_adj_pct, label, detail)."""
    p = params or {}
    empty = pd.Series(dtype=float)

    if strategy == "None (Base GBM / Buy & Hold)" or len(close) < 20:
        return empty, 0.0, "Buy & Hold", "No strategy filter applied."

    if strategy == "SMA Trend Following (50/200)":
        fast = int(p.get("sma_fast", 50))
        slow = int(p.get("sma_slow", 200))
        bull = float(p.get("bull_drift_adj", 6.0))
        bear = float(p.get("bear_drift_adj", -6.0))
        sma_f = close.rolling(fast, min_periods=max(10, fast // 3)).mean()
        sma_s = close.rolling(slow, min_periods=max(20, slow // 4)).mean()
        sig = ((close > sma_f) & (sma_f > sma_s)).astype(float).fillna(0.0)
        cur, cf, cs = float(close.iloc[-1]), float(sma_f.iloc[-1]), float(sma_s.iloc[-1])
        if cur > cf and cf > cs:      adj, label = bull,        "Uptrend"
        elif cur > cs:                adj, label = bull * 0.4,  "Weak Uptrend"
        elif cur < cf and cf < cs:    adj, label = bear,        "Downtrend"
        else:                         adj, label = bear * 0.4,  "Weak Downtrend"
        detail = f"Price ${cur:.2f} | SMA{fast} ${cf:.2f} | SMA{slow} ${cs:.2f} — {label} (drift {adj:+.1f}%)"
        return sig, adj, label, detail

    if strategy == "RSI Mean Reversion (14)":
        period  = int(p.get("rsi_period", 14))
        ob      = float(p.get("overbought", 70))
        os_     = float(p.get("oversold", 30))
        ob_adj  = float(p.get("ob_drift_adj", -7.0))
        os_adj  = float(p.get("os_drift_adj", 7.0))
        delta = close.diff()
        gain  = delta.clip(lower=0).rolling(period, min_periods=period // 2).mean()
        loss  = (-delta.clip(upper=0)).rolling(period, min_periods=period // 2).mean()
        rsi   = 100 - 100 / (1 + gain / loss.replace(0, 1e-9))
        sig   = (rsi < ob).astype(float).fillna(1.0)
        cur_rsi = float(rsi.iloc[-1]) if not pd.isna(rsi.iloc[-1]) else 50.0
        ob_sev = ob + (100 - ob) * 0.33
        os_sev = os_ - os_ * 0.33
        if cur_rsi >= ob_sev:       adj, label = ob_adj,        "Severely Overbought"
        elif cur_rsi >= ob:         adj, label = ob_adj * 0.43, "Overbought"
        elif cur_rsi <= os_sev:     adj, label = os_adj,        "Severely Oversold"
        elif cur_rsi <= os_:        adj, label = os_adj * 0.43, "Oversold"
        else:                       adj, label = 0.0,           "Neutral"
        detail = f"RSI({period}) = {cur_rsi:.1f} — {label} (drift {adj:+.1f}%)"
        return sig, adj, label, detail

    if strategy == "6-Month Price Momentum":
        lb      = int(p.get("lookback_days", 126))
        scale   = float(p.get("adj_scale", 0.25))
        cap     = float(p.get("adj_cap", 8.0))
        thresh  = float(p.get("threshold_pct", 0.0)) / 100
        mom_raw = close / close.shift(lb) - 1
        sig     = (mom_raw > thresh).astype(float).fillna(0.0)
        mom     = float(mom_raw.iloc[-1]) * 100 if not pd.isna(mom_raw.iloc[-1]) else 0.0
        adj     = float(np.clip(mom * scale, -cap, cap))
        label   = "Positive Momentum" if mom > thresh * 100 else "Negative Momentum"
        detail  = f"{lb}-day return {mom:+.1f}% — {label} (drift {adj:+.1f}%)"
        return sig, adj, label, detail

    if strategy == "Bollinger Breakout (20,2)":
        period  = int(p.get("bb_period", 20))
        std_dev = float(p.get("bb_std", 2.0))
        bull    = float(p.get("bull_drift_adj", 5.0))
        bear    = float(p.get("bear_drift_adj", -3.0))
        mid     = close.rolling(period).mean()
        std     = close.rolling(period).std()
        upper   = mid + std_dev * std
        lower   = mid - std_dev * std
        sig     = pd.Series(0.0, index=close.index)
        in_trade = False
        for i in range(period, len(close)):
            if not in_trade and close.iloc[i] > upper.iloc[i]:
                in_trade = True
            elif in_trade and close.iloc[i] < lower.iloc[i]:
                in_trade = False
            sig.iloc[i] = 1.0 if in_trade else 0.0
        last = float(sig.iloc[-1]) if not sig.empty else 0.0
        adj   = bull if last == 1.0 else bear
        label = "Breakout Active" if last == 1.0 else "No Breakout"
        detail = f"BB({period}, ±{std_dev}σ). {'Price above upper band — long.' if last else 'Price below lower band — cash.'} Drift {adj:+.1f}%."
        return sig, adj, label, detail

    if strategy == "MACD Crossover (12,26,9)":
        fast_p  = int(p.get("macd_fast", 12))
        slow_p  = int(p.get("macd_slow", 26))
        sig_p   = int(p.get("macd_signal", 9))
        bull    = float(p.get("bull_drift_adj", 5.0))
        bear    = float(p.get("bear_drift_adj", -4.0))
        ema_f   = close.ewm(span=fast_p, adjust=False).mean()
        ema_s   = close.ewm(span=slow_p, adjust=False).mean()
        macd    = ema_f - ema_s
        sig_ln  = macd.ewm(span=sig_p, adjust=False).mean()
        hist    = macd - sig_ln
        sig     = (macd > sig_ln).astype(float)
        last    = float(sig.iloc[-1]) if not sig.empty else 0.0
        adj     = bull if last == 1.0 else bear
        label   = "MACD Bullish" if last == 1.0 else "MACD Bearish"
        detail  = f"EMA({fast_p})–EMA({slow_p}) vs Signal({sig_p}). Histogram {float(hist.iloc[-1]):+.3f}. Drift {adj:+.1f}%."
        return sig, adj, label, detail

    if strategy == "Value — Trailing P/E":
        pe_dv   = float(p.get("pe_deep_value", 12.0))
        pe_fv   = float(p.get("pe_fair_value", 20.0))
        pe_in   = float(p.get("pe_in_threshold", 35.0))
        pe_exp  = float(p.get("pe_expensive", 50.0))
        bull    = float(p.get("bull_drift_adj", 6.0))
        bear    = float(p.get("bear_drift_adj", -6.0))
        tkr_sym = close.name or "UNKNOWN"
        try:
            info = yf.Ticker(str(tkr_sym)).info
            pe   = info.get("trailingPE") or info.get("forwardPE")
        except Exception:
            pe = None
        if pe is None or pe <= 0:
            return empty, 0.0, "P/E Unavailable", "No P/E data."
        if   pe < pe_dv:  adj, label = bull,       "Deep Value"
        elif pe < pe_fv:  adj, label = bull * 0.5, "Fairly Valued"
        elif pe < pe_in:  adj, label = 0.0,        "Neutral"
        elif pe < pe_exp: adj, label = bear * 0.5, "Expensive"
        else:             adj, label = bear,        "Very Expensive"
        sig_v = 1.0 if pe < pe_in else 0.0
        sig   = pd.Series(sig_v, index=close.index)
        detail = f"Trailing P/E = {pe:.1f} — {label} (drift {adj:+.1f}%)"
        return sig, adj, label, detail

    if strategy == "Earnings Growth Momentum":
        exit_t = float(p.get("exit_threshold_pct", -5.0)) / 100
        scale  = float(p.get("adj_scale", 60.0))
        cap    = float(p.get("adj_cap", 10.0))
        tkr_sym = close.name or "UNKNOWN"
        try:
            info = yf.Ticker(str(tkr_sym)).info
            eg   = info.get("earningsQuarterlyGrowth")
        except Exception:
            eg = None
        if eg is None:
            return empty, 0.0, "EPS Unavailable", "No quarterly earnings growth data."
        adj     = float(np.clip(eg * scale, -cap, cap))
        sig_v   = 1.0 if eg > exit_t else 0.0
        sig     = pd.Series(sig_v, index=close.index)
        label   = f"EPS Growth {eg*100:+.1f}%"
        detail  = f"Quarterly EPS growth {eg*100:+.1f}% — {label} (drift {adj:+.1f}%)"
        return sig, adj, label, detail

    return pd.Series(dtype=float), 0.0, "No Signal", ""


class StrategyRequest(BaseModel):
    ticker: str
    strategy: str
    start: str = "2020-01-01"
    end: str = "2024-12-31"
    params: dict = {}

    @field_validator('strategy')
    @classmethod
    def _valid_strategy(cls, v):
        if v not in STRATEGIES:
            raise ValueError(f"Unknown strategy")
        return v

    @model_validator(mode='after')
    def _validate(self):
        self.ticker = validate_ticker(self.ticker)
        validate_date(self.start); validate_date(self.end)
        return self


@router.post("/signal")
def get_strategy_signal(req: StrategyRequest):
    if req.strategy == "None (Base GBM / Buy & Hold)":
        return {"signal": [], "drift_adj": 0.0, "label": "Buy & Hold", "detail": "No filter applied."}
    try:
        close = _fetch_close(req.ticker, req.start, req.end)
        close.name = req.ticker.strip().upper()
        if close.empty:
            raise HTTPException(404, "No price data")
    except HTTPException:
        raise
    except Exception as e:
        logger.exception("internal error"); raise HTTPException(500, "Internal server error")

    sig, adj, label, detail = compute_signal(close, req.strategy, req.params)
    signal_list = []
    if not sig.empty:
        signal_list = [{"date": str(d.date()), "value": float(v)} for d, v in sig.items()]
    return {"signal": signal_list, "drift_adj": round(adj, 2), "label": label, "detail": detail}


@router.get("/list")
def list_strategies():
    return {"strategies": STRATEGIES}
