"""
Centralized caching layer for all yfinance and external API calls.
All routers import helpers from here to avoid repeated network round-trips.

Two load-shedding mechanisms sit in front of yfinance:
  1. TTL caches (below) collapse repeat calls for the same key.
  2. A BoundedSemaphore(2) caps concurrent yfinance execution so a burst can't
     spawn dozens of parallel network threads and OOM the 1GB prod VM. When the
     semaphore can't be acquired within YF_ACQUIRE_TIMEOUT, get_history routes to
     FMP then AlphaVantage instead of blocking; the lighter helpers degrade to an
     empty result (their existing failure mode).

TTLs:
  price history  — 5 min  (prices update frequently during market hours)
  fundamentals   — 15 min (info/earnings change infrequently)
  news           — 5 min
  rates/yield    — 10 min
"""
import os
import functools
import hashlib
import logging
import threading
from datetime import date, timedelta

import pandas as pd
import yfinance as yf
from cachetools import TTLCache

import alphavantage
import fmp
from disk_cache import disk_get, disk_set

logger = logging.getLogger(__name__)

_lock = threading.Lock()

# yfinance concurrency ceiling. The prod VM has OOM'd under parallel yfinance
# threads (2026-07-02 incident); 2 is the documented safe budget. acquire() blocks
# up to YF_ACQUIRE_TIMEOUT seconds, then callers fall back rather than pile up.
_YF_SEM = threading.BoundedSemaphore(2)
YF_ACQUIRE_TIMEOUT = float(os.getenv("YF_ACQUIRE_TIMEOUT", "6"))

# maxsize caps worst-case RSS: entries are full DataFrames (~100KB each for 5y
# daily), and the 1GB prod VM has OOM'd before. 200 ≈ 20MB ceiling.
_history_cache: TTLCache = TTLCache(maxsize=200, ttl=300)    # 5 min
_info_cache:    TTLCache = TTLCache(maxsize=200, ttl=900)     # 15 min
_news_cache:    TTLCache = TTLCache(maxsize=200, ttl=300)     # 5 min
_download_cache: TTLCache = TTLCache(maxsize=100, ttl=300)   # 5 min
_download_live_cache: TTLCache = TTLCache(maxsize=24, ttl=60)

# period -> lookback days, for converting a yfinance period into the explicit
# from/to range the FMP / AlphaVantage fallbacks require.
_PERIOD_DAYS = {
    "1d": 1, "5d": 5, "1mo": 31, "3mo": 93, "6mo": 186,
    "1y": 366, "2y": 731, "5y": 1827, "10y": 3653, "ytd": 366, "max": 3653,
}


class YFContention(RuntimeError):
    """Raised when the yfinance concurrency semaphore can't be acquired in time."""


def _run_yf(desc: str, fn):
    """Execute a yfinance call under the concurrency semaphore. Raises YFContention
    if the semaphore can't be acquired within YF_ACQUIRE_TIMEOUT so the caller can
    fall back (get_history) or degrade to empty (the lighter helpers)."""
    if not _YF_SEM.acquire(timeout=YF_ACQUIRE_TIMEOUT):
        logger.info("yfinance semaphore saturated for %s (>%ss) — yielding", desc, YF_ACQUIRE_TIMEOUT)
        raise YFContention(desc)
    try:
        return fn()
    finally:
        _YF_SEM.release()


def _key(prefix: str, args: tuple, kwargs: dict) -> str:
    raw = f"{prefix}|{args!r}|{sorted(kwargs.items())!r}"
    return prefix + ":" + hashlib.md5(raw.encode()).hexdigest()


