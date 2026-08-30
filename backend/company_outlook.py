"""Consensus estimates and valuation multiples, as Yahoo's Analysis and
Statistics tabs present them.

corporate.hub/estimates already covers estimate REVISIONS: which way consensus
has drifted over 7, 30 and 90 days and how broadly analysts moved. That answers
"is the number going up". It does not answer "what is the number", which is the
grid Yahoo prints: average, low, high, how many analysts, the year-ago actual
and the implied growth, for this quarter, next quarter, this year and next.

Both are worth having and neither replaces the other.
"""
import logging

import pandas as pd

from cache import _run_yf, cached

logger = logging.getLogger(__name__)

# Yahoo's own column order and labels for the estimate grid.
_PERIOD_LABELS = {
    "0q": "Current qtr",
    "+1q": "Next qtr",
    "0y": "Current year",
    "+1y": "Next year",
}
_PERIOD_ORDER = ["0q", "+1q", "0y", "+1y"]


def _num(v) -> float | None:
    """A finite float, or None. NaN reaching JSON serialises to a bare NaN token
    that json.loads rejects on the client, so it never leaves here."""
    try:
        if v is None or pd.isna(v):
            return None
        f = float(v)
        return f if f == f and abs(f) != float("inf") else None
    except (TypeError, ValueError):
        return None


def _grid(df, columns: dict[str, str]) -> list[dict]:
    """One row per forecast period, in Yahoo's order."""
    if df is None or getattr(df, "empty", True):
        return []
    out = []
    for period in _PERIOD_ORDER:
        if period not in df.index:
            continue
        row = df.loc[period]
        entry = {"period": period, "label": _PERIOD_LABELS[period]}
        for src, dest in columns.items():
            entry[dest] = _num(row.get(src)) if src in row else None
        # Analyst counts are counts, not measurements.
        if entry.get("analysts") is not None:
            entry["analysts"] = int(entry["analysts"])
        out.append(entry)
    return out


@cached(ttl=10_800, maxsize=120, persist=True)
def get_estimates(ticker: str) -> dict:
    """Revenue and EPS consensus grids, plus the recent beat/miss record."""
    sym = (ticker or "").strip().upper()
    if not sym:
        return {"available": False, "reason": "no_ticker"}

    # Imported here rather than at the top of the call: yfinance takes
    # seconds to import, and a request with no ticker should pay nothing.
    import yfinance as yf

    def pull():
        t = yf.Ticker(sym)
        return t.earnings_estimate, t.revenue_estimate, t.earnings_history

    try:
        earnings, revenue, history = _run_yf(f"estimates {sym}", pull)
    except Exception as e:
        logger.warning("estimates failed for %s: %s", sym, e)
        return {"available": False, "reason": "source_error", "ticker": sym}

    eps_grid = _grid(earnings, {
        "avg": "avg", "low": "low", "high": "high",
        "yearAgoEps": "yearAgo", "numberOfAnalysts": "analysts", "growth": "growth",
    })
    rev_grid = _grid(revenue, {
        "avg": "avg", "low": "low", "high": "high",
        "yearAgoRevenue": "yearAgo", "numberOfAnalysts": "analysts", "growth": "growth",
    })

    surprises = []
    if history is not None and not getattr(history, "empty", True):
        for quarter, row in history.iterrows():
            actual, estimate = _num(row.get("epsActual")), _num(row.get("epsEstimate"))
            if actual is None and estimate is None:
                continue
            surprises.append({
                "quarter": str(quarter)[:10],
                "actual": actual,
                "estimate": estimate,
                "difference": _num(row.get("epsDifference")),
                "surprisePct": _num(row.get("surprisePercent")),
            })

    if not (eps_grid or rev_grid or surprises):
        return {"available": False, "reason": "no_coverage", "ticker": sym}

    currency = None
    for frame in (earnings, revenue):
        if frame is not None and not getattr(frame, "empty", True) and "currency" in frame.columns:
            vals = [c for c in frame["currency"].tolist() if isinstance(c, str)]
            if vals:
                currency = vals[0]
                break

    return {
        "available": True,
        "ticker": sym,
        "currency": currency or "USD",
        "eps": eps_grid,
        "revenue": rev_grid,
        "surprises": surprises,
        "source": "Yahoo Finance",
    }


