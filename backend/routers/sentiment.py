"""
Sentiment tracker — RSS, Reddit, Finnhub — scored by Groq.
Timeframe-aware: articles are filtered to the requested window, time-decay
weighted, and momentum-scored (newest 25% vs older 75%).
"""
import os, sys, re, json, time, math, logging, threading, calendar, hashlib
from datetime import datetime
from zoneinfo import ZoneInfo
from pathlib import Path
import requests
from fastapi import APIRouter, Query
from dotenv import load_dotenv

sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))
load_dotenv(os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(__file__))), ".env"))
from cache import get_history

_log = logging.getLogger(__name__)
router = APIRouter()

_GROQ_API_KEY = os.getenv("GROQ_API_KEY", "")
try:
    import groq  # noqa: F401 — availability probe; client comes from ai_client
    _GROQ = bool(_GROQ_API_KEY)
except ImportError:
    _GROQ = False

_ET = ZoneInfo("America/New_York")

# ── Credentials ───────────────────────────────────────────────────────────────
_REDDIT_CLIENT_ID     = os.getenv("REDDIT_CLIENT_ID", "")
_REDDIT_CLIENT_SECRET = os.getenv("REDDIT_CLIENT_SECRET", "")
_REDDIT_USER_AGENT    = os.getenv("REDDIT_USER_AGENT", "FinanceDashboard/1.0")
_FINNHUB_API_KEY      = os.getenv("FINNHUB_API_KEY", "")

# ── Config ────────────────────────────────────────────────────────────────────
MIN_SIGNAL_HEADLINES  = 10   # min articles in window for full confidence
MIN_SOURCE_HEADLINES  = 2
CACHE_TTL_MARKET      = 240  # 4 min during market hours
CACHE_TTL_OVERNIGHT   = 600  # 10 min overnight
DEFAULT_SAMPLE_SIZE   = 500
MAX_GROQ_ITEMS        = 40
# 70b-versatile, not 8b-instant: the 8b clusters scores near 50 (often collapsing a
# whole batch to neutral) and truncates large batches. 70b scores decisively. Its
# lower free daily token budget is covered by the Groq->Cerebras failover in
# groq_chat (gpt-oss-120b), so a daily-limit 429 degrades to a strong model, not
# to fabricated neutral scores.
GROQ_SCORING_MODEL    = "llama-3.3-70b-versatile"
GROQ_MAX_TOKENS       = 4500   # headroom for 40 structured objects (no truncation)
GROQ_ARTICLE_CACHE_TTL = 4 * 3600  # scored articles cached 4h — same title = same score
BASELINE_WINDOW       = 48

# ── Per-article score cache (avoids re-scoring articles already in window) ────
_article_score_cache: dict[str, tuple[dict, float]] = {}  # sha1[:16] → (fields, expires_at)
_HISTORY_FILE         = Path(os.getenv("SENTIMENT_HISTORY_PATH", ".cache/sentiment_history.json"))

# ── NYSE holidays (2024-2027) ─────────────────────────────────────────────────
_NYSE_HOLIDAYS = {
    "2024-01-01","2024-01-15","2024-02-19","2024-03-29","2024-05-27",
    "2024-06-19","2024-07-04","2024-09-02","2024-11-28","2024-12-25",
    "2025-01-01","2025-01-20","2025-02-17","2025-04-18","2025-05-26",
    "2025-06-19","2025-07-04","2025-09-01","2025-11-27","2025-12-25",
    "2026-01-01","2026-01-19","2026-02-16","2026-04-03","2026-05-25",
    "2026-06-19","2026-07-03","2026-09-07","2026-11-26","2026-12-25",
    "2027-01-01","2027-01-18","2027-02-15","2027-03-26","2027-05-31",
    "2027-06-18","2027-07-05","2027-09-06","2027-11-25","2027-12-24",
}

def _is_market_holiday(dt_et: datetime) -> bool:
    return dt_et.strftime("%Y-%m-%d") in _NYSE_HOLIDAYS

def _article_hash(title: str) -> str:
    return hashlib.sha1(title.encode()).hexdigest()[:16]

def _get_cached_score(title: str) -> dict | None:
    entry = _article_score_cache.get(_article_hash(title))
    if entry and time.time() < entry[1]:
        return entry[0]
    return None

def _set_cached_score(title: str, fields: dict) -> None:
    # Don't cache neutral-default scores — they may be from a degraded/failed run
    if fields.get("score") in (50, 51) and fields.get("reasoning_tag") == "Neutral Signal":
        return
    _article_score_cache[_article_hash(title)] = (fields, time.time() + GROQ_ARTICLE_CACHE_TTL)

# ── Entity lookup ─────────────────────────────────────────────────────────────
_ENTITY_MAP: dict[str, tuple[str, str]] = {
    "SPY": ("SPY", "Equities"), "SPX": ("SPX", "Equities"), "QQQ": ("QQQ", "Equities"),
    "S&P": ("SPX", "Equities"), "S&P 500": ("SPX", "Equities"), "NASDAQ": ("NDX", "Equities"),
    "DOW": ("DJIA", "Equities"), "DJIA": ("DJIA", "Equities"), "RUSSELL": ("RUT", "Equities"),
    "IWM": ("IWM", "Equities"), "VIX": ("VIX", "Equities"), "AAPL": ("AAPL", "Equities"),
    "MSFT": ("MSFT", "Equities"), "NVDA": ("NVDA", "Equities"), "TSLA": ("TSLA", "Equities"),
    "AMZN": ("AMZN", "Equities"), "GOOGL": ("GOOGL", "Equities"), "META": ("META", "Equities"),
    "JPM": ("JPM", "Equities"), "GS": ("GS", "Equities"), "BAC": ("BAC", "Equities"),
    "XLF": ("XLF", "Equities"), "XLE": ("XLE", "Equities"), "XLK": ("XLK", "Equities"),
    "TREASURY": ("UST", "Fixed Income"), "TREASURIES": ("UST", "Fixed Income"),
    "10-YEAR": ("UST10Y", "Fixed Income"), "10Y": ("UST10Y", "Fixed Income"),
    "2-YEAR": ("UST2Y", "Fixed Income"), "2Y": ("UST2Y", "Fixed Income"),
    "30-YEAR": ("UST30Y", "Fixed Income"), "YIELD": ("UST", "Fixed Income"),
    "YIELDS": ("UST", "Fixed Income"), "BONDS": ("UST", "Fixed Income"),
    "TLT": ("TLT", "Fixed Income"), "AGG": ("AGG", "Fixed Income"),
    "DXY": ("DXY", "FX"), "DOLLAR": ("DXY", "FX"), "USD": ("USD", "FX"),
    "EUR": ("EUR/USD", "FX"), "EURO": ("EUR/USD", "FX"),
    "YEN": ("USD/JPY", "FX"), "JPY": ("USD/JPY", "FX"),
    "GBP": ("GBP/USD", "FX"), "POUND": ("GBP/USD", "FX"),
    "CNY": ("USD/CNY", "FX"), "YUAN": ("USD/CNY", "FX"),
    "OIL": ("WTI", "Commodities"), "WTI": ("WTI", "Commodities"),
    "CRUDE": ("WTI", "Commodities"), "BRENT": ("Brent", "Commodities"),
    "GOLD": ("XAU", "Commodities"), "XAU": ("XAU", "Commodities"),
    "SILVER": ("XAG", "Commodities"), "COPPER": ("Copper", "Commodities"),
    "WHEAT": ("Wheat", "Commodities"), "CORN": ("Corn", "Commodities"),
    "GLD": ("XAU", "Commodities"), "USO": ("WTI", "Commodities"),
    "BTC": ("BTC", "Crypto"), "BITCOIN": ("BTC", "Crypto"),
    "ETH": ("ETH", "Crypto"), "ETHEREUM": ("ETH", "Crypto"),
    "CRYPTO": ("Crypto", "Crypto"), "COINBASE": ("COIN", "Crypto"),
    "FED": ("Fed", "Macro"), "FEDERAL RESERVE": ("Fed", "Macro"),
    "FOMC": ("FOMC", "Macro"), "POWELL": ("Fed", "Macro"),
    "ECB": ("ECB", "Macro"), "BOJ": ("BOJ", "Macro"),
    "CPI": ("CPI", "Macro"), "PCE": ("PCE", "Macro"),
    "GDP": ("GDP", "Macro"), "NFP": ("NFP", "Macro"),
    "INFLATION": ("CPI", "Macro"), "UNEMPLOYMENT": ("NFP", "Macro"),
    "TARIFF": ("Trade", "Macro"), "TARIFFS": ("Trade", "Macro"),
    "DEBT": ("UST", "Fixed Income"), "DEFICIT": ("UST", "Fixed Income"),
}

