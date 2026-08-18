"""Turn a parsed brokerage ledger into an equity curve and its statistics.

The ledger says what was bought and sold; it does not say what the account was
worth on any given day. That has to be reconstructed: carry the share count
forward per symbol, mark it against daily closes, carry cash forward from every
signed amount, and add the two.

Returns are TIME-WEIGHTED. A deposit is not a gain, and money-weighted return
rewards a manager for the timing of their client's contributions rather than
for their own decisions. On any day carrying an external flow the return is
measured as (V_t − F_t) / V_(t−1) − 1, which removes the flow from the numerator
and leaves only what the positions did.

Two things this genuinely cannot do, both disclosed in the output rather than
smoothed over:

  Options have no free historical price series, so a contract is carried at
  realised cash only. Its mark between open and close is missing from the curve.

  A ledger that opens with a transfer of existing shares has no cost basis for
  them. They enter at the transferred value, so performance is measured from
  arrival, not from whenever they were bought.
"""
from __future__ import annotations

import logging
from datetime import date, timedelta

import numpy as np
import pandas as pd

from brokerage_import import Txn

logger = logging.getLogger(__name__)

_TRADING_DAYS = 252


def _price_frame(symbols: list[str], start: date, end: date) -> pd.DataFrame:
    """Daily closes for every symbol, forward-filled onto one calendar."""
    import cache

    series: dict[str, pd.Series] = {}
    for sym in symbols:
        try:
            hist = cache.get_history(sym, start=str(start - timedelta(days=7)), end=str(end + timedelta(days=1)))
        except Exception as e:                      # noqa: BLE001 — one bad symbol must not sink the run
            logger.warning("trade analytics: no history for %s (%s)", sym, e)
            continue
        if hist is None or hist.empty or "Close" not in hist:
            continue
        close = hist["Close"].copy()
        close.index = pd.to_datetime(close.index).tz_localize(None).normalize()
        series[sym] = close[~close.index.duplicated(keep="last")]
    if not series:
        return pd.DataFrame()
    frame = pd.DataFrame(series).sort_index()
    calendar = pd.date_range(start=pd.Timestamp(start), end=pd.Timestamp(end), freq="D")
    return frame.reindex(frame.index.union(calendar)).ffill().reindex(calendar).ffill()


def _is_security_transfer(t: Txn) -> bool:
    """A transfer of shares rather than of cash.

    An ACAT receive carries a quantity AND a dollar amount, and that amount is
    what the shares were worth, not money arriving. Adding both would count the
    position twice.
    """
    return t.kind in ("deposit", "withdrawal") and bool(t.symbol) and t.quantity > 0


def build_curve(txns: list[Txn], benchmark: str = "SPY") -> dict:
    """Daily equity, external flows, and the marked positions behind them."""
    dated = sorted((t for t in txns if t.date), key=lambda t: t.date)
    if not dated:
        return {"error": "no dated transactions"}

    start, end = dated[0].date, max(dated[-1].date, date.today())
    equities = sorted({t.symbol for t in dated if t.symbol and not t.is_option})
    prices = _price_frame(equities + [benchmark], start, end)
    if prices.empty:
        return {"error": "no price history available for these symbols"}
    calendar = prices.index

    shares = pd.DataFrame(0.0, index=calendar, columns=equities)
    cash = pd.Series(0.0, index=calendar)
    flows = pd.Series(0.0, index=calendar)
    option_pnl = pd.Series(0.0, index=calendar)

    for t in dated:
        day = pd.Timestamp(t.date)
        if day not in shares.index:
            day = calendar[calendar.searchsorted(day)] if day <= calendar[-1] else calendar[-1]
        signed = t.quantity if t.kind == "buy" else -t.quantity

        if _is_security_transfer(t):
            # Shares arrive; no cash moves. The value is an external contribution.
            if t.symbol in shares.columns:
                shares.loc[day:, t.symbol] += t.quantity if t.kind == "deposit" else -t.quantity
            flows.loc[day] += t.amount
            continue

        if t.kind in ("deposit", "withdrawal"):
            cash.loc[day:] += t.amount
            flows.loc[day] += t.amount
            continue

        if t.is_option:
            # No historical series for a contract: realised cash only.
            cash.loc[day:] += t.amount
            option_pnl.loc[day] += t.amount
            continue

        if t.kind in ("buy", "sell") and t.symbol in shares.columns:
            shares.loc[day:, t.symbol] += signed
        cash.loc[day:] += t.amount          # dividends, interest and fees land here too

    held = prices[equities] if equities else pd.DataFrame(index=calendar)
    holdings = (shares * held).sum(axis=1) if equities else pd.Series(0.0, index=calendar)
    equity = holdings + cash

    return {
        "equity": equity, "holdings": holdings, "cash": cash, "flows": flows,
        "shares": shares, "prices": prices, "benchmark": benchmark,
        "option_realised": float(option_pnl.sum()),
        "symbols": equities,
    }


