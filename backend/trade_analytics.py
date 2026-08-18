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
import re
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



# ── Options ─────────────────────────────────────────────────────────────────
# A contract has no free historical price series, but it does not need one: the
# fill price in the ledger is a real observation, so the volatility the market
# charged at that moment can be solved out of it and the contract marked against
# the underlying from there. That is one measured input per trade rather than an
# assumed volatility applied to everything.
_CONTRACT_MULTIPLIER = 100.0
_OCC = re.compile(r"^([A-Z.]{1,6})(\d{2})(\d{2})(\d{2})([CP])(\d+(?:\.\d+)?)$")


def parse_option_symbol(symbol: str) -> dict | None:
    """"NVDA260807C200" -> underlying, expiry, right and strike."""
    m = _OCC.match((symbol or "").strip().upper())
    if not m:
        return None
    root, yy, mm, dd, right, strike = m.groups()
    try:
        expiry = date(2000 + int(yy), int(mm), int(dd))
    except ValueError:
        return None
    return {"underlying": root, "expiry": expiry,
            "right": "call" if right == "C" else "put", "strike": float(strike)}


def implied_vol(price: float, S: float, K: float, T: float, r: float, right: str) -> float | None:
    """Volatility that reprices the fill, by bisection.

    Bisection rather than Newton: vega collapses on a deep or nearly-expired
    contract and a derivative method walks off. Fifty halvings of a wide bracket
    is fast enough here and cannot diverge.
    """
    from math_engine import bs_price

    def _bs(sigma: float) -> float:
        # bs_price takes days and percents; this module works in years/decimals.
        return float(bs_price(S, K, T * 365.0, r * 100.0, sigma * 100.0, right))

    if price <= 0 or S <= 0 or K <= 0 or T <= 0:
        return None
    intrinsic = max(S - K, 0.0) if right == "call" else max(K - S, 0.0)
    if price <= intrinsic:
        return None                      # no time value: nothing to solve for
    lo, hi = 1e-4, 5.0
    if _bs(hi) < price:
        return None                      # beyond any believable volatility
    for _ in range(50):
        mid = (lo + hi) / 2
        if _bs(mid) < price:
            lo = mid
        else:
            hi = mid
    return (lo + hi) / 2


def _mark_options(txns, calendar, prices, rf: float = 0.04):
    """Daily mark-to-market of every option position.

    Returns (value series, realised cash, contracts held at the end, notes).
    A short position marks negative: it is a liability until it is closed.
    """
    from math_engine import bs_price

    value = pd.Series(0.0, index=calendar)
    realised = 0.0
    open_lots: dict[str, dict] = {}
    unpriced: set[str] = set()

    for t in sorted((x for x in txns if x.is_option), key=lambda x: x.date):
        realised += t.amount
        spec = parse_option_symbol(t.symbol)
        if not spec or spec["underlying"] not in prices.columns:
            unpriced.add(t.symbol)
            continue
        lot = open_lots.setdefault(t.symbol, {**spec, "contracts": 0.0, "vol": None})
        lot["contracts"] += t.quantity if t.kind == "buy" else -t.quantity
        # Solve the volatility out of this fill and carry it forward.
        day = pd.Timestamp(t.date)
        if day in prices.index and t.price > 0:
            S = float(prices.loc[day, spec["underlying"]])
            T = max((spec["expiry"] - t.date).days, 0) / 365.0
            solved = implied_vol(t.price, S, spec["strike"], T, rf, spec["right"])
            if solved:
                lot["vol"] = solved

    for symbol, lot in open_lots.items():
        under = prices[lot["underlying"]]
        vol = lot["vol"]
        if vol is None:
            # No fill gave a solvable volatility, so fall back to what the
            # underlying actually did. Stated as an assumption, not a price.
            realised_vol = under.pct_change().std() * np.sqrt(_TRADING_DAYS)
            vol = float(realised_vol) if np.isfinite(realised_vol) and realised_vol > 0 else 0.30
            unpriced.add(symbol)
        # Rebuild the running contract count so the mark follows the position.
        held = pd.Series(0.0, index=calendar)
        for t in sorted((x for x in txns if x.is_option and x.symbol == symbol), key=lambda x: x.date):
            day = pd.Timestamp(t.date)
            if day > calendar[-1]:
                continue
            day = day if day in calendar else calendar[calendar.searchsorted(day)]
            held.loc[day:] += t.quantity if t.kind == "buy" else -t.quantity
        expiry = pd.Timestamp(lot["expiry"])
        for day in calendar:
            contracts = float(held.loc[day])
            if contracts == 0 or day > expiry:
                continue                 # expired or assigned: carried at zero
            T = max((expiry - day).days, 0) / 365.0
            S = float(under.loc[day])
            if T <= 0 or vol <= 0:
                # On expiry day the contract is worth its intrinsic value, and
                # Black-Scholes divides by sigma*sqrt(T) to get there.
                px = max(S - lot["strike"], 0.0) if lot["right"] == "call" \
                    else max(lot["strike"] - S, 0.0)
            else:
                px = float(bs_price(S, lot["strike"], T * 365.0,
                                    rf * 100.0, vol * 100.0, lot["right"]))
            value.loc[day] += contracts * _CONTRACT_MULTIPLIER * float(px)

    return value, realised, open_lots, sorted(unpriced)