# ── Cross-impact rules ────────────────────────────────────────────────────────
_CROSS_IMPACT_RULES: list[tuple[re.Pattern, list[tuple[str, str]]]] = [
    (re.compile(r'\b(FED|FOMC|POWELL|RATE\s+HIKE|RATE\s+CUT|INTEREST\s+RATE|MONETARY\s+POLICY|CENTRAL\s+BANK|ECB|BOJ|BOE)\b'),
     [("SPX", "Equities"), ("UST10Y", "Fixed Income")]),
    (re.compile(r'\b(INFLATION|CPI|PCE|DEFLATION|STAGFLATION|PRICE\s+(PRESSURE|SURGE|SPIKE|RISE|FALL)|COST.OF.LIVING)\b'),
     [("SPX", "Equities"), ("UST", "Fixed Income"), ("XAU", "Commodities")]),
    (re.compile(r'\b(RECESSION|ECONOMIC\s+(SLOWDOWN|CONTRACTION|DOWNTURN|CRISIS)|GDP\s+(MISS|FALL|SHRINK|CONTRACT)|GROWTH\s+SCARE)\b'),
     [("SPX", "Equities"), ("UST10Y", "Fixed Income"), ("XAU", "Commodities")]),
    (re.compile(r'\b(JOBS?\s*(REPORT|DATA|MARKET|NUMBER)?|EMPLOYMENT|UNEMPLOYMENT|NONFARM\s+PAYROLLS?|NFP|PAYROLLS?|LABOR\s+MARKET|JOBLESS\s+CLAIMS?|HIRING|LAYOFFS?)\b', re.IGNORECASE),
     [("SPX", "Equities"), ("NFP", "Macro"), ("UST", "Fixed Income")]),
    (re.compile(r'\b(OIL\s+(PRICE|SURGE|DROP|FALL|RISE|SPIKE)|CRUDE\s+(OIL|PRICE)|ENERGY\s+(PRICE|COST|CRISIS)|OPEC)\b'),
     [("XLE", "Equities"), ("SPX", "Equities"), ("CPI", "Macro")]),
    (re.compile(r'\bTARIFFS?\b|\bTRADE\s+(WAR|DISPUTE|TENSION|DEAL|POLICY)\b|\bIMPORT\s+(TAX|DUTY)\b|\bSANCTIONS?\b'),
     [("SPX", "Equities"), ("Trade", "Macro"), ("DXY", "FX")]),
    (re.compile(r'\b(DOLLAR\s+\w*(STRENGTH|WEAKEN|RISE|FALL|SURGE|PLUNGE)\w*|STRONG\s+DOLLAR|WEAK\s+DOLLAR|DXY\s+(UP|DOWN|RISE|FALL))\b', re.IGNORECASE),
     [("SPX", "Equities"), ("WTI", "Commodities"), ("XAU", "Commodities")]),
    (re.compile(r'\b(CREDIT\s+(CRISIS|CRUNCH|SPREAD|RISK)|BANK\s+(FAILURE|CRISIS|RUN|COLLAPSE)|SYSTEMIC\s+RISK|LIQUIDITY\s+CRUNCH|DEFAULT\s+RISK)\b'),
     [("XLF", "Equities"), ("SPX", "Equities"), ("UST", "Fixed Income")]),
    (re.compile(r'\b(GOLD\s+(SURGE|RALLY|RISE|HIT|RECORD)|SAFE.HAVEN|RISK.OFF|FLIGHT\s+TO\s+(SAFETY|QUALITY))\b'),
     [("XAU", "Commodities"), ("SPX", "Equities"), ("UST10Y", "Fixed Income")]),
    (re.compile(r'\b(TREASURY\s+YIELD|BOND\s+YIELD|10.YEAR\s+YIELD|YIELD\s+(SURGE|SPIKE|RISE|INVERSION|CURVE))\b'),
     [("UST10Y", "Fixed Income"), ("SPX", "Equities")]),
    (re.compile(r'\b(WAR|CONFLICT|GEOPOLIT|MILITARY\s+(STRIKE|ACTION|TENSION)|NUCLEAR\s+THREAT|UKRAINE|MIDDLE\s+EAST\s+WAR)\b'),
     [("SPX", "Equities"), ("XAU", "Commodities"), ("WTI", "Commodities"), ("UST10Y", "Fixed Income")]),
    (re.compile(r'\b(CHINA\s+(ECONOMY|SLOWDOWN|CRISIS|GROWTH|TRADE|MARKET)|YUAN\s+(DEVALUE|WEAKEN|CRASH)|EM\s+CRISIS)\b'),
     [("SPX", "Equities"), ("Trade", "Macro"), ("USD/CNY", "FX")]),
    (re.compile(r'\bSEMICONDUCTORS?\b|\bCHIP\s+(SHORTAGE|BAN|EXPORT|WAR)\b|\bAI\s+(BUBBLE|CRASH|REGULATION|BAN)\b|\bBIG\s+TECH\s+(SELL|ROUT|ANTITRUST|REGULATION)\b'),
     [("QQQ", "Equities"), ("XLK", "Equities"), ("NVDA", "Equities")]),
    (re.compile(r'\b(EARNINGS\s+(SEASON|MISS|BEAT|DISAPPOINT|GUIDANCE|OUTLOOK)|CORPORATE\s+(PROFIT|RESULT|REVENUE|EARNINGS))\b'),
     [("SPX", "Equities")]),
]

def _extract_entities(text: str) -> list[dict]:
    upper = text.upper()
    found: dict[str, str] = {}
    for token, (name, asset_class) in _ENTITY_MAP.items():
        if re.search(r'\b' + re.escape(token) + r'\b', upper):
            found[name] = asset_class
    for pattern, implied in _CROSS_IMPACT_RULES:
        if pattern.search(upper):
            for name, asset_class in implied:
                if name not in found:
                    found[name] = asset_class
    return [{"name": k, "asset_class": v} for k, v in found.items()]

# ── Market impact weights ─────────────────────────────────────────────────────
# Normalized 0-1: how much a single article about this entity moves the broad S&P 500.
# Macro entities / broad indices = 1.0; mega-caps scaled by approx SPX weight; rest low.
_SPX_ENTITY_IMPACT: dict[str, float] = {
    # Broad market proxies
    "SPX": 1.0,  "SPY": 1.0,  "QQQ": 1.0,  "NDX": 1.0,
    "DJIA": 1.0, "IWM": 0.9,  "RUT": 0.9,
    # Macro entities
    "Fed": 1.0,  "FOMC": 1.0, "CPI": 1.0,  "PCE": 1.0,  "GDP": 1.0,
    "NFP": 1.0,  "Trade": 0.9, "UST": 0.85, "UST10Y": 0.9, "UST2Y": 0.8,
    # Sector ETFs
    "XLF": 0.7, "XLE": 0.7, "XLK": 0.7,
    # Mega-cap equities (scaled by approx SPX weight × 15 factor, capped at 0.9)
    "AAPL": 0.90, "MSFT": 0.85, "NVDA": 0.82, "AMZN": 0.60,
    "META": 0.50, "GOOGL": 0.45, "TSLA": 0.38, "JPM": 0.28,
    "GS": 0.20,  "BAC": 0.18,
    # Commodities (affect inflation/SPX indirectly)
    "WTI": 0.65, "Brent": 0.60, "XAU": 0.45,
    # Crypto (limited SPX correlation)
    "BTC": 0.25, "ETH": 0.18,
    # FX
    "DXY": 0.55, "USD": 0.45, "EUR/USD": 0.35, "USD/JPY": 0.35,
}

