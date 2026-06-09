"""
Sentiment tracker — RSS, Reddit, Finnhub — scored by Groq.
Dynamic sample collection with engagement-weighted scoring.
"""
import os, sys, re, json, time, math, logging, threading, calendar, hashlib
from datetime import datetime, timezone
from zoneinfo import ZoneInfo
from pathlib import Path
import requests
from fastapi import APIRouter, Query
from dotenv import load_dotenv

sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))
load_dotenv(os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(__file__))), ".env"))

_log = logging.getLogger(__name__)
router = APIRouter()

_GROQ_API_KEY = os.getenv("GROQ_API_KEY", "")
try:
    from groq import Groq as _Groq
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
MIN_SIGNAL_HEADLINES = 15
MIN_SOURCE_HEADLINES = 3
CACHE_TTL_MARKET     = 300
CACHE_TTL_OVERNIGHT  = 900
DEFAULT_SAMPLE_SIZE  = 500
MAX_GROQ_ITEMS       = 40    # 3-4 items/source × 13 sources → ~40 items, well under token budget
GROQ_SCORING_MODEL   = "llama-3.3-70b-versatile"
BASELINE_WINDOW      = 48   # history points used to compute baseline (~4h at 5min intervals)
_HISTORY_FILE        = Path(os.getenv("SENTIMENT_HISTORY_PATH", ".cache/sentiment_history.json"))

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
# When a topic is detected, also tag its downstream asset classes.
# Allows macro/commodity/FX articles to feed Equities sentiment.
_CROSS_IMPACT_RULES: list[tuple[re.Pattern, list[tuple[str, str]]]] = [
    # Central bank / rates → Equities + Fixed Income always impacted
    (re.compile(r'\b(FED|FOMC|POWELL|RATE\s+HIKE|RATE\s+CUT|INTEREST\s+RATE|MONETARY\s+POLICY|CENTRAL\s+BANK|ECB|BOJ|BOE)\b'),
     [("SPX", "Equities"), ("UST10Y", "Fixed Income")]),

    # Inflation / price data → Equities (margin pressure) + Fixed Income (yield moves)
    (re.compile(r'\b(INFLATION|CPI|PCE|DEFLATION|STAGFLATION|PRICE\s+(PRESSURE|SURGE|SPIKE|RISE|FALL)|COST.OF.LIVING)\b'),
     [("SPX", "Equities"), ("UST", "Fixed Income"), ("XAU", "Commodities")]),

    # Recession / growth → Equities + credit
    (re.compile(r'\b(RECESSION|ECONOMIC\s+(SLOWDOWN|CONTRACTION|DOWNTURN|CRISIS)|GDP\s+(MISS|FALL|SHRINK|CONTRACT)|GROWTH\s+SCARE)\b'),
     [("SPX", "Equities"), ("UST10Y", "Fixed Income"), ("XAU", "Commodities")]),

    # Employment → Equities + Macro always linked
    (re.compile(r'\b(JOBS?\s*(REPORT|DATA|MARKET|NUMBER)?|EMPLOYMENT|UNEMPLOYMENT|NONFARM\s+PAYROLLS?|NFP|PAYROLLS?|LABOR\s+MARKET|JOBLESS\s+CLAIMS?|HIRING|LAYOFFS?)\b', re.IGNORECASE),
     [("SPX", "Equities"), ("NFP", "Macro"), ("UST", "Fixed Income")]),

    # Oil / energy prices → Equities (costs/XLE) + inflation
    (re.compile(r'\b(OIL\s+(PRICE|SURGE|DROP|FALL|RISE|SPIKE)|CRUDE\s+(OIL|PRICE)|ENERGY\s+(PRICE|COST|CRISIS)|OPEC)\b'),
     [("XLE", "Equities"), ("SPX", "Equities"), ("CPI", "Macro")]),

    # Tariffs / trade war → Equities always hit
    (re.compile(r'\bTARIFFS?\b|\bTRADE\s+(WAR|DISPUTE|TENSION|DEAL|POLICY)\b|\bIMPORT\s+(TAX|DUTY)\b|\bSANCTIONS?\b'),
     [("SPX", "Equities"), ("Trade", "Macro"), ("DXY", "FX")]),

    # Dollar strength/weakness → Equities (multinational earnings) + Commodities
    (re.compile(r'\b(DOLLAR\s+\w*(STRENGTH|WEAKEN|RISE|FALL|SURGE|PLUNGE)\w*|STRONG\s+DOLLAR|WEAK\s+DOLLAR|DXY\s+(UP|DOWN|RISE|FALL))\b', re.IGNORECASE),
     [("SPX", "Equities"), ("WTI", "Commodities"), ("XAU", "Commodities")]),

    # Credit / banking systemic → Equities (XLF) + Fixed Income
    (re.compile(r'\b(CREDIT\s+(CRISIS|CRUNCH|SPREAD|RISK)|BANK\s+(FAILURE|CRISIS|RUN|COLLAPSE)|SYSTEMIC\s+RISK|LIQUIDITY\s+CRUNCH|DEFAULT\s+RISK)\b'),
     [("XLF", "Equities"), ("SPX", "Equities"), ("UST", "Fixed Income")]),

    # Gold / safe-haven bid → Equities (risk-off signal)
    (re.compile(r'\b(GOLD\s+(SURGE|RALLY|RISE|HIT|RECORD)|SAFE.HAVEN|RISK.OFF|FLIGHT\s+TO\s+(SAFETY|QUALITY))\b'),
     [("XAU", "Commodities"), ("SPX", "Equities"), ("UST10Y", "Fixed Income")]),

    # Treasury yields → Equities (valuation discount rate)
    (re.compile(r'\b(TREASURY\s+YIELD|BOND\s+YIELD|10.YEAR\s+YIELD|YIELD\s+(SURGE|SPIKE|RISE|INVERSION|CURVE))\b'),
     [("UST10Y", "Fixed Income"), ("SPX", "Equities")]),

    # Geopolitical / war → Equities + commodities + safe haven
    (re.compile(r'\b(WAR|CONFLICT|GEOPOLIT|MILITARY\s+(STRIKE|ACTION|TENSION)|NUCLEAR\s+THREAT|UKRAINE|MIDDLE\s+EAST\s+WAR)\b'),
     [("SPX", "Equities"), ("XAU", "Commodities"), ("WTI", "Commodities"), ("UST10Y", "Fixed Income")]),

    # China / EM risk → Equities (global growth, supply chain)
    (re.compile(r'\b(CHINA\s+(ECONOMY|SLOWDOWN|CRISIS|GROWTH|TRADE|MARKET)|YUAN\s+(DEVALUE|WEAKEN|CRASH)|EM\s+CRISIS)\b'),
     [("SPX", "Equities"), ("Trade", "Macro"), ("USD/CNY", "FX")]),

    # Tech / AI / semiconductors → Equities specifically QQQ/XLK
    (re.compile(r'\bSEMICONDUCTORS?\b|\bCHIP\s+(SHORTAGE|BAN|EXPORT|WAR)\b|\bAI\s+(BUBBLE|CRASH|REGULATION|BAN)\b|\bBIG\s+TECH\s+(SELL|ROUT|ANTITRUST|REGULATION)\b'),
     [("QQQ", "Equities"), ("XLK", "Equities"), ("NVDA", "Equities")]),

    # Earnings season / corporate results → Equities
    (re.compile(r'\b(EARNINGS\s+(SEASON|MISS|BEAT|DISAPPOINT|GUIDANCE|OUTLOOK)|CORPORATE\s+(PROFIT|RESULT|REVENUE|EARNINGS))\b'),
     [("SPX", "Equities")]),
]

