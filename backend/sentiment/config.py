"""Declarative configuration for the sentiment engine.

DATA ONLY — the Source Authority Matrix and every tunable numeric knob. No I/O,
no business logic. Keeping all weights, thresholds and formula constants in one
auditable file means a reviewer can read this module alone and know exactly how
sources are tiered and how the math is parameterised.
"""
from __future__ import annotations

from dataclasses import dataclass

# ── Source Authority Matrix ───────────────────────────────────────────────────


@dataclass(frozen=True)
class SourceSpec:
    """One governed data source.

    key:            Stable id for telemetry / reliability state.
    label:          Display label. MUST match the legacy labels so the
                    ``sources[].label`` field of the API contract is unchanged.
    kind:           Adapter family: ``"rss" | "reddit" | "finnhub"``.
    tier:           Authority tier (1 = financial wire / paper of record,
                    2 = mainstream finance media, 3 = retail social).
    authority:      Base weight multiplier in the composite (the legacy
                    per-source ``weight``).
    target:         RSS URL or subreddit name; empty for finnhub.
    confidence_cap: Upper bound on per-article confidence from this source
                    (retail social is capped low).
    relevance:      Asset-class relevance to broad equities in 0..1. Every
                    current source is broad-market financial, so 1.0.
    whitelisted:    Only whitelisted sources are ingested.
    """

    key: str
    label: str
    kind: str
    tier: int
    authority: float
    target: str = ""
    confidence_cap: float = 1.0
    relevance: float = 1.0
    whitelisted: bool = True


SOURCE_MATRIX: tuple[SourceSpec, ...] = (
    SourceSpec("rss:marketwatch", "MarketWatch", "rss", 1, 1.4,
               "https://feeds.marketwatch.com/marketwatch/topstories/"),
    SourceSpec("rss:cnbc", "CNBC Markets", "rss", 1, 1.3,
               "https://search.cnbc.com/rs/search/combinedcms/view.xml?partnerId=wrss01&id=10000664"),
    SourceSpec("rss:wsj", "WSJ Markets", "rss", 1, 1.3,
               "https://feeds.a.dj.com/rss/RSSMarketsMain.xml"),
    SourceSpec("rss:nyt-business", "NYT Business", "rss", 1, 1.2,
               "https://rss.nytimes.com/services/xml/rss/nyt/Business.xml"),
    SourceSpec("rss:nyt-economy", "NYT Economy", "rss", 1, 1.2,
               "https://rss.nytimes.com/services/xml/rss/nyt/Economy.xml"),
    SourceSpec("rss:yahoo", "Yahoo Finance", "rss", 2, 1.2,
               "https://finance.yahoo.com/rss/topfinstories"),
    SourceSpec("rss:investing", "Investing.com", "rss", 2, 1.0,
               "https://www.investing.com/rss/news_25.rss"),
    SourceSpec("rss:fox-business", "Fox Business", "rss", 2, 0.8,
               "https://moxie.foxbusiness.com/google-publisher/markets.xml"),
    SourceSpec("reddit:investing", "Reddit/Investing", "reddit", 3, 1.2,
               "investing", confidence_cap=0.3),
    SourceSpec("reddit:stocks", "Reddit/Stocks", "reddit", 3, 1.0,
               "stocks", confidence_cap=0.3),
    SourceSpec("reddit:finance", "Reddit/Finance", "reddit", 3, 1.1,
               "finance", confidence_cap=0.3),
    SourceSpec("reddit:economics", "Reddit/Economics", "reddit", 3, 1.2,
               "economics", confidence_cap=0.3),
    SourceSpec("reddit:securityanalysis", "Reddit/Security", "reddit", 3, 1.3,
               "SecurityAnalysis", confidence_cap=0.3),
    SourceSpec("reddit:wsb", "Reddit/WSB", "reddit", 3, 0.7,
               "wallstreetbets", confidence_cap=0.3),
    SourceSpec("finnhub:general", "Finnhub News", "finnhub", 2, 1.1, ""),
)

SOURCE_BY_LABEL: dict[str, SourceSpec] = {s.label: s for s in SOURCE_MATRIX}
SOURCE_BY_KEY: dict[str, SourceSpec] = {s.key: s for s in SOURCE_MATRIX}

# ── Lexicon scoring constants (lexicon.py) ────────────────────────────────────
TANH_GAIN: float = 1.3              # K in score = 50 + 50·tanh(K·R)
CONF_BASE: float = 0.30
CONF_COVERAGE_COEF: float = 0.50
CONF_DISAGREEMENT_COEF: float = 0.30
CONF_COVERAGE_ETA: float = 4.0      # matched terms for full coverage
MIN_CONFIDENCE: float = 0.10
INTENSIFIER_FACTOR: float = 1.5
NEGATION_WINDOW: int = 3            # tokens around a term scanned for negators

