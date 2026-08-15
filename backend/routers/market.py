import time
from concurrent.futures import ThreadPoolExecutor
import numpy as np
import pandas as pd
import datetime as _dt
from fastapi import APIRouter, HTTPException
import sys, os
sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))
from cache import get_history as _cached_history, get_news as _cached_news, get_download, cached, get_info, _run_yf
from validation import validate_ticker, validate_tickers, validate_date
import serpapi_finance
import alpaca
import factor_models as fm
from market_hours import is_market_open, is_overnight_session, session_status, session_label, now_et
import extended_quotes
import index_profile as _index_profile
import breadth as _breadth
import seasonality as _seasonality
import rrg as _rrg


router = APIRouter()

# "Large" CAPM-vs-Scholes-Williams divergence: a starting threshold for
# flagging thin-trading distortion, not a statistically derived cutoff.
_THIN_TRADING_DIVERGENCE_PCT = 15.0


# Global Markets board: major stock indices by region, FX, commodities, US
# yields, and crypto. One batched yfinance download for all symbols (single
# HTTP call, respects the concurrency budget), endpoint-cached 5 minutes.
GLOBAL_MARKETS_BOARD: list[tuple[str, str, str]] = [
    # (section, label, yfinance symbol)
    ("Americas", "S&P 500", "^GSPC"), ("Americas", "Nasdaq", "^IXIC"),
    ("Americas", "Dow Jones", "^DJI"), ("Americas", "Russell 2000", "^RUT"),
    ("Americas", "VIX", "^VIX"), ("Americas", "TSX (Canada)", "^GSPTSE"),
    ("Americas", "Bovespa (Brazil)", "^BVSP"), ("Americas", "IPC (Mexico)", "^MXX"),
    ("Europe", "FTSE 100 (UK)", "^FTSE"), ("Europe", "DAX (Germany)", "^GDAXI"),
    ("Europe", "CAC 40 (France)", "^FCHI"), ("Europe", "Euro Stoxx 50", "^STOXX50E"),
    ("Europe", "IBEX 35 (Spain)", "^IBEX"), ("Europe", "SMI (Switzerland)", "^SSMI"),
    ("Europe", "AEX (Netherlands)", "^AEX"), ("Europe", "FTSE MIB (Italy)", "FTSEMIB.MI"),
    ("Asia-Pacific", "Nikkei 225 (Japan)", "^N225"), ("Asia-Pacific", "Hang Seng (HK)", "^HSI"),
    ("Asia-Pacific", "Shanghai Composite", "000001.SS"), ("Asia-Pacific", "CSI 300 (China)", "000300.SS"),
    ("Asia-Pacific", "KOSPI (Korea)", "^KS11"), ("Asia-Pacific", "TAIEX (Taiwan)", "^TWII"),
    ("Asia-Pacific", "Nifty 50 (India)", "^NSEI"), ("Asia-Pacific", "ASX 200 (Australia)", "^AXJO"),
    ("Asia-Pacific", "STI (Singapore)", "^STI"),
    ("FX", "DXY (Dollar index)", "DX-Y.NYB"), ("FX", "EUR / USD", "EURUSD=X"),
    ("FX", "USD / JPY", "JPY=X"), ("FX", "GBP / USD", "GBPUSD=X"),
    ("FX", "USD / CNY", "CNY=X"), ("FX", "USD / CHF", "CHF=X"),
    ("FX", "AUD / USD", "AUDUSD=X"), ("FX", "USD / CAD", "CAD=X"),
    ("FX", "USD / MXN", "MXN=X"), ("FX", "USD / INR", "INR=X"),
    ("Commodities", "WTI Crude", "CL=F"), ("Commodities", "Brent Crude", "BZ=F"),
    ("Commodities", "Natural Gas", "NG=F"), ("Commodities", "Gold", "GC=F"),
    ("Commodities", "Silver", "SI=F"), ("Commodities", "Copper", "HG=F"),
    ("Commodities", "Platinum", "PL=F"), ("Commodities", "Wheat", "ZW=F"),
    ("Commodities", "Corn", "ZC=F"), ("Commodities", "Soybeans", "ZS=F"),
    ("US Yields", "13-week", "^IRX"), ("US Yields", "2-year", "FRED:DGS2"),
    ("US Yields", "5-year", "^FVX"), ("US Yields", "10-year", "^TNX"),
    ("US Yields", "30-year", "^TYX"),
    ("Crypto", "Bitcoin", "BTC-USD"), ("Crypto", "Ethereum", "ETH-USD"),
    ("Crypto", "Solana", "SOL-USD"),
]
_GLOBAL_SECTIONS = ["Americas", "Europe", "Asia-Pacific", "FX", "Commodities", "US Yields", "Crypto"]
_GLOBAL_WINDOWS = {"10m", "30m", "1h", "1d", "1w", "1m", "ytd"}
_GLOBAL_FRED_SERIES = {"FRED:DGS2": "DGS2"}
_CME_FUTURES_PROXIES = {
    "^GSPC": ("S&P 500 Futures", "ES=F"),
    "^IXIC": ("Nasdaq 100 Futures", "NQ=F"),
    "^DJI": ("Dow Futures", "YM=F"),
    "^RUT": ("Russell 2000 Futures", "RTY=F"),
}


@router.get("/session")
def market_session():
    return session_status()


def _us_cash_session_open(now_utc: _dt.datetime) -> bool:
    return is_market_open(now_utc)


def _global_window(window: str, now):
    # Prefer coarser bars than strict 1m/5m: board needs last price + % change
    # + a short spark, not tick resolution. Fewer bars → much faster Yahoo download.
    if window == "10m": return now - _dt.timedelta(minutes=10), "1m", True
    if window == "30m": return now - _dt.timedelta(minutes=30), "5m", True
    if window == "1h":  return now - _dt.timedelta(hours=1), "5m", True
    if window == "1d":  return now - _dt.timedelta(days=1), "15m", True
    if window == "1w":  return now - _dt.timedelta(days=7), "1d", False
    if window == "1m":  return now - _dt.timedelta(days=31), "1d", False
    return _dt.datetime(now.year, 1, 1), "1d", False


def _iso_timestamp(value) -> str | None:
    if value is None:
        return None
    stamp = pd.Timestamp(value)
    if stamp.tzinfo is None:
        stamp = stamp.tz_localize("UTC")
    return stamp.isoformat()


def _close_frame(df: pd.DataFrame) -> pd.DataFrame | None:
    if df is None or df.empty:
        return None
    closes = df.get("Close")
    if closes is None:
        return None
    # Single-ticker downloads return a Series; multi-ticker a DataFrame.
    if isinstance(closes, pd.Series):
        return closes.to_frame()
    return closes


