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
    BreakingItem, ConfidenceInterval, ItemOut, Momentum, ScoredArticle,
    SourceResult, Velocity,
)


def _corr(corroboration: dict[str, float], a: ScoredArticle) -> float:
    return corroboration.get(f"{a.source_key}::{a.title}", 1.0)


def _signal_from_direction(direction: float) -> float:
    """Neutral (|direction|~0) → SIGNAL_FLOOR; a decisive read (|direction| >=
    SIGNAL_FULL) → 1.0. Non-zero floor keeps an all-neutral set from dividing by
    zero. Shared by the article weight and the source-level composite so neutral
    news and net-neutral sources both fade out."""
    mag = min(1.0, abs(direction) / config.SIGNAL_FULL) if config.SIGNAL_FULL else 1.0
    return config.SIGNAL_FLOOR + (1.0 - config.SIGNAL_FLOOR) * mag


def _signal_factor(a: ScoredArticle) -> float:
    return _signal_from_direction(a.direction)


def _article_weight(a: ScoredArticle, corr: float) -> float:
    """tier^EXP · confidence · recency · market_impact · corroboration · signal."""
    return float(
        (a.macro_tier ** config.TIER_EXPONENT)
        * a.confidence
        * a.recency_weight
        * a.market_impact_weight
        * _signal_factor(a)
        * corr
    )


def _source_qualifies(scored: list[ScoredArticle]) -> bool:
    """A source qualifies with enough distinct headlines to be a stable average,
    OR when it carries a single high-impact, strongly directional headline. A
    breaking macro/geopolitical shock (T>=HIGH_IMPACT_TIER, |direction| large) is
    signal on its own and should move the composite, not be held out as thin."""
    if len({a.title for a in scored}) >= config.MIN_SOURCE_HEADLINES:
        return True
    return any(
        a.macro_tier >= config.HIGH_IMPACT_TIER
        and abs(a.direction) >= config.HIGH_IMPACT_QUALIFY_DIRECTION
        for a in scored
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
        seen_in_sources=a.seen_in_sources,
        asset_directions=a.asset_directions,
        corrected=a.corrected,
        lexicon_direction=a.lexicon_direction,
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
        if fw > 0.5:  # strictly forward; 0.5 (no markers) counts as backward
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
            count=n, qualifies=_source_qualifies(scored),
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
        # Fold in a per-source signal factor so a net-neutral source (avg_direction
        # ~0, avg_score ~50) barely dilutes the composite — only sources carrying a
        # directional read drive it.
        effs = [base * eff_weight_by_label.get(s.label, s.weight) * _signal_from_direction(s.avg_direction)
                for s in qualifying]
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


def breaking(
    all_scored: list[ScoredArticle],
    specs_by_label: dict[str, SourceSpec],
) -> list[BreakingItem]:
    """Cross-source 'what is moving right now': the freshest, most directional,
    highest-impact headlines, ranked by urgency independently of the per-source
    stream and the composite.

    Urgency = |direction| · confidence · market_impact · sqrt(tier) · recency,
    boosted by corroboration (extra feeds) and by a wire/alert source. An item
    must be fresh (age <= BREAKING_MAX_AGE_H), carry a real direction and clear a
    confidence floor to qualify — neutral wire filler never breaks. This is a
    view only; it does not change any scored value.
    """
    ranked: list[tuple[float, ScoredArticle, bool]] = []
    for a in all_scored:
        if a.age_hours is None or a.age_hours > config.BREAKING_MAX_AGE_H:
            continue
        if abs(a.direction) < config.BREAKING_MIN_DIRECTION:
            continue
        if a.confidence < config.BREAKING_MIN_CONFIDENCE:
            continue
        spec = specs_by_label.get(a.source_label)
        is_wire = bool(spec and spec.breaking)
        recency = max(0.0, 1.0 - a.age_hours / config.BREAKING_MAX_AGE_H)
        corr_boost = 1.0 + config.BREAKING_CORROBORATION_COEF * (a.seen_in_sources - 1)
        wire_boost = config.BREAKING_WIRE_BONUS if is_wire else 1.0
        urgency = (
            abs(a.direction)
            * a.confidence
            * a.market_impact_weight
            * math.sqrt(a.macro_tier)
            * (0.4 + 0.6 * recency)
            * corr_boost
            * wire_boost
        )
        ranked.append((urgency, a, is_wire))
    ranked.sort(key=lambda t: (t[0], -t[1].age_hours), reverse=True)
    out: list[BreakingItem] = []
    for urgency, a, is_wire in ranked[: config.BREAKING_LIMIT]:
        out.append(BreakingItem(
            text=a.title, url=a.url, source_label=a.source_label,
            published_at=a.published_at, age_hours=a.age_hours,
            sentiment=a.sentiment, score=a.score, direction=a.direction,
            macro_tier=a.macro_tier, confidence=a.confidence,
            seen_in_sources=a.seen_in_sources, reasoning_tag=a.reasoning_tag,
            entities=a.entities, wire=is_wire, urgency=round(urgency, 3),
        ))
    return out


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