# Private / pre-IPO companies → near-zero S&P 500 impact
_PRIVATE_CO_RE = re.compile(
    r'\b(spacex|starlink|stripe|openai|anthropic|databricks|shein|'
    r'bytedance|tiktok\s+parent|instacart\s+private|revolut|klarna\s+private)\b',
    re.IGNORECASE,
)

_BROAD_MARKET_KW = re.compile(
    r'\b(market|stocks|equities|wall\s+street|s&p|dow\s+jones|nasdaq|'
    r'fed\b|fomc|rate\s+(cut|hike)|inflation|recession|gdp|'
    r'treasury|yield|tariff|economy|economic|unemployment|payroll)\b',
    re.IGNORECASE,
)

def _market_impact_weight(title: str, entities: list[dict]) -> float:
    """
    0.0-1.0 weight reflecting this article's relevance to broad S&P 500 direction.
    Down-weights single-stock idiosyncratic news in the composite.
    """
    if _PRIVATE_CO_RE.search(title):
        return 0.05
    if not entities:
        return 0.65 if _BROAD_MARKET_KW.search(title) else 0.15
    return max((_SPX_ENTITY_IMPACT.get(e["name"], 0.15) for e in entities), default=0.15)


# ── Reasoning tags ────────────────────────────────────────────────────────────
_REASONING_TAGS = [
    "Rate Hike Fear", "Rate Cut Hope", "Earnings Beat", "Earnings Miss",
    "Recession Signal", "Inflation Surge", "Dollar Strength", "Dollar Weakness",
    "Credit Risk", "Liquidity Crunch", "Policy Pivot", "Trade War Risk",
    "Safe Haven Bid", "Risk-On Rally", "Geopolitical Risk", "Supply Shock",
    "Central Bank Action", "Labor Market Strength", "Growth Slowdown", "Neutral Signal",
]
_TAGS_PIPE = "|".join(_REASONING_TAGS)
_TAGS_STR  = ", ".join(f'"{t}"' for t in _REASONING_TAGS)

# ── Source configs ────────────────────────────────────────────────────────────
_RSS_SOURCES = [
    {"url": "https://feeds.marketwatch.com/marketwatch/topstories/",                        "label": "MarketWatch",    "weight": 1.4},
    {"url": "https://search.cnbc.com/rs/search/combinedcms/view.xml?partnerId=wrss01&id=10000664", "label": "CNBC Markets",  "weight": 1.3},
    {"url": "https://finance.yahoo.com/rss/topfinstories",                                  "label": "Yahoo Finance",  "weight": 1.2},
    {"url": "https://rss.nytimes.com/services/xml/rss/nyt/Business.xml",                    "label": "NYT Business",   "weight": 1.2},
    {"url": "https://rss.nytimes.com/services/xml/rss/nyt/Economy.xml",                     "label": "NYT Economy",    "weight": 1.2},
    {"url": "https://www.investing.com/rss/news_25.rss",                                    "label": "Investing.com",  "weight": 1.0},
    {"url": "https://moxie.foxbusiness.com/google-publisher/markets.xml",                   "label": "Fox Business",   "weight": 0.8},
    {"url": "https://feeds.a.dj.com/rss/RSSMarketsMain.xml",                               "label": "WSJ Markets",    "weight": 1.3},
]

_REDDIT_SUBREDDITS = [
    {"name": "investing",        "label": "Reddit/Investing",  "weight": 1.2},
    {"name": "stocks",           "label": "Reddit/Stocks",     "weight": 1.0},
    {"name": "finance",          "label": "Reddit/Finance",    "weight": 1.1},
    {"name": "economics",        "label": "Reddit/Economics",  "weight": 1.2},
    {"name": "SecurityAnalysis", "label": "Reddit/Security",   "weight": 1.3},
    {"name": "wallstreetbets",   "label": "Reddit/WSB",        "weight": 0.7},
]

_FINNHUB_SOURCE = {"label": "Finnhub News", "weight": 1.1}

_RSS_HEADERS    = {"User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"}
_REDDIT_HEADERS = {"User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"}

# ── FOMC calendar + Fed-funds futures ─────────────────────────────────────────
# ZQ (30-Day Fed Funds futures) month codes
_ZQ_MONTH = {1:'F',2:'G',3:'H',4:'J',5:'K',6:'M',7:'N',8:'Q',9:'U',10:'V',11:'X',12:'Z'}

# Known FOMC meeting dates through 2027
_FOMC_DATES = [
    "2025-01-29","2025-03-19","2025-05-07","2025-06-18",
    "2025-07-30","2025-09-17","2025-10-29","2025-12-10",
    "2026-01-28","2026-03-18","2026-04-29","2026-06-17",
    "2026-07-29","2026-09-16","2026-10-28","2026-12-09",
    "2027-01-27","2027-03-17","2027-04-28","2027-06-16",
    "2027-07-28","2027-09-15","2027-10-27","2027-12-08",
]

# ── State ─────────────────────────────────────────────────────────────────────
_snapshot_data:    dict[int, dict | None] = {}   # keyed by timeframe_hours
_snapshot_expires: dict[int, float]       = {}
_history: list[dict] = []
_lock    = threading.Lock()

# Market context cache (independent TTL from snapshot cache)
_mkt_ctx_cache:   dict | None = None
_mkt_ctx_expires: float       = 0.0
_mkt_ctx_lock     = threading.Lock()
_MKT_CTX_TTL      = 300  # 5 minutes

def _load_history() -> list[dict]:
    try:
        if _HISTORY_FILE.exists():
            data = json.loads(_HISTORY_FILE.read_text())
            if isinstance(data, list):
                return data[-500:]
    except Exception as ex:
        _log.warning("Could not load history file: %s", ex)
    return []

def _save_history(history: list[dict]) -> None:
    try:
        _HISTORY_FILE.parent.mkdir(parents=True, exist_ok=True)
        _HISTORY_FILE.write_text(json.dumps(history[-500:]))
    except Exception as ex:
        _log.warning("Could not save history file: %s", ex)

def _compute_baseline(history: list[dict]) -> dict | None:
    if len(history) < 4:
        return None
    window = history[:-1][-BASELINE_WINDOW:]
    if len(window) < 3:
        return None
    scores = [p["composite_score"] for p in window]
    mean   = sum(scores) / len(scores)
    std    = (sum((s - mean) ** 2 for s in scores) / len(scores)) ** 0.5
    return {
        "baseline_score": round(mean, 1),
        "baseline_std":   round(std, 1),
        "baseline_n":     len(window),
    }

_history = _load_history()

def _current_cache_ttl() -> int:
    now_et = datetime.now(_ET)
    if 6 <= now_et.hour < 20:
        return CACHE_TTL_MARKET
    return CACHE_TTL_OVERNIGHT