def cached(ttl: int = 300, maxsize: int = 256, persist: bool = False, skip_if=None,
           version: int = 1):
    """
    Memoize an expensive function with a per-function TTL cache.

    Replaces the ad-hoc module-level TTLCache instances scattered across
    routers. Set persist=True to also back the result with the SQLite
    disk cache (survives restarts) — only for JSON-serializable returns
    (dicts/lists); DataFrames stay memory-only.

    Concurrent misses for the same key single-flight: only one caller runs
    the function; others wait on the same result (avoids stampede on cold
    cache for multi-second endpoints like the Global Markets board).

    The wrapper exposes .cache_clear() to flush the in-memory tier.

    skip_if(result) -> True means DO NOT store this result. Without it a
    transient upstream failure is cached for the full TTL, which for a 6h
    endpoint means one bad second at boot serves "unavailable" for the rest of
    the day. Callers whose payload can express failure should pass a predicate.

    version becomes part of the key. Bump it when the SHAPE of the payload
    changes, or a persisted result written by the previous build keeps being
    served for the whole TTL: a deploy that adds a field to a 6h-cached
    payload ships code whose output nobody sees until the next day.
    """
    def deco(fn):
        mem: TTLCache = TTLCache(maxsize=maxsize, ttl=ttl)
        flock = threading.Lock()
        inflight: dict[str, threading.Event] = {}
        prefix = f"{fn.__module__}.{fn.__qualname__}" + (f":v{version}" if version != 1 else "")

        @functools.wraps(fn)
        def wrapper(*args, **kwargs):
            k = _key(prefix, args, kwargs)
            with flock:
                if k in mem:
                    return mem[k]
                leader = k not in inflight
                if leader:
                    inflight[k] = threading.Event()
                wait_evt = inflight[k]
            if persist:
                hit = disk_get(k)
                if hit is not None:
                    with flock:
                        mem[k] = hit
                        evt = inflight.pop(k, None)
                    if evt is not None:
                        evt.set()
                    return hit
            if not leader:
                # Wait for the in-flight compute (bounded); then re-check cache.
                wait_evt.wait(timeout=max(ttl, 120))
                with flock:
                    if k in mem:
                        return mem[k]
                # Leader failed without caching — compute ourselves as backup.
            try:
                val = fn(*args, **kwargs)
            except Exception:
                if leader:
                    with flock:
                        inflight.pop(k, None)
                        wait_evt.set()
                raise
            store = not (skip_if is not None and skip_if(val))
            with flock:
                if store:
                    mem[k] = val
                if leader:
                    inflight.pop(k, None)
                    wait_evt.set()
            if persist and store:
                disk_set(k, val, ttl=ttl)
            return val

        wrapper.cache_clear = mem.clear
        return wrapper
    return deco


def _yf_history(sym: str, period: str, start: str | None, end: str | None) -> pd.DataFrame:
    tkr = yf.Ticker(sym)
    df = tkr.history(start=start, end=end) if (start or end) else tkr.history(period=period)
    if not df.empty and df.index.tz is not None:
        df.index = df.index.tz_localize(None)
    return df


def _resolve_range(period: str, start: str | None, end: str | None) -> tuple[str, str]:
    """Explicit (from, to) dates for the fallback providers. Honors an explicit
    start/end; otherwise derives a window from the yfinance period."""
    if start or end:
        return start or (date.today() - timedelta(days=366)).isoformat(), end or date.today().isoformat()
    days = _PERIOD_DAYS.get(period, 366)
    return (date.today() - timedelta(days=days)).isoformat(), date.today().isoformat()


def _history_fallback(sym: str, start: str, end: str, reason: str) -> pd.DataFrame:
    """Route a contended/empty yfinance history request to FMP, then AlphaVantage.
    First non-empty frame wins; all normalize to the yfinance OHLCV shape."""
    for name, fn in (("FMP", fmp.get_history_df), ("AlphaVantage", alphavantage.get_history_df)):
        try:
            df = fn(sym, start, end)
        except Exception as e:                # a provider fault must not abort the chain
            logger.warning("%s history fallback error for %s: %s", name, sym, e)
            continue
        if df is not None and not df.empty:
            logger.info("yfinance %s for %s — served by %s (%d rows)", reason, sym, name, len(df))
            return df
    logger.warning("yfinance %s for %s — all fallbacks empty", reason, sym)
    return pd.DataFrame()


