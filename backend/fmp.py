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
import threading
import concurrent.futures
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


def _get(path: str, params: dict | None = None) -> list | dict:
    p = dict(params or {})
    p["apikey"] = _API_KEY
    r = _session.get(f"{_BASE}{path}", params=p, timeout=_TIMEOUT)
    r.raise_for_status()
    return r.json()


def _get_v4(path: str, params: dict | None = None) -> list | dict:
    """FMP v4 API — broader coverage for segment data and other endpoints."""
    p = dict(params or {})
    p["apikey"] = _API_KEY
    r = _session.get(f"https://financialmodelingprep.com/api/v4{path}", params=p, timeout=_TIMEOUT)
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
    return _cached(_income_cache, key, fetch)


def get_balance(ticker: str) -> dict:
    """Latest annual balance sheet: totalDebt, cashAndCashEquivalents, netDebt, totalStockholdersEquity."""
    sym = ticker.strip().upper()
    def fetch():
        d = _get("/balance-sheet-statement", {"symbol": sym, "period": "annual", "limit": 1})
        return d[0] if isinstance(d, list) and d else {}
    return _cached(_balance_cache, sym, fetch)


def get_cashflow(ticker: str) -> dict:
    """Latest annual cash flow: capitalExpenditure (negative), depreciationAndAmortization, freeCashFlow."""
    sym = ticker.strip().upper()
    def fetch():
        d = _get("/cash-flow-statement", {"symbol": sym, "period": "annual", "limit": 1})
        return d[0] if isinstance(d, list) and d else {}
    return _cached(_cashflow_cache, sym, fetch)


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
    return _cached(_estimates_cache, key, fetch)


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

    return _cached(_fundamentals_cache, key, fetch)


_segments_cache: TTLCache = TTLCache(maxsize=200, ttl=86400)  # 24 hr


# FMP stable nests the segments under a "data" key; everything else is metadata.
_SEG_META_KEYS = {"date", "symbol", "reportedCurrency", "period", "fiscalYear", "calendarYear", "cik"}

EMPTY_SEGMENTS = {"fiscalYear": None, "currency": None, "latest": [], "history": [], "concentration": None}

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


def get_revenue_segments(ticker: str) -> dict:
    """Product revenue segments from FMP stable API → latest + history + YoY."""
    sym = ticker.strip().upper()
    def fetch():
        try:
            return _segment_history(_get("/revenue-product-segmentation", {"symbol": sym, "period": "annual"}))
        except Exception:
            return dict(EMPTY_SEGMENTS)
    return _cached(_segments_cache, f"{sym}:prod", fetch)


def get_geo_segments(ticker: str) -> dict:
    """Geographic revenue segments from FMP stable API → latest + history + YoY."""
    sym = ticker.strip().upper()
    def fetch():
        try:
            return _segment_history(_get("/revenue-geographic-segmentation", {"symbol": sym, "period": "annual"}))
        except Exception:
            return dict(EMPTY_SEGMENTS)
    return _cached(_segments_cache, f"{sym}:geo", fetch)


def get_dcf_fundamentals(ticker: str) -> dict:
    """
    Fetches profile + income(2yr) + balance + cashflow in parallel (~200ms).
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
    with concurrent.futures.ThreadPoolExecutor(max_workers=5) as ex:
        f_profile   = ex.submit(get_profile,            ticker)
        f_income    = ex.submit(get_income,             ticker, 2)
        f_balance   = ex.submit(get_balance,            ticker)
        f_cashflow  = ex.submit(get_cashflow,           ticker)
        f_estimates = ex.submit(get_analyst_estimates,  ticker, 3)

    profile   = f_profile.result()
    inc_list  = f_income.result()
    balance   = f_balance.result()
    cashflow  = f_cashflow.result()
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
