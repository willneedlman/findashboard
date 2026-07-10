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
_TF_RESAMPLE = {"daily": "D", "weekly": "W-FRI", "monthly": "ME"}
# Timeframe only applies to price-derived indicators; live-snapshot metrics
# (fundamentals, options, greeks, flow) are constant across the series.
_TF_TYPES = {"PRICE", "RSI", "SMA", "EMA", "MACD_LINE", "MACD_SIGNAL",
             "BB_UPPER", "BB_MID", "BB_LOWER", "ATR", "MOMENTUM", "PCT_CHANGE"}

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


def _fetch_close_tf(ticker: str, start: str, end: str, tf: str) -> pd.Series:
    """Close series at the base timeframe. Daily uses the existing cached path;
    intraday pulls Alpaca bars (equities only). Empty Series on miss."""
    if not _is_intraday_tf(tf):
        return _fetch_close(ticker, start, end)
    import alpaca
    atf = _BACKTEST_TF.get(tf, ("1d",))[0]
    df = alpaca.history_df(ticker, atf, start, end)
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
    # On a daily base, "daily" IS the base (no resample). On an intraday base,
    # "daily" means resample the intraday bars up to daily bars first.
    if tf == "daily" and not env.get("intraday_base"):
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
                          daily_index=None, intraday_base: bool = False) -> np.ndarray:
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
           "n": n, "daily_index": daily_index, "intraday_base": intraday_base}
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
    """Fetch each symbol's close and inner-join on shared bars so every frame shares
    one index (cross-ticker conditions compare same-bar values). `timeframe` selects
    the base bar size (daily or Alpaca intraday). Returns (index, {TICKER: close_array}).
    Symbols with no data are dropped."""
    series: dict[str, pd.Series] = {}
    for tk in tickers:
        s = _fetch_close_tf(tk, start, end, timeframe)
        if not s.empty:
            series[tk] = s
    if not series:
        return None, {}
    df = pd.concat(series, axis=1, join="inner").dropna()
    frames = {str(tk): df[tk].to_numpy(dtype=float) for tk in df.columns}
    return df.index, frames


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

    @model_validator(mode="after")
    def _validate(self):
        self.ticker = validate_ticker(self.ticker)
        validate_date(self.start)
        if self.end:
            validate_date(self.end)
        self.timeframe = (self.timeframe or "1d").lower()
        if self.timeframe not in _BACKTEST_TF:
            raise HTTPException(422, f"Unsupported timeframe '{self.timeframe}'. Use one of: {', '.join(_BACKTEST_TF)}.")
        return self


def _run_custom_rules(ticker: str, rules: dict, start: str, end: str, timeframe: str = "1d"):
    """Fetch + align every symbol a rule set references, resolve each one's live
    context, and evaluate the rules on the chosen base timeframe. Returns
    (signal_array, primary_close) where primary_close is a Series indexed by the
    shared bars."""
    from strategies.market_context import resolve_context
    primary = ticker.strip().upper()
    tickers = referenced_tickers(rules, primary)
    index, frames = build_aligned_frames(tickers, start, end, timeframe)
    if index is None or primary not in frames:
        return None, None
    ctx_by_ticker = {tk: resolve_context(tk, rules) for tk in frames}
    prices = frames[primary]
    sig = evaluate_custom_rules(prices, rules, frames=frames,
                                ctx_by_ticker=ctx_by_ticker, primary=primary,
                                daily_index=index, intraday_base=_is_intraday_tf(timeframe))
    return sig, pd.Series(prices, index=index, name=primary)


@router.post("/custom-backtest")
def custom_backtest(req: CustomBacktestRequest):
    from .algo import _apply_risk_controls
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
    signal = _apply_risk_controls(
        signal, close, req.stop_loss, req.take_profit, req.trailing_stop, req.max_hold_bars,
    )
    bpy = _BACKTEST_TF.get(tf, ("1d", 252))[1]
    result = _instrument_metrics(signal, close, req.instrument, req.side, req.ticker,
                                 req.position_size, req.initial_capital, bars_per_year=bpy)
    # Surface the window + timeframe actually used so "history" is never ambiguous.
    result["bars"] = int(len(close))
    result["timeframe"] = tf
    _fmt = (lambda d: d.strftime("%Y-%m-%d %H:%M")) if _is_intraday_tf(tf) else (lambda d: str(d.date()))
    result["span"] = {"start": _fmt(close.index[0]), "end": _fmt(close.index[-1])}
    return result


def _instrument_metrics(signal, close, instrument, side, ticker, position_size, capital, bars_per_year: int = 252):
    """Metrics for one position given its resolved signal + close: modeled option
    P&L for an option instrument (long buys it, short writes it), else long/short
    shares. `side` drives direction for both. Same result shape as /algo/backtest.
    Raises 422 if an option can't be priced."""
    from .algo import _compute_metrics, _compute_option_metrics
    inst = instrument or {}
    if inst.get("kind") == "option":
        try:
            from routers.options import options_snapshot
            iv = options_snapshot(ticker).get("atm_iv")
        except Exception:
            iv = None
        if not isinstance(iv, (int, float)) or iv <= 0:
            raise HTTPException(422, f"No implied volatility available to model options for {ticker}")
        return _compute_option_metrics(signal, close, inst, float(iv), position_size, capital, direction=side, bars_per_year=bars_per_year)
    return _compute_metrics(signal, close, position_size, capital, direction=side, bars_per_year=bars_per_year)


