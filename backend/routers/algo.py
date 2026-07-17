import threading
import numpy as np
import pandas as pd
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field, model_validator
import sys, os
sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))
from cache import get_history, get_info

router = APIRouter()

# combo_monte_carlo's (n_sims, dte+1) path grid can peak at ~150-200MB per
# request at the endpoint's own caps — same failure shape as the yfinance
# BoundedSemaphore(2) in cache.py (added after a real prod OOM on this 1GB
# VM), so a concurrent-request cap applies here too rather than letting
# requests stack unbounded. A ticker basket accumulates into one running
# total instead of holding a (n_sims, dte+1) array per ticker (see
# _combo_monte_carlo_impl), so its peak stays bounded by _BASKET_FETCH_WORKERS
# in-flight arrays regardless of basket size, not by the ticker count.
_COMBO_MC_SEM = threading.BoundedSemaphore(2)
_COMBO_MC_TIMEOUT = float(os.getenv("COMBO_MC_ACQUIRE_TIMEOUT", "10"))
_BASKET_FETCH_WORKERS = 8


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
    daily_rate = (1 + effective_annual_rate / 100.0) ** (1 / bars_per_year) - 1
    interest_cost = borrowed_notional * daily_rate
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


def _compute_metrics(signal: pd.Series, close: pd.Series, position_size: float = 100,
                     initial_capital: float = 10_000, direction: str = "long",
                     bars_per_year: int = 252, intraday: bool = False,
                     exit_kinds: dict | None = None):
    alloc = max(0.0, position_size) / 100.0
    # Intraday keeps the time in each label so bars within a day stay distinct
    # (a date-only label would collapse them and break the curve / portfolio join).
    _dfmt = "%Y-%m-%d %H:%M" if intraday else "%Y-%m-%d"
    sign = -1.0 if direction == "short" else 1.0
    daily_ret = close.pct_change()
    strat_ret = signal.shift(1) * daily_ret * alloc * sign

    # Equity curves — normalized to initial_capital
    equity_raw = (1 + strat_ret.fillna(0)).cumprod() * initial_capital
    benchmark = (1 + daily_ret.fillna(0)).cumprod() * initial_capital
    equity, blown_up_at = _floor_equity(equity_raw)

    # Total return
    total_return = float(equity.iloc[-1] / initial_capital - 1) * 100

    # Annualized return (bars_per_year scales with the backtest timeframe: 252 daily,
    # ~1638 hourly, ~19656 for 5-minute bars, so intraday Sharpe/CAGR stay comparable).
    n_days = len(equity)
    ann_factor = bars_per_year / n_days
    ann_return = _safe_ann_return(float(equity.iloc[-1]), initial_capital, ann_factor)

    # Max drawdown — guard the 0/0 case a same-bar wipeout produces (roll_max
    # is 0 too when equity never traded above zero before freezing).
    roll_max = equity.cummax()
    drawdown = (equity - roll_max) / roll_max.replace(0, np.nan)
    max_drawdown = float(drawdown.min(skipna=True) * 100) if drawdown.notna().any() else -100.0
    if blown_up_at is not None:
        max_drawdown = min(max_drawdown, -100.0)

    # Sharpe (rf=0, annualized)
    sharpe = float(strat_ret.mean() / strat_ret.std() * np.sqrt(bars_per_year)) if strat_ret.std() > 0 else 0.0

    # Trades
    position_changes = signal.diff().fillna(0)
    buy_dates = close.index[position_changes == 1]
    sell_dates = close.index[position_changes == -1]

    trades = []
    for d in buy_dates:
        trades.append({"date": d.strftime(_dfmt), "action": "BUY", "price": round(float(close.loc[d]), 2), "is_entry": True})
    for d in sell_dates:
        trades.append({"date": d.strftime(_dfmt), "action": "SELL", "price": round(float(close.loc[d]), 2), "is_entry": False,
                       "exit_kind": (exit_kinds or {}).get(d)})
    trades.sort(key=lambda x: x["date"])

    num_trades = len(buy_dates)

    # Win rate: pair each buy with the next sell
    wins = 0
    buy_prices = [(d, float(close.loc[d])) for d in buy_dates]
    sell_prices = [(d, float(close.loc[d])) for d in sell_dates]
    j = 0
    for bd, bp in buy_prices:
        while j < len(sell_prices) and sell_prices[j][0] <= bd:
            j += 1
        if j < len(sell_prices):
            if sell_prices[j][1] > bp:
                wins += 1
    win_rate = float(wins / num_trades * 100) if num_trades > 0 else 0.0

    final_capital = float(equity.iloc[-1])
    total_pnl = final_capital - initial_capital

    # Equity curve data
    curve = []
    for date, sv, bv in zip(equity.index, equity.values, benchmark.values):
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
            "blown_up_at": blown_up_at.strftime(_dfmt) if blown_up_at is not None else None,
        },
        "trades": trades,
    }