@router.get("/global-board")
@cached(ttl=120, maxsize=48, persist=True)
def global_board(date: str | None = None, window: str = "1d"):
    """Global Markets board with a consistent performance window.

    The current board uses the freshest intraday bars available for 10m through
    1d. Longer windows use daily closes. A dated session always remains an
    end-of-day snapshot so it cannot be mistaken for live data.

    Cached 2 minutes in memory + disk so cold tabs and concurrent visitors
    share one Yahoo multi-ticker download instead of stampeding.
    """
    target = None
    if date:
        try:
            target = _dt.date.fromisoformat(date)
        except ValueError:
            raise HTTPException(400, "date must be YYYY-MM-DD")
        if target > _dt.date.today():
            raise HTTPException(400, "date cannot be in the future")
    if window not in _GLOBAL_WINDOWS:
        raise HTTPException(400, "unsupported performance window")

    now_utc = _dt.datetime.now(_dt.timezone.utc)
    now = now_utc.replace(tzinfo=None)
    use_cme_futures = target is None and not _us_cash_session_open(now_utc)
    active_board = []
    for section, label, symbol in GLOBAL_MARKETS_BOARD:
        if use_cme_futures and symbol in _CME_FUTURES_PROXIES:
            proxy_label, quote_symbol = _CME_FUTURES_PROXIES[symbol]
            active_board.append((section, proxy_label, quote_symbol, symbol, True))
        else:
            active_board.append((section, label, symbol, symbol, False))
    syms = tuple(quote_symbol for _, _, quote_symbol, _, _ in active_board if quote_symbol not in _GLOBAL_FRED_SERIES)
    if target:
        start = (target - _dt.timedelta(days=20)).isoformat()
        end = (target + _dt.timedelta(days=1)).isoformat()
        df = get_download(syms, start, end, "1d")
        reference_at, interval, intraday = None, "1d", False
    else:
        reference_at, interval, intraday = _global_window(window, now)
        # Pad enough for weekends/holidays so the window base always resolves.
        pad_days = 3 if interval == "1d" else 2
        fetch_start = (reference_at.date() - _dt.timedelta(days=pad_days)).isoformat()
        fetch_end = (now.date() + _dt.timedelta(days=1)).isoformat()
        df = get_download(syms, fetch_start, fetch_end, interval, cache_ttl=120 if intraday else 300)
        # If live multi-ticker download was empty (contention / Yahoo blip), fall
        # back to daily bars so the board still paints instead of a long skeleton.
        if df.empty and interval != "1d":
            daily_start = (now.date() - _dt.timedelta(days=10)).isoformat()
            df = get_download(syms, daily_start, fetch_end, "1d", cache_ttl=300)
            if not df.empty:
                interval, intraday = "1d", False
                reference_at = now - _dt.timedelta(days=1)

    closes = _close_frame(df)
    fred_series: dict[str, pd.Series] = {}
    try:
        import fred as _fred
        for symbol, series_id in _GLOBAL_FRED_SERIES.items():
            observations = _fred.observations(series_id, 300)
            if observations:
                fred_series[symbol] = pd.Series(
                    [observation["value"] for observation in observations],
                    index=pd.to_datetime([observation["date"] for observation in observations]),
                    dtype=float,
                )
    except Exception:
        pass
    sections: dict[str, list] = {s: [] for s in _GLOBAL_SECTIONS}
    for section, label, quote_symbol, canonical_symbol, is_cme_proxy in active_board:
        if quote_symbol in fred_series:
            series = fred_series[quote_symbol]
        elif closes is not None and quote_symbol in closes.columns:
            series = closes[quote_symbol].dropna()
        else:
            series = pd.Series(dtype=float)
        row = {
            "label": label, "symbol": canonical_symbol, "quote_symbol": quote_symbol,
            "is_cme_proxy": is_cme_proxy, "price": None, "change_pct": None,
            "change_abs": None, "spark": [], "status": "unavailable", "as_of": None,
        }
        if not series.empty:
            try:
                if target:
                    on_day = series[[d.date() == target for d in series.index]]
                    before = series[[d.date() < target for d in series.index]]
                    if not on_day.empty:
                        price, base = float(on_day.iloc[-1]), float(before.iloc[-1]) if not before.empty else None
                        source = series[[d.date() <= target for d in series.index]]
                        row["status"] = "end_of_day"
                        row["as_of"] = _iso_timestamp(on_day.index[-1])
                    else:
                        price, base, source = None, None, before
                else:
                    price = float(series.iloc[-1])
                    source = series
                    last_at = pd.Timestamp(series.index[-1])
                    if last_at.tzinfo is not None:
                        last_at = last_at.tz_convert("UTC").tz_localize(None)
                    has_window = last_at > pd.Timestamp(reference_at)
                    prior = series[series.index <= pd.Timestamp(reference_at)] if has_window else pd.Series(dtype=float)
                    base = float(prior.iloc[-1]) if not prior.empty else None
                    # If the window base is missing (holiday gap), use previous bar.
                    if base is None and len(series) >= 2:
                        base = float(series.iloc[-2])
                    row["status"] = "intraday" if intraday and now - last_at <= _dt.timedelta(minutes=20) else "delayed" if intraday else "end_of_day"
                    row["as_of"] = _iso_timestamp(last_at)
                row["price"] = round(price, 4) if price is not None else None
                row["change_abs"] = round(price - base, 4) if price is not None and base is not None else None
                row["change_pct"] = round((price / base - 1) * 100, 2) if price is not None and base else None
                row["spark"] = [round(float(v), 4) for v in source.tail(10)]
            except Exception:
                pass
        sections[section].append(row)

    return {
        "sections": [{"name": n, "rows": sections[n]} for n in _GLOBAL_SECTIONS],
        "as_of": _dt.datetime.now(_dt.timezone.utc).isoformat(),
        "date": target.isoformat() if target else None,
        "window": "1d" if target else window,
        "refresh_seconds": 120 if intraday and not target else 300,
        "americas_mode": "cme_futures" if use_cme_futures else "cash_indices",
    }


def _session_closes(closes) -> "tuple[float | None, float | None, bool]":
    """Latest daily close, the close before it, and whether today's bar exists.

    One rule for every surface that reports a 1-day move. /quote and /quotes
    each guarded on has_today while overnight-moves took closes.iloc[-1]
    unguarded, so once today's bar landed it measured the last print against
    today's own close and called that an overnight gap. Three surfaces then
    printed three different 1-day changes for the same name at the same instant.
    """
    if closes is None or len(closes) == 0:
        return None, None, False
    regular_close = float(closes.iloc[-1])
    prior = float(closes.iloc[-2]) if len(closes) >= 2 else None
    try:
        has_today = closes.index[-1].date() == now_et().date()
    except Exception:
        has_today = False
    return regular_close, prior, has_today


def _prior_session_close(closes) -> "float | None":
    """The close a 1-day move is measured from.

    Today's bar, once it exists, is the current session, so the baseline is the
    bar before it. Before it exists the last bar IS the prior close.
    """
    regular_close, prior, has_today = _session_closes(closes)
    return prior if (has_today and prior is not None) else regular_close


