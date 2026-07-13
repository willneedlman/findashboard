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
    breaking:       Wire / real-time alert feed. Its items get a freshness boost
                    in the cross-source Breaking ranker (breaking() in aggregate).
                    Does NOT change how the composite is scored.
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
    breaking: bool = False


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
    SourceSpec("rss:cnbc-economy", "CNBC Economy", "rss", 1, 1.2,
               "https://search.cnbc.com/rs/search/combinedcms/view.xml?partnerId=wrss01&id=20910258"),
    SourceSpec("rss:cnbc-top", "CNBC Top News", "rss", 1, 1.2,
               "https://search.cnbc.com/rs/search/combinedcms/view.xml?partnerId=wrss01&id=100003114"),
    SourceSpec("rss:bbc-business", "BBC Business", "rss", 1, 1.1,
               "https://feeds.bbci.co.uk/news/business/rss.xml"),
    SourceSpec("rss:guardian-business", "Guardian Business", "rss", 1, 1.0,
               "https://www.theguardian.com/uk/business/rss"),
    SourceSpec("rss:nasdaq", "Nasdaq Markets", "rss", 2, 1.0,
               "https://www.nasdaq.com/feed/rssoutbound?category=Markets"),
    SourceSpec("rss:business-insider", "Business Insider", "rss", 2, 0.9,
               "https://markets.businessinsider.com/rss/news"),
    SourceSpec("rss:seeking-alpha", "Seeking Alpha", "rss", 2, 0.9,
               "https://seekingalpha.com/feed.xml"),
    SourceSpec("rss:motley-fool", "Motley Fool", "rss", 2, 0.8,
               "https://www.fool.com/feeds/index.aspx"),
    SourceSpec("rss:benzinga", "Benzinga", "rss", 2, 0.8,
               "https://www.benzinga.com/feed"),
    SourceSpec("rss:investing-economy", "Investing.com Economy", "rss", 2, 1.0,
               "https://www.investing.com/rss/news_14.rss"),
    # Primary / official — highest authority: a rate decision or enforcement
    # action should move the composite hard. Low volume, high signal.
    SourceSpec("rss:fed-press", "Federal Reserve", "rss", 1, 1.5,
               "https://www.federalreserve.gov/feeds/press_all.xml"),
    SourceSpec("rss:sec-press", "SEC Press", "rss", 1, 1.4,
               "https://www.sec.gov/news/pressreleases.rss"),
    SourceSpec("rss:ecb-press", "ECB Press", "rss", 1, 1.2,
               "https://www.ecb.europa.eu/rss/press.html"),
    # Quality outlets not previously covered (headline-only is fine — we only score titles).
    SourceSpec("rss:economist", "The Economist", "rss", 1, 1.2,
               "https://www.economist.com/finance-and-economics/rss.xml"),
    SourceSpec("rss:ft-home", "Financial Times", "rss", 1, 1.3,
               "https://www.ft.com/rss/home"),
    SourceSpec("rss:axios", "Axios", "rss", 2, 1.0,
               "https://api.axios.com/feed/"),
    # Crypto — feeds the by_asset_class Crypto read.
    SourceSpec("rss:coindesk", "CoinDesk", "rss", 2, 0.9,
               "https://www.coindesk.com/arc/outboundfeeds/rss/"),
    # Broad aggregator — surfaces Reuters/AP/Bloomberg indirectly; when:1d keeps it
    # fresh (Google News search feeds otherwise skew stale). Dedup collapses overlap.
    SourceSpec("rss:google-markets", "Google News Markets", "rss", 2, 1.0,
               "https://news.google.com/rss/search?q=stock+market+OR+Federal+Reserve+OR+%22S%26P+500%22+when:1d&hl=en-US&gl=US&ceid=US:en"),
    # Wire / real-time alert feeds — low-latency breaking flashes. Marked
    # breaking=True so the Breaking ranker floats their freshest items; they score
    # into the composite like any other tier-1/2 source.
    SourceSpec("rss:mw-realtime", "MarketWatch Real-time", "rss", 1, 1.4,
               "https://feeds.marketwatch.com/marketwatch/realtimeheadlines/", breaking=True),
    SourceSpec("rss:mw-bulletins", "MarketWatch Bulletins", "rss", 1, 1.5,
               "https://feeds.marketwatch.com/marketwatch/bulletins/", breaking=True),
    # Fresh 1h market window (not a literal "breaking" keyword match — most wire
    # flashes never contain that word). when:1h keeps it to the newest items;
    # dedup collapses any overlap with google-markets (when:1d).
    SourceSpec("rss:google-breaking", "Google News Breaking", "rss", 2, 1.0,
               "https://news.google.com/rss/search?q=(stock+market+OR+Federal+Reserve+OR+economy+OR+%22S%26P+500%22+OR+earnings+OR+inflation)+when:1h&hl=en-US&gl=US&ceid=US:en",
               breaking=True),
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
    SourceSpec("reddit:stockmarket", "Reddit/StockMarket", "reddit", 3, 0.9,
               "StockMarket", confidence_cap=0.3),
    SourceSpec("reddit:valueinvesting", "Reddit/ValueInvesting", "reddit", 3, 1.1,
               "ValueInvesting", confidence_cap=0.3),
    SourceSpec("reddit:options", "Reddit/Options", "reddit", 3, 0.8,
               "options", confidence_cap=0.3),
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
# A few phrases are decisive enough that a single occurrence is a confident read
# ("debt bubble", "growth engine"). Floor their confidence above CORRECTION_CONF_MAX
# so the deterministic lexicon read is trusted and the LLM overlay leaves it alone.
DECISIVE_CONF_FLOOR: float = 0.60
INTENSIFIER_FACTOR: float = 1.5
NEGATION_WINDOW: int = 3            # tokens around a term scanned for negators

