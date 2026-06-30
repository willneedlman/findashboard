"""Pure aggregation math. No I/O, no shared mutable state, no implicit clock.

Given scored articles (already windowed, so `recency_weight`/`age_hours` are set),
effective source weights and corroboration factors, these functions deterministically
produce the composite and all derived metrics. The weighting preserves the legacy
engine: per-article weight = tier^EXP · confidence · recency · market_impact, now
additionally scaled by the cross-source corroboration factor. Calling any function
twice with identical arguments yields an identical result.
"""
from __future__ import annotations

import math
import statistics
from typing import Any

from sentiment import config
from sentiment.config import SourceSpec
from sentiment.schemas import (
    ConfidenceInterval, ItemOut, Momentum, ScoredArticle, SourceResult, Velocity,
)


def _corr(corroboration: dict[str, float], a: ScoredArticle) -> float:
    return corroboration.get(f"{a.source_key}::{a.title}", 1.0)


def _article_weight(a: ScoredArticle, corr: float) -> float:
    """tier^EXP · confidence · recency · market_impact · corroboration."""
    return float(
        (a.macro_tier ** config.TIER_EXPONENT)
        * a.confidence
        * a.recency_weight
        * a.market_impact_weight
        * corr
    )


def _item_out(a: ScoredArticle) -> ItemOut:
    fw = a.forward_looking_weight
    return ItemOut(
        text=a.title, published_at=a.published_at, age_hours=a.age_hours, url=a.url,
        sentiment=a.sentiment, score=a.score, direction=a.direction, macro_tier=a.macro_tier,
        confidence=a.confidence, recency_weight=a.recency_weight,
        market_impact_weight=a.market_impact_weight, reasoning_tag=a.reasoning_tag,
        forward_looking_weight=fw,
        forward_sentiment_score=round(a.score * fw, 2),
        backward_sentiment_score=round(a.score * (1.0 - fw), 2),
        entities=a.entities,
    )


def horizon_composites(
    all_scored: list[ScoredArticle], corroboration: dict[str, float],
) -> tuple[float, float, int, int]:
    """(forward_composite, backward_composite, forward_count, backward_count).

    Each side is the article-weighted average score over its horizon mass: the
    standard article weight scaled by forward_looking_weight (forward) or by
    1 - forward_looking_weight (backward). A side with no mass falls back to the
    neutral 50.0. Counts split articles at the 0.5 threshold (the hard toggle).
    """
    if not all_scored:
        return 50.0, 50.0, 0, 0
    fwd_num = fwd_den = bwd_num = bwd_den = 0.0
    fwd_count = bwd_count = 0
    for a in all_scored:
        w = _article_weight(a, _corr(corroboration, a))
        fw = a.forward_looking_weight
        fwd_num += a.score * w * fw
        fwd_den += w * fw
        bwd_num += a.score * w * (1.0 - fw)
        bwd_den += w * (1.0 - fw)
        if fw >= 0.5:
            fwd_count += 1
        else:
            bwd_count += 1
    fwd = round(fwd_num / fwd_den, 1) if fwd_den > 0 else 50.0
    bwd = round(bwd_num / bwd_den, 1) if bwd_den > 0 else 50.0
    return fwd, bwd, fwd_count, bwd_count


def build_sources(
    scored_by_source: dict[str, list[ScoredArticle]],
    specs_by_label: dict[str, SourceSpec],
    corroboration: dict[str, float],
) -> list[SourceResult]:
    """Per-source weighted aggregates + item detail (legacy `source_results`)."""
    results: list[SourceResult] = []
    for label, scored in scored_by_source.items():
        if not scored:
            continue
        spec = specs_by_label[label]
        weights = [_article_weight(a, _corr(corroboration, a)) for a in scored]
        tot = sum(weights) or 1.0
        n = len(scored)
        avg_score = sum(a.score * w for a, w in zip(scored, weights)) / tot
        avg_dir = sum(a.direction * w for a, w in zip(scored, weights)) / tot

        groups: dict[str, list[str]] = {}
        for a in scored:
            for e in a.entities:
                groups.setdefault(e["asset_class"], []).append(e["name"])
        groups = {k: list(dict.fromkeys(v)) for k, v in groups.items()}

        results.append(SourceResult(
            label=label, type=spec.kind, weight=spec.authority,
            avg_score=round(avg_score, 1), avg_direction=round(avg_dir, 3),
            avg_conf=round(sum(a.confidence for a in scored) / n, 2),
            avg_tier=round(sum(a.macro_tier for a in scored) / n, 1),
            avg_age_h=round(sum(a.age_hours for a in scored) / n, 1),
            count=n, qualifies=len({a.title for a in scored}) >= config.MIN_SOURCE_HEADLINES,
            asset_groups=groups, items=[_item_out(a) for a in scored],
        ))
    return results


