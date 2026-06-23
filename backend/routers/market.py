import numpy as np
import pandas as pd
from fastapi import APIRouter, HTTPException
import sys, os
sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))
from cache import get_history as _cached_history, get_news as _cached_news, get_download, cached, get_info
from validation import validate_ticker, validate_tickers, validate_date


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


@router.get("/dividends")
def get_dividends(tickers: str):
    """Per-ticker dividend snapshot for portfolio income tracking.

    Returns annual_dividend ($/share, forward where available) and
    dividend_yield (%). Sourced from yfinance info so figures line up with what
    Yahoo reports; non-payers come back as zeros.
    """
    # Portfolios can hold more than the default 20-ticker cap; raise it here so a
    # large book's whole dividend panel doesn't 400. Still bounded to limit work.
    syms = validate_tickers([t.strip() for t in tickers.split(",") if t.strip()][:50], max_count=50)
    out: dict[str, dict] = {}
    for sym in syms:
        annual = 0.0
        yld = 0.0
        try:
            info = get_info(sym)
            price = info.get("currentPrice") or info.get("regularMarketPrice")
            if not price:
                hist = _cached_history(sym, period="5d")
                if not hist.empty:
                    price = float(hist["Close"].dropna().iloc[-1])
            price = float(price) if price else 0.0
            # Stocks expose a $/share rate (forward preferred); ETFs/funds instead
            # expose a trailing `yield` fraction. Use whichever is present so both
            # dividend stocks and dividend ETFs report correctly.
            rate = info.get("dividendRate") or info.get("trailingAnnualDividendRate") or 0.0
            yield_frac = info.get("yield") or info.get("trailingAnnualDividendYield") or 0.0
            if rate and price:
                annual = float(rate)
                yld = annual / price * 100
            elif yield_frac and price:
                yld = float(yield_frac) * 100
                annual = float(yield_frac) * price
        except Exception:
            pass
        out[sym] = {"annual_dividend": round(annual, 4), "dividend_yield": round(yld, 2)}
    return out


def _get_history(ticker: str) -> pd.DataFrame:
    df = _cached_history(ticker, period="5y")
    if df.empty:
        return pd.DataFrame()
    df = df.rename(columns={"Close": "close"})
    return df[["close"]].dropna()


# Resolution chosen from the requested span so short windows get intraday bars
# instead of a handful of daily points. Returns (yfinance interval, bars-per-year
# for annualising vol, bars-per-trading-day, is_intraday). yfinance intraday caps:
# 5m ~60d, 30m ~60d, 60m ~730d — every branch stays inside its cap.
_TRADING_DAYS = 252
def _history_resolution(span_days: "int | None"):
    if span_days is None or span_days > 90:
        return ("1d", _TRADING_DAYS, 1, False)
    if span_days <= 5:
        return ("5m", 78 * _TRADING_DAYS, 78, True)
    if span_days <= 30:
        return ("30m", 13 * _TRADING_DAYS, 13, True)
    return ("60m", round(6.5 * _TRADING_DAYS), 7, True)