# ── Market context (live data injected into Groq prompt) ──────────────────────
def _fetch_market_context() -> dict:
    """
    Fetch equity levels, VIX, yields, DXY, and Fed-funds futures cut probabilities.
    Cached for 5 min; runs concurrently with news fetching so adds ~0 latency.
    """
    global _mkt_ctx_cache, _mkt_ctx_expires
    now = time.time()
    with _mkt_ctx_lock:
        if _mkt_ctx_cache is not None and now < _mkt_ctx_expires:
            return _mkt_ctx_cache

    ctx: dict = {}
    try:
        from datetime import date

        def _pct(new: float, old: float) -> float:
            return round((new / old - 1) * 100, 2) if old else 0.0

        # ── Equity + macro tickers ────────────────────────────────────────────
        for sym, key in [
            ("^GSPC",   "sp500"),
            ("^IXIC",   "nasdaq"),
            ("^VIX",    "vix"),
            ("^TNX",    "yield_10y"),
            ("^IRX",    "yield_3m"),
            ("DX-Y.NYB","dxy"),
            ("GC=F",    "gold"),
            ("CL=F",    "oil"),
            ("NG=F",    "natgas"),
            ("BTC-USD", "btc"),
        ]:
            try:
                hist = get_history(sym, period="6mo")
                if hist.empty:
                    continue
                c = hist["Close"].dropna()
                if len(c) < 2:
                    continue
                price  = float(c.iloc[-1])
                entry  = {
                    "current": round(price, 2),
                    "chg_1d":  _pct(price, float(c.iloc[-2]))  if len(c) >  1 else 0.0,
                    "chg_5d":  _pct(price, float(c.iloc[-6]))  if len(c) >  5 else 0.0,
                    "chg_1m":  _pct(price, float(c.iloc[-22])) if len(c) > 21 else 0.0,
                }
                if key == "sp500":
                    today_year = date.today().year
                    ytd = c[c.index.year == today_year]
                    if len(ytd) > 0:
                        entry["chg_ytd"] = _pct(price, float(ytd.iloc[0]))
                if key == "vix":
                    entry["regime"]  = (
                        "low"      if price < 15 else
                        "normal"   if price < 20 else
                        "elevated" if price < 30 else
                        "high"
                    )
                    entry["avg_30d"] = round(float(c.tail(22).mean()), 1)
                ctx[key] = entry
            except Exception as _e:
                _log.debug("Market ctx %s: %s", sym, _e)

        # ── Yield curve ───────────────────────────────────────────────────────
        if "yield_10y" in ctx and "yield_3m" in ctx:
            spread = round(ctx["yield_10y"]["current"] - ctx["yield_3m"]["current"], 3)
            ctx["yield_curve"] = {
                "spread_3m10y": spread,
                "shape": "inverted" if spread < -0.1 else "flat" if spread < 0.3 else "normal",
            }

        # ── Fed policy ────────────────────────────────────────────────────────
        # Short-rate proxy: use 3M T-bill; override with FRED DFF if key set
        ffr: float | None = ctx.get("yield_3m", {}).get("current")
        fed: dict = {}
        if ffr is not None:
            fed["effective_rate_proxy"] = round(ffr, 2)
            fed["note"] = "3M T-bill proxy"

        fred_key = os.getenv("FRED_API_KEY", "")
        if fred_key:
            try:
                r = requests.get(
                    "https://api.stlouisfed.org/fred/series/observations",
                    params={"series_id": "DFF", "api_key": fred_key,
                            "file_type": "json", "sort_order": "desc", "limit": 5},
                    timeout=5,
                )
                if r.status_code == 200:
                    for obs in r.json().get("observations", []):
                        val = obs.get("value")
                        if val and val != ".":
                            ffr = float(val)
                            fed = {"effective_rate": round(ffr, 2)}
                            break
            except Exception:
                pass

        # ── Fed-funds futures (ZQ) — implied cut probabilities ────────────────
        today = date.today()
        upcoming = [
            date.fromisoformat(d) for d in _FOMC_DATES
            if date.fromisoformat(d) >= today
        ][:3]

        cut_probs = []
        for mtg in upcoming:
            try:
                zq = f"ZQ{_ZQ_MONTH[mtg.month]}{str(mtg.year)[-2:]}=F"
                zh = get_history(zq, period="5d")
                if zh.empty:
                    continue
                zq_price   = float(zh["Close"].iloc[-1])
                impl_rate  = round(100.0 - zq_price, 4)
                bps_priced = round((ffr - impl_rate) * 100, 1) if ffr is not None else 0.0

                # Probability of ≥1 25bp cut at this meeting
                prob = 0.0
                if ffr is not None and ffr > 0:
                    import calendar as _cal
                    days_total  = _cal.monthrange(mtg.year, mtg.month)[1]
                    days_before = (mtg - date(mtg.year, mtg.month, 1)).days
                    days_after  = days_total - days_before
                    if days_after > 0:
                        new_implied = (
                            impl_rate * days_total - days_before * ffr
                        ) / days_after
                        prob = max(0.0, min(1.0, (ffr - new_implied) / 0.25))

                cut_probs.append({
                    "meeting":      mtg.isoformat(),
                    "ticker":       zq,
                    "implied_rate": impl_rate,
                    "bps_priced":   bps_priced,
                    "prob_cut_25bp": round(prob * 100, 1),
                })
            except Exception as _e:
                _log.debug("ZQ futures %s: %s", mtg, _e)

        if cut_probs:
            fed["cut_probabilities"] = cut_probs

        # Year-end cumulative cuts from December ZQ
        dec_year = today.year if today.month <= 11 else today.year + 1
        try:
            zq_dec = f"ZQ{_ZQ_MONTH[12]}{str(dec_year)[-2:]}=F"
            zh_dec = get_history(zq_dec, period="5d")
            if not zh_dec.empty and ffr is not None:
                dec_impl = 100.0 - float(zh_dec["Close"].iloc[-1])
                cum_bps  = round((ffr - dec_impl) * 100, 0)
                fed["cumulative_bps_eoy"]  = cum_bps
                fed["implied_cuts_eoy"]    = round(cum_bps / 25, 1)
        except Exception:
            pass

        if fed:
            ctx["fed_policy"] = fed

    except Exception as ex:
        _log.warning("_fetch_market_context failed: %s", ex)

    with _mkt_ctx_lock:
        _mkt_ctx_cache   = ctx
        _mkt_ctx_expires = time.time() + _MKT_CTX_TTL

    return ctx


