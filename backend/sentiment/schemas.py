"""Pydantic v2 models — the validated boundaries of the engine.

`RawArticle` is the zero-trust ingestion boundary: every item returned by a
source adapter is coerced/validated here, and anything malformed raises and is
counted as a parse error rather than silently polluting the pipeline.

The remaining models define the OUTPUT contract. `SentimentSnapshot` reproduces
every field the legacy `/snapshot` response emitted (so `SentimentTracker.tsx`
is unaffected) and adds the additive audit/health fields. Optional fields
default to ``None`` and are stripped at serialisation, matching the legacy
behaviour of only including them when present.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from pydantic import BaseModel, ConfigDict, Field, field_validator

Entity = dict[str, str]  # {"name": ..., "asset_class": ...} — kept as the legacy shape


@dataclass(frozen=True)
class ScoredArticle:
    """Internal pipeline record: one article after deterministic scoring.

    Built by the engine after windowing (so recency/age are populated). Shared by
    source_manager (clustering), aggregate (weighting) and the output assembler.
    """

    source_key: str
    source_label: str
    source_type: str
    title: str
    url: str
    published_at: int
    age_hours: float
    recency_weight: float
    score: int
    direction: float
    confidence: float
    macro_tier: int
    sentiment: str
    market_impact_weight: float
    reasoning_tag: str
    forward_looking_weight: float = 0.5  # 1.0 = predictive/speculative, 0.0 = historical
    entities: list[Entity] = field(default_factory=list)
    seen_in_sources: int = 1  # distinct feeds that carried this story (1 = unique)
    asset_directions: dict[str, float] = field(default_factory=dict)  # per-asset-class read


# ── Ingestion boundary ────────────────────────────────────────────────────────
class RawArticle(BaseModel):
    """A single fetched headline. Validated at the source boundary (zero-trust)."""

    model_config = ConfigDict(extra="ignore")

    title: str
    published_at: int
    url: str = ""
    engagement_weight: float = 1.0

    @field_validator("title")
    @classmethod
    def _non_empty_title(cls, v: str) -> str:
        v = v.strip()
        if not v:
            raise ValueError("empty title")
        return v

    @field_validator("published_at", mode="before")
    @classmethod
    def _coerce_ts(cls, v: Any) -> int:
        # Feeds hand back float epochs, numeric strings, or None. Raise
        # ValueError (not TypeError) so Pydantic converts it to a
        # ValidationError the boundary counts as a parse error.
        try:
            return int(float(v))
        except (TypeError, ValueError) as ex:
            raise ValueError("invalid published_at") from ex

    @field_validator("engagement_weight", mode="before")
    @classmethod
    def _coerce_engagement(cls, v: Any) -> float:
        try:
            f = float(v)
        except (TypeError, ValueError):
            return 1.0
        return f if f >= 0 else 1.0


# ── Output: per-article / per-source ──────────────────────────────────────────
class ItemOut(BaseModel):
    text: str
    published_at: int
    age_hours: float
    url: str
    sentiment: str
    score: int
    direction: float
    macro_tier: int
    confidence: float
    recency_weight: float
    market_impact_weight: float
    reasoning_tag: str
    forward_looking_weight: float           # [0,1] horizon: 1 = forward, 0 = backward
    forward_sentiment_score: float          # score * forward_looking_weight
    backward_sentiment_score: float         # score * (1 - forward_looking_weight)
    entities: list[Entity]
    seen_in_sources: int = 1                 # distinct feeds carrying this story
    asset_directions: dict[str, float] = Field(default_factory=dict)  # per-asset-class direction


class SourceResult(BaseModel):
    label: str
    type: str
    weight: float
    avg_score: float
    avg_direction: float
    avg_conf: float
    avg_tier: float
    avg_age_h: float
    count: int
    qualifies: bool
    asset_groups: dict[str, list[str]]
    items: list[ItemOut]


# ── Output: additive audit / health fields ────────────────────────────────────
class SourceHealth(BaseModel):
    label: str
    key: str
    reliability_score: float
    latency_ms: float
    staleness_h: float
    parse_error_rate: float
    empty_rate: float
    downgraded: bool
    weight_effective: float


class ConfidenceInterval(BaseModel):
    low: float
    high: float


class Verification(BaseModel):
    clusters: int
    corroborated: int
    discounted: int


class AuditInfo(BaseModel):
    lineage_id: str
    formula_version: str
    qualifying_sources: int
    composite_path: str  # "source-level" | "article-level" | "empty"


class Momentum(BaseModel):
    delta: float
    label: str
    recent_avg: float
    older_avg: float
    n_recent: int
    n_older: int


class Velocity(BaseModel):
    delta: float
    velocity_hr: float
    elapsed_min: int
    points_used: int


# ── Output: top-level snapshot ────────────────────────────────────────────────
class SentimentSnapshot(BaseModel):
    # Legacy contract — always present.
    composite_score: float
    label: str
    direction: float
    session_conf: float
    total_headlines: int
    in_window_count: int
    timeframe_hours: int
    sources: list[SourceResult]
    fetched_at: int
    sample_size: int
    total_collected: int
    total_scored: int
    sources_used: int
    bull_count: int
    bear_count: int
    neutral_count: int
    bull_pct: int
    bear_pct: int
    scoring_degraded: bool
    groq_error: str | None = None  # name kept for contract; now = enrichment error

    # Horizon split — forward-looking vs backward-looking composite indices.
    forward_composite: float = 50.0
    backward_composite: float = 50.0
    forward_count: int = 0   # articles with forward_looking_weight >= 0.5
    backward_count: int = 0  # articles with forward_looking_weight < 0.5

    # Legacy contract — present only when available (stripped when None).
    high_impact_score: float | None = None
    high_impact_count: int | None = None
    momentum: Momentum | None = None
    velocity: Velocity | None = None
    market_context: dict[str, Any] | None = None
    baseline_score: float | None = None
    baseline_std: float | None = None
    baseline_n: int | None = None
    baseline_delta: float | None = None

    # Additive — always present.
    source_health: list[SourceHealth] = Field(default_factory=list)
    confidence_interval: ConfidenceInterval | None = None
    verification: Verification | None = None
    audit: AuditInfo | None = None
