"""
Finnhub API client — backup layer for FMP rate-limited endpoints.

Normalizes responses to match FMP field names so callers don't need
to know which source served the data.

Free tier: 60 req/min, no credit card required.
Set FINNHUB_API_KEY in backend/.env.
"""

import os
import threading
import time
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

# Free tier is 60 req/min. Callers here (earnings-calendar enrichment in
# particular) batch dozens of tickers through a thread pool, which used to
# fire 30+ concurrent requests in a single burst — blowing straight through
# the per-minute cap and drawing a wave of 429s that (see _cached below) used
# to get permanently cached as "no data". This paces every call to at most
# _RATE_LIMIT per rolling minute so bursts queue instead of failing.
_RATE_LIMIT = 55   # headroom under the documented 60/min cap
_RATE_WINDOW = 60.0
_rate_sem = threading.BoundedSemaphore(_RATE_LIMIT)


def _refill_rate_sem():
    interval = _RATE_WINDOW / _RATE_LIMIT
    while True:
        time.sleep(interval)
        try:
            _rate_sem.release()
        except ValueError:
            pass   # already at the ceiling — nothing has spent a permit to return


threading.Thread(target=_refill_rate_sem, daemon=True, name="finnhub-rate-refill").start()

_lock          = threading.Lock()
_quote_cache:   TTLCache = TTLCache(maxsize=300,  ttl=1800)   # 30 min
_ratings_cache: TTLCache = TTLCache(maxsize=300,  ttl=86400)  # 24 hr
# maxsize bumped from 300 — a single week-wide earnings-calendar window can
# cover 1000+ symbols, and at 300 the LRU eviction was constantly discarding
# entries before they could ever be reused within the same day.
_profile_cache: TTLCache = TTLCache(maxsize=4000, ttl=86400)  # 24 hr
_peers_cache:   TTLCache = TTLCache(maxsize=300,  ttl=86400)  # 24 hr
_earncal_cache: TTLCache = TTLCache(maxsize=64,   ttl=3600)   # 1 hr
_ipocal_cache:  TTLCache = TTLCache(maxsize=64,   ttl=3600)   # 1 hr


def available() -> bool:
    return bool(_API_KEY and _API_KEY not in ("", "your_key_here"))


def _get(path: str, params: dict | None = None) -> dict | list:
    _rate_sem.acquire()
    p = dict(params or {})
    p["token"] = _API_KEY
    r = _session.get(f"{_BASE}{path}", params=p, timeout=_TIMEOUT)
    r.raise_for_status()
    return r.json()


def _cached(cache: TTLCache, key: str, fetch_fn, default=None):
    with _lock:
        if key in cache:
            return cache[key]
    try:
        data = fetch_fn()
    except Exception:
        # A transient failure (rate limit, timeout, network blip) is not the
        # same fact as "this ticker has no data" — caching it here would bake
        # in a false negative for the cache's full TTL (up to 24h). Leave it
        # uncached so the next call gets a fresh attempt.
        return default if default is not None else {}
    with _lock:
        cache[key] = data
    return data


# ── Industry peers ────────────────────────────────────────────────────────────

def get_peers(ticker: str) -> list:
    """Same-industry peer symbols from Finnhub /stock/peers. Industry-precise and
    US-focused — good where FMP's curated peer list is thin."""
    sym = ticker.strip().upper()
    def fetch():
        data = _get("/stock/peers", {"symbol": sym})
        if isinstance(data, list):
            return [str(s).upper() for s in data if s and str(s).upper() != sym]
        return []
    return _cached(_peers_cache, sym, fetch, default=[])


# ── Quote — normalized to FMP /quote shape ────────────────────────────────────

def get_quote(ticker: str) -> dict:
    """
    Returns: price, changesPercentage, marketCap, volume.
    Normalized to match fmp.get_quote() output shape.
    """
    sym = ticker.strip().upper()

    def fetch():
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

    return _cached(_quote_cache, sym, fetch, default={})


# ── Analyst ratings — normalized to FMP /analyst-stock-ratings shape ─────────

def get_analyst_ratings(ticker: str) -> dict:
    """
    Returns latest analyst consensus.
    Normalized to match fmp.get_analyst_ratings() output shape.
    """
    sym = ticker.strip().upper()

    def fetch():
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

    return _cached(_ratings_cache, sym, fetch, default={})


# ── Company profile — normalized to FMP /profile shape ───────────────────────

_PROFILE_DISK_TTL = 3 * 86400   # see get_profile


