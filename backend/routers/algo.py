import numpy as np
import pandas as pd
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
import sys, os
sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))
from cache import get_history, get_info

router = APIRouter()


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
) -> pd.Series:
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
            exited = False
            if stop_loss is not None and price <= entry_price * (1 - stop_loss / 100):
                exited = True
            if not exited and take_profit is not None and price >= entry_price * (1 + take_profit / 100):
                exited = True
            if not exited and trailing_stop is not None and price <= peak_price * (1 - trailing_stop / 100):
                exited = True
            if not exited and max_hold_bars is not None and bars_held >= max_hold_bars:
                exited = True
            if exited:
                result.iloc[i] = 0.0
                in_trade = False
                blocked = True
                bars_held = 0
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


def _compute_metrics(signal: pd.Series, close: pd.Series, position_size: float = 100,
                     initial_capital: float = 10_000, direction: str = "long",
                     bars_per_year: int = 252, intraday: bool = False):
    alloc = max(0.0, min(100.0, position_size)) / 100.0
    # Intraday keeps the time in each label so bars within a day stay distinct
    # (a date-only label would collapse them and break the curve / portfolio join).
    _dfmt = "%Y-%m-%d %H:%M" if intraday else "%Y-%m-%d"
    sign = -1.0 if direction == "short" else 1.0
    daily_ret = close.pct_change()
    strat_ret = signal.shift(1) * daily_ret * alloc * sign

    # Equity curves — normalized to initial_capital
    equity = (1 + strat_ret.fillna(0)).cumprod() * initial_capital
    benchmark = (1 + daily_ret.fillna(0)).cumprod() * initial_capital

    # Total return
    total_return = float(equity.iloc[-1] / initial_capital - 1) * 100

    # Annualized return (bars_per_year scales with the backtest timeframe: 252 daily,
    # ~1638 hourly, ~19656 for 5-minute bars, so intraday Sharpe/CAGR stay comparable).
    n_days = len(equity)
    ann_factor = bars_per_year / n_days
    ann_return = float(((equity.iloc[-1] / initial_capital) ** ann_factor - 1) * 100)

    # Max drawdown
    roll_max = equity.cummax()
    drawdown = (equity - roll_max) / roll_max
    max_drawdown = float(drawdown.min() * 100)

    # Sharpe (rf=0, annualized)
    sharpe = float(strat_ret.mean() / strat_ret.std() * np.sqrt(bars_per_year)) if strat_ret.std() > 0 else 0.0

    # Trades
    position_changes = signal.diff().fillna(0)
    buy_dates = close.index[position_changes == 1]
    sell_dates = close.index[position_changes == -1]

    trades = []
    for d in buy_dates:
        trades.append({"date": d.strftime(_dfmt), "action": "BUY", "price": round(float(close.loc[d]), 2)})
    for d in sell_dates:
        trades.append({"date": d.strftime(_dfmt), "action": "SELL", "price": round(float(close.loc[d]), 2)})
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
        },
        "trades": trades,
    }


_OPT_MULT = 100


def _compute_option_metrics(signal: pd.Series, close: pd.Series, opt: dict, iv: float,
                            position_size: float = 100, initial_capital: float = 10_000,
                            direction: str = "long", bars_per_year: int = 252, intraday: bool = False):
    """Modeled single-option backtest. On each entry the strategy buys (long) or
    writes (short) a fresh Black-Scholes-priced call/put (strike = moneyness × spot,
    fixed DTE), marks it daily as time decays, and realizes it when the rules exit
    or it reaches expiry (then rolls if still signalled). IV is held at the current
    snapshot value — the project has no historical option prices — so this is an
    APPROXIMATION, labeled as modeled in the UI. A short leg mirrors the long leg's
    dollar P&L (project convention; assignment risk is not modeled) and is floored
    at a total loss of its capital. Benchmark stays underlying buy & hold."""
    from math_engine import bs_price
    otype = "put" if str(opt.get("type", "call")).lower().startswith("p") else "call"
    moneyness = float(opt.get("moneyness", 1.0))
    dte = max(1, int(opt.get("dte", 30)))
    short = direction == "short"
    entry_action = "SELL" if short else "BUY"   # short = sell-to-open
    exit_action = "BUY" if short else "SELL"
    r = 4.0
    alloc = max(0.0, min(100.0, position_size)) / 100.0
    _dfmt = "%Y-%m-%d %H:%M" if intraday else "%Y-%m-%d"
    idx = close.index
    px = close.to_numpy(dtype=float)
    sig = signal.to_numpy(dtype=float)
    n = len(px)

    equity = np.empty(n)
    cash = float(initial_capital)
    cur = float(initial_capital)
    in_trade = False
    contracts = 0.0
    strike = 0.0
    entry_i = -1
    trades: list[dict] = []

    def _val(i: int) -> float:
        return float(bs_price(px[i], strike, dte - (i - entry_i), r, iv, otype))

    for i in range(n):
        exiting = in_trade and (sig[i] == 0.0 or (i - entry_i) >= dte)
        if exiting:
            v = _val(i)
            cash += contracts * v * _OPT_MULT
            trades.append({"date": idx[i].strftime(_dfmt), "action": exit_action, "price": round(v, 2)})
            in_trade, contracts = False, 0.0
        if not in_trade and sig[i] == 1.0:
            strike = round(px[i] * moneyness, 2)
            entry_val = max(float(bs_price(px[i], strike, dte, r, iv, otype)), 0.01)
            invest = cur * alloc
            contracts = invest / (entry_val * _OPT_MULT)
            cash = cur - contracts * entry_val * _OPT_MULT
            entry_i, in_trade = i, True
            trades.append({"date": idx[i].strftime(_dfmt), "action": entry_action, "price": round(entry_val, 2)})
        cur = cash + (contracts * _val(i) * _OPT_MULT if in_trade else 0.0)
        equity[i] = cur

    eq = pd.Series(equity, index=idx)
    if short:
        # Short leg: dollar P&L is the negative of the long leg's, floored at a
        # full loss of capital. Modeled/approximate — not a true written-premium
        # backtest (no margin, no assignment).
        eq = (2 * initial_capital - eq).clip(lower=0.0)
    daily = eq.pct_change()
    benchmark = (1 + close.pct_change().fillna(0)).cumprod() * initial_capital
    total_return = float(eq.iloc[-1] / initial_capital - 1) * 100
    ann_return = float(((eq.iloc[-1] / initial_capital) ** (bars_per_year / max(1, n)) - 1) * 100)
    drawdown = (eq - eq.cummax()) / eq.cummax()
    sharpe = float(daily.mean() / daily.std() * np.sqrt(bars_per_year)) if daily.std() > 0 else 0.0

    entries = [t for t in trades if t["action"] == entry_action]
    exits = [t for t in trades if t["action"] == exit_action]
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
            "max_drawdown": round(float(drawdown.min() * 100), 2), "sharpe": round(sharpe, 3),
            "num_trades": num_trades, "win_rate": round(win_rate, 1),
            "initial_capital": round(initial_capital, 2), "final_capital": round(float(eq.iloc[-1]), 2),
            "total_pnl": round(float(eq.iloc[-1]) - initial_capital, 2),
        },
        "trades": trades[:200],
        "instrument": {"kind": "option", "type": otype, "moneyness": moneyness, "dte": dte, "iv": round(iv, 1), "direction": direction, "modeled": True},
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
