"""Orchestrator: ingest -> validate -> qualify -> score -> enrich -> aggregate.

Owns the concurrent fetch, the snapshot cache, history persistence, the shared
reliability store, and audit emission. The composite is a deterministic function
of the fetched text plus the reference timestamp; the only non-deterministic
input (LLM tag enrichment) is isolated and cannot affect the score.
"""
from __future__ import annotations

import concurrent.futures
import logging
import math
import os
import sys
import threading
import time
from dataclasses import replace
from datetime import datetime
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(__file__))))
import json  # noqa: E402

from sentiment import aggregate, audit, config, correction, enrich, horizon, lexicon, source_manager  # noqa: E402
from sentiment.reliability import Reliability  # noqa: E402
from sentiment.schemas import ScoredArticle, SentimentSnapshot  # noqa: E402
from sentiment.sources import fetch_market_context, fetch_source  # noqa: E402

_log = logging.getLogger(__name__)
_ET = ZoneInfo("America/New_York")

# ── Shared state ──────────────────────────────────────────────────────────────
_reliability = Reliability()
_history_file = Path(os.getenv(config.HISTORY_PATH_ENV, config.HISTORY_DEFAULT_PATH))
_lock = threading.Lock()
_snapshot_cache: dict[int, SentimentSnapshot] = {}
_snapshot_expires: dict[int, float] = {}


def _current_ttl() -> int:
    return config.CACHE_TTL_MARKET if 6 <= datetime.now(_ET).hour < 20 else config.CACHE_TTL_OVERNIGHT


def load_history() -> list[dict[str, Any]]:
    try:
        if _history_file.exists():
            data = json.loads(_history_file.read_text())
            if isinstance(data, list):
                return data[-config.HISTORY_LIMIT:]
    except Exception as ex:
        _log.warning("Could not load history: %s", ex)
    return []


def _save_history(history: list[dict[str, Any]]) -> None:
    try:
        _history_file.parent.mkdir(parents=True, exist_ok=True)
        _history_file.write_text(json.dumps(history[-config.HISTORY_LIMIT:]))
    except Exception as ex:
        _log.warning("Could not save history: %s", ex)


_history: list[dict[str, Any]] = load_history()


def _ingest(specs: list[Any], per_source: int, now: int) -> tuple[dict[str, list[Any]], dict[str, Any], int]:
    """Concurrent fetch of all sources + market context. Updates reliability."""
    raw_by_label: dict[str, list[Any]] = {}
    market_ctx: dict[str, Any] = {}
    with concurrent.futures.ThreadPoolExecutor(max_workers=min(len(specs) + 1, 24)) as ex:
        mkt_fut = ex.submit(fetch_market_context)
        futs = {ex.submit(fetch_source, spec, per_source): spec for spec in specs}
        for fut in concurrent.futures.as_completed(futs):
            outcome = fut.result()
            _reliability.update(outcome, now)
            raw_by_label[outcome.label] = outcome.articles
        try:
            market_ctx = mkt_fut.result(timeout=20)
        except Exception as exc:
            _log.warning("Market context timed out: %s", exc)
    _reliability.persist()
    total_collected = sum(len(v) for v in raw_by_label.values())
    return raw_by_label, market_ctx, total_collected