def _try_history_quote(sym: str) -> dict | None:
    """Last known price and the move that produced it.

    Outside regular hours the daily bar has stopped moving, so the extended-hours
    print is used instead — otherwise a portfolio reports yesterday's number all
    evening. The baseline for the percentage depends on whether today's daily bar
    exists yet: after the close it does, so the day's move is measured from the
    prior close and the after-hours move is included on top; pre-market it does
    not, so the last bar IS the prior close and the move is the pre-market move.
    Getting that wrong reports a two-day move as a one-day move every morning.
    """
    try:
        hist = _cached_history(sym, period="5d")
        closes = hist["Close"].dropna() if not hist.empty else None
        if closes is None or closes.empty:
            return None

        label = session_label()
        regular_close, _prior, _has_today = _session_closes(closes)
        # After the close today's bar exists, so the day's move runs from the
        # prior close and any after-hours move stacks on top. Pre-market it does
        # not, so the last bar IS the prior close.
        baseline = _prior_session_close(closes)

        price = regular_close
        extended = None
        as_of = None
        if not is_market_open():
            quote = extended_quotes.extended_quote(sym)
            if quote.get("price"):
                extended = float(quote["price"])
                as_of = quote.get("as_of")
                price = extended

        pct_1d = float((price / baseline - 1) * 100) if baseline else None

        out = {
            "current_price": round(price, 2),
            "pct_change_1d": round(pct_1d, 3) if pct_1d is not None else None,
            "session": label,
            # The basis and the baseline travel with the number. A surface that
            # renders this price beside a percentage from a different endpoint
            # can now tell that it is mixing two answers.
            "basis": "extended" if extended is not None else "regular_close",
            "prior_close": round(baseline, 4) if baseline else None,
        }
        if extended is not None:
            out["regular_close"] = round(regular_close, 2)
            out["extended_pct"] = round((extended / regular_close - 1) * 100, 3) if regular_close else None
            out["as_of"] = as_of
        return out
    except Exception:
        pass
    return None


# Symbols where the free chain (yfinance, with its own internal FMP/AV
# fallback) has already failed once — skip straight to the SerpAPI fallback
# next time instead of re-paying the latency of a chain we already know
# fails for this name. This is a latency fix, not a budget one: SerpAPI's own
# quote() cache already prevents re-spending on a repeat symbol regardless.
_UNCOVERED_TTL = 7 * 86400


@router.get("/quote/{ticker}")
def get_quote(ticker: str):
    from disk_cache import disk_get, disk_set
    sym = validate_ticker(ticker)
    uncovered_key = f"quote:uncovered:{sym}"
    skip_free_chain = bool(disk_get(uncovered_key))

    if not skip_free_chain:
        got = _try_history_quote(sym)
        if got:
            return got
        # One brief retry before spending SerpAPI budget — a lot of "the whole
        # free chain failed" moments are transient (yfinance's 2-slot semaphore
        # busy for a moment, FMP momentarily 429'd), not a genuine "this symbol
        # isn't covered" case, and a couple of seconds is often enough for that
        # contention to clear.
        time.sleep(2)
        got = _try_history_quote(sym)
        if got:
            return got
        disk_set(uncovered_key, True, ttl=_UNCOVERED_TTL)

    # Fallback: Google Finance resolves instruments yfinance cannot (some
    # international tickers, FX, funds). Budget-gated and cached in the client.
    gf = serpapi_finance.resolve(sym)
    if gf:
        return {
            "current_price": round(gf["price"], 2),
            "pct_change_1d": gf.get("change_pct"),
            "source": "google_finance",
        }
    # SerpAPI failed too (budget spent, or genuinely no data) — the "uncovered"
    # marker was premature; clear it so the next request tries the free chain
    # fresh rather than being locked out of it for a week over a fluke.
    if skip_free_chain:
        try:
            from disk_cache import _delete as _disk_delete
            _disk_delete(uncovered_key)
        except Exception:
            pass
    raise HTTPException(404, "Could not fetch quote")


@router.get("/quotes")
@cached(ttl=5, maxsize=64)
def get_quotes(tickers: str):
    """Quote a whole portfolio with one bounded market-data request.

    Portfolio Manager used to fan out one /quote call per row. A 15-name book
    therefore queued behind the two-slot yfinance semaphore and then multiplied
    fallback vendor traffic. One batch preserves a consistent as-of point and
    prevents a slow symbol from blanking unrelated holdings.
    """
    symbols = validate_tickers(
        [ticker.strip() for ticker in tickers.split(",") if ticker.strip()][:50],
        max_count=50,
    )
    if not symbols:
        return {"quotes": {}, "source": "batch_history"}
    today = _dt.date.today()
    frame = get_download(
        tuple(symbols),
        (today - _dt.timedelta(days=10)).isoformat(),
        (today + _dt.timedelta(days=1)).isoformat(),
        "1d",
        cache_ttl=30,
    )
    closes = _close_frame(frame)
    extended_by_symbol: dict[str, dict] = {}
    overnight_by_symbol: dict[str, dict] = {}
    live_by_symbol: dict[str, float] = {}
    regular_live_by_symbol: dict[str, float] = {}
    crypto_live_symbols: set[str] = set()
    market_open = is_market_open()
    session = session_label()
    overnight_active = is_overnight_session()
    use_extended_marks = not market_open and session in {"pre-market", "after-hours"}
    if market_open:
        # The daily bar above is a still-forming, delayed candle while the session
        # runs, so a fast poll would re-read the same stale close all afternoon.
        # Alpaca's real-time last trade is the actual mark when the market is open.
        # Batch equities in one request; crypto is 24/7 so it needs the same
        # treatment (Binance, keyless, 1s-cached). Deliberately NOT falling back to
        # yfinance fast_info per symbol here — that would fan out unbounded calls
        # against the 2-slot budget on every poll.
        import quotes
        regular_live_by_symbol = dict(alpaca.get_latest_prices(tuple(symbols)))
        for symbol in symbols:
            if symbol.endswith("-USD") and symbol not in regular_live_by_symbol:
                crypto_last = quotes.live_price(symbol)
                if crypto_last:
                    regular_live_by_symbol[symbol] = float(crypto_last)
                    crypto_live_symbols.add(symbol)
    if overnight_active:
        # Alpaca's free overnight feed is a real-time indicative quote, not a
        # BOATS trade. Preserve that distinction in the returned source.
        overnight_by_symbol = alpaca.get_latest_overnight_quotes(tuple(symbols))
        live_by_symbol = {symbol: quote["price"] for symbol, quote in overnight_by_symbol.items() if quote.get("price")}
    elif use_extended_marks:
        # Daily history stops at the regular close. Use the same extended-hours
        # source as individual quotes and option re-marks, without exceeding the
        # process-wide yfinance budget.
        live_by_symbol = alpaca.get_latest_prices(tuple(symbols))
        fallback_symbols = [symbol for symbol in symbols if symbol not in live_by_symbol]
        with ThreadPoolExecutor(max_workers=2) as pool:
            extended_by_symbol = dict(zip(fallback_symbols, pool.map(extended_quotes.extended_quote, fallback_symbols)))
    quotes: dict[str, dict] = {}
    for symbol in symbols:
        series = pd.Series(dtype=float)
        if closes is not None:
            if symbol in closes.columns:
                series = closes[symbol].dropna()
            elif len(symbols) == 1 and not closes.empty:
                series = closes.iloc[:, 0].dropna()
        if series.empty:
            quotes[symbol] = {"current_price": None, "pct_change_1d": None, "source": "unavailable"}
            continue
        regular_close, prior, has_today = _session_closes(series)
        extended = extended_by_symbol.get(symbol, {})
        overnight = overnight_by_symbol.get(symbol, {})
        live_price = live_by_symbol.get(symbol)
        regular_live = regular_live_by_symbol.get(symbol)
        extended_price = live_price or extended.get("price")
        price = float(regular_live) if regular_live else (float(extended_price) if extended_price else regular_close)
        # A closing daily bar should still report its regular-session move when
        # no extended print is available. With an after-hours print, stack that
        # print on the prior close. With a pre-market print, compare it with the
        # prior session's close. A real-time in-session mark measures against the
        # prior close too, but the daily series may not carry today's bar yet, in
        # which case its last row IS the prior close.
        if regular_live:
            baseline = prior if (has_today and prior is not None) else regular_close
        else:
            baseline = (
                prior if not extended_price else
                (prior if has_today and prior is not None else regular_close)
            )
        quote = {
            "current_price": round(price, 2),
            "pct_change_1d": round((price / baseline - 1) * 100, 3) if baseline else None,
            # Same contract as /quote: the basis and the baseline ride with the
            # number so a caller cannot pair this price with another endpoint's
            # percentage without noticing.
            "basis": "live" if regular_live else ("extended" if extended_price else "regular_close"),
            "prior_close": round(baseline, 4) if baseline else None,
            "source": (
                ("crypto_realtime" if symbol in crypto_live_symbols else "alpaca_realtime") if regular_live else
                "alpaca_overnight_indicative" if overnight else
                "alpaca_extended" if live_price else
                "extended_hours" if extended_price else "batch_history"
            ),
            "session": session,
        }
        if extended_price:
            quote.update({
                "regular_close": round(regular_close, 2),
                "extended_pct": round((price / regular_close - 1) * 100, 3) if regular_close else None,
                "as_of": overnight.get("as_of") or extended.get("as_of"),
            })
        quotes[symbol] = quote
    source = "batch_history"
    if any(q.get("source") in {"alpaca_realtime", "crypto_realtime"} for q in quotes.values()):
        source = "realtime"
    elif any(q.get("source") == "alpaca_overnight_indicative" for q in quotes.values()):
        source = "alpaca_overnight_indicative"
    elif any(q.get("source") in {"alpaca_extended", "extended_hours"} for q in quotes.values()):
        source = "extended_hours"
    return {"quotes": quotes, "source": source}


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