# ── Aggregation constants (aggregate.py) ──────────────────────────────────────
TIER_EXPONENT: float = 1.2
DECAY_HALFLIFE_RATIO: float = 1.0 / 3.0   # half-life = timeframe / 3
CORROBORATION_DISCOUNT: float = 0.5       # weight multiplier for an isolated spike
# Signal-magnitude weighting: a directionless (neutral) headline should barely
# move the composite. Article weight is scaled by SIGNAL_FLOOR + (1-FLOOR)·
# min(1, |direction|/SIGNAL_FULL): a |direction|>=SIGNAL_FULL item gets full weight,
# a neutral (|direction|~0) item keeps only SIGNAL_FLOOR. The floor is deliberately
# non-zero so an all-neutral window still averages to a real (neutral) score rather
# than dividing by zero. Raising the floor makes neutral news matter more.
SIGNAL_FLOOR: float = 0.15
SIGNAL_FULL: float = 0.45
SHINGLE_K: int = 3                        # token shingle size for dedup
SHINGLE_SIMILARITY: float = 0.6           # Jaccard >= this => same cluster
# Paraphrase clustering: headlines that reword the same event (different titles,
# same story) won't pass the shingle test, but share a rare anchor token (e.g. a
# surname) plus enough content. Cluster when they share a rare, non-generic token
# AND >= MIN_SHARED content tokens AND the overlap is >= RATIO of the shorter title.
PARAPHRASE_RARE_DF_FRACTION: float = 0.06  # token is a "rare anchor" if it appears in <= this fraction of the batch
PARAPHRASE_MIN_SHARED: int = 2             # min shared content tokens
PARAPHRASE_RATIO: float = 0.4              # shared / shorter-title-length floor
# Two DISTINCT rare anchors shared (e.g. "opec" + "output") is a strong same-event
# signal on its own — cluster even when the rest is reworded and the ratio is low.
PARAPHRASE_STRONG_ANCHORS: int = 2
HIGH_IMPACT_TIER: int = 4                 # tier >= this counts toward high_impact_score
# ── Breaking headlines ranker (aggregate.breaking) ────────────────────────────
# A cross-source "what's moving right now" strip, ranked separately from the
# per-source stream and the composite. An item qualifies only if it is fresh AND
# carries a real direction (neutral wire filler never breaks). Urgency ranks by
# conviction × confidence × impact × recency, boosted by corroboration and by a
# wire/alert source. None of this feeds the composite score.
BREAKING_MAX_AGE_H: float = 3.0           # only headlines this fresh are eligible
BREAKING_MIN_DIRECTION: float = 0.12      # drop near-neutral items (no real signal)
BREAKING_MIN_CONFIDENCE: float = 0.25     # drop low-conviction reads
BREAKING_LIMIT: int = 8                   # max items in the strip
BREAKING_WIRE_BONUS: float = 1.25         # urgency multiplier for a breaking-flagged source
BREAKING_CORROBORATION_COEF: float = 0.15 # per extra feed carrying the story
# An "isolated spike" worth discounting is a systemic, very strongly directional
# claim carried by a single source — the precise fake-news / manipulation guard.
# Kept narrow so ordinary strong coverage is not broadly suppressed.
SPIKE_TIER: int = 5
SPIKE_DIRECTION: float = 0.6
# Scheduled market recaps and roundup columns carry a direction (indexes "close
# lower", country stocks "higher at close of trade", "Stock Market Today", the
# "Weekly Market Update") but report no breaking event, so they are held out of
# the Breaking strip. View-only: these still count in the composite. Matched
# case-insensitively against the headline in aggregate.breaking().
BREAKING_ROUNDUP_PATTERNS: tuple[str, ...] = (
    r"\bat close of trade\b",
    r"\b(?:market|markets|sector|stocks?)\s+(?:today|update|wrap|recap|roundup)\b",
    r"\broundup\b",
    r"\b(?:clos(?:e|es|ed|ing)|end(?:s|ed)|finish(?:es|ed))\s+(?:\w+\s+)?(?:higher|lower|mixed|flat)\b",
    r"\bstocks?\s+(?:higher|lower|mixed|flat)\s+at\s+close\b",
    r"\bindex\s+(?:up|down)\s+[\d.]",
)

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
# Exception to the volume rule: a single high-impact, strongly directional
# headline (a breaking macro/geopolitical shock) is signal on its own, so it
# qualifies its source even below MIN_SOURCE_HEADLINES — otherwise a lone
# "airstrikes on Iran" flash from one feed is held out of the composite as "thin".
HIGH_IMPACT_QUALIFY_DIRECTION: float = 0.4   # |direction| a T>=HIGH_IMPACT_TIER item needs to qualify alone
DEFAULT_SAMPLE_SIZE: int = 900
PER_SOURCE_SCORE_CAP: int = 18      # top-N in-window items scored per source (payload bound)
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

