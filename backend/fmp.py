"""
Financial Modeling Prep (FMP) client — stable API.

Replaces slow yfinance .info calls for:
  - DCF fundamentals  (revenue, margins, debt, shares, beta, growth)
  - Corporate Hub     (real market cap, real % change, real P/E)

Stable API base: https://financialmodelingprep.com/stable
Set FMP_API_KEY in backend/.env or as an environment variable.
"""

import os
import re
import time
import threading
import concurrent.futures
import pandas as pd
import requests
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry
from cachetools import TTLCache
from dotenv import load_dotenv
import logging

_log = logging.getLogger(__name__)

load_dotenv(os.path.join(os.path.dirname(__file__), ".env"))

_API_KEY = os.getenv("FMP_API_KEY", "")
_BASE    = "https://financialmodelingprep.com/stable"
_TIMEOUT = 8

# Shared session: connection pooling (keep-alive) + automatic retry with backoff
# on transient 429/5xx. Honors Retry-After headers from FMP rate limits.
_session = requests.Session()
_retry = Retry(
    total=2, backoff_factor=0.5,
    status_forcelist=(429, 500, 502, 503, 504),
    allowed_methods=("GET",),
    respect_retry_after_header=True,
)
_adapter = HTTPAdapter(max_retries=_retry, pool_connections=10, pool_maxsize=20)
_session.mount("https://", _adapter)

_lock            = threading.Lock()
_profile_cache:   TTLCache = TTLCache(maxsize=300, ttl=86400)  # 24 hr
_income_cache:    TTLCache = TTLCache(maxsize=300, ttl=86400)  # 24 hr
_balance_cache:   TTLCache = TTLCache(maxsize=300, ttl=86400)  # 24 hr
_cashflow_cache:  TTLCache = TTLCache(maxsize=300, ttl=86400)  # 24 hr
_quote_cache:     TTLCache = TTLCache(maxsize=300, ttl=1800)   # 30 min — biggest FMP saver
_estimates_cache: TTLCache = TTLCache(maxsize=300, ttl=86400)  # 24 hr


def available() -> bool:
    return bool(_API_KEY and _API_KEY not in ("", "your_key_here"))


# ── Passive rate-limit tracking ───────────────────────────────────────────────
# We don't live-probe FMP (it burns metered quota), so the health monitor can't
# otherwise see a 429. Instead, record 429s observed on real app calls and expose
# a rolling status the /health probe reads — so throttling shows up automatically.
_RL_WINDOW = 300.0                       # seconds a 429 is considered "recent"
_rl_lock = threading.Lock()
_rl_hits: list[float] = []               # timestamps of recent 429s


def _is_rate_limit(exc: Exception) -> bool:
    if isinstance(exc, requests.HTTPError) and exc.response is not None:
        return exc.response.status_code == 429
    return "429" in str(exc) or "too many" in str(exc).lower()


def _note_rate_limit() -> None:
    now = time.time()
    with _rl_lock:
        _rl_hits.append(now)
        # keep only the rolling window
        cutoff = now - _RL_WINDOW
        while _rl_hits and _rl_hits[0] < cutoff:
            _rl_hits.pop(0)


def rate_limit_status() -> dict:
    """Rolling FMP rate-limit health from observed 429s on real calls."""
    now = time.time()
    cutoff = now - _RL_WINDOW
    with _rl_lock:
        recent = [t for t in _rl_hits if t >= cutoff]
        last = _rl_hits[-1] if _rl_hits else None
    return {
        "rate_limited": bool(recent),
        "recent_count": len(recent),
        "window_sec": int(_RL_WINDOW),
        "last_seconds_ago": round(now - last, 1) if last else None,
    }


def _get(path: str, params: dict | None = None) -> list | dict:
    p = dict(params or {})
    p["apikey"] = _API_KEY
    try:
        r = _session.get(f"{_BASE}{path}", params=p, timeout=_TIMEOUT)
        r.raise_for_status()
        return r.json()
    except requests.exceptions.RequestException as e:
        if _is_rate_limit(e):
            _note_rate_limit()
        raise


_US_EXCHANGES = {"NASDAQ", "NYSE", "AMEX", "NYSE AMERICAN", "NYSEARCA", "BATS", "OTC", "PNK", "OTCMKTS"}