def _get_history(ticker: str, start: str | None = None) -> pd.DataFrame:
    # An explicit start bypasses the "5y" bucket entirely (cache.get_history honors
    # start/end verbatim) so a caller asking for 2020-01-01 actually gets 2020-01-01
    # instead of being silently clipped to the last 5 years.
    df = _cached_history(ticker, period="max", start=start) if start else _cached_history(ticker, period="5y")
    if df.empty:
        return pd.DataFrame()
    df = df.rename(columns={"Close": "close"})
    return df[["close"]].dropna()


# Resolution chosen from the requested span so short windows get intraday bars
# instead of a handful of daily points. Returns (yfinance interval, bars-per-year
# for annualising vol, bars-per-trading-day, is_intraday). yfinance intraday caps:
# 5m ~60d, 30m ~60d, 60m ~730d — every branch stays inside its cap.
_TRADING_DAYS = 252
_INTRADAY_HISTORY_WINDOWS = {
    "10m": 10,
    "30m": 30,
    "1h": 60,
}


def _history_resolution(span_days: "int | None"):
    if span_days is None or span_days > 90:
        return ("1d", _TRADING_DAYS, 1, False)
    if span_days <= 5:
        return ("5m", 78 * _TRADING_DAYS, 78, True)
    if span_days <= 30:
        return ("30m", 13 * _TRADING_DAYS, 13, True)
    return ("60m", round(6.5 * _TRADING_DAYS), 7, True)


@router.get("/history")
def get_history(ticker: str, start: str | None = None, end: str | None = None, window: str | None = None):
    ticker = validate_ticker(ticker)
    if window and (start or end):
        raise HTTPException(400, "window cannot be combined with start or end")
    if window and window not in _INTRADAY_HISTORY_WINDOWS:
        raise HTTPException(400, "unsupported intraday window")
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
    if window:
        end_at = _dt.datetime.now(_dt.timezone.utc)
        start_at = end_at - _dt.timedelta(minutes=_INTRADAY_HISTORY_WINDOWS[window])
        yf_int, bars_per_year, bars_per_day, intraday = "1m", 390 * _TRADING_DAYS, 390, True
        import yfinance as yf
        try:
            raw = yf.Ticker(ticker).history(start=start_at, end=end_at + _dt.timedelta(minutes=1), interval=yf_int, auto_adjust=True)
            if not raw.empty:
                df = raw.rename(columns={"Close": "close"})[["close"]].dropna()
                if df.index.tz is not None:
                    df.index = df.index.tz_convert("UTC")
        except Exception:
            df = None
        if df is None or df.empty:
            raise HTTPException(404, "No intraday data in requested window")
    elif intraday and start and end:
        end_excl = (_dt.date.fromisoformat(end) + _dt.timedelta(days=1)).isoformat()
        # Alpaca first for equities (real per-minute intraday, deeper than yfinance).
        if alpaca.available() and alpaca.is_equity(ticker):
            atf = {"5m": "5m", "15m": "15m", "30m": "30m", "60m": "1h"}.get(yf_int)
            if atf:
                adf = alpaca.history_df(ticker, atf, start, end_excl)
                if not adf.empty:
                    df = adf.rename(columns={"Close": "close"})[["close"]].dropna()
        if df is None or df.empty:
            import yfinance as yf
            try:
                raw = yf.Ticker(ticker).history(start=start, end=end_excl, interval=yf_int)
                if not raw.empty:
                    df = raw.rename(columns={"Close": "close"})[["close"]].dropna()
            except Exception:
                df = None

    # Daily path — also the fallback when intraday is unavailable for the window
    # (e.g. a short range older than the provider's intraday cap).
    if df is None or df.empty:
        intraday, bars_per_year = False, _TRADING_DAYS
        df = _get_history(ticker, start=start)
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
        "meta": {"interval": yf_int, "intraday": intraday, "vol_window": int(win), "window": window, "as_of": _iso_timestamp(prices.index[-1]), "source": "Yahoo Finance", "data_status": "latest" if intraday else "end_of_day"},
    }