def funding_floor(equity: pd.Series) -> float:
    """Below this the account is not yet funded and a return is meaningless.

    A ledger often opens with dust: a few tenths of a cent of stock-lending
    income days before the first real deposit. Dividing by $0.0055 turned a
    $239 gain into a reported 261,622%. One percent of the account's own
    typical size scales with the account instead of hard-coding a number that
    is wrong for a $2k book or a $2m one.
    """
    positive = equity[equity > 0]
    if positive.empty:
        return 0.0
    return max(1.0, float(positive.median()) * 0.01)


def _twr(equity: pd.Series, flows: pd.Series) -> pd.Series:
    """Daily time-weighted returns, with external flows removed.

    Measurement starts at the first funded day, not the first row, and any day
    whose previous value is still below the floor is dropped rather than
    allowed to divide by dust.
    """
    floor = funding_floor(equity)
    funded = equity[equity >= floor]
    if funded.empty:
        return pd.Series(dtype=float)
    equity = equity.loc[funded.index[0]:]
    flows = flows.loc[funded.index[0]:]
    prev = equity.shift(1)
    ret = (equity - flows) / prev - 1.0
    return ret.replace([np.inf, -np.inf], np.nan).where(prev >= floor).dropna()


def analyze(txns: list[Txn], benchmark: str = "SPY", rf: float = 0.04) -> dict:
    """Full statistics for a trade history. Returns a JSON-ready dict."""
    built = build_curve(txns, benchmark)
    if "error" in built:
        return built

    equity: pd.Series = built["equity"]
    flows: pd.Series = built["flows"]
    ret = _twr(equity, flows)
    if len(ret) < 3:
        return {"error": "not enough dated history to measure performance"}

    bench_close = built["prices"][benchmark]
    bench_ret = bench_close.pct_change().replace([np.inf, -np.inf], np.nan).dropna()

    wealth = (1.0 + ret).cumprod()
    # Everything is measured from the first funded day, so the elapsed period
    # matches the returns rather than counting the unfunded run-in.
    measured_from = ret.index[0]
    days = max((equity.index[-1] - measured_from).days, 1)
    years = days / 365.25
    total = float(wealth.iloc[-1] - 1.0)
    ann_return = float((1 + total) ** (1 / years) - 1) if years > 0 and total > -1 else total
    vol = float(ret.std() * np.sqrt(_TRADING_DAYS)) if len(ret) > 1 else 0.0
    arith = float(ret.mean() * _TRADING_DAYS)
    sharpe = (arith - rf) / vol if vol else 0.0
    downside = ret[ret < 0]
    down_vol = float(downside.std() * np.sqrt(_TRADING_DAYS)) if len(downside) > 1 else vol
    sortino = (arith - rf) / down_vol if down_vol else 0.0
    peak = wealth.cummax()
    dd = (wealth - peak) / peak
    max_dd = float(dd.min())
    calmar = ann_return / abs(max_dd) if max_dd else 0.0

    common = ret.index.intersection(bench_ret.index)
    beta = alpha = 0.0
    bench_total = 0.0
    if len(common) > 2 and float(bench_ret.loc[common].var()) > 0:
        b = bench_ret.loc[common]
        p = ret.loc[common]
        beta = float(np.cov(p.values, b.values)[0, 1] / np.var(b.values))
        bench_ann = float(b.mean() * _TRADING_DAYS)
        # Jensen's alpha: the return left after paying for the market risk taken.
        alpha = float(arith - (rf + beta * (bench_ann - rf)))
        bench_total = float((1 + b).prod() - 1)

    external = float(flows.sum())
    realised = _realised_pnl(txns)
    thin = days < 90 or len(ret) < 60

    return {
        "metrics": {
            "totalReturnPct": round(total * 100, 2),
            "annualizedReturnPct": round(ann_return * 100, 2),
            "benchmarkReturnPct": round(bench_total * 100, 2),
            "volPct": round(vol * 100, 2),
            "sharpe": round(sharpe, 2),
            "sortino": round(sortino, 2),
            "calmar": round(calmar, 2),
            "maxDrawdownPct": round(max_dd * 100, 2),
            "alphaPct": round(alpha * 100, 2),
            "beta": round(beta, 2),
            "riskFreePct": round(rf * 100, 2),
            "benchmark": benchmark,
        },
        "account": {
            "startDate": str(measured_from.date()),
            "endDate": str(equity.index[-1].date()),
            "ledgerStartDate": str(equity.index[0].date()),
            "days": days,
            "endingValue": round(float(equity.iloc[-1]), 2),
            "netContributions": round(external, 2),
            "netGain": round(float(equity.iloc[-1]) - external, 2),
            "realisedPnl": round(realised, 2),
            "optionRealised": round(built["option_realised"], 2),
            "tradeCount": sum(1 for t in txns if t.kind in ("buy", "sell")),
            "symbols": built["symbols"],
        },
        "series": {
            "equity": _series_points(equity),
            "drawdown": _series_points(dd * 100, wealth.index),
            "benchmark": _series_points(_rebased(bench_close, equity)),
        },
        "allocation": _allocation(built),
        "monthly": _monthly(ret),
        "caveats": _caveats(built, txns, thin, days),
        "returnMethod": "time-weighted, external flows removed",
    }