def search_symbols(query: str, limit: int = 8) -> list:
    """FMP symbol search — covers US listings plus ADRs / OTC names the SEC index
    misses (e.g. SMPNY -> Sompo). Returns [{"ticker","name"}], US-listed only."""
    if not available():
        return []
    try:
        rows = _get("/search-name", {"query": query, "limit": limit * 3})
    except Exception:
        return []
    out: list = []
    if isinstance(rows, list):
        for r in rows:
            sym = str(r.get("symbol") or "").upper()
            name = str(r.get("name") or "")
            ex = str(r.get("exchange") or r.get("exchangeShortName") or "").upper()
            if not sym or not name or "." in sym:        # skip foreign-suffixed dupes (e.g. 8630.T)
                continue
            if ex and ex not in _US_EXCHANGES:
                continue
            out.append({"ticker": sym, "name": name})
            if len(out) >= limit:
                break
    return out


def _get_v4(path: str, params: dict | None = None) -> list | dict:
    """FMP v4 API — broader coverage for segment data and other endpoints."""
    p = dict(params or {})
    p["apikey"] = _API_KEY
    try:
        r = _session.get(f"https://financialmodelingprep.com/api/v4{path}", params=p, timeout=_TIMEOUT)
        r.raise_for_status()
        return r.json()
    except requests.exceptions.RequestException as e:
        if _is_rate_limit(e):
            _note_rate_limit()
        raise


def _cached(cache: TTLCache, key: str, fetch_fn, default=None):
    with _lock:
        if key in cache:
            return cache[key]
    try:
        data = fetch_fn()
    except Exception:
        # A transient failure (rate limit, timeout, network blip) is not the
        # same fact as "no data" — caching it here would bake in a false
        # negative for the cache's full TTL (up to 24h), which on the daily
        # free-tier quota specifically means blocking the very next retry
        # after the quota resets. Leave it uncached so that retry can land.
        return default if default is not None else {}
    with _lock:
        cache[key] = data
    return data


# ── Public helpers ────────────────────────────────────────────────────────────

def get_profile(ticker: str) -> dict:
    """Price, marketCap, beta, changePercentage, companyName, sector."""
    sym = ticker.strip().upper()
    def fetch():
        d = _get("/profile", {"symbol": sym})
        return d[0] if isinstance(d, list) and d else {}
    return _cached(_profile_cache, sym, fetch)


def get_income(ticker: str, limit: int = 2) -> list:
    """Annual income statements (latest first). limit=2 enables YoY growth calc."""
    sym = ticker.strip().upper()
    key = f"{sym}:income:{limit}"
    def fetch():
        d = _get("/income-statement", {"symbol": sym, "period": "annual", "limit": limit})
        return d if isinstance(d, list) else []
    return _cached(_income_cache, key, fetch, default=[])


def get_balance(ticker: str) -> dict:
    """Latest annual balance sheet: totalDebt, cashAndCashEquivalents, netDebt, totalStockholdersEquity."""
    sym = ticker.strip().upper()
    def fetch():
        d = _get("/balance-sheet-statement", {"symbol": sym, "period": "annual", "limit": 1})
        return d[0] if isinstance(d, list) and d else {}
    return _cached(_balance_cache, sym, fetch)


_FUND_TTL = 30 * 86400                                    # statements change quarterly
_fund_cache: TTLCache = TTLCache(maxsize=2000, ttl=86400)


def get_fundamentals(ticker: str, cached_only: bool = False) -> dict | None:
    """Bundle of {profile, income(2y), balance} for the screener, persisted to disk
    for 30 days so the free-tier daily call budget is spent at most once per ticker
    per month. cached_only=True returns the cached bundle or None without spending a
    network call (and the caller's per-screen fetch budget)."""
    sym = ticker.strip().upper()
    with _lock:
        if sym in _fund_cache:
            return _fund_cache[sym]
    dk = f"fmp:fund:v1:{sym}"
    dv = disk_get(dk)
    if dv is not None:
        with _lock:
            _fund_cache[sym] = dv
        return dv
    if cached_only or not available():
        return None
    try:
        bundle = {"profile": get_profile(sym), "income": get_income(sym, 2), "balance": get_balance(sym)}
    except Exception:
        return None
    if not (bundle["income"] or bundle["balance"]):
        return None                                       # nothing useful — don't cache a dud
    with _lock:
        _fund_cache[sym] = bundle
    disk_set(dk, bundle, ttl=_FUND_TTL)
    return bundle