@router.get("/beta-suite")
def beta_suite(ticker: str, start: str | None = None, end: str | None = None, model: str = "ff3"):
    """Computed CAPM + Scholes-Williams beta, FF3/FF4 style loadings, and
    IVOL/TVOL for a single ticker, regressed against Ken French factors —
    real regression output, not the vendor `beta` field. Falls back to the
    vendor beta, labeled as such, when there isn't enough price history to
    regress (e.g. a recent IPO)."""
    sym = validate_ticker(ticker)
    if model not in ("ff3", "ff4"):
        raise HTTPException(400, "model must be 'ff3' or 'ff4'")
    end = end or _dt.date.today().isoformat()
    start = start or (_dt.date.today() - _dt.timedelta(days=3 * 365)).isoformat()
    validate_date(start); validate_date(end)

    try:
        returns = fm.stock_returns(sym, start, end, "daily")
    except Exception:
        raise HTTPException(500, "Internal server error")

    if returns.empty or len(returns) < 20:
        info = get_info(sym)
        raw_beta = info.get("beta") if info.get("beta") is not None else info.get("beta3Year")
        vendor_beta = round(float(raw_beta), 2) if isinstance(raw_beta, (int, float)) else None
        return {
            "ticker": sym, "available": False,
            "reason": "insufficient price history to regress",
            "vendor_beta": vendor_beta,
            "vendor_beta_source": "yfinance (unlabeled methodology)" if vendor_beta is not None else None,
        }

    result = fm.compute_beta_suite(returns, frequency="daily", model=model)
    capm_beta = result["capm"].get("betas", {}).get("mktrf") if result["capm"].get("available") else None
    sw_beta = result["scholes_williams"].get("beta") if result["scholes_williams"].get("available") else None
    divergence = round(abs(sw_beta - capm_beta) / abs(capm_beta) * 100, 1) if capm_beta and sw_beta is not None else None

    result["ticker"] = sym
    result["available"] = True
    result["beta_divergence_pct"] = divergence
    result["thin_trading_flag"] = bool(divergence is not None and divergence >= _THIN_TRADING_DIVERGENCE_PCT)
    return result


_COMPARE_PERIOD_DAYS = {"1m": 31, "3m": 92, "6m": 183, "1y": 366, "2y": 731, "5y": 1827}
# Intraday periods need an intraday bar interval, not just a shorter daily window —
# (yfinance interval, lookback days to fetch).
_COMPARE_INTRADAY = {"1d": ("5m", 2), "1w": ("30m", 8)}

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
    interval = "1d"
    if period in _COMPARE_INTRADAY:
        interval, lookback_days = _COMPARE_INTRADAY[period]
        start = today - _dt.timedelta(days=lookback_days)
    elif period == "ytd":
        start = _dt.date(today.year, 1, 1)
    elif period == "max":
        start = today - _dt.timedelta(days=365 * 15)
    else:
        start = today - _dt.timedelta(days=_COMPARE_PERIOD_DAYS.get(period, 366))
    end = today + _dt.timedelta(days=1)

    try:
        raw = get_download(tuple(sorted(allsyms)), str(start), str(end), interval=interval)
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
    intraday = period in _COMPARE_INTRADAY
    for d, row in out.iterrows():
        ts = pd.Timestamp(d)
        rec = {"date": ts.isoformat() if intraday else str(ts.date())}
        for s in cols:
            v = row[s]
            rec[s] = round(float(v), 4) if pd.notna(v) else None
        series.append(rec)

    return {"period": period, "normalize": normalize, "tickers": prim_avail,
            "overlays": sec_avail + fred_avail, "series": series, "meta": meta, "axis": axis}