def _extract_entities(text: str) -> list[dict]:
    upper = text.upper()
    found: dict[str, str] = {}

    # Direct token matches
    for token, (name, asset_class) in _ENTITY_MAP.items():
        if re.search(r'\b' + re.escape(token) + r'\b', upper):
            found[name] = asset_class

    # Cross-impact inference — topic detected → also tag downstream asset classes
    for pattern, implied in _CROSS_IMPACT_RULES:
        if pattern.search(upper):
            for name, asset_class in implied:
                if name not in found:
                    found[name] = asset_class

    return [{"name": k, "asset_class": v} for k, v in found.items()]

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
    {"url": "https://feeds.a.dj.com/rss/RSSMarketsMain.xml",             "label": "WSJ Markets",   "weight": 1.5},
    {"url": "https://rss.nytimes.com/services/xml/rss/nyt/Business.xml", "label": "NYT Business",  "weight": 1.2},
    {"url": "https://rss.nytimes.com/services/xml/rss/nyt/Economy.xml",  "label": "NYT Economy",   "weight": 1.2},
    {"url": "https://seekingalpha.com/market_currents.xml",              "label": "Seeking Alpha", "weight": 1.0},
    {"url": "https://www.investing.com/rss/news_25.rss",                 "label": "Investing.com", "weight": 1.0},
    {"url": "https://moxie.foxbusiness.com/google-publisher/markets.xml","label": "Fox Business",  "weight": 0.8},
    {"url": "https://feeds.a.dj.com/rss/RSSWSJD.xml",                   "label": "WSJ Tech/Econ", "weight": 0.9},
]

