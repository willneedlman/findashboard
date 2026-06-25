import asyncio
import logging
import concurrent.futures
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field
from cachetools import TTLCache
import threading
import yfinance as yf
import sys, os
sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))
import fmp

logger = logging.getLogger(__name__)
router = APIRouter()

_screen_cache: TTLCache = TTLCache(maxsize=50, ttl=3600)   # 1 hr — screener results rarely change intraday
_detail_cache: TTLCache = TTLCache(maxsize=500, ttl=3600)  # 1 hr
_lock = threading.Lock()

try:
    from disk_cache import disk_get, disk_set
    _DISK = True
except ImportError:
    _DISK = False
    def disk_get(_k): return None  # type: ignore
    def disk_set(_k, _v, ttl=0): pass  # type: ignore

# Screener universe: bundled S&P 500 + S&P 400 (midcap) + Nasdaq 100 constituents
# (~915 names). Refresh data/index_constituents.json periodically; the index
# membership changes only quarterly.
def _norm_tk(t) -> str:
    # FMP uses dashes for share classes (BRK-B); Wikipedia/our list uses dots
    # (BRK.B). Normalize both to a dash so the intersection matches.
    return str(t).strip().upper().replace(".", "-")


def _load_universe() -> "tuple[set, list, dict]":
    import json
    try:
        path = os.path.join(os.path.dirname(os.path.dirname(__file__)), "data", "index_constituents.json")
        d = json.load(open(path))
        sets = {
            k: {_norm_tk(t) for t in d.get(k, []) if t}
            for k in ("sp500", "sp400", "nasdaq100")
        }
        uni = set().union(*sets.values())
        if uni:
            return uni, sorted(uni), sets
    except Exception as e:
        logger.warning("index constituents load failed: %s", e)
    return set(), [], {}

_UNIVERSE, _UNIVERSE_LIST, _INDEX_SETS = _load_universe()

# Selectable universes beyond the three raw index sets. Index ETFs reuse the
# bundled set of the index they track; Sector SPDRs are the S&P 500 members in
# one GICS sector, which is exactly what the Select Sector SPDR funds hold. Both
# resolve entirely against bundled data, so picking an ETF needs no holdings API.
_ETF_ALIAS = {
    "spy": "sp500", "voo": "sp500", "ivv": "sp500",
    "qqq": "nasdaq100",
    "mdy": "sp400", "ijh": "sp400",
}
_SECTOR_SPDR = {
    "xlk": "Technology", "xlv": "Healthcare", "xlf": "Financial Services",
    "xly": "Consumer Cyclical", "xlc": "Communication Services",
    "xli": "Industrials", "xlp": "Consumer Defensive", "xle": "Energy",
    "xlu": "Utilities", "xlre": "Real Estate", "xlb": "Basic Materials",
}

# Picker options for the frontend (value, label, group). "" screens all indexes.
UNIVERSE_OPTIONS = [
    {"value": "",          "label": "All (S&P 500 + 400 + Nasdaq 100)", "group": "Indexes"},
    {"value": "sp500",     "label": "S&P 500",         "group": "Indexes"},
    {"value": "sp400",     "label": "S&P 400 Midcap",  "group": "Indexes"},
    {"value": "nasdaq100", "label": "Nasdaq 100",      "group": "Indexes"},
    {"value": "spy", "label": "SPY · S&P 500",        "group": "Index ETFs"},
    {"value": "voo", "label": "VOO · S&P 500",        "group": "Index ETFs"},
    {"value": "ivv", "label": "IVV · S&P 500",        "group": "Index ETFs"},
    {"value": "qqq", "label": "QQQ · Nasdaq 100",     "group": "Index ETFs"},
    {"value": "mdy", "label": "MDY · S&P 400 Midcap", "group": "Index ETFs"},
    {"value": "ijh", "label": "IJH · S&P 400 Midcap", "group": "Index ETFs"},
    {"value": "xlk",  "label": "XLK · Technology",          "group": "Sector SPDRs"},
    {"value": "xlf",  "label": "XLF · Financials",          "group": "Sector SPDRs"},
    {"value": "xlv",  "label": "XLV · Health Care",         "group": "Sector SPDRs"},
    {"value": "xly",  "label": "XLY · Consumer Cyclical",   "group": "Sector SPDRs"},
    {"value": "xlc",  "label": "XLC · Communication Svcs",  "group": "Sector SPDRs"},
    {"value": "xli",  "label": "XLI · Industrials",         "group": "Sector SPDRs"},
    {"value": "xlp",  "label": "XLP · Consumer Defensive",  "group": "Sector SPDRs"},
    {"value": "xle",  "label": "XLE · Energy",              "group": "Sector SPDRs"},
    {"value": "xlu",  "label": "XLU · Utilities",           "group": "Sector SPDRs"},
    {"value": "xlre", "label": "XLRE · Real Estate",        "group": "Sector SPDRs"},
    {"value": "xlb",  "label": "XLB · Materials",           "group": "Sector SPDRs"},
]