# Yahoo's Valuation Measures rows, in its order. Kept as (key, label, unit) so
# the client renders what it is given rather than holding a second copy of this
# list that has to be kept in step.
_VALUATION = [
    ("marketCap", "Market cap", "$"),
    ("enterpriseValue", "Enterprise value", "$"),
    ("trailingPE", "Trailing P/E", "x"),
    ("forwardPE", "Forward P/E", "x"),
    ("pegRatio", "PEG ratio", "x"),
    ("priceToSalesTrailing12Months", "Price / sales", "x"),
    ("priceToBook", "Price / book", "x"),
    ("enterpriseToRevenue", "EV / revenue", "x"),
    ("enterpriseToEbitda", "EV / EBITDA", "x"),
]


@cached(ttl=3_600, maxsize=200, persist=True)
def get_valuation(ticker: str) -> dict:
    """Current valuation multiples.

    Current only. Yahoo prints a quarterly history beside these, which yfinance
    does not carry, and the per-year multiples on /fundamental-history are
    computed against each fiscal year's own close rather than a rolling
    quarter-end, so they are not the same series and are not presented as one.
    """
    sym = (ticker or "").strip().upper()
    if not sym:
        return {"available": False, "reason": "no_ticker"}

    # Imported here rather than at the top of the call: yfinance takes
    # seconds to import, and a request with no ticker should pay nothing.
    import yfinance as yf

    try:
        info = _run_yf(f"valuation {sym}", lambda: yf.Ticker(sym).info) or {}
    except Exception as e:
        logger.warning("valuation failed for %s: %s", sym, e)
        return {"available": False, "reason": "source_error", "ticker": sym}

    # pegRatio disappeared from info for many tickers; trailingPegRatio is the
    # field that survived, so it stands in rather than the row vanishing.
    if info.get("pegRatio") is None and info.get("trailingPegRatio") is not None:
        info = {**info, "pegRatio": info.get("trailingPegRatio")}

    rows = [
        {"key": k, "label": label, "unit": unit, "value": _num(info.get(k))}
        for k, label, unit in _VALUATION
    ]
    if all(r["value"] is None for r in rows):
        return {"available": False, "reason": "no_coverage", "ticker": sym}

    return {
        "available": True,
        "ticker": sym,
        "currency": info.get("currency") or "USD",
        "rows": rows,
        "source": "Yahoo Finance",
    }


# The overview header's 16-cell stat grid. /market/quote carries the price block
# (current, prior close, session) and nothing else, so the grid had no source at
# all: open, bid, ask, both ranges, volume and average volume exist only on the
# vendor info blob.
_QUOTE_FIELDS = [
    "regularMarketPreviousClose", "regularMarketOpen", "bid", "bidSize", "ask", "askSize",
    "dayLow", "dayHigh", "fiftyTwoWeekLow", "fiftyTwoWeekHigh", "volume", "averageVolume",
    "marketCap", "enterpriseValue", "beta", "trailingPE", "trailingEps",
    "targetMeanPrice", "sharesOutstanding", "impliedSharesOutstanding",
    "dividendRate", "dividendYield", "currency", "exchange", "quoteType",
]


@cached(ttl=900, maxsize=200, persist=True)
def get_quote_detail(ticker: str) -> dict:
    """Everything the overview stat grid prints, in one call.

    Values are returned raw. Formatting and the em-dash-versus-reason decision
    belong to the view, which knows the cell it is filling: an absent dividend
    is "None declared" because no dividend exists, while an absent bid is simply
    unavailable, and only the caller can tell those apart.
    """
    sym = (ticker or "").strip().upper()
    if not sym:
        return {"available": False, "reason": "no_ticker"}

    # Imported here rather than at the top of the call: yfinance takes seconds
    # to import, and a request with no ticker should pay nothing.
    import yfinance as yf

    try:
        info = _run_yf(f"quote detail {sym}", lambda: yf.Ticker(sym).info) or {}
    except Exception as e:
        logger.warning("quote detail failed for %s: %s", sym, e)
        return {"available": False, "reason": "source_error", "ticker": sym}

    out = {k: _num(info.get(k)) for k in _QUOTE_FIELDS if k not in
           ("currency", "exchange", "quoteType")}
    for k in ("currency", "exchange", "quoteType"):
        out[k] = info.get(k)

    if not any(v is not None for v in out.values()):
        return {"available": False, "reason": "no_coverage", "ticker": sym}

    # Diluted shares are what a market cap should be built on, and naming the
    # basis is the difference between a figure and a figure you can check.
    shares = out.get("impliedSharesOutstanding") or out.get("sharesOutstanding")
    out["marketCapBasis"] = shares
    out["available"] = True
    out["ticker"] = sym
    out["source"] = "Yahoo Finance"
    return out