def get_profile(ticker: str) -> dict:
    """
    Returns company name, sector, market cap, exchange.
    Normalized to match fmp.get_profile() output shape.

    Backed by a disk-persisted L2 cache on top of the in-memory 24h TTLCache:
    name/sector are stable and a market cap that's a few days stale is fine
    for filtering/display, so once a symbol has been profiled it survives
    server restarts and in-memory eviction without spending another live call
    for _PROFILE_DISK_TTL — the dominant cost of a big earnings-calendar
    window is exactly this call, repeated for every covered symbol.
    """
    from disk_cache import disk_get, disk_set
    sym = ticker.strip().upper()
    with _lock:
        if sym in _profile_cache:
            return _profile_cache[sym]
    dk = f"finnhub:profile:{sym}"
    disk_val = disk_get(dk)
    if disk_val is not None:
        with _lock:
            _profile_cache[sym] = disk_val
        return disk_val

    def fetch():
        p = _get("/stock/profile2", {"symbol": sym})
        if not p or not p.get("name"):
            return {}
        # profile2 sometimes resolves a foreign ADR (TSM, TM, BABA, ASML, …) to
        # its overseas PRIMARY listing, and marketCapitalization there is in
        # THAT market's local currency (TWD, JPY, CNY, EUR, …), not USD — off
        # by whatever the FX rate is, silently, since the field shape looks
        # identical either way. There's no live FX conversion wired in here,
        # so treat it as unknown rather than report a wrong number: a null
        # market cap correctly falls through/excludes from filters, a wrong
        # one (e.g. TSM showing $59T) actively lies.
        currency = p.get("currency")
        mc_raw = p.get("marketCapitalization")
        mc = mc_raw * 1_000_000 if (mc_raw is not None and currency in (None, "USD")) else None
        return {
            "symbol":          sym,
            "companyName":     p.get("name"),
            "sector":          p.get("finnhubIndustry"),
            "exchange":        p.get("exchange"),
            "country":         p.get("country"),  # ISO-2 domicile; foreign → ADR listing
            "marketCap":       mc,
            "logo":            p.get("logo") or None,
            "price":           None,  # not in profile endpoint
            "beta":            None,
            "changePercentage":None,
            "_source":         "finnhub",
        }

    data = _cached(_profile_cache, sym, fetch, default={})
    if data:
        disk_set(dk, data, ttl=_PROFILE_DISK_TTL)
    return data


def get_earnings_calendar(date_from: str, date_to: str) -> list:
    """
    Upcoming earnings between two ISO dates (inclusive). Finnhub's free tier
    serves forward-looking dates only, which is exactly what the calendar needs.

    Each row: symbol, date, hour (bmo/amc/dmh/""), quarter, year, epsEstimate.
    Actuals are null for future reports.
    """
    key = f"{date_from}:{date_to}"

    def fetch():
        d = _get("/calendar/earnings", {"from": date_from, "to": date_to})
        rows = d.get("earningsCalendar", []) if isinstance(d, dict) else []
        return [
            {
                "symbol":           r.get("symbol"),
                "date":             r.get("date"),
                "hour":             r.get("hour") or "",
                "quarter":          r.get("quarter"),
                "year":             r.get("year"),
                "epsEstimate":      r.get("epsEstimate"),
            }
            for r in rows if r.get("symbol")
        ]

    return _cached(_earncal_cache, key, fetch, default=[])


def get_ipo_calendar(date_from: str, date_to: str) -> list:
    """
    IPOs between two ISO dates (inclusive) from Finnhub's free feed. Everything
    the calendar view needs arrives in this one call, so there is no per-row
    enrichment step.

    Each row: symbol, name, date, exchange, price (offer range or single, as
    given), shares, dealValue, status (expected/priced/filed/withdrawn).
    """
    key = f"{date_from}:{date_to}"

    def fetch():
        d = _get("/calendar/ipo", {"from": date_from, "to": date_to})
        rows = d.get("ipoCalendar", []) if isinstance(d, dict) else []
        return [
            {
                "symbol":     r.get("symbol"),
                "name":       r.get("name"),
                "date":       r.get("date"),
                "exchange":   r.get("exchange") or "",
                "price":      r.get("price") or "",
                "shares":     r.get("numberOfShares"),
                "dealValue":  r.get("totalSharesValue"),
                "status":     (r.get("status") or "").lower(),
            }
            for r in rows if r.get("symbol")
        ]

    return _cached(_ipocal_cache, key, fetch, default=[])