def _resolve_universe(u) -> "tuple[set, str | None]":
    """Map a universe key to (allowed ticker set, optional sector lens). Index
    ETFs reuse the tracked index's bundled set; Sector SPDRs are the S&P 500
    members in that GICS sector. Unknown/empty -> the full bundled universe."""
    if not u:
        return _UNIVERSE, None
    key = str(u).lower()
    if key in _INDEX_SETS:
        return _INDEX_SETS[key], None
    if key in _ETF_ALIAS:
        return _INDEX_SETS.get(_ETF_ALIAS[key], _UNIVERSE), None
    if key in _SECTOR_SPDR:
        return _INDEX_SETS.get("sp500", _UNIVERSE), _SECTOR_SPDR[key]
    return _UNIVERSE, None

# Max NEW (uncached) tickers a single screen may deep-fetch. Cached fundamentals
# (30d disk cache, filled by the backfill loop below) enrich for free, so a cold
# screen stays well under the free-tier FMP daily cap. Tune via env.
_LIVE_ENRICH_BUDGET = int(os.getenv("SCREENER_LIVE_ENRICH", "25"))


def _backfill_order() -> list:
    seen: set = set()
    out: list = []
    for k in ("nasdaq100", "sp500", "sp400"):         # most-screened indices first
        for t in sorted(_INDEX_SETS.get(k, ())):
            if t not in seen:
                seen.add(t)
                out.append(t)
    return out


_BACKFILL_ORDER = _backfill_order()
_backfill_task = None


def _backfill_once(daily: int) -> int:
    """Warm up to `daily` new tickers' fundamentals into the 30d cache. A disk flag
    with a 20h TTL makes this idempotent across restarts/redeploys so repeated
    deploys can't stack multiple runs and blow the free-tier daily FMP cap."""
    if not fmp.available():
        return 0
    if disk_get("screener:backfill:ran") is not None:
        return -1
    fetched = 0
    for sym in _BACKFILL_ORDER:
        if fetched >= daily:
            break
        if fmp.get_fundamentals(sym, cached_only=True) is not None:
            continue
        if fmp.get_fundamentals(sym):
            fetched += 1
    # Hold the redeploy-stacking guard for ~20h after real progress; if nothing
    # was fetched (free daily cap exhausted / throttled), keep a short window so
    # the next run retries once the quota resets instead of idling a full day.
    disk_set("screener:backfill:ran", 1, ttl=72000 if fetched else 7200)
    return fetched


async def _backfill_loop():
    await asyncio.sleep(180)                           # let startup settle
    daily = int(os.getenv("SCREENER_BACKFILL_DAILY", "80"))
    while True:
        try:
            n = await asyncio.to_thread(_backfill_once, daily)
            if n >= 0:
                logger.info("screener backfill: warmed %d new tickers", n)
            next_delay = 86400 if (n and n > 0) else 7200   # retry sooner on a capped day
        except asyncio.CancelledError:
            return
        except Exception as e:
            logger.warning("screener backfill error: %s", e)
            next_delay = 7200
        await asyncio.sleep(next_delay)


def start_backfill_loop():
    global _backfill_task
    try:
        _backfill_task = asyncio.get_event_loop().create_task(_backfill_loop())
    except Exception as e:
        logger.warning("backfill loop start failed: %s", e)


def stop_backfill_loop():
    global _backfill_task
    if _backfill_task:
        _backfill_task.cancel()
        _backfill_task = None

# ── Request schema ────────────────────────────────────────────────────────────

class FilterRule(BaseModel):
    field:    str
    operator: str   # gt | lt | gte | lte | eq | between
    value:    float
    value2:   float | None = None  # for 'between'
    param:    str | None = None    # period for parameterized fields (priceChange): 1D|1W|1M|3M|6M|YTD|1Y

class ScreenRequest(BaseModel):
    filters:    list[FilterRule] = []
    sector:     str | None = None
    industry:   str | None = None
    exchange:   str | None = None
    sort_by:    str = "marketCap"
    sort_dir:   str = "desc"
    sort_param: str | None = None   # period when sorting by priceChange
    limit:      int = Field(default=50, ge=1, le=500)
    universe:   str | None = None   # 'sp500' | 'sp400' | 'nasdaq100' | None (all three)

# ── Field definitions visible to the frontend ─────────────────────────────────

