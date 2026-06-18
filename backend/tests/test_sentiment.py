"""Tests for the deterministic sentiment engine.

Covers the contract the rebuild promised: a reproducible core, a zero-trust
ingestion boundary, dynamic reliability downgrade, isolated-spike discounting,
and a real composite even when the LLM is unavailable.
"""
import os
import sys
import tempfile

# Isolate persisted state before the engine module is imported.
os.environ["SENTIMENT_HISTORY_PATH"] = tempfile.mktemp()
os.environ["SENTIMENT_RELIABILITY_PATH"] = tempfile.mktemp()
os.environ.pop("GROQ_API_KEY", None)
os.environ.pop("FINNHUB_API_KEY", None)
sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))

import pytest

from sentiment import aggregate, source_manager
from sentiment.config import SOURCE_BY_LABEL
from sentiment.lexicon import extract_entities, score_text
from sentiment.reliability import Reliability
from sentiment.schemas import ScoredArticle
from sentiment.sources.base import FetchOutcome, _coerce
from sentiment.sources.base import RawArticle

NOW = 1_700_000_000


def _scored(label, key, title, score, tier, conf=0.8, rec=1.0, mi=1.0):
    d = round((score - 50) / 50, 3)
    return ScoredArticle(
        source_key=key, source_label=label, source_type="rss", title=title, url="",
        published_at=NOW, age_hours=1.0, recency_weight=rec, score=score, direction=d,
        confidence=conf, macro_tier=tier,
        sentiment="bullish" if d > 0.1 else "bearish" if d < -0.1 else "neutral",
        market_impact_weight=mi, reasoning_tag="Neutral Signal",
    )


# ── Deterministic lexicon core ────────────────────────────────────────────────
def test_score_text_is_deterministic():
    text = "S&P 500 drops 2% on recession fears as Fed signals rate hike"
    ent = extract_entities(text)
    scores = {score_text(text, ent).score for _ in range(1000)}
    assert len(scores) == 1


@pytest.mark.parametrize("text,expected", [
    ("Fed signals rate hike", "bearish"),
    ("Fed cuts rates as inflation cools", "bullish"),
    ("Stocks rally to record high on strong jobs report", "bullish"),
    ("Recession fears grip markets", "bearish"),
    ("Company opens new office in Denver", "neutral"),
])
def test_lexicon_directions(text, expected):
    assert score_text(text, extract_entities(text)).sentiment == expected


@pytest.mark.parametrize("text,expected", [
    ("Oil prices fall as tensions ease", "bullish"),     # commodity down -> bullish equities
    ("Treasury yields jump after hot data", "bearish"),  # yields up -> bearish (inversion)
    ("Unemployment rises to 5%", "bearish"),             # bad-up subject rises -> bearish
    ("Jobless claims fall sharply", "bullish"),          # bad-up subject falls -> bullish
    ("Gold surges as investors flee", "bearish"),        # risk-off
    ("Intel's stock jumps 11%", "bullish"),              # single-stock move + apostrophe strip
    ("Nasdaq soars to fresh record", "bullish"),
    ("DeepSeek won't sink AI titans", "bullish"),        # contraction negation flips "sink"
])
def test_movement_layer_and_inversion(text, expected):
    assert score_text(text, extract_entities(text)).sentiment == expected


def test_score_bounds_and_neutral_default():
    # No lexical signal -> exactly neutral with floor confidence.
    s = score_text("A quiet uneventful day downtown", [])
    assert s.score == 50 and s.confidence == 0.10
    # Strong bearish stays inside (0, 100) and well below 50.
    s2 = score_text("Market crash: stocks plunge in historic selloff", [])
    assert 0 < s2.score < 50


# ── Zero-trust ingestion boundary ─────────────────────────────────────────────
def test_boundary_rejects_and_dedups():
    arts, errors = _coerce([
        {"title": "Real headline", "published_at": 1700000000.0},
        {"title": "   ", "published_at": 1700000000},        # empty -> reject
        {"title": "No ts", "published_at": None},            # None -> reject
        {"title": "Real headline", "published_at": 1700000009},  # dup -> drop
        {"title": "Strnum", "published_at": "1700000002"},   # numeric str -> ok
    ])
    assert len(arts) == 2
    assert errors == 2


