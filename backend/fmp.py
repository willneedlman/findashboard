"""
Financial Modeling Prep (FMP) client — stable API.

Replaces slow yfinance .info calls for:
  - DCF fundamentals  (revenue, margins, debt, shares, beta, growth)
  - Corporate Hub     (real market cap, real % change, real P/E)

Stable API base: https://financialmodelingprep.com/stable
Set FMP_API_KEY in backend/.env or as an environment variable.
"""

import os
import threading
import concurrent.futures
import requests
from cachetools import TTLCache
from dotenv import load_dotenv
import logging

_log = logging.getLogger(__name__)

load_dotenv(os.path.join(os.path.dirname(__file__), ".env"))

_API_KEY = os.getenv("FMP_API_KEY", "")
_BASE    = "https://financialmodelingprep.com/stable"
_TIMEOUT = 8

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
    r = requests.get(f"{_BASE}{path}", params=p, timeout=_TIMEOUT)
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