def _score_window(
    specs: list[Any], raw_by_label: dict[str, list[Any]], timeframe_hours: int, now: int,
) -> tuple[list[ScoredArticle], int]:
    """Window-filter, deterministically score the top items per source."""
    cutoff = now - timeframe_hours * 3600
    decay_half = max(1.0, timeframe_hours * config.DECAY_HALFLIFE_RATIO)
    scored: list[ScoredArticle] = []
    in_window = 0
    for spec in specs:
        windowed = [a for a in raw_by_label.get(spec.label, []) if a.published_at >= cutoff]
        # Drop off-topic noise up front: only market-relevant articles (a financial
        # entity or a broad-market keyword) are scored, counted, or shown.
        relevant: list[tuple[Any, list]] = []
        for a in windowed:
            ents = lexicon.extract_entities(a.title)
            if not config.REQUIRE_MARKET_RELEVANCE or lexicon.is_relevant(a.title, ents):
                relevant.append((a, ents))
        in_window += len(relevant)
        # max(0, age): a future-dated / malformed timestamp must not produce a
        # recency_weight > 1 that lets one bad item dominate the composite.
        relevant.sort(
            key=lambda ae: math.exp(-max(0.0, (now - ae[0].published_at) / 3600.0) / decay_half) * ae[0].engagement_weight,
            reverse=True,
        )
        for art, entities in relevant[:config.PER_SOURCE_SCORE_CAP]:
            age_h = max(0.0, (now - art.published_at) / 3600.0)
            recency = round(math.exp(-age_h / decay_half), 4)
            lex = lexicon.score_text(art.title, entities)
            conf = min(lex.confidence, spec.confidence_cap)
            scored.append(ScoredArticle(
                source_key=spec.key, source_label=spec.label, source_type=spec.kind,
                title=art.title, url=art.url, published_at=art.published_at,
                age_hours=round(age_h, 2), recency_weight=recency, score=lex.score,
                direction=lex.direction, confidence=round(conf, 2), macro_tier=lex.macro_tier,
                sentiment=lex.sentiment,
                market_impact_weight=lexicon.market_impact_weight(art.title, entities),
                reasoning_tag="Neutral Signal",
                forward_looking_weight=horizon.forward_looking_weight(art.title),
                entities=entities,
                asset_directions=lex.by_asset_class,
            ))
    return scored, in_window