@router.get("/history")
def get_history(ticker: str, start: str | None = None, end: str | None = None):
    import datetime as _dt
    ticker = validate_ticker(ticker)
    if start: validate_date(start)
    if end:   validate_date(end)

    span_days = None
    if start and end:
        try:
            span_days = (_dt.date.fromisoformat(end) - _dt.date.fromisoformat(start)).days
        except Exception:
            span_days = None
    yf_int, bars_per_year, bars_per_day, intraday = _history_resolution(span_days)

    df = None
    if intraday and start and end:
        import yfinance as yf
        try:
            end_excl = (_dt.date.fromisoformat(end) + _dt.timedelta(days=1)).isoformat()
            raw = yf.Ticker(ticker).history(start=start, end=end_excl, interval=yf_int)
            if not raw.empty:
                df = raw.rename(columns={"Close": "close"})[["close"]].dropna()
        except Exception:
            df = None

    # Daily path — also the fallback when intraday is unavailable for the window
    # (e.g. a short range older than the provider's intraday cap).
    if df is None or df.empty:
        intraday, bars_per_year = False, _TRADING_DAYS
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
    ann = np.sqrt(bars_per_year)
    # Rolling window: 30 sessions for daily; ~a quarter of the intraday series
    # (capped at one trading day of bars) so the line is smooth at any zoom.
    win = 30 if not intraday else max(10, min(len(returns) // 4, bars_per_day))
    rolling_vol = returns.rolling(win).std() * ann
    wealth_idx = (1 + prices.pct_change().fillna(0)).cumprod()
    drawdown = (wealth_idx - wealth_idx.cummax()) / wealth_idx.cummax()

    total_return = (prices.iloc[-1] / prices.iloc[0] - 1) * 100
    max_dd = float(drawdown.min()) * 100
    ann_vol = float(returns.std() * ann) * 100 if len(returns) > 1 else 0.0
    current_price = float(prices.iloc[-1])

    # Intraday points carry a UNIX timestamp (seconds) so lightweight-charts shows
    # the time of day; daily points keep the YYYY-MM-DD string.
    def _lbl(d):
        return int(d.timestamp()) if intraday else str(d.date())

    return {
        "ticker": ticker.upper(),
        "metrics": {
            "total_return": round(total_return, 2),
            "max_drawdown": round(max_dd, 2),
            "ann_volatility": round(ann_vol, 2),
            "current_price": round(current_price, 2),
        },
        "price": [{"date": _lbl(d), "value": round(float(v), 4)} for d, v in prices.items()],
        "volatility": [{"date": _lbl(d), "value": round(float(v), 4)} for d, v in rolling_vol.dropna().items()],
        "drawdown": [{"date": _lbl(d), "value": round(float(v), 4)} for d, v in drawdown.items()],
        "meta": {"interval": yf_int, "intraday": intraday, "vol_window": int(win)},
    }


_COMPARE_PERIOD_DAYS = {"1m": 31, "3m": 92, "6m": 183, "1y": 366, "2y": 731, "5y": 1827}

# Macro overlays sourced from FRED rather than yfinance. (series_id, kind) — kind
# 'level' plots the raw series, 'yoy' plots the year-over-year % change. Monthly
# data is forward-filled onto the chart's daily index.
_FRED_OVERLAYS = {
    "FRED:UNEMP": ("UNRATE",   "level"),
    "FRED:CPI":   ("CPIAUCSL", "yoy"),
    "FRED:CORE":  ("CPILFESL", "yoy"),
    "FRED:PCE":   ("PCEPI",    "yoy"),
}


@router.get("/compare")
def compare_assets(tickers: str, period: str = "1y", normalize: str = "indexed", overlays: str = ""):
    """Overlay assets on one timeline. Any yfinance symbol — equities, ETFs, crypto
    (BTC-USD), indices (^GSPC), FX (EURUSD=X), futures (GC=F), rates (^TNX), vol (^VIX).

    `tickers`  → primary, left axis, normalized by `normalize`
                 ('indexed' = rebased to 100, 'pct' = cumulative %, 'price' = raw).
    `overlays` → secondary, right axis, raw values (macro: ^TNX, ^VIX, DX-Y.NYB …).
    """
    import datetime as _dt

    def _parse(s: str) -> list:
        return list(dict.fromkeys([x.strip().upper() for x in s.split(",") if x.strip()]))

    prim = _parse(tickers)[:8]
    ov_all = [x for x in _parse(overlays) if x not in prim]
    fred_ov = [x for x in ov_all if x in _FRED_OVERLAYS][:4]
    sec     = [x for x in ov_all if x not in _FRED_OVERLAYS][:4]
    if not prim:
        raise HTTPException(400, "Provide at least one ticker")
    allsyms = prim + sec   # yfinance symbols only; FRED overlays fetched separately
    try:
        validate_tickers(allsyms, max_count=12)
    except HTTPException:
        raise HTTPException(400, "Invalid ticker symbol")

    today = _dt.date.today()
    if period == "ytd":
        start = _dt.date(today.year, 1, 1)
    elif period == "max":
        start = today - _dt.timedelta(days=365 * 15)
    else:
        start = today - _dt.timedelta(days=_COMPARE_PERIOD_DAYS.get(period, 366))
    end = today + _dt.timedelta(days=1)

    try:
        raw = get_download(tuple(sorted(allsyms)), str(start), str(end))
    except Exception:
        raise HTTPException(500, "Internal server error")
    if raw is None or raw.empty:
        raise HTTPException(404, "No data for the requested assets")

    if isinstance(raw.columns, pd.MultiIndex):
        closes = raw["Close"] if "Close" in raw.columns.get_level_values(0) else raw
    else:
        col = "Close" if "Close" in raw.columns else raw.columns[0]
        closes = raw[[col]].copy()
        closes.columns = [allsyms[0]]
    if isinstance(closes, pd.Series):
        closes = closes.to_frame(allsyms[0])

    closes = closes.sort_index().ffill()
    prim_avail = [s for s in prim if s in closes.columns]
    sec_avail  = [s for s in sec if s in closes.columns]
    if not prim_avail:
        raise HTTPException(404, "No data for the requested assets")
    # Align on the primary assets' common history (crypto weekends fold into trading days)
    closes = closes.dropna(subset=prim_avail)
    if closes.empty:
        raise HTTPException(404, "No overlapping history for these assets")

    out  = pd.DataFrame(index=closes.index)
    meta, axis = {}, {}
    base = closes[prim_avail].iloc[0]
    for s in prim_avail:
        col = closes[s]
        if normalize == "indexed":
            out[s] = col / base[s] * 100.0
        elif normalize == "pct":
            out[s] = (col / base[s] - 1.0) * 100.0
        else:
            out[s] = col
        first, last = float(col.iloc[0]), float(col.iloc[-1])
        meta[s] = {"start": round(first, 4), "last": round(last, 4),
                   "change_pct": round((last / first - 1) * 100, 2) if first else None}
        axis[s] = "left"
    for s in sec_avail:                         # secondary overlays — raw values
        col = closes[s]
        out[s] = col
        valid = col.dropna()
        if len(valid):
            f, l = float(valid.iloc[0]), float(valid.iloc[-1])
            meta[s] = {"start": round(f, 4), "last": round(l, 4),
                       "change_pct": round((l / f - 1) * 100, 2) if f else None}
        axis[s] = "right"

    # FRED macro overlays — monthly, forward-filled onto the daily chart index
    fred_avail: list[str] = []
    if fred_ov:
        import fred as _fred
        months = max(24, (today - start).days // 30 + 16)   # cover window + 12 for YoY
        for key in fred_ov:
            series_id, kind = _FRED_OVERLAYS[key]
            obs = _fred.observations(series_id, months + 2)
            if kind == "yoy":
                obs = _fred.yoy(obs)
            if not obs:
                continue
            s = pd.Series({pd.Timestamp(o["date"]): o["value"] for o in obs}).sort_index()
            aligned = s.reindex(out.index.union(s.index)).ffill().reindex(out.index)
            out[key] = aligned
            valid = aligned.dropna()
            if len(valid):
                f, l = float(valid.iloc[0]), float(valid.iloc[-1])
                meta[key] = {"start": round(f, 4), "last": round(l, 4),
                             "change_pct": round((l / f - 1) * 100, 2) if f else None}
            axis[key] = "right"
            fred_avail.append(key)

    cols = prim_avail + sec_avail + fred_avail
    series = []
    for d, row in out.iterrows():
        rec = {"date": str(pd.Timestamp(d).date())}
        for s in cols:
            v = row[s]
            rec[s] = round(float(v), 4) if pd.notna(v) else None
        series.append(rec)

    return {"period": period, "normalize": normalize, "tickers": prim_avail,
            "overlays": sec_avail + fred_avail, "series": series, "meta": meta, "axis": axis}


@router.get("/fundamental-series")
def fundamental_series(ticker: str, metric: str = "pe", period: str = "quarter"):
    """Time series of a standardized multiple/ratio (P/E, EV/EBITDA, P/S, P/B, ROE,
    ROIC, margins, D/E, yields) for chart overlays — all size-neutral and comparable
    across companies. Also serves absolute fundamentals (revenue, FCF, …) if requested."""
    ticker = validate_ticker(ticker)
    import fmp as _fmp
    if not _fmp.available():
        raise HTTPException(503, "Fundamentals data source unavailable")

    if metric in _fmp.RATIO_METRICS:
        pts = _fmp.get_ratio_series(ticker, metric, period if period in ("quarter", "annual") else "annual", 16)
        unit = "%" if _fmp._RATIO_REGISTRY[metric][2] else "x"
    else:
        pts = _fmp.get_fundamental_series(ticker, metric, period, 24)
        unit = {"revenue": "$", "net_income": "$", "eps": "$", "ebitda": "$", "fcf": "$",
                "gross_margin": "%", "operating_margin": "%", "net_margin": "%"}.get(metric, "")
    if not pts:
        raise HTTPException(404, "No data for this ticker/metric")
    return {"ticker": ticker.upper(), "metric": metric, "unit": unit, "points": pts}


_INTRADAY_PERIOD = {"1m": "1d", "5m": "5d", "15m": "5d", "1h": "1mo"}

# Full timeframe set. Each maps to (yfinance interval, fetch period, resample rule
# or None, intraday). yfinance has no 3m/10m/2h/6h/12h, so those are resampled
# from the finest native base (1m for sub-hour, 60m for multi-hour).
# Fetch period is maxed to each interval's provider cap so the chart can scroll
# back as far as the data allows (yfinance limits: 1m ≈ 7d, 5m ≈ 60d, 60m ≈ 730d).
_TF = {
    "1m":  ("1m",  "5d",  None,    True),
    "3m":  ("1m",  "5d",  "3min",  True),
    "5m":  ("5m",  "1mo", None,    True),
    "10m": ("5m",  "1mo", "10min", True),   # was 1m/5d → 5m/1mo: ~5 days → ~30 days
    "1h":  ("60m", "2y",  None,    True),    # was 3mo → 2y
    "2h":  ("60m", "2y",  "2h",    True),    # was 6mo → 2y
    "6h":  ("60m", "2y",  "6h",    True),    # was 1y → 2y
    "12h": ("60m", "2y",  "12h",   True),
    "1d":  ("1d",  "max", None,    False),   # full daily history back to inception
    "1wk": ("1wk", "10y", None,    False),   # was 5y → 10y
    "1mo": ("1mo", "max", None,    False),   # was 10y → max
}


@router.get("/ohlcv")
def get_ohlcv(ticker: str, period: str = "1y", interval: str = "1d", tf: str | None = None, prepost: bool = False):
    ticker = validate_ticker(ticker)
    if tf and tf in _TF:
        import yfinance as yf
        yf_int, yf_per, rule, intraday = _TF[tf]
        try:
            df = yf.Ticker(ticker).history(period=yf_per, interval=yf_int, prepost=prepost and intraday)
        except Exception:
            df = _pd_empty()
        if not df.empty and rule:
            df = df.resample(rule, label="left", closed="left").agg(
                {"Open": "first", "High": "max", "Low": "min", "Close": "last", "Volume": "sum"}
            ).dropna(subset=["Close"])
    elif interval in _INTRADAY_PERIOD:
        intraday = True
        import yfinance as yf
        try:
            df = yf.Ticker(ticker).history(period=_INTRADAY_PERIOD[interval], interval=interval, prepost=prepost)
        except Exception:
            df = _pd_empty()
    else:
        intraday = False
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
                "time":   int(d.timestamp()) if intraday else str(d.date()),
                "open":   round(float(row["Open"]),  4),
                "high":   round(float(row["High"]),  4),
                "low":    round(float(row["Low"]),   4),
                "close":  round(float(row["Close"]), 4),
                "volume": int(row["Volume"]),
            })
        except Exception:
            pass
    return {"ticker": ticker.upper(), "candles": candles}


def _pd_empty():
    import pandas as pd
    return pd.DataFrame()


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


MACRO_ASSETS = [
    # FX
    ("EURUSD=X",  "EUR/USD",   "fx"),
    ("GBPUSD=X",  "GBP/USD",   "fx"),
    ("JPY=X",     "USD/JPY",   "fx"),
    ("DX-Y.NYB",  "DXY",       "fx"),
    # Commodities
    ("CL=F",      "WTI Oil",   "commodity"),
    ("BZ=F",      "Brent Oil", "commodity"),
    ("GC=F",      "Gold",      "commodity"),
    ("SI=F",      "Silver",    "commodity"),
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

def _fetch_treasury_yields() -> dict[str, tuple[float, float]]:
    """Return (current_yield, prev_yield) for interpolated tenors."""
    try:
        syms = {"3M": "^IRX", "5Y": "^FVX", "10Y": "^TNX", "30Y": "^TYX"}
        anchors_cur: dict[str, float] = {}
        anchors_prev: dict[str, float] = {}
        for lbl, sym in syms.items():
            hist = _cached_history(sym, period="5d")
            if not hist.empty:
                closes = hist["Close"].dropna()
                cur  = float(closes.iloc[-1])
                prev = float(closes.iloc[-2]) if len(closes) >= 2 else cur
                anchors_cur[lbl]  = cur  if cur  < 20.0 else cur  / 100.0
                anchors_prev[lbl] = prev if prev < 20.0 else prev / 100.0

        if len(anchors_cur) < 2:
            return {}

        anchor_map = {"3M": 0.25, "5Y": 5.0, "10Y": 10.0, "30Y": 30.0}

        def make_interp(anchors: dict[str, float]):
            pts = sorted([(anchor_map[k], v) for k, v in anchors.items() if k in anchor_map])
            yrs = [p[0] for p in pts]
            yld = [p[1] for p in pts]
            def _interp(target: float) -> float:
                if target <= yrs[0]:  return yld[0]
                if target >= yrs[-1]: return yld[-1]
                for i in range(len(yrs) - 1):
                    if yrs[i] <= target <= yrs[i + 1]:
                        tt = (target - yrs[i]) / (yrs[i + 1] - yrs[i])
                        return yld[i] + tt * (yld[i + 1] - yld[i])
                return yld[-1]
            return _interp

        interp_cur  = make_interp(anchors_cur)
        interp_prev = make_interp(anchors_prev) if len(anchors_prev) >= 2 else interp_cur

        targets = {"1M": 1/12, "6M": 0.5, "3Y": 3.0, "7Y": 7.0}
        return {
            tenor: (round(interp_cur(yrs), 4), round(interp_prev(yrs), 4))
            for tenor, yrs in targets.items()
        }
    except Exception:
        return {}

@router.get("/macro-dashboard")
@cached(ttl=300, maxsize=1)
def macro_dashboard():
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
            price, prev = treasury_yields[tenor]
            chg = price - prev
            pct = (chg / prev * 100) if prev else 0.0
            results.append({"ticker": f"UST{tenor}", "label": label, "category": "bond",
                             "price": price, "change": round(chg, 4), "pct": round(pct, 3)})

    # Sort bond results by maturity so the yield curve reads short → long
    _bond_maturity = {
        "US 1M": 1, "US 3M": 2, "US 6M": 3, "US 1Y": 4,
        "US 3Y": 5, "US 5Y": 6, "US 7Y": 7, "US 10Y": 8, "US 30Y": 9,
    }
    non_bonds = [r for r in results if r["category"] != "bond"]
    bonds     = sorted([r for r in results if r["category"] == "bond"],
                       key=lambda a: _bond_maturity.get(a["label"], 99))
    results   = non_bonds + bonds

    payload = {"assets": results, "as_of": date.today().isoformat()}
    return payload