# ── Reliability ───────────────────────────────────────────────────────────────
def test_reliability_downgrade_and_recovery():
    r = Reliability(path=tempfile.mktemp())
    assert r.score("rss:x") == 1.0
    fail = FetchOutcome("rss:x", "X", [], latency_ms=50, attempted=0, parse_errors=0, ok=False)
    for _ in range(3):
        r.update(fail, now=NOW)
    assert r.score("rss:x") < 0.4  # downgraded after sustained failure
    ok = FetchOutcome("rss:x", "X", [RawArticle(title="hi", published_at=NOW)],
                      latency_ms=200, attempted=1, parse_errors=0, ok=True)
    r.update(ok, now=NOW)
    assert r.score("rss:x") == 1.0  # one success restores it


def test_effective_weight_scales_with_reliability():
    r = Reliability(path=tempfile.mktemp())
    spec = SOURCE_BY_LABEL["MarketWatch"]
    assert source_manager.effective_weight(spec, r) == spec.authority  # fresh => full
    fail = FetchOutcome(spec.key, spec.label, [], 50, 0, 0, ok=False)
    for _ in range(3):
        r.update(fail, now=NOW)
    assert source_manager.effective_weight(spec, r) < spec.authority


# ── Cross-source verification ─────────────────────────────────────────────────
def test_isolated_spike_discounted_but_corroborated_not():
    items = [
        _scored("MarketWatch", "rss:marketwatch", "Fed announces emergency rate hike", 12, 5),
        _scored("WSJ", "rss:wsj", "Stocks tumble on recession fears today", 24, 4),
        _scored("CNBC Markets", "rss:cnbc", "Stocks tumble on recession fears", 24, 4),
    ]
    factor, stats = source_manager.verify(items)
    spike = factor["rss:marketwatch::Fed announces emergency rate hike"]
    corro = factor["rss:wsj::Stocks tumble on recession fears today"]
    assert spike == 0.5          # lone systemic tier-5 strong claim discounted
    assert corro == 1.0          # tier-4 echoed across sources kept
    assert stats.corroborated >= 1


# ── Pure aggregation determinism ──────────────────────────────────────────────
def test_aggregate_is_deterministic():
    sbs = {
        "MarketWatch": [_scored("MarketWatch", "rss:marketwatch", "rate hike fear", 18, 5),
                        _scored("MarketWatch", "rss:marketwatch", "recession risk", 24, 4)],
        "CNBC Markets": [_scored("CNBC Markets", "rss:cnbc", "stocks rally", 78, 4),
                         _scored("CNBC Markets", "rss:cnbc", "earnings beat", 72, 3)],
    }
    specs = {k: SOURCE_BY_LABEL[k] for k in sbs}
    flat = [a for v in sbs.values() for a in v]
    eff = {"MarketWatch": 1.4, "CNBC Markets": 1.3}
    a = [s.model_dump() for s in aggregate.build_sources(sbs, specs, {})]
    b = [s.model_dump() for s in aggregate.build_sources(sbs, specs, {})]
    assert a == b
    c1 = aggregate.composite(aggregate.build_sources(sbs, specs, {}), eff, flat, {})
    c2 = aggregate.composite(aggregate.build_sources(sbs, specs, {}), eff, flat, {})
    assert c1 == c2


# ── Engine without the LLM still yields a real composite ──────────────────────
def _fake_fetch(spec, limit):
    titles = ["Stocks rally to record high", "Fed cuts rates as inflation cools",
              "Strong jobs report lifts optimism", "Earnings beat estimates broadly"]
    arts = [RawArticle(title=f"{spec.label}: {t}", published_at=NOW - (i + 1) * 600)
            for i, t in enumerate(titles)]
    return FetchOutcome(spec.key, spec.label, arts, latency_ms=100.0, attempted=len(arts),
                        parse_errors=0, ok=True)


def test_engine_llm_off_real_composite(monkeypatch):
    import sentiment.engine as engine
    monkeypatch.setattr(engine, "fetch_source", _fake_fetch)
    monkeypatch.setattr(engine, "fetch_market_context", lambda: {})
    s1 = engine.build_snapshot(refresh=True, now=NOW)
    s2 = engine.build_snapshot(refresh=True, now=NOW)

    assert s1.scoring_degraded is False           # score never depends on the LLM
    assert (s1.composite_score, s1.direction) == (s2.composite_score, s2.direction)
    assert s1.composite_score > 55                # an all-bullish tape reads bullish
    assert s1.sources_used > 0 and s1.source_health
    assert s1.audit and s1.confidence_interval and s1.verification
