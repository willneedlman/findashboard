import logging
logger = logging.getLogger(__name__)

"""
Strategy signal computation for backtester and Monte Carlo overlays.
Each strategy returns a daily signal (1=invested, 0=cash) and a drift adjustment (%).
"""
import numpy as np
import pandas as pd
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, field_validator, model_validator
import sys, os
sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))
from validation import validate_ticker, validate_date
from cache import get_history, get_info
from strategies.indicators import get_indicator as _get_ind

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
    "EMA Micro-Scalp (3/8)",
]


def _fetch_close(ticker: str, start: str, end: str) -> pd.Series:
    hist = get_history(ticker, start=start, end=end)
    if hist.empty:
        return pd.Series(dtype=float)
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
            info = get_info(str(tkr_sym))
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
            info = get_info(str(tkr_sym))
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

    if strategy == "EMA Micro-Scalp (3/8)":
        fast_p  = int(p.get("ema_fast", 3))
        slow_p  = int(p.get("ema_slow", 8))
        atr_per = int(p.get("atr_period", 5))
        atr_mul = float(p.get("atr_mult", 0.3))
        bull    = float(p.get("bull_drift_adj", 8.0))
        bear    = float(p.get("bear_drift_adj", -5.0))
        ema_f   = close.ewm(span=fast_p, adjust=False).mean()
        ema_s   = close.ewm(span=slow_p, adjust=False).mean()
        # ATR filter: suppress signal when market is too quiet
        tr      = close.diff().abs()
        atr     = tr.rolling(atr_per, min_periods=1).mean()
        atr_pct = atr / close * 100
        atr_ok  = (atr_pct >= atr_mul) if atr_mul > 0 else pd.Series(True, index=close.index)
        sig     = ((ema_f > ema_s) & atr_ok).astype(float)
        last    = float(sig.iloc[-1]) if not sig.empty else 0.0
        adj     = bull if last == 1.0 else bear
        last_f  = float(ema_f.iloc[-1]); last_s = float(ema_s.iloc[-1])
        label   = "EMA Bullish" if last == 1.0 else "EMA Bearish"
        detail  = (f"EMA({fast_p}) ${last_f:.2f} vs EMA({slow_p}) ${last_s:.2f} — {label}. "
                   f"ATR({atr_per}) {float(atr_pct.iloc[-1]):.2f}% (min {atr_mul}%). Drift {adj:+.1f}%.")
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
    except Exception:
        logger.exception("internal error"); raise HTTPException(500, "Internal server error")

    sig, adj, label, detail = compute_signal(close, req.strategy, req.params)
    signal_list = []
    if not sig.empty:
        signal_list = [{"date": str(d.date()), "value": float(v)} for d, v in sig.items()]
    return {"signal": signal_list, "drift_adj": round(adj, 2), "label": label, "detail": detail}


@router.get("/list")
def list_strategies():
    return {"strategies": STRATEGIES}


# ─── Custom rule strategy ─────────────────────────────────────────────────────

def _eval_cond_at(cond: dict, i: int, prices: np.ndarray,
                  cache: dict[str, np.ndarray], context: dict | None = None) -> bool:
    def _ind(ref: dict) -> np.ndarray:
        key = repr(sorted(ref.items()))
        if key not in cache:
            cache[key] = _get_ind(ref, prices, context)
        return cache[key]

    lhs_arr = _ind(cond.get("lhs", {"type": "PRICE"}))
    lhs = lhs_arr[i]
    if np.isnan(lhs):
        return False

    op       = cond.get("op", "gt")
    rhs_type = cond.get("rhs_type", "number")
    if rhs_type == "number":
        rhs = float(cond.get("rhs_num", 0))
        prev_rhs = rhs
    else:
        rhs_arr  = _ind(cond.get("rhs_ind", {"type": "PRICE"}))
        rhs      = rhs_arr[i]
        if np.isnan(rhs):
            return False
        prev_rhs = rhs_arr[i - 1] if i > 0 else float("nan")

    if op == "gt":  return bool(lhs > rhs)
    if op == "lt":  return bool(lhs < rhs)
    if op == "gte": return bool(lhs >= rhs)
    if op == "lte": return bool(lhs <= rhs)
    if i < 1:
        return False
    prev_lhs = lhs_arr[i - 1]
    if np.isnan(prev_lhs) or np.isnan(prev_rhs):
        return False
    if op == "crosses_above": return bool(prev_lhs <= prev_rhs and lhs > rhs)
    if op == "crosses_below": return bool(prev_lhs >= prev_rhs and lhs < rhs)
    return False


def _eval_group_at(group: dict, i: int, prices: np.ndarray,
                   cache: dict, context: dict | None = None) -> bool:
    conds = group.get("conditions", [])
    if not conds:
        return False
    logic   = group.get("logic", "AND")
    results = [_eval_cond_at(c, i, prices, cache, context) for c in conds]
    return all(results) if logic == "AND" else any(results)


