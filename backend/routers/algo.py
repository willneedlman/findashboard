import threading
import hashlib
import json
import numpy as np
import pandas as pd
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field, model_validator
from cachetools import TTLCache
import sys, os
sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))
from cache import get_history, get_info

router = APIRouter()

# Path+signal packs: expensive GBM + rule eval. Reused when only sizing / TP-SL /
# max-hold / EAR change. Keyed per ticker; ~tens of MB for large baskets.
_MC_PATH_CACHE_TTL = int(os.getenv("COMBO_MC_PATH_CACHE_TTL", "1800"))  # 30 min
_MC_PATH_CACHE_MAX = int(os.getenv("COMBO_MC_PATH_CACHE_MAX", "64"))
_MC_PATH_CACHE: TTLCache = TTLCache(maxsize=_MC_PATH_CACHE_MAX, ttl=_MC_PATH_CACHE_TTL)
_MC_PATH_CACHE_LOCK = threading.Lock()
_MC_PATH_CACHE_STATS = {"hits": 0, "misses": 0}

# combo_monte_carlo's (n_sims, dte+1) path grid can peak at ~150-200MB per
# request at the endpoint's own caps — same failure shape as the yfinance
# BoundedSemaphore(2) in cache.py (added after a real prod OOM on this 1GB
# VM), so a concurrent-request cap applies here too rather than letting
# requests stack unbounded. A ticker basket accumulates into one running
# total instead of holding a (n_sims, dte+1) array per ticker (see
# _combo_monte_carlo_impl), so its peak stays bounded by _BASKET_FETCH_WORKERS
# in-flight arrays regardless of basket size, not by the ticker count.
#
# Acquire timeout is intentionally long: a waiting request holds no path
# arrays, so queueing is safe. The old 10s default turned "two slow jobs
# already running" into an immediate 503 even for a 1-ticker/100-path run.
_COMBO_MC_CONCURRENCY = max(1, int(os.getenv("COMBO_MC_CONCURRENCY", "2")))
_COMBO_MC_SEM = threading.BoundedSemaphore(_COMBO_MC_CONCURRENCY)
_COMBO_MC_TIMEOUT = float(os.getenv("COMBO_MC_ACQUIRE_TIMEOUT", "90"))
_BASKET_FETCH_WORKERS = 8
# Strategy-entry mode is pure-Python day-by-day BS. Caps allow multi-year
# universe runs (e.g. 80 names × 1000 paths × 1024d); heavy jobs use a
# process pool to escape the GIL. Memory stays bounded by in-flight workers
# (one (n, horizon) grid each), not by basket size.
_STRATEGY_N_SIMS_CAP = int(os.getenv("COMBO_MC_STRATEGY_N_SIMS_CAP", "2000"))
_STRATEGY_HORIZON_CAP = int(os.getenv("COMBO_MC_STRATEGY_HORIZON_CAP", "1260"))  # ~5y trading days
_STRATEGY_PROC_WORKERS = max(1, min(
    int(os.getenv("COMBO_MC_STRATEGY_WORKERS", "4")),
    max(1, (os.cpu_count() or 2)),
))
# sim-day units (tickers × n_sims × horizon) above this → process pool
_STRATEGY_PROC_MIN_WORK = int(os.getenv("COMBO_MC_PROC_MIN_WORK", "50000"))
# Live option-chain walk can hang on yfinance; MC only needs spot + a vol.
_MC_SNAP_TIMEOUT = float(os.getenv("COMBO_MC_SNAP_TIMEOUT", "12"))
# Custom rules with OPT_IVRANK(252) need rv_period(21)+rank(252) ≈ 272 trading
# bars before the indicator is non-NaN. 250 calendar days only yields ~170 bars,
# so IV-rank conditions never fire and the whole basket stays flat. ~800 calendar
# days ≈ 550 sessions — enough for IVR(252) + a buffer for PCT_CHANGE(30) etc.
_STRATEGY_HIST_LOOKBACK_DAYS = int(os.getenv("COMBO_MC_HIST_LOOKBACK_DAYS", "800"))
_STRATEGY_HIST_MIN_BARS = 300


class BacktestRequest(BaseModel):
    ticker: str
    strategy: str
    params: dict = {}
    start: str = "2022-01-01"
    end: str | None = None
    stop_loss: float | None = None      # exit if price drops X% from entry
    take_profit: float | None = None    # exit if price rises X% from entry
    trailing_stop: float | None = None  # exit if price drops X% from its peak since entry
    max_hold_bars: int | None = None    # time-based exit: close after N trading days
    position_size: float = 100          # % of portfolio allocated per trade
    initial_capital: float = 10_000    # starting capital for $ P&L metrics


class SignalRequest(BaseModel):
    ticker: str
    strategy: str
    params: dict = {}


def _fetch_close(ticker: str, start: str, end: str | None) -> pd.Series:
    hist = get_history(ticker, start=start, end=end)
    if hist.empty:
        raise HTTPException(status_code=404, detail=f"No data for {ticker}")
    return hist["Close"].dropna()


def _compute_rsi(close: pd.Series, period: int) -> pd.Series:
    delta = close.diff()
    gain = delta.clip(lower=0)
    loss = -delta.clip(upper=0)
    avg_gain = gain.ewm(com=period - 1, min_periods=period).mean()
    avg_loss = loss.ewm(com=period - 1, min_periods=period).mean()
    rs = avg_gain / avg_loss.replace(0, np.nan)
    return 100 - (100 / (1 + rs))


def _compute_signal(close: pd.Series, strategy: str, params: dict) -> pd.Series:
    p = params or {}

    if strategy == "rsi_mean_reversion":
        period = int(p.get("period", 14))
        oversold = float(p.get("oversold", 30))
        overbought = float(p.get("overbought", 70))
        rsi = _compute_rsi(close, period)
        signal = pd.Series(np.nan, index=close.index)
        in_trade = False
        for i in range(1, len(rsi)):
            if not in_trade and rsi.iloc[i - 1] < oversold and rsi.iloc[i] >= oversold:
                in_trade = True
            elif in_trade and rsi.iloc[i - 1] > overbought and rsi.iloc[i] <= overbought:
                in_trade = False
            signal.iloc[i] = 1 if in_trade else 0
        return signal.fillna(0)

    elif strategy == "ma_crossover":
        fast = int(p.get("fast", 20))
        slow = int(p.get("slow", 50))
        fast_ma = close.rolling(fast).mean()
        slow_ma = close.rolling(slow).mean()
        signal = (fast_ma > slow_ma).astype(float)
        return signal

    elif strategy == "bollinger_breakout":
        period = int(p.get("period", 20))
        std_dev = float(p.get("std_dev", 2.0))
        mid = close.rolling(period).mean()
        std = close.rolling(period).std()
        upper = mid + std_dev * std
        lower = mid - std_dev * std
        signal = pd.Series(0.0, index=close.index)
        in_trade = False
        for i in range(period, len(close)):
            if not in_trade and close.iloc[i] > upper.iloc[i]:
                in_trade = True
            elif in_trade and close.iloc[i] < lower.iloc[i]:
                in_trade = False
            signal.iloc[i] = 1.0 if in_trade else 0.0
        return signal

    elif strategy == "momentum":
        lookback = int(p.get("lookback", 20))
        ret = close.pct_change(lookback)
        signal = (ret > 0).astype(float)
        return signal

    elif strategy == "macd_crossover":
        fast_p = int(p.get("fast", 12))
        slow_p = int(p.get("slow", 26))
        sig_p  = int(p.get("signal", 9))
        ema_f  = close.ewm(span=fast_p, adjust=False).mean()
        ema_s  = close.ewm(span=slow_p, adjust=False).mean()
        macd   = ema_f - ema_s
        sig_ln = macd.ewm(span=sig_p, adjust=False).mean()
        signal = (macd > sig_ln).astype(float)
        return signal

    elif strategy == "value_pe":
        pe_threshold = float(p.get("pe_in_threshold", 35.0))
        tkr_sym = str(close.name) if close.name else "UNKNOWN"
        try:
            info = get_info(tkr_sym)
            pe = info.get("trailingPE") or info.get("forwardPE")
        except Exception:
            pe = None
        sig_v = 1.0 if (pe is None or pe <= 0 or pe < pe_threshold) else 0.0
        return pd.Series(sig_v, index=close.index)

    elif strategy == "earnings_momentum":
        exit_t = float(p.get("exit_threshold_pct", -5.0)) / 100
        tkr_sym = str(close.name) if close.name else "UNKNOWN"
        try:
            info = get_info(tkr_sym)
            eg = info.get("earningsQuarterlyGrowth")
        except Exception:
            eg = None
        sig_v = 1.0 if (eg is None or eg > exit_t) else 0.0
        return pd.Series(sig_v, index=close.index)

    elif strategy == "micro_scalp":
        fast_p  = int(p.get("ema_fast", 3))
        slow_p  = int(p.get("ema_slow", 8))
        atr_per = int(p.get("atr_period", 5))
        atr_mul = float(p.get("atr_mult", 0.3))
        ema_f   = close.ewm(span=fast_p, adjust=False).mean()
        ema_s   = close.ewm(span=slow_p, adjust=False).mean()
        tr      = close.diff().abs()
        atr_pct = tr.rolling(atr_per, min_periods=1).mean() / close * 100
        atr_ok  = (atr_pct >= atr_mul) if atr_mul > 0 else pd.Series(True, index=close.index)
        signal  = ((ema_f > ema_s) & atr_ok).astype(float)
        return signal

    else:
        raise HTTPException(status_code=400, detail=f"Unknown strategy: {strategy}")


def _apply_risk_controls(
    signal: pd.Series,
    close: pd.Series,
    stop_loss: float | None,
    take_profit: float | None,
    trailing_stop: float | None = None,
    max_hold_bars: int | None = None,
    exit_kinds: dict | None = None,
) -> pd.Series:
    """exit_kinds, if passed, is mutated in place: {Timestamp: "stop_loss"|
    "take_profit"|"trailing_stop"|"max_hold"} for every risk-forced exit — lets
    callers distinguish a risk-control exit from a rule-driven one (e.g. for
    trade-marker tooltips), without changing this function's return shape for
    existing callers that don't need it."""
    no_controls = all(v is None for v in [stop_loss, take_profit, trailing_stop, max_hold_bars])
    if no_controls:
        return signal
    result = signal.copy()
    in_trade = False
    entry_price = 0.0
    peak_price = 0.0
    bars_held = 0
    blocked = False
    for i in range(len(signal)):
        raw = float(signal.iloc[i])
        price = float(close.iloc[i])
        if in_trade:
            peak_price = max(peak_price, price)
            bars_held += 1
            exit_kind = None
            if stop_loss is not None and price <= entry_price * (1 - stop_loss / 100):
                exit_kind = "stop_loss"
            if exit_kind is None and take_profit is not None and price >= entry_price * (1 + take_profit / 100):
                exit_kind = "take_profit"
            if exit_kind is None and trailing_stop is not None and price <= peak_price * (1 - trailing_stop / 100):
                exit_kind = "trailing_stop"
            if exit_kind is None and max_hold_bars is not None and bars_held >= max_hold_bars:
                exit_kind = "max_hold"
            if exit_kind is not None:
                result.iloc[i] = 0.0
                in_trade = False
                blocked = True
                bars_held = 0
                if exit_kinds is not None:
                    exit_kinds[close.index[i]] = exit_kind
            else:
                result.iloc[i] = 1.0
        else:
            if blocked and raw == 0.0:
                blocked = False
            if not blocked and raw == 1.0:
                in_trade = True
                entry_price = price
                peak_price = price
                bars_held = 1
                result.iloc[i] = 1.0
            else:
                result.iloc[i] = 0.0
    return result


def _floor_equity(equity: pd.Series):
    """Freeze an equity curve at 0 the first time it goes non-positive. A
    leveraged position can lose more than 100% in a single bar; letting a raw
    cumulative-return series carry on compounding past that point lets it
    swing back above zero on a later "gain", which misrepresents a wipeout as
    a recovery. Real accounts don't get that free option — once equity hits
    zero the position is liquidated and stays at zero. Returns
    (floored_series, date_of_wipeout_or_None)."""
    non_positive = equity <= 0
    if not non_positive.any():
        return equity, None
    first = non_positive.idxmax()
    out = equity.copy()
    out.loc[first:] = 0.0
    return out, first


def _safe_ann_return(final_capital: float, initial_capital: float, ann_factor: float) -> float:
    """(final/initial) ** ann_factor blows up into a complex number for a
    non-integer ann_factor once final_capital is negative — guard the
    wipeout case explicitly instead of relying on floored equity everywhere."""
    if initial_capital <= 0:
        return 0.0
    ratio = final_capital / initial_capital
    if ratio <= 0:
        return -100.0
    return float(ratio ** ann_factor - 1) * 100


def _ear_bar_rate(effective_annual_rate: float, bars_per_year: float) -> float:
    """Per-bar compounding rate implied by an effective annual rate (%), for
    contexts that accrue financing once per trading bar (historical
    backtests, keyed off the series' own bar count/year)."""
    return (1 + effective_annual_rate / 100.0) ** (1 / bars_per_year) - 1


def _ear_growth_factor(effective_annual_rate: float, days, day_count: float = 365.0):
    """Total compounding growth factor an effective annual rate (%) implies
    over a calendar-day span (accepts a scalar or an ndarray of days) — for
    contexts keyed off actual DTE/holding-period days rather than trading
    bars (options/combo Monte Carlo). Multiply by borrowed notional directly;
    the result is already "growth over the period", not a per-day rate."""
    return np.power(1 + effective_annual_rate / 100.0, days / day_count) - 1


def _apply_financing_cost(equity: pd.Series, signal: pd.Series, trade_size_pct: float,
                          initial_capital: float, effective_annual_rate: float, bars_per_year: int):
    """Charge daily-compounded interest on whatever notional a leveraged
    position carries beyond 100% of initial capital — the same borrowed-cash
    model portfolio_backtest uses, applied to a single position so a
    leveraged single-ticker backtest isn't "free" leverage with no financing
    drag. Returns (equity_with_financing_deducted, total_interest_paid)."""
    if effective_annual_rate <= 0 or trade_size_pct <= 100:
        return equity, 0.0
    gross_notional = signal.reindex(equity.index).ffill().fillna(0.0) * (trade_size_pct / 100.0) * initial_capital
    borrowed_notional = (gross_notional - initial_capital).clip(lower=0.0)
    interest_cost = borrowed_notional * _ear_bar_rate(effective_annual_rate, bars_per_year)
    total_interest = float(interest_cost.sum())
    if not total_interest:
        return equity, 0.0
    return equity - interest_cost.cumsum(), total_interest


def _summarize_equity(equity: pd.Series, initial_capital: float, bars_per_year: int, blown_up_at=None) -> dict:
    """Recompute the standard summary stats (total/ann return, drawdown,
    Sharpe, final capital) from an equity curve that's already been floored —
    used after a post-hoc adjustment (financing cost) changes a curve that an
    engine already summarized once."""
    n = len(equity)
    ann_factor = bars_per_year / max(1, n)
    total_return = float(equity.iloc[-1] / initial_capital - 1) * 100
    ann_return = _safe_ann_return(float(equity.iloc[-1]), initial_capital, ann_factor)
    roll_max = equity.cummax().replace(0, np.nan)
    drawdown = (equity - roll_max) / roll_max
    max_drawdown = float(drawdown.min(skipna=True) * 100) if drawdown.notna().any() else -100.0
    if blown_up_at is not None:
        max_drawdown = min(max_drawdown, -100.0)
    daily = equity.pct_change()
    sharpe = float(daily.mean() / daily.std() * np.sqrt(bars_per_year)) if daily.std() > 0 else 0.0
    return {
        "total_return": round(total_return, 2), "ann_return": round(ann_return, 2),
        "max_drawdown": round(max_drawdown, 2), "sharpe": round(sharpe, 3),
        "final_capital": round(float(equity.iloc[-1]), 2),
        "total_pnl": round(float(equity.iloc[-1]) - initial_capital, 2),
    }


