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

# ── Multi-timeframe support ───────────────────────────────────────────────────
# A condition's indicator can run on a coarser bar than the daily backtest.
# Weekly/monthly resample the daily close we already have; the indicator is
# computed on those bars, then mapped back onto the daily index (ffill) so the
# daily signal loop is unchanged.
_TF_RESAMPLE = {"5m": "5min", "15m": "15min", "30m": "30min", "1h": "1h", "hourly": "1h",
                "daily": "D", "weekly": "W-FRI", "monthly": "ME"}
# Approx minutes per bar, used to compare a condition's timeframe against the base
# backtest timeframe. A condition only resamples to a STRICTLY coarser frame — a
# same/finer frame has no finer data to compute from, so it runs on the base bars.
_TF_MINUTES = {"5m": 5, "15m": 15, "30m": 30, "1h": 60, "hourly": 60,
               "daily": 390, "weekly": 1950, "monthly": 8190}
_BASE_MINUTES = {"1d": 390, "1h": 60, "30m": 30, "15m": 15, "5m": 5}
# Timeframe resampling only applies to indicators computed straight from the
# price series (get_indicator's plain dispatch branches). Context types
# (fundamentals, liquidity, flow) are pre-resolved per-bar arrays looked up by
# type, not resampled from price, so they always run at the base cadence.
_TF_TYPES = {"PRICE", "RSI", "SMA", "EMA", "MACD_LINE", "MACD_SIGNAL",
             "BB_UPPER", "BB_MID", "BB_LOWER", "ATR", "MOMENTUM", "PCT_CHANGE",
             "PCT_BELOW_HIGH", "PCT_ABOVE_LOW", "OPT_HV", "OPT_IVRANK"}

# ── Base backtest timeframe ───────────────────────────────────────────────────
# Alpaca supplies deep intraday history, so a strategy can trade on sub-daily bars.
# Each maps to (alpaca timeframe, approx bars/year for annualization, max lookback
# days to bound intraday bar counts). '1d' is the default/unchanged daily path
# (yfinance-backed via get_history); intraday requires an Alpaca key + equity ticker.
_BACKTEST_TF = {
    "1d":  ("1d",  252,   None),
    "1h":  ("1h",  1638,  730),
    "30m": ("30m", 3276,  180),
    "15m": ("15m", 6552,  120),
    "5m":  ("5m",  19656, 60),
}


def _is_intraday_tf(tf: "str | None") -> bool:
    return (tf or "").lower() not in ("", "1d", "daily")


def _clamp_intraday_start(tf: str, start: str, end: str) -> str:
    """Bound an intraday window so a huge date range can't request years of minute
    bars (past Alpaca's page cap, and meaningless at that granularity)."""
    import datetime as _d
    max_days = _BACKTEST_TF.get(tf, (None, None, 120))[2] or 120
    floor = (_d.date.fromisoformat(end) - _d.timedelta(days=max_days)).isoformat()
    return max(start, floor)


def _fetch_ohlcv_tf(ticker: str, start: str, end: str, tf: str) -> pd.DataFrame:
    """OHLCV at the base timeframe. Daily uses the existing cached path; intraday
    pulls Alpaca bars (equities only). Empty DataFrame on miss. Volume comes along
    for VOL_RELATIVE/VOL_DOLLAR context indicators, which used to need a second
    fetch of data this call already has."""
    if not _is_intraday_tf(tf):
        return get_history(ticker, start=start, end=end)
    import alpaca
    atf = _BACKTEST_TF.get(tf, ("1d",))[0]
    return alpaca.history_df(ticker, atf, start, end)


def _fetch_close_tf(ticker: str, start: str, end: str, tf: str) -> pd.Series:
    """Close series at the base timeframe. Empty Series on miss."""
    if not _is_intraday_tf(tf):
        return _fetch_close(ticker, start, end)
    df = _fetch_ohlcv_tf(ticker, start, end, tf)
    return df["Close"].dropna() if not df.empty else pd.Series(dtype=float)

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

def _tf_indicator(ref: dict, arr: np.ndarray, daily_index, ctx: dict | None, tf: str) -> np.ndarray:
    """Indicator computed on its resampled (weekly/monthly) bars, then mapped onto
    the daily index (ffill) so the daily signal loop reads the latest completed
    bar."""
    n = len(daily_index)
    rule = _TF_RESAMPLE.get(tf)
    if rule is None:
        return _get_ind(ref, arr, ctx)
    ser = pd.Series(arr, index=daily_index)
    coarse = ser.resample(rule).last().dropna()
    if coarse.empty:
        return np.full(n, np.nan)
    ind = _get_ind(ref, coarse.to_numpy(dtype=float), ctx)
    return pd.Series(ind, index=coarse.index).reindex(daily_index, method="ffill").to_numpy(dtype=float)


def _resolve_series(ref: dict, tk: str, env: dict) -> np.ndarray:
    arr = env["frames"].get(tk)
    if arr is None:
        return np.full(env["n"], np.nan)
    ctx = env["ctx_by_ticker"].get(tk)
    tf = str(ref.get("timeframe") or "daily").lower()
    di = env.get("daily_index")
    if di is None or ref.get("type") not in _TF_TYPES:
        return _get_ind(ref, arr, ctx)
    # Resample only to a STRICTLY coarser frame than the backtest base; a same/finer
    # frame has no finer data to compute from, so it runs on the base bars.
    base_min = _BASE_MINUTES.get(env.get("base_tf", "1d"), 390)
    if _TF_MINUTES.get(tf, 390) <= base_min:
        return _get_ind(ref, arr, ctx)
    return _tf_indicator(ref, arr, di, ctx, tf)


