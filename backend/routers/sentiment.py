"""
Sentiment tracker — financial news RSS feeds, scored by Groq.
Works 24/7. Reddit dropped (requires OAuth); uses verified-working RSS sources.
"""
import os, sys, re, json, time, logging, threading
import requests
from fastapi import APIRouter
from cachetools import TTLCache
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

_cache: TTLCache = TTLCache(maxsize=4, ttl=900)   # 15 min
_lock  = threading.Lock()

# ── Data sources (all verified working without auth) ──────────────────────────

_RSS_SOURCES = [
    {"url": "https://feeds.a.dj.com/rss/RSSMarketsMain.xml",                      "label": "WSJ Markets",    "weight": 1.5},
    {"url": "https://rss.nytimes.com/services/xml/rss/nyt/Business.xml",           "label": "NYT Business",   "weight": 1.2},
    {"url": "https://rss.nytimes.com/services/xml/rss/nyt/Economy.xml",            "label": "NYT Economy",    "weight": 1.2},
    {"url": "https://seekingalpha.com/market_currents.xml",                        "label": "Seeking Alpha",  "weight": 1.0},
    {"url": "https://www.investing.com/rss/news_25.rss",                           "label": "Investing.com",  "weight": 1.0},
    {"url": "https://moxie.foxbusiness.com/google-publisher/markets.xml",          "label": "Fox Business",   "weight": 0.8},
    {"url": "https://feeds.a.dj.com/rss/RSSWSJD.xml",                             "label": "WSJ Tech/Econ",  "weight": 0.9},
]

# ── Fetcher ───────────────────────────────────────────────────────────────────

_RSS_HEADERS = {"User-Agent": "Mozilla/5.0 (compatible; FinanceDashboard/1.0)"}

def _fetch_rss(feed_url: str) -> list[str]:
    try:
        import feedparser
        # Use requests to bypass Python 3.13 SSL cert issues on macOS, then parse text
        r = requests.get(feed_url, headers=_RSS_HEADERS, timeout=10, verify=False)
        r.raise_for_status()
        feed = feedparser.parse(r.text)
        titles = [e.get("title", "").strip() for e in feed.entries[:20] if e.get("title")]
        if not titles:
            _log.warning("RSS 0 entries from %s", feed_url)
        return titles
    except Exception as e:
        _log.error("RSS fetch failed %s: %s", feed_url, e)
        return []

# ── Groq scoring ──────────────────────────────────────────────────────────────

def _score_batch(texts: list[str], source_label: str) -> list[dict]:
    """Score headlines. Returns [{text, sentiment, score}] score 0-100 (50=neutral)."""
    if not _GROQ or not texts:
        return [{"text": t, "sentiment": "neutral", "score": 50} for t in texts]
    try:
        client = _Groq(api_key=_GROQ_API_KEY)
        numbered = "\n".join(f"{i+1}. {t}" for i, t in enumerate(texts[:20]))
        prompt = (
            "Score each headline for US stock market sentiment.\n"
            "Return ONLY a JSON array, one object per line:\n"
            '[{"score": 0-100, "sentiment": "bullish"|"bearish"|"neutral"}, ...]\n'
            "50=neutral, >65=bullish, <35=bearish. Judge broad market impact.\n\n"
            f"Source: {source_label}\n{numbered}"
        )
        resp = client.chat.completions.create(
            model="llama-3.1-8b-instant",
            messages=[{"role": "user", "content": prompt}],
            temperature=0.1,
            max_tokens=600,
        )
        raw = resp.choices[0].message.content or ""
        m = re.search(r'\[.*\]', raw, re.DOTALL)
        if not m:
            raise ValueError("no JSON array in Groq response")
        scores = json.loads(m.group())
        return [
            {
                "text":      texts[i],
                "sentiment": str(scores[i].get("sentiment", "neutral")) if i < len(scores) else "neutral",
                "score":     max(0, min(100, int(scores[i].get("score", 50)))) if i < len(scores) else 50,
            }
            for i in range(len(texts[:20]))
        ]
    except Exception as e:
        _log.error("Groq scoring failed for %s: %s", source_label, e)
        return [{"text": t, "sentiment": "neutral", "score": 50} for t in texts]

# ── Composite builder ─────────────────────────────────────────────────────────

def _build_sentiment() -> dict:
    import concurrent.futures

    with concurrent.futures.ThreadPoolExecutor(max_workers=len(_RSS_SOURCES)) as ex:
        futs = {src["label"]: ex.submit(_fetch_rss, src["url"]) for src in _RSS_SOURCES}
    rss_data = {label: fut.result() for label, fut in futs.items()}

    source_results = []
    for src in _RSS_SOURCES:
        headlines = rss_data.get(src["label"], [])
        if not headlines:
            continue
        scored = _score_batch(headlines, src["label"])
        avg = sum(s["score"] for s in scored) / len(scored) if scored else 50
        source_results.append({
            "label":     src["label"],
            "type":      "news",
            "weight":    src["weight"],
            "avg_score": round(avg, 1),
            "count":     len(scored),
            "items":     [{"text": s["text"], "sentiment": s["sentiment"], "score": s["score"]} for s in scored[:10]],
        })

    if source_results:
        total_w   = sum(s["weight"] for s in source_results)
        composite = sum(s["avg_score"] * s["weight"] for s in source_results) / total_w
    else:
        composite = 50.0

    if composite >= 70:   label = "Extreme Greed"
    elif composite >= 60: label = "Greed"
    elif composite >= 55: label = "Mild Bullish"
    elif composite >= 45: label = "Neutral"
    elif composite >= 40: label = "Mild Bearish"
    elif composite >= 30: label = "Fear"
    else:                 label = "Extreme Fear"

    return {
        "composite_score": round(composite, 1),
        "label":           label,
        "sources":         source_results,
        "fetched_at":      int(time.time()),
    }

# ── Endpoint ──────────────────────────────────────────────────────────────────

@router.get("/snapshot")
def sentiment_snapshot(refresh: bool = False):
    with _lock:
        if not refresh and "snapshot" in _cache:
            return _cache["snapshot"]
    data = _build_sentiment()
    with _lock:
        _cache["snapshot"] = data
    return data