def _compute_metrics(buy_signal: np.ndarray, sell_signal: np.ndarray, close: pd.Series,
                     position_size: float = 100, initial_capital: float = 10_000,
                     direction: str = "long", bars_per_year: int = 252, intraday: bool = False,
                     stop_loss: float | None = None, take_profit: float | None = None,
                     trailing_stop: float | None = None, max_hold_bars: int | None = None,
                     exit_pct: float = 100.0, max_open_positions: int | None = None):
    """Shares are fungible — a share bought at $80 and one bought at $100
    aren't distinguishable positions the way two options with different
    strikes are, and P&L doesn't depend on which one a later sale is
    "attributed to". So this tracks ONE aggregate position (shares held +
    total cost basis), not a stack of lots: every bar the buy signal fires
    while flat OR already holding, `alloc` fraction of currently-available
    cash buys more shares at that bar's close, folding into the average cost.
    The rule-based sell signal closes `exit_pct` of whatever's open each time
    it fires (100 = the whole position at once, matching the old behavior;
    less than 100 trims it, and a still-true sell signal keeps trimming the
    remainder bar over bar, same level-triggered semantics as the buy side).
    A risk control (stop-loss/take-profit/trailing-stop/max-hold, evaluated
    against the position's own average cost basis, tracked from whenever it
    was last fully flat) always closes the position in full. A short mirrors
    the long side's dollar P&L (project convention, matches the option/combo
    engines) rather than modeling real short-sale margin mechanics."""
    alloc = max(0.0, position_size) / 100.0
    exit_frac_cfg = max(0.0, min(1.0, exit_pct / 100.0))
    # Intraday keeps the time in each label so bars within a day stay distinct
    # (a date-only label would collapse them and break the curve / portfolio join).
    _dfmt = "%Y-%m-%d %H:%M" if intraday else "%Y-%m-%d"
    sign = -1.0 if direction == "short" else 1.0
    px = close.values.astype(float)
    idx = close.index
    n = len(px)

    cash = initial_capital
    shares = 0.0
    cost_basis = 0.0    # total $ committed to the currently-open aggregate position
    entry_i: int | None = None   # bar the position was last opened from flat (max_hold_bars)
    peak_price = 0.0    # best price seen (favorable direction) since entry_i (trailing stop)
    cycle_buys = 0      # buys in the CURRENT open cycle, resolved to win/loss when it closes
    cycle_cost_total = 0.0      # $ ever committed across this cycle's buys (win/loss basis)
    cycle_proceeds_total = 0.0  # $ realized so far across this cycle's exits (partial + final)
    cycle_peak_cost = 0.0       # largest cost_basis this cycle has reached (dust-close threshold)

    equity = np.empty(n)
    equity[0] = initial_capital
    in_position = np.zeros(n)
    trades: list[dict] = []
    total_buys = 0
    wins = 0
    position_limit_blocked_entries = 0

    for i in range(1, n):
        price = px[i]
        exit_kind = None

        if shares > 0:
            peak_price = max(peak_price, price) if sign > 0 else min(peak_price, price)
            avg_entry = cost_basis / shares
            pct_move = sign * (price / avg_entry - 1) * 100
            if stop_loss is not None and pct_move <= -stop_loss:
                exit_kind = "stop_loss"
            if exit_kind is None and take_profit is not None and pct_move >= take_profit:
                exit_kind = "take_profit"
            if exit_kind is None and trailing_stop is not None:
                peak_pct = sign * (peak_price / avg_entry - 1) * 100
                if peak_pct - pct_move >= trailing_stop:
                    exit_kind = "trailing_stop"
            if exit_kind is None and max_hold_bars is not None and entry_i is not None and (i - entry_i) >= max_hold_bars:
                exit_kind = "max_hold"
            if exit_kind is None and sell_signal[i]:
                exit_kind = "rule"

            if exit_kind is not None:
                frac = 1.0
                if exit_kind == "rule" and exit_frac_cfg < 1.0:
                    frac = exit_frac_cfg
                    # Don't let a persistently-true exit rule leave an
                    # ever-shrinking dust tail open forever — once what's
                    # left is under 0.5% of this cycle's peak size, close it.
                    if cost_basis * (1 - frac) <= max(0.01, cycle_peak_cost * 0.005):
                        frac = 1.0
                closed_shares = shares * frac
                closed_cost = cost_basis * frac
                proceeds = closed_cost + sign * closed_shares * (price - avg_entry)
                cash += proceeds
                cycle_proceeds_total += proceeds
                shares -= closed_shares
                cost_basis -= closed_cost
                trade_entry = {"date": idx[i].strftime(_dfmt), "action": "SELL",
                               "price": round(float(price), 2), "is_entry": False,
                               "exit_kind": None if exit_kind == "rule" else exit_kind}
                if frac < 1.0:
                    trade_entry["partial_pct"] = round(frac * 100, 1)
                trades.append(trade_entry)
                if shares <= 1e-9:
                    if cycle_proceeds_total > cycle_cost_total:
                        wins += cycle_buys
                    shares, cost_basis, entry_i, peak_price = 0.0, 0.0, None, 0.0
                    cycle_buys, cycle_cost_total, cycle_proceeds_total, cycle_peak_cost = 0, 0.0, 0.0, 0.0

        position_limit_reached = max_open_positions is not None and cycle_buys >= max_open_positions
        if buy_signal[i] and cash > 0.01 and position_limit_reached:
            position_limit_blocked_entries += 1
        if buy_signal[i] and cash > 0.01 and not position_limit_reached:
            invest = cash * alloc
            if invest > 0:
                new_shares = invest / price
                cash -= invest
                shares += new_shares
                cost_basis += invest
                if entry_i is None:
                    entry_i, peak_price = i, price
                cycle_buys += 1
                total_buys += 1
                cycle_cost_total += invest
                cycle_peak_cost = max(cycle_peak_cost, cost_basis)
                trades.append({"date": idx[i].strftime(_dfmt), "action": "BUY",
                               "price": round(float(price), 2), "is_entry": True})

        pos_value = 0.0
        if shares > 0:
            avg_entry = cost_basis / shares
            pos_value = cost_basis + sign * shares * (price - avg_entry)
        equity[i] = cash + pos_value
        in_position[i] = 1.0 if shares > 0 else 0.0

    equity_s = pd.Series(equity, index=idx)
    daily_ret = close.pct_change()
    benchmark = (1 + daily_ret.fillna(0)).cumprod() * initial_capital
    equity_floored, blown_up_at = _floor_equity(equity_s)

    total_return = float(equity_floored.iloc[-1] / initial_capital - 1) * 100

    # Annualized return (bars_per_year scales with the backtest timeframe: 252 daily,
    # ~1638 hourly, ~19656 for 5-minute bars, so intraday Sharpe/CAGR stay comparable).
    n_days = len(equity_floored)
    ann_factor = bars_per_year / n_days
    ann_return = _safe_ann_return(float(equity_floored.iloc[-1]), initial_capital, ann_factor)

    # Max drawdown — guard the 0/0 case a same-bar wipeout produces (roll_max
    # is 0 too when equity never traded above zero before freezing).
    roll_max = equity_floored.cummax()
    drawdown = (equity_floored - roll_max) / roll_max.replace(0, np.nan)
    max_drawdown = float(drawdown.min(skipna=True) * 100) if drawdown.notna().any() else -100.0
    if blown_up_at is not None:
        max_drawdown = min(max_drawdown, -100.0)

    strat_ret = equity_floored.pct_change()
    sharpe = float(strat_ret.mean() / strat_ret.std() * np.sqrt(bars_per_year)) if strat_ret.std() > 0 else 0.0

    trades.sort(key=lambda x: x["date"])
    num_trades = total_buys
    win_rate = float(wins / total_buys * 100) if total_buys > 0 else 0.0

    final_capital = float(equity_floored.iloc[-1])
    total_pnl = final_capital - initial_capital

    curve = []
    for date, sv, bv in zip(equity_floored.index, equity_floored.values, benchmark.values):
        curve.append({
            "date": date.strftime(_dfmt),
            "strategy": round(float(sv), 2),
            "benchmark": round(float(bv), 2),
        })

    return {
        "equity_curve": curve,
        "metrics": {
            "total_return": round(total_return, 2),
            "ann_return": round(ann_return, 2),
            "max_drawdown": round(max_drawdown, 2),
            "sharpe": round(sharpe, 3),
            "num_trades": num_trades,
            "win_rate": round(win_rate, 1),
            "initial_capital": round(initial_capital, 2),
            "final_capital": round(final_capital, 2),
            "total_pnl": round(total_pnl, 2),
            "max_open_positions": max_open_positions,
            "position_limit_blocked_entries": position_limit_blocked_entries,
            "blown_up_at": blown_up_at.strftime(_dfmt) if blown_up_at is not None else None,
        },
        "trades": trades,
        "in_position": in_position.tolist(),
    }


_OPT_MULT = 100


def _compute_option_metrics(buy_signal: np.ndarray, sell_signal: np.ndarray, close: pd.Series, opt: dict, iv: float,
                            position_size: float = 100, initial_capital: float = 10_000,
                            direction: str = "long", bars_per_year: int = 252, intraday: bool = False,
                            stop_loss: float | None = None, take_profit: float | None = None,
                            trailing_stop: float | None = None, max_hold_bars: int | None = None,
                            exit_pct: float = 100.0,
                            delta_exit: float | None = None, gamma_exit: float | None = None,
                            max_open_positions: int | None = None):
    """Modeled single-option backtest, multi-lot: every bar the buy signal
    fires, ANOTHER fresh Black-Scholes-priced call/put (strike = moneyness ×
    spot at that bar, fixed DTE) opens sized off currently-available cash —
    unlike shares, each entry is a genuinely distinct instrument (its own
    strike/expiry fixed at entry time), so lots are tracked independently
    rather than blended into one average. Each lot marks itself daily as time
    decays and closes on its OWN risk-control trigger or its own calendar
    expiry; the shared sell rule, when it fires, closes every still-open lot
    at once (each realized at its own current value). IV is held at the
    current snapshot value for every lot — the project has no historical
    option prices — so this is an APPROXIMATION, labeled as modeled in the UI.
    A short leg mirrors the long leg's dollar P&L (project convention).
    Expiry is cash-settled at intrinsic value, which is economically
    equivalent to exercise/assignment with an immediately flattened share delivery;
    assignment margin and post-expiry shares are not carried. Benchmark stays
    underlying buy & hold.

    stop_loss/take_profit/trailing_stop are evaluated against EACH LOT'S OWN
    unrealized P&L (as % of that lot's own entry premium paid/collected), not
    the underlying's price move — an option's value doesn't move 1:1 with the
    underlying (theta, vega, and non-ATM strikes all break that), so a
    price-based stop would trigger at the wrong P&L level or not at all.
    max_hold_bars forces a lot's exit after N bars even if its own DTE/the
    rules haven't closed it. delta_exit/gamma_exit close a lot once |delta|/
    |gamma| (the option's own, direction-agnostic — how far ITM or how fast
    its value is curving) reaches the threshold; both use the SAME
    constant-IV Black-Scholes approximation already used for the lot's P&L,
    so this isn't a new source of inaccuracy over what the rest of the engine
    already assumes."""
    from math_engine import bs_price, bs_greeks
    otype = "put" if str(opt.get("type", "call")).lower().startswith("p") else "call"
    moneyness = float(opt.get("moneyness", 1.0))
    dte = max(1, int(opt.get("dte", 30)))
    short = direction == "short"
    entry_action = "SELL" if short else "BUY"   # short = sell-to-open
    exit_action = "BUY" if short else "SELL"
    r = 4.0
    alloc = max(0.0, position_size) / 100.0
    exit_frac_cfg = max(0.0, min(1.0, exit_pct / 100.0))
    _dfmt = "%Y-%m-%d %H:%M" if intraday else "%Y-%m-%d"
    idx = close.index
    px = close.to_numpy(dtype=float)
    n = len(px)

    equity = np.empty(n)
    cash = float(initial_capital)
    cur = float(initial_capital)
    lots: list[dict] = []   # each: {strike, entry_i, expiry_at, entry_val, entry_mtm, basis, orig_basis, peak_pnl, signed_contracts}
    trades: list[dict] = []
    wiped_out = False
    blown_up_at = None
    num_trades = 0
    wins = 0
    in_position = np.empty(n, dtype=bool)
    position_limit_blocked_entries = 0

    def _val(lot: dict, i: int) -> float:
        remaining_days = max(0, (lot["expiry_at"] - idx[i]).total_seconds() / 86_400)
        return float(bs_price(px[i], lot["strike"], remaining_days, r, iv, otype))

    def _greeks(lot: dict, i: int) -> tuple[float, float]:
        remaining_days = max(0, (lot["expiry_at"] - idx[i]).total_seconds() / 86_400)
        g = bs_greeks(px[i], lot["strike"], remaining_days, r, iv, otype)
        return g["delta"], g["gamma"]

    def _settlement(lot: dict, i: int) -> str:
        intrinsic = max(px[i] - lot["strike"], 0.0) if otype == "call" else max(lot["strike"] - px[i], 0.0)
        if intrinsic <= 0:
            return "expired_worthless"
        return "assignment" if short else "exercise"

    def _close_lot(lot: dict, i: int, exit_kind: str, frac: float = 1.0):
        """Closes `frac` of this lot's contracts (1.0 = all of it, the only
        value any non-rule exit ever uses). A partial rule-close realizes its
        share of cash and shrinks the lot in place — basis/peak_pnl scale down
        with it so a later stop/take-profit % check still reads correctly
        against what's actually still open."""
        nonlocal cash, num_trades, wins
        v = _val(lot, i)
        closed_contracts = lot["signed_contracts"] * frac
        cash += closed_contracts * v * _OPT_MULT
        num_trades += 1
        # A short leg profits when it buys the option back cheaper than it sold it.
        if (v < lot["entry_val"] if short else v > lot["entry_val"]):
            wins += 1
        trade_entry = {"date": idx[i].strftime(_dfmt), "action": "EXPIRE" if exit_kind == "expiration" else exit_action,
                       "price": round(v, 2), "is_entry": False, "exit_kind": exit_kind,
                       **({"settlement": _settlement(lot, i)} if exit_kind == "expiration" else {})}
        if frac < 1.0:
            trade_entry["partial_pct"] = round(frac * 100, 1)
        trades.append(trade_entry)
        if frac < 1.0:
            lot["signed_contracts"] -= closed_contracts
            lot["entry_mtm"] *= (1 - frac)
            lot["basis"] = max(abs(lot["entry_mtm"]), 0.01)
            lot["peak_pnl"] *= (1 - frac)

    for i in range(n):
        if wiped_out:
            equity[i] = 0.0
            in_position[i] = False
            continue

        remaining: list[dict] = []
        for lot in lots:
            expires_now = idx[i] >= lot["expiry_at"]
            exit_kind = None
            if not expires_now:
                pnl = lot["signed_contracts"] * _val(lot, i) * _OPT_MULT - lot["entry_mtm"]
                lot["peak_pnl"] = max(lot["peak_pnl"], pnl)
                if stop_loss is not None and pnl <= -(stop_loss / 100.0) * lot["basis"]:
                    exit_kind = "stop_loss"
                if exit_kind is None and take_profit is not None and pnl >= (take_profit / 100.0) * lot["basis"]:
                    exit_kind = "take_profit"
                if exit_kind is None and trailing_stop is not None and pnl <= lot["peak_pnl"] - (trailing_stop / 100.0) * lot["basis"]:
                    exit_kind = "trailing_stop"
                if exit_kind is None and (delta_exit is not None or gamma_exit is not None):
                    d, g = _greeks(lot, i)
                    if delta_exit is not None and abs(d) >= delta_exit:
                        exit_kind = "delta_exit"
                    elif gamma_exit is not None and abs(g) >= gamma_exit:
                        exit_kind = "gamma_exit"
                if exit_kind is None and max_hold_bars is not None and (i - lot["entry_i"]) >= max_hold_bars:
                    exit_kind = "max_hold"
            else:
                exit_kind = "expiration"
            if exit_kind is not None:
                _close_lot(lot, i, exit_kind)
            else:
                remaining.append(lot)
        lots = remaining

        if lots and sell_signal[i]:
            if exit_frac_cfg >= 1.0:
                for lot in lots:
                    _close_lot(lot, i, "rule")
                lots = []
            else:
                # A persistently-true exit rule keeps trimming every lot bar
                # over bar; once what's left of a given lot is under 0.5% of
                # its ORIGINAL size, finish it off instead of leaving dust.
                remaining_lots = []
                for lot in lots:
                    if abs(lot["entry_mtm"]) * (1 - exit_frac_cfg) <= max(0.01, lot["orig_basis"] * 0.005):
                        _close_lot(lot, i, "rule", 1.0)
                    else:
                        _close_lot(lot, i, "rule", exit_frac_cfg)
                        remaining_lots.append(lot)
                lots = remaining_lots

        position_limit_reached = max_open_positions is not None and len(lots) >= max_open_positions
        if buy_signal[i] and cash > 0.01 and position_limit_reached:
            position_limit_blocked_entries += 1
        if buy_signal[i] and cash > 0.01 and not position_limit_reached:
            strike = round(px[i] * moneyness, 2)
            entry_val = max(float(bs_price(px[i], strike, dte, r, iv, otype)), 0.01)
            invest = cash * alloc
            if invest > 0:
                contracts = invest / (entry_val * _OPT_MULT)
                signed_contracts = -contracts if short else contracts
                cash -= signed_contracts * entry_val * _OPT_MULT
                entry_mtm = signed_contracts * entry_val * _OPT_MULT
                lots.append({
                    "strike": strike, "entry_i": i, "expiry_at": idx[i] + pd.Timedelta(days=dte),
                    "entry_val": entry_val, "entry_mtm": entry_mtm, "basis": abs(entry_mtm) or 1.0,
                    "orig_basis": abs(entry_mtm) or 1.0,
                    "peak_pnl": 0.0, "signed_contracts": signed_contracts,
                })
                trades.append({"date": idx[i].strftime(_dfmt), "action": entry_action, "price": round(entry_val, 2), "is_entry": True})

        cur = cash + sum(lot["signed_contracts"] * _val(lot, i) * _OPT_MULT for lot in lots)
        if cur <= 0:
            # Record each lot's OWN value at liquidation, not the underlying's
            # spot price — the win/loss classification compares this "price"
            # against that lot's entry premium, and comparing an underlying
            # price (e.g. $180) against a premium (e.g. $3.50) would classify
            # almost every wipeout as a win.
            for lot in lots:
                liq_val = _val(lot, i)
                num_trades += 1
                if (liq_val < lot["entry_val"] if short else liq_val > lot["entry_val"]):
                    wins += 1
                trades.append({"date": idx[i].strftime(_dfmt), "action": "LIQUIDATED", "price": round(liq_val, 2),
                               "is_entry": False, "exit_kind": "wipeout"})
            wiped_out, blown_up_at, cur = True, idx[i], 0.0
            cash, lots = 0.0, []
        equity[i] = cur
        in_position[i] = len(lots) > 0

    eq = pd.Series(equity, index=idx)
    daily = eq.pct_change()
    benchmark = (1 + close.pct_change().fillna(0)).cumprod() * initial_capital
    total_return = float(eq.iloc[-1] / initial_capital - 1) * 100
    ann_return = _safe_ann_return(float(eq.iloc[-1]), initial_capital, bars_per_year / max(1, n))
    roll_max = eq.cummax().replace(0, np.nan)
    drawdown = (eq - roll_max) / roll_max
    max_drawdown = float(drawdown.min(skipna=True) * 100) if drawdown.notna().any() else -100.0
    if blown_up_at is not None:
        max_drawdown = min(max_drawdown, -100.0)
    sharpe = float(daily.mean() / daily.std() * np.sqrt(bars_per_year)) if daily.std() > 0 else 0.0

    win_rate = float(wins / num_trades * 100) if num_trades else 0.0

    curve = [{"date": d.strftime(_dfmt), "strategy": round(float(sv), 2), "benchmark": round(float(bv), 2)}
             for d, sv, bv in zip(eq.index, eq.values, benchmark.values)]
    return {
        "equity_curve": curve,
        "metrics": {
            "total_return": round(total_return, 2), "ann_return": round(ann_return, 2),
            "max_drawdown": round(max_drawdown, 2), "sharpe": round(sharpe, 3),
            "num_trades": num_trades, "win_rate": round(win_rate, 1),
            "initial_capital": round(initial_capital, 2), "final_capital": round(float(eq.iloc[-1]), 2),
            "total_pnl": round(float(eq.iloc[-1]) - initial_capital, 2),
            "max_open_positions": max_open_positions,
            "position_limit_blocked_entries": position_limit_blocked_entries,
            "blown_up_at": blown_up_at.strftime(_dfmt) if blown_up_at is not None else None,
        },
        "trades": trades,
        "instrument": {"kind": "option", "type": otype, "moneyness": moneyness, "dte": dte, "iv": round(iv, 1), "direction": direction, "modeled": True},
        "in_position": in_position.tolist(),
    }