def _eval_block_at(block: dict, i: int, prices: np.ndarray,
                   cache: dict, context: dict | None = None) -> bool:
    groups = block.get("groups")
    # backwards compat: flat conditions → treat as single group
    if not groups:
        flat = block.get("conditions", [])
        if not flat:
            return False
        groups = [{"logic": block.get("logic", "AND"), "conditions": flat}]
    top_logic = block.get("logic", "AND")
    results   = [_eval_group_at(g, i, prices, cache, context) for g in groups]
    return all(results) if top_logic == "AND" else any(results)


def evaluate_custom_rules(prices: np.ndarray, rules: dict, context: dict | None = None) -> np.ndarray:
    """Bar-by-bar evaluation. Returns 1.0 = invested, 0.0 = cash.

    `context` supplies live/snapshot metrics (fundamentals, liquidity) for any
    market-data conditions; held constant across the series (see market_context).
    """
    n        = len(prices)
    signal   = np.zeros(n)
    cache: dict[str, np.ndarray] = {}
    buy_blk  = rules.get("buy",  {"logic": "AND", "conditions": []})
    sell_blk = rules.get("sell", {"logic": "AND", "conditions": []})
    in_trade = False
    for i in range(1, n):
        if not in_trade:
            if _eval_block_at(buy_blk, i, prices, cache, context):
                in_trade   = True
                signal[i]  = 1.0
        else:
            if _eval_block_at(sell_blk, i, prices, cache, context):
                in_trade  = False
                signal[i] = 0.0
            else:
                signal[i] = 1.0
    return signal


class CustomSignalRequest(BaseModel):
    ticker:     str
    start:      str  = "2020-01-01"
    end:        str  = "2024-12-31"
    rules:      dict = {}
    bull_drift: float = 5.0
    bear_drift: float = -3.0

    @model_validator(mode="after")
    def _validate(self):
        self.ticker = validate_ticker(self.ticker)
        validate_date(self.start); validate_date(self.end)
        return self


@router.post("/custom-signal")
def get_custom_signal(req: CustomSignalRequest):
    try:
        close = _fetch_close(req.ticker, req.start, req.end)
        if close.empty:
            raise HTTPException(404, "No price data")
    except HTTPException:
        raise
    except Exception:
        logger.exception("custom-signal fetch failed")
        raise HTTPException(500, "Failed to fetch price data")

    prices   = close.values.astype(float)
    from strategies.market_context import resolve_context
    sig_arr  = evaluate_custom_rules(prices, req.rules, resolve_context(req.ticker, req.rules))
    last_sig = float(sig_arr[-1]) if len(sig_arr) else 0.0
    invested = int(np.sum(sig_arr))
    pct      = 100 * invested / max(1, len(sig_arr))
    adj      = req.bull_drift if last_sig == 1.0 else req.bear_drift
    label    = "Custom — Invested" if last_sig == 1.0 else "Custom — Cash"
    detail   = (f"Custom rules. {invested}/{len(sig_arr)} bars invested ({pct:.0f}%). "
                f"Current: {'Invested' if last_sig else 'Cash'}. Drift {adj:+.1f}%.")

    signal_list = [{"date": str(d.date()), "value": float(v)}
                   for d, v in zip(close.index, sig_arr)]
    return {"signal": signal_list, "drift_adj": round(adj, 2),
            "label": label, "detail": detail}


# ─── Custom rule backtest (Algorithmic Strategy Builder) ──────────────────────
# Runs a composed buy/sell rule set through the shared engine + algo risk
# controls + metrics, returning the same shape as /algo/backtest so the builder
# UI reuses the standard result strip + equity curve.

class CustomBacktestRequest(BaseModel):
    ticker: str
    rules: dict = {}
    start: str = "2022-01-01"
    end: str | None = None
    stop_loss: float | None = None
    take_profit: float | None = None
    trailing_stop: float | None = None
    max_hold_bars: int | None = None
    position_size: float = 100
    initial_capital: float = 10_000

    @model_validator(mode="after")
    def _validate(self):
        self.ticker = validate_ticker(self.ticker)
        validate_date(self.start)
        if self.end:
            validate_date(self.end)
        return self


@router.post("/custom-backtest")
def custom_backtest(req: CustomBacktestRequest):
    from .algo import _apply_risk_controls, _compute_metrics
    import datetime
    end = req.end or datetime.date.today().isoformat()
    close = _fetch_close(req.ticker, req.start, end)
    if len(close) < 60:
        raise HTTPException(422, "Insufficient price history for backtest")
    close.name = req.ticker.strip().upper()
    from strategies.market_context import resolve_context
    sig_arr = evaluate_custom_rules(close.values.astype(float), req.rules, resolve_context(req.ticker, req.rules))
    signal = pd.Series(sig_arr, index=close.index)
    signal = _apply_risk_controls(
        signal, close, req.stop_loss, req.take_profit, req.trailing_stop, req.max_hold_bars,
    )
    return _compute_metrics(signal, close, req.position_size, req.initial_capital)