def build_curve(txns: list[Txn], benchmark: str = "SPY") -> dict:
    """Daily equity, external flows, and the marked positions behind them."""
    dated = sorted((t for t in txns if t.date), key=lambda t: t.date)
    if not dated:
        return {"error": "no dated transactions"}

    start, end = dated[0].date, max(dated[-1].date, date.today())
    equities = sorted({t.symbol for t in dated if t.symbol and not t.is_option})
    # An option is marked against its underlying, so that series is needed even
    # when the underlying itself was never traded.
    underlyings = sorted({
        spec["underlying"] for t in dated if t.is_option
        for spec in [parse_option_symbol(t.symbol)] if spec
    })
    prices = _price_frame(sorted(set(equities + underlyings + [benchmark])), start, end)
    if prices.empty:
        return {"error": "no price history available for these symbols"}
    calendar = prices.index

    shares = pd.DataFrame(0.0, index=calendar, columns=equities)
    cash = pd.Series(0.0, index=calendar)
    flows = pd.Series(0.0, index=calendar)

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
            # Cash moves here; the position itself is marked below.
            cash.loc[day:] += t.amount
            continue

        if t.kind in ("buy", "sell") and t.symbol in shares.columns:
            shares.loc[day:, t.symbol] += signed
        cash.loc[day:] += t.amount          # dividends, interest and fees land here too

    held = prices[equities] if equities else pd.DataFrame(index=calendar)
    holdings = (shares * held).sum(axis=1) if equities else pd.Series(0.0, index=calendar)
    option_value, option_realised, option_lots, option_unpriced = _mark_options(
        dated, calendar, prices)
    equity = holdings + option_value + cash

    return {
        "equity": equity, "holdings": holdings, "cash": cash, "flows": flows,
        "shares": shares, "prices": prices, "benchmark": benchmark,
        "option_value": option_value,
        "option_realised": option_realised,
        "option_lots": option_lots,
        "option_unpriced": option_unpriced,
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




def _irr(flows: list[tuple[float, float]]) -> float | None:
    """Annualized IRR of (years_from_start, amount) pairs, by bisection.

    Bisection because a cash-flow series can have several sign changes and
    Newton wanders off; halving a bracket cannot.
    """
    if len(flows) < 2 or all(a >= 0 for _, a in flows) or all(a <= 0 for _, a in flows):
        return None

    def npv(rate: float) -> float:
        return sum(a / (1.0 + rate) ** t for t, a in flows)

    lo, hi = -0.9999, 10.0
    if npv(lo) * npv(hi) > 0:
        return None                      # no sign change: no rate solves it
    for _ in range(200):
        mid = (lo + hi) / 2
        if npv(lo) * npv(mid) <= 0:
            hi = mid
        else:
            lo = mid
    return (lo + hi) / 2


def direct_alpha(flows: pd.Series, ending_value: float, bench: pd.Series) -> dict:
    """Money-weighted alpha: the IRR of flows scaled by the benchmark.

    Gredil, Griffiths and Stucke's Direct Alpha. Every contribution is carried
    forward to the end date at the benchmark's own return, which asks what those
    exact dollars would have become in the index on those exact dates. The IRR
    of the scaled series is then the excess rate earned over the benchmark,
    annualized, with no CAPM assumption and no beta.

    Time-weighted alpha answers whether the decisions were good. This answers
    whether the money made more than the index would have, which is the question
    an account holder is usually asking, and the two differ whenever
    contributions are unevenly timed.
    """
    moved = flows[flows != 0]
    if moved.empty or ending_value <= 0 or bench.empty:
        return {"available": False}
    index = bench.reindex(bench.index.union(moved.index)).ffill()
    end_day = bench.index[-1]
    end_level = float(index.loc[end_day])
    if not np.isfinite(end_level) or end_level <= 0:
        return {"available": False}

    start = moved.index[0]
    scaled: list[tuple[float, float]] = []
    contributed = 0.0
    for day, amount in moved.items():
        level = float(index.loc[day]) if day in index.index else np.nan
        if not np.isfinite(level) or level <= 0:
            continue
        years = max((day - start).days, 0) / 365.25
        # A contribution leaves the holder's pocket, so it is negative here.
        scaled.append((years, -float(amount) * (end_level / level)))
        contributed += float(amount)
    if not scaled:
        return {"available": False}
    scaled.append((max((end_day - start).days, 0) / 365.25, float(ending_value)))

    rate = _irr(scaled)
    if rate is None:
        return {"available": False}

    # What the same dollars would have been worth in the index, for context.
    benchmark_value = sum(
        float(a) * (end_level / float(index.loc[d]))
        for d, a in moved.items()
        if d in index.index and np.isfinite(index.loc[d]) and float(index.loc[d]) > 0
    )
    return {
        "available": True,
        "alphaPct": round(rate * 100, 2),
        "contributed": round(contributed, 2),
        "endingValue": round(float(ending_value), 2),
        "benchmarkValue": round(benchmark_value, 2),
        "dollarsVsBenchmark": round(float(ending_value) - benchmark_value, 2),
        "flowCount": int(len(moved)),
    }


def market_regression(port: pd.Series, bench: pd.Series, rf: float) -> dict:
    """Regress daily excess return on the market's, and say whether it is noise.

    The intercept is alpha and the slope is beta, fitted together rather than
    plugged into an identity one at a time. The intercept carries a standard
    error, so it comes with a t-statistic: a large alpha on a short, noisy
    sample is usually indistinguishable from zero, and a ratio cannot say so.
    """
    from scipy import stats

    common = port.index.intersection(bench.index)
    if len(common) < 20:
        return {"observations": int(len(common)), "sufficient": False}
    daily_rf = rf / _TRADING_DAYS
    x = (bench.loc[common] - daily_rf).values
    y = (port.loc[common] - daily_rf).values
    if float(np.var(x)) <= 0 or len(np.unique(x)) < 2:
        # A benchmark that never moves has no slope to fit, and linregress
        # raises rather than saying so.
        return {"observations": int(len(common)), "sufficient": False}

    try:
        fit = stats.linregress(x, y)
    except ValueError:
        return {"observations": int(len(common)), "sufficient": False}
    beta = float(fit.slope)
    alpha_daily = float(fit.intercept)
    t_stat = alpha_daily / fit.intercept_stderr if fit.intercept_stderr else 0.0
    p_value = float(2 * (1 - stats.t.cdf(abs(t_stat), max(len(x) - 2, 1))))

    years = max(len(common) / _TRADING_DAYS, 1e-9)
    port_ann = float((1 + port.loc[common]).prod() ** (1 / years) - 1)
    bench_ann = float((1 + bench.loc[common]).prod() ** (1 / years) - 1)

    lo, hi = float(np.min(x)), float(np.max(x))
    return {
        "sufficient": True,
        "observations": int(len(common)),
        "beta": round(beta, 3),
        "alphaRegressionPct": round(alpha_daily * _TRADING_DAYS * 100, 2),
        "tStat": round(float(t_stat), 2),
        "pValue": round(p_value, 4),
        "rSquared": round(float(fit.rvalue ** 2), 3),
        "significant": bool(p_value < 0.05),
        "portfolioAnnPct": round(port_ann * 100, 2),
        "benchmarkAnnPct": round(bench_ann * 100, 2),
        # Daily points in percent, with the fitted line's endpoints, so the
        # chart draws the same fit these numbers came from.
        "points": [
            {"x": round(float(a) * 100, 4), "y": round(float(b) * 100, 4)}
            for a, b in zip(x, y)
        ],
        "line": [
            {"x": round(lo * 100, 4), "y": round((alpha_daily + beta * lo) * 100, 4)},
            {"x": round(hi * 100, 4), "y": round((alpha_daily + beta * hi) * 100, 4)},
        ],
    }


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
    beta = 0.0
    bench_total = 0.0
    if len(common) > 2 and float(bench_ret.loc[common].var()) > 0:
        b = bench_ret.loc[common]
        p = ret.loc[common]
        beta = float(np.cov(p.values, b.values)[0, 1] / np.var(b.values))
        bench_total = float((1 + b).prod() - 1)

    reg = market_regression(ret, bench_ret, rf)
    direct = direct_alpha(flows, float(equity.iloc[-1]), bench_close)
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
            # alphaPct is the regression alpha. It was a separate CAPM figure,
            # which is Jensen's under another name and which the regression
            # supersedes by fitting alpha and beta together and reporting
            # whether the result is distinguishable from zero.
            "alphaPct": reg.get("alphaRegressionPct"),
            "alphaRegressionPct": reg.get("alphaRegressionPct"),
            "alphaDirectPct": direct.get("alphaPct"),
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
        "regression": reg,
        "directAlpha": direct,
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
    unpriced = built.get("option_unpriced") or []
    if unpriced:
        out.append(
            f"{', '.join(unpriced[:6])} could not be priced from its own fills, so it is marked "
            "at the underlying's realised volatility rather than at the volatility the market "
            "charged."
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