def _compute_combo_metrics(buy_signal: np.ndarray, sell_signal: np.ndarray, close: pd.Series, combo: dict, iv: float,
                           position_size: float = 100, initial_capital: float = 10_000,
                           bars_per_year: int = 252, intraday: bool = False,
                           stop_loss: float | None = None, take_profit: float | None = None,
                           trailing_stop: float | None = None, max_hold_bars: int | None = None,
                           exit_pct: float = 100.0,
                           delta_exit: float | None = None, gamma_exit: float | None = None,
                           max_open_positions: int | None = None):
    """Modeled multi-leg option combo backtest (straddle/strangle/spread/condor/
    butterfly/etc — same leg shape as the Options Strategy Builder's PRESETS
    table: {type, side, moneyness, qty}), multi-lot: every bar the buy signal
    fires, ANOTHER full copy of the structure opens (every leg simultaneously,
    strike = moneyness × spot at that bar, one shared DTE) sized off
    currently-available cash — unlike shares, each entry is a genuinely
    distinct set of instruments (strikes fixed at entry time), so lots are
    tracked independently rather than blended. Each lot's net signed value is
    marked daily as time decays, and it closes on its OWN risk-control
    trigger or its own shared-DTE expiry; the shared sell rule, when it
    fires, closes every still-open lot (every leg of it) at once. IV is held
    at the current snapshot value for every leg of every lot — the project
    has no historical option prices — so this is an APPROXIMATION, labeled as
    modeled in the UI, same convention as the single-leg version.

    Unlike the single-leg function's whole-curve "mirror around 2×capital"
    trick (which only works when every leg is on the same side), each leg here
    carries its own signed quantity (+qty long, -qty short) and the account
    value is cash + Σ(signed_qty × leg value) — this handles any mix of long
    and short legs (iron condors, jade lizards, ratio spreads, ...) correctly
    without a post-hoc sign flip. A naked short leg's risk isn't capped like a
    single covered position, so the account is force-liquidated and frozen at
    zero the first bar it goes non-positive — it doesn't keep trading on
    borrowed/negative cash.

    position_size(%) scales EACH new lot to alloc% of currently-available
    cash via NOTIONAL (Σqty×spot×MULT), not premium — premium-based sizing
    blows up for cheap far-OTM legs (a strangle's wings can be a tiny
    fraction of a straddle's ATM premium, forcing an enormous contract count
    to hit the same %-of-cash target, i.e. hidden leverage with no cap).
    Notional sizing stays bounded regardless of how cheap the legs are, and
    still preserves the preset's relative leg ratios (e.g. 1:2:1 for a
    butterfly).

    stop_loss/take_profit/trailing_stop are evaluated against EACH LOT'S OWN
    unrealized P&L (as % of that lot's own entry credit/debit magnitude — the
    standard "close at 50% of max profit" convention, same basis
    combo_monte_carlo's early-exit uses), not the underlying's price move — a
    short strangle can lose or gain heavily from IV/theta with the stock
    barely moving, so a price-based stop (correct for plain shares) would
    rarely fire here at all. max_hold_bars forces a lot's exit after N bars
    even if its own DTE/the rules haven't closed it. delta_exit/gamma_exit close
    a lot once its NET delta/gamma (Σ signed_qty × leg greek, divided by Σ
    |signed_qty| so it stays on the same ~0-1 per-contract scale a single-leg
    position uses) reaches the threshold — a structure's real directional/
    curvature exposure, not any one leg's greek in isolation."""
    from math_engine import bs_price, bs_greeks
    legs_cfg = combo.get("legs") or []
    if not legs_cfg:
        raise HTTPException(422, "Combo instrument needs at least one leg")
    dte = max(1, int(combo.get("dte", 30)))
    r = 4.0
    alloc = max(0.0, position_size) / 100.0
    exit_frac_cfg = max(0.0, min(1.0, exit_pct / 100.0))
    _dfmt = "%Y-%m-%d %H:%M" if intraday else "%Y-%m-%d"
    idx = close.index
    px = close.to_numpy(dtype=float)
    n = len(px)

    equity = np.empty(n)
    cash = float(initial_capital)
    cur = float(initial_capital)
    lots: list[dict] = []   # each: {legs: [{type, strike, signed_qty}], entry_i, expiry_at, entry_mtm, basis, orig_basis, peak_pnl}
    trades: list[dict] = []
    wiped_out = False
    blown_up_at = None
    num_trades = 0
    wins = 0
    in_position = np.empty(n, dtype=bool)
    position_limit_blocked_entries = 0

    def _leg_val(leg: dict, lot: dict, i: int) -> float:
        remaining_days = max(0, (lot["expiry_at"] - idx[i]).total_seconds() / 86_400)
        return float(bs_price(px[i], leg["strike"], remaining_days, r, iv, leg["type"]))

    def _lot_mtm(lot: dict, i: int) -> float:
        return sum(l["signed_qty"] * _leg_val(l, lot, i) * _OPT_MULT for l in lot["legs"])

    def _lot_greeks(lot: dict, i: int) -> tuple[float, float]:
        remaining_days = max(0, (lot["expiry_at"] - idx[i]).total_seconds() / 86_400)
        net_delta = net_gamma = 0.0
        total_qty = 0.0
        for l in lot["legs"]:
            g = bs_greeks(px[i], l["strike"], remaining_days, r, iv, l["type"])
            net_delta += l["signed_qty"] * g["delta"]
            net_gamma += l["signed_qty"] * g["gamma"]
            total_qty += abs(l["signed_qty"])
        if total_qty <= 0:
            return 0.0, 0.0
        return net_delta / total_qty, net_gamma / total_qty

    def _settlement(leg: dict, i: int) -> str:
        intrinsic = max(px[i] - leg["strike"], 0.0) if leg["type"] == "call" else max(leg["strike"] - px[i], 0.0)
        if intrinsic <= 0:
            return "expired_worthless"
        return "exercise" if leg["signed_qty"] > 0 else "assignment"

    def _close_lot(lot: dict, i: int, exit_kind: str, frac: float = 1.0):
        """Closes `frac` of every leg in this lot (1.0 = all of it, the only
        value any non-rule exit ever uses) — each leg's signed_qty shrinks by
        the same fraction so the structure's ratio (e.g. a butterfly's 1:2:1)
        stays intact on whatever remains open."""
        nonlocal cash, num_trades, wins
        mtm = _lot_mtm(lot, i) * frac
        cash += mtm
        num_trades += 1
        if mtm - lot["entry_mtm"] * frac > 0:
            wins += 1
        for l in lot["legs"]:
            trade_entry = {
                "date": idx[i].strftime(_dfmt),
                "action": "EXPIRE" if exit_kind == "expiration" else "SELL" if l["signed_qty"] > 0 else "BUY",
                "price": round(_leg_val(l, lot, i), 2),
                "leg": f"{l['type']} {l['strike']:g}",
                "is_entry": False,
                "exit_kind": exit_kind,
                **({"settlement": _settlement(l, i)} if exit_kind == "expiration" else {}),
            }
            if frac < 1.0:
                trade_entry["partial_pct"] = round(frac * 100, 1)
            trades.append(trade_entry)
        if frac < 1.0:
            for l in lot["legs"]:
                l["signed_qty"] *= (1 - frac)
            lot["entry_mtm"] *= (1 - frac)
            lot["basis"] = max(abs(lot["entry_mtm"]), 0.01)
            lot["peak_pnl"] *= (1 - frac)

    for i in range(n):
        if wiped_out:
            equity[i] = 0.0
            in_position[i] = False
            continue

        remaining: list[dict] = []
        for lot in lots:
            expires_now = idx[i] >= lot["expiry_at"]
            exit_kind = None
            if not expires_now:
                pnl = _lot_mtm(lot, i) - lot["entry_mtm"]
                lot["peak_pnl"] = max(lot["peak_pnl"], pnl)
                if stop_loss is not None and pnl <= -(stop_loss / 100.0) * lot["basis"]:
                    exit_kind = "stop_loss"
                if exit_kind is None and take_profit is not None and pnl >= (take_profit / 100.0) * lot["basis"]:
                    exit_kind = "take_profit"
                if exit_kind is None and trailing_stop is not None and pnl <= lot["peak_pnl"] - (trailing_stop / 100.0) * lot["basis"]:
                    exit_kind = "trailing_stop"
                if exit_kind is None and (delta_exit is not None or gamma_exit is not None):
                    d, g = _lot_greeks(lot, i)
                    if delta_exit is not None and abs(d) >= delta_exit:
                        exit_kind = "delta_exit"
                    elif gamma_exit is not None and abs(g) >= gamma_exit:
                        exit_kind = "gamma_exit"
                if exit_kind is None and max_hold_bars is not None and (i - lot["entry_i"]) >= max_hold_bars:
                    exit_kind = "max_hold"
            else:
                exit_kind = "expiration"
            if exit_kind is not None:
                _close_lot(lot, i, exit_kind)
            else:
                remaining.append(lot)
        lots = remaining

        if lots and sell_signal[i]:
            if exit_frac_cfg >= 1.0:
                for lot in lots:
                    _close_lot(lot, i, "rule")
                lots = []
            else:
                remaining_lots = []
                for lot in lots:
                    if abs(lot["entry_mtm"]) * (1 - exit_frac_cfg) <= max(0.01, lot["orig_basis"] * 0.005):
                        _close_lot(lot, i, "rule", 1.0)
                    else:
                        _close_lot(lot, i, "rule", exit_frac_cfg)
                        remaining_lots.append(lot)
                lots = remaining_lots

        position_limit_reached = max_open_positions is not None and len(lots) >= max_open_positions
        if buy_signal[i] and cash > 0.01 and position_limit_reached:
            position_limit_blocked_entries += 1
        if buy_signal[i] and cash > 0.01 and not position_limit_reached:
            unscaled: list[dict] = []
            base_notional = 0.0
            for lc in legs_cfg:
                strike = round(px[i] * float(lc.get("moneyness", 1.0)), 2)
                otype = "put" if str(lc.get("type", "call")).lower().startswith("p") else "call"
                qty = max(0.0, float(lc.get("qty", 1.0)))
                signed_qty = qty if str(lc.get("side", "buy")).lower() == "buy" else -qty
                entry_val = max(float(bs_price(px[i], strike, dte, r, iv, otype)), 0.01)
                unscaled.append({"type": otype, "strike": strike, "signed_qty": signed_qty, "entry_val": entry_val})
                base_notional += qty * px[i] * _OPT_MULT
            scale = (cash * alloc) / base_notional if base_notional > 0 else 0.0
            if scale > 0:
                lot_legs = []
                for l in unscaled:
                    signed_qty = l["signed_qty"] * scale
                    lot_legs.append({"type": l["type"], "strike": l["strike"], "signed_qty": signed_qty})
                    trades.append({
                        "date": idx[i].strftime(_dfmt),
                        "action": "BUY" if signed_qty > 0 else "SELL",
                        "price": round(l["entry_val"], 2),
                        "leg": f"{l['type']} {l['strike']:g}",
                        "is_entry": True,
                    })
                expiry_at = idx[i] + pd.Timedelta(days=dte)
                entry_mtm = sum(l["signed_qty"] * bs_price(px[i], l["strike"], dte, r, iv, l["type"]) * _OPT_MULT for l in lot_legs)
                cash -= entry_mtm
                lots.append({
                    "legs": lot_legs, "entry_i": i, "expiry_at": expiry_at,
                    "entry_mtm": entry_mtm, "basis": abs(entry_mtm) or 1.0,
                    "orig_basis": abs(entry_mtm) or 1.0, "peak_pnl": 0.0,
                })

        cur = cash + sum(_lot_mtm(lot, i) for lot in lots)
        if cur <= 0:
            wiped_out, blown_up_at = True, idx[i]
            # One row per leg per open lot, using each leg's own mark value —
            # not a single summary row at the underlying's spot price, and not
            # comparable to a leg's entry premium anyway (same fix as the
            # single-option engine's wipeout).
            for lot in lots:
                for l in lot["legs"]:
                    trades.append({
                        "date": idx[i].strftime(_dfmt),
                        "action": "SELL" if l["signed_qty"] > 0 else "BUY",
                        "price": round(_leg_val(l, lot, i), 2),
                        "leg": f"{l['type']} {l['strike']:g}",
                        "is_entry": False,
                        "exit_kind": "wipeout",
                    })
                num_trades += 1   # each lot is a round trip that ended in wipeout — never a win
            cash, lots, cur = 0.0, [], 0.0
        equity[i] = cur
        in_position[i] = len(lots) > 0

    eq = pd.Series(equity, index=idx)
    daily = eq.pct_change()
    benchmark = (1 + close.pct_change().fillna(0)).cumprod() * initial_capital
    total_return = float(eq.iloc[-1] / initial_capital - 1) * 100
    ann_return = _safe_ann_return(float(eq.iloc[-1]), initial_capital, bars_per_year / max(1, n))
    roll_max = eq.cummax().replace(0, np.nan)
    drawdown = (eq - roll_max) / roll_max
    max_drawdown = float(drawdown.min(skipna=True) * 100) if drawdown.notna().any() else -100.0
    if blown_up_at is not None:
        max_drawdown = min(max_drawdown, -100.0)
    sharpe = float(daily.mean() / daily.std() * np.sqrt(bars_per_year)) if daily.std() > 0 else 0.0

    win_rate = float(wins / num_trades * 100) if num_trades else 0.0

    curve = [{"date": d.strftime(_dfmt), "strategy": round(float(sv), 2), "benchmark": round(float(bv), 2)}
             for d, sv, bv in zip(eq.index, eq.values, benchmark.values)]
    return {
        "equity_curve": curve,
        "metrics": {
            "total_return": round(total_return, 2), "ann_return": round(ann_return, 2),
            "max_drawdown": round(max_drawdown, 2), "sharpe": round(sharpe, 3),
            "num_trades": num_trades, "win_rate": round(win_rate, 1),
            "initial_capital": round(initial_capital, 2), "final_capital": round(float(eq.iloc[-1]), 2),
            "total_pnl": round(float(eq.iloc[-1]) - initial_capital, 2),
            "max_open_positions": max_open_positions,
            "position_limit_blocked_entries": position_limit_blocked_entries,
            "blown_up_at": blown_up_at.strftime(_dfmt) if blown_up_at is not None else None,
        },
        "trades": trades,
        "instrument": {"kind": "combo", "legs": legs_cfg, "dte": dte, "iv": round(iv, 1), "modeled": True},
        "in_position": in_position.tolist(),
    }


class ComboMonteCarloRequest(BaseModel):
    ticker: str
    # Multi-ticker basket: the SAME leg structure (moneyness-based, so strikes
    # derive from each ticker's own spot) applied across every ticker, equal-
    # weighted, independent GBM paths per name, summed into one portfolio P&L
    # distribution — for a universe strategy imported from the Algo Strategy
    # Builder (one shared combo across many symbols), not a single position.
    # None/empty = single-ticker mode using `ticker` above, unchanged.
    tickers: list[str] | None = None
    combo: dict                                   # {dte, legs:[{type,side,moneyness,qty}]}
    n_sims: int = 2000
    # Early-exit management, as % of the entry credit/debit magnitude (the
    # standard "close at 50% of max profit" convention) — None = no such exit.
    take_profit_pct: float | None = None
    stop_loss_pct: float | None = None
    max_hold_days: int | None = Field(None, ge=1)   # None = hold to DTE; 0/negative rejected, not silently ignored
    exit_pct: float = 100.0   # % of every open lot the rule-based exit closes when the signal drops; 100 = all of it
    delta_exit: float | None = None   # None = off; closes a lot once |net delta| reaches this
    gamma_exit: float | None = None   # None = off; closes a lot once |net gamma| reaches this
    # Sizing — same as portfolio_backtest: each admitted trade is sized at
    # position_size% × leverage of initial_capital (NOT split across the
    # ticker universe). Leg qty ratios from combo.legs stay fixed; absolute
    # scale = (position_size/100 × leverage × capital) / structure notional.
    initial_capital: float = 10_000
    position_size: float = 100        # % of portfolio for EVERY trade (backtester convention)
    leverage: float = 1               # multiplies trade size (trade_size = position_size × leverage)
    effective_annual_rate: float = 0  # EAR on notional borrowed beyond capital
    strategy: str | None = None
    strategy_params: dict | None = None
    horizon_days: int | None = None
    strategy_rules: dict | None = None
    # Underlying path generator (portfolio MC parity):
    #   gbm        — physical GBM, σ = max(ATM IV, HV)
    #   student_t  — same drift/vol, Student-t shocks (fat tails / crash days)
    #   bootstrap  — block-bootstrap of each name's historical log returns
    #   gbm_rn     — risk-neutral GBM with ATM IV only (classic options RN measure)
    path_model: str = "gbm"

    @model_validator(mode="after")
    def _validate_sizing(self):
        if self.leverage < 1:
            raise ValueError("Leverage must be at least 1x")
        if not 0 <= self.effective_annual_rate <= 100:
            raise ValueError("Effective annual rate must be between 0% and 100%")
        if not 0 < self.position_size <= 100:
            raise ValueError("Position size must be between 0% and 100% of capital")
        if not 0 < self.exit_pct <= 100:
            self.exit_pct = 100.0
        if self.tickers is not None and len(self.tickers) > 100:
            raise ValueError("Basket is limited to 100 tickers — each one needs its own live spot/IV fetch and simulation")
        allowed = {"gbm", "student_t", "bootstrap", "gbm_rn"}
        m = (self.path_model or "gbm").strip().lower()
        if m not in allowed:
            raise ValueError(f"path_model must be one of {sorted(allowed)}")
        self.path_model = m
        return self


_PATH_MODELS = frozenset({"gbm", "student_t", "bootstrap", "gbm_rn"})
_STUDENT_T_DF = 5
_BOOTSTRAP_BLOCK = 10