_OPT_MULT = 100


def _compute_option_metrics(signal: pd.Series, close: pd.Series, opt: dict, iv: float,
                            position_size: float = 100, initial_capital: float = 10_000,
                            direction: str = "long", bars_per_year: int = 252, intraday: bool = False,
                            stop_loss: float | None = None, take_profit: float | None = None,
                            trailing_stop: float | None = None, max_hold_bars: int | None = None):
    """Modeled single-option backtest. On each entry the strategy buys (long) or
    writes (short) a fresh Black-Scholes-priced call/put (strike = moneyness × spot,
    fixed DTE), marks it daily as time decays, and realizes it when the rules exit,
    a risk-control trigger fires, or it reaches its calendar-date expiry (then rolls if still
    signalled). IV is held at the current snapshot value — the project has no
    historical option prices — so this is an APPROXIMATION, labeled as modeled
    in the UI. A short leg mirrors the long leg's dollar P&L (project
    convention). Expiry is cash-settled at intrinsic value, which is economically
    equivalent to exercise/assignment with an immediately flattened share delivery;
    assignment margin and post-expiry shares are not carried. Benchmark stays
    underlying buy & hold.

    stop_loss/take_profit/trailing_stop are evaluated against the OPTION'S OWN
    unrealized P&L (as % of the entry premium paid/collected), not the
    underlying's price move — an option's value doesn't move 1:1 with the
    underlying (theta, vega, and non-ATM strikes all break that), so a
    price-based stop would trigger at the wrong P&L level or not at all.
    max_hold_bars forces an exit after N bars even if DTE/the rules haven't."""
    from math_engine import bs_price
    otype = "put" if str(opt.get("type", "call")).lower().startswith("p") else "call"
    moneyness = float(opt.get("moneyness", 1.0))
    dte = max(1, int(opt.get("dte", 30)))
    short = direction == "short"
    entry_action = "SELL" if short else "BUY"   # short = sell-to-open
    exit_action = "BUY" if short else "SELL"
    r = 4.0
    alloc = max(0.0, position_size) / 100.0
    _dfmt = "%Y-%m-%d %H:%M" if intraday else "%Y-%m-%d"
    idx = close.index
    px = close.to_numpy(dtype=float)
    sig = signal.to_numpy(dtype=float)
    n = len(px)

    equity = np.empty(n)
    cash = float(initial_capital)
    cur = float(initial_capital)
    in_trade = False
    blocked = False   # true after a risk-triggered exit, until the raw signal drops to 0
    signed_contracts = 0.0
    strike = 0.0
    entry_i = -1
    entry_val = 0.0
    entry_mtm = 0.0
    basis = 1.0
    peak_pnl = 0.0
    trades: list[dict] = []
    wiped_out = False
    blown_up_at = None

    def _val(i: int) -> float:
        remaining_days = max(0, (expiry_at - idx[i]).total_seconds() / 86_400) if entry_i >= 0 else dte
        return float(bs_price(px[i], strike, remaining_days, r, iv, otype))

    def _settlement(i: int) -> str:
        intrinsic = max(px[i] - strike, 0.0) if otype == "call" else max(strike - px[i], 0.0)
        if intrinsic <= 0:
            return "expired_worthless"
        return "assignment" if short else "exercise"

    expiry_at = None

    for i in range(n):
        if wiped_out:
            equity[i] = 0.0
            continue
        exit_kind = None
        expires_now = in_trade and expiry_at is not None and idx[i] >= expiry_at
        if in_trade:
            pnl = signed_contracts * _val(i) * _OPT_MULT - entry_mtm
            peak_pnl = max(peak_pnl, pnl)
            if not expires_now and stop_loss is not None and pnl <= -(stop_loss / 100.0) * basis:
                exit_kind = "stop_loss"
            if not expires_now and exit_kind is None and take_profit is not None and pnl >= (take_profit / 100.0) * basis:
                exit_kind = "take_profit"
            if not expires_now and exit_kind is None and trailing_stop is not None and pnl <= peak_pnl - (trailing_stop / 100.0) * basis:
                exit_kind = "trailing_stop"
            if not expires_now and exit_kind is None and max_hold_bars is not None and (i - entry_i) >= max_hold_bars:
                exit_kind = "max_hold"
        risk_triggered = exit_kind is not None
        if expires_now:
            exit_kind = "expiration"
        exiting = in_trade and (sig[i] == 0.0 or exit_kind is not None)
        if exiting:
            v = _val(i)
            cash += signed_contracts * v * _OPT_MULT
            trades.append({"date": idx[i].strftime(_dfmt), "action": "EXPIRE" if exit_kind == "expiration" else exit_action, "price": round(v, 2), "is_entry": False,
                           "exit_kind": exit_kind or "rule", **({"settlement": _settlement(i)} if exit_kind == "expiration" else {})})
            in_trade, signed_contracts = False, 0.0
            blocked = risk_triggered
        if blocked and sig[i] == 0.0:
            blocked = False
        if not in_trade and not blocked and sig[i] == 1.0:
            strike = round(px[i] * moneyness, 2)
            entry_val = max(float(bs_price(px[i], strike, dte, r, iv, otype)), 0.01)
            invest = cash * alloc
            contracts = invest / (entry_val * _OPT_MULT)
            signed_contracts = -contracts if short else contracts
            cash -= signed_contracts * entry_val * _OPT_MULT
            entry_i, expiry_at, in_trade = i, idx[i] + pd.Timedelta(days=dte), True
            entry_mtm = signed_contracts * entry_val * _OPT_MULT
            basis = abs(entry_mtm) or 1.0
            peak_pnl = 0.0
            trades.append({"date": idx[i].strftime(_dfmt), "action": entry_action, "price": round(entry_val, 2), "is_entry": True})
        cur = cash + (signed_contracts * _val(i) * _OPT_MULT if in_trade else 0.0)
        if cur <= 0:
            # Record the OPTION's own value at liquidation, not the
            # underlying's spot price — the win/loss classification below
            # compares this "price" against the entry premium, and comparing
            # an underlying price (e.g. $180) against a premium (e.g. $3.50)
            # would classify almost every wipeout as a win.
            liq_val = _val(i) if in_trade else 0.0
            wiped_out, blown_up_at, cur = True, idx[i], 0.0
            cash, in_trade, signed_contracts = 0.0, False, 0.0
            trades.append({"date": idx[i].strftime(_dfmt), "action": "LIQUIDATED", "price": round(liq_val, 2),
                           "is_entry": False, "exit_kind": "wipeout"})
        equity[i] = cur

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

    entries = [t for t in trades if t["is_entry"]]
    exits = [t for t in trades if not t["is_entry"]]
    # A short leg profits when it buys the option back cheaper than it sold it.
    wins = sum(1 for e, x in zip(entries, exits)
               if (x["price"] < e["price"] if short else x["price"] > e["price"]))
    num_trades = len(entries)
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
            "blown_up_at": blown_up_at.strftime(_dfmt) if blown_up_at is not None else None,
        },
        "trades": trades,
        "instrument": {"kind": "option", "type": otype, "moneyness": moneyness, "dte": dte, "iv": round(iv, 1), "direction": direction, "modeled": True},
    }