def _format_market_context_for_prompt(ctx: dict) -> str:
    if not ctx:
        return ""

    lines = [
        "═══ CURRENT MARKET CONDITIONS (live — calibrate all scores against this) ═══",
    ]

    sp = ctx.get("sp500")
    if sp:
        ytd = f" | YTD: {sp['chg_ytd']:+.1f}%" if "chg_ytd" in sp else ""
        lines.append(
            f"• S&P 500: {sp['current']:,.0f} | Day: {sp['chg_1d']:+.2f}%"
            f" | 5D: {sp['chg_5d']:+.2f}% | 1M: {sp['chg_1m']:+.2f}%{ytd}"
        )

    vix = ctx.get("vix")
    if vix:
        lines.append(
            f"• VIX: {vix['current']:.1f} ({vix['regime']} vol regime"
            f", 30D avg: {vix['avg_30d']:.1f}) | Day: {vix['chg_1d']:+.2f}%"
        )

    y10 = ctx.get("yield_10y")
    if y10:
        lines.append(
            f"• 10Y Treasury: {y10['current']:.3f}%"
            f" | 5D: {y10['chg_5d']:+.3f}% | 1M: {y10['chg_1m']:+.3f}%"
        )

    yc = ctx.get("yield_curve")
    if yc:
        lines.append(
            f"• Yield Curve (3M–10Y): {yc['spread_3m10y']:+.2f}% → {yc['shape'].upper()} curve"
        )

    nasdaq = ctx.get("nasdaq")
    if nasdaq:
        lines.append(
            f"• Nasdaq: {nasdaq['current']:,.0f} | Day: {nasdaq['chg_1d']:+.2f}%"
            f" | 5D: {nasdaq['chg_5d']:+.2f}% | 1M: {nasdaq['chg_1m']:+.2f}%"
        )

    dxy = ctx.get("dxy")
    if dxy:
        lines.append(
            f"• DXY (Dollar Index): {dxy['current']:.1f}"
            f" | 5D: {dxy['chg_5d']:+.2f}%"
        )

    gold = ctx.get("gold")
    if gold:
        lines.append(
            f"• Gold: ${gold['current']:,.0f}/oz | Day: {gold['chg_1d']:+.2f}%"
            f" | 5D: {gold['chg_5d']:+.2f}% | 1M: {gold['chg_1m']:+.2f}%"
        )

    oil = ctx.get("oil")
    if oil:
        lines.append(
            f"• WTI Oil: ${oil['current']:.1f}/bbl | Day: {oil['chg_1d']:+.2f}%"
            f" | 5D: {oil['chg_5d']:+.2f}% | 1M: {oil['chg_1m']:+.2f}%"
        )

    natgas = ctx.get("natgas")
    if natgas:
        lines.append(
            f"• Natural Gas: ${natgas['current']:.3f}/MMBtu | Day: {natgas['chg_1d']:+.2f}%"
            f" | 5D: {natgas['chg_5d']:+.2f}%"
        )

    btc = ctx.get("btc")
    if btc:
        lines.append(
            f"• Bitcoin: ${btc['current']:,.0f} | Day: {btc['chg_1d']:+.2f}%"
            f" | 5D: {btc['chg_5d']:+.2f}% | 1M: {btc['chg_1m']:+.2f}%"
        )

    fed = ctx.get("fed_policy")
    if fed:
        rate = fed.get("effective_rate") or fed.get("effective_rate_proxy")
        if rate is not None:
            note = " (3M proxy)" if fed.get("note") else ""
            lines.append(f"• Fed Funds Rate: {rate:.2f}%{note}")
        for cp in (fed.get("cut_probabilities") or [])[:2]:
            lines.append(
                f"• {cp['meeting']} FOMC: {cp['prob_cut_25bp']:.0f}% chance 25bp cut"
                f" ({cp['bps_priced']:+.0f}bps priced in)"
            )
        if "implied_cuts_eoy" in fed:
            n   = fed["implied_cuts_eoy"]
            bps = fed.get("cumulative_bps_eoy", 0)
            lines.append(f"• Year-end implied: {n:.1f} cuts ({bps:+.0f}bps total)")

    lines += [
        "CALIBRATION RULES (apply these, do not ignore):",
        "  A Fed HOLD is BEARISH if cuts were expected; neutral if hold was expected.",
        "  Strong jobs = BEARISH when market needs cuts (strong data → Fed stays higher).",
        "  Rate-hike fears in LOW-VIX = more bearish than in HIGH-VIX (fear already priced).",
        "  'Rally' or 'Record high' headlines are less bullish when S&P already extended.",
        "  Yield spikes harm equities; yield drops are bullish for rate-sensitive sectors.",
        "═══════════════════════════════════════════════════════════════════════════════",
    ]
    return "\n".join(lines)


# ── RSS fetcher ───────────────────────────────────────────────────────────────
import certifi
_CA_BUNDLE = certifi.where()

def _fetch_rss(src: dict, limit: int = 30) -> list[dict]:
    try:
        import feedparser
        r = requests.get(src["url"], headers=_RSS_HEADERS, timeout=10, verify=_CA_BUNDLE)
        r.raise_for_status()
        feed  = feedparser.parse(r.text)
        now_  = int(time.time())
        items = []
        seen_hashes: set[str] = set()
        for e in feed.entries[:limit]:
            title = (e.get("title") or "").strip()
            if not title:
                continue
            h = hashlib.md5(title.lower().encode()).hexdigest()
            if h in seen_hashes:
                continue
            seen_hashes.add(h)
            pub_at = now_
            if e.get("published_parsed"):
                try:
                    pub_at = int(calendar.timegm(e.published_parsed))
                except Exception:
                    pass
            items.append({
                "title":             title,
                "published_at":      pub_at,
                "url":               e.get("link", ""),
                "engagement_weight": 1.0,
            })
        if not items:
            _log.warning("RSS 0 entries from %s", src["url"])
        return items
    except Exception as ex:
        _log.error("RSS fetch failed %s: %s", src["url"], ex)
        return []

# ── Reddit fetchers ───────────────────────────────────────────────────────────
def _fetch_reddit_rss(sub_name: str, limit: int) -> list[dict]:
    try:
        import feedparser
        url = f"https://www.reddit.com/r/{sub_name}/hot/.rss?limit={min(limit, 100)}"
        r = requests.get(url, headers=_REDDIT_HEADERS, timeout=12)
        if r.status_code in (429, 403):
            _log.warning("Reddit RSS %s for r/%s — skipping", r.status_code, sub_name)
            return []
        r.raise_for_status()
        feed  = feedparser.parse(r.text)
        now_  = int(time.time())
        items = []
        seen: set[str] = set()
        for e in feed.entries[:limit]:
            title = (e.get("title") or "").strip()
            title = re.sub(r'\s*:\s*$', '', title).strip()
            if not title or title.lower().startswith("posted by"):
                continue
            h = hashlib.md5(title.lower().encode()).hexdigest()
            if h in seen:
                continue
            seen.add(h)
            pub_at = now_
            if e.get("published_parsed"):
                try:
                    pub_at = int(calendar.timegm(e.published_parsed))
                except Exception:
                    pass
            items.append({
                "title":             title,
                "published_at":      pub_at,
                "url":               e.get("link", ""),
                "engagement_weight": 1.0,
            })
        _log.info("Reddit RSS r/%s → %d posts", sub_name, len(items))
        return items
    except Exception as ex:
        _log.error("Reddit RSS fetch r/%s failed: %s", sub_name, ex)
        return []

def _fetch_reddit_praw(sub_name: str, limit: int) -> list[dict]:
    try:
        import praw
        reddit = praw.Reddit(
            client_id=_REDDIT_CLIENT_ID,
            client_secret=_REDDIT_CLIENT_SECRET,
            user_agent=_REDDIT_USER_AGENT,
        )
        items = []
        for post in reddit.subreddit(sub_name).hot(limit=limit):
            title = (post.title or "").strip()
            if not title:
                continue
            eng = math.log1p(max(0, post.score)) * (post.upvote_ratio or 0.5)
            items.append({
                "title":             title,
                "published_at":      int(post.created_utc),
                "url":               f"https://reddit.com{post.permalink}",
                "engagement_weight": round(eng, 3),
            })
        return items
    except Exception as ex:
        _log.warning("PRAW fetch r/%s failed: %s — falling back to RSS", sub_name, ex)
        return []

def _fetch_reddit(sub: dict, limit: int) -> list[dict]:
    name = sub["name"]
    if _REDDIT_CLIENT_ID and _REDDIT_CLIENT_SECRET:
        items = _fetch_reddit_praw(name, limit)
        if items:
            return items
    return _fetch_reddit_rss(name, limit)

# ── Finnhub fetcher ───────────────────────────────────────────────────────────
def _fetch_finnhub(limit: int) -> list[dict]:
    try:
        r = requests.get(
            "https://finnhub.io/api/v1/news",
            params={"category": "general", "token": _FINNHUB_API_KEY},
            timeout=10,
        )
        if r.status_code == 429:
            _log.warning("Finnhub rate limit hit — skipping")
            return []
        r.raise_for_status()
        items = []
        for item in r.json()[:limit]:
            headline = (item.get("headline") or "").strip()
            if not headline:
                continue
            items.append({
                "title":             headline,
                "published_at":      int(item.get("datetime", time.time())),
                "url":               item.get("url", ""),
                "engagement_weight": 1.0,
            })
        return items
    except Exception as ex:
        _log.error("Finnhub fetch failed: %s", ex)
        return []