def _bs_vec(S: "np.ndarray", K: float, T: "np.ndarray", rf: float, sigma: float, otype: str) -> "np.ndarray":
    """Vectorized Black-Scholes over an (n_sims, n_days) price grid — math_engine's
    bs_core/bs_price are scalar-only (their T<=0 branch uses Python's max(), which
    can't handle an array truth value), so a small array-safe version lives here
    for the path simulation below.

    Uses erf (not scipy.stats.norm.cdf) so the hot path stays free of SciPy
    distribution overhead on multi-million-element grids.
    """
    from scipy.special import erf
    T_safe = np.maximum(T, 1e-8)
    sqrt_t = np.sqrt(T_safe)
    d1 = (np.log(S / K) + (rf + 0.5 * sigma ** 2) * T_safe) / (sigma * sqrt_t)
    d2 = d1 - sigma * sqrt_t
    # Φ(x) = 0.5 * (1 + erf(x / √2)) — erf is far cheaper than scipy.stats.norm.cdf
    inv_sqrt2 = 0.7071067811865476
    cdf = lambda x: 0.5 * (1.0 + erf(x * inv_sqrt2))
    if otype == "call":
        val = S * cdf(d1) - K * np.exp(-rf * T_safe) * cdf(d2)
        intrinsic = np.maximum(S - K, 0.0)
    else:
        val = K * np.exp(-rf * T_safe) * cdf(-d2) - S * cdf(-d1)
        intrinsic = np.maximum(K - S, 0.0)
    return np.where(T <= 1e-8, intrinsic, val)


def _bs_scalar(S: float, K: float, T: float, rf: float, sigma: float, otype: str) -> float:
    """Ultra-fast scalar Black-Scholes pricing using math.erf to bypass scipy.stats overhead in nested loops."""
    import math
    if T <= 1e-8:
        return max(S - K, 0.0) if otype == "call" else max(K - S, 0.0)
    d1 = (math.log(S / K) + (rf + 0.5 * sigma ** 2) * T) / (sigma * math.sqrt(T))
    d2 = d1 - sigma * math.sqrt(T)
    
    # normal cdf = 0.5 * (1 + erf(x / sqrt(2)))
    # sqrt(2) is approx 1.4142135623730951
    cdf_d1 = 0.5 * (1.0 + math.erf(d1 / 1.4142135623730951))
    cdf_d2 = 0.5 * (1.0 + math.erf(d2 / 1.4142135623730951))
    
    if otype == "call":
        return S * cdf_d1 - K * math.exp(-rf * T) * cdf_d2
    else:
        cdf_neg_d1 = 0.5 * (1.0 + math.erf(-d1 / 1.4142135623730951))
        cdf_neg_d2 = 0.5 * (1.0 + math.erf(-d2 / 1.4142135623730951))
        return K * math.exp(-rf * T) * cdf_neg_d2 - S * cdf_neg_d1


def _bs_greeks_scalar(S: float, K: float, T: float, rf: float, sigma: float, otype: str) -> tuple[float, float]:
    """(delta, gamma) for one option, same fast erf-based math as _bs_scalar (T in years,
    rf/sigma already decimals). At/after expiry the option's shape has already resolved to
    its intrinsic-value kink — delta is binary (1/0/-1 by moneyness) and gamma is 0."""
    import math
    if T <= 1e-8:
        itm = S > K if otype == "call" else S < K
        delta = (1.0 if otype == "call" else -1.0) if itm else 0.0
        return delta, 0.0
    d1 = (math.log(S / K) + (rf + 0.5 * sigma ** 2) * T) / (sigma * math.sqrt(T))
    cdf_d1 = 0.5 * (1.0 + math.erf(d1 / 1.4142135623730951))
    delta = cdf_d1 if otype == "call" else cdf_d1 - 1.0
    gamma = math.exp(-0.5 * d1 * d1) / math.sqrt(2 * math.pi) / (S * sigma * math.sqrt(T))
    return delta, gamma


@router.post("/combo-montecarlo")
def combo_monte_carlo(req: ComboMonteCarloRequest):
    """Synchronous combo MC (kept for scripts/tests). Prefer /start + /jobs for the UI."""
    if not _COMBO_MC_SEM.acquire(timeout=_COMBO_MC_TIMEOUT):
        raise HTTPException(
            503,
            f"Too many simulations running (max {_COMBO_MC_CONCURRENCY} concurrent on this worker; "
            f"waited {_COMBO_MC_TIMEOUT:.0f}s). Another heavy run is still in progress — retry in a moment, "
            f"or lower Simulations / Horizon / ticker count.",
        )
    try:
        return _combo_monte_carlo_impl(req)
    finally:
        _COMBO_MC_SEM.release()


# ── Async job store (survives browser tab freezes) ────────────────────────────
# The SPA used to hold a multi-minute POST open. Chrome freezes background tabs
# and aborts long XHRs / client timers — the sim appeared to "stop" on tab
# switch even though the user only looked away. Jobs run in a daemon thread;
# the client polls a short status endpoint and resumes immediately on focus.
import time as _time
import uuid as _uuid
import logging as _logging

_MC_JOBS: dict[str, dict] = {}
_MC_JOBS_LOCK = threading.Lock()
_MC_JOB_TTL_SEC = float(os.getenv("COMBO_MC_JOB_TTL_SEC", "3600"))  # 1h
_log_mc = _logging.getLogger(__name__)
# Thread-local so deep MC helpers can report progress without threading job_id
# through every signature.
_MC_PROGRESS_TLS = threading.local()


def _mc_jobs_gc() -> None:
    cutoff = _time.time() - _MC_JOB_TTL_SEC
    with _MC_JOBS_LOCK:
        dead = [jid for jid, j in _MC_JOBS.items()
                if (j.get("finished_at") or j.get("created_at") or 0) < cutoff
                and j.get("status") in ("done", "error")]
        for jid in dead:
            _MC_JOBS.pop(jid, None)


def _set_mc_progress(pct: float, message: str) -> None:
    """Update live progress for the job running on this thread (if any)."""
    job_id = getattr(_MC_PROGRESS_TLS, "job_id", None)
    if not job_id:
        return
    with _MC_JOBS_LOCK:
        job = _MC_JOBS.get(job_id)
        if not job or job.get("status") not in ("queued", "running"):
            return
        job["progress"] = round(float(min(99.5, max(0.0, pct))), 1)
        job["progress_message"] = str(message)[:200]
        job["status"] = "running"
        if not job.get("started_at"):
            job["started_at"] = _time.time()


def _run_mc_job(job_id: str, req: ComboMonteCarloRequest) -> None:
    _MC_PROGRESS_TLS.job_id = job_id
    _set_mc_progress(1, "Waiting for a simulation slot…")
    acquired = _COMBO_MC_SEM.acquire(timeout=_COMBO_MC_TIMEOUT)
    if not acquired:
        with _MC_JOBS_LOCK:
            _MC_JOBS[job_id] = {
                "job_id": job_id,
                "status": "error",
                "detail": (
                    f"Too many simulations running (max {_COMBO_MC_CONCURRENCY} concurrent; "
                    f"waited {_COMBO_MC_TIMEOUT:.0f}s). Retry in a moment."
                ),
                "created_at": _MC_JOBS.get(job_id, {}).get("created_at"),
                "started_at": None,
                "finished_at": _time.time(),
                "progress": 0,
                "progress_message": "Failed — slot busy",
            }
        _MC_PROGRESS_TLS.job_id = None
        return
    with _MC_JOBS_LOCK:
        prev = _MC_JOBS.get(job_id, {})
        _MC_JOBS[job_id] = {
            **prev,
            "job_id": job_id,
            "status": "running",
            "started_at": _time.time(),
            "progress": 3,
            "progress_message": "Slot acquired — starting…",
        }
    try:
        _set_mc_progress(5, "Starting simulation…")
        result = _combo_monte_carlo_impl(req)
        with _MC_JOBS_LOCK:
            _MC_JOBS[job_id] = {
                "job_id": job_id,
                "status": "done",
                "result": result,
                "created_at": prev.get("created_at"),
                "started_at": _MC_JOBS.get(job_id, {}).get("started_at"),
                "finished_at": _time.time(),
                "progress": 100,
                "progress_message": "Complete",
            }
    except HTTPException as e:
        with _MC_JOBS_LOCK:
            _MC_JOBS[job_id] = {
                "job_id": job_id,
                "status": "error",
                "detail": e.detail if isinstance(e.detail, str) else str(e.detail),
                "created_at": prev.get("created_at"),
                "started_at": _MC_JOBS.get(job_id, {}).get("started_at"),
                "finished_at": _time.time(),
                "progress": 0,
                "progress_message": "Failed",
            }
    except Exception as e:
        _log_mc.exception("combo MC job %s failed", job_id)
        with _MC_JOBS_LOCK:
            _MC_JOBS[job_id] = {
                "job_id": job_id,
                "status": "error",
                "detail": str(e) or "Simulation failed",
                "created_at": prev.get("created_at"),
                "started_at": _MC_JOBS.get(job_id, {}).get("started_at"),
                "finished_at": _time.time(),
                "progress": 0,
                "progress_message": "Failed",
            }
    finally:
        _COMBO_MC_SEM.release()
        _MC_PROGRESS_TLS.job_id = None


@router.post("/combo-montecarlo/start")
def combo_monte_carlo_start(req: ComboMonteCarloRequest):
    """Enqueue combo MC on a background thread; poll /jobs/{id} for the result.

    Returns immediately so the browser never holds a multi-minute POST that
    Chrome aborts when the tab is backgrounded.
    """
    _mc_jobs_gc()
    job_id = str(_uuid.uuid4())
    now = _time.time()
    with _MC_JOBS_LOCK:
        _MC_JOBS[job_id] = {
            "job_id": job_id,
            "status": "queued",
            "created_at": now,
            "started_at": None,
            "finished_at": None,
            "progress": 0,
            "progress_message": "Queued…",
        }
    t = threading.Thread(target=_run_mc_job, args=(job_id, req), daemon=True, name=f"combo-mc-{job_id[:8]}")
    t.start()
    return {
        "job_id": job_id,
        "status": "queued",
        "created_at": now,
        "progress": 0,
        "progress_message": "Queued…",
    }


@router.get("/combo-montecarlo/jobs/{job_id}")
def combo_monte_carlo_job(job_id: str):
    """Status / result / live progress for an async combo MC job."""
    with _MC_JOBS_LOCK:
        job = _MC_JOBS.get(job_id)
    if not job:
        raise HTTPException(404, f"Unknown or expired Monte Carlo job: {job_id}")
    out = {
        "job_id": job["job_id"],
        "status": job["status"],
        "created_at": job.get("created_at"),
        "started_at": job.get("started_at"),
        "finished_at": job.get("finished_at"),
        "progress": job.get("progress", 0 if job["status"] != "done" else 100),
        "progress_message": job.get("progress_message") or "",
    }
    if job["status"] == "done":
        out["result"] = job.get("result")
        out["progress"] = 100
        out["progress_message"] = "Complete"
    if job["status"] == "error":
        out["detail"] = job.get("detail") or "Simulation failed"
    return out


def _mc_spot_iv(ticker: str) -> tuple[float, float]:
    """Spot + ATM IV (%) for Monte Carlo.

    Prefer the full options snapshot (cached 10m). If the live option-chain
    walk is cold/slow/hanging, fall back to 21d historical vol from price
    history so a single yfinance stall cannot pin a combo-MC concurrency slot.
    """
    import concurrent.futures
    from routers.options import options_snapshot

    try:
        with concurrent.futures.ThreadPoolExecutor(max_workers=1) as pool:
            fut = pool.submit(options_snapshot, ticker)
            snap = fut.result(timeout=_MC_SNAP_TIMEOUT)
        spot, iv = snap.get("spot"), snap.get("atm_iv")
        if spot and isinstance(iv, (int, float)) and iv > 0:
            return float(spot), float(iv)
        # Snapshot returned but IV missing — still use its spot if present.
        if spot:
            hist = get_history(ticker, period="1y")
            closes = hist["Close"].dropna() if hist is not None and not hist.empty else None
            if closes is not None and len(closes) >= 6:
                log_ret = np.log(closes / closes.shift(1)).dropna()
                hv = float(log_ret.tail(min(21, len(log_ret))).std() * np.sqrt(252) * 100)
                if np.isfinite(hv) and hv > 0:
                    return float(spot), hv
    except Exception:
        pass

    hist = get_history(ticker, period="1y")
    if hist is None or hist.empty:
        raise HTTPException(422, f"No live spot/IV available for {ticker}")
    closes = hist["Close"].dropna()
    if closes.empty:
        raise HTTPException(422, f"No live spot/IV available for {ticker}")
    spot = float(closes.iloc[-1])
    log_ret = np.log(closes / closes.shift(1)).dropna()
    if len(log_ret) < 5:
        raise HTTPException(422, f"No live spot/IV available for {ticker}")
    hv = float(log_ret.tail(min(21, len(log_ret))).std() * np.sqrt(252) * 100)
    if not np.isfinite(hv) or hv <= 0:
        hv = 30.0
    return spot, hv


def _price_ticker_leg(ticker: str, legs_cfg: list, dte: int, r: float, committed_dollars: float,
                      n: int, dt: float, rng, path_model: str = "gbm",
                      hist_values: np.ndarray | None = None) -> dict:
    """Fetch one ticker's own live spot/IV and simulate its dollar
    contribution to the combo — legs are moneyness-based, so strikes derive
    from THIS ticker's own spot. `committed_dollars` is the full per-trade
    notional (position_size% × leverage × capital), same as one backtest trade
    — not a 1/N slice of the book.
    """
    from math_engine import bs_price
    spot, iv = _mc_spot_iv(ticker)

    base_notional = sum(max(0.0, float(lc.get("qty", 1.0))) * spot * _OPT_MULT for lc in legs_cfg)
    scale = committed_dollars / base_notional if base_notional > 0 else 0.0

    resolved: list[dict] = []
    entry_cash_flow = 0.0
    for lc in legs_cfg:
        strike = round(spot * float(lc.get("moneyness", 1.0)), 2)
        otype = "put" if str(lc.get("type", "call")).lower().startswith("p") else "call"
        qty = max(0.0, float(lc.get("qty", 1.0))) * scale
        signed_qty = qty if str(lc.get("side", "buy")).lower() == "buy" else -qty
        entry_val = max(float(bs_price(spot, strike, dte, r, iv, otype)), 0.01)
        entry_cash_flow += -signed_qty * entry_val * _OPT_MULT
        resolved.append({"type": otype, "strike": strike, "signed_qty": signed_qty})

    sigma = iv / 100.0
    rf = r / 100.0
    seed = int(rng.integers(0, 2**31 - 1)) if hasattr(rng, "integers") else 0
    hist = hist_values if hist_values is not None else _synthetic_hist(spot, max(_STRATEGY_HIST_MIN_BARS, 120), seed=seed)
    # Hold-to-DTE default stays risk-neutral-ish unless model says otherwise
    model = path_model if path_model != "gbm" else "gbm_rn"
    price_paths = _generate_price_paths(spot, hist, n, dte, dt, seed, iv, path_model=model)
    days = np.arange(dte + 1)
    t_rem = (dte - days) / 365.0   # (dte+1,) remaining years per column, broadcasts over price_paths
    mtm = np.zeros((n, dte + 1))
    for leg in resolved:
        leg_val = _bs_vec(price_paths, leg["strike"], t_rem, rf, sigma, leg["type"])
        mtm += leg["signed_qty"] * leg_val * _OPT_MULT
    pnl_path = entry_cash_flow + mtm   # (n, dte+1) unrealized $ P&L at each day, each path

    return {"spot": spot, "iv": iv, "resolved": resolved, "entry_cash_flow": entry_cash_flow, "pnl_path": pnl_path}


def _payoff_breakevens(resolved: list, spot: float, entry_cash_flow: float,
                       financing_share: float, capital_floor: float):
    """Deterministic 50%-150%-of-spot payoff curve + breakevens + max profit/
    loss at expiry for one underlying's resolved legs — the "if held to
    expiry" reference. Used for the single-ticker combo curve and, per-ticker,
    for a basket's breakeven summary (each ticker priced independently off
    its own spot/legs/entry cash flow, sharing an equal split of the basket's
    total financing cost — see _combo_monte_carlo_impl's dollars_per_trade)."""
    def payoff(price: float) -> float:
        val = sum(
            l["signed_qty"] * (max(price - l["strike"], 0.0) if l["type"] == "call" else max(l["strike"] - price, 0.0)) * _OPT_MULT
            for l in resolved
        )
        return max(entry_cash_flow + val - financing_share, -capital_floor)

    lo, hi = spot * 0.5, spot * 1.5
    curve = [{"price": round(lo + (hi - lo) * i / 100, 2)} for i in range(101)]
    for pt in curve:
        pt["pnl"] = round(payoff(pt["price"]), 2)

    breakevens = []
    for a, b in zip(curve, curve[1:]):
        if (a["pnl"] <= 0 < b["pnl"]) or (a["pnl"] >= 0 > b["pnl"]):
            lo_p, hi_p = a["price"], b["price"]
            for _ in range(40):
                mid = (lo_p + hi_p) / 2
                if (payoff(lo_p) <= 0) == (payoff(mid) <= 0):
                    lo_p = mid
                else:
                    hi_p = mid
            breakevens.append(round((lo_p + hi_p) / 2, 2))

    # Only the upside (price -> infinity) can be truly unbounded at expiry —
    # the downside is always floored at price=0. (An early stop-loss further
    # bounds both sides in the simulated distribution.)
    slope_up = sum(l["signed_qty"] * _OPT_MULT for l in resolved if l["type"] == "call")
    floor_pnl = payoff(0.0)
    sampled_pnls = [pt["pnl"] for pt in curve] + [floor_pnl]
    max_profit = None if slope_up > 1e-6 else round(max(sampled_pnls), 2)
    max_loss = None if slope_up < -1e-6 else round(min(sampled_pnls), 2)
    return curve, breakevens, max_profit, max_loss


def _synthetic_hist(spot: float, n: int = _STRATEGY_HIST_MIN_BARS, seed: int = 0) -> np.ndarray:
    """Fallback price path long enough to warm OPT_IVRANK(252) / PCT_CHANGE(30)."""
    rng = np.random.default_rng(seed)
    shocks = rng.normal(0.0002, 0.015, max(n, _STRATEGY_HIST_MIN_BARS))
    return float(spot) * np.cumprod(1.0 + shocks)