def _series_for(ref: dict, env: dict) -> np.ndarray:
    """Daily-aligned indicator series for one condition side, resolved against the
    side's own ticker (blank ⇒ primary) and timeframe (blank ⇒ daily). A referenced
    symbol with no data yields all-NaN so its condition never fires. Cached per
    (ticker, ref); the ref cache key already folds in the timeframe field."""
    tk = str(ref.get("ticker") or env["primary"]).upper().strip()
    key = repr((tk, sorted((k, v) for k, v in ref.items() if k != "ticker")))
    cache = env["cache"]
    if key not in cache:
        cache[key] = _resolve_series(ref, tk, env)
    return cache[key]


def _eval_cond_at(cond: dict, i: int, env: dict) -> bool:
    lhs_arr = _series_for(cond.get("lhs", {"type": "PRICE"}), env)
    lhs = lhs_arr[i]
    if np.isnan(lhs):
        return False

    op       = cond.get("op", "gt")
    rhs_type = cond.get("rhs_type", "number")
    if rhs_type == "number":
        rhs = float(cond.get("rhs_num", 0))
        prev_rhs = rhs
    else:
        rhs_arr  = _series_for(cond.get("rhs_ind", {"type": "PRICE"}), env)
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


def _eval_group_at(group: dict, i: int, env: dict) -> bool:
    conds = group.get("conditions", [])
    if not conds:
        return False
    logic   = group.get("logic", "AND")
    results = [_eval_cond_at(c, i, env) for c in conds]
    return all(results) if logic == "AND" else any(results)


def _eval_block_at(block: dict, i: int, env: dict) -> bool:
    groups = block.get("groups")
    # backwards compat: flat conditions → treat as single group
    if not groups:
        flat = block.get("conditions", [])
        if not flat:
            return False
        groups = [{"logic": block.get("logic", "AND"), "conditions": flat}]
    top_logic = block.get("logic", "AND")
    results   = [_eval_group_at(g, i, env) for g in groups]
    return all(results) if top_logic == "AND" else any(results)


def evaluate_custom_rules(prices: np.ndarray, rules: dict, context: dict | None = None,
                          frames: dict[str, np.ndarray] | None = None,
                          ctx_by_ticker: dict[str, dict] | None = None,
                          primary: str | None = None,
                          daily_index=None, intraday_base: bool = False,
                          base_tf: str = "1d") -> np.ndarray:
    """Bar-by-bar evaluation. Returns 1.0 = invested, 0.0 = cash.

    Single-ticker (default): pass `prices` + `context`; every condition reads that
    one symbol. Cross-ticker: pass `frames` = {TICKER: date-aligned close array}
    (all equal length), `ctx_by_ticker` = per-symbol live context, and `primary` =
    the traded symbol; a condition's `ticker` field then selects its symbol.

    `context`/`ctx_by_ticker` supply live snapshot metrics (fundamentals, options,
    liquidity) held constant across the series (see market_context).
    """
    n        = len(prices)
    if primary is None:
        primary = "_PRIMARY_"
    if frames is None:
        frames = {primary: np.asarray(prices, dtype=float)}
    if ctx_by_ticker is None:
        ctx_by_ticker = {primary: context or {}}
    signal   = np.zeros(n)
    env = {"primary": primary, "frames": frames, "cache": {}, "ctx_by_ticker": ctx_by_ticker,
           "n": n, "daily_index": daily_index, "intraday_base": intraday_base, "base_tf": base_tf}
    buy_blk  = rules.get("buy",  {"logic": "AND", "conditions": []})
    sell_blk = rules.get("sell", {"logic": "AND", "conditions": []})
    in_trade = False
    for i in range(1, n):
        if not in_trade:
            if _eval_block_at(buy_blk, i, env):
                in_trade   = True
                signal[i]  = 1.0
        else:
            if _eval_block_at(sell_blk, i, env):
                in_trade  = False
                signal[i] = 0.0
            else:
                signal[i] = 1.0
    return signal


# ── Human-readable rule descriptions (for trade-marker tooltips) ─────────────
# Mirrors the frontend's IND_LABELS (CustomStrategyModal.tsx) — kept as a
# literal here rather than shared, since indicator labels rarely change and a
# cross-language import isn't worth the coupling.
_IND_LABELS: dict[str, str] = {
    "PRICE": "Price", "RSI": "RSI", "SMA": "SMA", "EMA": "EMA",
    "MACD_LINE": "MACD Line", "MACD_SIGNAL": "MACD Signal",
    "BB_UPPER": "BB Upper", "BB_MID": "BB Mid", "BB_LOWER": "BB Lower",
    "ATR": "ATR", "MOMENTUM": "Momentum", "PCT_CHANGE": "% change",
    "PCT_BELOW_HIGH": "% below high", "PCT_ABOVE_LOW": "% above low",
    "OPT_HV": "Realized vol %", "OPT_IVRANK": "IV Rank %",
    "FUND_PE": "P/E", "FUND_PEG": "PEG", "FUND_EPSGROWTH": "EPS growth %",
    "FUND_NETMARGIN": "Net margin %", "FUND_GROSSMARGIN": "Gross margin %",
    "FUND_DEBTEQUITY": "Debt/equity", "FUND_DIVYIELD": "Dividend yield %",
    "FUND_PB": "P/B", "FUND_CURRENTRATIO": "Current ratio", "FUND_BETA": "Beta",
    "VOL_RELATIVE": "Relative volume", "VOL_DOLLAR": "Dollar volume",
    "FLOW_HORMUZ": "Hormuz transits", "FLOW_SUEZ": "Suez transits",
    "FLOW_PANAMA": "Panama transits", "FLOW_MALACCA": "Malacca transits",
}
_OP_LABELS: dict[str, str] = {
    "gt": ">", "lt": "<", "gte": "≥", "lte": "≤",
    "crosses_above": "crosses above", "crosses_below": "crosses below",
}


