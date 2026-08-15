import asyncio
import datetime as _dt
import logging
import concurrent.futures
import re
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field
from cachetools import TTLCache
import threading
import yfinance as yf
import sys, os
sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))
import fmp
import industry_ratios
import market_cap as market_cap_lib

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


def _load_universe() -> "tuple[set, dict]":
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
            return uni, sets
    except Exception as e:
        logger.warning("index constituents load failed: %s", e)
    return set(), {}

_UNIVERSE, _INDEX_SETS = _load_universe()


def _load_us_fundamentals() -> "tuple[dict, str | None]":
    # Bundled basic stats (sector + ratios + margins + growth) for the US universe,
    # built offline from Finnhub by scripts/build_us_fundamentals.py. Serves as the
    # durable fallback so major US names always show real data when FMP is throttled
    # or a name's deep fundamentals aren't cached yet. Keyed by normalized ticker.
    # The build date rides along so a row served from here can say how old it is
    # instead of inheriting the wall clock.
    import json
    try:
        path = os.path.join(os.path.dirname(os.path.dirname(__file__)), "data", "us_fundamentals.json")
        d = json.load(open(path))
        if not isinstance(d, dict):
            return {}, None
        built_at = d.pop("_built_at", None) or _dt.datetime.fromtimestamp(
            os.path.getmtime(path), _dt.timezone.utc
        ).replace(microsecond=0).isoformat().replace("+00:00", "Z")
        return {_norm_tk(k): v for k, v in d.items()}, built_at
    except Exception as e:
        logger.warning("us fundamentals load failed: %s", e)
        return {}, None

_US_FUND, _US_FUND_BUILT_AT = _load_us_fundamentals()

_COMPANY_NAME_STOP = {
    "american", "bank", "capital", "central", "financial", "first", "general",
    "global", "group", "holdings", "international", "national", "northern",
    "united", "western",
}


def resolve_company_mentions(value: str, limit: int = 8) -> list[str]:
    text = re.sub(r"[^a-z0-9$.-]+", " ", str(value or "").lower()).strip()
    if not text:
        return []
    matches: list[tuple[int, float, str]] = []
    for ticker, row in _US_FUND.items():
        raw_name = str(row.get("companyName") or "").lower()
        name = re.sub(r"[^a-z0-9]+", " ", raw_name).strip()
        tokens = name.split()
        aliases = [name]
        if len(tokens) >= 2:
            aliases.append(" ".join(tokens[:2]))
        if tokens and len(tokens[0]) >= 5 and tokens[0] not in _COMPANY_NAME_STOP:
            aliases.append(tokens[0])
        ticker_key = ticker.lower().replace("-", ".")
        if re.search(rf"(?<![a-z0-9])\$?{re.escape(ticker_key)}(?![a-z0-9])", text):
            aliases.append(ticker_key)
        matched = max((len(alias) for alias in aliases if alias and re.search(
            rf"(?<![a-z0-9]){re.escape(alias)}(?![a-z0-9])", text
        )), default=0)
        if matched:
            matches.append((matched, float(row.get("marketCap") or 0), ticker))
    matches.sort(reverse=True)
    return [ticker for _, _, ticker in matches[:max(1, min(8, limit))]]

# Fundamental + descriptive fields the bundled seed can backfill on a row.
# cashRatio/payablesTurnover/cashConversionCycle/roic are NOT here — Finnhub's
# free metric bundle (the seed's only source) doesn't carry payables data or a
# clean invested-capital figure, so those stay live-fetch (FMP-covered
# tickers) only rather than an approximation on the seed fallback.
_SEED_FIELDS = ("companyName", "sector", "industry", "country", "beta", "peRatio",
                "pbRatio", "psRatio", "evEbitda", "pegRatio", "grossMargin",
                "operatingMargin", "netMargin", "roe", "roa", "debtEquity",
                "currentRatio", "quickRatio", "inventoryTurnover", "receivablesTurnover",
                "interestCoverage", "payoutRatio",
                "revenueGrowth", "epsGrowth", "dividendYield")

# SEC-primary fundamental ratios extracted from FactIQ (backend/data/reference.db,
# built by scripts/build_reference_db.py). These are computed from EDGAR filings, so
# they are fresher and more authoritative than the Finnhub seed for the same fields —
# preferred over the seed, but still deferring to any live FMP value. Price/market
# ratios (peRatio/pbRatio/beta/dividendYield/...) are NOT here and stay live.
_REF_FIELDS = ("grossMargin", "operatingMargin", "netMargin", "roe", "roa",
               "debtEquity", "currentRatio", "revenueGrowth", "epsGrowth")


def _load_reference_fundamentals() -> dict:
    import sqlite3
    try:
        path = os.path.join(os.path.dirname(os.path.dirname(__file__)), "data", "reference.db")
        if not os.path.exists(path):
            return {}
        conn = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
        conn.row_factory = sqlite3.Row
        rows = conn.execute("SELECT * FROM fundamentals").fetchall()
        conn.close()
        return {_norm_tk(r["ticker"]): {k: r[k] for k in _REF_FIELDS if r[k] is not None}
                for r in rows}
    except Exception as e:
        logger.warning("reference.db load failed: %s", e)
        return {}

_REF_FUND = _load_reference_fundamentals()


def _load_intl() -> "tuple[dict, dict]":
    # International tickers keep their exchange-suffix dot (SAP.DE, 7203.T), so they
    # are NOT run through _norm_tk (which would turn the dot into a dash). Names are
    # bundled (ticker -> name) so numeric Tokyo tickers always show a company name.
    import json
    try:
        path = os.path.join(os.path.dirname(os.path.dirname(__file__)), "data", "intl_constituents.json")
        d = json.load(open(path))
        sets, names = {}, {}
        for k, v in d.items():
            if k not in ("dax40", "ftse100", "nikkei225") or not isinstance(v, dict):
                continue
            sets[k] = {str(t).strip().upper() for t in v}
            for t, nm in v.items():
                names[str(t).strip().upper()] = nm
        return sets, names
    except Exception as e:
        logger.warning("intl constituents load failed: %s", e)
        return {}, {}