def _daily_pe_from_backlog(ticker: str) -> list:
    """Daily P/E = close / TTM EPS, from the banked EPS quarters + cached price
    history. Zero FMP calls once the backlog exists, and daily resolution beats
    FMP's quarterly ratio snapshots."""
    import fmp as _fmp
    quarters = _fmp.get_fundamental_series(ticker, "eps", "quarter", 24)
    if len(quarters) < 2:
        # No FMP backlog yet — seed from yfinance reported EPS (chart-events).
        # Report dates also avoid look-ahead bias vs fiscal quarter-ends.
        try:
            ev = chart_events(ticker)
            quarters = [{"date": e["date"], "value": e["eps"]}
                        for e in ev.get("earnings", []) if e.get("eps") is not None]
        except Exception:
            quarters = []
    if len(quarters) < 2:
        return []
    q = sorted(quarters, key=lambda p: p["date"])
    import datetime as _dt
    gaps = [( _dt.date.fromisoformat(q[i + 1]["date"]) - _dt.date.fromisoformat(q[i]["date"])).days
            for i in range(len(q) - 1)]
    quarterly = sorted(gaps)[len(gaps) // 2] < 150
    ttm: list[tuple[str, float]] = []
    if quarterly:
        for i in range(3, len(q)):
            ttm.append((q[i]["date"], sum(float(q[j]["value"]) for j in range(i - 3, i + 1))))
    else:
        ttm = [(p["date"], float(p["value"])) for p in q]
    if not ttm:
        return []

    hist = _cached_history(ticker, period="5y")
    if hist.empty:
        return []
    closes = hist["Close"].dropna()
    pts, i = [], 0
    for d, close in closes.items():
        ds = str(d.date())
        while i + 1 < len(ttm) and ttm[i + 1][0] <= ds:
            i += 1
        if ttm[i][0] <= ds and ttm[i][1] > 0:
            pts.append({"date": ds, "value": round(float(close) / ttm[i][1], 2)})
    return pts


# ── yfinance-native fallback for the standardized ratio registry ───────────────
# FMP's shared daily quota (~250 calls/day across the whole app) sometimes runs
# out, at which point every ratio it serves (P/B, P/S, EV/EBITDA, margins, ROE,
# …) goes dark simultaneously, even for tickers FMP has served before, because a
# transient failure used to get cached as a false "no data" for 24h (fixed
# separately). yfinance's own quarterly statements carry no such shared budget,
# so this recomputes the same ratios locally as a fallback — at the cost of only
# ~5-6 quarters of free history (vs FMP's much deeper backlog when it's up), so
# it's used only when FMP itself comes back empty, not as the primary source.
_YF_QSTMT_TTL = 86400
_YF_BS_FIELDS = ["Stockholders Equity", "Total Debt", "Cash Cash Equivalents And Short Term Investments",
                 "Total Assets", "Current Assets", "Current Liabilities", "Ordinary Shares Number", "Invested Capital"]
_YF_INC_FIELDS = ["Total Revenue", "Gross Profit", "Operating Income", "Net Income", "EBITDA"]
_YF_CF_FIELDS = ["Free Cash Flow"]


def _yf_quarterly_statements(ticker: str) -> dict:
    from disk_cache import disk_get, disk_set
    sym = ticker.strip().upper()
    ck = f"yf:qstmt:{sym}"
    cached = disk_get(ck)
    if cached is not None:
        return cached
    import yfinance as yf
    t = yf.Ticker(sym)

    def _quarters(df, fields: list) -> list:
        if df is None or df.empty:
            return []
        out = []
        for d in sorted(df.columns):
            col = df[d]
            row = {"date": str(d.date())}
            ok = False
            for f in fields:
                v = col.get(f)
                if v is not None and not pd.isna(v):
                    row[f] = float(v)
                    ok = True
            if ok:
                out.append(row)
        return out

    try:
        bs = _run_yf(f"qbs {sym}", lambda: t.quarterly_balance_sheet)
        inc = _run_yf(f"qinc {sym}", lambda: t.quarterly_income_stmt)
        cf = _run_yf(f"qcf {sym}", lambda: t.quarterly_cashflow)
        out = {"balance": _quarters(bs, _YF_BS_FIELDS), "income": _quarters(inc, _YF_INC_FIELDS),
               "cashflow": _quarters(cf, _YF_CF_FIELDS)}
    except Exception:
        out = {}
    disk_set(ck, out, ttl=_YF_QSTMT_TTL)
    return out


def _yf_field_series(rows: list, field: str) -> list:
    return [(r["date"], r[field]) for r in rows if field in r]


def _yf_ttm(rows: list, field: str) -> list:
    """Trailing-4-quarter sum, one point per quarter once 4 quarters exist."""
    s = _yf_field_series(rows, field)
    if len(s) < 4:
        return []
    return [(s[i][0], sum(v for _, v in s[i - 3:i + 1])) for i in range(3, len(s))]


def _yf_step_cursor(series: list, ds: str, cursor: list) -> float | None:
    if not series:
        return None
    while cursor[0] + 1 < len(series) and series[cursor[0] + 1][0] <= ds:
        cursor[0] += 1
    return series[cursor[0]][1] if series[cursor[0]][0] <= ds else None


def _yf_daily_multiple(ticker: str, combine, *series_list) -> list:
    """Daily series: for each price-history date, step each quarterly series
    forward to its latest value at/before that date, then combine(close, *vals)."""
    hist = _cached_history(ticker, period="5y")
    if hist.empty:
        return []
    closes = hist["Close"].dropna()
    cursors = [[0] for _ in series_list]
    pts = []
    for d, close in closes.items():
        ds = str(d.date())
        vals = [_yf_step_cursor(s, ds, c) for s, c in zip(series_list, cursors)]
        if any(v is None for v in vals):
            continue
        v = combine(float(close), *vals)
        if v is not None:
            pts.append({"date": ds, "value": round(v, 3)})
    return pts


def _yf_margin_series(inc_rows: list, num_field: str, den_field: str) -> list:
    out = []
    for r in inc_rows:
        n, d = r.get(num_field), r.get(den_field)
        if n is not None and d:
            out.append({"date": r["date"], "value": round(n / d * 100, 3)})
    return out


def _yf_align_ttm_to_balance(ttm_num: list, bal_rows: list, den_field: str, scale: float = 1.0) -> list:
    """Align a TTM numerator series to the nearest balance-sheet snapshot at/before
    each date, dividing by den_field there."""
    den_map = sorted((r["date"], r[den_field]) for r in bal_rows if den_field in r)
    out, j = [], 0
    for d, v in ttm_num:
        while j + 1 < len(den_map) and den_map[j + 1][0] <= d:
            j += 1
        if den_map and den_map[j][0] <= d and den_map[j][1]:
            out.append({"date": d, "value": round(v / den_map[j][1] * scale, 3)})
    return out


def _yf_point_ratio_series(bal_rows: list, num_field: str, den_field: str) -> list:
    out = []
    for r in bal_rows:
        n, d = r.get(num_field), r.get(den_field)
        if n is not None and d:
            out.append({"date": r["date"], "value": round(n / d, 3)})
    return out


def _yf_dividend_yield_series(ticker: str) -> list:
    import yfinance as yf
    try:
        divs = _run_yf(f"dividends {ticker}", lambda: yf.Ticker(ticker).dividends)
    except Exception:
        return []
    if divs is None or divs.empty:
        return []
    hist = _cached_history(ticker, period="5y")
    if hist.empty:
        return []
    closes = hist["Close"].dropna()
    div_dates = [d.tz_localize(None) if d.tzinfo else d for d in divs.index]
    div_vals = list(divs.values)
    pts = []
    for d, close in closes.items():
        dd = d.tz_localize(None) if d.tzinfo else d
        cutoff = dd - pd.Timedelta(days=365)
        ttm_div = sum(v for dt, v in zip(div_dates, div_vals) if cutoff < dt <= dd)
        if ttm_div and close:
            pts.append({"date": str(d.date()), "value": round(ttm_div / float(close) * 100, 3)})
    return pts


def _yf_ratio_series(ticker: str, metric: str) -> list:
    stmt = _yf_quarterly_statements(ticker)
    if not stmt:
        return []
    bal, inc, cf = stmt["balance"], stmt["income"], stmt["cashflow"]

    if metric == "pb":
        eq, sh = _yf_field_series(bal, "Stockholders Equity"), _yf_field_series(bal, "Ordinary Shares Number")
        return _yf_daily_multiple(ticker, lambda c, e, s: c / (e / s) if e and s else None, eq, sh)
    if metric == "ps":
        rev, sh = _yf_ttm(inc, "Total Revenue"), _yf_field_series(bal, "Ordinary Shares Number")
        return _yf_daily_multiple(ticker, lambda c, r, s: c / (r / s) if r and s else None, rev, sh)
    if metric == "p_fcf":
        fcf, sh = _yf_ttm(cf, "Free Cash Flow"), _yf_field_series(bal, "Ordinary Shares Number")
        return _yf_daily_multiple(ticker, lambda c, f, s: c / (f / s) if f and s else None, fcf, sh)
    if metric == "ev_ebitda":
        ebitda = _yf_ttm(inc, "EBITDA")
        sh, debt, cash = (_yf_field_series(bal, "Ordinary Shares Number"), _yf_field_series(bal, "Total Debt"),
                          _yf_field_series(bal, "Cash Cash Equivalents And Short Term Investments"))
        def combine(c, e, s, d, ca):
            return (c * s + (d or 0) - (ca or 0)) / e if e and s else None
        return _yf_daily_multiple(ticker, combine, ebitda, sh, debt, cash)
    if metric == "ev_sales":
        rev = _yf_ttm(inc, "Total Revenue")
        sh, debt, cash = (_yf_field_series(bal, "Ordinary Shares Number"), _yf_field_series(bal, "Total Debt"),
                          _yf_field_series(bal, "Cash Cash Equivalents And Short Term Investments"))
        def combine(c, r, s, d, ca):
            return (c * s + (d or 0) - (ca or 0)) / r if r and s else None
        return _yf_daily_multiple(ticker, combine, rev, sh, debt, cash)
    if metric == "gross_margin":
        return _yf_margin_series(inc, "Gross Profit", "Total Revenue")
    if metric == "operating_margin":
        return _yf_margin_series(inc, "Operating Income", "Total Revenue")
    if metric == "net_margin":
        return _yf_margin_series(inc, "Net Income", "Total Revenue")
    if metric == "roe":
        return _yf_align_ttm_to_balance(_yf_ttm(inc, "Net Income"), bal, "Stockholders Equity", 100)
    if metric == "roa":
        return _yf_align_ttm_to_balance(_yf_ttm(inc, "Net Income"), bal, "Total Assets", 100)
    if metric == "roic":
        # NOPAT approximated as TTM operating income at a flat 21% statutory tax
        # rate — FMP's own methodology isn't public, so this is a labeled estimate.
        op_ttm = [(d, v * 0.79) for d, v in _yf_ttm(inc, "Operating Income")]
        return _yf_align_ttm_to_balance(op_ttm, bal, "Invested Capital", 100)
    if metric == "debt_equity":
        return _yf_point_ratio_series(bal, "Total Debt", "Stockholders Equity")
    if metric == "current_ratio":
        return _yf_point_ratio_series(bal, "Current Assets", "Current Liabilities")
    if metric == "dividend_yield":
        return _yf_dividend_yield_series(ticker)
    if metric == "fcf_yield":
        fcf, sh = _yf_ttm(cf, "Free Cash Flow"), _yf_field_series(bal, "Ordinary Shares Number")
        return _yf_daily_multiple(ticker, lambda c, f, s: (f / s) / c * 100 if f and s and c else None, fcf, sh)
    return []


@router.get("/fundamental-series")
def fundamental_series(ticker: str, metric: str = "pe", period: str = "quarter"):
    """Time series of a standardized multiple/ratio (P/E, EV/EBITDA, P/S, P/B, ROE,
    ROIC, margins, D/E, yields) for chart overlays — all size-neutral and comparable
    across companies. Also serves absolute fundamentals (revenue, FCF, …) if requested."""
    ticker = validate_ticker(ticker)
    import fmp as _fmp

    # P/E computes locally from the banked EPS quarters + price history, so it
    # works at daily resolution even when FMP is throttled or down.
    if metric == "pe":
        pts = _daily_pe_from_backlog(ticker)
        if pts:
            return {"ticker": ticker.upper(), "metric": "pe", "unit": "x", "points": pts,
                    "source": "close / TTM EPS (cached backlog)"}

    # Forward EPS estimates aren't available historically for free, so rather
    # than trusting yfinance's own precomputed forwardPE (frozen at whatever
    # point Yahoo last computed it) or emitting a single flat snapshot point
    # (which renders as a static line no matter how fresh the one value is),
    # this divides the CURRENT forward-EPS estimate into each day's close
    # over the trailing price history. The line then moves with price day to
    # day, at the cost of holding the estimate itself constant through the
    # window — a reasonable trade since the estimate moves far less than
    # price does, and revises only a few times a year.
    if metric == "forward_pe":
        info = get_info(ticker) or {}
        fwd_eps = info.get("forwardEps")
        hist = _cached_history(ticker, period="5y")
        if fwd_eps and not hist.empty:
            closes = hist["Close"].dropna()
            pts = [{"date": str(d.date()), "value": round(float(c) / float(fwd_eps), 2)} for d, c in closes.items()]
            if pts:
                return {"ticker": ticker.upper(), "metric": "forward_pe", "unit": "x", "points": pts,
                        "source": "daily close / current forward EPS estimate"}
        raise HTTPException(404, "No forward P/E available for this ticker")

    # Same principle as forward P/E, one step removed: there is no free
    # forward-EBITDA consensus field at all (unlike forwardEps), so this
    # approximates it from two real analyst inputs — next-year consensus
    # revenue (yfinance's revenue_estimate '+1y' row) times the trailing
    # EBITDA margin — then divides that into a daily live enterprise value
    # (shares outstanding × daily close, plus debt, minus cash) instead of
    # yfinance's own frozen enterpriseValue/enterpriseToEbitda snapshot.
    # Debt, cash, shares, and the margin are all held constant through the
    # window, same trade-off as holding forward EPS constant above — they
    # move far slower than price.
    if metric == "forward_ev_ebitda":
        import yfinance as yf
        info = get_info(ticker) or {}
        margin = info.get("ebitdaMargins")
        shares = info.get("sharesOutstanding")
        debt = info.get("totalDebt") or 0
        cash = info.get("totalCash") or 0
        try:
            rev_est = _run_yf(f"revenue_estimate {ticker}", lambda: yf.Ticker(ticker).revenue_estimate)
            fwd_rev = float(rev_est.loc["+1y", "avg"]) if rev_est is not None and "+1y" in rev_est.index else None
        except Exception:
            fwd_rev = None
        fwd_ebitda = fwd_rev * margin if fwd_rev and margin else None
        hist = _cached_history(ticker, period="5y")
        if fwd_ebitda and shares and not hist.empty:
            closes = hist["Close"].dropna()
            pts = [{"date": str(d.date()), "value": round((float(c) * float(shares) + debt - cash) / fwd_ebitda, 2)}
                   for d, c in closes.items()]
            if pts:
                return {"ticker": ticker.upper(), "metric": "forward_ev_ebitda", "unit": "x", "points": pts,
                        "source": "daily (shares x close + debt - cash) / (next-year consensus revenue x trailing EBITDA margin)"}
        raise HTTPException(404, "No forward EV/EBITDA available for this ticker")

    # Standardized ratios: try FMP first (deeper history when it's up), and fall
    # back to a locally-computed yfinance series — shorter history, but immune
    # to FMP's shared daily quota — whenever FMP is unavailable or comes back
    # empty (including while its quota is exhausted for the day).
    if metric in _fmp.RATIO_METRICS:
        pts = (_fmp.get_ratio_series(ticker, metric, period if period in ("quarter", "annual") else "annual", 16)
               if _fmp.available() else [])
        unit = "%" if _fmp._RATIO_REGISTRY[metric][2] else "x"
        source = "fmp"
        if not pts:
            pts = _yf_ratio_series(ticker, metric)
            source = "yfinance (fallback — fmp unavailable)"
        if not pts:
            raise HTTPException(404, "No data for this ticker/metric")
        return {"ticker": ticker.upper(), "metric": metric, "unit": unit, "points": pts, "source": source}

    if not _fmp.available():
        raise HTTPException(503, "Fundamentals data source unavailable")
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
    "15m": ("15m", "1mo", None,    True),
    "1h":  ("60m", "2y",  None,    True),    # was 3mo → 2y
    "2h":  ("60m", "2y",  "2h",    True),    # was 6mo → 2y
    "4h":  ("60m", "2y",  "4h",    True),
    "6h":  ("60m", "2y",  "6h",    True),    # was 1y → 2y
    "12h": ("60m", "2y",  "12h",   True),
    "1d":  ("1d",  "max", None,    False),   # full daily history back to inception
    "1wk": ("1wk", "10y", None,    False),   # was 5y → 10y
    "1mo": ("1mo", "max", None,    False),   # was 10y → max
}

