"""LLM corrective overlay — adjudicates only the headlines the lexicon is unsure about.

The lexicon (``lexicon.score_text``) stays the primary, deterministic scorer. This
layer selects the low-confidence subset — items the lexicon itself flagged as
uncertain (confidence at or below ``CORRECTION_CONF_MAX``) — and asks the LLM for
a direction + magnitude read in ONE batched, temperature-0 call. A confident LLM
answer overrides the lexicon score for those items only; every other headline
keeps its untouched deterministic score.

Why an overlay and not a full rewrite: bag-of-words scoring fails on compositional
headlines ("greater WAR resilience to OUTPACE peers" reads bearish off the bare
token "war"), but it is fast, free, and reproducible on the clear majority. The
LLM is spent only where the lexicon admits doubt, so cost stays bounded to one
batched call per refresh and determinism holds for everything the lexicon was
sure about.

Reproducibility: temperature 0 + content-hash cache means the same headline maps
to the same correction for the cache lifetime. On any failure (no key, malformed
response, item over the cap) the lexicon score stands, so the snapshot is always
fully populated regardless of LLM availability — exactly like enrich.py.
"""
from __future__ import annotations

import hashlib
import json
import logging
import os
import re
import time
from dataclasses import replace

from sentiment import config
from sentiment.schemas import ScoredArticle

_log = logging.getLogger(__name__)

# title sha1[:16] -> (correction | None, expires_at). A cached None means the LLM
# was asked and declined to override (low confidence): don't re-ask for 4h.
_cache: dict[str, tuple[dict | None, float]] = {}

_DIR = {"bullish": 1.0, "bearish": -1.0, "neutral": 0.0}


def _hash(title: str) -> str:
    return hashlib.sha256(title.encode()).hexdigest()[:16]


def _enabled() -> bool:
    return os.getenv(config.CORRECTION_ENABLED_ENV, "1") != "0" and bool(os.getenv("GROQ_API_KEY") or os.getenv("CEREBRAS_API_KEY"))


def _signed_to_fields(signed: float) -> dict:
    """Map a signed direction in [-1, 1] to the lexicon's score/sentiment shape."""
    signed = max(-1.0, min(1.0, signed))
    score = max(0, min(100, round(50 + 50 * signed)))
    sentiment = "bullish" if signed > 0.1 else "bearish" if signed < -0.1 else "neutral"
    # The LLM gives a single risk-asset view. Apply it across every class, including
    # Commodities: the lexicon's per-asset read on a corrected item came from the same
    # misfire we're overriding, so keeping its commodity number would leave a known-bad
    # value on the card. We don't model commodity inversion here (no commodity read).
    by_asset = {"Equities": signed, "Crypto": signed, "Macro": signed, "Commodities": signed}
    return {"score": score, "direction": signed, "sentiment": sentiment, "by_asset_class": by_asset}