_INTL_SETS, _INTL_NAMES = _load_intl()
_INDEX_SETS.update(_INTL_SETS)        # so _resolve_universe + the yfinance path resolve them
_INTL_KEYS = set(_INTL_SETS.keys())   # universes that need USD FX-normalization + skip FMP
_ALL_INTL = set().union(*_INTL_SETS.values()) if _INTL_SETS else set()
_NIKKEI_FINANCIALS = {
    "5831.T", "7186.T", "8304.T", "8306.T", "8308.T", "8309.T", "8316.T", "8331.T", "8354.T", "8411.T",
    "8253.T", "8591.T", "8697.T", "8601.T", "8604.T", "8630.T", "8725.T", "8750.T", "8766.T", "8795.T",
}
_INTL_SECTOR_OVERRIDES = {ticker: "Financial Services" for ticker in _NIKKEI_FINANCIALS}
_INTL_SNAPSHOT_CACHE = "screener:intlsnap:v4"

# Deterministic listing metadata keeps a valid bundled name visible in region and
# exchange filters when a quote-provider profile is blank or rate-limited.
_INTL_LISTING_METADATA = {
    "ftse100": {"country": "United Kingdom", "region": "Europe", "exchange": "LSE"},
    "dax40": {"country": "Germany", "region": "Europe", "exchange": "XETRA"},
    "nikkei225": {"country": "Japan", "region": "Asia-Pacific", "exchange": "TSE"},
}
_INTL_COUNTRY = {key: value["country"] for key, value in _INTL_LISTING_METADATA.items()}
_INTL_TICKER_METADATA = {
    ticker: _INTL_LISTING_METADATA[key]
    for key, tickers in _INTL_SETS.items()
    for ticker in tickers
}
REGIONS = ["North America", "Europe", "Asia-Pacific"]
_COUNTRY_REGION = {
    "United States": "North America", "US": "North America", "USA": "North America",
    "Canada": "North America", "CA": "North America", "Mexico": "North America", "MX": "North America",
    "United Kingdom": "Europe", "GB": "Europe", "UK": "Europe", "Germany": "Europe", "DE": "Europe", "France": "Europe", "FR": "Europe", "Netherlands": "Europe",
    "Switzerland": "Europe", "Ireland": "Europe", "Spain": "Europe", "Italy": "Europe",
    "Sweden": "Europe", "Denmark": "Europe", "Finland": "Europe", "Norway": "Europe",
    "Belgium": "Europe", "Luxembourg": "Europe", "Austria": "Europe", "Portugal": "Europe",
    "Japan": "Asia-Pacific", "JP": "Asia-Pacific", "China": "Asia-Pacific", "CN": "Asia-Pacific", "Hong Kong": "Asia-Pacific", "HK": "Asia-Pacific",
    "Taiwan": "Asia-Pacific", "TW": "Asia-Pacific", "South Korea": "Asia-Pacific", "KR": "Asia-Pacific", "Australia": "Asia-Pacific", "AU": "Asia-Pacific",
    "Singapore": "Asia-Pacific", "SG": "Asia-Pacific", "India": "Asia-Pacific", "IN": "Asia-Pacific",
}

# Sector SPDRs are the S&P 500 members in one GICS sector, which is exactly what
# the Select Sector SPDR funds hold — resolved against bundled data, no API.
_SECTOR_SPDR = {
    "xlk": "Technology", "xlv": "Healthcare", "xlf": "Financial Services",
    "xly": "Consumer Cyclical", "xlc": "Communication Services",
    "xli": "Industrials", "xlp": "Consumer Defensive", "xle": "Energy",
    "xlu": "Utilities", "xlre": "Real Estate", "xlb": "Basic Materials",
}

# Picker options for the frontend (value, label, group). "" = every bundled seed,
# not a worldwide universe.
UNIVERSE_OPTIONS = [
    {"value": "",          "label": "Bundled Universes", "group": "Indexes"},
    {"value": "sp500",     "label": "S&P 500",         "group": "Indexes"},
    {"value": "sp400",     "label": "S&P 400 Midcap",  "group": "Indexes"},
    {"value": "nasdaq100", "label": "Nasdaq 100",      "group": "Indexes"},
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
    {"value": "ftse100",   "label": "UK Large Caps",        "group": "International"},
    {"value": "dax40",     "label": "DAX 40 · Germany",     "group": "International"},
    {"value": "nikkei225", "label": "Japan Large Caps",     "group": "International"},
]
INTERNATIONAL_COVERAGE_NOTE = "International and regional screens are curated unless their coverage panel says validated complete."


def _load_coverage_contract() -> dict:
    import json
    path = os.path.join(os.path.dirname(os.path.dirname(__file__)), "data", "screener_coverage.json")
    try:
        with open(path) as handle:
            contract = json.load(handle)
    except Exception as exc:
        logger.warning("screener coverage contract load failed: %s", exc)
        return {"universes": {}, "regions": {}}
    for key, entry in contract.get("universes", {}).items():
        entry["available"] = len(_INDEX_SETS.get(key, ()))
    return contract


_COVERAGE_CONTRACT = _load_coverage_contract()