# ─── Multi-position portfolio backtest ────────────────────────────────────────
# A strategy can be a BOOK of positions, each with its own ticker, instrument
# (shares long/short or a modeled option), rules, and capital weight. Each runs
# through the shared engine; equity curves are weight-scaled, date-aligned, and
# summed into one portfolio curve with per-position attribution.

class PortfolioPosition(BaseModel):
    ticker:        str
    rules:         dict = {}
    instrument:    dict | None = None   # {kind:"shares"|"option", type:"call"|"put", ...}; None = shares
    side:          str = "long"          # long|short — drives direction for shares AND options
    weight:        float = 0.0           # % of capital; all-zero ⇒ equal weight
    position_size: float = 100
    stop_loss:     float | None = None
    take_profit:   float | None = None
    trailing_stop: float | None = None
    max_hold_bars: int | None = None


class PortfolioBacktestRequest(BaseModel):
    positions:       list[PortfolioPosition]
    start:           str = "2022-01-01"
    end:             str | None = None
    initial_capital: float = 10_000

    @model_validator(mode="after")
    def _validate(self):
        if not (1 <= len(self.positions) <= 12):
            raise ValueError("A portfolio needs 1-12 positions")
        for p in self.positions:
            p.ticker = validate_ticker(p.ticker)
        validate_date(self.start)
        if self.end:
            validate_date(self.end)
        return self


@router.post("/portfolio-backtest")
def portfolio_backtest(req: PortfolioBacktestRequest):
    from .algo import _apply_risk_controls
    import datetime as _dt
    import numpy as _np
    end = req.end or _dt.date.today().isoformat()

    weights = [max(0.0, p.weight) for p in req.positions]
    if sum(weights) <= 0:
        weights = [100.0 / len(req.positions)] * len(req.positions)
    tot_w = sum(weights)

    legs = []   # (position, cap, result)
    for p, w in zip(req.positions, weights):
        cap = (w / tot_w) * req.initial_capital
        sig_arr, close = _run_custom_rules(p.ticker, p.rules, req.start, end)
        if close is None or len(close) < 40:
            continue
        signal = pd.Series(sig_arr, index=close.index)
        signal = _apply_risk_controls(signal, close, p.stop_loss, p.take_profit, p.trailing_stop, p.max_hold_bars)
        try:
            res = _instrument_metrics(signal, close, p.instrument, p.side, p.ticker, p.position_size, cap)
        except HTTPException:
            continue
        legs.append((p, cap, res))

    if not legs:
        raise HTTPException(422, "No position produced a backtest (check tickers, rules, and date range)")

    def _series(res, key):
        return pd.Series([pt[key] for pt in res["equity_curve"]],
                         index=pd.to_datetime([pt["date"] for pt in res["equity_curve"]]))

    eq_df = pd.concat({str(i): _series(res, "strategy") for i, (_, _, res) in enumerate(legs)}, axis=1, join="inner")
    bm_df = pd.concat({str(i): _series(res, "benchmark") for i, (_, _, res) in enumerate(legs)}, axis=1, join="inner")
    if eq_df.empty:
        raise HTTPException(422, "Positions share no overlapping trading days — align their tickers or date range")
    idle_cash = req.initial_capital - sum(cap for _, cap, _ in legs)   # capital of any dropped positions
    port_eq = eq_df.sum(axis=1) + idle_cash
    port_bm = bm_df.sum(axis=1) + idle_cash

    n = len(port_eq)
    daily = port_eq.pct_change()
    total_return = float(port_eq.iloc[-1] / req.initial_capital - 1) * 100
    ann_return = float(((port_eq.iloc[-1] / req.initial_capital) ** (252 / max(1, n)) - 1) * 100)
    dd = (port_eq - port_eq.cummax()) / port_eq.cummax()
    sharpe = float(daily.mean() / daily.std() * _np.sqrt(252)) if daily.std() > 0 else 0.0
    trades_tot = sum(res["metrics"]["num_trades"] for _, _, res in legs)
    wins_tot = sum(round(res["metrics"]["win_rate"] / 100 * res["metrics"]["num_trades"]) for _, _, res in legs)
    win_rate = float(wins_tot / trades_tot * 100) if trades_tot else 0.0

    curve = [{"date": d.strftime("%Y-%m-%d"), "strategy": round(float(sv), 2), "benchmark": round(float(bv), 2)}
             for d, sv, bv in zip(port_eq.index, port_eq.values, port_bm.values)]
    positions_out = [{
        "ticker": p.ticker, "side": p.side,
        "instrument": (p.instrument or {}).get("kind", "shares"),
        "opt_type": (p.instrument or {}).get("type"),
        "weight_pct": round(cap / req.initial_capital * 100, 1),
        "return_pct": res["metrics"]["total_return"],
        "pnl": round(float(_series(res, "strategy").iloc[-1]) - cap, 2),
        "num_trades": res["metrics"]["num_trades"],
    } for (p, cap, res) in legs]

    return {
        "equity_curve": curve,
        "metrics": {
            "total_return": round(total_return, 2), "ann_return": round(ann_return, 2),
            "max_drawdown": round(float(dd.min() * 100), 2), "sharpe": round(sharpe, 3),
            "num_trades": trades_tot, "win_rate": round(win_rate, 1),
            "initial_capital": round(req.initial_capital, 2), "final_capital": round(float(port_eq.iloc[-1]), 2),
            "total_pnl": round(float(port_eq.iloc[-1]) - req.initial_capital, 2),
        },
        "positions": positions_out,
    }
