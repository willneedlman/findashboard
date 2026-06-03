"""
Centralized caching layer for all yfinance and external API calls.
All routers import helpers from here to avoid repeated network round-trips.

TTLs:
  price history  — 5 min  (prices update frequently during market hours)
  fundamentals   — 15 min (info/earnings change infrequently)
  news           — 5 min
  rates/yield    — 10 min
"""
import threading
import pandas as pd
import yfinance as yf
from cachetools import TTLCache

_lock = threading.Lock()

_history_cache: TTLCache = TTLCache(maxsize=500, ttl=300)    # 5 min
_info_cache:    TTLCache = TTLCache(maxsize=200, ttl=900)     # 15 min
_news_cache:    TTLCache = TTLCache(maxsize=200, ttl=300)     # 5 min
_download_cache: TTLCache = TTLCache(maxsize=100, ttl=300)   # 5 min


def get_history(ticker: str, period: str = "1y") -> pd.DataFrame:
    key = f"{ticker}:{period}"
    with _lock:
        if key in _history_cache:
            return _history_cache[key]
    try:
        df = yf.Ticker(ticker.strip().upper()).history(period=period)
        if df.index.tz is not None:
            df.index = df.index.tz_localize(None)
    except Exception:
        df = pd.DataFrame()
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
    with _lock:
        _news_cache[sym] = news
    return news


def get_download(tickers: tuple, start: str, end: str) -> pd.DataFrame:
    key = (tickers, start, end)
    with _lock:
        if key in _download_cache:
            return _download_cache[key]
    try:
        df = yf.download(list(tickers), start=start, end=end, auto_adjust=True, progress=False)
        if df.index.tz is not None:
            df.index = df.index.tz_localize(None)
    except Exception:
        df = pd.DataFrame()
    with _lock:
        _download_cache[key] = df
    return df