def _compute_combo_metrics(signal: pd.Series, close: pd.Series, combo: dict, iv: float,
                           position_size: float = 100, initial_capital: float = 10_000,
                           bars_per_year: int = 252, intraday: bool = False,
                           stop_loss: float | None = None, take_profit: float | None = None,
                           trailing_stop: float | None = None, max_hold_bars: int | None = None):
    """Modeled multi-leg option combo backtest (straddle/strangle/spread/condor/
    butterfly/etc — same leg shape as the Options Strategy Builder's PRESETS
    table: {type, side, moneyness, qty}). On each entry every leg opens
    simultaneously (strike = moneyness × spot, one shared DTE), the combo's net
    signed value is marked daily as time decays, and every leg closes together
    on rule-exit, a risk-control trigger, or shared expiry (rolling a fresh set
    of legs if the signal is still active). IV is held at the current snapshot
    value for every leg — the project has no historical option prices — so
    this is an APPROXIMATION, labeled as modeled in the UI, same convention as
    the single-leg version.

    Unlike the single-leg function's whole-curve "mirror around 2×capital"
    trick (which only works when every leg is on the same side), each leg here
    carries its own signed quantity (+qty long, -qty short) and the account
    value is cash + Σ(signed_qty × leg value) — this handles any mix of long
    and short legs (iron condors, jade lizards, ratio spreads, ...) correctly
    without a post-hoc sign flip. A naked short leg's risk isn't capped like a
    single covered position, so the account is force-liquidated and frozen at
    zero the first bar it goes non-positive — it doesn't keep trading on
    borrowed/negative cash.

    position_size(%) scales the whole structure to alloc% of current capital
    via NOTIONAL (Σqty×spot×MULT), not premium — premium-based sizing blows up
    for cheap far-OTM legs (a strangle's wings can be a tiny fraction of a
    straddle's ATM premium, forcing an enormous contract count to hit the same
    %-of-capital target, i.e. hidden leverage with no cap). Notional sizing
    stays bounded regardless of how cheap the legs are, and still preserves
    the preset's relative leg ratios (e.g. 1:2:1 for a butterfly).

    stop_loss/take_profit/trailing_stop are evaluated against the COMBO'S OWN
    unrealized P&L (as % of the entry credit/debit magnitude — the standard
    "close at 50% of max profit" convention, same basis combo_monte_carlo's
    early-exit uses), not the underlying's price move — a short strangle can
    lose or gain heavily from IV/theta with the stock barely moving, so a
    price-based stop (correct for plain shares) would rarely fire here at all.
    max_hold_bars forces an exit after N bars even if DTE/the rules haven't."""
    from math_engine import bs_price
    legs_cfg = combo.get("legs") or []
    if not legs_cfg:
        raise HTTPException(422, "Combo instrument needs at least one leg")
    dte = max(1, int(combo.get("dte", 30)))
    r = 4.0
    alloc = max(0.0, position_size) / 100.0
    _dfmt = "%Y-%m-%d %H:%M" if intraday else "%Y-%m-%d"
    idx = close.index
    px = close.to_numpy(dtype=float)
    sig = signal.to_numpy(dtype=float)
    n = len(px)

    equity = np.empty(n)
    cash = float(initial_capital)
    cur = float(initial_capital)
    in_trade = False
    blocked = False   # true after a risk-triggered exit, until the raw signal drops to 0
    entry_i = -1
    entry_mtm = 0.0
    peak_pnl = 0.0
    basis = 1.0
    leg_state: list[dict] = []   # [{type, strike, signed_qty}]
    trades: list[dict] = []
    expiry_at = None
    wiped_out = False
    blown_up_at = None

    def _leg_val(leg: dict, i: int) -> float:
        remaining_days = max(0, (expiry_at - idx[i]).total_seconds() / 86_400) if entry_i >= 0 else dte
        return float(bs_price(px[i], leg["strike"], remaining_days, r, iv, leg["type"]))

    def _combo_mtm(i: int) -> float:
        return sum(l["signed_qty"] * _leg_val(l, i) * _OPT_MULT for l in leg_state)

    def _settlement(leg: dict, i: int) -> str:
        intrinsic = max(px[i] - leg["strike"], 0.0) if leg["type"] == "call" else max(leg["strike"] - px[i], 0.0)
        if intrinsic <= 0:
            return "expired_worthless"
        return "exercise" if leg["signed_qty"] > 0 else "assignment"

    for i in range(n):
        if wiped_out:
            equity[i] = 0.0
            continue
        exit_kind = None
        expires_now = in_trade and expiry_at is not None and idx[i] >= expiry_at
        if in_trade:
            pnl = _combo_mtm(i) - entry_mtm
            peak_pnl = max(peak_pnl, pnl)
            if not expires_now and stop_loss is not None and pnl <= -(stop_loss / 100.0) * basis:
                exit_kind = "stop_loss"
            if not expires_now and exit_kind is None and take_profit is not None and pnl >= (take_profit / 100.0) * basis:
                exit_kind = "take_profit"
            if not expires_now and exit_kind is None and trailing_stop is not None and pnl <= peak_pnl - (trailing_stop / 100.0) * basis:
                exit_kind = "trailing_stop"
            if not expires_now and exit_kind is None and max_hold_bars is not None and (i - entry_i) >= max_hold_bars:
                exit_kind = "max_hold"
        risk_triggered = exit_kind is not None
        if expires_now:
            exit_kind = "expiration"
        exiting = in_trade and (sig[i] == 0.0 or exit_kind is not None)
        if exiting:
            cash += _combo_mtm(i)
            for l in leg_state:
                trades.append({
                    "date": idx[i].strftime(_dfmt),
                    "action": "EXPIRE" if exit_kind == "expiration" else "SELL" if l["signed_qty"] > 0 else "BUY",
                    "price": round(_leg_val(l, i), 2),
                    "leg": f"{l['type']} {l['strike']:g}",
                    "is_entry": False,
                    "exit_kind": exit_kind or "rule",
                    **({"settlement": _settlement(l, i)} if exit_kind == "expiration" else {}),
                })
            in_trade, leg_state = False, []
            # Only a risk-forced exit blocks re-entry (until the rule itself says
            # exit) — a rule-driven exit (sig[i]==0) already can't re-enter this
            # same bar since the "not in_trade and sig[i]==1" check below needs
            # sig[i]==1, which isn't the case here.
            blocked = risk_triggered
        if blocked and sig[i] == 0.0:
            blocked = False
        if not in_trade and not blocked and sig[i] == 1.0:
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
            leg_state = []
            for l in unscaled:
                signed_qty = l["signed_qty"] * scale
                leg_state.append({"type": l["type"], "strike": l["strike"], "signed_qty": signed_qty})
                trades.append({
                    "date": idx[i].strftime(_dfmt),
                    "action": "BUY" if signed_qty > 0 else "SELL",
                    "price": round(l["entry_val"], 2),
                    "leg": f"{l['type']} {l['strike']:g}",
                    "is_entry": True,
                })
            cash -= sum(l["signed_qty"] * bs_price(px[i], l["strike"], dte, r, iv, l["type"]) * _OPT_MULT for l in leg_state)
            entry_i, expiry_at, in_trade = i, idx[i] + pd.Timedelta(days=dte), True
            entry_mtm = _combo_mtm(i)
            basis = abs(entry_mtm) or 1.0
            peak_pnl = 0.0
        cur = cash + (_combo_mtm(i) if in_trade else 0.0)
        if cur <= 0:
            wiped_out, blown_up_at = True, idx[i]
            # One row per leg, using each leg's own mark value — not a single
            # summary row at the underlying's spot price. The round-trip
            # win-rate pairing below walks `trades` in fixed n_legs-sized
            # batches; a single row (regardless of leg count) breaks that
            # assumption, and spot price isn't comparable to a leg's entry
            # premium anyway (same fix as the single-option engine's wipeout).
            if in_trade:
                for l in leg_state:
                    trades.append({
                        "date": idx[i].strftime(_dfmt),
                        "action": "SELL" if l["signed_qty"] > 0 else "BUY",
                        "price": round(_leg_val(l, i), 2),
                        "leg": f"{l['type']} {l['strike']:g}",
                        "is_entry": False,
                        "exit_kind": "wipeout",
                    })
            cash, in_trade, leg_state, cur = 0.0, False, [], 0.0
        equity[i] = cur

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

    # Round-trip win rate: pair each entry batch with its exit batch (same leg count
    # per side) and compare total premium in vs out, since individual leg wins/losses
    # can offset within one combo.
    num_trades = 0
    wins = 0
    i2 = 0
    n_legs = len(legs_cfg)
    while i2 + 2 * n_legs <= len(trades):
        entry_batch = trades[i2:i2 + n_legs]
        exit_batch = trades[i2 + n_legs:i2 + 2 * n_legs]
        if len(exit_batch) == n_legs:
            entry_flow = sum((-1 if t["action"] == "BUY" else 1) * t["price"] for t in entry_batch)
            exit_flow = sum((1 if t["action"] == "SELL" else -1) * t["price"] for t in exit_batch)
            num_trades += 1
            if entry_flow + exit_flow > 0:
                wins += 1
        i2 += 2 * n_legs
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
            "blown_up_at": blown_up_at.strftime(_dfmt) if blown_up_at is not None else None,
        },
        "trades": trades,
        "instrument": {"kind": "combo", "legs": legs_cfg, "dte": dte, "iv": round(iv, 1), "modeled": True},
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
    # Sizing — notional-based, same convention as _compute_combo_metrics: leg
    # qty ratios from `combo.legs` are preserved, absolute size is normalized
    # to position_size% of initial_capital times leverage. Replaces the older
    # literal-qty-is-the-answer behavior so this tool sizes the same way the
    # Algo Strategy Builder's own combo backtest does (a raw contract count is
    # otherwise meaningless without an account size to relate it to).
    initial_capital: float = 10_000
    position_size: float = 100        # % of capital committed to this structure
    leverage: float = 1               # gross-notional multiplier, 1x = unlevered
    effective_annual_rate: float = 0  # EAR on notional borrowed beyond capital

    @model_validator(mode="after")
    def _validate_sizing(self):
        if self.leverage < 1:
            raise ValueError("Leverage must be at least 1x")
        if not 0 <= self.effective_annual_rate <= 100:
            raise ValueError("Effective annual rate must be between 0% and 100%")
        if not 0 < self.position_size <= 100:
            raise ValueError("Position size must be between 0% and 100% of capital")
        if self.tickers is not None and len(self.tickers) > 100:
            raise ValueError("Basket is limited to 100 tickers — each one needs its own live spot/IV fetch and simulation")
        return self