# ── Groq scoring ──────────────────────────────────────────────────────────────
def _score_all_sources(
    raw_data: dict[str, list[dict]],
    source_configs: list[dict],
    max_per_source: int = 10,
    market_context_str: str = "",
) -> tuple[dict[str, list[dict]], str | None]:
    """One Groq call for all sources combined. Returns (result, error_msg | None)."""

    def _base(h: dict) -> dict:
        ents = _extract_entities(h["title"])
        return {**h, "score": 50, "sentiment": "neutral", "direction": 0.0,
                "macro_tier": 1, "confidence": 0.5, "reasoning_tag": "Neutral Signal",
                "entities": ents, "market_impact_weight": _market_impact_weight(h["title"], ents)}

    all_items: list[tuple[str, dict]] = []
    for src in source_configs:
        lbl = src["label"]
        # Sort by recency × engagement so the freshest, most-engaged items get scored
        bucket = sorted(
            raw_data.get(lbl, []),
            key=lambda x: x.get("recency_weight", 1.0) * x.get("engagement_weight", 1.0),
            reverse=True,
        )
        for h in bucket[:max_per_source]:
            all_items.append((lbl, h))

    result: dict[str, list[dict]] = {src["label"]: [] for src in source_configs}

    if not _GROQ or not all_items:
        reason = "GROQ_API_KEY not configured" if not _GROQ else "no articles collected"
        for label, h in all_items:
            result[label].append(_base(h))
        return result, reason

    # ── Article-level cache: skip items already scored this session ──────────────
    uncached: list[tuple[str, dict]] = []
    cached_by_idx: dict[int, dict] = {}
    for idx, (lbl, h) in enumerate(all_items):
        hit = _get_cached_score(h["title"])
        if hit:
            cached_by_idx[idx] = hit
        else:
            uncached.append((lbl, h))

    cache_hits = len(cached_by_idx)
    if cache_hits:
        _log.info("Article score cache: %d hits, %d to score", cache_hits, len(uncached))

    # Fill results from cache immediately
    for idx, (label, h) in enumerate(all_items):
        if idx in cached_by_idx:
            result[label].append({**h, **cached_by_idx[idx]})

    # Nothing new to score
    if not uncached:
        return result, None

    numbered = "\n".join(
        f"{i+1}. [{lbl}] {h['title']}" for i, (lbl, h) in enumerate(uncached)
    )
    ctx_block = (market_context_str + "\n\n") if market_context_str else ""
    prompt = (
        "You are a senior equity analyst. Score each headline for its BROAD S&P 500 market impact — "
        "not the individual company's stock reaction.\n"
        "Return ONLY a JSON array, one object per headline, SAME ORDER as input:\n"
        '[{"score":INT,"sentiment":"bullish"|"bearish"|"neutral","macro_tier":INT,"confidence":FLOAT,"reasoning_tag":"TAG"},...]\n\n'
        + ctx_block +
        "SCORE = expected S&P 500 move today from this news:\n"
        "  10-30 = strongly bearish  (rate hike, recession, crash, systemic shock)\n"
        "  31-44 = bearish           (hawkish Fed, mass layoffs, tariffs, earnings miss)\n"
        "  45-49 = mildly bearish    (weak data, cautious guidance)\n"
        "  50    = zero directional signal — use only for genuinely ambiguous headlines\n"
        "  51-55 = mildly bullish    (in-line results, steady data)\n"
        "  56-69 = bullish           (earnings beat, rate pause, jobs growth)\n"
        "  70-90 = strongly bullish  (rate cut, blowout earnings, major stimulus)\n\n"
        "CRITICAL RULES:\n"
        "  1. Private companies (SpaceX, Stripe, OpenAI, etc.) have NO S&P 500 impact -> score=50, tier=1, conf=0.1\n"
        "  2. Single-stock IPO news, insider lock-ups, analyst upgrades for non-mega-caps -> score near 50, tier=1-2\n"
        "  3. Only assign tier=4-5 for truly market-wide events (Fed, macro data, broad sell-offs)\n"
        "  4. Do NOT assign 'Rate Hike Fear' to non-Fed headlines\n"
        "  5. Do NOT cluster at 50 for macro/market-wide headlines — those should be clearly directional\n\n"
        "CALIBRATION EXAMPLES:\n"
        '  "Fed signals rate hike" -> 18 bearish tier:5 conf:0.9 tag:Rate Hike Fear\n'
        '  "S&P 500 drops 2% on recession fears" -> 22 bearish tier:4 conf:0.9 tag:Recession Signal\n'
        '  "Oil falls to 8-week low, Iran tensions ease" -> 63 bullish tier:4 conf:0.8 tag:Geopolitical Risk\n'
        '  "Nvidia crushes earnings, raises guidance" -> 81 bullish tier:3 conf:0.9 tag:Earnings Beat\n'
        '  "Markets slip on tariff fears" -> 31 bearish tier:4 conf:0.8 tag:Trade War Risk\n'
        '  "SpaceX cuts retail IPO allocation to 20%" -> 50 neutral tier:1 conf:0.1 tag:Neutral Signal\n'
        '  "Small-cap biotech misses Phase 3 trial" -> 50 neutral tier:1 conf:0.1 tag:Neutral Signal\n'
        '  "Amazon announces new delivery drone program" -> 55 neutral tier:2 conf:0.4 tag:Neutral Signal\n\n'
        "MACRO_TIER: 1=private/micro, 2=sector/single-stock, 3=large-cap index mover, 4=market-wide, 5=central bank/systemic\n"
        "CONFIDENCE: 0.1=vague/private-co, 0.5=moderate, 0.9=crystal-clear market impact\n"
        f"REASONING_TAG: one of: {_TAGS_PIPE}\n"
        "Reddit posts: score by implied broad market sentiment, confidence <= 0.3.\n"
        f"Return EXACTLY {len(uncached)} objects. No markdown, no extra text.\n\n"
        f"Headlines to score:\n{numbered}"
    )

    scores: list[dict] = []
    groq_error: str | None = None
    try:
        from ai_client import groq_chat
        resp = groq_chat(
            [{"role": "user", "content": prompt}],
            model=GROQ_SCORING_MODEL,
            max_tokens=GROQ_MAX_TOKENS,
            temperature=0.15,
        )
        raw    = resp.choices[0].message.content or ""
        finish = resp.choices[0].finish_reason
        _log.info("Groq response len=%d finish=%s items_sent=%d", len(raw), finish, len(uncached))
        clean = re.sub(r'```[a-z]*\n?', '', raw).strip()
        start = clean.find('[')
        if start == -1:
            raise ValueError("no JSON array in response")
        depth, end = 0, -1
        for ci, ch in enumerate(clean[start:], start):
            if ch == '[': depth += 1
            elif ch == ']':
                depth -= 1
                if depth == 0:
                    end = ci
                    break
        if end != -1:
            scores = json.loads(clean[start:end + 1])
        else:
            recovered = re.findall(r'\{[^{}]*"score"\s*:\s*\d+[^{}]*\}', clean[start:])
            if not recovered:
                raise ValueError("no parseable objects in truncated response")
            scores = [json.loads(obj) for obj in recovered if '"score"' in obj]
            _log.warning("Groq truncated — recovered %d/%d items", len(scores), len(uncached))
    except Exception as ex:
        groq_error = str(ex)
        _log.error("Groq batch scoring failed: %s", ex)

    for i, (label, h) in enumerate(uncached):
        if i < len(scores):
            s   = scores[i]
            tag = s.get("reasoning_tag", "Neutral Signal")
            if tag not in _REASONING_TAGS:
                tag = "Neutral Signal"
            score_val = max(0, min(100, int(s.get("score", 50))))
            ents = _extract_entities(h["title"])
            fields = {
                "score":                score_val,
                "sentiment":            str(s.get("sentiment", "neutral")),
                "direction":            round((score_val - 50) / 50.0, 3),
                "macro_tier":           max(1, min(5, int(s.get("macro_tier", 1)))),
                "confidence":           max(0.0, min(1.0, float(s.get("confidence", 0.5)))),
                "reasoning_tag":        tag,
                "entities":             ents,
                "market_impact_weight": _market_impact_weight(h["title"], ents),
            }
            _set_cached_score(h["title"], fields)
            result[label].append({**h, **fields})
        else:
            result[label].append(_base(h))

    # Silent degradation: the Groq call did not raise but produced no usable signal,
    # so every article fell back to neutral 50. Surface it rather than presenting
    # fabricated neutral scores as if they were real.
    if groq_error is None:
        usable = min(len(scores), len(uncached))
        if uncached and usable == 0:
            groq_error = "Groq returned no usable scores"
        elif usable and all(int(x.get("score", 50)) == 50 for x in scores[:usable]):
            groq_error = "Groq returned all-neutral scores; scoring likely failed"

    return result, groq_error