_REDDIT_SUBREDDITS = [
    {"name": "wallstreetbets",   "label": "Reddit/WSB",       "weight": 0.9},
    {"name": "investing",        "label": "Reddit/Investing",  "weight": 1.2},
    {"name": "stocks",           "label": "Reddit/Stocks",     "weight": 1.1},
    {"name": "finance",          "label": "Reddit/Finance",    "weight": 1.2},
    {"name": "economics",        "label": "Reddit/Economics",  "weight": 1.3},
    {"name": "SecurityAnalysis", "label": "Reddit/Security",   "weight": 1.4},
]

_FINNHUB_SOURCE = {"label": "Finnhub News", "weight": 1.1}

_RSS_HEADERS    = {"User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"}
_REDDIT_HEADERS = {"User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"}

# ── State ─────────────────────────────────────────────────────────────────────
_snapshot_data:    dict | None = None
_snapshot_expires: float       = 0.0
_history: list[dict] = []
_lock    = threading.Lock()

def _load_history() -> list[dict]:
    try:
        if _HISTORY_FILE.exists():
            data = json.loads(_HISTORY_FILE.read_text())
            if isinstance(data, list):
                return data[-500:]  # cap at 500 points
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
    """Rolling baseline from the PREVIOUS window of points (excludes the most recent)."""
    if len(history) < 4:
        return None
    window = history[:-1][-BASELINE_WINDOW:]  # exclude current, take last N
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

# ── RSS fetcher ───────────────────────────────────────────────────────────────
import certifi

_CA_BUNDLE = certifi.where()