def get_history(ticker: str, period: str = "1y",
                start: str | None = None, end: str | None = None) -> pd.DataFrame:
    sym = ticker.strip().upper()
    key = f"{sym}:{period}:{start}:{end}"
    with _lock:
        if key in _history_cache:
            logger.debug("history cache hit %s", key)
            return _history_cache[key]

    df = pd.DataFrame()
    contended = False
    try:
        df = _run_yf(f"history {sym}", lambda: _yf_history(sym, period, start, end))
    except YFContention:
        contended = True
    except Exception:
        df = pd.DataFrame()

    if df is None or df.empty:                # contended, or yfinance returned nothing
        f_start, f_end = _resolve_range(period, start, end)
        df = _history_fallback(sym, f_start, f_end, "contended" if contended else "empty")

    if not df.empty:                          # don't cache transient failures
        with _lock:
            _history_cache[key] = df
    return df


def get_info(ticker: str) -> dict:
    sym = ticker.strip().upper()
    with _lock:
        if sym in _info_cache:
            return _info_cache[sym]
    try:
        info = _run_yf(f"info {sym}", lambda: yf.Ticker(sym).info)
    except YFContention:
        logger.info("info %s deferred — yfinance saturated", sym)
        info = {}
    except Exception:
        info = {}
    if info:                              # don't cache transient failures
        with _lock:
            _info_cache[sym] = info
    return info


def get_news(ticker: str) -> list:
    sym = ticker.strip().upper()
    with _lock:
        if sym in _news_cache:
            return _news_cache[sym]
    try:
        news = _run_yf(f"news {sym}", lambda: yf.Ticker(sym).news) or []
    except YFContention:
        logger.info("news %s deferred — yfinance saturated", sym)
        news = []
    except Exception:
        news = []
    if news:                              # don't cache transient failures
        with _lock:
            _news_cache[sym] = news
    return news


# Single-flight events for multi-ticker downloads so concurrent Global Markets
# (and similar) loads share one Yahoo round-trip instead of N parallel ones.
_download_inflight: dict[tuple, threading.Event] = {}
_download_inflight_lock = threading.Lock()


def get_download(
    tickers: tuple,
    start: str,
    end: str,
    interval: str = "1d",
    cache_ttl: int = 300,
    *,
    auto_adjust: bool = True,
    actions: bool = False,
) -> pd.DataFrame:
    cache = _download_live_cache if cache_ttl <= 60 else _download_cache
    key = (tickers, start, end, interval, auto_adjust, actions)
    with _lock:
        if key in cache:
            return cache[key]

    with _download_inflight_lock:
        leader = key not in _download_inflight
        if leader:
            _download_inflight[key] = threading.Event()
        wait_evt = _download_inflight[key]
    if not leader:
        wait_evt.wait(timeout=90)
        with _lock:
            if key in cache:
                return cache[key]
        # Leader produced nothing usable — fall through and try ourselves.

    def _do():
        df = yf.download(
            list(tickers), start=start, end=end, interval=interval,
            auto_adjust=auto_adjust, actions=actions, progress=False, threads=True,
        )
        if not df.empty and df.index.tz is not None:
            df.index = df.index.tz_localize(None)
        return df

    try:
        # Live multi-ticker boards need more patience than the default 6s
        # history/info budget — wait longer before yielding empty.
        acquire_timeout = max(YF_ACQUIRE_TIMEOUT, 25.0) if len(tickers) >= 10 else YF_ACQUIRE_TIMEOUT
        if not _YF_SEM.acquire(timeout=acquire_timeout):
            logger.info("download of %d tickers deferred — yfinance saturated (>%ss)", len(tickers), acquire_timeout)
            df = pd.DataFrame()
        else:
            try:
                df = _do()
            finally:
                _YF_SEM.release()
    except Exception:
        df = pd.DataFrame()
    if not df.empty:                      # don't cache transient failures
        with _lock:
            cache[key] = df
    if leader:
        with _download_inflight_lock:
            _download_inflight.pop(key, None)
        wait_evt.set()
    return df