# ── Momentum signal ───────────────────────────────────────────────────────────
def _compute_momentum(all_items: list[dict]) -> dict | None:
    """
    Compare the newest 25% of in-window articles against the older 75%.
    Positive delta = sentiment is improving in this window.
    """
    items = sorted(
        [i for i in all_items if "age_hours" in i],
        key=lambda x: x["age_hours"],  # ascending = newest first
    )
    if len(items) < 4:
        return None

    cutoff = max(1, len(items) // 4)
    recent = items[:cutoff]
    older  = items[cutoff:]

    def _wscore(lst: list[dict]) -> float:
        tw = sum(i["confidence"] for i in lst) or 1.0
        return sum(i["score"] * i["confidence"] for i in lst) / tw

    r_score = _wscore(recent)
    o_score = _wscore(older)
    delta   = r_score - o_score

    if   delta >  8:  label = "Strongly Improving"
    elif delta >  3:  label = "Improving"
    elif delta >  1:  label = "Slightly Improving"
    elif delta < -8:  label = "Strongly Deteriorating"
    elif delta < -3:  label = "Deteriorating"
    elif delta < -1:  label = "Slightly Deteriorating"
    else:             label = "Stable"

    return {
        "delta":      round(delta, 1),
        "label":      label,
        "recent_avg": round(r_score, 1),
        "older_avg":  round(o_score, 1),
        "n_recent":   len(recent),
        "n_older":    len(older),
    }

# ── Composite builder ─────────────────────────────────────────────────────────
def _build_sentiment(sample_size: int = DEFAULT_SAMPLE_SIZE, timeframe_hours: int = 24) -> dict:
    import concurrent.futures

    all_source_configs: list[dict] = []
    for s in _RSS_SOURCES:
        all_source_configs.append({**s, "source_type": "rss"})
    for s in _REDDIT_SUBREDDITS:
        all_source_configs.append({**s, "source_type": "reddit"})
    if _FINNHUB_API_KEY:
        all_source_configs.append({**_FINNHUB_SOURCE, "source_type": "finnhub"})

    total_sources   = len(all_source_configs)
    per_src_collect = max(15, sample_size // max(1, total_sources))

    # Fetch news sources + market context concurrently
    with concurrent.futures.ThreadPoolExecutor(max_workers=min(total_sources + 1, 24)) as ex:
        # Market context runs in parallel with all news fetches (adds ~0 latency when cached)
        mkt_fut = ex.submit(_fetch_market_context)

        futs: dict[str, concurrent.futures.Future] = {}
        for src in all_source_configs:
            if src["source_type"] == "rss":
                futs[src["label"]] = ex.submit(_fetch_rss, src, per_src_collect)
            elif src["source_type"] == "reddit":
                futs[src["label"]] = ex.submit(_fetch_reddit, src, per_src_collect)
            elif src["source_type"] == "finnhub":
                futs[src["label"]] = ex.submit(_fetch_finnhub, per_src_collect)

        raw_data: dict[str, list[dict]] = {}
        for label, fut in futs.items():
            try:
                raw_data[label] = fut.result()
            except Exception as ex:
                _log.error("Source %s failed: %s", label, ex)
                raw_data[label] = []

        try:
            market_ctx = mkt_fut.result(timeout=20)
        except Exception as ex:
            _log.warning("Market context fetch timed out: %s", ex)
            market_ctx = {}

    total_collected = sum(len(v) for v in raw_data.values())

    # ── Timeframe filter + recency annotation ─────────────────────────────────
    now_ts    = int(time.time())
    cutoff_ts = now_ts - timeframe_hours * 3600
    # Decay half-life = 1/3 of the window (so oldest allowed article has weight ~0.05)
    decay_half = max(1.0, timeframe_hours / 3.0)

    in_window_total = 0
    for label in raw_data:
        filtered = []
        for item in raw_data[label]:
            pub = item.get("published_at", now_ts)
            age_h = (now_ts - pub) / 3600.0
            if pub >= cutoff_ts:
                item["age_hours"]      = round(age_h, 2)
                item["recency_weight"] = round(math.exp(-age_h / decay_half), 4)
                filtered.append(item)
        raw_data[label] = filtered
        in_window_total += len(filtered)

    _log.info(
        "Timeframe=%dh — collected=%d  in_window=%d",
        timeframe_hours, total_collected, in_window_total,
    )

    # Score — cap per source by Groq budget
    market_ctx_str       = _format_market_context_for_prompt(market_ctx)
    max_per_source_scored = max(3, MAX_GROQ_ITEMS // max(1, total_sources))
    scored_by_source, groq_error = _score_all_sources(
        raw_data, all_source_configs, max_per_source_scored, market_ctx_str
    )
    total_scored     = sum(len(v) for v in scored_by_source.values())

    # ── Build per-source result objects ───────────────────────────────────────
    source_results = []
    all_scored_flat: list[dict] = []  # for momentum + high-impact calcs

    for src in all_source_configs:
        scored = scored_by_source.get(src["label"], [])
        if not scored:
            continue

        unique_count = len({s["title"] for s in scored})
        qualifies    = unique_count >= MIN_SOURCE_HEADLINES

        # Tier^1.2 × confidence × recency × market_impact weighted averages
        def _src_w(s: dict) -> float:
            return (s.get("macro_tier", 1) ** 1.2) * s["confidence"] * s.get("recency_weight", 1.0) * s.get("market_impact_weight", 0.5)

        total_w   = sum(_src_w(s) for s in scored) or 1.0
        avg_score = sum(s["score"]     * _src_w(s) for s in scored) / total_w
        avg_dir   = sum(s["direction"] * _src_w(s) for s in scored) / total_w
        avg_conf  = sum(s["confidence"] for s in scored) / len(scored)
        avg_tier  = sum(s["macro_tier"] for s in scored) / len(scored)
        avg_age_h = sum(s.get("age_hours", 0) for s in scored) / len(scored)

        asset_groups: dict[str, list] = {}
        for s in scored:
            for ent in s.get("entities", []):
                ac = ent["asset_class"]
                asset_groups.setdefault(ac, []).append(ent["name"])
        asset_groups = {k: list(dict.fromkeys(v)) for k, v in asset_groups.items()}

        source_results.append({
            "label":         src["label"],
            "type":          src["source_type"],
            "weight":        src["weight"],
            "avg_score":     round(avg_score, 1),
            "avg_direction": round(avg_dir, 3),
            "avg_conf":      round(avg_conf, 2),
            "avg_tier":      round(avg_tier, 1),
            "avg_age_h":     round(avg_age_h, 1),
            "count":         len(scored),
            "qualifies":     qualifies,
            "asset_groups":  asset_groups,
            "items": [
                {
                    "text":           s["title"],
                    "published_at":   s["published_at"],
                    "age_hours":      s.get("age_hours", 0),
                    "url":            s.get("url", ""),
                    "sentiment":      s["sentiment"],
                    "score":          s["score"],
                    "direction":      s["direction"],
                    "macro_tier":     s["macro_tier"],
                    "confidence":     s["confidence"],
                    "recency_weight":        s.get("recency_weight", 1.0),
                    "market_impact_weight":  s.get("market_impact_weight", 0.5),
                    "reasoning_tag":         s["reasoning_tag"],
                    "entities":              s.get("entities", []),
                }
                for s in scored
            ],
        })
        all_scored_flat.extend(scored)

    # ── Composite score ───────────────────────────────────────────────────────
    qualifying = [s for s in source_results if s["qualifies"]]
    N          = len(qualifying)

    if N >= 2:
        # Enough multi-article sources for a de-noised, cross-source composite.
        # Source-level weight = editorial_weight / N (equal floor) × source weight multiplier
        base_weight = 1.0 / N if N > 0 else 1.0
        eff_weights = [base_weight * s["weight"] for s in qualifying]
        total_eff   = sum(eff_weights) or 1.0
        composite   = sum(s["avg_score"]     * w for s, w in zip(qualifying, eff_weights)) / total_eff
        direction   = sum(s["avg_direction"] * s["avg_tier"] * w for s, w in zip(qualifying, eff_weights)) / total_eff
    elif all_scored_flat:
        # Thin window: fewer than 2 sources clear the per-source bar, so a
        # source-level composite would silently drop single-article sources and
        # mis-read the tape (e.g. one neutral 3-article source hiding two bullish
        # single-article ones). Fall back to an article-level composite over every
        # scored article, weighted by tier / confidence / recency / market impact.
        def _aw(i: dict) -> float:
            return (i.get("macro_tier", 1) ** 1.2) * i["confidence"] * i.get("recency_weight", 1.0) * i.get("market_impact_weight", 0.5)
        tot_aw    = sum(_aw(i) for i in all_scored_flat) or 1.0
        composite = sum(i["score"]     * _aw(i) for i in all_scored_flat) / tot_aw
        direction = sum(i["direction"] * i.get("macro_tier", 1) * _aw(i) for i in all_scored_flat) / tot_aw
    else:
        composite = 50.0
        direction = 0.0

    # ── Bull / Bear / Neutral breakdown ───────────────────────────────────────
    bull_count    = sum(1 for i in all_scored_flat if i.get("sentiment") == "bullish")
    bear_count    = sum(1 for i in all_scored_flat if i.get("sentiment") == "bearish")
    neutral_count = sum(1 for i in all_scored_flat if i.get("sentiment") == "neutral")
    total_bb      = bull_count + bear_count + neutral_count or 1

    # ── High-impact signal (T4/T5 macro articles only) ────────────────────────
    hi_items = [i for i in all_scored_flat if i.get("macro_tier", 1) >= 4]
    high_impact_score: float | None = None
    if hi_items:
        hi_w   = sum(i["confidence"] * i.get("recency_weight", 1.0) for i in hi_items) or 1.0
        high_impact_score = round(
            sum(i["score"] * i["confidence"] * i.get("recency_weight", 1.0) for i in hi_items) / hi_w, 1
        )

    session_conf  = min(1.0, in_window_total / max(1, MIN_SIGNAL_HEADLINES))
    # When the composite falls back to article level, count every scored article
    total_unique  = sum(s["count"] for s in qualifying) if N >= 2 else len(all_scored_flat)

    if composite >= 70:   lbl = "Extreme Greed"
    elif composite >= 60: lbl = "Greed"
    elif composite >= 55: lbl = "Mild Bullish"
    elif composite >= 45: lbl = "Neutral"
    elif composite >= 40: lbl = "Mild Bearish"
    elif composite >= 30: lbl = "Fear"
    else:                 lbl = "Extreme Fear"

    fetched_at    = int(time.time())
    baseline      = _compute_baseline(_history)
    current_score = round(composite, 1)
    momentum      = _compute_momentum(all_scored_flat)

    result: dict = {
        "composite_score":   current_score,
        "label":             lbl,
        "direction":         round(direction, 3),
        "session_conf":      round(session_conf, 2),
        "total_headlines":   total_unique,
        "in_window_count":   in_window_total,
        "timeframe_hours":   timeframe_hours,
        "sources":           source_results,
        "fetched_at":        fetched_at,
        "sample_size":       sample_size,
        "total_collected":   total_collected,
        "total_scored":      total_scored,
        "sources_used":      len(source_results),
        "bull_count":        bull_count,
        "bear_count":        bear_count,
        "neutral_count":     neutral_count,
        "bull_pct":          round(100 * bull_count / total_bb),
        "bear_pct":          round(100 * bear_count / total_bb),
        "scoring_degraded":  groq_error is not None,
        "groq_error":        groq_error,
    }

    if high_impact_score is not None:
        result["high_impact_score"] = high_impact_score
        result["high_impact_count"] = len(hi_items)

    if momentum:
        result["momentum"] = momentum

    if market_ctx:
        result["market_context"] = market_ctx

    if baseline:
        result["baseline_score"] = baseline["baseline_score"]
        result["baseline_std"]   = baseline["baseline_std"]
        result["baseline_n"]     = baseline["baseline_n"]
        result["baseline_delta"] = round(current_score - baseline["baseline_score"], 1)

    return result

# ── Velocity helper ───────────────────────────────────────────────────────────
def _compute_velocity(history: list[dict]) -> dict | None:
    if len(history) < 2:
        return None
    recent  = history[-3:]
    dt_sec  = recent[-1]["fetched_at"] - recent[0]["fetched_at"]
    ds      = recent[-1]["composite_score"] - recent[0]["composite_score"]
    if dt_sec < 60:
        return None
    velocity_per_hr = ds / (dt_sec / 3600)
    return {
        "delta":        round(ds, 1),
        "velocity_hr":  round(velocity_per_hr, 2),
        "elapsed_min":  round(dt_sec / 60),
        "points_used":  len(recent),
    }

# ── Endpoints ─────────────────────────────────────────────────────────────────
@router.get("/snapshot")
def sentiment_snapshot(
    refresh:         bool = Query(False),
    sample_size:     int  = Query(DEFAULT_SAMPLE_SIZE, ge=50, le=2000),
    timeframe_hours: int  = Query(24, ge=1, le=168),
):
    global _snapshot_data, _snapshot_expires
    now = time.time()

    cached     = _snapshot_data.get(timeframe_hours)
    expires_at = _snapshot_expires.get(timeframe_hours, 0.0)

    with _lock:
        if not refresh and cached and now < expires_at:
            return cached

    data = _build_sentiment(sample_size, timeframe_hours)

    point = {
        "composite_score": data["composite_score"],
        "label":           data["label"],
        "direction":       data["direction"],
        "session_conf":    data["session_conf"],
        "fetched_at":      data["fetched_at"],
    }

    with _lock:
        _snapshot_data[timeframe_hours]    = data
        _snapshot_expires[timeframe_hours] = time.time() + _current_cache_ttl()
        _history.append(point)
        if len(_history) > 500:
            _history.pop(0)
        hist_copy = list(_history)

    _save_history(hist_copy)

    velocity = _compute_velocity(hist_copy)
    if velocity:
        data["velocity"] = velocity

    return data


@router.get("/history")
def sentiment_history():
    with _lock:
        hist = list(_history)
    velocity = _compute_velocity(hist)
    return {"points": hist, "velocity": velocity}