def _bs_vec(S: "np.ndarray", K: float, T: "np.ndarray", rf: float, sigma: float, otype: str) -> "np.ndarray":
    """Vectorized Black-Scholes over an (n_sims, n_days) price grid — math_engine's
    bs_core/bs_price are scalar-only (their T<=0 branch uses Python's max(), which
    can't handle an array truth value), so a small array-safe version lives here
    for the path simulation below."""
    from scipy.stats import norm
    T_safe = np.maximum(T, 1e-8)
    d1 = (np.log(S / K) + (rf + 0.5 * sigma ** 2) * T_safe) / (sigma * np.sqrt(T_safe))
    d2 = d1 - sigma * np.sqrt(T_safe)
    if otype == "call":
        val = S * norm.cdf(d1) - K * np.exp(-rf * T_safe) * norm.cdf(d2)
        intrinsic = np.maximum(S - K, 0.0)
    else:
        val = K * np.exp(-rf * T_safe) * norm.cdf(-d2) - S * norm.cdf(-d1)
        intrinsic = np.maximum(K - S, 0.0)
    return np.where(T <= 1e-8, intrinsic, val)


@router.post("/combo-montecarlo")
def combo_monte_carlo(req: ComboMonteCarloRequest):
    if not _COMBO_MC_SEM.acquire(timeout=_COMBO_MC_TIMEOUT):
        raise HTTPException(503, "Too many simulations running — try again shortly")
    try:
        return _combo_monte_carlo_impl(req)
    finally:
        _COMBO_MC_SEM.release()