def get_cashflow(ticker: str) -> dict:
    """Latest annual cash flow: capitalExpenditure (negative), depreciationAndAmortization, freeCashFlow."""
    sym = ticker.strip().upper()
    def fetch():
        d = _get("/cash-flow-statement", {"symbol": sym, "period": "annual", "limit": 1})
        return d[0] if isinstance(d, list) and d else {}
    return _cached(_cashflow_cache, sym, fetch)


def get_history_df(symbol: str, start: str | None = None, end: str | None = None) -> pd.DataFrame:
    """Daily OHLCV as a yfinance-shaped frame (tz-naive DatetimeIndex; Open/High/Low/
    Close/Volume; ascending). Fallback source for cache.get_history when yfinance is
    contended. Close is split/dividend-adjusted (adjClose, matching yfinance
    auto_adjust) and OHLC scaled by the same factor. Empty frame on any failure —
    never raises into the caller."""
    if not available():
        return pd.DataFrame()
    sym = (symbol or "").strip().upper()
    if not sym:
        return pd.DataFrame()
    params: dict = {"symbol": sym}
    if start:
        params["from"] = start
    if end:
        params["to"] = end
    _log.info("fmp history fallback for %s (%s→%s)", sym, start or "-", end or "-")
    try:
        d = _get("/historical-price-eod/full", params)
    except Exception as e:
        if _is_rate_limit(e):
            _log.warning("fmp history rate-limited for %s", sym)
        else:
            _log.warning("fmp history failed for %s: %s", sym, e)
        return pd.DataFrame()

    rows = d.get("historical") if isinstance(d, dict) else d
    if not isinstance(rows, list) or not rows:
        return pd.DataFrame()
    recs = []
    for r in rows:
        try:
            close = float(r["close"])
            adj = float(r.get("adjClose") or close)
            factor = adj / close if close else 1.0
            recs.append((
                pd.Timestamp(r["date"]),
                float(r["open"]) * factor, float(r["high"]) * factor,
                float(r["low"]) * factor, adj, float(r.get("volume") or 0),
            ))
        except (KeyError, ValueError, TypeError):
            continue
    if not recs:
        return pd.DataFrame()
    return (pd.DataFrame(recs, columns=["Date", "Open", "High", "Low", "Close", "Volume"])
            .set_index("Date").sort_index())


def get_analyst_estimates(ticker: str, limit: int = 3) -> list:
    """
    Forward analyst estimates (annual). Each record has estimatedRevenueAvg,
    estimatedEbitAvg, estimatedEpsAvg, and date. Latest forward year first.
    """
    sym = ticker.strip().upper()
    key = f"{sym}:estimates:{limit}"
    def fetch():
        d = _get("/analyst-estimates", {"symbol": sym, "period": "annual", "limit": limit})
        return d if isinstance(d, list) else []
    return _cached(_estimates_cache, key, fetch, default=[])


_ratings_cache: TTLCache = TTLCache(maxsize=300, ttl=86400)  # 24 hr — analyst ratings change at most daily


def get_analyst_ratings(ticker: str) -> dict:
    """Latest analyst consensus. Falls back to Finnhub on FMP 429."""
    sym = ticker.strip().upper()
    def fetch():
        try:
            d = _get("/analyst-stock-ratings", {"symbol": sym, "limit": 1})
            return d[0] if isinstance(d, list) and d else {}
        except requests.HTTPError as e:
            if e.response is not None and e.response.status_code == 429:
                _log.warning("FMP /analyst-stock-ratings 429 for %s — trying Finnhub", sym)
                try:
                    import finnhub as fh
                    if fh.available():
                        return fh.get_analyst_ratings(sym)
                except Exception:
                    pass
            return {}
    return _cached(_ratings_cache, sym, fetch)


def get_quote(ticker: str) -> dict:
    """Real-time quote. Falls back to Finnhub on FMP 429."""
    sym = ticker.strip().upper()
    def fetch():
        try:
            d = _get("/quote", {"symbol": sym})
            return d[0] if isinstance(d, list) and d else {}
        except requests.HTTPError as e:
            if e.response is not None and e.response.status_code == 429:
                _log.warning("FMP /quote 429 for %s — trying Finnhub", sym)
                try:
                    import finnhub as fh
                    if fh.available():
                        return fh.get_quote(sym)
                except Exception:
                    pass
            return {}
    return _cached(_quote_cache, sym, fetch)


