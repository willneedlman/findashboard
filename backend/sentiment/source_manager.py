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
from collections import Counter

from sentiment import config
from sentiment.config import SourceSpec
from sentiment.reliability import Reliability
from sentiment.schemas import ScoredArticle, Verification

_WORD = re.compile(r"[a-z0-9]+")

# Tokens that carry no subject identity: function words plus generic market
# vocabulary. They can count as shared content but must NOT serve as the rare
# anchor that fuses two paraphrased headlines, or template lines like
# "X stock rises on earnings" / "Y stock rises on earnings" would wrongly merge.
_STOP = frozenset("""
a an the of to in on for and or but with as at by from is are was were be been being this that these those
it its it's he she they them his her their you your we our us not no nor than then over under into out up down
off about after before may might could would should will can has have had do does did say says said tell tells
told amid if when while what why how who whom whose new now get gets new amp via per
""".split())
_COMMON_FINANCE = frozenset("""
stock stocks share shares market markets rate rates inflation earnings revenue revenues profit profits loss
losses fed ecb boe economy economic price prices index indexes dow nasdaq treasury treasuries yield yields
oil gold silver dollar euro bond bonds close closes closing open opens rise rises rose fall falls fell gain
gains drop drops tumble rally rallies surge surges slump high highs low lows week weeks day days month months
quarter report reports data growth investors trading trade session futures cut cuts hike hikes outlook forecast
sector stocks500 sp500 wall street percent points
beat beats miss misses top tops topped jump jumps jumped slide slides soar soars sink sinks climb climbs dip
dips plunge plunges slip slips edge edges rebound rebounds season company shares stockmarket
""".split())


def _content_tokens(title: str) -> frozenset[str]:
    """Subject-bearing tokens: length >= 3, minus function words."""
    return frozenset(t for t in _WORD.findall(title.lower()) if len(t) >= 3 and t not in _STOP)


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


def verify(items: list[ScoredArticle]) -> tuple[dict[str, float], Verification, list[list[int]]]:
    """Cluster near-duplicates; return (corroboration factor, stats, clusters).

    Single-linkage greedy clustering in input order is deterministic. The factor
    key is ``f"{source_key}::{title}"``; aggregate multiplies each article's
    weight by it. ``clusters`` is the member indices per cluster, so the caller
    can collapse a story syndicated across feeds to one representative.
    """
    shings = [_shingles(it.title) for it in items]
    toks = [_content_tokens(it.title) for it in items]

    # Rare anchor tokens: subject words (e.g. a surname) appearing in only a small
    # fraction of the batch and not generic market vocabulary. Two reworded
    # headlines about the same event share one even when their wording differs.
    n = len(items)
    df: Counter[str] = Counter()
    for ts in toks:
        df.update(ts)
    rare_df = max(3, round(n * config.PARAPHRASE_RARE_DF_FRACTION))
    rare = {t for t, c in df.items() if c <= rare_df and t not in _COMMON_FINANCE}

    def _same_story(i: int, rep_i: int) -> bool:
        if _jaccard(shings[rep_i], shings[i]) >= config.SHINGLE_SIMILARITY:
            return True
        shared = toks[rep_i] & toks[i]
        if len(shared) < config.PARAPHRASE_MIN_SHARED or not (shared & rare):
            return False
        shorter = min(len(toks[rep_i]), len(toks[i])) or 1
        return len(shared) / shorter >= config.PARAPHRASE_RATIO

    # Each cluster: [representative index, member indices, distinct source labels]
    clusters: list[tuple[int, list[int], set[str]]] = []
    for i in range(n):
        placed = False
        for rep_i, members, sources in clusters:
            if _same_story(i, rep_i):
                members.append(i)
                sources.add(items[i].source_label)
                placed = True
                break
        if not placed:
            clusters.append((i, [i], {items[i].source_label}))

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
    cluster_members = [members for _rep, members, _sources in clusters]
    return factor, Verification(clusters=len(clusters), corroborated=corroborated, discounted=discounted), cluster_members