def _coverage_for_scope(universe: str | None = None, region: str | None = None) -> dict:
    """Return an honest, small coverage payload for the selected screener scope."""
    if universe:
        entry = _COVERAGE_CONTRACT.get("universes", {}).get(str(universe).lower())
        if entry:
            return {"scope": entry["label"], **entry}
    if region:
        entry = _COVERAGE_CONTRACT.get("regions", {}).get(region)
        if entry:
            return {"scope": region, **entry}
    return {
        "scope": "Bundled universes",
        "status": "curated",
        "source": "Bundled index seeds; this is not a global market-wide universe",
    }


_FX_CACHE: TTLCache = TTLCache(maxsize=32, ttl=3600)
# Approximate fallbacks so a transient FX-rate fetch failure doesn't silently
# leave international values in local currency labeled as USD.
_FX_FALLBACK = {"EUR": 1.08, "GBP": 1.27, "JPY": 0.0067, "CHF": 1.12, "CAD": 0.73,
                "AUD": 0.66, "HKD": 0.128, "SGD": 0.74, "SEK": 0.095, "DKK": 0.145}

def _fx_to_usd(currency) -> "tuple[float, float]":
    """Return (rate, divisor) converting a listing currency to USD: value/divisor*rate.
    GBp (London pence) divides by 100 then applies GBPUSD. Rates from yfinance FX
    pairs, cached (mem + disk). Unknown/failed rate falls back to 1.0 (no-op)."""
    raw = currency or "USD"
    base, div = ("GBP", 100.0) if raw == "GBp" else (str(raw).upper(), 1.0)
    if base == "USD":
        return 1.0, div
    if base in _FX_CACHE:
        return _FX_CACHE[base], div
    rate = disk_get(f"fx:{base}")
    if rate is None:
        try:
            rate = float(yf.Ticker(f"{base}USD=X").fast_info.last_price)
        except Exception:
            rate = None
        if rate:
            disk_set(f"fx:{base}", rate, ttl=43200)
    if rate:
        _FX_CACHE[base] = rate
    return (rate or _FX_FALLBACK.get(base, 1.0)), div


def _resolve_universe(u) -> "tuple[set, str | None]":
    """Map a universe key to (allowed ticker set, optional sector lens). Index
    ETFs reuse the tracked index's bundled set; Sector SPDRs are the S&P 500
    members in that GICS sector. Unknown/empty -> the full bundled universe."""
    if not u:
        return _UNIVERSE, None
    key = str(u).lower()
    if key in _INDEX_SETS:
        return _INDEX_SETS[key], None
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
    # Warm the base-data snapshot first (one call fills every screen's base columns
    # + the 7d sticky fallback). The 6h fresh window is below the backfill cadence,
    # so this naturally refetches.
    _fmp_snapshot("", "")
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
    # Build the full international snapshot (sector + fundamentals via yfinance
    # .info) once per productive cycle — slow, so it runs here in the background.
    try:
        _intl_snapshot(full=True)
    except Exception as e:
        logger.warning("intl snapshot warm failed: %s", e)
    # Pre-warm price-history metrics (technicals + multi-period price change) for the
    # most-screened names so the first technical screen of the day isn't a cold 1y
    # bulk download. Batched to bound memory; runs in the background loop.
    try:
        warm = [t for t in _BACKFILL_ORDER if disk_get(f"histv2:{t}") is None][:int(os.getenv("SCREENER_HISTORY_WARM", "120"))]
        for i in range(0, len(warm), 40):
            _compute_history_batch(warm[i:i + 40])
    except Exception as e:
        logger.warning("history warm failed: %s", e)
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
    region:     str | None = None   # North America | Europe | Asia-Pacific
    sort_by:    str = "marketCap"
    sort_dir:   str = "desc"
    sort_param: str | None = None   # period when sorting by priceChange
    limit:      int | None = Field(default=None, ge=1)
    universe:   str | None = None   # 'sp500' | 'sp400' | 'nasdaq100' | None (all three)

# ── Field definitions visible to the frontend ─────────────────────────────────