_peers_cache: TTLCache = TTLCache(maxsize=300, ttl=86400)  # 24 hr


def get_stock_peers(ticker: str, limit: int = 8) -> list:
    """Business-relevant comparable companies, kept cheap (≤3 API calls).

    Finnhub's /stock/peers is already industry-matched and roughly size-ordered, so
    it leads (e.g. SBUX → MCD/YUM/CMG, not travel names). FMP's /stock-peers adds
    breadth plus free market caps, which we use only to drop extreme size mismatches
    (e.g. a $4T name benchmarked against a $40B one). No per-candidate lookups —
    avoids the rate-limit storm that per-peer profile fetches caused.
    """
    import math
    sym = ticker.strip().upper()

    def fetch():
        # FMP peers: free market caps (and breadth)
        capmap: dict[str, float] = {}
        try:
            raw = _get("/stock-peers", {"symbol": sym})
            for r in (raw if isinstance(raw, list) else []):
                if isinstance(r, dict):
                    ps = str(r.get("symbol") or "").upper()
                    if ps and ps != sym:
                        capmap[ps] = float(r.get("mktCap") or 0)
        except Exception:
            pass

        # Finnhub peers: industry-precise, leads the ordering
        fh_order: list = []
        try:
            import finnhub as _fh
            if _fh.available():
                fh_order = [p for p in _fh.get_peers(sym) if p and p != sym]
        except Exception:
            pass

        seen, cand = set(), []
        for p in fh_order + list(capmap.keys()):
            if p not in seen:
                seen.add(p)
                cand.append(p)
        if not cand:
            return []

        # Drop extreme size mismatches using free FMP caps; keep unknown-size peers.
        try:
            tgt = float(get_profile(sym).get("marketCap") or 0)
        except Exception:
            tgt = 0.0
        if tgt > 0:
            def size_ok(p: str) -> bool:
                c = capmap.get(p, 0.0)
                return c <= 0 or abs(math.log10(c) - math.log10(tgt)) <= 1.6  # ~40x band
            cand = [p for p in cand if size_ok(p)] or cand

        return cand[:limit]

    return _cached(_peers_cache, sym, fetch)


_fundamentals_cache: TTLCache = TTLCache(maxsize=300, ttl=86400)  # 24 hr

_FUND_INCOME_FIELD = {"revenue": "revenue", "net_income": "netIncome", "eps": "eps", "ebitda": "ebitda"}
_FUND_MARGIN_NUM   = {"gross_margin": "grossProfit", "operating_margin": "operatingIncome", "net_margin": "netIncome"}


def _fund_points(rows, field: str) -> list:
    out = []
    for r in (rows if isinstance(rows, list) else []):
        v, d = r.get(field), r.get("date")
        if d and v is not None:
            try:
                out.append({"date": d, "value": float(v)})
            except (TypeError, ValueError):
                pass
    return sorted(out, key=lambda x: x["date"])


def _durable_series(kind: str, key: str, fetch) -> list:
    """Backlog layer for series data: every successful fetch is persisted for
    ~13 months, and a failed/throttled fetch serves the backlog instead of
    nothing. Fundamentals barely change intra-quarter, so stale beats empty
    and the free-tier daily quota is never a hard dependency."""
    dk = f"fmp:backlog:{kind}:{key}"
    pts = fetch()
    if pts:
        disk_set(dk, pts, ttl=400 * 86400)
        return pts
    return disk_get(dk) or []