def _compute(sample_size: int, timeframe_hours: int, now: int) -> SentimentSnapshot:
    specs = source_manager.active_specs()
    specs_by_label = {s.label: s for s in specs}
    per_source = max(15, sample_size // max(1, len(specs)))

    raw_by_label, market_ctx, total_collected = _ingest(specs, per_source, now)
    scored, in_window = _score_window(specs, raw_by_label, timeframe_hours, now)

    # LLM corrective overlay: adjudicate only the headlines the lexicon scored with
    # low confidence, overriding its direction when the LLM is confident. Everything
    # else keeps its deterministic lexicon score. Pure pass-through if disabled.
    scored = correction.apply(scored)

    # Optional, non-scoring tag enrichment.
    tags = enrich.enrich(scored)
    scored = [replace(a, reasoning_tag=tags.get(f"{a.source_key}::{a.title}", a.reasoning_tag)) for a in scored]

    # Cross-source corroboration + effective weights.
    corroboration, verification, clusters = source_manager.verify(scored)
    eff_weight = {s.label: source_manager.effective_weight(s, _reliability) for s in specs}

    # Collapse each near-duplicate cluster to a single representative so a story
    # syndicated across feeds (e.g. CNBC Markets + CNBC Top News carrying the same
    # headline) is counted and shown once. Corroboration is measured above on the
    # full set first, so the multi-source signal is preserved; the representative
    # records how many feeds carried it.
    def _authority(a: ScoredArticle) -> float:
        spec = specs_by_label.get(a.source_label)
        return spec.authority if spec else 0.0

    deduped: list[ScoredArticle] = []
    for members in clusters:
        arts = [scored[i] for i in members]
        rep = max(arts, key=lambda a: (_authority(a), a.confidence, a.recency_weight, a.source_label, a.title))
        n_sources = len({a.source_label for a in arts})
        deduped.append(replace(rep, seen_in_sources=n_sources) if n_sources > 1 else rep)
    deduped.sort(key=lambda a: a.published_at, reverse=True)
    scored = deduped

    scored_by_source: dict[str, list[ScoredArticle]] = {}
    for a in scored:
        scored_by_source.setdefault(a.source_label, []).append(a)

    source_results = aggregate.build_sources(scored_by_source, specs_by_label, corroboration)
    comp, direction, path = aggregate.composite(source_results, eff_weight, scored, corroboration)
    fwd_comp, bwd_comp, fwd_count, bwd_count = aggregate.horizon_composites(scored, corroboration)
    bull, bear, neutral, bull_pct, bear_pct = aggregate.breakdown(scored)
    hi_score, hi_count = aggregate.high_impact(scored)
    session_conf = round(min(1.0, in_window / max(1, config.MIN_SIGNAL_HEADLINES)), 2)

    health = [_reliability.health(s.key, s.label, s.authority) for s in specs]
    degraded = [h.label for h in health if h.downgraded]
    for h in health:
        if h.downgraded:
            _log.warning("Source downgraded: %s reliability=%.2f weight_eff=%.2f",
                         h.label, h.reliability_score, h.weight_effective)
    degraded_fraction = len(degraded) / len(specs) if specs else 0.0

    fetched_at = now
    base = aggregate.baseline(_history)
    momentum = aggregate.momentum(scored)
    audit_info = audit.emit(
        fetched_at=fetched_at, composite=comp, direction=direction, path=path,
        source_results=source_results, health=health, verification=verification,
        total_scored=len(scored), degraded=degraded,
    )

    snap = SentimentSnapshot(
        composite_score=comp, label=aggregate.label_for(comp), direction=direction,
        session_conf=session_conf,
        total_headlines=sum(s.count for s in source_results if s.qualifies) if path == "source-level" else len(scored),
        in_window_count=in_window, timeframe_hours=timeframe_hours, sources=source_results,
        fetched_at=fetched_at, sample_size=sample_size, total_collected=total_collected,
        total_scored=len(scored), sources_used=len(source_results),
        bull_count=bull, bear_count=bear, neutral_count=neutral, bull_pct=bull_pct, bear_pct=bear_pct,
        scoring_degraded=False, groq_error=None,
        forward_composite=fwd_comp, backward_composite=bwd_comp,
        forward_count=fwd_count, backward_count=bwd_count,
        high_impact_score=hi_score, high_impact_count=hi_count if hi_score is not None else None,
        momentum=momentum, market_context=market_ctx or None,
        source_health=health,
        confidence_interval=aggregate.confidence_interval(comp, session_conf, degraded_fraction),
        verification=verification, audit=audit_info,
    )
    if base:
        snap.baseline_score = base["baseline_score"]
        snap.baseline_std = base["baseline_std"]
        snap.baseline_n = int(base["baseline_n"])
        snap.baseline_delta = round(comp - base["baseline_score"], 1)

    _append_history(snap)
    snap.velocity = aggregate.velocity(list(_history))
    return snap


def _append_history(snap: SentimentSnapshot) -> None:
    point = {
        "composite_score": snap.composite_score, "label": snap.label,
        "direction": snap.direction, "session_conf": snap.session_conf,
        "fetched_at": snap.fetched_at,
    }
    with _lock:
        _history.append(point)
        if len(_history) > config.HISTORY_LIMIT:
            _history.pop(0)
        snapshot = list(_history)
    _save_history(snapshot)


def build_snapshot(
    refresh: bool = False, sample_size: int = config.DEFAULT_SAMPLE_SIZE,
    timeframe_hours: int = 24, now: int | None = None,
) -> SentimentSnapshot:
    ts = now if now is not None else int(time.time())
    with _lock:
        cached = _snapshot_cache.get(timeframe_hours)
        if not refresh and cached and time.time() < _snapshot_expires.get(timeframe_hours, 0.0):
            return cached
    snap = _compute(sample_size, timeframe_hours, ts)
    with _lock:
        _snapshot_cache[timeframe_hours] = snap
        _snapshot_expires[timeframe_hours] = time.time() + _current_ttl()
    return snap


def history_payload() -> dict[str, Any]:
    with _lock:
        hist = list(_history)
    velocity = aggregate.velocity(hist)
    return {"points": hist, "velocity": velocity.model_dump() if velocity else None}