# ── Corrective overlay (correction.py) ────────────────────────────────────────
# The lexicon stays the primary scorer. Only headlines it is UNSURE about (its
# own confidence at or below the ceiling) are sent to the LLM for a direction +
# magnitude second opinion; a confident LLM answer overrides the lexicon read
# for those items only. Everything else keeps its deterministic score. Set
# SENTIMENT_CORRECTION=0 to disable and fall back to pure-lexicon scoring.
CORRECTION_ENABLED_ENV: str = "SENTIMENT_CORRECTION"
CORRECTION_CONF_MAX: float = 0.55   # only adjudicate items the lexicon scored at/below this
CORRECTION_MIN_CONF: float = 0.50   # LLM must be at least this sure to override the lexicon
MAX_CORRECTION_ITEMS: int = 50      # per-refresh cap (one batched call; only uncached items)
# Below this confidence the lexicon had no real signal, so a directional label is
# noise — neutralize any such item the LLM did not rescue instead of showing a
# confident-looking false direction.
NEUTRALIZE_CONF_MAX: float = 0.12
CORRECTION_MODEL: str = ENRICH_MODEL
CORRECTION_MAX_TOKENS: int = 3000
CORRECTION_TEMPERATURE: float = 0.0
CORRECTION_CACHE_TTL: int = 4 * 3600  # same headline => same correction for 4h

FORMULA_VERSION: str = "sentiment-v2"

# Reasoning tags the enricher may assign (also used for deterministic fallback).
REASONING_TAGS: tuple[str, ...] = (
    "Rate Hike Fear", "Rate Cut Hope", "Earnings Beat", "Earnings Miss",
    "Recession Signal", "Inflation Surge", "Dollar Strength", "Dollar Weakness",
    "Credit Risk", "Liquidity Crunch", "Policy Pivot", "Trade War Risk",
    "Safe Haven Bid", "Risk-On Rally", "Geopolitical Risk", "Supply Shock",
    "Central Bank Action", "Labor Market", "Growth Slowdown", "Neutral Signal",
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