def _normalize_mc_strategy_rules(rules: dict | None) -> dict | None:
    """Normalize Algo Builder rule JSON for single-ticker MC evaluation.

    - Prefer `groups` form (what CustomStrategyModal saves); lift flat `conditions`.
    - Strip per-condition `ticker` so indicators bind to the simulated name's series
      (cross-ticker frames are not available inside one-ticker path sims).
    - Coerce period / rhs_num to numbers (JSON sometimes stores strings).
    """
    if not rules or not isinstance(rules, dict):
        return None
    import copy
    rules = copy.deepcopy(rules)

    def _fix_ref(ref: dict | None) -> dict | None:
        if not isinstance(ref, dict):
            return ref
        out = dict(ref)
        out.pop("ticker", None)  # force primary series
        for key in ("period", "fast", "slow", "signal_period"):
            if key in out and out[key] is not None and out[key] != "":
                try:
                    out[key] = int(float(out[key]))
                except (TypeError, ValueError):
                    pass
        if "std" in out and out["std"] is not None and out["std"] != "":
            try:
                out["std"] = float(out["std"])
            except (TypeError, ValueError):
                pass
        return out

    def _fix_block(block) -> dict:
        if not isinstance(block, dict):
            return {"logic": "AND", "groups": [{"logic": "AND", "conditions": []}]}
        groups = block.get("groups")
        if not groups:
            flat = block.get("conditions") or []
            groups = [{"logic": block.get("logic", "AND"), "conditions": list(flat)}]
        fixed = []
        for g in groups:
            if not isinstance(g, dict):
                continue
            conds = []
            for c in (g.get("conditions") or []):
                if not isinstance(c, dict):
                    continue
                cc = dict(c)
                if "lhs" in cc:
                    cc["lhs"] = _fix_ref(cc.get("lhs"))
                if "rhs_ind" in cc:
                    cc["rhs_ind"] = _fix_ref(cc.get("rhs_ind"))
                if cc.get("rhs_num") is not None and cc.get("rhs_num") != "":
                    try:
                        cc["rhs_num"] = float(cc["rhs_num"])
                    except (TypeError, ValueError):
                        pass
                conds.append(cc)
            fixed.append({"logic": g.get("logic", "AND"), "conditions": conds})
        return {"logic": block.get("logic", "AND"), "groups": fixed}

    return {"buy": _fix_block(rules.get("buy")), "sell": _fix_block(rules.get("sell"))}


def _path_vol_and_drift(hist_values: np.ndarray, atm_iv: float) -> tuple[float, float]:
    """Physical path dynamics for signal-driving GBM.

    Risk-neutral ATM IV alone understates crash frequency for rare entry rules
    (IV Rank > 80 ∧ large % drops). Use max(ATM IV, trailing realized vol) so
    the path distribution can actually realize the stress regimes those rules
    target. Option mark-to-market still prices with ATM IV separately.
    """
    from strategies.indicators import realized_vol
    iv = float(atm_iv) if np.isfinite(atm_iv) and atm_iv > 0 else 25.0
    hv = iv
    try:
        rv = realized_vol(np.asarray(hist_values, dtype=float), 21)
        finite = rv[np.isfinite(rv)]
        if finite.size:
            hv = float(finite[-1])
    except Exception:
        pass
    if not np.isfinite(hv) or hv <= 0:
        hv = iv
    # Floor keeps ultra-low-vol names from never stressing entry rules
    sigma_pct = max(iv, hv, 20.0)
    # Physical drift from hist log-returns (clipped)
    mu = 0.0
    try:
        p = np.asarray(hist_values, dtype=float)
        p = p[np.isfinite(p) & (p > 0)]
        if p.size > 30:
            lr = np.diff(np.log(p))
            mu = float(np.mean(lr) * 252.0)
    except Exception:
        mu = 0.0
    if not np.isfinite(mu):
        mu = 0.0
    mu = float(np.clip(mu, -0.4, 0.4))
    return sigma_pct / 100.0, mu


def _prefetch_strategy_market(tickers: list[str]) -> tuple[dict, dict]:
    """I/O phase for strategy MC: parallel spot/IV + history for every ticker.

    Returns (market, dropped) where market[tk] = {spot, iv, hist_values: np.ndarray}.
    Fetching happens once up-front so process-pool workers never touch the network
    (picklable payloads only) and a hung chain cannot pin a sim worker mid-loop.

    History lookback is long enough for OPT_IVRANK(252) warmup (~272 trading bars).
    """
    import concurrent.futures
    import datetime

    today = datetime.date.today()
    start_dt = today - datetime.timedelta(days=_STRATEGY_HIST_LOOKBACK_DAYS)
    market: dict = {}
    dropped: dict = {}

    def _one(tk: str):
        spot, iv = _mc_spot_iv(tk)
        try:
            hist = _fetch_close(tk, start_dt.isoformat(), today.isoformat())
            vals = hist.to_numpy(dtype=float)
            if vals.size < _STRATEGY_HIST_MIN_BARS:
                # Pad the left with synthetic bars so IV-rank warmup is covered
                # without inventing a full fake series when we have some real data.
                pad_n = _STRATEGY_HIST_MIN_BARS - int(vals.size)
                if vals.size >= 5:
                    seed_px = float(vals[0])
                    pad = _synthetic_hist(seed_px, pad_n + 1, seed=hash(tk) & 0xFFFFFFFF)[:-1]
                    # scale pad end to meet real series start
                    if pad[-1] > 0:
                        pad = pad * (seed_px / pad[-1])
                    vals = np.concatenate([pad, vals])
                else:
                    vals = _synthetic_hist(spot, _STRATEGY_HIST_MIN_BARS, seed=hash(tk) & 0xFFFFFFFF)
        except Exception:
            vals = _synthetic_hist(spot, _STRATEGY_HIST_MIN_BARS, seed=hash(tk) & 0xFFFFFFFF)
        return tk, float(spot), float(iv), vals

    workers = min(_BASKET_FETCH_WORKERS, max(1, len(tickers)))
    with concurrent.futures.ThreadPoolExecutor(max_workers=workers) as pool:
        futs = {pool.submit(_one, tk): tk for tk in tickers}
        for fut in concurrent.futures.as_completed(futs):
            tk = futs[fut]
            try:
                _tk, spot, iv, vals = fut.result()
                market[_tk] = {"spot": spot, "iv": iv, "hist_values": vals}
            except HTTPException as e:
                dropped[tk] = str(e.detail)
            except Exception as e:
                dropped[tk] = str(e)
    return market, dropped