def _fetch_rss(src: dict, limit: int = 20) -> list[dict]:
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
                "title":            title,
                "published_at":     pub_at,
                "url":              e.get("link", ""),
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
    """Fetch via subreddit RSS feed — works without auth or API key."""
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
            # Reddit RSS wraps post text in title for self-posts; strip trailing " : " cruft
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
    """PRAW OAuth path — richer engagement data when credentials are configured."""
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
                "title":            headline,
                "published_at":     int(item.get("datetime", time.time())),
                "url":              item.get("url", ""),
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
) -> dict[str, list[dict]]:
    """One Groq call for all sources combined. Falls back to neutral on failure."""

    def _base(h: dict) -> dict:
        return {**h, "score": 50, "sentiment": "neutral", "direction": 0.0,
                "macro_tier": 1, "confidence": 0.5, "reasoning_tag": "Neutral Signal",
                "entities": _extract_entities(h["title"])}

    all_items: list[tuple[str, dict]] = []
    for src in source_configs:
        lbl = src["label"]
        # Sort by engagement descending so top items get scored
        bucket = sorted(
            raw_data.get(lbl, []),
            key=lambda x: x.get("engagement_weight", 1.0),
            reverse=True,
        )
        for h in bucket[:max_per_source]:
            all_items.append((lbl, h))

    result: dict[str, list[dict]] = {src["label"]: [] for src in source_configs}

    if not _GROQ or not all_items:
        for label, h in all_items:
            result[label].append(_base(h))
        return result

    numbered = "\n".join(
        f"{i+1}. [{lbl}] {h['title']}" for i, (lbl, h) in enumerate(all_items)
    )
    prompt = (
        "You are a senior equity portfolio manager scoring financial news headlines for US EQUITY MARKET sentiment.\n"
        "Return ONLY a JSON array, one object per headline, SAME ORDER as input:\n"
        '[{"score":INT,"sentiment":"bullish"|"bearish"|"neutral","macro_tier":INT,"confidence":FLOAT,"reasoning_tag":"TAG"},...]\n\n'
        "SCORE SCALE — does this headline move stocks UP or DOWN TODAY?\n"
        "  10-24 = strongly bearish  (rate hike, recession confirmed, systemic shock, crash, credit crisis, war)\n"
        "  25-39 = bearish           (inflation surge, Fed hawkishness, earnings miss, mass layoffs, tariff escalation)\n"
        "  40-49 = mildly bearish    (weak data, cautious guidance, minor credit event, modest policy tightening)\n"
        "  50    = ONLY for genuinely ambiguous headlines with zero directional signal\n"
        "  51-60 = mildly bullish    (in-line earnings, steady jobs, soft landing signals, M&A)\n"
        "  61-75 = bullish           (earnings beat, Fed pause, job growth, buyback, debt ceiling resolved)\n"
        "  76-90 = strongly bullish  (Fed pivot, rate cut, massive earnings beat, stimulus, historic rally)\n\n"
        "ANTI-CLUSTERING RULES (these violations will invalidate your output):\n"
        "  ❌ DO NOT return score=50 for more than 20% of headlines\n"
        "  ❌ DO NOT return all items with the same score\n"
        "  ❌ Headlines about market drops, Fed hikes, tariffs, layoffs MUST score below 45\n"
        "  ❌ Headlines about earnings beats, rate cuts, rallies MUST score above 55\n"
        "  ✅ Distribution should span the full 10-90 range across a typical news cycle\n\n"
        "CALIBRATION (commit to directional scores like these):\n"
        '  "Fed signals more rate hikes amid persistent inflation" → 19 bearish tier:5\n'
        '  "S&P 500 drops 2% as recession fears mount" → 16 bearish tier:4\n'
        '  "Markets slide on tariff escalation fears" → 23 bearish tier:4\n'
        '  "Nvidia crushes earnings, raises guidance 40%" → 84 bullish tier:3\n'
        '  "Fed holds rates steady, signals potential cuts" → 76 bullish tier:5\n'
        '  "CEO steps down amid accounting investigation" → 27 bearish tier:3\n'
        '  "Company announces new product line" → 52 neutral tier:1\n'
        '  "Goldman raises S&P 500 year-end target to 6500" → 68 bullish tier:4\n'
        '  "WSB: NVDA to the moon!! 🚀" → 55 mildly bullish tier:1 conf:0.2\n'
        '  "recession is coming guys" → 33 bearish tier:1 conf:0.3\n\n'
        "MACRO_TIER: 1=micro/retail chatter, 2=sector, 3=large-cap event, 4=market-wide, 5=central bank/systemic\n"
        "CONFIDENCE: 0.1=vague/meme, 0.5=moderate signal, 0.9=crystal-clear directional impact\n"
        f"REASONING_TAG: pick ONE of: {_TAGS_PIPE}\n\n"
        "Reddit posts (labeled [Reddit/...]) are informal — score by implied market sentiment, apply low confidence.\n"
        f"Return EXACTLY {len(all_items)} objects in order. No markdown, no extra text, just the JSON array.\n\n"
        f"Headlines to score:\n{numbered}"
    )

    scores: list[dict] = []
    try:
        resp = _Groq(api_key=_GROQ_API_KEY).chat.completions.create(
            model=GROQ_SCORING_MODEL,
            messages=[{"role": "user", "content": prompt}],
            temperature=0.15,
            max_tokens=5000,
        )
        raw    = resp.choices[0].message.content or ""
        finish = resp.choices[0].finish_reason
        _log.info("Groq response len=%d finish=%s items_sent=%d", len(raw), finish, len(all_items))
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
            _log.warning("Groq truncated — recovered %d/%d items", len(scores), len(all_items))
    except Exception as ex:
        _log.error("Groq batch scoring failed: %s", ex)

    for i, (label, h) in enumerate(all_items):
        if i < len(scores):
            s   = scores[i]
            tag = s.get("reasoning_tag", "Neutral Signal")
            if tag not in _REASONING_TAGS:
                tag = "Neutral Signal"
            score_val = max(0, min(100, int(s.get("score", 50))))
            result[label].append({
                **h,
                "score":         score_val,
                "sentiment":     str(s.get("sentiment", "neutral")),
                "direction":     round((score_val - 50) / 50.0, 3),
                "macro_tier":    max(1, min(5, int(s.get("macro_tier", 1)))),
                "confidence":    max(0.0, min(1.0, float(s.get("confidence", 0.5)))),
                "reasoning_tag": tag,
                "entities":      _extract_entities(h["title"]),
            })
        else:
            result[label].append(_base(h))

    return result

