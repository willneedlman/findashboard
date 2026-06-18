"""Source qualification, cross-source verification, and effective weighting.

- `active_specs`: the whitelisted, currently-available sources to ingest.
- `verify`: deterministic near-duplicate clustering (token-shingle Jaccard, not
  embeddings) used for cross-source corroboration. A *high-impact, strongly
  directional* claim carried by only one source is discounted — the protection
  against isolated manipulation / fake-news spikes — while ordinary unique
  coverage is left at full weight so the composite is not broadly suppressed.
- `effective_weight`: a source's authority scaled by its live reliability score.
"""
from __future__ import annotations

import os
import re

from sentiment import config
from sentiment.config import SourceSpec
from sentiment.reliability import Reliability
from sentiment.schemas import ScoredArticle, Verification

_WORD = re.compile(r"[a-z0-9]+")


def active_specs() -> list[SourceSpec]:
    """Whitelisted sources that can actually be fetched in this environment."""
    out: list[SourceSpec] = []
    for s in config.SOURCE_MATRIX:
        if not s.whitelisted:
            continue
        if s.kind == "finnhub" and not os.getenv("FINNHUB_API_KEY"):
            continue
        out.append(s)
    return out


def effective_weight(spec: SourceSpec, reliability: Reliability) -> float:
    """Authority weight scaled by the source's dynamic reliability score."""
    return spec.authority * reliability.score(spec.key)


def _shingles(title: str) -> frozenset[str]:
    toks = _WORD.findall(title.lower())
    k = config.SHINGLE_K
    if len(toks) < k:
        return frozenset(toks)
    return frozenset(" ".join(toks[i:i + k]) for i in range(len(toks) - k + 1))


def _jaccard(a: frozenset[str], b: frozenset[str]) -> float:
    if not a or not b:
        return 0.0
    union = len(a | b)
    return len(a & b) / union if union else 0.0


def _is_spike(it: ScoredArticle) -> bool:
    """An isolated claim worth discounting: systemic and very strongly directional."""
    return it.macro_tier >= config.SPIKE_TIER and abs(it.direction) >= config.SPIKE_DIRECTION


def verify(items: list[ScoredArticle]) -> tuple[dict[str, float], Verification]:
    """Cluster near-duplicates; return (corroboration factor by article key, stats).

    Single-linkage greedy clustering in input order is deterministic. The factor
    key is ``f"{source_key}::{title}"``; aggregate multiplies each article's
    weight by it.
    """
    shings = [_shingles(it.title) for it in items]
    # Each cluster: [representative shingles, member indices, distinct source labels]
    clusters: list[tuple[frozenset[str], list[int], set[str]]] = []
    for i, sh in enumerate(shings):
        placed = False
        for rep, members, sources in clusters:
            if _jaccard(rep, sh) >= config.SHINGLE_SIMILARITY:
                members.append(i)
                sources.add(items[i].source_label)
                placed = True
                break
        if not placed:
            clusters.append((sh, [i], {items[i].source_label}))

    factor: dict[str, float] = {}
    discounted = 0
    corroborated = 0
    for _rep, members, sources in clusters:
        is_corroborated = len(sources) >= 2
        if is_corroborated:
            corroborated += 1
        for idx in members:
            it = items[idx]
            discount = (not is_corroborated) and _is_spike(it)
            if discount:
                discounted += 1
            factor[f"{it.source_key}::{it.title}"] = (
                config.CORROBORATION_DISCOUNT if discount else 1.0
            )
    return factor, Verification(clusters=len(clusters), corroborated=corroborated, discounted=discounted)