def get_fundamental_series(ticker: str, metric: str = "revenue", period: str = "quarter", limit: int = 24) -> list:
    """Time series of a fundamental metric for chart overlays. Returns [{date, value}]
    oldest-first. metric: revenue | net_income | eps | ebitda | fcf | gross_margin |
    operating_margin | net_margin (margins in %, the rest in raw reported units)."""
    sym = ticker.strip().upper()
    period = period if period in ("quarter", "annual") else "quarter"
    key = f"{sym}:{metric}:{period}:{limit}"

    def _one(per: str) -> list:
        if metric == "fcf":
            rows = _get("/cash-flow-statement", {"symbol": sym, "period": per, "limit": limit})
            return _fund_points(rows, "freeCashFlow")
        rows = _get("/income-statement", {"symbol": sym, "period": per, "limit": limit})
        if metric in _FUND_MARGIN_NUM:
            num = _FUND_MARGIN_NUM[metric]
            out = []
            for r in (rows if isinstance(rows, list) else []):
                rev, v = r.get("revenue"), r.get(num)
                if rev and v is not None and r.get("date"):
                    out.append({"date": r["date"], "value": round(float(v) / float(rev) * 100, 3)})
            return sorted(out, key=lambda x: x["date"])
        return _fund_points(rows, _FUND_INCOME_FIELD.get(metric, "revenue"))

    def fetch():
        try:
            pts = _one(period)
            # Some FMP tiers gate quarterly statements — fall back to annual.
            if not pts and period != "annual":
                pts = _one("annual")
            return pts
        except Exception:
            return []

    return _cached(_fundamentals_cache, key, lambda: _durable_series("fund", key, fetch))


# ── Standardized multiples & ratios (size-neutral, comparable across companies) ──
_stmt_cache:  TTLCache = TTLCache(maxsize=300, ttl=86400)  # raw /ratios & /key-metrics
_ratio_cache: TTLCache = TTLCache(maxsize=400, ttl=86400)  # computed metric series

# metric -> (FMP endpoint, candidate field names, is_percent)
_RATIO_REGISTRY = {
    "pe":              ("/ratios",      ["priceToEarningsRatio", "priceEarningsRatio", "peRatio"], False),
    "ps":              ("/ratios",      ["priceToSalesRatio", "priceSalesRatio"], False),
    "pb":              ("/ratios",      ["priceToBookRatio", "priceBookValueRatio", "pbRatio"], False),
    "p_fcf":           ("/ratios",      ["priceToFreeCashFlowsRatio", "priceToFreeCashFlowRatio"], False),
    "ev_ebitda":       ("/key-metrics", ["enterpriseValueOverEBITDA", "evToEBITDA", "enterpriseValueMultiple"], False),
    "ev_sales":        ("/key-metrics", ["evToSales", "enterpriseValueOverSales"], False),
    "gross_margin":    ("/ratios",      ["grossProfitMargin"], True),
    "operating_margin":("/ratios",      ["operatingProfitMargin", "operatingMargin"], True),
    "net_margin":      ("/ratios",      ["netProfitMargin", "netIncomeMargin"], True),
    "roe":             ("/ratios",      ["returnOnEquity"], True),
    "roa":             ("/ratios",      ["returnOnAssets"], True),
    "roic":            ("/key-metrics", ["returnOnInvestedCapital", "roic"], True),
    "debt_equity":     ("/ratios",      ["debtToEquityRatio", "debtEquityRatio"], False),
    "current_ratio":   ("/ratios",      ["currentRatio"], False),
    "dividend_yield":  ("/ratios",      ["dividendYield", "dividendYielPercentage"], True),
    "fcf_yield":       ("/key-metrics", ["freeCashFlowYield"], True),
}

RATIO_METRICS = frozenset(_RATIO_REGISTRY)


def _statement(path: str, sym: str, period: str, limit: int) -> list:
    key = f"{path}:{sym}:{period}:{limit}"
    def fetch():
        d = _get(path, {"symbol": sym, "period": period, "limit": limit})
        return d if isinstance(d, list) else []
    return _cached(_stmt_cache, key, fetch, default=[])