def _series_points(series: pd.Series, index=None) -> list[dict]:
    idx = index if index is not None else series.index
    s = pd.Series(series.values, index=idx).dropna()
    step = max(1, len(s) // 400)                    # keep the payload small
    return [{"d": str(i.date()), "v": round(float(v), 4)} for i, v in list(s.items())[::step]]


def _rebased(bench: pd.Series, equity: pd.Series) -> pd.Series:
    """Benchmark scaled to the account's starting value, for one shared axis."""
    b = bench.reindex(equity.index).ffill().dropna()
    if b.empty or b.iloc[0] == 0:
        return b
    start = float(equity.iloc[0]) or 1.0
    return b / float(b.iloc[0]) * start


def _allocation(built: dict) -> list[dict]:
    shares, prices = built["shares"], built["prices"]
    if shares.empty:
        return []
    last = shares.iloc[-1]
    values = {s: float(last[s] * prices[s].iloc[-1]) for s in shares.columns if last[s] > 0}
    total = sum(values.values())
    if total <= 0:
        return []
    return sorted(
        ({"symbol": s, "value": round(v, 2), "weightPct": round(v / total * 100, 2)}
         for s, v in values.items()),
        key=lambda r: -r["value"],
    )


def _monthly(ret: pd.Series) -> list[dict]:
    if ret.empty:
        return []
    grouped = (1 + ret).groupby([ret.index.year, ret.index.month]).prod() - 1
    return [{"month": f"{y}-{m:02d}", "returnPct": round(float(v) * 100, 2)}
            for (y, m), v in grouped.items()]


def _realised_pnl(txns: list[Txn]) -> float:
    """Cash actually banked: every sale, dividend and fee, net of what was paid.

    Average cost, not FIFO lots. A brokerage export does not identify which lot
    a sale closed, so a lot-level figure would be invented rather than measured.
    """
    cost: dict[str, list[float]] = {}
    realised = 0.0
    for t in sorted(txns, key=lambda x: x.date):
        if t.kind in ("dividend", "interest"):
            realised += t.amount
        elif t.kind == "fee":
            realised += t.amount
        elif t.kind == "buy" and t.symbol:
            qty, spent = cost.setdefault(t.symbol, [0.0, 0.0])
            cost[t.symbol] = [qty + t.quantity, spent + abs(t.amount)]
        elif t.kind == "sell" and t.symbol:
            qty, spent = cost.get(t.symbol, [0.0, 0.0])
            if qty > 0:
                unit = spent / qty
                sold = min(t.quantity, qty)
                realised += abs(t.amount) - unit * sold
                cost[t.symbol] = [qty - sold, spent - unit * sold]
            else:
                realised += abs(t.amount)
    return realised


def _caveats(built: dict, txns: list[Txn], thin: bool, days: int) -> list[str]:
    out: list[str] = []
    if thin:
        out.append(
            f"This history covers {days} days. Annualized return, Sharpe, Sortino and alpha "
            "are scaled from that sample and are not reliable at this length: read the total "
            "return and the drawdown instead."
        )
    if any(t.is_option for t in txns):
        out.append(
            "Option trades are carried at realised cash only. There is no free historical "
            "price series for a contract, so their value between opening and closing is "
            "missing from the curve."
        )
    transferred = sorted({t.symbol for t in txns if _is_security_transfer(t)})
    if transferred:
        out.append(
            f"{', '.join(transferred)} arrived as a transfer, so they enter at their transferred "
            "value. Performance on them is measured from arrival, not from when they were bought."
        )
    missing = [s for s in {t.symbol for t in txns if t.symbol and not t.is_option}
               if s not in built["symbols"]]
    if missing:
        out.append(f"No price history was available for {', '.join(sorted(missing)[:6])}, "
                   "so those holdings are absent from the marked value.")
    return out
