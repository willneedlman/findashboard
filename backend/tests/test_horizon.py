"""Tests for the forward/backward horizon classifier and its aggregation.

Covers: the deterministic forward_looking_weight classifier, the per-article
subscore split (forward + backward == raw), and the article-weighted
forward/backward composites.
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))

from sentiment import aggregate
from sentiment.horizon import forward_looking_weight
from sentiment.schemas import ScoredArticle


def _article(title: str, score: int = 80, fw: float = 0.5) -> ScoredArticle:
    return ScoredArticle(
        source_key="k", source_label="L", source_type="rss", title=title, url="",
        published_at=0, age_hours=1.0, recency_weight=1.0, score=score, direction=0.5,
        confidence=1.0, macro_tier=3, sentiment="bullish", market_impact_weight=1.0,
        reasoning_tag="t", forward_looking_weight=fw, entities=[],
    )


# ── classifier ────────────────────────────────────────────────────────────────
def test_forward_headlines_score_high():
    for t in [
        "Fed expected to cut rates in 2027, analysts forecast",
        "Analyst sets $250 price target on Nvidia, sees upside ahead",
        "Apple guidance points to a strong next quarter",
    ]:
        assert forward_looking_weight(t) > 0.5, t


def test_backward_headlines_score_low():
    for t in [
        "Tesla reported Q3 results; revenue rose 8% year-over-year",
        "S&P 500 fell as banks posted weak earnings",
        "Microsoft beat estimates last quarter, shares jumped",
    ]:
        assert forward_looking_weight(t) < 0.5, t


def test_neutral_or_empty_defaults_to_half():
    assert forward_looking_weight("") == 0.5
    assert forward_looking_weight("Apple unveils new iPhone color") == 0.5


def test_weight_is_bounded_and_deterministic():
    t = "Fed forecast vs last quarter's reported results"
    w = forward_looking_weight(t)
    assert 0.0 <= w <= 1.0
    assert w == forward_looking_weight(t)  # deterministic


# ── subscore split ────────────────────────────────────────────────────────────
def test_subscores_split_raw_exactly():
    a = _article("x", score=80, fw=0.25)
    item = aggregate._item_out(a)
    assert item.forward_sentiment_score == 20.0      # 80 * 0.25
    assert item.backward_sentiment_score == 60.0     # 80 * 0.75
    assert round(item.forward_sentiment_score + item.backward_sentiment_score, 2) == 80.0


# ── horizon composites ────────────────────────────────────────────────────────
def test_horizon_composites_separate_the_signals():
    # Forward articles are bullish (90); backward articles are bearish (20).
    scored = [
        _article("a", score=90, fw=1.0),
        _article("b", score=90, fw=1.0),
        _article("c", score=20, fw=0.0),
        _article("d", score=20, fw=0.0),
    ]
    fwd, bwd, fc, bc = aggregate.horizon_composites(scored, {})
    assert fwd == 90.0
    assert bwd == 20.0
    assert fc == 2 and bc == 2


def test_horizon_composites_empty_is_neutral():
    assert aggregate.horizon_composites([], {}) == (50.0, 50.0, 0, 0)


def test_count_split_strictly_above_half():
    scored = [_article("a", fw=0.6), _article("b", fw=0.5)]
    _, _, fc, bc = aggregate.horizon_composites(scored, {})
    assert fc == 1 and bc == 1  # 0.6 forward; 0.5 (no markers) counts backward


def test_strong_forward_marker_outweighs_weak_backward():
    # A decisive forward cue (guidance / next quarter) beats an incidental past
    # reference, instead of splitting 50/50 on raw marker counts.
    assert forward_looking_weight("Nvidia beat estimates but guidance points to a strong next quarter") > 0.5
    assert forward_looking_weight("Fed warns of recession risk ahead") == 1.0
    # A decisive backward cue still wins when forward side is only weak/absent.
    assert forward_looking_weight("Stocks fell after data shows a slowdown") < 0.5


def test_reported_headlines_are_backward():
    for t in [
        "Small-cap stocks enjoy their best first half in 35 years. Here's what's driving it",
        "Microsoft stuck in downtrend, resistance at $381: Live levels",
        "UK economy grows as expected before Iran war impact, ONS data shows",
        "Apple unveils new iPhone color",  # no markers -> backward by default
    ]:
        assert forward_looking_weight(t) <= 0.5, t