def _call_llm(titles: list[str]) -> list[dict | None]:
    """One batched direction+magnitude call at temperature 0.

    Returns a list aligned to ``titles``: each entry is a correction dict or None
    (the LLM was not confident enough to override). Returns [] on any failure so
    the caller falls back to the lexicon for the whole batch.
    """
    numbered = "\n".join(f"{i + 1}. {t}" for i, t in enumerate(titles))
    prompt = (
        "You are a financial-markets sentiment classifier. For each headline judge its "
        "IMPLICATION FOR BROAD RISK ASSETS (equities), reading the full sentence — "
        "negation, comparison, and who benefits — not individual scary words.\n"
        'Return ONLY a JSON array, one object per headline, SAME ORDER as input:\n'
        '{"dir": "bullish"|"bearish"|"neutral", "mag": 0.0-1.0, "conf": 0.0-1.0}\n'
        "dir = direction for risk assets, mag = strength of that move, conf = how sure you are.\n"
        f"Return EXACTLY {len(titles)} objects. No markdown, no prose.\n\n"
        f"Headlines:\n{numbered}"
    )
    try:
        from ai_client import groq_chat

        resp = groq_chat(
            [{"role": "user", "content": prompt}],
            model=config.CORRECTION_MODEL,
            max_tokens=config.CORRECTION_MAX_TOKENS,
            temperature=config.CORRECTION_TEMPERATURE,
        )
        raw = resp.choices[0].message.content or ""
        clean = re.sub(r"```[a-z]*\n?", "", raw).strip()
        start, end = clean.find("["), clean.rfind("]")
        if start == -1 or end == -1:
            raise ValueError("no JSON array in response")
        arr = json.loads(clean[start:end + 1])
        out: list[dict | None] = []
        for obj in arr:
            try:
                d = str(obj.get("dir", "")).lower().strip()
                if d not in _DIR:
                    out.append(None)
                    continue
                conf = float(obj.get("conf", 0.0))
                mag = max(0.0, min(1.0, float(obj.get("mag", 0.0))))
                if conf < config.CORRECTION_MIN_CONF:
                    out.append(None)
                    continue
                signed = _DIR[d] * (mag if d != "neutral" else 0.0)
                out.append(_signed_to_fields(signed))
            except (TypeError, ValueError, AttributeError):
                out.append(None)
        return out
    except Exception as ex:
        _log.warning("Correction call failed: %s", ex)
        return []


def apply(articles: list[ScoredArticle]) -> list[ScoredArticle]:
    """Override the lexicon read for low-confidence items with a confident LLM one.

    Pure pass-through when disabled or when nothing qualifies. Never raises; on
    LLM failure the input list is returned unchanged.
    """
    if not _enabled() or not articles:
        return articles

    now = time.time()
    # Candidates = items the lexicon itself was unsure about, lowest confidence first.
    candidates = sorted(
        (a for a in articles if a.confidence <= config.CORRECTION_CONF_MAX),
        key=lambda a: a.confidence,
    )
    if not candidates:
        return articles

    overrides: dict[str, dict] = {}   # id(article) -> correction fields
    uncached: list[ScoredArticle] = []
    for art in candidates:
        entry = _cache.get(_hash(art.title))
        if entry and now < entry[1]:
            if entry[0] is not None:
                overrides[art.title] = entry[0]
        else:
            uncached.append(art)

    batch = uncached[:config.MAX_CORRECTION_ITEMS]
    if batch:
        results = _call_llm([a.title for a in batch])
        for i, art in enumerate(batch):
            fields = results[i] if i < len(results) else None
            _cache[_hash(art.title)] = (fields, now + config.CORRECTION_CACHE_TTL)
            if fields is not None:
                overrides[art.title] = fields

    if not overrides:
        return articles

    out: list[ScoredArticle] = []
    for art in articles:
        fields = overrides.get(art.title)
        if fields is None or fields["direction"] == art.direction:
            out.append(art)
            continue
        merged = dict(art.asset_directions)
        merged.update(fields["by_asset_class"])
        out.append(replace(
            art,
            score=fields["score"], direction=fields["direction"], sentiment=fields["sentiment"],
            asset_directions=merged, corrected=True, lexicon_direction=art.direction,
        ))
    return out


def neutralize_floor(articles: list[ScoredArticle]) -> list[ScoredArticle]:
    """A floor-confidence lexicon read carries no real signal, so a directional
    label there is noise ("Equities Post Strong First Half" scored bearish). Any
    such item the LLM overlay did NOT rescue is forced to neutral — the honest
    read when there is no signal — so the tape stops showing false directions.
    Runs regardless of whether the overlay is enabled."""
    out: list[ScoredArticle] = []
    for a in articles:
        if not a.corrected and a.sentiment != "neutral" and a.confidence <= config.NEUTRALIZE_CONF_MAX:
            out.append(replace(
                a, direction=0.0, score=50, sentiment="neutral",
                asset_directions={k: 0.0 for k in a.asset_directions},
                lexicon_direction=a.direction,
            ))
        else:
            out.append(a)
    return out
