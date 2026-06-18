"""Structured JSON lineage logging for a sentiment calculation.

Emits one JSON line capturing how a composite was produced — the path taken,
per-source counts and scores, the effective reliability-adjusted weights, the
degraded sources, and the cross-source verification stats — so any score can be
audited after the fact. Returns the compact `AuditInfo` embedded in the payload.
"""
from __future__ import annotations

import hashlib
import json
import logging

from sentiment import config
from sentiment.schemas import AuditInfo, SourceHealth, SourceResult, Verification

_log = logging.getLogger("sentiment.audit")


def emit(
    *,
    fetched_at: int,
    composite: float,
    direction: float,
    path: str,
    source_results: list[SourceResult],
    health: list[SourceHealth],
    verification: Verification,
    total_scored: int,
    degraded: list[str],
) -> AuditInfo:
    lineage_id = hashlib.sha1(
        f"{fetched_at}:{composite}:{direction}:{total_scored}".encode()
    ).hexdigest()[:12]
    qualifying = sum(1 for s in source_results if s.qualifies)

    record = {
        "lineage_id": lineage_id,
        "formula_version": config.FORMULA_VERSION,
        "fetched_at": fetched_at,
        "composite": composite,
        "direction": direction,
        "composite_path": path,
        "qualifying_sources": qualifying,
        "total_scored": total_scored,
        "sources": [
            {"label": s.label, "count": s.count, "avg_score": s.avg_score, "qualifies": s.qualifies}
            for s in source_results
        ],
        "reliability": [
            {"label": h.label, "score": h.reliability_score,
             "weight_effective": h.weight_effective, "downgraded": h.downgraded}
            for h in health
        ],
        "degraded_sources": degraded,
        "verification": verification.model_dump(),
    }
    _log.info("sentiment_lineage %s", json.dumps(record, separators=(",", ":")))

    return AuditInfo(
        lineage_id=lineage_id, formula_version=config.FORMULA_VERSION,
        qualifying_sources=qualifying, composite_path=path,
    )