# ── Aggregation constants (aggregate.py) ──────────────────────────────────────
TIER_EXPONENT: float = 1.2
DECAY_HALFLIFE_RATIO: float = 1.0 / 3.0   # half-life = timeframe / 3
CORROBORATION_DISCOUNT: float = 0.5       # weight multiplier for an isolated spike
SHINGLE_K: int = 3                        # token shingle size for dedup
SHINGLE_SIMILARITY: float = 0.6           # Jaccard >= this => same cluster
HIGH_IMPACT_TIER: int = 4                 # tier >= this counts toward high_impact_score
# An "isolated spike" worth discounting is a systemic, very strongly directional
# claim carried by a single source — the precise fake-news / manipulation guard.
# Kept narrow so ordinary strong coverage is not broadly suppressed.
SPIKE_TIER: int = 5
SPIKE_DIRECTION: float = 0.6

# ── Relevance / scope ─────────────────────────────────────────────────────────
# A broad-market sentiment gauge only counts articles that touch the market:
# every scored article must carry a recognized financial entity or a broad-market
# keyword, else it is dropped as noise before it can be weighted, counted, or shown.
REQUIRE_MARKET_RELEVANCE: bool = True
# Articles scoped to a single company (no index/macro/rates context) are capped
# below the lowest macro/index impact so an individual stock — even a megacap —
# never out-weights a broader macro or index story of the same tier.
SINGLE_STOCK_IMPACT_CAP: float = 0.45

# ── Window / qualification thresholds ─────────────────────────────────────────
MIN_SIGNAL_HEADLINES: int = 10      # in-window articles for full session confidence
MIN_SOURCE_HEADLINES: int = 2       # unique headlines for a source to "qualify"
DEFAULT_SAMPLE_SIZE: int = 500
PER_SOURCE_SCORE_CAP: int = 12      # top-N in-window items scored per source (payload bound)
BASELINE_WINDOW: int = 48

# ── Caching ───────────────────────────────────────────────────────────────────
CACHE_TTL_MARKET: int = 240         # 4 min, 06:00-20:00 ET
CACHE_TTL_OVERNIGHT: int = 600      # 10 min otherwise
MARKET_CTX_TTL: int = 300
ENRICH_CACHE_TTL: int = 4 * 3600    # same headline => same tag for 4h
MAX_ENRICH_ITEMS: int = 40
HISTORY_LIMIT: int = 500

# ── Reliability (reliability.py) ──────────────────────────────────────────────
RELIABILITY_FLOOR: float = 0.4      # below this => downgrade weight + warn
FETCH_DECAY: float = 0.7            # reliability multiplier per consecutive failure
LATENCY_SOFT_MS: float = 2500.0     # latency where the latency health factor ~0.5
STALENESS_SOFT_H: float = 12.0      # staleness (h) where the factor ~0.5
EWMA_ALPHA: float = 0.3
RELIABILITY_PATH_ENV: str = "SENTIMENT_RELIABILITY_PATH"
RELIABILITY_DEFAULT_PATH: str = ".cache/sentiment_reliability.json"

# ── History (engine.py) ───────────────────────────────────────────────────────
HISTORY_PATH_ENV: str = "SENTIMENT_HISTORY_PATH"
HISTORY_DEFAULT_PATH: str = ".cache/sentiment_history.json"

# ── Enrichment (enrich.py) ────────────────────────────────────────────────────
ENRICH_MODEL: str = "llama-3.3-70b-versatile"
ENRICH_MAX_TOKENS: int = 4500
ENRICH_TEMPERATURE: float = 0.0     # deterministic-as-possible; never feeds the score

FORMULA_VERSION: str = "sentiment-v2"

# Reasoning tags the enricher may assign (also used for deterministic fallback).
REASONING_TAGS: tuple[str, ...] = (
    "Rate Hike Fear", "Rate Cut Hope", "Earnings Beat", "Earnings Miss",
    "Recession Signal", "Inflation Surge", "Dollar Strength", "Dollar Weakness",
    "Credit Risk", "Liquidity Crunch", "Policy Pivot", "Trade War Risk",
    "Safe Haven Bid", "Risk-On Rally", "Geopolitical Risk", "Supply Shock",
    "Central Bank Action", "Labor Market Strength", "Growth Slowdown", "Neutral Signal",
)

# Composite -> label thresholds, highest first (preserved from the legacy engine).
LABEL_THRESHOLDS: tuple[tuple[float, str], ...] = (
    (70.0, "Extreme Greed"),
    (60.0, "Greed"),
    (55.0, "Mild Bullish"),
    (45.0, "Neutral"),
    (40.0, "Mild Bearish"),
    (30.0, "Fear"),
)
LABEL_FLOOR: str = "Extreme Fear"