SCREENER_FIELDS = [
    # Price & Market
    {"id": "price",          "label": "Price ($)",           "group": "Price & Market"},
    {"id": "marketCap",      "label": "Market Cap ($B)",      "group": "Price & Market"},
    {"id": "volume",         "label": "Volume",               "group": "Price & Market"},
    {"id": "avgVolume",      "label": "Avg Volume",           "group": "Price & Market"},
    {"id": "beta",           "label": "Beta",                 "group": "Price & Market"},
    {"id": "priceChange",    "label": "Price Change (%)",     "group": "Price & Market", "param": "period"},
    {"id": "change52wHiPct", "label": "% Below 52W High",    "group": "Price & Market"},
    # Valuation
    {"id": "peRatio",        "label": "P/E Ratio",            "group": "Valuation"},
    {"id": "forwardPE",      "label": "Forward P/E",          "group": "Valuation"},
    {"id": "pbRatio",        "label": "P/B Ratio",            "group": "Valuation"},
    {"id": "psRatio",        "label": "P/S Ratio",            "group": "Valuation"},
    {"id": "evEbitda",       "label": "EV/EBITDA",            "group": "Valuation"},
    {"id": "pegRatio",       "label": "PEG Ratio",            "group": "Valuation"},
    # Growth
    {"id": "revenueGrowth",  "label": "Revenue Growth YoY (%)", "group": "Growth"},
    {"id": "epsGrowth",      "label": "EPS Growth YoY (%)",  "group": "Growth"},
    # Profitability
    {"id": "grossMargin",    "label": "Gross Margin (%)",     "group": "Profitability"},
    {"id": "operatingMargin","label": "Operating Margin (%)", "group": "Profitability"},
    {"id": "netMargin",      "label": "Net Margin (%)",       "group": "Profitability"},
    {"id": "roe",            "label": "ROE (%)",              "group": "Profitability"},
    {"id": "roa",            "label": "ROA (%)",              "group": "Profitability"},
    # Financial Health
    {"id": "debtEquity",     "label": "Debt / Equity",        "group": "Financial Health"},
    {"id": "currentRatio",   "label": "Current Ratio",        "group": "Financial Health"},
    {"id": "interestCoverage","label": "Interest Coverage",   "group": "Financial Health"},
    # Dividends
    {"id": "dividendYield",  "label": "Dividend Yield (%)",   "group": "Dividends"},
    {"id": "payoutRatio",    "label": "Payout Ratio (%)",     "group": "Dividends"},
    # Technical (computed from 1y daily history; only when a technical filter/sort is used)
    {"id": "rsi14",          "label": "RSI (14)",             "group": "Technical"},
    {"id": "smaDist50",      "label": "Price vs 50D MA (%)",  "group": "Technical"},
    {"id": "smaDist200",     "label": "Price vs 200D MA (%)", "group": "Technical"},
    {"id": "vol30",          "label": "30D Volatility (%)",   "group": "Technical"},
]

# Selectable lookback periods for the parameterized Price Change filter, mapped to
# trading-day offsets (YTD is date-based and handled separately).
PRICE_CHANGE_PERIODS = ["1D", "1W", "1M", "3M", "6M", "YTD", "1Y"]
_PERIOD_DAYS = {"1D": 1, "1W": 5, "1M": 21, "3M": 63, "6M": 126, "1Y": 252}

# Fields requiring price-history computation (gated so a fundamentals-only screen
# never pays the history-download cost). priceChange is parameterized by period.
TECH_FIELDS = {"rsi14", "smaDist50", "smaDist200", "vol30"}
HISTORY_FIELDS = TECH_FIELDS | {"priceChange"}

SECTORS = ["Technology","Healthcare","Financial Services","Consumer Cyclical",
           "Industrials","Communication Services","Consumer Defensive",
           "Energy","Utilities","Real Estate","Basic Materials"]

EXCHANGES = ["NASDAQ", "NYSE", "AMEX"]

@router.get("/fields")
def get_fields():
    return {"fields": SCREENER_FIELDS, "sectors": SECTORS, "exchanges": EXCHANGES, "universes": UNIVERSE_OPTIONS}

# ── FMP screener params builder ───────────────────────────────────────────────

def _fmp_params_from_filters(filters: list[FilterRule], sector, exchange, limit) -> dict:
    # FMP returns by descending market cap, so to reliably include the smallest
    # index members (S&P 400 midcaps sit well below the mega caps) we pull the
    # full top band before intersecting/curating client-side.
    p: dict = {"limit": 3000}
    if sector:
        p["sector"] = sector
    if exchange:
        p["exchange"] = exchange.lower()  # FMP expects lowercase exchange codes

    field_map = {
        "marketCap":     ("marketCapMoreThan", "marketCapLessThan", 1e9),
        "price":         ("priceMoreThan",     "priceLessThan",     1),
        "volume":        ("volumeMoreThan",    "volumeLessThan",    1),
        "beta":          ("betaMoreThan",      "betaLessThan",      1),
        "dividendYield": ("dividendMoreThan",  "dividendLessThan",  0.01),
    }

    for f in filters:
        if f.field not in field_map:
            continue
        more_key, less_key, scale = field_map[f.field]
        val = f.value * scale
        if f.operator in ("gt", "gte"):
            p[more_key] = val
        elif f.operator in ("lt", "lte"):
            p[less_key] = val
        elif f.operator == "between" and f.value2 is not None:
            p[more_key] = val
            p[less_key] = f.value2 * scale

    return p

# ── Detail enrichment per ticker ──────────────────────────────────────────────

