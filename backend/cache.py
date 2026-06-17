"""
Centralized caching layer for all yfinance and external API calls.
All routers import helpers from here to avoid repeated network round-trips.

TTLs:
  price history  — 5 min  (prices update frequently during market hours)
  fundamentals   — 15 min (info/earnings change infrequently)
  news           — 5 min
  rates/yield    — 10 min
"""
import functools
import hashlib
import threading
import pandas as pd
import yfinance as yf
from cachetools import TTLCache

from disk_cache import disk_get, disk_set

_lock = threading.Lock()

_history_cache: TTLCache = TTLCache(maxsize=500, ttl=300)    # 5 min
_info_cache:    TTLCache = TTLCache(maxsize=200, ttl=900)     # 15 min
_news_cache:    TTLCache = TTLCache(maxsize=200, ttl=300)     # 5 min
_download_cache: TTLCache = TTLCache(maxsize=100, ttl=300)   # 5 min


def _key(prefix: str, args: tuple, kwargs: dict) -> str:
    raw = f"{prefix}|{args!r}|{sorted(kwargs.items())!r}"
    return prefix + ":" + hashlib.md5(raw.encode()).hexdigest()


def cached(ttl: int = 300, maxsize: int = 256, persist: bool = False):
    """
    Memoize an expensive function with a per-function TTL cache.

    Replaces the ad-hoc module-level TTLCache instances scattered across
    routers. Set persist=True to also back the result with the SQLite
    disk cache (survives restarts) — only for JSON-serializable returns
    (dicts/lists); DataFrames stay memory-only.

    The wrapper exposes .cache_clear() to flush the in-memory tier.
    """
    def deco(fn):
        mem: TTLCache = TTLCache(maxsize=maxsize, ttl=ttl)
        flock = threading.Lock()
        prefix = f"{fn.__module__}.{fn.__qualname__}"

        @functools.wraps(fn)
        def wrapper(*args, **kwargs):
            k = _key(prefix, args, kwargs)
            with flock:
                if k in mem:
                    return mem[k]
            if persist:
                hit = disk_get(k)
                if hit is not None:
                    with flock:
                        mem[k] = hit
                    return hit
            val = fn(*args, **kwargs)
            with flock:
                mem[k] = val
            if persist:
                disk_set(k, val, ttl=ttl)
            return val

        wrapper.cache_clear = mem.clear
        return wrapper
    return deco


def get_history(ticker: str, period: str = "1y",
                start: str | None = None, end: str | None = None) -> pd.DataFrame:
    sym = ticker.strip().upper()
    key = f"{sym}:{period}:{start}:{end}"
    with _lock:
        if key in _history_cache:
            return _history_cache[key]
    try:
        tkr = yf.Ticker(sym)
        df = tkr.history(start=start, end=end) if (start or end) else tkr.history(period=period)
        if df.index.tz is not None:
            df.index = df.index.tz_localize(None)
    except Exception:
        df = pd.DataFrame()
    if not df.empty:                      # don't cache transient failures
        with _lock:
            _history_cache[key] = df
    return df


def get_info(ticker: str) -> dict:
    sym = ticker.strip().upper()
    with _lock:
        if sym in _info_cache:
            return _info_cache[sym]
    try:
        info = yf.Ticker(sym).info
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
        news = yf.Ticker(sym).news or []
    except Exception:
        news = []
    if news:                              # don't cache transient failures
        with _lock:
            _news_cache[sym] = news
    return news


def get_download(tickers: tuple, start: str, end: str, interval: str = "1d") -> pd.DataFrame:
    key = (tickers, start, end, interval)
    with _lock:
        if key in _download_cache:
            return _download_cache[key]
    try:
        df = yf.download(list(tickers), start=start, end=end, interval=interval, auto_adjust=True, progress=False)
        if df.index.tz is not None:
            df.index = df.index.tz_localize(None)
    except Exception:
        df = pd.DataFrame()
    if not df.empty:                      # don't cache transient failures
        with _lock:
            _download_cache[key] = df
    return df