def _describe_indicator(ind: dict) -> str:
    t = ind.get("type", "PRICE")
    label = _IND_LABELS.get(t, t)
    period = ind.get("period")
    if period:
        label += f" ({period}d)"
    tk = ind.get("ticker")
    if tk:
        label += f" [{str(tk).upper()}]"
    return label


def _describe_condition(cond: dict) -> str:
    lhs = _describe_indicator(cond.get("lhs") or {"type": "PRICE"})
    op = _OP_LABELS.get(cond.get("op", "gt"), cond.get("op", "gt"))
    if cond.get("rhs_type") == "indicator":
        rhs = _describe_indicator(cond.get("rhs_ind") or {"type": "PRICE"})
    else:
        rhs = str(cond.get("rhs_num", 0))
    return f"{lhs} {op} {rhs}"


def describe_rule_block(block: dict | None) -> str:
    """Human-readable summary of a buy/sell rule block, for trade-marker
    tooltips — e.g. '% below high (20d) > 20 AND IV Rank % >= 80'."""
    block = block or {}
    groups = block.get("groups")
    if not groups:
        flat = block.get("conditions") or []
        if not flat:
            return "no conditions set"
        groups = [{"logic": block.get("logic", "AND"), "conditions": flat}]
    group_strs = []
    for g in groups:
        conds = g.get("conditions") or []
        if not conds:
            continue
        logic = f" {g.get('logic', 'AND')} "
        s = logic.join(_describe_condition(c) for c in conds)
        group_strs.append(f"({s})" if len(conds) > 1 and len(groups) > 1 else s)
    if not group_strs:
        return "no conditions set"
    top_logic = f" {block.get('logic', 'AND')} "
    return top_logic.join(group_strs)


def _exit_reason(exit_kind: str | None, sell_reason: str, *, stop_loss=None, take_profit=None,
                 trailing_stop=None, max_hold_bars=None, dte=None) -> str:
    """A risk-control-forced exit (stop-loss/take-profit/trailing-stop/max-hold/
    DTE expiry) did NOT happen because the sell rule fired — showing the static
    sell_reason text on those trades would misattribute the exit. exit_kind
    (set by _apply_risk_controls/_compute_option_metrics/_compute_combo_metrics)
    picks the accurate label instead; only a genuine rule-driven exit ("rule" or
    unset) falls back to sell_reason."""
    if exit_kind == "stop_loss" and stop_loss is not None:
        return f"Stop-loss triggered ({stop_loss:g}%)"
    if exit_kind == "take_profit" and take_profit is not None:
        return f"Take-profit triggered ({take_profit:g}%)"
    if exit_kind == "trailing_stop" and trailing_stop is not None:
        return f"Trailing stop triggered ({trailing_stop:g}%)"
    if exit_kind == "max_hold" and max_hold_bars is not None:
        return f"Max hold reached ({max_hold_bars} bars)"
    if exit_kind == "expiration" and dte is not None:
        return f"Expired and settled ({dte} calendar DTE)"
    if exit_kind == "wipeout":
        return "Liquidated — position lost its full allocated capital"
    return sell_reason


def referenced_tickers(rules: dict | None, primary: str) -> list[str]:
    """Every symbol a rule set touches: the primary plus any per-condition ticker
    overrides. Used to fetch and date-align all needed price frames."""
    primary = (primary or "").upper().strip()
    out = {primary} if primary else set()
    for block in (rules or {}).values():
        if not isinstance(block, dict):
            continue
        conds = list(block.get("conditions") or [])
        for g in (block.get("groups") or []):
            if isinstance(g, dict):
                conds += (g.get("conditions") or [])
        for c in conds:
            if not isinstance(c, dict):
                continue
            for side in ("lhs", "rhs_ind"):
                tk = (c.get(side) or {}).get("ticker")
                if tk:
                    out.add(str(tk).upper().strip())
    return sorted(t for t in out if t)


def build_aligned_frames(tickers: list[str], start: str, end: str, timeframe: str = "1d"):
    """Fetch each symbol's OHLCV and inner-join closes on shared bars so every frame
    shares one index (cross-ticker conditions compare same-bar values). `timeframe`
    selects the base bar size (daily or Alpaca intraday). Returns
    (index, {TICKER: close_array}, {TICKER: volume_array}) — volume feeds the
    VOL_RELATIVE/VOL_DOLLAR context indicators, reindexed onto the same shared
    bars (NaN where a symbol's feed has no volume, e.g. some intraday sources).
    Symbols with no data are dropped."""
    series: dict[str, pd.Series] = {}
    vol_series: dict[str, pd.Series] = {}
    for tk in tickers:
        df = _fetch_ohlcv_tf(tk, start, end, timeframe)
        if df.empty or "Close" not in df:
            continue
        c = df["Close"].dropna()
        if c.empty:
            continue
        series[tk] = c
        if "Volume" in df:
            vol_series[tk] = df["Volume"]
    if not series:
        return None, {}, {}
    df = pd.concat(series, axis=1, join="inner").dropna()
    frames = {str(tk): df[tk].to_numpy(dtype=float) for tk in df.columns}
    volumes = {
        str(tk): vol_series[tk].reindex(df.index).to_numpy(dtype=float)
        for tk in df.columns if tk in vol_series
    }
    return df.index, frames, volumes