def _enrich(ticker: str, base: dict, claim) -> dict:
    cache_key = ticker
    with _lock:
        if cache_key in _detail_cache:
            return {**base, **_detail_cache[cache_key]}

    try:
        tkr = yf.Ticker(ticker)
        fi = tkr.fast_info

        hi52       = getattr(fi, "year_high",                    None)
        last_price = getattr(fi, "last_price",                   None)
        prev_close = getattr(fi, "previous_close",               None)
        avg_vol    = getattr(fi, "three_month_average_volume",   None)
        price      = base.get("price") or last_price

        change52 = round((price / hi52 - 1) * 100, 1) if hi52 and price and hi52 > 0 else None

        # Always calculate 1D% from fast_info; only fall back to base if unavailable
        change1d = base.get("change1d")
        if change1d is None and prev_close and last_price and prev_close > 0:
            change1d = round((last_price / prev_close - 1) * 100, 2)

        detail: dict = {
            "avgVolume":      int(avg_vol) if avg_vol else None,
            "change52wHiPct": change52,
            "change1d":       change1d,
        }

        # Deep fundamentals: free when cached (30d disk, filled by the backfill job
        # and prior screens); otherwise one budget unit, so a single cold screen
        # can't blow the free-tier daily FMP cap. Uncached + no budget -> the
        # yfinance .info fallback below fills what it can.
        fmp_ok = False
        fund = fmp.get_fundamentals(ticker, cached_only=True) if fmp.available() else None
        granted = fund is not None or claim()
        if granted and fund is None and fmp.available():
            fund = fmp.get_fundamentals(ticker)
        if fund:
            try:
                prof = fund.get("profile") or {}
                inc  = fund.get("income") or []
                bal  = fund.get("balance") or {}
                income       = inc[0] if inc else {}
                income_prior = inc[1] if len(inc) > 1 else {}

                rev       = income.get("revenue") or 0
                rev_prior = income_prior.get("revenue") or 0
                eps       = income.get("epsDiluted") or 0
                eps_prior = income_prior.get("epsDiluted") or 0
                gross     = income.get("grossProfit") or 0
                op_inc    = income.get("operatingIncome") or 0
                net_inc   = income.get("netIncome") or 0
                # Price/market cap from base (fresh from the screener call) so the
                # 30d-cached statements never make price-derived ratios stale.
                price_val = price or prof.get("price")
                mktcap    = (base.get("marketCap") or 0) * 1e9 or (prof.get("marketCap") or 0)
                ebitda    = income.get("ebitda") or 0
                total_debt      = bal.get("totalDebt") or 0
                equity          = bal.get("totalStockholdersEquity") or 1
                total_assets    = bal.get("totalAssets") or 1
                current_assets  = bal.get("totalCurrentAssets") or 0
                current_liab    = bal.get("totalCurrentLiabilities") or 1
                interest        = abs(income.get("interestExpense") or 0)
                ev_raw          = mktcap + total_debt - (bal.get("cashAndCashEquivalents") or 0)

                # Map FMP exchangeShortName to standard display name
                fmp_exch = (prof.get("exchangeShortName") or "").upper()
                if fmp_exch and not base.get("exchange"):
                    detail["exchange"] = fmp_exch

                detail.update({
                    "companyName":    prof.get("companyName") or base.get("companyName"),
                    "sector":         prof.get("sector") or base.get("sector"),
                    "industry":       prof.get("industry") or base.get("industry"),
                    "peRatio":        round(price_val / eps, 1) if eps > 0 and price_val else None,
                    "forwardPE":      None,
                    "pbRatio":        round(mktcap / equity, 2) if equity > 0 else None,
                    "psRatio":        round(mktcap / rev, 2) if rev > 0 else None,
                    "evEbitda":       round(ev_raw / ebitda, 1) if ebitda > 0 else None,
                    "grossMargin":    round(gross / rev * 100, 1) if rev else None,
                    "operatingMargin":round(op_inc / rev * 100, 1) if rev else None,
                    "netMargin":      round(net_inc / rev * 100, 1) if rev else None,
                    "roe":            round(net_inc / equity * 100, 1) if equity > 0 else None,
                    "roa":            round(net_inc / total_assets * 100, 1) if total_assets > 0 else None,
                    "debtEquity":     round(total_debt / equity, 2) if equity > 0 else None,
                    "currentRatio":   round(current_assets / current_liab, 2) if current_liab > 0 else None,
                    "interestCoverage": round(op_inc / interest, 1) if interest > 0 else None,
                    "revenueGrowth":  round((rev / rev_prior - 1) * 100, 1) if rev and rev_prior else None,
                    "epsGrowth":      round((eps / eps_prior - 1) * 100, 1) if eps and eps_prior and eps_prior > 0 else None,
                    "dividendYield":  round((prof.get("lastAnnualDividend") or 0) / price_val * 100, 2) if price_val and price_val > 0 else None,
                })
                fmp_ok = True
            except Exception:
                pass

        # Always use yfinance for company name if FMP didn't provide it or it equals the ticker
        company_from_base = base.get("companyName") or ""
        needs_name = not detail.get("companyName") or detail.get("companyName") == ticker

        # Map yfinance exchange codes to standard display names (used as fallback if FMP didn't populate it)
        _YF_EXCHANGE_MAP = {
            "NMS": "NASDAQ", "NGM": "NASDAQ", "NCM": "NASDAQ", "NAS": "NASDAQ",
            "NYQ": "NYSE",   "NYS": "NYSE",
            "ASE": "AMEX",   "PCX": "AMEX",
        }

        # Populate exchange from yfinance whenever it's not already set (from base or FMP profile)
        if granted and not detail.get("exchange") and not base.get("exchange"):
            try:
                info_dict = tkr.info
                yf_exch = (info_dict.get("exchange") or "").upper()
                mapped_exch = _YF_EXCHANGE_MAP.get(yf_exch, yf_exch)
                if mapped_exch:
                    detail["exchange"] = mapped_exch
            except Exception:
                pass

        if granted and (not fmp_ok or needs_name):
            try:
                info_dict = tkr.info
                cn = info_dict.get("longName") or info_dict.get("shortName")
                if cn:
                    detail["companyName"] = cn
                # Fill fundamentals from yfinance when FMP was unavailable/failed
                if not fmp_ok:
                    detail.update({
                        "peRatio":        info_dict.get("trailingPE"),
                        "forwardPE":      info_dict.get("forwardPE"),
                        "pbRatio":        info_dict.get("priceToBook"),
                        "psRatio":        info_dict.get("priceToSalesTrailing12Months"),
                        "evEbitda":       info_dict.get("enterpriseToEbitda"),
                        "pegRatio":       info_dict.get("trailingPegRatio"),
                        "grossMargin":    round((info_dict.get("grossMargins") or 0) * 100, 1),
                        "operatingMargin":round((info_dict.get("operatingMargins") or 0) * 100, 1),
                        "netMargin":      round((info_dict.get("profitMargins") or 0) * 100, 1),
                        "roe":            round((info_dict.get("returnOnEquity") or 0) * 100, 1),
                        "roa":            round((info_dict.get("returnOnAssets") or 0) * 100, 1),
                        "debtEquity":     info_dict.get("debtToEquity"),
                        "currentRatio":   info_dict.get("currentRatio"),
                        "revenueGrowth":  round((info_dict.get("revenueGrowth") or 0) * 100, 1),
                        "epsGrowth":      round((info_dict.get("earningsGrowth") or 0) * 100, 1),
                        "dividendYield":  round((info_dict.get("dividendYield") or 0) * 100, 2),
                        "sector":         info_dict.get("sector") or base.get("sector"),
                        "industry":       info_dict.get("industry") or base.get("industry"),
                    })
            except Exception:
                if needs_name:
                    detail["companyName"] = company_from_base or ticker

    except Exception as e:
        logger.warning("enrich %s: %s", ticker, e)
        detail = {}

    with _lock:
        _detail_cache[cache_key] = detail

    return {**base, **detail}