def _mc_path_pack_key(
    ticker: str, n: int, horizon_days: int, seed: int,
    spot: float, iv: float, hist_values: np.ndarray,
    strategy: str | None, strategy_params: dict | None, strategy_rules: dict | None,
    path_model: str = "gbm",
) -> str:
    """Stable key for path+signal packs (excludes sizing / risk / EAR)."""
    rules_n = _normalize_mc_strategy_rules(strategy_rules) if strategy_rules else None
    hist = np.asarray(hist_values, dtype=float)
    # Compact hist fingerprint (not full series) — enough to invalidate on refresh
    h_fp = {
        "len": int(hist.size),
        "first": round(float(hist[0]), 4) if hist.size else 0.0,
        "last": round(float(hist[-1]), 4) if hist.size else 0.0,
        "mid": round(float(hist[hist.size // 2]), 4) if hist.size else 0.0,
    }
    blob = {
        "tk": ticker.upper(),
        "n": int(n),
        "h": int(horizon_days),
        "seed": int(seed),
        "spot": round(float(spot), 4),
        "iv": round(float(iv), 3),
        "hist": h_fp,
        "strategy": strategy,
        "strategy_params": strategy_params or {},
        "strategy_rules": rules_n,
        "path_model": (path_model or "gbm").lower(),
    }
    raw = json.dumps(blob, sort_keys=True, default=str, separators=(",", ":"))
    return hashlib.sha256(raw.encode()).hexdigest()


def _student_t_shocks(rng: np.random.Generator, shape: tuple, df: int = _STUDENT_T_DF) -> np.ndarray:
    """Unit-variance Student-t shocks (fatter tails than N(0,1))."""
    z = rng.standard_normal(shape)
    chi2 = rng.chisquare(df, size=shape)
    t = z / np.sqrt(chi2 / df)
    return t * np.sqrt((df - 2) / df)


def _generate_price_paths(
    spot: float, hist_values: np.ndarray, n: int, horizon_days: int, dt: float,
    seed: int, iv: float, path_model: str = "gbm",
    shared_shocks: np.ndarray | None = None,
) -> np.ndarray:
    """(n, horizon+1) price paths under the chosen model.

    shared_shocks: optional pre-built unit-variance shocks (n, horizon) for
    correlated multi-name generation (caller applies Cholesky).
    """
    hist_values = np.asarray(hist_values, dtype=float)
    rng = np.random.default_rng(int(seed))
    model = (path_model or "gbm").lower()
    if model not in _PATH_MODELS:
        model = "gbm"

    # ── Block bootstrap of historical log returns ──────────────────────────
    if model == "bootstrap":
        pos = hist_values[np.isfinite(hist_values) & (hist_values > 0)]
        if pos.size >= 25:
            log_r = np.diff(np.log(pos))
            log_r = log_r[np.isfinite(log_r)]
        else:
            log_r = np.array([])
        if log_r.size < 20:
            model = "gbm"  # fall through
        else:
            block = min(_BOOTSTRAP_BLOCK, max(2, log_r.size // 3))
            max_start = max(0, log_r.size - block)
            paths = np.empty((n, horizon_days + 1), dtype=float)
            paths[:, 0] = spot
            for s in range(n):
                v = float(spot)
                t = 0
                while t < horizon_days:
                    start = int(rng.integers(0, max_start + 1))
                    for b in range(block):
                        if t >= horizon_days:
                            break
                        v = v * float(np.exp(log_r[start + b]))
                        if not np.isfinite(v) or v <= 0:
                            v = max(float(spot) * 1e-4, 1e-6)
                        paths[s, t + 1] = v
                        t += 1
            return paths

    # ── Diffusion (GBM / Student-t / risk-neutral GBM) ─────────────────────
    sigma_iv = float(iv) / 100.0 if np.isfinite(iv) and iv > 0 else 0.25
    if model == "gbm_rn":
        mu_path, sigma_path = 0.04, sigma_iv  # rf-ish drift, ATM IV vol
        # use actual rf from caller would be nicer; 4% matches combo MC default r
        mu_path = 0.04
    else:
        sigma_path, mu_path = _path_vol_and_drift(hist_values, float(iv) if iv else 25.0)

    if shared_shocks is not None:
        z = np.asarray(shared_shocks, dtype=float)
        if z.shape != (n, horizon_days):
            raise ValueError(f"shared_shocks shape {z.shape} != {(n, horizon_days)}")
    elif model == "student_t":
        z = _student_t_shocks(rng, (n, horizon_days))
    else:
        z = rng.standard_normal((n, horizon_days))

    shocks = (mu_path - 0.5 * sigma_path ** 2) * dt + sigma_path * np.sqrt(dt) * z
    return np.hstack([np.full((n, 1), spot), spot * np.exp(np.cumsum(shocks, axis=1))])


def _signal_grid_for_paths(
    price_paths: np.ndarray, hist_values: np.ndarray,
    strategy: str | None, strategy_params: dict | None, strategy_rules: dict | None,
    ticker: str = "?",
) -> np.ndarray:
    """Per-path entry signal on days 0..H from hist + forward prices."""
    n, cols = price_paths.shape
    horizon_days = cols - 1
    hist_values = np.asarray(hist_values, dtype=float)
    hist_len = int(hist_values.shape[0])
    signal_grid = np.zeros((n, horizon_days + 1), dtype=np.float32)
    rules_n = _normalize_mc_strategy_rules(strategy_rules) if strategy_rules is not None else None

    for i in range(n):
        sim_prices = price_paths[i]
        combined_values = np.concatenate([hist_values, sim_prices[1:]])
        try:
            if rules_n is not None or strategy_rules is not None:
                from routers.strategy import evaluate_custom_rules
                sig_arr = np.asarray(
                    evaluate_custom_rules(combined_values, rules_n or strategy_rules),
                    dtype=float,
                )
            elif strategy is not None:
                combined_series = pd.Series(combined_values)
                signals = _compute_signal(combined_series, strategy, strategy_params)
                sig_arr = signals.to_numpy(dtype=float)
            else:
                sig_arr = np.zeros(len(combined_values), dtype=float)
            if sig_arr.shape[0] != len(combined_values):
                sig_arr = np.resize(sig_arr, len(combined_values))
            sig_arr = np.where(np.isfinite(sig_arr), sig_arr, 0.0)
        except Exception as e:
            import logging
            logging.warning("Signal eval failed for %s: %s", ticker, e)
            sig_arr = np.zeros(len(combined_values), dtype=float)

        for d in range(0, horizon_days + 1):
            idx = hist_len - 1 if d <= 0 else hist_len + d - 1
            if 0 <= idx < len(sig_arr):
                signal_grid[i, d] = float(sig_arr[idx])
            elif len(sig_arr):
                signal_grid[i, d] = float(sig_arr[-1])
    return signal_grid


def _build_path_signal_pack(
    ticker: str, n: int, horizon_days: int, dt: float, seed,
    spot: float, iv: float, hist_values: np.ndarray,
    strategy: str | None, strategy_params: dict | None, strategy_rules: dict | None,
    path_model: str = "gbm",
    shared_shocks: np.ndarray | None = None,
) -> dict:
    """Expensive stage: price paths + per-path entry signals (cacheable)."""
    hist_values = np.asarray(hist_values, dtype=float)
    hist_len = int(hist_values.shape[0])
    sigma = float(iv) / 100.0 if np.isfinite(iv) and iv > 0 else 0.25
    price_paths = _generate_price_paths(
        spot, hist_values, n, horizon_days, dt, int(seed), float(iv) if iv else 25.0,
        path_model=path_model, shared_shocks=shared_shocks,
    )
    signal_grid = _signal_grid_for_paths(
        price_paths, hist_values, strategy, strategy_params, strategy_rules, ticker=ticker,
    )
    return {
        "spot": float(spot),
        "iv": float(iv),
        "sigma": float(sigma),
        "price_paths": price_paths,
        "signal_grid": signal_grid,
        "hist_len": hist_len,
        "path_model": (path_model or "gbm").lower(),
    }


def _get_path_signal_pack(
    ticker: str, n: int, horizon_days: int, dt: float, seed: int,
    spot: float, iv: float, hist_values: np.ndarray,
    strategy: str | None, strategy_params: dict | None, strategy_rules: dict | None,
    path_model: str = "gbm",
    shared_shocks: np.ndarray | None = None,
) -> tuple[dict, bool]:
    """Return (pack, cache_hit). shared_shocks bypasses cache (joint generation)."""
    if shared_shocks is not None:
        pack = _build_path_signal_pack(
            ticker, n, horizon_days, dt, int(seed), spot, iv, hist_values,
            strategy, strategy_params, strategy_rules, path_model=path_model,
            shared_shocks=shared_shocks,
        )
        return pack, False

    key = _mc_path_pack_key(
        ticker, n, horizon_days, int(seed), spot, iv, hist_values,
        strategy, strategy_params, strategy_rules, path_model=path_model,
    )
    with _MC_PATH_CACHE_LOCK:
        hit = _MC_PATH_CACHE.get(key)
        if hit is not None:
            _MC_PATH_CACHE_STATS["hits"] += 1
            return hit, True
        _MC_PATH_CACHE_STATS["misses"] += 1
    pack = _build_path_signal_pack(
        ticker, n, horizon_days, dt, int(seed), spot, iv, hist_values,
        strategy, strategy_params, strategy_rules, path_model=path_model,
    )
    with _MC_PATH_CACHE_LOCK:
        _MC_PATH_CACHE[key] = pack
    return pack, False


def _corr_cholesky_from_hists(hists: list[np.ndarray]) -> np.ndarray | None:
    """Cholesky of return-correlation across tickers (for joint GBM / Student-t)."""
    k = len(hists)
    if k < 2:
        return None
    # Align on min length trailing segment
    lens = [int(np.asarray(h).size) for h in hists]
    m = min(lens)
    if m < 30:
        return None
    rets = []
    for h in hists:
        p = np.asarray(h, dtype=float)[-m:]
        p = p[np.isfinite(p) & (p > 0)]
        if p.size < 30:
            return None
        lr = np.diff(np.log(p))
        rets.append(lr)
    # re-trim to common length after log
    m2 = min(len(r) for r in rets)
    if m2 < 25:
        return None
    R = np.zeros((k, k))
    mats = [r[-m2:] for r in rets]
    for i in range(k):
        for j in range(i, k):
            a, b = mats[i], mats[j]
            if np.std(a) < 1e-12 or np.std(b) < 1e-12:
                c = 1.0 if i == j else 0.0
            else:
                c = float(np.corrcoef(a, b)[0, 1])
                if not np.isfinite(c):
                    c = 0.0
                c = float(np.clip(c, -0.99, 0.99))
            R[i, j] = R[j, i] = (1.0 if i == j else c)
    # jitter for PD
    R = R + np.eye(k) * 1e-6
    try:
        return np.linalg.cholesky(R)
    except np.linalg.LinAlgError:
        return None


def _apply_trades_on_pack(
    pack: dict, legs_cfg: list, dte: int, r: float, committed_dollars: float,
    take_profit_pct: float | None, stop_loss_pct: float | None, max_hold_days: int | None,
    exit_pct: float = 100.0,
    delta_exit: float | None = None, gamma_exit: float | None = None,
) -> dict:
    """Cheap stage: size + risk-manage trades on a cached path/signal pack.

    Multi-lot: a buy signal firing while a position is already open opens
    ANOTHER lot (each sized at the same committed_dollars notional as a
    single trade — this engine doesn't track a cash balance the way the
    backtester does, so there's no "% of available cash" to shrink; every
    lot commits the same fixed notional) instead of being ignored — same
    "can hold more than one trade on a ticker at a time" semantics as the
    backtester's option/combo engines. Each lot is independent (its own
    strikes fixed at entry, its own DTE clock, its own stop/take-profit/
    max-hold tracking) since options aren't fungible across entries the way
    shares are. The rule-based exit (the signal dropping to 0) closes
    `exit_pct` of every open lot at once (100 = all of it, the same
    full-close behavior as before; less than 100 trims each lot in place —
    same mechanism as the backtester's engines). A lot's own risk trigger
    or expiry always closes that lot in full, regardless of exit_pct.
    """
    spot = float(pack["spot"])
    iv = float(pack["iv"])
    sigma = float(pack["sigma"])
    rf = r / 100.0
    exit_frac_cfg = max(0.0, min(1.0, exit_pct / 100.0))
    price_paths = pack["price_paths"]
    signal_grid = pack["signal_grid"]
    n, cols = price_paths.shape
    horizon_days = cols - 1

    pnl_path = np.zeros((n, horizon_days + 1))
    trades_total = np.zeros(n)
    trades_win = np.zeros(n)
    open_notional_path = np.zeros((n, horizon_days + 1))

    def _open_position(entry_spot: float):
        base_notional = sum(
            max(0.0, float(lc.get("qty", 1.0))) * entry_spot * _OPT_MULT for lc in legs_cfg
        )
        scale = committed_dollars / base_notional if base_notional > 0 else 0.0
        resolved = []
        cash = 0.0
        for lc in legs_cfg:
            strike = round(entry_spot * float(lc.get("moneyness", 1.0)), 2)
            otype = "put" if str(lc.get("type", "call")).lower().startswith("p") else "call"
            qty = max(0.0, float(lc.get("qty", 1.0))) * scale
            signed_qty = qty if str(lc.get("side", "buy")).lower() == "buy" else -qty
            entry_val = max(_bs_scalar(entry_spot, strike, dte / 365.0, rf, sigma, otype), 0.01)
            cash += -signed_qty * entry_val * _OPT_MULT
            resolved.append({"type": otype, "strike": strike, "signed_qty": signed_qty})
        return resolved, cash

    def _mtm(resolved, entry_cash: float, spot_now: float, t_rem: float) -> float:
        opt_val = 0.0
        for leg in resolved:
            if t_rem <= 0:
                if leg["type"] == "call":
                    v = max(spot_now - leg["strike"], 0.0)
                else:
                    v = max(leg["strike"] - spot_now, 0.0)
            else:
                v = _bs_scalar(spot_now, leg["strike"], t_rem / 365.0, rf, sigma, leg["type"])
            opt_val += leg["signed_qty"] * v * _OPT_MULT
        return entry_cash + opt_val

    def _lot_greeks(resolved, spot_now: float, t_rem: float) -> tuple[float, float]:
        """Qty-weighted net delta/gamma across every leg — same convention as
        the backtester's combo engine — divided by total |qty| so a single
        leg's own (or a structure's net) exposure both read on the same
        ~0-1-ish per-contract scale."""
        net_delta = net_gamma = 0.0
        total_qty = 0.0
        for leg in resolved:
            d, g = _bs_greeks_scalar(spot_now, leg["strike"], max(t_rem, 1e-6) / 365.0, rf, sigma, leg["type"])
            net_delta += leg["signed_qty"] * d
            net_gamma += leg["signed_qty"] * g
            total_qty += abs(leg["signed_qty"])
        if total_qty <= 0:
            return 0.0, 0.0
        return net_delta / total_qty, net_gamma / total_qty

    for i in range(n):
        sim_prices = price_paths[i]
        lots: list[dict] = []   # each: {entry_day, resolved_legs, entry_cash_flow}
        cum_pnl = 0.0

        for d in range(0, horizon_days + 1):
            want_in = float(signal_grid[i, d]) >= 0.5
            spot_now = float(sim_prices[d])

            # Each open lot checks its own risk controls/expiry, plus the
            # shared rule exit (want_in false closes every remaining lot in
            # this same pass) — one MTM per lot per day, no redundant work.
            remaining: list[dict] = []
            unrealized_open = 0.0
            for lot in lots:
                days_held = d - lot["entry_day"]
                t_rem = dte - days_held
                unrealized = _mtm(lot["resolved_legs"], lot["entry_cash_flow"], spot_now, float(t_rem))
                basis = abs(lot["entry_cash_flow"]) or 1.0
                tp_level = (take_profit_pct / 100.0) * basis if take_profit_pct is not None else None
                sl_level = -(stop_loss_pct / 100.0) * basis if stop_loss_pct is not None else None
                is_tp = tp_level is not None and unrealized >= tp_level
                is_sl = sl_level is not None and unrealized <= sl_level
                is_max_hold = max_hold_days is not None and days_held >= max_hold_days
                is_expiry = t_rem <= 0
                is_delta = is_gamma = False
                if not is_expiry and (delta_exit is not None or gamma_exit is not None):
                    ld, lg = _lot_greeks(lot["resolved_legs"], spot_now, t_rem)
                    is_delta = delta_exit is not None and abs(ld) >= delta_exit
                    is_gamma = not is_delta and gamma_exit is not None and abs(lg) >= gamma_exit
                is_hard_exit = is_tp or is_sl or is_max_hold or is_expiry or is_delta or is_gamma
                if is_hard_exit or not want_in:
                    frac = 1.0
                    if not is_hard_exit and exit_frac_cfg < 1.0:
                        # Rule-based exit only: trim instead of fully closing,
                        # unless what would remain is dust relative to this
                        # lot's original size (mirrors the backtester engines).
                        remaining_notional = abs(lot["entry_cash_flow"]) * (1 - exit_frac_cfg)
                        if remaining_notional > max(0.01, lot["orig_basis"] * 0.005):
                            frac = exit_frac_cfg
                    cum_pnl += unrealized * frac
                    trades_total[i] += 1
                    if unrealized > 0:
                        trades_win[i] += 1
                    if frac < 1.0:
                        for leg in lot["resolved_legs"]:
                            leg["signed_qty"] *= (1 - frac)
                        lot["entry_cash_flow"] *= (1 - frac)
                        lot["notional_frac"] *= (1 - frac)
                        remaining.append(lot)
                        unrealized_open += unrealized * (1 - frac)
                else:
                    remaining.append(lot)
                    unrealized_open += unrealized
            lots = remaining

            # New lot: buy signal opens ANOTHER lot regardless of existing
            # ones. No d < horizon_days guard, matching the original code's
            # unconditional first-entry check — an entry on the final
            # simulated day just ends up marked-to-market as a still-open
            # lot in that day's P&L, same as before. A freshly-opened lot's
            # same-bar unrealized is ~0 (entry_val and MTM price it the same
            # way), so it's not added to unrealized_open here.
            if want_in:
                resolved_legs, entry_cash_flow = _open_position(spot_now)
                lots.append({"entry_day": d, "resolved_legs": resolved_legs, "entry_cash_flow": entry_cash_flow,
                            "orig_basis": abs(entry_cash_flow) or 1.0, "notional_frac": 1.0})

            open_notional_path[i, d] = committed_dollars * sum(lot["notional_frac"] for lot in lots)
            pnl_path[i, d] = cum_pnl + unrealized_open

    return {
        "spot": spot,
        "iv": iv,
        "pnl_path": pnl_path,
        "trades_total": trades_total,
        "trades_win": trades_win,
        "open_notional_path": open_notional_path,
    }


def _simulate_ticker_strategy_path(ticker: str, legs_cfg: list, dte: int, horizon_days: int, r: float,
                                  committed_dollars: float, n: int, dt: float, seed,
                                  strategy: str | None, strategy_params: dict | None,
                                  take_profit_pct: float | None, stop_loss_pct: float | None,
                                  max_hold_days: int | None, strategy_rules: dict | None = None,
                                  batch_hist: dict | None = None,
                                  spot: float | None = None, iv: float | None = None,
                                  hist_close: "pd.Series | None" = None,
                                  path_model: str = "gbm", exit_pct: float = 100.0,
                                  delta_exit: float | None = None, gamma_exit: float | None = None):
    """Simulate one ticker's strategy-entry options path (paths+signals cached).

    When spot/iv/hist_close are provided (preferred — from _prefetch_strategy_market),
    no network I/O occurs. That keeps process-pool workers pure-CPU and picklable.
    """
    if spot is None or iv is None:
        spot, iv = _mc_spot_iv(ticker)
    spot = float(spot)
    iv = float(iv)

    if hist_close is None:
        import datetime
        today = datetime.date.today()
        start_dt = today - datetime.timedelta(days=_STRATEGY_HIST_LOOKBACK_DAYS)
        if batch_hist is not None and ticker in batch_hist and not batch_hist[ticker].empty:
            hist_close = batch_hist[ticker]
        else:
            try:
                hist_close = _fetch_close(ticker, start_dt.isoformat(), today.isoformat())
            except Exception:
                hist_close = pd.Series(
                    _synthetic_hist(spot, _STRATEGY_HIST_MIN_BARS),
                    index=pd.date_range(end=today, periods=_STRATEGY_HIST_MIN_BARS),
                )

    hist_values = hist_close.to_numpy(dtype=float) if hasattr(hist_close, "to_numpy") else np.asarray(hist_close, dtype=float)
    if hist_values.size < _STRATEGY_HIST_MIN_BARS:
        pad_n = _STRATEGY_HIST_MIN_BARS - int(hist_values.size)
        seed_px = float(hist_values[0]) if hist_values.size else float(spot)
        pad = _synthetic_hist(seed_px, pad_n + 1)[:-1]
        if pad.size and pad[-1] > 0:
            pad = pad * (seed_px / pad[-1])
        hist_values = np.concatenate([pad, hist_values]) if hist_values.size else _synthetic_hist(spot)

    seed_i = int(seed) if not isinstance(seed, np.random.Generator) else int(np.random.SeedSequence().generate_state(1)[0])
    pack, _hit = _get_path_signal_pack(
        ticker, n, horizon_days, dt, seed_i, spot, iv, hist_values,
        strategy, strategy_params, strategy_rules, path_model=path_model,
    )
    return _apply_trades_on_pack(
        pack, legs_cfg, dte, r, committed_dollars,
        take_profit_pct, stop_loss_pct, max_hold_days,
        exit_pct=exit_pct, delta_exit=delta_exit, gamma_exit=gamma_exit,
    )


def _strategy_sim_job(payload: dict) -> dict:
    """Picklable process-pool entrypoint for one ticker's strategy MC.

    Prefer a prebuilt path+signal `pack` (from parent cache). Falls back to full
    simulate when pack is missing (legacy / tests).
    """
    ticker = payload["ticker"]
    try:
        pack = payload.get("pack")
        if pack is not None:
            res = _apply_trades_on_pack(
                pack,
                payload["legs_cfg"],
                int(payload["dte"]),
                float(payload["r"]),
                float(payload["committed_dollars"]),
                payload.get("take_profit_pct"),
                payload.get("stop_loss_pct"),
                payload.get("max_hold_days"),
                exit_pct=float(payload.get("exit_pct") or 100.0),
                delta_exit=payload.get("delta_exit"),
                gamma_exit=payload.get("gamma_exit"),
            )
        else:
            hist_close = pd.Series(np.asarray(payload["hist_values"], dtype=float))
            res = _simulate_ticker_strategy_path(
                ticker=ticker,
                legs_cfg=payload["legs_cfg"],
                dte=int(payload["dte"]),
                horizon_days=int(payload["horizon_days"]),
                r=float(payload["r"]),
                committed_dollars=float(payload["committed_dollars"]),
                n=int(payload["n"]),
                dt=float(payload["dt"]),
                seed=int(payload["seed"]),
                strategy=payload.get("strategy"),
                strategy_params=payload.get("strategy_params"),
                take_profit_pct=payload.get("take_profit_pct"),
                stop_loss_pct=payload.get("stop_loss_pct"),
                max_hold_days=payload.get("max_hold_days"),
                exit_pct=float(payload.get("exit_pct") or 100.0),
                delta_exit=payload.get("delta_exit"),
                gamma_exit=payload.get("gamma_exit"),
                strategy_rules=payload.get("strategy_rules"),
                spot=float(payload["spot"]),
                iv=float(payload["iv"]),
                hist_close=hist_close,
            )
        return {
            "ok": True,
            "ticker": ticker,
            "spot": res["spot"],
            "iv": res["iv"],
            "pnl_path": res["pnl_path"],
            "trades_total": res["trades_total"],
            "trades_win": res["trades_win"],
            "open_notional_path": res.get("open_notional_path"),
            "cache_hit": bool(payload.get("cache_hit")),
        }
    except Exception as e:
        detail = getattr(e, "detail", None)
        return {"ok": False, "ticker": ticker, "error": str(detail if detail is not None else e)}


def _mc_finite(x, default: float = 0.0) -> float:
    """JSON-safe float — NaN/inf from degenerate paths become `default`."""
    try:
        v = float(x)
        return default if not np.isfinite(v) else v
    except Exception:
        return default


def _market_regression_vs_benchmark(
    equity_paths: np.ndarray,
    horizon_days: int,
    n: int,
    benchmark: str = "SPY",
) -> dict:
    """Market regression for MC equity paths — same KPI shape as the algo backtester.

    1) Co-simulate a market GBM for path overlay bands.
    2) Stack all path-day strategy vs market daily returns and run one OLS
       (correlation, R², beta, daily alpha, p-values, observations) — matches
       the backtester strip: Market Corr / R² / Beta / Daily Alpha / Observations.
    3) Also keep per-path coefficient distributions for optional diagnostics.
    """
    from regression_engine.montecarlo import path_regression
    from regression_engine.schemas import SimulationPathData, RegressionInput
    from regression_engine.ols import ols as _ols_single

    # Strategy daily simple returns (P, T). Drop wipeout transitions: when prior
    # equity is ~0, next-bar return is numerically infinite and wrecks OLS
    # (betas of 1e9, axis labels like 3000000000%).
    prev = equity_paths[:, :-1]
    with np.errstate(divide="ignore", invalid="ignore"):
        strat_rets = np.diff(equity_paths, axis=1) / prev
    alive = prev > (np.nanmax(equity_paths) * 1e-6 + 1e-6)  # prior bar still solvent
    strat_rets = np.where(alive & np.isfinite(strat_rets), strat_rets, np.nan)
    # Clip extreme daily moves for regression (beyond ±50% is noise from
    # leverage/floor artifacts, not economically comparable to market days).
    strat_rets = np.clip(strat_rets, -0.5, 0.5)

    # Calibrate market GBM from benchmark history (cached)
    try:
        hist = get_history(benchmark, period="2y")
        closes = hist["Close"].dropna() if hist is not None and not hist.empty else None
        if closes is not None and len(closes) > 30:
            log_r = np.log(closes / closes.shift(1)).dropna()
            mu = float(log_r.mean() * 252.0)
            sig = float(log_r.std() * np.sqrt(252.0))
        else:
            mu, sig = 0.08, 0.16
    except Exception:
        mu, sig = 0.08, 0.16
    if not np.isfinite(mu):
        mu = 0.08
    if not np.isfinite(sig) or sig <= 1e-6:
        sig = 0.16

    # Per-path market returns (independent GBM futures, same calendar length)
    dt_m = 1.0 / 252.0
    rng = np.random.default_rng(7)
    shocks = (mu - 0.5 * sig ** 2) * dt_m + sig * np.sqrt(dt_m) * rng.standard_normal((n, horizon_days))
    mkt_rets = np.exp(shocks) - 1.0
    mkt_rets = np.where(np.isfinite(mkt_rets), mkt_rets, 0.0)

    # Market equity index for path overlay ($100 start)
    mkt_equity = 100.0 * np.cumprod(1.0 + mkt_rets, axis=1)
    mkt_equity = np.hstack([np.full((n, 1), 100.0), mkt_equity])
    mkt_pct = np.percentile(mkt_equity, [5, 50, 95], axis=0)
    market_bands = [
        {"day": int(d), "p5": round(float(mkt_pct[0, d]), 2),
         "p50": round(float(mkt_pct[1, d]), 2), "p95": round(float(mkt_pct[2, d]), 2)}
        for d in range(horizon_days + 1)
    ]

    # Pooled OLS on stacked daily returns (same convention as backtester KPIs)
    y_flat = strat_rets.ravel()
    x_flat = mkt_rets.ravel()
    mask = np.isfinite(y_flat) & np.isfinite(x_flat)
    y_flat, x_flat = y_flat[mask], x_flat[mask]
    # Winsorize both legs for scatter/OLS stability (1st–99th pct)
    if y_flat.size > 20:
        y_lo, y_hi = np.percentile(y_flat, [1, 99])
        x_lo_w, x_hi_w = np.percentile(x_flat, [1, 99])
        keep = (y_flat >= y_lo) & (y_flat <= y_hi) & (x_flat >= x_lo_w) & (x_flat <= x_hi_w)
        y_flat, x_flat = y_flat[keep], x_flat[keep]
    summary = {
        "correlation": 0.0,
        "r_squared": 0.0,
        "beta": 0.0,
        "beta_p": None,
        "alpha_daily": 0.0,
        "alpha_p": None,
        "observations": int(y_flat.size),
    }
    # Scatter subsample for chart (strategy daily ret vs market daily ret)
    scatter_x: list[float] = []
    scatter_y: list[float] = []
    scatter_line: list[dict] = []
    try:
        if y_flat.size >= 3 and float(np.std(x_flat)) > 1e-12:
            out = _ols_single(RegressionInput(y_flat, x_flat.reshape(-1, 1), [benchmark.upper()]))
            corr = float(np.corrcoef(x_flat, y_flat)[0, 1]) if y_flat.size > 1 else 0.0
            if not np.isfinite(corr):
                corr = 0.0
            beta_v = _mc_finite(float(out.betas[0]))
            alpha_v = _mc_finite(out.alpha)
            # Guard absurd coefficients (still possible with near-collinear junk)
            if abs(beta_v) > 50:
                beta_v = float(np.clip(beta_v, -50, 50))
            if abs(alpha_v) > 0.1:  # >10% daily intercept is not economic
                alpha_v = float(np.clip(alpha_v, -0.1, 0.1))
            summary = {
                "correlation": round(_mc_finite(corr), 4),
                "r_squared": round(_mc_finite(out.r_squared), 4),
                "beta": round(beta_v, 4),
                "beta_p": round(_mc_finite(float(out.p_values[1])), 6) if len(out.p_values) > 1 else None,
                "alpha_daily": round(alpha_v, 8),
                "alpha_p": round(_mc_finite(float(out.p_values[0])), 6) if len(out.p_values) > 0 else None,
                "observations": int(out.n_obs),
            }
            x_lo, x_hi = float(np.percentile(x_flat, 1)), float(np.percentile(x_flat, 99))
            scatter_line = [
                {"x": round(x_lo, 6), "y": round(alpha_v + beta_v * x_lo, 6)},
                {"x": round(x_hi, 6), "y": round(alpha_v + beta_v * x_hi, 6)},
            ]
            step = max(1, y_flat.size // 2000)
            scatter_x = [round(_mc_finite(v), 6) for v in x_flat[::step]]
            scatter_y = [round(_mc_finite(v), 6) for v in y_flat[::step]]
    except Exception as e:
        import logging
        logging.warning("Pooled market OLS failed: %s", e)

    # Per-path distributions (optional diagnostics / legacy)
    alpha_dict = beta_dict = r2_dict = None
    n_failed = 0
    try:
        # path_regression needs finite arrays (zeros for dead bars)
        strat_for_paths = np.where(np.isfinite(strat_rets), strat_rets, 0.0)
        pr = path_regression(
            SimulationPathData(
                strategy_paths=strat_for_paths,
                factor_paths=mkt_rets,
                factor_names=[benchmark.upper()],
            ),
            keep_per_path=False,
        )
        n_failed = int(pr.n_failed)
        alpha_dict = pr.alpha.to_dict()
        for k, v in list(alpha_dict.items()):
            if v is not None and k != "prob_positive":
                alpha_dict[k] = round(_mc_finite(v * 252.0 * 100.0), 4)
        beta_dict = pr.betas[0].to_dict() if pr.betas else None
        r2_dict = pr.r_squared.to_dict()
        if beta_dict:
            for k, v in list(beta_dict.items()):
                if v is not None and k != "prob_positive":
                    beta_dict[k] = round(_mc_finite(v), 4)
        if r2_dict:
            for k, v in list(r2_dict.items()):
                if v is not None and k != "prob_positive":
                    r2_dict[k] = round(_mc_finite(v), 4)
    except Exception as e:
        import logging
        logging.warning("Per-path market regression failed: %s", e)
        n_failed = n

    return {
        "benchmark": benchmark.upper(),
        "n_paths": n,
        "n_obs": horizon_days,
        "n_failed": n_failed,
        # Backtester-identical summary strip
        "summary": summary,
        "alpha_ann_pct": alpha_dict,
        "beta": beta_dict,
        "r_squared": r2_dict,
        # Daily-return scatter (x=market, y=strategy) for the regression chart
        "scatter": {
            "x": scatter_x,
            "y": scatter_y,
            "line": scatter_line,
        },
        "market_bands": market_bands,
        "calibration": {
            "mu_annual": round(mu * 100.0, 2),
            "sigma_annual": round(sig * 100.0, 2),
        },
    }


def _run_strategy_basket(
    tickers: list[str],
    market: dict,
    legs_cfg: list,
    dte: int,
    horizon_days: int,
    r: float,
    dollars_per_trade: float,
    n: int,
    dt: float,
    strategy: str | None,
    strategy_params: dict | None,
    take_profit_pct: float | None,
    stop_loss_pct: float | None,
    max_hold_days: int | None,
    strategy_rules: dict | None,
    path_model: str = "gbm",
    exit_pct: float = 100.0,
    delta_exit: float | None = None,
    gamma_exit: float | None = None,
) -> tuple[np.ndarray, np.ndarray, dict, dict]:
    """Run strategy MC for a prefetched basket.

    `dollars_per_trade` is the full notional for each admitted trade
    (position_size% × leverage × capital) — same as portfolio_backtest, NOT
    split 1/N across the universe.

    Large jobs (process pool) escape the GIL; small jobs run in-process to
    avoid spawn overhead. Returns
    (pnl_path, open_notional_path, per_ticker_results, dropped).
    """
    import concurrent.futures
    import multiprocessing as mp

    path_model = (path_model or "gbm").lower()
    if path_model not in _PATH_MODELS:
        path_model = "gbm"

    work_units = len(tickers) * n * horizon_days
    use_processes = work_units >= _STRATEGY_PROC_MIN_WORK and len(tickers) >= 1
    # Single tiny ticker: stay in-process (spawn cost dominates).
    if len(tickers) == 1 and work_units < _STRATEGY_PROC_MIN_WORK * 2:
        use_processes = False

    seed_ints = [int(s.generate_state(1)[0]) for s in np.random.SeedSequence().spawn(len(tickers))]
    # Mutable holder so nested _consume can update without `nonlocal` surprises
    # on `pnl_path +=` (which Python treats as local rebinding).
    acc = {
        "pnl": np.zeros((n, horizon_days + 1)),
        "open_notional": np.zeros((n, horizon_days + 1)),
    }
    per_ticker_results: dict = {}
    dropped: dict = {}

    def _consume(res: dict):
        tk = res["ticker"]
        if not res.get("ok"):
            dropped[tk] = res.get("error") or "simulation failed"
            return
        per_ticker_results[tk] = {
            "spot": res["spot"],
            "iv": res["iv"],
            "pnl_path": res["pnl_path"],
            "trades_total": res["trades_total"],
            "trades_win": res["trades_win"],
        }
        acc["pnl"] += res["pnl_path"]
        on = res.get("open_notional_path")
        if on is not None:
            acc["open_notional"] += on

    # Optional joint shocks for multi-name GBM / Student-t (macro co-movement).
    # Bootstrap stays per-name (historical blocks already embed that ticker's vol).
    shared_by_ticker: dict[str, np.ndarray] | None = None
    if path_model in ("gbm", "student_t", "gbm_rn") and len(tickers) >= 2:
        chol = _corr_cholesky_from_hists([market[tk]["hist_values"] for tk in tickers if tk in market])
        if chol is not None:
            k = len(tickers)
            rng_j = np.random.default_rng(int(seed_ints[0]) ^ 0xC0FFEE)
            if path_model == "student_t":
                z = _student_t_shocks(rng_j, (n, horizon_days, k))
            else:
                z = rng_j.standard_normal((n, horizon_days, k))
            # correlated: Z @ L.T  for each day  → (n, H, k)
            corr_z = np.einsum("nhk,jk->nhj", z, chol)
            shared_by_ticker = {tk: corr_z[:, :, j] for j, tk in enumerate(tickers)}
            _set_mc_progress(16, f"Joint {path_model} shocks ({k} names, correlated)…")

    # Build path+signal packs in the parent (shared TTL cache). Workers only
    # re-apply sizing/risk — so trade-size / TP-SL / max-hold changes are fast.
    payloads = []
    cache_hits = 0
    n_tk = max(1, len(tickers))
    for i, (tk, seed) in enumerate(zip(tickers, seed_ints)):
        # Paths+signals: 15% → 80% of overall job
        _set_mc_progress(
            15 + 65 * (i / n_tk),
            f"Simulating {tk} ({i + 1}/{n_tk}) — {path_model} paths & signals…",
        )
        m = market[tk]
        sh = shared_by_ticker.get(tk) if shared_by_ticker else None
        pack, hit = _get_path_signal_pack(
            tk, n, horizon_days, dt, int(seed),
            float(m["spot"]), float(m["iv"]), m["hist_values"],
            strategy, strategy_params, strategy_rules,
            path_model=path_model, shared_shocks=sh,
        )
        if hit:
            cache_hits += 1
            _set_mc_progress(
                15 + 65 * ((i + 0.5) / n_tk),
                f"Cache hit {tk} ({i + 1}/{n_tk}) — applying trades…",
            )
        payloads.append({
            "ticker": tk,
            "pack": pack,
            "cache_hit": hit,
            "legs_cfg": legs_cfg,
            "dte": dte,
            "horizon_days": horizon_days,
            "r": r,
            "committed_dollars": dollars_per_trade,
            "n": n,
            "dt": dt,
            "seed": int(seed),
            "strategy": strategy,
            "strategy_params": strategy_params,
            "take_profit_pct": take_profit_pct,
            "stop_loss_pct": stop_loss_pct,
            "max_hold_days": max_hold_days,
            "exit_pct": exit_pct,
            "delta_exit": delta_exit,
            "gamma_exit": gamma_exit,
            "strategy_rules": strategy_rules,
            "path_model": path_model,
            "spot": m["spot"],
            "iv": m["iv"],
            "hist_values": m["hist_values"],
        })

    # If every ticker hit the path cache, apply trades in-process (cheap) —
    # process-pool spawn would dominate.
    all_cached = cache_hits == len(payloads) and len(payloads) > 0
    _set_mc_progress(82, "Applying trade engine across tickers…")
    if use_processes and not all_cached:
        workers = min(_STRATEGY_PROC_WORKERS, len(tickers))
        pool = None
        try:
            ctx = mp.get_context("spawn")
            pool = concurrent.futures.ProcessPoolExecutor(max_workers=workers, mp_context=ctx)
            futs = [pool.submit(_strategy_sim_job, p) for p in payloads]
            for fut in concurrent.futures.as_completed(futs):
                _consume(fut.result())
        except Exception as e:
            import logging
            logging.warning("Strategy process pool failed (%s) — falling back to in-process", e)
            per_ticker_results.clear()
            dropped.clear()
            acc["pnl"] = np.zeros((n, horizon_days + 1))
            acc["open_notional"] = np.zeros((n, horizon_days + 1))
            for p in payloads:
                _consume(_strategy_sim_job(p))
        finally:
            if pool is not None:
                try:
                    pool.shutdown(wait=True, cancel_futures=True)
                except TypeError:
                    pool.shutdown(wait=True)
    else:
        for p in payloads:
            _consume(_strategy_sim_job(p))

    # Surface cache stats on first ticker result for diagnostics (optional UI)
    if per_ticker_results:
        first = next(iter(per_ticker_results.values()))
        first["_path_cache"] = {
            "hits": cache_hits,
            "total": len(payloads),
            "all_cached": all_cached,
            **{k: _MC_PATH_CACHE_STATS[k] for k in ("hits", "misses")},
        }

    return acc["pnl"], acc["open_notional"], per_ticker_results, dropped


def _combo_monte_carlo_impl(req: ComboMonteCarloRequest):
    legs_cfg = req.combo.get("legs") or []
    if not legs_cfg:
        raise HTTPException(422, "Combo needs at least one leg")
    dte = max(1, int(req.combo.get("dte", 30)))
    r = 4.0
    dt = 1.0 / 365.0

    tickers = [t.strip().upper() for t in req.tickers if t and t.strip()] if req.tickers else [req.ticker.strip().upper()]
    if not tickers:
        raise HTTPException(422, "Need at least one ticker")
    is_basket = len(tickers) > 1

    # Match portfolio_backtest: trade_size_pct = position_size × leverage (e.g. 8% × 3x = 24%).
    # Each admitted trade (any ticker) is sized to that fraction of capital — NEVER 1/N of the book.
    trade_size_pct = float(req.position_size) * float(req.leverage)
    dollars_per_trade = req.initial_capital * (trade_size_pct / 100.0)
    n = min(max(int(req.n_sims), 100), 5000)

    # Strategy Mode Check
    if req.strategy is not None or req.strategy_rules is not None:
        raw_horizon = req.horizon_days if req.horizon_days is not None else 252
        horizon_days = min(max(int(raw_horizon), 1), _STRATEGY_HORIZON_CAP)
        n = min(n, _STRATEGY_N_SIMS_CAP)

        # Phase 1 — network only (threaded): spot/IV + long history for the whole basket.
        _set_mc_progress(8, f"Fetching spot/IV & history for {len(tickers)} tickers…")
        market, dropped_tickers = _prefetch_strategy_market(tickers)
        if not market:
            raise HTTPException(
                422,
                f"No live spot/IV available for any of the {len(tickers)} tickers in this basket",
            )
        # Normalize once so process-pool workers all see the same rule shape.
        strategy_rules = _normalize_mc_strategy_rules(req.strategy_rules)
        # Phase 2 — CPU only (process pool for large jobs): no further I/O.
        live_tickers = [t for t in tickers if t in market]
        path_model = getattr(req, "path_model", None) or "gbm"
        _set_mc_progress(15, f"Building {path_model} paths & signals ({len(live_tickers)} names × {n} sims)…")
        pnl_path, open_notional_path, per_ticker_results, sim_dropped = _run_strategy_basket(
            live_tickers, market, legs_cfg, dte, horizon_days, r, dollars_per_trade,
            n, dt, req.strategy, req.strategy_params, req.take_profit_pct, req.stop_loss_pct,
            req.max_hold_days, strategy_rules, path_model=path_model, exit_pct=req.exit_pct,
            delta_exit=req.delta_exit, gamma_exit=req.gamma_exit,
        )
        dropped_tickers.update(sim_dropped)
        if not per_ticker_results:
            raise HTTPException(
                422,
                f"No live spot/IV available for any of the {len(tickers)} tickers in this basket",
            )
        tickers = [t for t in tickers if t in per_ticker_results]

        _set_mc_progress(86, "Computing equity, metrics & financing…")
        # Financing like portfolio_backtest: interest only when gross open notional
        # (sum of full-size trades) exceeds capital.
        day_idx = np.arange(horizon_days + 1)
        borrowed = np.maximum(0.0, open_notional_path - req.initial_capital)
        # Cumulative EAR growth on the borrowed path (per-day incremental charge)
        ear_daily = _ear_growth_factor(req.effective_annual_rate, 1.0)  # growth over 1 day
        # Interest accrued day d ≈ borrowed[d] * daily_factor; cumsum for total drag to date
        if req.effective_annual_rate > 0 and ear_daily > 0:
            interest_daily = borrowed * ear_daily
            financing = np.cumsum(interest_daily, axis=1)
        else:
            financing = np.zeros_like(borrowed)
        equity_paths = np.maximum(0.0, req.initial_capital + pnl_path - financing)

        final_caps = equity_paths[:, -1]
        # CAGR — clamp ratio to avoid overflow to inf when leverage explodes a path
        growth = np.clip(final_caps / max(req.initial_capital, 1e-9), 0.0, 1e6)
        ann_returns = np.where(
            final_caps > 0,
            (np.power(growth, 252.0 / max(horizon_days, 1)) - 1.0) * 100.0,
            -100.0,
        )
        ann_returns = np.where(np.isfinite(ann_returns), ann_returns, -100.0)

        roll_max = np.maximum.accumulate(equity_paths, axis=1)
        drawdowns = (equity_paths - roll_max) / np.where(roll_max <= 0, 1.0, roll_max)
        max_drawdowns = np.min(drawdowns, axis=1) * 100.0
        max_drawdowns = np.where(np.isfinite(max_drawdowns), max_drawdowns, 0.0)

        daily_returns = np.diff(equity_paths, axis=1) / np.where(equity_paths[:, :-1] <= 0, 1.0, equity_paths[:, :-1])
        daily_returns = np.where(np.isfinite(daily_returns), daily_returns, 0.0)
        ret_mean = np.mean(daily_returns, axis=1)
        ret_std = np.std(daily_returns, axis=1)
        sharpes = np.where(ret_std > 1e-12, ret_mean / ret_std * np.sqrt(252.0), 0.0)
        sharpes = np.where(np.isfinite(sharpes), sharpes, 0.0)

        all_trades_total = np.zeros(n)
        all_trades_win = np.zeros(n)
        for res in per_ticker_results.values():
            all_trades_total += res["trades_total"]
            all_trades_win += res["trades_win"]
        # Per-path win rate (0 when no trades). For rare-entry signals (e.g. IVR>80
        # AND large drawdowns) most paths are flat zeros — use aggregate win rate
        # and mean trades so KPIs aren't all-zero while a real subset traded.
        win_rates = np.where(all_trades_total > 0, all_trades_win / all_trades_total * 100.0, np.nan)
        traded_mask = all_trades_total > 0
        agg_trades = float(all_trades_total.sum())
        agg_wins = float(all_trades_win.sum())
        win_rate_metric = (
            float(agg_wins / agg_trades * 100.0) if agg_trades > 0
            else 0.0
        )
        # Mean trades/path is more informative than median when >50% of paths are 0
        num_trades_metric = float(np.mean(all_trades_total))
        med_trades_when = (
            float(np.median(all_trades_total[traded_mask])) if traded_mask.any() else 0.0
        )

        # Equity bands on a $100 notional (stable chart scale) — not raw $ P&L
        equity_100 = 100.0 * equity_paths / max(req.initial_capital, 1e-9)
        eq_pct = np.percentile(equity_100, [5, 25, 50, 75, 95], axis=0)
        pnl_bands = [
            {
                "day": int(d),
                "p5": round(_mc_finite(eq_pct[0, d]), 2),
                "p25": round(_mc_finite(eq_pct[1, d]), 2),
                "p50": round(_mc_finite(eq_pct[2, d]), 2),
                "p75": round(_mc_finite(eq_pct[3, d]), 2),
                "p95": round(_mc_finite(eq_pct[4, d]), 2),
            }
            for d in range(horizon_days + 1)
        ]

        final_pnl = final_caps - req.initial_capital
        final_equity_100 = 100.0 * final_caps / max(req.initial_capital, 1e-9)
        percentiles = {
            k: round(_mc_finite(np.percentile(final_pnl, q)), 2)
            for k, q in [("p5", 5), ("p25", 25), ("p50", 50), ("p75", 75), ("p95", 95)]
        }
        # Terminal equity on $100 start (for histogram + footer)
        percentiles_equity = {
            k: round(_mc_finite(np.percentile(final_equity_100, q)), 2)
            for k, q in [("p5", 5), ("p25", 25), ("p50", 50), ("p75", 75), ("p95", 95)]
        }
        prob_profit = round(_mc_finite((final_pnl > 0).mean() * 100), 1)
        interest_paid_p50 = _mc_finite(np.median(financing[:, -1])) if req.effective_annual_rate > 0 else 0.0

        # Binned terminal distribution ($100 start) — frontend-ready
        fe = final_equity_100[np.isfinite(final_equity_100)]
        hist_bins: list[dict] = []
        if fe.size > 0:
            lo, hi = float(np.percentile(fe, 1)), float(np.percentile(fe, 99))
            if hi <= lo:
                lo, hi = float(fe.min()), float(fe.max() + 1e-6)
            counts, edges = np.histogram(fe, bins=40, range=(lo, hi))
            hist_bins = [
                {"price": round(float((edges[i] + edges[i + 1]) / 2), 2), "count": int(counts[i])}
                for i in range(len(counts))
            ]

        _set_mc_progress(92, "Market regression vs SPY…")
        market_reg = _market_regression_vs_benchmark(equity_paths, horizon_days, n, benchmark="SPY")
        _set_mc_progress(98, "Packaging results…")

        med_trades = _mc_finite(num_trades_metric)
        pct_paths_traded = _mc_finite(traded_mask.mean() * 100.0)
        warn = None
        if pct_paths_traded <= 0:
            warn = (
                "No option entries fired on any simulated path — equity stays flat and market "
                "regression is undefined. For rules like IV Rank > 80 AND 30d/10d % declines, "
                "entries only appear on paths that crash hard enough. "
                "History for IV Rank(252) now loads ~2y (was ~8m, which left IV Rank as NaN). "
                "If this persists: lengthen Horizon, raise vol, loosen thresholds, or use "
                "Entry Signal → Enter Immediately."
            )
        elif pct_paths_traded < 15:
            warn = (
                f"Sparse entries: only {pct_paths_traded:.0f}% of paths took a trade "
                f"(mean {num_trades_metric:.2f}/path; median when traded {med_trades_when:.1f}). "
                "IV Rank > 80 combined with large % drops is intentionally rare under GBM."
            )

        first_tk = tickers[0]
        res_first = per_ticker_results[first_tk]

        return {
            "ticker": first_tk if not is_basket else None,
            "tickers": tickers if is_basket else None,
            "dropped_tickers": [{"ticker": tk, "reason": reason} for tk, reason in dropped_tickers.items()] if is_basket else None,
            "is_basket": is_basket,
            "spot": round(_mc_finite(res_first["spot"]), 2) if not is_basket else None,
            "iv": round(_mc_finite(res_first["iv"]), 1) if not is_basket else None,
            "dte": dte,
            "entry_credit_debit": 0.0,
            "breakevens": [],
            "per_ticker_breakevens": None,
            "max_profit": None,
            "max_loss": None,
            "prob_profit": prob_profit,
            "percentiles": percentiles,
            "percentiles_equity": percentiles_equity,
            "payoff_curve": [],
            "histogram": hist_bins,
            "n_sims": n,
            "horizon_days": horizon_days,
            "path_model": path_model,
            "has_exit_rule": req.take_profit_pct is not None or req.stop_loss_pct is not None or req.max_hold_days is not None,
            "max_hold_days": req.max_hold_days,
            "avg_hold_days": 0.0,
            "pct_take_profit": 0.0,
            "pct_stop_loss": 0.0,
            "pct_held_to_exit_cap": 0.0,
            "initial_capital": req.initial_capital,
            "position_size": req.position_size,
            "leverage": req.leverage,
            "trade_size_pct": round(trade_size_pct, 2),  # position_size × leverage (per trade)
            "dollars_per_trade": round(dollars_per_trade, 2),
            "effective_annual_rate": req.effective_annual_rate,
            "interest_paid_p50": round(interest_paid_p50, 2),
            "pnl_bands": pnl_bands,
            "bands_unit": "equity_100",  # frontend: values already $100-start equity
            "strategy_metrics": {
                "ann_return": round(_mc_finite(np.median(ann_returns)), 2),
                "max_drawdown": round(_mc_finite(np.median(max_drawdowns)), 2),
                "sharpe": round(_mc_finite(np.median(sharpes)), 2),
                # Aggregate across all trades — not median of per-path rates (which
                # is 0 when a rare IVR+crash signal leaves most paths untraded).
                "win_rate": round(_mc_finite(win_rate_metric), 1),
                "num_trades": round(_mc_finite(num_trades_metric), 2),
            },
            "market_regression": market_reg,
            "diagnostics": {
                "median_trades": round(_mc_finite(med_trades_when), 1),
                "mean_trades": round(_mc_finite(num_trades_metric), 2),
                "pct_paths_with_trades": round(pct_paths_traded, 1),
                "warning": warn,
                "path_cache": (per_ticker_results.get(first_tk) or {}).get("_path_cache"),
            },
        }

    dropped_tickers: dict = {}   # ticker -> reason, populated in the basket branch below
    # Hold-to-DTE: each name is a full-size trade (same dollars_per_trade), not 1/N.
    path_model_h2d = getattr(req, "path_model", None) or "gbm"
    _set_mc_progress(12, f"Hold-to-DTE simulation ({path_model_h2d})…")
    if is_basket:
        # options_snapshot does its own live fetch (price history + up to a
        # dozen option-chain calls hunting for a valid ATM expiry) per ticker
        # — sequential, that's 60+ round trips end-to-end for the reported
        # real-world basket size before any simulation even starts. Fetch/
        # simulate concurrently instead (each ticker is an independent cache
        # key in options_snapshot, so this is safe). np.random.Generator is
        # NOT thread-safe to share across threads — spawn an independent,
        # non-overlapping stream per ticker via SeedSequence. Accumulate into
        # a running total rather than collecting all N per-ticker (n_sims,
        # dte+1) arrays first: at the 100-ticker/5000-sim/365-DTE cap, holding
        # all of them at once would peak past 1GB on this VM's own budget
        # (see _COMBO_MC_SEM's comment above) — bounded to ~_BASKET_FETCH_WORKERS
        # in-flight arrays plus the running total instead.
        import concurrent.futures
        child_seeds = np.random.SeedSequence().spawn(len(tickers))
        entry_cash_flow = 0.0
        pnl_path = np.zeros((n, dte + 1))
        per_ticker_results: dict = {}
        with concurrent.futures.ThreadPoolExecutor(max_workers=min(_BASKET_FETCH_WORKERS, len(tickers))) as pool:
            futures = {
                pool.submit(
                    _price_ticker_leg, tk, legs_cfg, dte, r, dollars_per_trade, n, dt,
                    np.random.default_rng(seed), path_model_h2d,
                ): tk
                for tk, seed in zip(tickers, child_seeds)
            }
            for fut in concurrent.futures.as_completed(futures):
                tk = futures[fut]
                try:
                    res = fut.result()
                # A basket at real-world scale (60-100+ symbols) is expected to hit
                # at least one bad ticker (delisted, no listed options, a transient
                # fetch failure) — one name failing shouldn't 404 the whole basket
                # and discard every other ticker's already-completed work. Drop it
                # and keep going; the response reports what was dropped and why,
                # same "no silent gaps" posture as the rest of the app's caveats.
                except HTTPException as e:
                    dropped_tickers[tk] = str(e.detail)
                except Exception as e:
                    dropped_tickers[tk] = str(e)
                else:
                    entry_cash_flow += res["entry_cash_flow"]
                    pnl_path += res["pnl_path"]
                    per_ticker_results[tk] = res
        if not per_ticker_results:
            raise HTTPException(422, f"No live spot/IV available for any of the {len(tickers)} tickers in this basket")
        tickers = [t for t in tickers if t in per_ticker_results]   # drop failures, preserve request order
        per_ticker_single = None
        # All names open together for the full DTE → gross open notional = N × trade size
        gross_open = dollars_per_trade * len(tickers)
    else:
        rng = np.random.default_rng()
        res = _price_ticker_leg(
            tickers[0], legs_cfg, dte, r, dollars_per_trade, n, dt, rng, path_model_h2d,
        )
        entry_cash_flow = res["entry_cash_flow"]
        pnl_path = res["pnl_path"]
        per_ticker_single = res
        gross_open = dollars_per_trade

    # Financing: interest only on notional beyond capital (same as portfolio_backtest).
    borrowed_notional = max(0.0, gross_open - req.initial_capital)
    # Financing at full term (the deterministic "held to expiry" reference below)
    # — folded into payoff() itself so breakevens/max-profit/max-loss all widen
    # correctly to account for the borrowing cost, same as a real levered account.
    financing_at_expiry = borrowed_notional * _ear_growth_factor(req.effective_annual_rate, dte)

    if is_basket:
        # No single price axis applies once there's more than one underlying —
        # skip the deterministic curve/breakevens/max-profit/max-loss for the
        # basket as a whole; the simulated distribution (percentiles/
        # histogram) below still fully represents the basket's outcome. Each
        # ticker's OWN breakeven(s) are still well-defined though (each has
        # its own spot/strikes), sharing an equal split of the basket's total
        # financing cost — surfaced as reference info per name.
        curve: list[dict] = []
        breakevens: list[float] = []
        max_profit_expiry = None
        max_loss_expiry = None
        financing_share = financing_at_expiry / len(tickers)
        per_ticker_breakevens = [
            {
                "ticker": tk,
                "spot": round(res["spot"], 2),
                "entry_credit_debit": round(res["entry_cash_flow"], 2),
                **dict(zip(
                    ("breakevens", "max_profit", "max_loss"),
                    _payoff_breakevens(res["resolved"], res["spot"], res["entry_cash_flow"], financing_share, req.initial_capital)[1:],
                )),
            }
            for tk, res in ((t, per_ticker_results[t]) for t in tickers)
        ]
    else:
        resolved, spot = per_ticker_single["resolved"], per_ticker_single["spot"]
        curve, breakevens, max_profit_expiry, max_loss_expiry = _payoff_breakevens(
            resolved, spot, entry_cash_flow, financing_at_expiry, req.initial_capital
        )
        per_ticker_breakevens = None

    has_exit_rule = req.take_profit_pct is not None or req.stop_loss_pct is not None or req.max_hold_days is not None
    max_days = min(int(req.max_hold_days), dte) if req.max_hold_days is not None else dte
    basis = abs(entry_cash_flow) or 1.0
    tp_level = (req.take_profit_pct / 100.0) * basis if req.take_profit_pct is not None else None
    sl_level = -(req.stop_loss_pct / 100.0) * basis if req.stop_loss_pct is not None else None

    search = pnl_path[:, :max_days + 1]
    hit_tp = (search >= tp_level) if tp_level is not None else np.zeros_like(search, dtype=bool)
    hit_sl = (search <= sl_level) if sl_level is not None else np.zeros_like(search, dtype=bool)
    exit_trigger = hit_tp | hit_sl
    triggered = exit_trigger.any(axis=1)
    exit_day = np.where(triggered, exit_trigger.argmax(axis=1), max_days)
    pnl = pnl_path[np.arange(n), exit_day]
    # Financing accrues over each path's OWN holding period (an early TP/SL
    # exit stops paying it, same as closing a levered position early does) —
    # computed per-path from exit_day, not the fixed DTE the expiry curve uses.
    financing = borrowed_notional * _ear_growth_factor(req.effective_annual_rate, exit_day)
    pnl = np.maximum(pnl - financing, -req.initial_capital)

    # Which rule fired on each path's actual exit day (both can trigger the
    # same day on a large gap move — stop-loss wins that tie as the more
    # conservative read of what happened).
    row_idx = np.arange(n)
    sl_at_exit = hit_sl[row_idx, exit_day] if sl_level is not None else np.zeros(n, dtype=bool)
    tp_at_exit = hit_tp[row_idx, exit_day] if tp_level is not None else np.zeros(n, dtype=bool)
    exited_sl = triggered & sl_at_exit
    exited_tp = triggered & tp_at_exit & ~exited_sl
    pct_take_profit = round(float(exited_tp.mean() * 100), 1) if tp_level is not None else 0.0
    pct_stop_loss = round(float(exited_sl.mean() * 100), 1) if sl_level is not None else 0.0
    pct_held_full_term = round(float((~triggered).mean() * 100), 1)
    avg_hold_days = round(float(exit_day.mean()), 1)

    percentiles = {k: round(float(np.percentile(pnl, q)), 2)
                   for k, q in [("p5", 5), ("p25", 25), ("p50", 50), ("p75", 75), ("p95", 95)]}
    prob_profit = round(float((pnl > 0).mean() * 100), 1)

    # Day-by-day P&L distribution across the full simulated horizon (not just
    # the terminal/exit outcome above) — each path is frozen at its own exit
    # day (a closed position's P&L doesn't keep moving) with financing accrued
    # only up to that same day, then percentiled across paths per day. This is
    # what the frontend plots as a percentile fan chart, same convention as
    # the Portfolio tab's Monte Carlo paths chart.
    day_idx = np.arange(dte + 1)[None, :]
    frozen_day = np.minimum(day_idx, exit_day[:, None])
    managed_pnl_path = pnl_path[np.arange(n)[:, None], frozen_day]
    managed_pnl_path = np.maximum(
        managed_pnl_path - borrowed_notional * _ear_growth_factor(req.effective_annual_rate, frozen_day),
        -req.initial_capital,
    )
    pct_grid = np.percentile(managed_pnl_path, [5, 25, 50, 75, 95], axis=0)   # (5, dte+1)
    pnl_bands = [
        {"day": d, "p5": round(float(pct_grid[0, d]), 2), "p25": round(float(pct_grid[1, d]), 2),
         "p50": round(float(pct_grid[2, d]), 2), "p75": round(float(pct_grid[3, d]), 2), "p95": round(float(pct_grid[4, d]), 2)}
        for d in range(dte + 1)
    ]

    return {
        "ticker": tickers[0] if not is_basket else None,
        "tickers": tickers if is_basket else None,
        "dropped_tickers": [{"ticker": tk, "reason": reason} for tk, reason in dropped_tickers.items()] if is_basket else None,
        "is_basket": is_basket,
        "spot": round(per_ticker_single["spot"], 2) if not is_basket else None,
        "iv": round(per_ticker_single["iv"], 1) if not is_basket else None,
        "dte": dte,
        "entry_credit_debit": round(entry_cash_flow, 2),
        "breakevens": breakevens,
        "per_ticker_breakevens": per_ticker_breakevens,
        "max_profit": max_profit_expiry, "max_loss": max_loss_expiry,
        "prob_profit": prob_profit,
        "percentiles": percentiles,
        "payoff_curve": curve,
        "histogram": sorted(round(float(v), 2) for v in pnl),
        "n_sims": n,
        "has_exit_rule": has_exit_rule,
        "max_hold_days": max_days if has_exit_rule else None,
        "avg_hold_days": avg_hold_days,
        "pct_take_profit": pct_take_profit,
        "pct_stop_loss": pct_stop_loss,
        "pct_held_to_exit_cap": pct_held_full_term,
        "initial_capital": req.initial_capital, "position_size": req.position_size,
        "leverage": req.leverage, "effective_annual_rate": req.effective_annual_rate,
        "interest_paid_p50": round(float(np.median(financing)), 2) if req.effective_annual_rate > 0 else 0.0,
        "pnl_bands": pnl_bands,
    }


@router.post("/backtest")
def backtest(req: BacktestRequest):
    close = _fetch_close(req.ticker, req.start, req.end)
    if len(close) < 60:
        raise HTTPException(status_code=422, detail="Insufficient price history for backtest")
    signal = _compute_signal(close, req.strategy, req.params)
    signal = _apply_risk_controls(
        signal, close,
        req.stop_loss, req.take_profit,
        req.trailing_stop, req.max_hold_bars,
    )
    # Risk controls are already baked into `signal` here (single-position,
    # no scale-in for this legacy hardcoded-strategy route) — recover the
    # buy/sell edges so they replay unchanged through the new engine.
    position_changes = signal.diff().fillna(0)
    buy_signal = (position_changes > 0).to_numpy()
    sell_signal = (position_changes < 0).to_numpy()
    result = _compute_metrics(buy_signal, sell_signal, close, req.position_size, req.initial_capital)
    result["bars"] = int(len(close))
    result["span"] = {"start": str(close.index[0].date()), "end": str(close.index[-1].date())}
    return result


@router.post("/signal")
def signal(req: SignalRequest):
    import datetime
    end = datetime.date.today().isoformat()
    start_dt = datetime.date.today() - datetime.timedelta(days=300)
    start = start_dt.isoformat()
    close = _fetch_close(req.ticker, start, end)
    if len(close) < 30:
        raise HTTPException(status_code=422, detail="Insufficient data for signal")
    sig = _compute_signal(close, req.strategy, req.params)
    current = float(sig.iloc[-1])
    prev = float(sig.iloc[-2]) if len(sig) > 1 else current

    p = req.params or {}

    if req.strategy == "rsi_mean_reversion":
        rsi = _compute_rsi(close, int(p.get("period", 14)))
        value = round(float(rsi.iloc[-1]), 2)
        if current == 1 and prev == 0:
            label = "BUY"
        elif current == 0 and prev == 1:
            label = "SELL"
        elif current == 1:
            label = "BUY"
        else:
            label = "HOLD"
        description = f"RSI={value:.1f}"

    elif req.strategy == "ma_crossover":
        fast = int(p.get("fast", 20))
        slow = int(p.get("slow", 50))
        fm = float(close.rolling(fast).mean().iloc[-1])
        sm = float(close.rolling(slow).mean().iloc[-1])
        value = round(fm - sm, 4)
        label = "BUY" if current == 1 else "SELL"
        description = f"Fast MA={fm:.2f} vs Slow MA={sm:.2f}"

    elif req.strategy == "bollinger_breakout":
        period = int(p.get("period", 20))
        std_dev = float(p.get("std_dev", 2.0))
        mid = float(close.rolling(period).mean().iloc[-1])
        std = float(close.rolling(period).std().iloc[-1])
        upper = mid + std_dev * std
        lower = mid - std_dev * std
        last_price = float(close.iloc[-1])
        value = round(last_price, 2)
        if current == 1 and prev == 0:
            label = "BUY"
        elif current == 0 and prev == 1:
            label = "SELL"
        elif current == 1:
            label = "BUY"
        else:
            label = "HOLD"
        description = f"Price={last_price:.2f}, Upper={upper:.2f}, Lower={lower:.2f}"

    elif req.strategy == "momentum":
        lookback = int(p.get("lookback", 20))
        ret = float(close.pct_change(lookback).iloc[-1]) * 100
        value = round(ret, 2)
        label = "BUY" if current == 1 else "SELL"
        description = f"{lookback}d return={ret:.1f}%"

    elif req.strategy == "macd_crossover":
        fast_p = int(p.get("fast", 12))
        slow_p = int(p.get("slow", 26))
        sig_p  = int(p.get("signal", 9))
        ema_f  = close.ewm(span=fast_p, adjust=False).mean()
        ema_s  = close.ewm(span=slow_p, adjust=False).mean()
        macd_line = ema_f - ema_s
        sig_ln = macd_line.ewm(span=sig_p, adjust=False).mean()
        hist = float((macd_line - sig_ln).iloc[-1])
        value = round(hist, 4)
        label = "BUY" if current == 1 else "SELL"
        description = f"MACD hist={hist:+.3f}, fast={fast_p}, slow={slow_p}, signal={sig_p}"

    elif req.strategy == "value_pe":
        pe_threshold = float(p.get("pe_in_threshold", 35.0))
        tkr_sym = req.ticker.strip().upper()
        try:
            info = get_info(tkr_sym)
            pe = info.get("trailingPE") or info.get("forwardPE") or 0
        except Exception:
            pe = 0
        value = round(float(pe), 2)
        label = "BUY" if current == 1 else "SELL"
        description = f"P/E={pe:.1f}, threshold={pe_threshold:.0f}"

    elif req.strategy == "earnings_momentum":
        tkr_sym = req.ticker.strip().upper()
        try:
            info = get_info(tkr_sym)
            eg = info.get("earningsQuarterlyGrowth") or 0
        except Exception:
            eg = 0
        exit_t = float(p.get("exit_threshold_pct", -5.0)) / 100
        value = round(float(eg) * 100, 2)
        label = "BUY" if current == 1 else "SELL"
        description = f"Quarterly EPS growth={eg*100:.1f}%, exit at {exit_t*100:.0f}%"

    else:
        raise HTTPException(status_code=400, detail=f"Unknown strategy: {req.strategy}")

    return {"signal": label, "value": value, "description": description}
