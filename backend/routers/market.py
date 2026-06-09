import numpy as np
import pandas as pd
from fastapi import APIRouter, HTTPException
import sys, os
sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))
from cache import get_history as _cached_history, get_news as _cached_news
from validation import validate_ticker, validate_date

import yfinance as yf

router = APIRouter()


@router.get("/quote/{ticker}")
def get_quote(ticker: str):
    sym = validate_ticker(ticker)
    try:
        hist = _cached_history(sym, period="5d")
        if hist.empty:
            raise HTTPException(404, "No data")
        closes = hist["Close"].dropna()
        price = float(closes.iloc[-1])
        pct_1d = float((closes.iloc[-1] / closes.iloc[-2] - 1) * 100) if len(closes) >= 2 else None
        return {
            "current_price": round(price, 2),
            "pct_change_1d": round(pct_1d, 3) if pct_1d is not None else None,
        }
    except HTTPException:
        raise
    except Exception:
        raise HTTPException(404, "Could not fetch quote")


def _get_history(ticker: str) -> pd.DataFrame:
    df = _cached_history(ticker, period="5y")
    if df.empty:
        return pd.DataFrame()
    df = df.rename(columns={"Close": "close"})
    return df[["close"]].dropna()


@router.get("/history")
def get_history(ticker: str, start: str | None = None, end: str | None = None):
    ticker = validate_ticker(ticker)
    if start: validate_date(start)
    if end:   validate_date(end)
    df = _get_history(ticker)
    if df.empty:
        raise HTTPException(404, "No data found for ticker")
    if start:
        df = df[df.index >= pd.to_datetime(start)]
    if end:
        df = df[df.index <= pd.to_datetime(end)]
    if df.empty:
        raise HTTPException(404, "No data in date range")

    prices = df["close"]
    returns = np.log(prices / prices.shift(1)).dropna()
    rolling_vol = returns.rolling(30).std() * np.sqrt(252)
    wealth_idx = (1 + prices.pct_change().fillna(0)).cumprod()
    drawdown = (wealth_idx - wealth_idx.cummax()) / wealth_idx.cummax()

    total_return = (prices.iloc[-1] / prices.iloc[0] - 1) * 100
    max_dd = float(drawdown.min()) * 100
    ann_vol = float(returns.std() * np.sqrt(252)) * 100
    current_price = float(prices.iloc[-1])

    return {
        "ticker": ticker.upper(),
        "metrics": {
            "total_return": round(total_return, 2),
            "max_drawdown": round(max_dd, 2),
            "ann_volatility": round(ann_vol, 2),
            "current_price": round(current_price, 2),
        },
        "price": [{"date": str(d.date()), "value": round(float(v), 4)} for d, v in prices.items()],
        "volatility": [{"date": str(d.date()), "value": round(float(v), 4)} for d, v in rolling_vol.dropna().items()],
        "drawdown": [{"date": str(d.date()), "value": round(float(v), 4)} for d, v in drawdown.items()],
    }


@router.get("/ohlcv")
def get_ohlcv(ticker: str, period: str = "1y"):
    ticker = validate_ticker(ticker)
    allowed = {"1mo", "3mo", "6mo", "1y", "2y", "5y"}
    if period not in allowed:
        period = "1y"
    df = _cached_history(ticker, period=period)
    if df.empty:
        raise HTTPException(404, "No data found for ticker")
    df = df[["Open", "High", "Low", "Close", "Volume"]].dropna()
    candles = []
    for d, row in df.iterrows():
        try:
            candles.append({
                "time":   str(d.date()),
                "open":   round(float(row["Open"]),  4),
                "high":   round(float(row["High"]),  4),
                "low":    round(float(row["Low"]),   4),
                "close":  round(float(row["Close"]), 4),
                "volume": int(row["Volume"]),
            })
        except Exception:
            pass
    return {"ticker": ticker.upper(), "candles": candles}


@router.get("/news")
def get_news(ticker: str):
    return {"news": _cached_news(ticker)[:10]}


# ── Sector Rotation ────────────────────────────────────────────────────────────

import threading
from datetime import date, timedelta
from cachetools import TTLCache

try:
    from disk_cache import disk_get, disk_set
except ImportError:
    def disk_get(_k): return None
    def disk_set(_k, _v, ttl=0): pass

from cache import get_download

_SECTOR_CACHE: TTLCache = TTLCache(maxsize=1, ttl=3600)
_SECTOR_LOCK = threading.Lock()