def composite(
    source_results: list[SourceResult],
    eff_weight_by_label: dict[str, float],
    all_scored: list[ScoredArticle],
    corroboration: dict[str, float],
) -> tuple[float, float, str]:
    """(composite_score, direction, path). Source-level when >=2 sources qualify.

    The article-level fallback (fewer than 2 qualifying sources) avoids silently
    dropping single-article sources, exactly as the legacy engine did.
    """
    qualifying = [s for s in source_results if s.qualifies]
    n = len(qualifying)
    if n >= 2:
        base = 1.0 / n
        effs = [base * eff_weight_by_label.get(s.label, s.weight) for s in qualifying]
        tote = sum(effs) or 1.0
        comp = sum(s.avg_score * e for s, e in zip(qualifying, effs)) / tote
        direction = sum(s.avg_direction * s.avg_tier * e for s, e in zip(qualifying, effs)) / tote
        return round(comp, 1), round(direction, 3), "source-level"
    if all_scored:
        ws = [_article_weight(a, _corr(corroboration, a)) for a in all_scored]
        tot = sum(ws) or 1.0
        comp = sum(a.score * w for a, w in zip(all_scored, ws)) / tot
        direction = sum(a.direction * a.macro_tier * w for a, w in zip(all_scored, ws)) / tot
        return round(comp, 1), round(direction, 3), "article-level"
    return 50.0, 0.0, "empty"


def breakdown(all_scored: list[ScoredArticle]) -> tuple[int, int, int, int, int]:
    """(bull, bear, neutral, bull_pct, bear_pct)."""
    bull = sum(1 for a in all_scored if a.sentiment == "bullish")
    bear = sum(1 for a in all_scored if a.sentiment == "bearish")
    neutral = sum(1 for a in all_scored if a.sentiment == "neutral")
    total = bull + bear + neutral or 1
    return bull, bear, neutral, round(100 * bull / total), round(100 * bear / total)


def high_impact(all_scored: list[ScoredArticle]) -> tuple[float | None, int]:
    """Confidence·recency-weighted average over T4/T5 macro articles only."""
    hi = [a for a in all_scored if a.macro_tier >= config.HIGH_IMPACT_TIER]
    if not hi:
        return None, 0
    w = sum(a.confidence * a.recency_weight for a in hi) or 1.0
    score = sum(a.score * a.confidence * a.recency_weight for a in hi) / w
    return round(score, 1), len(hi)


def label_for(comp: float) -> str:
    for threshold, name in config.LABEL_THRESHOLDS:
        if comp >= threshold:
            return name
    return config.LABEL_FLOOR


def confidence_interval(comp: float, session_conf: float, degraded_fraction: float) -> ConfidenceInterval:
    """Half-width grows as the window thins and as sources degrade."""
    hw = 3.0 + 10.0 * (1.0 - session_conf) + 6.0 * degraded_fraction
    return ConfidenceInterval(
        low=round(max(0.0, comp - hw), 1),
        high=round(min(100.0, comp + hw), 1),
    )


def momentum(all_scored: list[ScoredArticle]) -> Momentum | None:
    """Newest 25% vs older 75% of in-window articles (confidence-weighted)."""
    items = sorted([a for a in all_scored if a.age_hours is not None], key=lambda a: a.age_hours)
    if len(items) < 4:
        return None
    cut = max(1, len(items) // 4)
    recent, older = items[:cut], items[cut:]

    def _w(lst: list[ScoredArticle]) -> float:
        tw = sum(a.confidence for a in lst) or 1.0
        return sum(a.score * a.confidence for a in lst) / tw

    r, o = _w(recent), _w(older)
    delta = r - o
    if delta > 8:
        label = "Strongly Improving"
    elif delta > 3:
        label = "Improving"
    elif delta > 1:
        label = "Slightly Improving"
    elif delta < -8:
        label = "Strongly Deteriorating"
    elif delta < -3:
        label = "Deteriorating"
    elif delta < -1:
        label = "Slightly Deteriorating"
    else:
        label = "Stable"
    return Momentum(delta=round(delta, 1), label=label, recent_avg=round(r, 1),
                    older_avg=round(o, 1), n_recent=len(recent), n_older=len(older))


def velocity(history: list[dict[str, Any]]) -> Velocity | None:
    if len(history) < 2:
        return None
    recent = history[-3:]
    dt = recent[-1]["fetched_at"] - recent[0]["fetched_at"]
    ds = recent[-1]["composite_score"] - recent[0]["composite_score"]
    if dt < 60:
        return None
    return Velocity(delta=round(ds, 1), velocity_hr=round(ds / (dt / 3600), 2),
                    elapsed_min=round(dt / 60), points_used=len(recent))


def baseline(history: list[dict[str, Any]]) -> dict[str, float] | None:
    """Mean/std of the trailing window (excluding the just-appended point)."""
    if len(history) < 4:
        return None
    window = history[:-1][-config.BASELINE_WINDOW:]
    if len(window) < 3:
        return None
    scores = [p["composite_score"] for p in window]
    mean = statistics.fmean(scores)
    std = statistics.pstdev(scores)
    return {"baseline_score": round(mean, 1), "baseline_std": round(std, 1), "baseline_n": len(window)}