# ── Filter application ────────────────────────────────────────────────────────

def _passes(row: dict, filters: list[FilterRule]) -> bool:
    for f in filters:
        # priceChange is parameterized: resolve to the chosen period's value.
        if f.field == "priceChange":
            val = row.get(f"chg:{f.param if f.param in PRICE_CHANGE_PERIODS else '1D'}")
        else:
            val = row.get(f.field)
        if val is None:
            return False
        try:
            v = float(val)
            fv = float(f.value)
        except (TypeError, ValueError):
            continue
        if   f.operator in ("gt",  ">"):  ok = v > fv
        elif f.operator in ("gte", ">="): ok = v >= fv
        elif f.operator in ("lt",  "<"):  ok = v < fv
        elif f.operator in ("lte", "<="): ok = v <= fv
        elif f.operator == "eq":          ok = abs(v - fv) < 0.01
        elif f.operator == "between" and f.value2 is not None:
            ok = fv <= v <= float(f.value2)
        else:
            ok = True
        if not ok:
            return False
    return True

# ── Technical indicators (computed from daily closes) ─────────────────────────

def _history_metrics(series) -> dict:
    """From a daily-close pandas Series (DatetimeIndex, oldest first): RSI(14,
    Wilder), price-vs-SMA distances, 30D vol, and price change for each lookback
    period (stored as chg:<period>, including a date-based YTD)."""
    import numpy as np
    out: dict = {}
    s = series.dropna()
    c = s.values.astype(float)
    if c.size < 30:
        return out
    price = float(c[-1])
    if c.size >= 50:
        out["smaDist50"] = round((price / c[-50:].mean() - 1) * 100, 1)
    if c.size >= 200:
        out["smaDist200"] = round((price / c[-200:].mean() - 1) * 100, 1)

    delta = np.diff(c)
    if delta.size >= 14:
        gain = np.where(delta > 0, delta, 0.0)
        loss = np.where(delta < 0, -delta, 0.0)
        # Wilder smoothing: seed with the first 14-period average, then EMA.
        ag = gain[:14].mean(); al = loss[:14].mean()
        for i in range(14, delta.size):
            ag = (ag * 13 + gain[i]) / 14
            al = (al * 13 + loss[i]) / 14
        out["rsi14"] = 100.0 if al == 0 else round(100 - 100 / (1 + ag / al), 1)

    if c.size >= 31:
        rets = np.diff(np.log(c[-31:]))
        out["vol30"] = round(float(rets.std(ddof=1)) * (252 ** 0.5) * 100, 1)

    for p, d in _PERIOD_DAYS.items():
        # Clamp the offset to the available span so 1Y (≈252d, often just over the
        # ~251 trading days in a 1y pull) falls back to the earliest close instead
        # of going None.
        idx = d if c.size > d else c.size - 1
        out[f"chg:{p}"] = round((c[-1] / c[-1 - idx] - 1) * 100, 1) if idx > 0 else None
    try:
        import datetime
        mask = s.index >= f"{datetime.date.today().year}-01-01"
        if mask.any():
            base = float(s[mask].iloc[0])
            out["chg:YTD"] = round((price / base - 1) * 100, 1) if base else None
    except Exception:
        pass
    return out