SECTORS = [
    ("XLK",  "Technology"),
    ("XLC",  "Communication"),
    ("XLY",  "Consumer Disc."),
    ("XLP",  "Consumer Staples"),
    ("XLF",  "Financials"),
    ("XLV",  "Health Care"),
    ("XLI",  "Industrials"),
    ("XLB",  "Materials"),
    ("XLRE", "Real Estate"),
    ("XLE",  "Energy"),
    ("XLU",  "Utilities"),
]

PERIODS = {
    "1W":  7,
    "1M":  30,
    "3M":  90,
    "6M":  180,
    "YTD": None,
    "1Y":  365,
}


def _pct_return(series: pd.Series, days: int | None) -> float | None:
    try:
        if days is None:
            # YTD
            start = date(date.today().year, 1, 1).isoformat()
            sub = series.loc[start:]
        else:
            cutoff = (date.today() - timedelta(days=days)).isoformat()
            sub = series.loc[cutoff:]
        sub = sub.dropna()
        if len(sub) < 2:
            return None
        return round(float((sub.iloc[-1] / sub.iloc[0] - 1) * 100), 2)
    except Exception:
        return None


@router.get("/sector-rotation")
def sector_rotation():
    with _SECTOR_LOCK:
        if "data" in _SECTOR_CACHE:
            return _SECTOR_CACHE["data"]

    cached = disk_get("market:sector-rotation")
    if cached:
        with _SECTOR_LOCK:
            _SECTOR_CACHE["data"] = cached
        return cached

    tickers = [s[0] for s in SECTORS] + ["SPY"]
    start = (date.today() - timedelta(days=400)).isoformat()

    try:
        raw = get_download(tuple(tickers), start=start, end=date.today().isoformat())
        if isinstance(raw.columns, pd.MultiIndex):
            prices = raw["Close"]
        else:
            prices = raw
        prices = prices.ffill()
    except Exception as e:
        raise HTTPException(500, f"Data fetch failed: {e}")

    spy = prices.get("SPY")

    results = []
    for ticker, name in SECTORS:
        if ticker not in prices.columns:
            continue
        series = prices[ticker].dropna()
        if series.empty:
            continue

        returns = {p: _pct_return(series, d) for p, d in PERIODS.items()}
        spy_returns = {p: _pct_return(spy, d) for p, d in PERIODS.items()} if spy is not None else {}

        # Relative strength vs SPY per period
        rel_strength = {}
        for p in PERIODS:
            r, s = returns.get(p), spy_returns.get(p)
            rel_strength[p] = round(r - s, 2) if r is not None and s is not None else None

        # Momentum: rank improvement between 1M and 3M performance
        r1m = returns.get("1M")
        r3m = returns.get("3M")
        momentum = round(r1m - r3m / 3, 2) if r1m is not None and r3m is not None else None

        results.append({
            "ticker":       ticker,
            "name":         name,
            "price":        round(float(series.iloc[-1]), 2),
            "returns":      returns,
            "rel_strength": rel_strength,
            "momentum":     momentum,
        })

    # Add rank per period (1 = best)
    for period in PERIODS:
        ranked = sorted(
            [(i, r["returns"].get(period)) for i, r in enumerate(results) if r["returns"].get(period) is not None],
            key=lambda x: x[1], reverse=True
        )
        for rank, (i, _) in enumerate(ranked, 1):
            results[i].setdefault("ranks", {})[period] = rank

    spy_returns_out = {p: _pct_return(spy, d) for p, d in PERIODS.items()} if spy is not None else {}

    payload = {
        "sectors": results,
        "spy_returns": spy_returns_out,
        "as_of": date.today().isoformat(),
    }

    disk_set("market:sector-rotation", payload, ttl=3600)
    with _SECTOR_LOCK:
        _SECTOR_CACHE["data"] = payload
    return payload


# ── Global Macro Dashboard ─────────────────────────────────────────────────────

_MACRO_CACHE: TTLCache = TTLCache(maxsize=1, ttl=300)
_MACRO_LOCK = threading.Lock()