# Alpaca intraday lookback per timeframe (days). Alpaca serves far deeper intraday
# than yfinance, but a chart doesn't need years of 1-min bars — cap per granularity
# so the response stays lean while still scrolling well past yfinance's caps.
_ALPACA_LOOKBACK_DAYS = {
    "1m": 30, "2m": 30, "3m": 30, "5m": 120, "10m": 120, "15m": 120, "30m": 120,
    "1h": 730, "2h": 730, "4h": 730, "6h": 730, "12h": 730,
    "1d": 3650, "1wk": 3650, "1mo": 3650,
}


def _alpaca_start(tf: str) -> str:
    import datetime as _d
    days = _ALPACA_LOOKBACK_DAYS.get(tf, 120)
    return (_d.date.today() - _d.timedelta(days=days)).isoformat()


@router.get("/ohlcv")
def get_ohlcv(ticker: str, period: str = "1y", interval: str = "1d", tf: str | None = None, prepost: bool = False):
    ticker = validate_ticker(ticker)
    if tf and tf in _TF:
        yf_int, yf_per, rule, intraday = _TF[tf]
        df = None
        # Alpaca first for equities: deep, native intraday (odd frames included), so
        # no resample needed. Falls through to yfinance when unavailable/empty.
        # Daily/weekly/monthly skip Alpaca entirely — its IEX feed is capped at
        # _ALPACA_LOOKBACK_DAYS (10y) while yfinance's period="max" below reaches
        # back to each ticker's actual listing date, which is strictly deeper.
        if intraday and alpaca.available() and alpaca.is_equity(ticker):
            adf = alpaca.history_df(ticker, tf, _alpaca_start(tf))
            if not adf.empty:
                df = adf
        if df is None:
            import yfinance as yf
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