class CustomSignalRequest(BaseModel):
    ticker:     str
    start:      str  = "2020-01-01"
    end:        str  = "2024-12-31"
    rules:      dict = {}
    bull_drift: float = 5.0
    bear_drift: float = -3.0
    timeframe:  str = "1d"

    @model_validator(mode="after")
    def _validate(self):
        self.ticker = validate_ticker(self.ticker)
        validate_date(self.start); validate_date(self.end)
        self.timeframe = (self.timeframe or "1d").lower()
        if self.timeframe not in _BACKTEST_TF:
            raise HTTPException(422, f"Unsupported timeframe '{self.timeframe}'.")
        return self


@router.post("/custom-signal")
def get_custom_signal(req: CustomSignalRequest):
    try:
        # _run_custom_rules fetches + date-aligns every referenced symbol so
        # cross-ticker rules behave the same here as in the algo backtest.
        tf = req.timeframe
        start = _clamp_intraday_start(tf, req.start, req.end) if _is_intraday_tf(tf) else req.start
        sig_arr, close = _run_custom_rules(req.ticker, req.rules, start, req.end, tf)
    except HTTPException:
        raise
    except Exception:
        logger.exception("custom-signal fetch failed")
        raise HTTPException(500, "Failed to fetch price data")
    if close is None or close.empty:
        raise HTTPException(404, "No price data")

    last_sig = float(sig_arr[-1]) if len(sig_arr) else 0.0
    invested = int(np.sum(sig_arr))
    pct      = 100 * invested / max(1, len(sig_arr))
    adj      = req.bull_drift if last_sig == 1.0 else req.bear_drift
    label    = "Custom — Invested" if last_sig == 1.0 else "Custom — Cash"
    detail   = (f"Custom rules. {invested}/{len(sig_arr)} bars invested ({pct:.0f}%). "
                f"Current: {'Invested' if last_sig else 'Cash'}. Drift {adj:+.1f}%.")

    _fmt = (lambda d: d.strftime("%Y-%m-%d %H:%M")) if _is_intraday_tf(tf) else (lambda d: str(d.date()))
    signal_list = [{"date": _fmt(d), "value": float(v)}
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
    timeframe: str = "1d"            # 1d (default) | 1h | 30m | 15m | 5m — intraday needs Alpaca + an equity
    stop_loss: float | None = None
    take_profit: float | None = None
    trailing_stop: float | None = None
    max_hold_bars: int | None = None
    position_size: float = 100
    initial_capital: float = 10_000
    instrument: dict | None = None   # {kind:"option", type:"call"|"put", moneyness, dte} → modeled option P&L
    side: str = "long"               # long|short — drives direction for shares AND options
    leverage: float = 1              # gross-notional multiplier on position_size, 1x = unlevered
    effective_annual_rate: float = 0  # EAR charged on notional borrowed beyond 100% of capital

    @model_validator(mode="after")
    def _validate(self):
        self.ticker = validate_ticker(self.ticker)
        validate_date(self.start)
        if self.end:
            validate_date(self.end)
        for field in ("stop_loss", "take_profit", "trailing_stop", "max_hold_bars"):
            if getattr(self, field) is not None and getattr(self, field) <= 0:
                setattr(self, field, None)
        self.timeframe = (self.timeframe or "1d").lower()
        if self.timeframe not in _BACKTEST_TF:
            raise HTTPException(422, f"Unsupported timeframe '{self.timeframe}'. Use one of: {', '.join(_BACKTEST_TF)}.")
        if self.leverage < 1:
            raise ValueError("Leverage must be at least 1x")
        if not 0 <= self.effective_annual_rate <= 100:
            raise ValueError("Effective annual rate must be between 0% and 100%")
        return self


def _run_custom_rules(ticker: str, rules: dict, start: str, end: str, timeframe: str = "1d"):
    """Fetch + align every symbol a rule set references, resolve each one's
    point-in-time context (fundamentals/liquidity/flow series aligned to the same
    bars), and evaluate the rules on the chosen base timeframe. Returns
    (signal_array, primary_close) where primary_close is a Series indexed by the
    shared bars."""
    from strategies.market_context import resolve_context

    def strip_self_placeholder(value):
        if isinstance(value, list):
            return [strip_self_placeholder(item) for item in value]
        if not isinstance(value, dict):
            return value
        return {
            key: strip_self_placeholder(item)
            for key, item in value.items()
            if not (key == "ticker" and isinstance(item, str) and item.strip().upper() in {"$TICKER", "TICKER", "$SYMBOL", "SYMBOL", "SELF"})
        }

    rules = strip_self_placeholder(rules)
    primary = ticker.strip().upper()
    tickers = referenced_tickers(rules, primary)
    index, frames, volumes = build_aligned_frames(tickers, start, end, timeframe)
    if index is None or primary not in frames:
        return None, None
    ctx_by_ticker = {
        tk: resolve_context(tk, rules, index=index, close=frames[tk], volume=volumes.get(tk))
        for tk in frames
    }
    prices = frames[primary]
    sig = evaluate_custom_rules(prices, rules, frames=frames,
                                ctx_by_ticker=ctx_by_ticker, primary=primary,
                                daily_index=index, intraday_base=_is_intraday_tf(timeframe),
                                base_tf=(timeframe or "1d").lower())
    return sig, pd.Series(prices, index=index, name=primary)


@router.post("/custom-backtest")
def custom_backtest(req: CustomBacktestRequest):
    from .algo import _apply_risk_controls, _apply_financing_cost, _floor_equity, _summarize_equity
    import datetime, alpaca
    end = req.end or datetime.date.today().isoformat()
    tf = req.timeframe
    if _is_intraday_tf(tf):
        if not alpaca.available():
            raise HTTPException(422, "Intraday backtesting needs a market-data key (Alpaca) configured on the server.")
        if not alpaca.is_equity(req.ticker):
            raise HTTPException(422, f"Intraday backtesting covers US equities/ETFs only — {req.ticker} isn't available at {tf}.")
        start = _clamp_intraday_start(tf, req.start, end)
    else:
        start = req.start
    sig_arr, close = _run_custom_rules(req.ticker, req.rules, start, end, tf)
    if close is None or len(close) < 60:
        raise HTTPException(422, "Not enough price history for a backtest (need about 60 bars). Use a longer date range.")
    signal = pd.Series(sig_arr, index=close.index)
    # Option/combo risk controls are P&L-based (see _compute_option_metrics /
    # _compute_combo_metrics) — a modeled position's value doesn't move 1:1
    # with the underlying's price, so the price-based pre-filter below (correct
    # for plain shares) would rarely trigger at the intended P&L level.
    is_modeled = (req.instrument or {}).get("kind") in ("option", "combo")
    exit_kinds: dict = {}
    if not is_modeled:
        signal = _apply_risk_controls(
            signal, close, req.stop_loss, req.take_profit, req.trailing_stop, req.max_hold_bars,
            exit_kinds=exit_kinds,
        )
    bpy = _BACKTEST_TF.get(tf, ("1d", 252))[1]
    trade_size = req.position_size * req.leverage
    result = _instrument_metrics(signal, close, req.instrument, req.side, req.ticker,
                                 trade_size, req.initial_capital, bars_per_year=bpy,
                                 intraday=_is_intraday_tf(tf),
                                 stop_loss=req.stop_loss if is_modeled else None,
                                 take_profit=req.take_profit if is_modeled else None,
                                 trailing_stop=req.trailing_stop if is_modeled else None,
                                 max_hold_bars=req.max_hold_bars if is_modeled else None,
                                 exit_kinds=exit_kinds)

    # Leverage is "free" P&L amplification unless the borrowed portion of
    # notional (beyond 100% of capital) actually costs something — apply the
    # same daily-compounding financing charge portfolio_backtest uses, then
    # re-floor since financing drag can itself tip a thin curve to zero.
    equity = pd.Series([pt["strategy"] for pt in result["equity_curve"]], index=close.index)
    # For a modeled option/combo instrument, the raw entry-rule signal can stay
    # "1" through a blocked period (already force-closed by a risk trigger,
    # waiting for the rule to drop to 0 before re-entering) — financing must be
    # computed off the engine's own in_position state, not that raw signal, or
    # it keeps charging interest on notional that was already unwound.
    financing_signal = (
        pd.Series(result["in_position"], index=close.index).astype(float)
        if is_modeled and result.get("in_position") is not None else signal
    )
    equity, total_interest = _apply_financing_cost(equity, financing_signal, trade_size, req.initial_capital,
                                                    req.effective_annual_rate, bpy)
    blown_up_at = None
    if total_interest:
        equity, blown_up_at = _floor_equity(equity)
        result["metrics"].update(_summarize_equity(equity, req.initial_capital, bpy, blown_up_at))
        for pt, val in zip(result["equity_curve"], equity.values):
            pt["strategy"] = round(float(val), 2)
        if blown_up_at is not None:
            result["metrics"]["blown_up_at"] = blown_up_at.strftime("%Y-%m-%d %H:%M" if _is_intraday_tf(tf) else "%Y-%m-%d")
    result["metrics"]["interest_paid"] = round(total_interest, 2)
    result["metrics"]["leverage"] = req.leverage
    result["metrics"]["effective_annual_rate"] = req.effective_annual_rate

    # Surface the window + timeframe actually used so "history" is never ambiguous.
    result["bars"] = int(len(close))
    result["timeframe"] = tf
    _fmt = (lambda d: d.strftime("%Y-%m-%d %H:%M")) if _is_intraday_tf(tf) else (lambda d: str(d.date()))
    result["span"] = {"start": _fmt(close.index[0]), "end": _fmt(close.index[-1])}
    # Human-readable "why" per trade, for the equity-curve's hover markers. An
    # exit's reason is the sell rule ONLY if that's what actually closed it —
    # a stop-loss/take-profit/trailing-stop/max-hold/DTE exit gets its own
    # accurate label instead (see _exit_reason).
    buy_reason = describe_rule_block(req.rules.get("buy"))
    sell_reason = describe_rule_block(req.rules.get("sell"))
    dte = (req.instrument or {}).get("dte")
    for t in result.get("trades", []):
        if t.get("is_entry"):
            t["reason"] = buy_reason
        else:
            t["reason"] = _exit_reason(t.get("exit_kind"), sell_reason,
                                       stop_loss=req.stop_loss, take_profit=req.take_profit,
                                       trailing_stop=req.trailing_stop, max_hold_bars=req.max_hold_bars,
                                       dte=dte if is_modeled else None)
    result["buy_reason"] = buy_reason
    result["sell_reason"] = sell_reason
    return result


def _instrument_metrics(signal, close, instrument, side, ticker, position_size, capital, bars_per_year: int = 252, intraday: bool = False,
                        stop_loss: float | None = None, take_profit: float | None = None,
                        trailing_stop: float | None = None, max_hold_bars: int | None = None,
                        exit_kinds: dict | None = None):
    """Metrics for one position given its resolved signal + close: modeled option
    P&L for an option instrument (long buys it, short writes it), else long/short
    shares. `side` drives direction for both. Same result shape as /algo/backtest.
    Raises 422 if an option can't be priced.

    stop_loss/take_profit/trailing_stop/max_hold_bars are ONLY used for option/
    combo instruments here — they're evaluated against the position's own P&L
    inside _compute_option_metrics/_compute_combo_metrics. For shares the
    caller already applied them as a price-based pre-filter on `signal` (see
    _apply_risk_controls), which is the correct check there since a share's
    P&L moves 1:1 with price."""
    from .algo import _compute_metrics, _compute_option_metrics, _compute_combo_metrics
    inst = instrument or {}
    if inst.get("kind") in ("option", "combo"):
        try:
            from routers.options import options_snapshot
            iv = options_snapshot(ticker).get("atm_iv")
        except Exception:
            iv = None
        if not isinstance(iv, (int, float)) or iv <= 0:
            raise HTTPException(422, f"No implied volatility available to model options for {ticker}")
        if inst.get("kind") == "combo":
            return _compute_combo_metrics(signal, close, inst, float(iv), position_size, capital, bars_per_year=bars_per_year, intraday=intraday,
                                          stop_loss=stop_loss, take_profit=take_profit, trailing_stop=trailing_stop, max_hold_bars=max_hold_bars)
        return _compute_option_metrics(signal, close, inst, float(iv), position_size, capital, direction=side, bars_per_year=bars_per_year, intraday=intraday,
                                       stop_loss=stop_loss, take_profit=take_profit, trailing_stop=trailing_stop, max_hold_bars=max_hold_bars)
    return _compute_metrics(signal, close, position_size, capital, direction=side, bars_per_year=bars_per_year, intraday=intraday,
                            exit_kinds=exit_kinds)


# ─── Multi-position portfolio backtest ────────────────────────────────────────
# A strategy can be a BOOK of positions, each with its own ticker, instrument
# (shares long/short or a modeled option), and rules. Each runs through the
# shared engine, sized off the portfolio's shared trade size (or its own
# override); equity curves are date-aligned and summed into one portfolio
# curve with per-position attribution.

class PortfolioPosition(BaseModel):
    ticker:        str
    rules:         dict = {}
    instrument:    dict | None = None   # {kind:"shares"|"option", type:"call"|"put", ...}; None = shares
    side:          str = "long"          # long|short — drives direction for shares AND options
    position_size: float | None = None   # optional per-position override of the shared trade size
    stop_loss:     float | None = None
    take_profit:   float | None = None
    trailing_stop: float | None = None
    max_hold_bars: int | None = None

    @model_validator(mode="after")
    def _normalize_disabled_risk_controls(self):
        for field in ("stop_loss", "take_profit", "trailing_stop", "max_hold_bars"):
            if getattr(self, field) is not None and getattr(self, field) <= 0:
                setattr(self, field, None)
        return self


class PortfolioBacktestRequest(BaseModel):
    positions:       list[PortfolioPosition]
    start:           str = "2022-01-01"
    end:             str | None = None
    timeframe:       str = "1d"          # shared base bar size for every position
    initial_capital: float = 10_000
    position_size:   float = 10           # % of the whole portfolio for every admitted trade
    max_exposure:    float = 100          # cap on simultaneous gross allocation
    leverage:        float = 1            # gross-notional multiplier, 1x = unlevered
    effective_annual_rate: float = 0      # EAR charged on borrowed notional

    @model_validator(mode="after")
    def _validate(self):
        if not self.positions:
            raise ValueError("A portfolio needs at least one position")
        if not 1 <= self.position_size <= 100:
            raise ValueError("Trade size must be between 1% and 100% of the portfolio")
        if not 0 < self.max_exposure <= 100:
            raise ValueError("Maximum exposure must be greater than 0% and no more than 100%")
        if self.leverage < 1:
            raise ValueError("Leverage must be at least 1x")
        if not 0 <= self.effective_annual_rate <= 100:
            raise ValueError("Effective annual rate must be between 0% and 100%")
        if self.position_size > self.max_exposure:
            raise ValueError("Trade size cannot exceed maximum portfolio exposure")
        for p in self.positions:
            p.ticker = validate_ticker(p.ticker)
            if p.position_size is not None and not 1 <= p.position_size <= self.max_exposure:
                raise ValueError(f"Trade size override for {p.ticker} must be between 1% and the maximum portfolio exposure")
        validate_date(self.start)
        if self.end:
            validate_date(self.end)
        self.timeframe = (self.timeframe or "1d").lower()
        if self.timeframe not in _BACKTEST_TF:
            raise HTTPException(422, f"Unsupported timeframe '{self.timeframe}'.")
        return self


@router.post("/portfolio-backtest")
def portfolio_backtest(req: PortfolioBacktestRequest):
    from .algo import _apply_risk_controls, _floor_equity, _safe_ann_return, _ear_bar_rate
    import datetime as _dt
    import numpy as _np
    import alpaca
    end = req.end or _dt.date.today().isoformat()
    tf = req.timeframe
    intraday = _is_intraday_tf(tf)
    if intraday:
        if not alpaca.available():
            raise HTTPException(422, "Intraday backtesting needs a market-data key (Alpaca) configured on the server.")
        bad = [p.ticker for p in req.positions if not alpaca.is_equity(p.ticker)]
        if bad:
            raise HTTPException(422, f"Intraday backtesting covers US equities/ETFs only — not available for: {', '.join(bad)}.")
        start = _clamp_intraday_start(tf, req.start, end)
    else:
        start = req.start
    bpy = _BACKTEST_TF.get(tf, ("1d", 252))[1]

    candidates = []
    for p in req.positions:
        sig_arr, close = _run_custom_rules(p.ticker, p.rules, start, end, tf)
        if close is None or len(close) < 40:
            continue
        candidates.append((p, pd.Series(sig_arr, index=close.index), close))

    if not candidates:
        raise HTTPException(422, "No position produced a backtest (check tickers, rules, and date range)")

    # A universe strategy is one algorithm applied to many symbols. A ticker is
    # admitted only when it has a signal and the shared portfolio has room for
    # its master-sized trade or its explicit per-position override; leverage
    # scales both notional and the gross-exposure capacity. It never
    # receives a pre-funded capital sleeve merely because it is in the universe.
    def trade_size(position: PortfolioPosition) -> float:
        base_size = position.position_size if position.position_size is not None else req.position_size
        return base_size * req.leverage

    all_dates = sorted({date for _, signal, _ in candidates for date in signal.index})
    controlled = [pd.Series(0.0, index=close.index) for _, _, close in candidates]
    active: set[int] = set()
    for date in all_dates:
        for i, (_, signal, _) in enumerate(candidates):
            if i not in active or date not in signal.index:
                continue
            if signal.loc[date] == 0:
                active.remove(i)
            else:
                controlled[i].loc[date] = 1.0
        for i, (_, signal, _) in enumerate(candidates):
            if i in active or date not in signal.index or signal.loc[date] == 0:
                continue
            open_exposure = sum(trade_size(candidates[active_i][0]) for active_i in active)
            if open_exposure + trade_size(candidates[i][0]) > req.max_exposure * req.leverage:
                continue
            active.add(i)
            controlled[i].loc[date] = 1.0

    legs = []   # (position, result)
    for (p, _raw_signal, close), signal in zip(candidates, controlled):
        # See custom_backtest: option/combo risk controls are P&L-based, applied
        # inside _instrument_metrics — the price-based pre-filter is for shares only.
        is_modeled = (p.instrument or {}).get("kind") in ("option", "combo")
        exit_kinds: dict = {}
        if not is_modeled:
            signal = _apply_risk_controls(signal, close, p.stop_loss, p.take_profit, p.trailing_stop, p.max_hold_bars,
                                          exit_kinds=exit_kinds)
        try:
            res = _instrument_metrics(signal, close, p.instrument, p.side, p.ticker, trade_size(p), req.initial_capital,
                                      bars_per_year=bpy, intraday=intraday,
                                      stop_loss=p.stop_loss if is_modeled else None,
                                      take_profit=p.take_profit if is_modeled else None,
                                      trailing_stop=p.trailing_stop if is_modeled else None,
                                      max_hold_bars=p.max_hold_bars if is_modeled else None,
                                      exit_kinds=exit_kinds)
        except HTTPException:
            continue
        # Financing (below) needs the ACTUAL open-position state, not the raw
        # entry-rule signal — for a modeled option/combo leg those diverge
        # during a blocked period (already force-closed by a risk trigger,
        # waiting for the rule to drop to 0 before re-entering); see
        # custom_backtest's identical financing_signal handling.
        financing_signal = (
            pd.Series(res["in_position"], index=close.index).astype(float)
            if is_modeled and res.get("in_position") is not None else signal
        )
        legs.append((p, res, financing_signal))

    if not legs:
        raise HTTPException(422, "No position produced a backtest (check tickers, rules, and date range)")

    def _series(res, key):
        return pd.Series([pt[key] for pt in res["equity_curve"]],
                         index=pd.to_datetime([pt["date"] for pt in res["equity_curve"]]))

    # An inner join here would collapse the WHOLE portfolio's window down to
    # whichever single position has the shortest trading history (e.g. one
    # recent IPO in an otherwise-2022-onward book) — silently discarding years
    # of valid data from every other position. Outer-join instead, so the
    # curve spans the full requested range; a position with no data yet just
    # sits at its allocated capital (idle cash) until its own history starts,
    # same convention already used for a position that fails outright.
    eq_df = pd.concat({str(i): _series(res, "strategy") for i, (_, res, _) in enumerate(legs)}, axis=1, join="outer").sort_index()
    bm_df = pd.concat({str(i): _series(res, "benchmark") for i, (_, res, _) in enumerate(legs)}, axis=1, join="outer").sort_index()
    if eq_df.empty:
        raise HTTPException(422, "Positions share no overlapping trading days — align their tickers or date range")
    for i, (_, _res, _) in enumerate(legs):
        col = str(i)
        eq_df[col] = eq_df[col].ffill().fillna(req.initial_capital)
        bm_df[col] = bm_df[col].ffill().fillna(req.initial_capital)
    port_eq = req.initial_capital + (eq_df - req.initial_capital).sum(axis=1)

    # Blend every leg's own buy-and-hold benchmark (each already a full-capital
    # curve for its ticker — see _compute_metrics/_compute_option_metrics),
    # weighted by that leg's actual share of the portfolio, instead of just
    # reading the first leg's curve as if it stood in for the whole book.
    leg_weights = pd.Series({str(i): trade_size(p) for i, (p, _, _) in enumerate(legs)})
    weight_total = float(leg_weights.sum())
    if weight_total > 0:
        leg_weights = leg_weights[bm_df.columns] / weight_total
        bm_returns = bm_df.pct_change().fillna(0.0)
        port_bm = req.initial_capital * (1 + (bm_returns * leg_weights).sum(axis=1)).cumprod()
    else:
        port_bm = bm_df.iloc[:, 0]

    gross_notional = pd.Series(0.0, index=port_eq.index)
    for p, _res, signal in legs:
        # ffill only covers gaps WITHIN this ticker's own price history (e.g. a
        # holiday another leg doesn't share) — it must not carry a position
        # "open" past the last date this ticker actually has data for, or a
        # leg whose price feed simply ends mid-window while in a trade reads
        # as permanently open and accrues financing interest forever.
        sig = signal.reindex(port_eq.index).ffill().fillna(0.0)
        sig.loc[sig.index > signal.index.max()] = 0.0
        gross_notional = gross_notional.add(sig * (trade_size(p) / 100.0) * req.initial_capital, fill_value=0.0)
    borrowed_notional = (gross_notional - req.initial_capital).clip(lower=0.0)
    interest_cost = borrowed_notional * _ear_bar_rate(req.effective_annual_rate, bpy)
    total_interest = float(interest_cost.sum())
    if total_interest:
        port_eq = port_eq - interest_cost.cumsum()

    # Floor the aggregate curve too — every leg is individually floored at 0,
    # but several legs losing their full allocation in the same window can
    # still sum the portfolio below zero (each leg is sized against the FULL
    # initial capital, not a shared pool), which hits the same
    # negative-equity crash/false-recovery risk as a single leveraged leg.
    port_eq, blown_up_at = _floor_equity(port_eq)

    n = len(port_eq)
    daily = port_eq.pct_change()
    total_return = float(port_eq.iloc[-1] / req.initial_capital - 1) * 100
    ann_return = _safe_ann_return(float(port_eq.iloc[-1]), req.initial_capital, bpy / max(1, n))
    roll_max = port_eq.cummax().replace(0, _np.nan)
    dd = (port_eq - roll_max) / roll_max
    max_drawdown = float(dd.min(skipna=True) * 100) if dd.notna().any() else -100.0
    if blown_up_at is not None:
        max_drawdown = min(max_drawdown, -100.0)
    sharpe = float(daily.mean() / daily.std() * _np.sqrt(bpy)) if daily.std() > 0 else 0.0
    trades_tot = sum(res["metrics"]["num_trades"] for _, res, _ in legs)
    wins_tot = sum(round(res["metrics"]["win_rate"] / 100 * res["metrics"]["num_trades"]) for _, res, _ in legs)
    win_rate = float(wins_tot / trades_tot * 100) if trades_tot else 0.0

    _cfmt = "%Y-%m-%d %H:%M" if intraday else "%Y-%m-%d"
    curve = [{"date": d.strftime(_cfmt), "strategy": round(float(sv), 2), "benchmark": round(float(bv), 2)}
             for d, sv, bv in zip(port_eq.index, port_eq.values, port_bm.values)]
    positions_out = [{
        "ticker": p.ticker, "side": p.side,
        "instrument": (p.instrument or {}).get("kind", "shares"),
        "opt_type": (p.instrument or {}).get("type"),
        "weight_pct": trade_size(p),
        "return_pct": res["metrics"]["total_return"],
        "pnl": round(float(_series(res, "strategy").iloc[-1]) - req.initial_capital, 2),
        "num_trades": res["metrics"]["num_trades"],
    } for (p, res, _) in legs]

    # Aggregate every position's trades onto the shared timeline, for the
    # equity-curve's hover markers — tagged with ticker (several positions can
    # trade the same day) and a per-position "why" (each has its own rules).
    # Only dates inside the portfolio's own (inner-joined) span have a curve
    # point to anchor a marker to.
    valid_dates = {d.strftime(_cfmt) for d in port_eq.index}
    trades_out = []
    for p, res, _ in legs:
        buy_reason = describe_rule_block(p.rules.get("buy"))
        sell_reason = describe_rule_block(p.rules.get("sell"))
        is_modeled = (p.instrument or {}).get("kind") in ("option", "combo")
        dte = (p.instrument or {}).get("dte") if is_modeled else None
        for t in res.get("trades", []):
            if t["date"] not in valid_dates:
                continue
            reason = buy_reason if t.get("is_entry") else _exit_reason(
                t.get("exit_kind"), sell_reason, stop_loss=p.stop_loss, take_profit=p.take_profit,
                trailing_stop=p.trailing_stop, max_hold_bars=p.max_hold_bars, dte=dte,
            )
            trades_out.append({**t, "ticker": p.ticker, "reason": reason})
    trades_out.sort(key=lambda t: t["date"])

    return {
        "equity_curve": curve,
        "metrics": {
            "total_return": round(total_return, 2), "ann_return": round(ann_return, 2),
            "max_drawdown": round(max_drawdown, 2), "sharpe": round(sharpe, 3),
            "num_trades": trades_tot, "win_rate": round(win_rate, 1),
            "initial_capital": round(req.initial_capital, 2), "final_capital": round(float(port_eq.iloc[-1]), 2),
            "total_pnl": round(float(port_eq.iloc[-1]) - req.initial_capital, 2),
            "interest_paid": round(total_interest, 2), "leverage": req.leverage, "effective_annual_rate": req.effective_annual_rate,
            "blown_up_at": blown_up_at.strftime(_cfmt) if blown_up_at is not None else None,
        },
        "timeframe": tf,
        "positions": positions_out,
        "trades": trades_out,
        "bars": int(n),
        "span": {"start": port_eq.index[0].strftime(_cfmt), "end": port_eq.index[-1].strftime(_cfmt)},
    }