def _compute_history_batch(tickers: list[str]) -> dict:
    """Map ticker -> history-metrics dict. Disk-cached per ticker (daily TTL);
    uncached names are pulled in one batched yfinance download (no N HTTP calls)."""
    out: dict = {}
    need: list[str] = []
    for t in tickers:
        cached = disk_get(f"histv2:{t}")
        if cached is not None:
            out[t] = cached
        else:
            need.append(t)
    if not need:
        return out
    try:
        data = yf.download(need, period="1y", interval="1d", group_by="ticker",
                           threads=True, progress=False, auto_adjust=True)
    except Exception as e:
        logger.warning("history batch download failed: %s", e)
        data = None
    for t in need:
        metrics: dict = {}
        try:
            if data is not None:
                closes = (data[t]["Close"] if len(need) > 1 else data["Close"])
                metrics = _history_metrics(closes)
        except Exception:
            metrics = {}
        # Only cache real results; caching {} on a transient download failure would
        # blank the whole universe's history for the full 24h TTL.
        if metrics:
            disk_set(f"histv2:{t}", metrics, ttl=86400)
        out[t] = metrics
    return out


# ── Main screen endpoint ──────────────────────────────────────────────────────

@router.post("/run")
def run_screen(req: ScreenRequest):
    import json, hashlib
    # Bump CACHE_VER whenever screener logic changes to invalidate stale disk-cached results
    CACHE_VER = "v8"
    cache_key = CACHE_VER + hashlib.md5(json.dumps(req.model_dump(), sort_keys=True).encode()).hexdigest()
    with _lock:
        if cache_key in _screen_cache:
            return _screen_cache[cache_key]
    disk_val = disk_get(f"screen:{cache_key}")
    if disk_val is not None:
        with _lock:
            _screen_cache[cache_key] = disk_val
        return disk_val

    candidates: list[dict] = []

    # Resolve the chosen universe to an allowed ticker set + optional sector lens.
    # A Sector SPDR pick (e.g. XLK) screens the S&P 500 members in that sector, so
    # its sector flows through the same path the Sector dropdown uses.
    uni_set, spdr_sector = _resolve_universe(req.universe)
    effective_sector = req.sector or spdr_sector
    # Technical indicators and price-change periods need price history, so only
    # compute them when a filter or the sort references one (keeps fundamentals-
    # only screens fast).
    need_history = req.sort_by in HISTORY_FIELDS or any(f.field in HISTORY_FIELDS for f in req.filters)

    fmp_screened = False  # tracks whether FMP already applied sector/exchange filtering
    if fmp.available():
        try:
            params = _fmp_params_from_filters(req.filters, effective_sector, req.exchange, req.limit)
            raw = fmp._get("/stock-screener", params)
            if isinstance(raw, list) and raw:
                fmp_screened = True
                for r in raw:
                    candidates.append({
                        "ticker":      r.get("symbol", ""),
                        "companyName": r.get("companyName", ""),
                        "price":       r.get("price"),
                        "marketCap":   round((r.get("marketCap") or 0) / 1e9, 2),
                        "beta":        r.get("beta"),
                        "volume":      r.get("volume"),
                        "sector":      r.get("sector", ""),
                        "industry":    r.get("industry", ""),
                        "exchange":    r.get("exchangeShortName", ""),
                        "change1d":    r.get("changesPercentage"),
                        "_fmp_screened": True,
                    })
        except Exception as e:
            logger.warning("FMP screener error: %s", e)

    # Curate to the chosen index universe (S&P 500 / S&P 400 midcap / Nasdaq 100).
    # req.universe picks one index; otherwise all three. Strict: the user asked to
    # screen within an index, so we never fall back to non-index names — an empty
    # result honestly means nothing in that index passed the filters.
    if _UNIVERSE and candidates:
        candidates = [c for c in candidates if _norm_tk(c["ticker"]) in uni_set]

    # Fallback: sector-aware liquid tickers via yfinance
    SECTOR_TICKERS: dict[str, list[str]] = {
        "technology":            ["AAPL","MSFT","NVDA","GOOGL","META","ORCL","AMD","CSCO","ADBE","CRM","INTC","QCOM","TXN","AMAT","LRCX","MU","KLAC","SNPS","CDNS","ACN","IBM","INTU","NOW","PANW","CRWD"],
        "healthcare":            ["UNH","LLY","JNJ","ABBV","MRK","TMO","ABT","BMY","AMGN","DHR","PFE","CVS","CI","BSX","ELV","MDT","ISRG","VRTX","REGN","GILD","HCA","HUM","CNC","ZBH","MOH"],
        "financial services":    ["BRK-B","JPM","V","MA","BAC","GS","MS","AXP","BLK","SPGI","CME","ICE","SCHW","USB","WFC","C","PNC","TFC","MTB","ALLY","COF","SYF","DFS","FITB","KEY"],
        "consumer cyclical":     ["AMZN","TSLA","HD","MCD","NKE","SBUX","TGT","LOW","COST","BKNG","MAR","HLT","ROST","TJX","DHI","LEN","NVR","PHM","F","GM","UBER","LYFT","SHOP","W","ETSY"],
        "industrials":           ["CAT","RTX","HON","UPS","DE","BA","MMM","GE","LMT","NOC","GD","EMR","ETN","PH","ROK","CMI","PCAR","FDX","CSX","NSC","UNP","WM","RSG","EXPD","XPO"],
        "communication services":["GOOGL","META","DIS","CMCSA","NFLX","VZ","T","TMUS","ATVI","EA","TTWO","SNAP","PINS","MTCH","FOXA","PARA","WBD","IPG","OMC","NYT","IAC","ZM","TWLO","BANDWIDTH","SEZL"],
        "consumer defensive":    ["WMT","PG","KO","PEP","MO","PM","COST","MDLZ","CL","KMB","GIS","K","CPB","HRL","CAG","SJM","MKC","CHD","CLX","TSN","KHC","ADM","BG","CALM","POST"],
        "energy":                ["XOM","CVX","COP","EOG","SLB","PXD","MPC","VLO","PSX","OXY","DVN","HAL","BKR","FANG","APA","HES","MRO","PR","CLR","SM","RRC","AR","CNX","CTRA","EQT"],
        "utilities":             ["NEE","DUK","SO","D","AEP","SRE","EXC","XEL","PEG","ED","ES","EIX","FE","ETR","PPL","AES","NI","WEC","CMS","LNT","EVRG","ATO","NWE","OGE","AVA","PNW","OTTR","POR","MGEE","IDACORP","BKH","PNM","UIL","UGI"],
        "real estate":           ["PLD","AMT","EQIX","CCI","SPG","O","PSA","WELL","DLR","AVB","EQR","MAA","UDR","CPT","ESS","NNN","VICI","GLPI","MGM","MPW","VTR","PEAK","ARE","BXP","KIM"],
        "basic materials":       ["LIN","APD","ECL","SHW","FCX","NEM","NUE","STLD","RS","VMC","MLM","MOS","CF","DOW","LYB","PPG","RPM","EMN","HUN","OLN","ATI","CC","CSTM","AA","X"],
    }
    LIQUID_TICKERS = [
        "AAPL","MSFT","NVDA","AMZN","GOOGL","META","TSLA","BRK-B","JPM","V",
        "UNH","XOM","LLY","JNJ","WMT","MA","PG","HD","MRK","ORCL",
        "COST","ABBV","CVX","BAC","NFLX","KO","PEP","ADBE","TMO","CSCO",
        "AMD","ACN","MCD","NKE","DHR","INTC","QCOM","IBM","TXN","PM",
        "UPS","CAT","RTX","HON","AMGN","SBUX","GE","DE","BA","MMM",
        "GS","MS","AXP","BLK","SPGI","CME","ICE","SCHW","USB","WFC",
        "DIS","CMCSA","VZ","T","TMUS","CRM","NOW","INTU","AMAT","LRCX",
        "MU","KLAC","SNPS","CDNS","PANW","CRWD","ZS","OKTA","DDOG","NET",
        "SHOP","SQ","PYPL","COIN","HOOD","MSTR","PLTR","RBLX","UBER","LYFT",
    ]

    if not candidates:
        filter_sector = effective_sector.lower() if effective_sector else None
        # Use sector-specific tickers when sector is requested; otherwise use broad list
        if filter_sector and filter_sector in SECTOR_TICKERS:
            tickers_to_fetch = SECTOR_TICKERS[filter_sector]
        elif _UNIVERSE_LIST:
            # Broad fallback over the index universe; capped because each name is a
            # separate yfinance fast_info call (this path only runs when FMP is down).
            sel = uni_set if req.universe else None
            tickers_to_fetch = (sorted(sel) if sel else _UNIVERSE_LIST)[:300]
        else:
            tickers_to_fetch = LIQUID_TICKERS

        def _quick(tk):
            try:
                fi = yf.Ticker(tk).fast_info
                price = getattr(fi, "last_price", None)
                mc    = getattr(fi, "market_cap", None)
                return {"ticker": tk, "companyName": tk,
                        "price":     round(float(price), 2) if price else None,
                        "marketCap": round(float(mc) / 1e9, 2) if mc else None,
                        "beta": None, "volume": None, "sector": "", "industry": "", "exchange": ""}
            except Exception:
                return None

        with concurrent.futures.ThreadPoolExecutor(max_workers=15) as ex:
            results = list(ex.map(_quick, tickers_to_fetch))
        candidates = [r for r in results if r and r.get("price")]
        # Pre-fill sector so post-enrichment filter doesn't strip them if yfinance/FMP fails
        if filter_sector and effective_sector:
            for c in candidates:
                if not c.get("sector"):
                    c["sector"] = effective_sector

    if not candidates:
        try:
            from ai_client import groq_complete, parse_json
            tickers_str = ", ".join(LIQUID_TICKERS[:20])
            raw = groq_complete(
                f"Return estimated fundamentals for: {tickers_str}\n"
                "JSON array with fields: ticker, companyName, sector, exchange, marketCap(B), "
                "peRatio, operatingMargin(%), netMargin(%), revenueGrowth(%), beta, price, isAiEstimate=true. "
                "No markdown, just the array.",
                max_tokens=1500,
            )
            ai_rows = parse_json(raw)
            if isinstance(ai_rows, list):
                candidates = [
                    {
                        "ticker":    r.get("ticker", ""),
                        "companyName": r.get("companyName", r.get("ticker", "")),
                        "price":     r.get("price"),
                        "marketCap": r.get("marketCap"),
                        "peRatio":   r.get("peRatio"),
                        "operatingMargin": r.get("operatingMargin"),
                        "netMargin": r.get("netMargin"),
                        "revenueGrowth": r.get("revenueGrowth"),
                        "beta":      r.get("beta"),
                        "sector":    r.get("sector", ""),
                        "exchange":  r.get("exchange", ""),
                        "isAiEstimate": True,
                        "change1d": None, "volume": None, "forwardPE": None,
                        "pbRatio": None, "psRatio": None, "evEbitda": None,
                        "grossMargin": None, "roe": None, "debtEquity": None,
                        "currentRatio": None, "epsGrowth": None,
                        "dividendYield": None, "change52wHiPct": None, "avgVolume": None,
                    }
                    for r in ai_rows if r.get("ticker")
                ]
        except Exception as e:
            logger.warning("AI screener fallback failed: %s", e)

    if not candidates:
        raise HTTPException(503, "No data source available. Configure FMP_API_KEY for best results.")

    # Enrich top candidates in parallel (cap at 150 to leave room for sector/exchange
    # filtering). Cached tickers enrich for free; new ones draw on a small per-screen
    # budget so a cold screen can't exhaust the free-tier daily FMP cap.
    to_enrich = candidates[:150]
    _budget = {"n": _LIVE_ENRICH_BUDGET}
    _budget_lock = threading.Lock()
    def _claim() -> bool:
        with _budget_lock:
            if _budget["n"] > 0:
                _budget["n"] -= 1
                return True
            return False
    with concurrent.futures.ThreadPoolExecutor(max_workers=10) as ex:
        enriched = list(ex.map(lambda c: _enrich(c["ticker"], c, _claim), to_enrich))

    # Apply sector / exchange filters (post-enrichment so sector data is populated).
    # Skip for FMP-screened candidates — FMP already filtered them at the source,
    # and its profile endpoint may use different sector naming (e.g. "Consumer Discretionary"
    # vs "Consumer Cyclical") which would incorrectly eliminate valid results.
    if effective_sector and not fmp_screened:
        fs = effective_sector.lower()
        enriched = [r for r in enriched if (r.get("sector") or "").lower() == fs]
    if req.exchange and not fmp_screened:
        fe = req.exchange.lower()
        enriched = [r for r in enriched if (r.get("exchange") or "").lower() == fe]

    # Merge history metrics (technicals + price-change periods) only when
    # requested, after sector/exchange filtering so history is fetched for the
    # smallest candidate set.
    display_period = None
    if need_history and enriched:
        hist = _compute_history_batch([r["ticker"] for r in enriched])
        for r in enriched:
            r.update(hist.get(r["ticker"], {}))
        # The Price Change column tracks the period the user is sorting/filtering
        # by, so the displayed value matches the active control.
        if req.sort_by == "priceChange":
            display_period = req.sort_param
        else:
            display_period = next((f.param for f in req.filters if f.field == "priceChange" and f.param), None)
        display_period = display_period if display_period in PRICE_CHANGE_PERIODS else "1D"
        for r in enriched:
            r["priceChange"] = r.get(f"chg:{display_period}")
    else:
        # No history needed: the Price Change column shows the free 1D move.
        for r in enriched:
            r["priceChange"] = r.get("change1d")

    # Apply precise client-side filters
    filtered = [r for r in enriched if _passes(r, req.filters)]

    # Sort
    reverse = req.sort_dir == "desc"
    STRING_FIELDS = {"ticker", "name", "sector", "industry"}
    def sort_key(r):
        v = r.get(req.sort_by)
        if req.sort_by in STRING_FIELDS:
            return str(v).lower() if v is not None else ""
        if v is None:
            return float("-inf") if reverse else float("inf")
        try:
            return float(v)
        except (TypeError, ValueError):
            return float("-inf") if reverse else float("inf")
    filtered.sort(key=sort_key, reverse=reverse)

    # Strip internal bookkeeping keys before returning (per-period change values
    # are collapsed into the single priceChange field above).
    for r in filtered:
        r.pop("_fmp_screened", None)
        for k in [k for k in r if k.startswith("chg:")]:
            r.pop(k, None)

    result = {"results": filtered[:req.limit], "total": len(filtered), "changePeriod": display_period or "1D"}
    with _lock:
        _screen_cache[cache_key] = result
    disk_set(f"screen:{cache_key}", result, ttl=3600)
    return result