def _price_ticker_leg(ticker: str, legs_cfg: list, dte: int, r: float, committed_dollars: float,
                      n: int, dt: float, rng) -> dict:
    """Fetch one ticker's own live spot/IV and simulate its dollar
    contribution to the combo — legs are moneyness-based, so strikes derive
    from THIS ticker's own spot, and its notional is scaled to
    committed_dollars independent of every other ticker in a basket."""
    from routers.options import options_snapshot
    from math_engine import bs_price
    snap = options_snapshot(ticker)
    spot, iv = snap.get("spot"), snap.get("atm_iv")
    if not spot or not isinstance(iv, (int, float)) or iv <= 0:
        raise HTTPException(422, f"No live spot/IV available for {ticker}")

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
    shocks = (rf - 0.5 * sigma ** 2) * dt + sigma * np.sqrt(dt) * rng.standard_normal((n, dte))
    log_paths = np.cumsum(shocks, axis=1)
    price_paths = np.hstack([np.full((n, 1), spot), spot * np.exp(log_paths)])   # (n, dte+1), day 0..dte
    days = np.arange(dte + 1)
    t_rem = (dte - days) / 365.0   # (dte+1,) remaining years per column, broadcasts over price_paths
    mtm = np.zeros((n, dte + 1))
    for leg in resolved:
        leg_val = _bs_vec(price_paths, leg["strike"], t_rem, rf, sigma, leg["type"])
        mtm += leg["signed_qty"] * leg_val * _OPT_MULT
    pnl_path = entry_cash_flow + mtm   # (n, dte+1) unrealized $ P&L at each day, each path

    return {"spot": spot, "iv": iv, "resolved": resolved, "entry_cash_flow": entry_cash_flow, "pnl_path": pnl_path}