SCREENER_FIELDS = [
    # Price & Market
    {"id": "price",          "label": "Price ($)",           "group": "Price & Market"},
    {"id": "marketCap",      "label": "Market Cap ($B)",      "group": "Price & Market"},
    {"id": "volume",         "label": "Volume (sh)",          "group": "Price & Market"},
    {"id": "avgVolume",      "label": "Avg Volume (sh)",      "group": "Price & Market"},
    {"id": "beta",           "label": "Beta",                 "group": "Price & Market"},
    {"id": "priceChange",    "label": "Price Change (%)",     "group": "Price & Market", "param": "period"},
    {"id": "change52wHiPct", "label": "% Below 52W High",    "group": "Price & Market"},
    # Valuation
    {"id": "peRatio",        "label": "P/E Ratio",            "group": "Valuation"},
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
    {"id": "quickRatio",     "label": "Quick Ratio",          "group": "Financial Health"},
    {"id": "cashRatio",      "label": "Cash Ratio",           "group": "Financial Health"},
    {"id": "interestCoverage","label": "Interest Coverage",   "group": "Financial Health"},
    {"id": "roic",           "label": "ROIC (%)",             "group": "Financial Health"},
    {"id": "inventoryTurnover",   "label": "Inventory Turnover",   "group": "Efficiency"},
    {"id": "receivablesTurnover", "label": "Receivables Turnover", "group": "Efficiency"},
    {"id": "payablesTurnover",    "label": "Payables Turnover",    "group": "Efficiency"},
    {"id": "cashConversionCycle", "label": "Cash Conversion Cycle (days)", "group": "Efficiency"},
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


def _needs_history(field: str, param: "str | None") -> bool:
    """Whether evaluating this field requires the 1y price-history download. The 1D
    price change is free from the snapshot, so a Price Change 1D filter/sort does
    NOT pay the history cost — only technicals and 1W+ periods do."""
    if field in TECH_FIELDS:
        return True
    if field == "priceChange":
        return (param if param in PRICE_CHANGE_PERIODS else "1D") != "1D"
    return False
# Fields that need a per-ticker yfinance fast_info call (the slow part of a screen).
FASTINFO_FIELDS = {"change52wHiPct", "avgVolume"}

SECTORS = ["Technology","Healthcare","Financial Services","Consumer Cyclical",
           "Industrials","Communication Services","Consumer Defensive",
           "Energy","Utilities","Real Estate","Basic Materials"]

EXCHANGES = ["NASDAQ", "NYSE", "AMEX", "LSE", "XETRA", "TSE"]

@router.get("/fields")
def get_fields():
    return {"fields": SCREENER_FIELDS, "sectors": SECTORS, "exchanges": EXCHANGES,
            "universes": UNIVERSE_OPTIONS, "regions": REGIONS,
            "internationalCoverageNote": INTERNATIONAL_COVERAGE_NOTE,
            "coverage": _COVERAGE_CONTRACT}


@router.get("/sector-medians")
def get_sector_medians():
    """Industry-median benchmarks (WIFR methodology: median + 1% winsorized,
    computed from the same bundled US fundamentals universe the screener
    already loads — see industry_ratios.py). Small payload (11 sectors x
    <=15 fields), fetch once and diff every row/field against it client-side
    rather than round-tripping per cell."""
    return {"sectors": industry_ratios.get_sector_medians(), "fields": list(industry_ratios.MEDIAN_FIELDS)}


class PercentileRequest(BaseModel):
    sector: str
    values: dict[str, float | None]


@router.post("/percentile")
def get_percentiles(req: PercentileRequest):
    """Exact percentile rank (0-100) of each given field value within its
    sector's winsorized distribution. One call for all of a name's ratios —
    for a single-ticker view (Company Profile), not for scoring an entire
    screener results table (use /sector-medians + a client-side delta there)."""
    return {field: industry_ratios.percentile_rank(req.sector, field, value)
            for field, value in req.values.items()}

# ── Row provenance ────────────────────────────────────────────────────────────
# Every base row carries where its price came from and when. The header used to
# stamp results with the browser clock while the rows underneath were a bundled
# July snapshot, and rows of different vintages sat side by side unmarked (GOOG
# on the seed, GOOGL live, six P/E points apart in one table).

def _now_iso() -> str:
    return _dt.datetime.now(_dt.timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def _stamp(rows: list, source: str, as_of: "str | None") -> list:
    for r in rows:
        r["priceSource"] = source
        r["priceAsOf"] = as_of
    return rows


def _overlay_live_prices(rows: list) -> None:
    """Repoint price, market cap and the 1D move at a live batch quote.

    Every price-derived ratio is computed from base price/market cap inside
    _enrich, so this has to land before enrichment or a live price would sit
    beside a July P/E. Market cap is rescaled by the price move rather than
    refetched: the share count has not changed since the snapshot.
    """
    symbols = [r["ticker"] for r in rows if r.get("ticker")]
    if not symbols:
        return
    try:
        import pandas as pd
        from cache import get_download
    except Exception:
        return
    today = _dt.date.today()
    start = (today - _dt.timedelta(days=10)).isoformat()
    end = (today + _dt.timedelta(days=1)).isoformat()
    quotes: dict = {}
    for i in range(0, len(symbols), 50):
        chunk = tuple(symbols[i:i + 50])
        try:
            frame = get_download(chunk, start, end, "1d", cache_ttl=300)
        except Exception as e:
            logger.warning("screener live overlay chunk failed: %s", e)
            continue
        if frame is None or frame.empty:
            continue
        closes = frame.get("Close")
        if closes is None:
            continue
        if isinstance(closes, pd.Series):
            closes = closes.to_frame(name=chunk[0])
        for sym in chunk:
            if sym not in closes:
                continue
            series = closes[sym].dropna()
            if series.empty:
                continue
            last = float(series.iloc[-1])
            if last > 0:
                quotes[sym] = (last, float(series.iloc[-2]) if len(series) > 1 else None)
    if not quotes:
        return
    stamped = _now_iso()
    for r in rows:
        quote = quotes.get(r.get("ticker"))
        if not quote:
            continue
        last, prior = quote
        stale_price = r.get("price")
        if stale_price and stale_price > 0 and r.get("marketCap"):
            r["marketCap"] = round(r["marketCap"] * last / stale_price, 2)
        r["price"] = round(last, 2)
        if prior and prior > 0:
            r["change1d"] = round((last / prior - 1) * 100, 2)
        r["priceSource"] = "live"
        r["priceAsOf"] = stamped


# ── Cached base-data snapshot from the FMP screener ───────────────────────────

def _fmp_snapshot(sector, exchange) -> list:
    """Base data (price, mkt cap, sector, name, beta, volume, 1D) for the top band
    of names, pulled once from the FMP screener and disk-cached for 6h. Keyed by
    sector/exchange only — independent of the numeric filters (those run client
    side) — so every screen reuses one pull instead of spending an FMP call. This
    is what keeps screens fast and off the free-tier daily cap."""
    base = f"{(sector or '').lower()}:{(exchange or '').lower()}"
    fresh_key, sticky_key = f"screener:snap:{base}", f"screener:snap:sticky:{base}"
    fresh = disk_get(fresh_key)
    if fresh is not None:
        return fresh
    if not fmp.available():
        return disk_get(sticky_key) or []
    params: dict = {"limit": 3000}
    if sector:
        params["sector"] = sector
    if exchange:
        params["exchange"] = str(exchange).lower()
    rows = []
    try:
        raw = fmp._get("/stock-screener", params)
        if isinstance(raw, list):
            for r in raw:
                if not r.get("symbol"):
                    continue
                rows.append({
                    "ticker":      r.get("symbol", ""),
                    "companyName": r.get("companyName", ""),
                    "price":       r.get("price"),
                    "marketCap":   round((r.get("marketCap") or 0) / 1e9, 2),
                    "beta":        r.get("beta"),
                    "volume":      r.get("volume"),
                    "sector":      r.get("sector", ""),
                    "industry":    r.get("industry", ""),
                    "exchange":    r.get("exchangeShortName", ""),
                    "country":     r.get("country", ""),
                    "change1d":    r.get("changesPercentage"),
                })
    except Exception as e:
        logger.warning("FMP snapshot error: %s", e)
    if rows:
        _stamp(rows, "fmp", _now_iso())
        disk_set(fresh_key, rows, ttl=21600)     # 6h fresh window
        disk_set(sticky_key, rows, ttl=604800)   # 7d sticky fallback when FMP is throttled
        return rows
    # Refresh failed (rate-limited / empty): serve the last good copy so data
    # never blanks once it has been warmed. It keeps its original as-of and is
    # relabelled so a week-old sticky copy cannot pass for a live pull.
    return [{**r, "priceSource": "fmp-stale"} for r in (disk_get(sticky_key) or [])]


def _intl_snapshot(full: bool = False) -> list:
    """Base data for every bundled international name, FX-normalized to USD, with
    bundled names + per-index country. Disk-cached 6h (+ 7d sticky) so 'All' /
    international screens don't re-fetch ~140 quotes each time.

    full=True (called by the backfill) ALSO pulls yfinance .info per name for
    sector/industry and the fundamentals FMP doesn't cover for intl (P/E, margins,
    ROE, growth, yield). It is slow, so it runs in the background and overwrites the
    cache; screens read the cached result. full=False is the quick fast_info-only
    build used on a cold cache miss."""
    if not _ALL_INTL:
        return []
    if not full:
        fresh = disk_get(_INTL_SNAPSHOT_CACHE)
        if fresh is not None:
            return fresh
    _pct = lambda v: round(v * 100, 1) if isinstance(v, (int, float)) else None

    def _q(tk):
        try:
            t = yf.Ticker(tk)
            fi = t.fast_info
            listing = _INTL_TICKER_METADATA.get(tk, {})
            price = getattr(fi, "last_price", None)
            mc = getattr(fi, "market_cap", None)
            rate, divisor = _fx_to_usd(getattr(fi, "currency", None))
            row = {
                "ticker": tk, "companyName": _INTL_NAMES.get(tk) or tk,
                "price": round(float(price) / divisor * rate, 2) if price else None,
                "marketCap": round(float(mc) / divisor * rate / 1e9, 2) if mc else None,
                "beta": None, "volume": None, "sector": _INTL_SECTOR_OVERRIDES.get(tk, ""), "industry": "",
                "exchange": listing.get("exchange", ""), "country": listing.get("country", ""), "change1d": None,
            }
            if full:
                try:
                    info = t.info
                    row.update({
                        "sector": info.get("sector") or row["sector"], "industry": info.get("industry") or "",
                        "beta": info.get("beta"),
                        "peRatio": info.get("trailingPE"), "pbRatio": info.get("priceToBook"),
                        "psRatio": info.get("priceToSalesTrailing12Months"),
                        "evEbitda": info.get("enterpriseToEbitda"), "pegRatio": info.get("trailingPegRatio"),
                        "grossMargin": _pct(info.get("grossMargins")), "operatingMargin": _pct(info.get("operatingMargins")),
                        "netMargin": _pct(info.get("profitMargins")), "roe": _pct(info.get("returnOnEquity")),
                        "roa": _pct(info.get("returnOnAssets")), "debtEquity": info.get("debtToEquity"),
                        "currentRatio": info.get("currentRatio"),
                        "revenueGrowth": _pct(info.get("revenueGrowth")), "epsGrowth": _pct(info.get("earningsGrowth")),
                        "dividendYield": _pct(info.get("dividendYield")),
                    })
                except Exception:
                    pass
            return row
        except Exception:
            return None

    with concurrent.futures.ThreadPoolExecutor(max_workers=15) as ex:
        rows = [r for r in ex.map(_q, sorted(_ALL_INTL)) if r and r.get("price")]
    if rows:
        _stamp(rows, "yfinance", _now_iso())
        disk_set(_INTL_SNAPSHOT_CACHE, rows, ttl=21600)
        disk_set(f"{_INTL_SNAPSHOT_CACHE}:sticky", rows, ttl=604800)
        return rows
    return [{**r, "priceSource": "yfinance-stale"} for r in (disk_get(f"{_INTL_SNAPSHOT_CACHE}:sticky") or [])]


# ── Detail enrichment per ticker ──────────────────────────────────────────────

def _enrich(ticker: str, base: dict, claim, want_fastinfo: bool = False) -> dict:
    # Separate cache entries for fast-info vs not, so a cheap screen's result isn't
    # served when 52w-high / avg-volume are needed.
    cache_key = ticker + ("+fi" if want_fastinfo else "")
    with _lock:
        if cache_key in _detail_cache:
            return {**base, **_detail_cache[cache_key]}

    detail: dict = {"change1d": base.get("change1d")}
    try:
        price = base.get("price")
        # yfinance is only touched for 52w-high / avg-volume, and only when a screen
        # actually uses them — those per-ticker calls are the slow part of a screen.
        if want_fastinfo:
            try:
                fi = yf.Ticker(ticker).fast_info
                hi52 = getattr(fi, "year_high", None)
                last_price = getattr(fi, "last_price", None)
                prev_close = getattr(fi, "previous_close", None)
                avg_vol = getattr(fi, "three_month_average_volume", None)
                price = price or last_price
                hi_ref = last_price or price
                if hi52 and hi_ref and hi52 > 0:
                    detail["change52wHiPct"] = round((hi_ref / hi52 - 1) * 100, 1)
                if avg_vol:
                    detail["avgVolume"] = int(avg_vol)
                if detail["change1d"] is None and prev_close and last_price and prev_close > 0:
                    detail["change1d"] = round((last_price / prev_close - 1) * 100, 2)
            except Exception:
                pass

        # Deep fundamentals are free when cached (filled by the backfill loop + prior
        # screens). A small per-screen budget allows a little live warming without
        # burning the free-tier daily FMP cap; uncached + no budget stays null and
        # gets warmed by the backfill instead of a slow per-ticker yfinance call.
        fund = fmp.get_fundamentals(ticker, cached_only=True) if fmp.available() else None
        if fund is None and fmp.available() and claim():
            fund = fmp.get_fundamentals(ticker)
        if fund:
            detail["fundamentalsSource"] = "fmp"
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
                cash            = bal.get("cashAndCashEquivalents") or 0
                ev_raw          = mktcap + total_debt - cash
                # Working-capital detail, for the liquidity/efficiency ratios below
                # that plain currentRatio/debtEquity can't answer (WIFR asks for
                # quick/cash ratio, turnover, and cash conversion cycle too).
                cogs            = income.get("costOfRevenue") or 0
                inventory       = bal.get("inventory") or 0
                receivables     = bal.get("netReceivables") or 0
                payables        = bal.get("accountPayables") or 0
                pretax_inc      = income.get("incomeBeforeTax") or 0
                tax_exp         = income.get("incomeTaxExpense") or 0
                eff_tax_rate    = (tax_exp / pretax_inc) if pretax_inc > 0 else 0.21
                invested_cap    = total_debt + equity - cash

                # Map FMP exchangeShortName to standard display name
                fmp_exch = (prof.get("exchangeShortName") or "").upper()
                if fmp_exch and not base.get("exchange"):
                    detail["exchange"] = fmp_exch

                detail.update({
                    "companyName":    prof.get("companyName") or base.get("companyName"),
                    "sector":         prof.get("sector") or base.get("sector"),
                    "industry":       prof.get("industry") or base.get("industry"),
                    "country":        prof.get("country") or base.get("country"),
                    "peRatio":        round(price_val / eps, 1) if eps > 0 and price_val else None,
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
                    "quickRatio":     round((current_assets - inventory) / current_liab, 2) if current_liab > 0 else None,
                    "cashRatio":      round(cash / current_liab, 2) if current_liab > 0 else None,
                    "inventoryTurnover":    round(cogs / inventory, 2) if inventory > 0 and cogs > 0 else None,
                    "receivablesTurnover":  round(rev / receivables, 2) if receivables > 0 and rev > 0 else None,
                    "payablesTurnover":     round(cogs / payables, 2) if payables > 0 and cogs > 0 else None,
                    "roic":           round(op_inc * (1 - eff_tax_rate) / invested_cap * 100, 1) if invested_cap > 0 else None,
                    "interestCoverage": round(op_inc / interest, 1) if interest > 0 else None,
                    "revenueGrowth":  round((rev / rev_prior - 1) * 100, 1) if rev and rev_prior else None,
                    "epsGrowth":      round((eps / eps_prior - 1) * 100, 1) if eps and eps_prior and eps_prior > 0 else None,
                    "dividendYield":  round((prof.get("lastAnnualDividend") or 0) / price_val * 100, 2) if price_val and price_val > 0 else None,
                })
                # PEG = trailing P/E over EPS growth, from the values just computed.
                _pe, _eg = detail.get("peRatio"), detail.get("epsGrowth")
                detail["pegRatio"] = round(_pe / _eg, 2) if _pe and _eg and _eg > 0 else None
                # Cash conversion cycle = days inventory + days receivable - days
                # payable, from the turnover ratios just computed.
                dio = 365 / detail["inventoryTurnover"] if detail.get("inventoryTurnover") else None
                dso = 365 / detail["receivablesTurnover"] if detail.get("receivablesTurnover") else None
                dpo = 365 / detail["payablesTurnover"] if detail.get("payablesTurnover") else None
                detail["cashConversionCycle"] = round(dio + dso - dpo, 1) if None not in (dio, dso, dpo) else None
            except Exception:
                pass

        # SEC-primary ratios (reference.db) fill missing fundamentals first, ahead of
        # the Finnhub seed, so a name shows EDGAR-derived margins/ROE/growth whenever
        # FMP is throttled. Live FMP/base values still take precedence.
        ref = _REF_FUND.get(_norm_tk(ticker)) if _REF_FUND else None
        if ref:
            for k in _REF_FIELDS:
                if detail.get(k) in (None, "") and base.get(k) in (None, "") and ref.get(k) is not None:
                    detail[k] = ref[k]
                    detail.setdefault("fundamentalsSource", "sec")

        # Bundled US fundamentals fallback: fill any basic stat still missing after
        # the FMP path (throttled / not yet cached) so US names never show blank
        # fundamentals or sector. Live FMP/base values always take precedence.
        seed = _US_FUND.get(_norm_tk(ticker)) if _US_FUND else None
        if seed:
            for k in _SEED_FIELDS:
                if detail.get(k) in (None, "") and base.get(k) in (None, "") and seed.get(k) not in (None, ""):
                    detail[k] = seed[k]
                    detail.setdefault("fundamentalsSource", "bundled")

        # Name/sector come from the FMP screener result (base) or the FMP profile
        # above; fall back to the ticker so a row never shows blank.
        if not detail.get("companyName") and not base.get("companyName"):
            detail["companyName"] = ticker

    except Exception as e:
        logger.warning("enrich %s: %s", ticker, e)
        detail = {}

    with _lock:
        _detail_cache[cache_key] = detail

    return {**base, **detail}

# ── Filter application ────────────────────────────────────────────────────────

# Fields served straight from the screener snapshot (no per-ticker fetch). A filter
# on one of these can be applied before enrichment to narrow the candidate set.
BASE_FILTER_FIELDS = {"price", "marketCap", "volume", "beta"}


def _filter_value(row: dict, f: FilterRule):
    """Resolve the value a filter compares against. priceChange is parameterized:
    the free 1D move comes from the snapshot (change1d); longer periods come from
    computed history (chg:<period>)."""
    if f.field == "priceChange":
        p = f.param if f.param in PRICE_CHANGE_PERIODS else "1D"
        return row.get("change1d") if p == "1D" else row.get(f"chg:{p}")
    return row.get(f.field)


def _compare(v: float, f: FilterRule) -> bool:
    op = f.operator
    if op in ("gt",  ">"):  return v > f.value
    if op in ("gte", ">="): return v >= f.value
    if op in ("lt",  "<"):  return v < f.value
    if op in ("lte", "<="): return v <= f.value
    if op == "eq":          return abs(v - f.value) < 0.01
    if op == "between":
        # A one-sided 'between' (no upper bound entered) acts as a lower bound
        # instead of silently passing everything.
        return f.value <= v if f.value2 is None else f.value <= v <= f.value2
    return True


def _passes(row: dict, filters: list[FilterRule]) -> bool:
    for f in filters:
        val = _filter_value(row, f)
        if val is None:
            return False
        try:
            v = float(val)
        except (TypeError, ValueError):
            continue
        if not _compare(v, f):
            return False
    return True


def _is_base_filter(f: FilterRule) -> bool:
    return f.field in BASE_FILTER_FIELDS or (
        f.field == "priceChange" and (f.param if f.param in PRICE_CHANGE_PERIODS else "1D") == "1D")

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
    CACHE_VER = "v21"
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
    is_intl = str(req.universe).lower() in _INTL_KEYS   # routes via yfinance + FX-normalizes
    # Technical indicators and price-change periods need price history, so only
    # compute them when a filter or the sort references one (keeps fundamentals-
    # only screens fast).
    need_history = _needs_history(req.sort_by, req.sort_param) or any(_needs_history(f.field, f.param) for f in req.filters)
    need_fastinfo = req.sort_by in FASTINFO_FIELDS or any(f.field in FASTINFO_FIELDS for f in req.filters)

    fmp_screened = False  # tracks whether FMP already applied sector/exchange filtering
    if fmp.available() and not is_intl:
        snap = _fmp_snapshot(effective_sector, req.exchange)
        if snap:
            fmp_screened = True
            candidates = [{**r, "_fmp_screened": True} for r in snap]

    # Curate to the chosen index universe (S&P 500 / S&P 400 midcap / Nasdaq 100).
    # req.universe picks one index; otherwise all three. Strict: the user asked to
    # screen within an index, so we never fall back to non-index names — an empty
    # result honestly means nothing in that index passed the filters.
    if _UNIVERSE and candidates:
        candidates = [c for c in candidates if _norm_tk(c["ticker"]) in uni_set]

    # Add international names: the picked intl universe, or every intl name when the
    # universe is "All". Base data comes USD-normalized from the cached intl snapshot.
    # Sector/exchange are NOT a reason to skip this — they're applied as post-filters
    # below (same as they are for non-FMP-screened candidates), so a sector-scoped
    # "All" screen must still see international names or it silently excludes them.
    if is_intl:
        intl_want = uni_set
    elif not req.universe:
        intl_want = _ALL_INTL
    else:
        intl_want = set()
    if intl_want:
        candidates += [r for r in _intl_snapshot() if r["ticker"] in intl_want]

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

    us_missing = not is_intl and not fmp_screened
    # Durable US fill: when FMP gave no live US base data, seed the chosen universe
    # straight from the bundled fundamentals snapshot so major US names always appear
    # with real stats (sector, ratios, margins) instead of a blank, near-empty board.
    if us_missing and _US_FUND:
        want = uni_set if req.universe else _UNIVERSE
        have = {_norm_tk(c["ticker"]) for c in candidates}
        seeded = [dict(_US_FUND[t]) for t in want if t in _US_FUND and t not in have]
        # Prefer SEC-primary ratios over the Finnhub seed values on the bulk board.
        for r in seeded:
            ref = _REF_FUND.get(_norm_tk(r["ticker"]))
            if ref:
                r.update(ref)
        if effective_sector:
            fs = effective_sector.lower()
            seeded = [r for r in seeded if (r.get("sector") or "").lower() == fs]
        # These rows are the bundled file wholesale, so they carry its build date
        # rather than the clock, and their fundamentals are marked as the seed's
        # unless _enrich later lands live ones on top.
        _stamp(seeded, "bundled", _US_FUND_BUILT_AT)
        for r in seeded:
            r["fundamentalsSource"] = "bundled"
        candidates += seeded

    # yfinance fill — last resort when neither FMP nor the bundled seed covered the
    # request (e.g. the seed file is missing, or an international-only universe with a
    # cold intl snapshot). Each name is a separate fast_info call, so it stays capped.
    if not candidates or (us_missing and not _US_FUND):
        filter_sector = effective_sector.lower() if effective_sector else None
        # Sector → its liquid members; a specific index → that index (capped, since
        # each name is a separate fast_info call); 'All' → curated megacaps (the
        # alpha-sorted universe would miss most large names in a 60-name slice).
        if filter_sector and filter_sector in SECTOR_TICKERS:
            tickers_to_fetch = SECTOR_TICKERS[filter_sector]
        elif req.universe and uni_set:
            tickers_to_fetch = sorted(uni_set)[:60]
        else:
            tickers_to_fetch = LIQUID_TICKERS

        def _quick(tk):
            try:
                fi = yf.Ticker(tk).fast_info
                price = getattr(fi, "last_price", None)
                mc    = getattr(fi, "market_cap", None)
                prev  = getattr(fi, "previous_close", None)
                # International listings quote price/market cap in local currency;
                # normalize to USD so they compare against US names. The 1D change is
                # a ratio, so it needs no FX conversion.
                rate, divisor = (_fx_to_usd(getattr(fi, "currency", None)) if is_intl else (1.0, 1.0))
                price_usd = float(price) / divisor * rate if price else None
                mc_usd    = float(mc) / divisor * rate if mc else None
                listing = _INTL_TICKER_METADATA.get(tk, {})
                return {"ticker": tk, "companyName": _INTL_NAMES.get(tk) or tk,
                        "price":     round(price_usd, 2) if price_usd else None,
                        "marketCap": round(mc_usd / 1e9, 2) if mc_usd else None,
                        "change1d":  round((float(price) / prev - 1) * 100, 2) if price and prev else None,
                        "beta": None, "volume": None, "sector": "", "industry": "",
                        "exchange": listing.get("exchange", ""),
                        "country": listing.get("country", _INTL_COUNTRY.get(str(req.universe).lower(), "")) if is_intl else "",
                        "priceSource": "yfinance", "priceAsOf": _now_iso()}
            except Exception:
                return None

        have = {c["ticker"] for c in candidates}
        fetch = [t for t in tickers_to_fetch if t not in have]
        with concurrent.futures.ThreadPoolExecutor(max_workers=15) as ex:
            results = list(ex.map(_quick, fetch))
        new_rows = [r for r in results if r and r.get("price")]
        # Pre-fill sector so post-enrichment filter doesn't strip them if yfinance/FMP fails
        if filter_sector and effective_sector:
            for c in new_rows:
                if not c.get("sector"):
                    c["sector"] = effective_sector
        candidates += new_rows

    if not candidates:
        raise HTTPException(503, "No data source available. Configure FMP_API_KEY for best results.")

    # Apply snapshot-served base filters (price, market cap, volume, beta, 1D change)
    # before enrichment so the deep-fetch budget lands on names that already pass the
    # cheap constraints — and a tightly-scoped screen enriches far fewer tickers.
    base_filters = [f for f in req.filters if _is_base_filter(f)]
    if base_filters:
        candidates = [c for c in candidates if _passes(c, base_filters)]

    # Sort by market cap before capping so the largest names (incl. international,
    # which are appended unsorted) survive the cap. Enrichment is cache-backed and
    # cheap now, so a larger cap is fine.
    candidates.sort(key=lambda c: c.get("marketCap") or 0, reverse=True)
    to_enrich = candidates[:250]
    # Live prices land before enrichment so P/E, P/B, P/S, EV/EBITDA and yield
    # are all divided by the same fresh price. A live price can also push a name
    # out of a price or market-cap filter the snapshot let through, so the cheap
    # filters run once more on the fresh numbers.
    _overlay_live_prices(to_enrich)
    if base_filters:
        to_enrich = [c for c in to_enrich if _passes(c, base_filters)]
    _budget = {"n": _LIVE_ENRICH_BUDGET}
    _budget_lock = threading.Lock()
    def _claim() -> bool:
        with _budget_lock:
            if _budget["n"] > 0:
                _budget["n"] -= 1
                return True
            return False
    with concurrent.futures.ThreadPoolExecutor(max_workers=10) as ex:
        enriched = list(ex.map(lambda c: _enrich(c["ticker"], c, _claim, need_fastinfo), to_enrich))

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

    # Region is derived from the company's country; filter on it when requested.
    # Names in the bundled US indexes default to United States so Region still works
    # when FMP (the usual country source) is throttled and country comes back blank.
    for r in enriched:
        country = r.get("country")
        if not country and _norm_tk(r.get("ticker", "")) in _UNIVERSE:
            country = r["country"] = "United States"
        r["region"] = _COUNTRY_REGION.get(country or "")
    if req.region:
        enriched = [r for r in enriched if r.get("region") == req.region]

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

    shown = filtered[:req.limit] if req.limit is not None else filtered
    # The header used to print the browser clock over rows that could be a month
    # old. Report the oldest price on the board instead, plus how the rows split
    # by source, so a mixed or bundled board says so.
    stamps = [r.get("priceAsOf") for r in shown if r.get("priceAsOf")]
    price_sources: dict = {}
    fundamentals_sources: dict = {}
    for r in shown:
        price_sources[r.get("priceSource") or "unknown"] = price_sources.get(r.get("priceSource") or "unknown", 0) + 1
        key = r.get("fundamentalsSource") or "none"
        fundamentals_sources[key] = fundamentals_sources.get(key, 0) + 1
    result = {
        "results": shown, "total": len(filtered), "changePeriod": display_period or "1D",
        "coverage": _coverage_for_scope(req.universe, req.region),
        "priceAsOf": min(stamps) if stamps else None,
        # A per-name diluted share count across 250 rows is not affordable here,
        # so the board stays on the vendor basis and says so. Ranking within the
        # table is consistent; it is comparison against the valuation tabs, which
        # use diluted, that needs the caveat.
        "marketCapBasis": market_cap_lib.BASIS_VENDOR,
        "priceSources": price_sources,
        "fundamentalsSources": fundamentals_sources,
        "bundledAsOf": _US_FUND_BUILT_AT,
    }
    with _lock:
        _screen_cache[cache_key] = result
    disk_set(f"screen:{cache_key}", result, ttl=3600)
    return result