@router.get("/chart-events")
@cached(ttl=6 * 3600, maxsize=64)
def chart_events(ticker: str):
    """Earnings dates (with EPS vs estimate), dividends and splits as
    time-mapped markers for the Chart Studio timeline."""
    ticker = validate_ticker(ticker)
    import yfinance as yf
    events: dict = {"earnings": [], "dividends": [], "splits": []}
    try:
        df = yf.Ticker(ticker).get_earnings_dates(limit=16)
        if df is not None and not df.empty:
            for ts, row in df.sort_index().iterrows():
                eps = row.get("Reported EPS")
                est = row.get("EPS Estimate")
                sur = row.get("Surprise(%)")
                events["earnings"].append({
                    "date": ts.date().isoformat(),
                    "eps": round(float(eps), 2) if pd.notna(eps) else None,
                    "estimate": round(float(est), 2) if pd.notna(est) else None,
                    "surprise_pct": round(float(sur), 1) if pd.notna(sur) else None,
                })
    except Exception:
        pass
    try:
        tk = yf.Ticker(ticker)
        div = tk.dividends
        if div is not None and len(div):
            events["dividends"] = [
                {"date": ts.date().isoformat(), "amount": round(float(v), 4)}
                for ts, v in div.tail(40).items()
            ]
        sp = tk.splits
        if sp is not None and len(sp):
            events["splits"] = [
                {"date": ts.date().isoformat(), "ratio": float(v)}
                for ts, v in sp.tail(10).items()
            ]
    except Exception:
        pass
    return {"ticker": ticker.upper(), **events}


@router.get("/live-quote")
def get_live_quote(ticker: str):
    """Freshest last price for the live chart-tick overlay — Alpaca IEX real-time for
    equities (Tradier fallback), yfinance fast_info for futures/crypto/FX. The /ohlcv
    candle history refreshes slowly (~1/min); this lets the forming bar tick every few
    seconds."""
    ticker = validate_ticker(ticker)
    import quotes
    last = quotes.live_price(ticker)
    if not last:   # None or 0 (halted / no-trade) — don't tick the chart to zero
        raise HTTPException(404, "No live quote")
    # The baseline ships with the price. Callers used to take the price from
    # here and the percentage from /quote, which meant a tile could show a price
    # that had moved up next to a red percentage anchored to a different source.
    prior_close = None
    try:
        hist = _cached_history(ticker, period="5d")
        prior_close = _prior_session_close(hist["Close"].dropna() if not hist.empty else None)
    except Exception:
        pass
    return {
        "ticker": ticker, "last": last, "basis": "live",
        "prior_close": round(prior_close, 4) if prior_close else None,
        "pct_change_1d": round((last / prior_close - 1) * 100, 3) if prior_close else None,
    }


@router.get("/overnight-moves")
@cached(ttl=20, maxsize=64)
def overnight_moves(tickers: str):
    """Prior close vs the freshest available price for a set of tickers — the
    gap block behind the Morning Brief's Overnight section. Outside the regular
    session the "last" print is whatever extended-hours trade is available
    (thin, easily stale), so the response carries a session bucket and an
    indicative flag rather than presenting pre/post-market prints with
    regular-session confidence. Caller (book + watchlist) caps the ticker list."""
    import market_hours
    import quotes
    syms = validate_tickers([t.strip() for t in tickers.split(",") if t.strip()], max_count=40)
    session = market_hours.session_label()
    rows = []
    for sym in syms:
        prior_close = None
        try:
            hist = _cached_history(sym, period="5d")
            closes = hist["Close"].dropna() if not hist.empty else None
            # An overnight gap runs from the last completed session's close.
            # This used to take closes.iloc[-1] unguarded, so once today's daily
            # bar existed it measured the last print against today's own close
            # and reported that as an overnight move, disagreeing with /quote
            # and /quotes on the same name at the same instant.
            prior_close = _prior_session_close(closes)
        except Exception:
            pass
        last = quotes.live_price(sym)
        row = {
            "ticker": sym,
            "prior_close": round(prior_close, 4) if prior_close is not None else None,
            "last": round(last, 4) if last else None,
            "basis": "live" if last else "regular_close",
            "change_abs": None,
            "change_pct": None,
        }
        if prior_close and last:
            row["change_abs"] = round(last - prior_close, 4)
            row["change_pct"] = round((last / prior_close - 1) * 100, 3)
        rows.append(row)
    return {
        "session": session,
        "indicative": session != "regular",
        "as_of": _dt.datetime.now(_dt.timezone.utc).isoformat(),
        "rows": rows,
    }


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
        # Every sector row prints a price and the benchmark row printed a dash,
        # which reads as missing data rather than as a field nobody supplied.
        "spy_price": round(float(spy.iloc[-1]), 2) if spy is not None and len(spy) else None,
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


@router.get("/asset-profile")
def asset_profile(ticker: str):
    """Range, return ladder and realised risk for one row of the board.

    Split from the constituent table on purpose. This is one download of one
    symbol and lands in about a second; pricing the S&P's 500 members takes
    Yahoo fifteen. Behind a single endpoint the fast half waits on the slow
    half and the whole panel sits empty.
    """
    validate_ticker(ticker)
    return {"ticker": ticker, "stats": _index_profile.asset_stats(ticker) or None}


@router.get("/index-constituents")
def index_constituents(ticker: str):
    """Members of an index priced live, with sector mix, breadth and
    concentration. Empty-but-explained for an index with no free member list,
    and silent for anything that is not an index."""
    validate_ticker(ticker)
    return {"ticker": ticker, "constituents": _index_profile.index_profile(ticker)}


@router.get("/breadth")
def market_breadth(index: str = "^GSPC"):
    """Participation behind an index move: advancers against decliners, new
    52-week extremes, the share of members above their 50 and 200-day averages,
    and the cumulative A/D line plotted against the index itself."""
    validate_ticker(index)
    return _breadth.breadth(index)


@router.get("/breadth/indices")
def market_breadth_indices():
    return {"indices": _breadth.tracked_indices()}


@router.get("/seasonality")
def market_seasonality(ticker: str, years: int = 20):
    """Month, weekday and turn-of-month patterns for one symbol, each reported
    with the sample size behind it."""
    validate_ticker(ticker)
    return _seasonality.seasonality(ticker.strip().upper(), max(2, min(int(years), 40)))


@router.get("/rrg")
def market_rrg(tickers: str = "", benchmark: str = "SPY", tail: int = 8):
    """Relative Rotation Graph coordinates. Defaults to the GICS sector ETFs,
    which is what the Sector Rotation screen plots."""
    syms = tuple(validate_tickers(tickers)) if tickers.strip() else tuple(t for t, _ in SECTORS)
    validate_ticker(benchmark)
    return _rrg.rrg(syms, benchmark.strip().upper(), max(2, min(int(tail), 20)))