def _combo_monte_carlo_impl(req: ComboMonteCarloRequest):
    """P&L distribution for a multi-leg options combo (same PRESETS shape as
    the Options Strategy Builder / Algo Strategy Builder combo instrument),
    from a current live spot/IV — not tied to any entry rule.

    The underlying is simulated as a full DAILY price path to DTE via
    risk-neutral GBM (drift = r, the same rate used to price the legs) rather
    than empirical historical drift: this is the standard convention for a
    probability-of-profit calculator — it answers "given how the market is
    pricing this vol, what's the outcome distribution", not "assuming the
    stock keeps doing what it's done". Every leg is marked to market via
    Black-Scholes at EVERY day along the path (not just at expiry), so an
    optional take-profit/stop-loss/max-hold exits the position the first day
    it's triggered — a short-premium strategy managed at "close at 50% of
    max profit" behaves very differently from one held to expiry, and this
    is the whole reason the path (not just the terminal price) matters here.

    req.tickers (plural) applies the SAME leg structure to every ticker —
    each with its own live spot/IV and its own independent GBM draw — equal-
    weighted and summed into one basket P&L distribution. This is how a
    universe strategy imported from the Algo Strategy Builder (one shared
    combo across many symbols) is represented here, since a single-ticker
    payoff curve has no meaning once there's more than one underlying."""
    legs_cfg = req.combo.get("legs") or []
    if not legs_cfg:
        raise HTTPException(422, "Combo needs at least one leg")
    dte = max(1, int(req.combo.get("dte", 30)))
    r = 4.0
    dt = (dte / 365.0) / dte

    tickers = [t.strip().upper() for t in req.tickers if t and t.strip()] if req.tickers else [req.ticker.strip().upper()]
    if not tickers:
        raise HTTPException(422, "Need at least one ticker")
    is_basket = len(tickers) > 1

    # Notional sizing: preserve each leg's qty RATIO from the preset (e.g. a
    # butterfly's 1:2:1), scale absolute size to position_size% of capital
    # times leverage — same convention _compute_combo_metrics uses, so a
    # structure imported from the Algo Strategy Builder sizes identically here.
    # A basket splits that total notional equally across every ticker.
    alloc = (req.position_size / 100.0) * req.leverage
    committed_notional = req.initial_capital * alloc
    borrowed_notional = max(0.0, committed_notional - req.initial_capital)
    per_ticker_dollars = committed_notional / len(tickers)

    # Early exit needs a full (n_sims, dte+1) grid marked at every day, not just
    # a terminal draw — meaningfully heavier, so cap sims lower than the
    # expiry-only version did.
    n = min(max(int(req.n_sims), 100), 5000)

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
        with concurrent.futures.ThreadPoolExecutor(max_workers=min(_BASKET_FETCH_WORKERS, len(tickers))) as pool:
            futures = [
                pool.submit(_price_ticker_leg, tk, legs_cfg, dte, r, per_ticker_dollars, n, dt, np.random.default_rng(seed))
                for tk, seed in zip(tickers, child_seeds)
            ]
            for fut in concurrent.futures.as_completed(futures):
                res = fut.result()
                entry_cash_flow += res["entry_cash_flow"]
                pnl_path += res["pnl_path"]
        per_ticker_single = None
    else:
        rng = np.random.default_rng()
        res = _price_ticker_leg(tickers[0], legs_cfg, dte, r, per_ticker_dollars, n, dt, rng)
        entry_cash_flow = res["entry_cash_flow"]
        pnl_path = res["pnl_path"]
        per_ticker_single = res

    # Financing at full term (the deterministic "held to expiry" reference below)
    # — folded into payoff() itself so breakevens/max-profit/max-loss all widen
    # correctly to account for the borrowing cost, same as a real levered account.
    financing_at_expiry = borrowed_notional * ((1 + req.effective_annual_rate / 100.0) ** (dte / 365.0) - 1)

    if is_basket:
        # No single price axis applies once there's more than one underlying —
        # skip the deterministic curve/breakevens/max-profit/max-loss; the
        # simulated distribution (percentiles/histogram) below still fully
        # represents the basket's outcome.
        curve: list[dict] = []
        breakevens: list[float] = []
        max_profit_expiry = None
        max_loss_expiry = None
    else:
        resolved, spot = per_ticker_single["resolved"], per_ticker_single["spot"]

        def payoff(price: float) -> float:
            val = sum(
                l["signed_qty"] * (max(price - l["strike"], 0.0) if l["type"] == "call" else max(l["strike"] - price, 0.0)) * _OPT_MULT
                for l in resolved
            )
            return max(entry_cash_flow + val - financing_at_expiry, -req.initial_capital)

        # Deterministic payoff curve for charting, 50%-150% of spot — this is the
        # "if held to expiry" reference; the simulated distribution below reflects
        # early-exit rules when they're set, so the two can legitimately diverge.
        lo, hi = spot * 0.5, spot * 1.5
        curve = [{"price": round(lo + (hi - lo) * i / 100, 2)} for i in range(101)]
        for pt in curve:
            pt["pnl"] = round(payoff(pt["price"]), 2)

        # Breakevens: bisect every sign change in the sampled curve.
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
        # bounds both sides in the simulated distribution below.)
        slope_up = sum(l["signed_qty"] * _OPT_MULT for l in resolved if l["type"] == "call")
        floor_pnl = payoff(0.0)
        sampled_pnls = [pt["pnl"] for pt in curve] + [floor_pnl]
        max_profit_expiry = None if slope_up > 1e-6 else round(max(sampled_pnls), 2)
        max_loss_expiry = None if slope_up < -1e-6 else round(min(sampled_pnls), 2)

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
    financing = borrowed_notional * (np.power(1 + req.effective_annual_rate / 100.0, exit_day / 365.0) - 1)
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

    return {
        "ticker": tickers[0] if not is_basket else None,
        "tickers": tickers if is_basket else None,
        "is_basket": is_basket,
        "spot": round(per_ticker_single["spot"], 2) if not is_basket else None,
        "iv": round(per_ticker_single["iv"], 1) if not is_basket else None,
        "dte": dte,
        "entry_credit_debit": round(entry_cash_flow, 2),
        "breakevens": breakevens,
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
    result = _compute_metrics(signal, close, req.position_size, req.initial_capital)
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