# ── Composite builder ─────────────────────────────────────────────────────────
def _build_sentiment(sample_size: int = DEFAULT_SAMPLE_SIZE) -> dict:
    import concurrent.futures

    all_source_configs: list[dict] = []
    for s in _RSS_SOURCES:
        all_source_configs.append({**s, "source_type": "rss"})
    for s in _REDDIT_SUBREDDITS:
        all_source_configs.append({**s, "source_type": "reddit"})
    if _FINNHUB_API_KEY:
        all_source_configs.append({**_FINNHUB_SOURCE, "source_type": "finnhub"})

    total_sources   = len(all_source_configs)
    per_src_collect = max(10, sample_size // max(1, total_sources))

    # Fetch all sources concurrently
    with concurrent.futures.ThreadPoolExecutor(max_workers=min(total_sources, 20)) as ex:
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

    total_collected = sum(len(v) for v in raw_data.values())

    # Cap items sent to Groq — take top by engagement per source
    max_per_source_scored = max(3, MAX_GROQ_ITEMS // max(1, total_sources))

    scored_by_source = _score_all_sources(raw_data, all_source_configs, max_per_source_scored)
    total_scored     = sum(len(v) for v in scored_by_source.values())

    # Build per-source result objects
    source_results = []
    for src in all_source_configs:
        scored = scored_by_source.get(src["label"], [])
        if not scored:
            continue

        unique_count = len({s["title"] for s in scored})
        qualifies    = unique_count >= MIN_SOURCE_HEADLINES

        # Engagement-weighted averages
        total_eng  = sum(s.get("engagement_weight", 1.0) * s["confidence"] for s in scored) or 1.0
        avg_score  = sum(s["score"]     * s.get("engagement_weight", 1.0) * s["confidence"] for s in scored) / total_eng
        avg_dir    = sum(s["direction"] * s.get("engagement_weight", 1.0) * s["confidence"] for s in scored) / total_eng
        avg_conf   = sum(s["confidence"] for s in scored) / len(scored)
        avg_tier   = sum(s["macro_tier"] for s in scored) / len(scored)

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
            "count":         len(scored),
            "qualifies":     qualifies,
            "asset_groups":  asset_groups,
            "items": [
                {
                    "text":          s["title"],
                    "published_at":  s["published_at"],
                    "url":           s.get("url", ""),
                    "sentiment":     s["sentiment"],
                    "score":         s["score"],
                    "direction":     s["direction"],
                    "macro_tier":    s["macro_tier"],
                    "confidence":    s["confidence"],
                    "reasoning_tag": s["reasoning_tag"],
                    "entities":      s.get("entities", []),
                }
                for s in scored
            ],
        })

    # Composite score: equal-weight floor + editorial multiplier
    qualifying = [s for s in source_results if s["qualifies"]]
    N          = len(qualifying)
    total_unique = sum(s["count"] for s in qualifying)

    if qualifying:
        base_weight = 1.0 / N if N > 0 else 1.0
        eff_weights = [base_weight * s["weight"] for s in qualifying]
        total_eff   = sum(eff_weights)
        composite   = sum(s["avg_score"] * w for s, w in zip(qualifying, eff_weights)) / total_eff
        direction   = sum(s["avg_direction"] * s["avg_tier"] * w for s, w in zip(qualifying, eff_weights)) / total_eff
    else:
        composite = 50.0
        direction = 0.0

    session_conf = min(1.0, total_unique / MIN_SIGNAL_HEADLINES)

    if composite >= 70:   label = "Extreme Greed"
    elif composite >= 60: label = "Greed"
    elif composite >= 55: label = "Mild Bullish"
    elif composite >= 45: label = "Neutral"
    elif composite >= 40: label = "Mild Bearish"
    elif composite >= 30: label = "Fear"
    else:                 label = "Extreme Fear"

    fetched_at   = int(time.time())
    baseline     = _compute_baseline(_history)
    current_score = round(composite, 1)

    result = {
        "composite_score":  current_score,
        "label":            label,
        "direction":        round(direction, 3),
        "session_conf":     round(session_conf, 2),
        "total_headlines":  total_unique,
        "sources":          source_results,
        "fetched_at":       fetched_at,
        "sample_size":      sample_size,
        "total_collected":  total_collected,
        "total_scored":     total_scored,
        "sources_used":     len(source_results),
    }
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

# ── Endpoints ──────────────────────────────────────────────────────────────────
@router.get("/snapshot")
def sentiment_snapshot(
    refresh:     bool = Query(False),
    sample_size: int  = Query(DEFAULT_SAMPLE_SIZE, ge=50, le=2000),
):
    global _snapshot_data, _snapshot_expires
    now = time.time()

    with _lock:
        if not refresh and _snapshot_data and now < _snapshot_expires:
            return _snapshot_data

    data = _build_sentiment(sample_size)

    point = {
        "composite_score": data["composite_score"],
        "label":           data["label"],
        "direction":       data["direction"],
        "session_conf":    data["session_conf"],
        "fetched_at":      data["fetched_at"],
    }

    with _lock:
        _snapshot_data    = data
        _snapshot_expires = time.time() + _current_cache_ttl()
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