MACRO_ASSETS = [
    # FX
    ("EURUSD=X",  "EUR/USD",   "fx"),
    ("GBPUSD=X",  "GBP/USD",   "fx"),
    ("JPY=X",     "USD/JPY",   "fx"),
    ("DX-Y.NYB",  "DXY",       "fx"),
    # Commodities
    ("CL=F",      "WTI Oil",   "commodity"),
    ("GC=F",      "Gold",      "commodity"),
    ("HG=F",      "Copper",    "commodity"),
    ("NG=F",      "Nat Gas",   "commodity"),
    # Bonds (yfinance)
    ("^TNX",      "US 10Y",    "bond"),
    ("^TYX",      "US 30Y",    "bond"),
    ("^FVX",      "US 5Y",     "bond"),
    ("^IRX",      "US 3M",     "bond"),
    # Vol & Indices
    ("^VIX",      "VIX",       "vol"),
    ("^GSPC",     "S&P 500",   "equity"),
    ("^IXIC",     "NASDAQ",    "equity"),
    ("^RUT",      "Russell 2K","equity"),
]

# Extra Treasury tenors from Treasury.gov XML (not available via yfinance)
# 3M is already available via ^IRX
TREASURY_TENORS = {
    "1M":  ("BC_1MONTH",  "US 1M"),
    "6M":  ("BC_6MONTH",  "US 6M"),
    "3Y":  ("BC_3YEAR",   "US 3Y"),
    "7Y":  ("BC_7YEAR",   "US 7Y"),
}

def _fetch_treasury_yields() -> dict[str, float]:
    """Get interpolated yields for missing tenors from yfinance anchors."""
    import yfinance as yf
    try:
        # Get the 4 reliable yfinance tenors
        syms = {"3M": "^IRX", "5Y": "^FVX", "10Y": "^TNX", "30Y": "^TYX"}
        anchors = {}
        for label, sym in syms.items():
            t = yf.Ticker(sym)
            hist = t.history(period="5d")
            if not hist.empty:
                val = float(hist["Close"].dropna().iloc[-1])
                anchors[label] = val if val < 20.0 else val / 100.0

        if len(anchors) < 2:
            return {}

        # Linear interpolation
        anchor_map = {"3M": 0.25, "5Y": 5.0, "10Y": 10.0, "30Y": 30.0}
        sorted_anchors = sorted([(anchor_map[k], v) for k, v in anchors.items() if k in anchor_map])

        def interp(target_yrs: float) -> float:
            years = [a[0] for a in sorted_anchors]
            yields = [a[1] for a in sorted_anchors]
            if target_yrs <= years[0]:
                return yields[0]
            if target_yrs >= years[-1]:
                return yields[-1]
            for i in range(len(years) - 1):
                if years[i] <= target_yrs <= years[i + 1]:
                    t = (target_yrs - years[i]) / (years[i + 1] - years[i])
                    return yields[i] + t * (yields[i + 1] - yields[i])
            return yields[-1]

        return {
            "1M": round(interp(1/12), 4),
            "6M": round(interp(0.5), 4),
            "3Y": round(interp(3.0), 4),
            "7Y": round(interp(7.0), 4),
        }
    except Exception:
        return {}

@router.get("/macro-dashboard")
def macro_dashboard():
    with _MACRO_LOCK:
        if "data" in _MACRO_CACHE:
            return _MACRO_CACHE["data"]

    tickers = [a[0] for a in MACRO_ASSETS]
    results = []

    try:
        raw = get_download(tuple(tickers), start=(date.today() - timedelta(days=5)).isoformat(), end=date.today().isoformat())
        if isinstance(raw.columns, pd.MultiIndex):
            close = raw["Close"]
        else:
            close = raw
        close = close.ffill()
    except Exception:
        close = pd.DataFrame()

    for ticker, label, category in MACRO_ASSETS:
        try:
            if ticker not in close.columns or close[ticker].dropna().empty:
                results.append({"ticker": ticker, "label": label, "category": category, "price": None, "change": None, "pct": None})
                continue
            series = close[ticker].dropna()
            price = float(series.iloc[-1])
            prev  = float(series.iloc[-2]) if len(series) >= 2 else price
            chg   = price - prev
            pct   = (chg / prev * 100) if prev else 0
            results.append({"ticker": ticker, "label": label, "category": category,
                             "price": round(price, 4), "change": round(chg, 4), "pct": round(pct, 3)})
        except Exception:
            results.append({"ticker": ticker, "label": label, "category": category, "price": None, "change": None, "pct": None})

    treasury_yields = _fetch_treasury_yields()
    for tenor, (field, label) in TREASURY_TENORS.items():
        if tenor in treasury_yields:
            price = treasury_yields[tenor]
            results.append({"ticker": f"UST{tenor}", "label": label, "category": "bond",
                             "price": price, "change": None, "pct": None})

    payload = {"assets": results, "as_of": date.today().isoformat()}
    with _MACRO_LOCK:
        _MACRO_CACHE["data"] = payload
    return payload
