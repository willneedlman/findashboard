"""
Finnhub API client — backup layer for FMP rate-limited endpoints.

Normalizes responses to match FMP field names so callers don't need
to know which source served the data.

Free tier: 60 req/min, no credit card required.
Set FINNHUB_API_KEY in backend/.env.
"""

import os
import threading
import requests
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry
from cachetools import TTLCache
from dotenv import load_dotenv

load_dotenv(os.path.join(os.path.dirname(__file__), ".env"))

_API_KEY = os.getenv("FINNHUB_API_KEY", "")
_BASE    = "https://finnhub.io/api/v1"
_TIMEOUT = 8

# Shared session: connection pooling + automatic retry/backoff on transient 429/5xx.
_session = requests.Session()
_retry = Retry(
    total=2, backoff_factor=0.5,
    status_forcelist=(429, 500, 502, 503, 504),
    allowed_methods=("GET",),
    respect_retry_after_header=True,
)
_session.mount("https://", HTTPAdapter(max_retries=_retry, pool_connections=10, pool_maxsize=20))

_lock          = threading.Lock()
_quote_cache:   TTLCache = TTLCache(maxsize=300, ttl=1800)   # 30 min
_ratings_cache: TTLCache = TTLCache(maxsize=300, ttl=86400)  # 24 hr
_profile_cache: TTLCache = TTLCache(maxsize=300, ttl=86400)  # 24 hr
_peers_cache:   TTLCache = TTLCache(maxsize=300, ttl=86400)  # 24 hr


def available() -> bool:
    return bool(_API_KEY and _API_KEY not in ("", "your_key_here"))


def _get(path: str, params: dict | None = None) -> dict | list:
    p = dict(params or {})
    p["token"] = _API_KEY
    r = _session.get(f"{_BASE}{path}", params=p, timeout=_TIMEOUT)
    r.raise_for_status()
    return r.json()


def _cached(cache: TTLCache, key: str, fetch_fn):
    with _lock:
        if key in cache:
            return cache[key]
    data = fetch_fn()
    with _lock:
        cache[key] = data
    return data


# ── Industry peers ────────────────────────────────────────────────────────────

def get_peers(ticker: str) -> list:
    """Same-industry peer symbols from Finnhub /stock/peers. Industry-precise and
    US-focused — good where FMP's curated peer list is thin."""
    sym = ticker.strip().upper()
    def fetch():
        try:
            data = _get("/stock/peers", {"symbol": sym})
            if isinstance(data, list):
                return [str(s).upper() for s in data if s and str(s).upper() != sym]
        except Exception:
            pass
        return []
    return _cached(_peers_cache, sym, fetch)


# ── Quote — normalized to FMP /quote shape ────────────────────────────────────

def get_quote(ticker: str) -> dict:
    """
    Returns: price, changesPercentage, marketCap, volume.
    Normalized to match fmp.get_quote() output shape.
    """
    sym = ticker.strip().upper()

    def fetch():
        try:
            q = _get("/quote", {"symbol": sym})
            # Finnhub /quote fields: c=current, dp=% change, v=volume, t=timestamp
            if not q or q.get("c", 0) == 0:
                return {}
            return {
                "symbol":            sym,
                "price":             q.get("c"),
                "change":            q.get("d"),           # absolute change
                "changesPercentage": q.get("dp"),          # % change
                "volume":            q.get("v"),
                "previousClose":     q.get("pc"),
                # marketCap not available on free quote endpoint — omit
                "marketCap":         None,
                "_source":           "finnhub",
            }
        except Exception:
            return {}

    return _cached(_quote_cache, sym, fetch)


# ── Analyst ratings — normalized to FMP /analyst-stock-ratings shape ─────────

def get_analyst_ratings(ticker: str) -> dict:
    """
    Returns latest analyst consensus.
    Normalized to match fmp.get_analyst_ratings() output shape.
    """
    sym = ticker.strip().upper()

    def fetch():
        try:
            # Finnhub /stock/recommendation returns list of weekly snapshots
            data = _get("/stock/recommendation", {"symbol": sym})
            if not isinstance(data, list) or not data:
                return {}
            latest = data[0]  # most recent week
            buy    = (latest.get("buy", 0) or 0) + (latest.get("strongBuy", 0) or 0)
            hold   = latest.get("hold", 0) or 0
            sell   = (latest.get("sell", 0) or 0) + (latest.get("strongSell", 0) or 0)
            total  = buy + hold + sell or 1

            # Derive a normalized recommendation string
            buy_pct = buy / total
            if buy_pct >= 0.6:
                rec = "Strong Buy"
                score = 5
            elif buy_pct >= 0.4:
                rec = "Buy"
                score = 4
            elif sell / total >= 0.4:
                rec = "Sell"
                score = 2
            else:
                rec = "Hold"
                score = 3

            return {
                "symbol":                 sym,
                "ratingRecommendation":   rec,
                "ratingScore":            score,
                "ratingBuy":              buy,
                "ratingHold":             hold,
                "ratingSell":             sell,
                "_source":                "finnhub",
            }
        except Exception:
            return {}

    return _cached(_ratings_cache, sym, fetch)


# ── Company profile — normalized to FMP /profile shape ───────────────────────

def get_profile(ticker: str) -> dict:
    """
    Returns company name, sector, market cap, exchange.
    Normalized to match fmp.get_profile() output shape.
    """
    sym = ticker.strip().upper()

    def fetch():
        try:
            p = _get("/stock/profile2", {"symbol": sym})
            if not p or not p.get("name"):
                return {}
            return {
                "symbol":          sym,
                "companyName":     p.get("name"),
                "sector":          p.get("finnhubIndustry"),
                "exchange":        p.get("exchange"),
                "marketCap":       p.get("marketCapitalization", 0) * 1_000_000,  # Finnhub returns $M
                "price":           None,  # not in profile endpoint
                "beta":            None,
                "changePercentage":None,
                "_source":         "finnhub",
            }
        except Exception:
            return {}

    return _cached(_profile_cache, sym, fetch)