def get_ratio_series(ticker: str, metric: str, period: str = "annual", limit: int = 16) -> list:
    """Time series of a standardized multiple/ratio (P/E, EV/EBITDA, ROE, margins …)
    for chart overlays. Returns [{date, value}] oldest-first; percent metrics scaled
    to %, multiples left raw. Falls back to the other reporting period if empty."""
    spec = _RATIO_REGISTRY.get(metric)
    if not spec:
        return []
    sym = ticker.strip().upper()
    period = period if period in ("quarter", "annual") else "annual"
    path, fields, is_pct = spec
    key = f"{sym}:{metric}:{period}:{limit}"

    def extract(per: str) -> list:
        rows = _statement(path, sym, per, limit)
        out = []
        for r in (rows or []):
            d = r.get("date")
            v = next((r.get(f) for f in fields if r.get(f) is not None), None)
            if d is None or v is None:
                continue
            try:
                out.append({"date": d, "value": float(v)})
            except (TypeError, ValueError):
                pass
        out.sort(key=lambda x: x["date"])
        if is_pct and out:                       # FMP returns decimals (0.45) — scale to %
            mags = sorted(abs(p["value"]) for p in out)
            if mags and mags[len(mags) // 2] < 3:
                for p in out:
                    p["value"] = round(p["value"] * 100, 3)
        return out

    def fetch():
        pts = extract(period)
        if not pts:
            pts = extract("quarter" if period == "annual" else "annual")
        return pts

    return _cached(_ratio_cache, key, lambda: _durable_series("ratio", key, fetch))


_segments_cache: TTLCache = TTLCache(maxsize=200, ttl=86400)  # 24 hr


# FMP stable nests the segments under a "data" key; everything else is metadata.
_SEG_META_KEYS = {"date", "symbol", "reportedCurrency", "period", "fiscalYear", "calendarYear", "cik"}

try:
    from disk_cache import disk_get, disk_set
except ImportError:                              # pragma: no cover
    def disk_get(_k): return None                # type: ignore
    def disk_set(_k, _v, ttl=0): pass            # type: ignore

# 'error' distinguishes a failed/throttled fetch from a genuine "issuer reports nothing".
EMPTY_SEGMENTS = {"fiscalYear": None, "currency": None, "latest": [], "history": [], "concentration": None, "error": False}

# Intersegment/corporate reconciliation rows — noise in a revenue mix, not real segments.
_SEG_NOISE_RE = re.compile(r"reconcil|eliminat|intersegment|^segment reporting", re.I)


def _clean_segment_name(name: str) -> str:
    """Strip FMP's XBRL ' Member' suffix and collapse whitespace."""
    s = re.sub(r"\s+", " ", str(name)).strip()
    return re.sub(r"\s*\bMember\b$", "", s).strip()


def _clean_segments(src: dict) -> dict:
    """Filter a raw segment dict to real, positive revenue segments with tidy names."""
    out: dict = {}
    for k, v in src.items():
        if k in _SEG_META_KEYS or not isinstance(v, (int, float)) or v <= 0:
            continue
        name = _clean_segment_name(k)
        if not name or _SEG_NOISE_RE.search(name):
            continue
        out[name] = out.get(name, 0.0) + float(v)   # merge any name collisions
    return out


def _segment_history(data, years: int = 6) -> dict:
    """Parse FMP segmentation into latest breakdown + multi-year history + YoY + concentration.

    Handles the current stable shape (segments nested under "data") and the
    older flat shape (segment keys at the top level).
    """
    if not isinstance(data, list) or not data:
        return dict(EMPTY_SEGMENTS)

    rows = []
    for entry in data:
        if not isinstance(entry, dict):
            continue
        src = entry.get("data") if isinstance(entry.get("data"), dict) else entry
        segs = _clean_segments(src)
        if not segs:
            continue
        fy = entry.get("fiscalYear") or entry.get("calendarYear") or str(entry.get("date") or "")[:4]
        try:
            fy = int(fy)
        except (TypeError, ValueError):
            pass
        rows.append({"year": fy, "date": str(entry.get("date") or ""),
                     "segments": segs, "total": sum(segs.values())})

    if not rows:
        return dict(EMPTY_SEGMENTS)

    rows.sort(key=lambda r: (r["date"], str(r["year"])), reverse=True)   # newest first
    rows = rows[:years]
    latest = rows[0]
    prior = rows[1]["segments"] if len(rows) > 1 else {}
    total = latest["total"] or 1.0

    latest_list = []
    for name, val in sorted(latest["segments"].items(), key=lambda x: -x[1]):
        prev = prior.get(name)
        yoy = round((val - prev) / prev * 100, 1) if prev else None
        latest_list.append({"name": name, "value": val,
                            "pct": round(val / total * 100, 1), "yoy_pct": yoy})

    shares = [v / total for v in latest["segments"].values()]
    concentration = {"topShare": round(max(shares) * 100, 1),
                     "hhi": round(sum(s * s for s in shares) * 10000),
                     "count": len(latest["segments"])}

    history = [{"year": r["year"], "total": r["total"],
                "segments": [{"name": n, "value": v}
                             for n, v in sorted(r["segments"].items(), key=lambda x: -x[1])]}
               for r in reversed(rows)]   # oldest -> newest for charting

    currency = next((e.get("reportedCurrency") for e in data
                     if isinstance(e, dict) and e.get("reportedCurrency")), None)
    return {"fiscalYear": latest["year"], "currency": currency,
            "latest": latest_list, "history": history, "concentration": concentration}


def _get_segments(sym: str, path: str, kind: str) -> dict:
    """Three-layer segment fetch: in-memory → disk (30d) → FMP. Only successful
    results are cached, so a rate-limited fetch retries next time instead of
    sticking. Disk persistence keeps segments available across restarts and FMP
    outages — coverage accumulates as tickers are viewed."""
    mem_key, disk_key = f"{sym}:{kind}", f"seg:{kind}:{sym}"

    with _lock:
        cached = _segments_cache.get(mem_key)
    if isinstance(cached, dict) and cached.get("latest"):
        return cached
    try:
        d = disk_get(disk_key)
        if isinstance(d, dict) and d.get("latest"):
            with _lock:
                _segments_cache[mem_key] = d
            return d
    except Exception:
        pass

    try:
        result = _segment_history(_get(path, {"symbol": sym, "period": "annual"}))
    except Exception:
        out = dict(EMPTY_SEGMENTS)
        out["error"] = True            # fetch failed (throttled / down) — not a real "no data"
        return out

    if result.get("latest"):
        with _lock:
            _segments_cache[mem_key] = result
        try:
            disk_set(disk_key, result, ttl=30 * 86400)
        except Exception:
            pass
    return result


def get_revenue_segments(ticker: str) -> dict:
    """Product revenue segments (disk-cached) — FMP /revenue-product-segmentation."""
    return _get_segments(ticker.strip().upper(), "/revenue-product-segmentation", "prod")


def get_geo_segments(ticker: str) -> dict:
    """Geographic revenue segments (disk-cached) — FMP /revenue-geographic-segmentation."""
    return _get_segments(ticker.strip().upper(), "/revenue-geographic-segmentation", "geo")


def _statements_first(ticker: str) -> tuple[list, dict, dict]:
    """Income(2y) / balance / cashflow for the DCF engine, sourced SEC EDGAR first
    (free, unmetered) and falling back to FMP only when SEC is missing or corrupt.
    Profile / price / beta are NOT sourced here — SEC has none, so the caller keeps
    those on FMP. Returns (income_list, balance, cashflow) in FMP field-name shape."""
    sym = ticker.strip().upper()
    try:
        import sec_fundamentals
        if sec_fundamentals.statements_available(ticker):
            _log.info("DCF %s statements ← SEC EDGAR", sym)
            return (sec_fundamentals.get_income(ticker, 2),
                    sec_fundamentals.get_balance(ticker),
                    sec_fundamentals.get_cashflow(ticker))
    except Exception as e:
        _log.warning("SEC statements failed for %s, using FMP: %s", sym, e)
    _log.info("DCF %s statements ← FMP fallback (SEC missing/corrupt)", sym)
    return get_income(ticker, 2), get_balance(ticker), get_cashflow(ticker)


def get_dcf_fundamentals(ticker: str) -> dict:
    """
    Fetches profile + statements + estimates in parallel (~200ms). Statements come
    from SEC EDGAR first (see _statements_first), FMP only on a SEC miss.
    Returns everything the DCF Valuation Engine needs in one call.

    Returns
    -------
    revenue       float   TTM revenue $M
    op_margin     float   operating margin %
    shares        float   diluted shares outstanding (millions)
    net_debt      float   total debt − cash $M
    rev_growth    float   YoY revenue growth %
    capex_pct     float   CapEx as % of revenue
    da_pct        float   D&A as % of revenue
    tax_rate      float   effective tax rate %
    beta          float   equity beta
    market_price  float|None
    market_cap    int|None
    de_ratio      float   debt / equity (for WACC)
    """
    with concurrent.futures.ThreadPoolExecutor(max_workers=3) as ex:
        f_profile   = ex.submit(get_profile,            ticker)
        f_stmts     = ex.submit(_statements_first,      ticker)
        f_estimates = ex.submit(get_analyst_estimates,  ticker, 3)

    profile   = f_profile.result()
    inc_list, balance, cashflow = f_stmts.result()
    estimates = f_estimates.result()

    income = inc_list[0] if inc_list else {}
    income_prior = inc_list[1] if len(inc_list) > 1 else {}

    # Revenue ($M)
    rev_raw  = income.get("revenue") or 0
    revenue  = round(rev_raw / 1e6, 0)

    # Operating margin
    op_inc    = income.get("operatingIncome") or 0
    op_margin = round((op_inc / rev_raw * 100) if rev_raw else 15.0, 1)

    # Diluted shares (millions)
    shares = round((income.get("weightedAverageShsOutDil") or 100e6) / 1e6, 1)

    # Net debt — FMP computes this directly; fall back to debt - cash
    net_debt_raw = balance.get("netDebt")
    if net_debt_raw is not None:
        net_debt = round(net_debt_raw / 1e6, 0)
    else:
        debt = (balance.get("totalDebt") or 0) / 1e6
        cash = (balance.get("cashAndCashEquivalents") or 0) / 1e6
        net_debt = round(debt - cash, 0)

    # YoY revenue growth
    rev_prior = income_prior.get("revenue") or 0
    if rev_raw and rev_prior:
        rev_growth = round((rev_raw / rev_prior - 1) * 100, 1)
    else:
        rev_growth = 10.0

    # CapEx % of revenue (capitalExpenditure is negative in FMP)
    capex_abs = abs(cashflow.get("capitalExpenditure") or 0) / 1e6
    capex_pct = round((capex_abs / revenue * 100) if revenue else 5.0, 1)

    # D&A % of revenue
    da_abs = (cashflow.get("depreciationAndAmortization") or 0) / 1e6
    da_pct = round((da_abs / revenue * 100) if revenue else 4.0, 1)

    # Working capital change % of revenue
    # FMP: positive = cash inflow from WC reduction, negative = cash used to build WC.
    # In DCF modelling, a cash use (negative value) is a drag on FCF, so we flip the sign.
    wc_raw = (cashflow.get("changeInWorkingCapital") or 0) / 1e6
    if revenue:
        wc_pct_raw = -wc_raw / revenue * 100   # positive = WC drag, negative = WC release
        wc_pct = round(max(-2.0, min(5.0, wc_pct_raw)), 2)
    else:
        wc_pct = 0.5

    # Effective tax rate
    pretax   = income.get("incomeBeforeTax") or 0
    tax_exp  = income.get("incomeTaxExpense") or 0
    tax_rate = round((tax_exp / pretax * 100) if pretax > 0 else 21.0, 1)
    tax_rate = max(0.0, min(tax_rate, 40.0))

    # Beta and price from profile
    beta         = float(profile.get("beta") or 1.0)
    market_price = profile.get("price") or None
    market_cap   = profile.get("marketCap") or None

    # D/E ratio for WACC calculation
    total_debt = (balance.get("totalDebt") or 0) / 1e6
    equity     = (balance.get("totalStockholdersEquity") or 1) / 1e6
    de_ratio   = round(total_debt / equity if equity > 0 else 0.0, 2)

    # Target margin from analyst forward estimates (furthest year available)
    # estimatedEbitAvg / estimatedRevenueAvg gives consensus operating margin
    target_margin = None
    if estimates:
        best = max(estimates, key=lambda e: e.get("date", ""), default=None)
        if best:
            fwd_ebit = best.get("estimatedEbitAvg") or best.get("estimatedEbit") or 0
            fwd_rev  = best.get("estimatedRevenueAvg") or best.get("estimatedRevenue") or 0
            if fwd_rev and fwd_rev > 0:
                target_margin = round(fwd_ebit / fwd_rev * 100, 1)
    # Fallback: if deeply unprofitable and no estimates, default to 15%
    if target_margin is None:
        target_margin = op_margin if op_margin >= 0 else 15.0

    return {
        "revenue":       max(0.0, revenue),
        "op_margin":     op_margin,
        "target_margin": target_margin,
        "shares":        max(0.1, shares),
        "net_debt":      net_debt,
        "rev_growth":    rev_growth,
        "capex_pct":     max(0.0, capex_pct),
        "da_pct":        max(0.0, da_pct),
        "wc_pct":        wc_pct,
        "tax_rate":      tax_rate,
        "beta":          round(max(0.1, beta), 2),
        "market_price":  market_price,
        "market_cap":    market_cap,
        "de_ratio":      de_ratio,
    }
