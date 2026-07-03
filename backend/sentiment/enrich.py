"""Optional LLM enrichment — reasoning tags ONLY.

This layer is deliberately non-load-bearing: it assigns a `reasoning_tag` from a
fixed vocabulary and nothing else. It can never change a score, direction, tier,
or confidence. If `GROQ_API_KEY` is unset, the call fails, the response is
truncated, or an item exceeds the batch cap, the tag falls back to a
deterministic rule over the headline — so the snapshot is always fully populated
and reproducible regardless of LLM availability. Tags are content-hash cached.
"""
from __future__ import annotations

import hashlib
import json
import logging
import os
import re
import time

from sentiment import config
from sentiment.schemas import ScoredArticle

_log = logging.getLogger(__name__)

# title sha1[:16] -> (tag, expires_at)
_tag_cache: dict[str, tuple[str, float]] = {}

# Deterministic fallback: first matching rule wins; else by direction.
_FALLBACK_RULES: list[tuple[re.Pattern[str], str]] = [
    (re.compile(r'rate\s+hike|hawkish|hikes?\s+rates|raises?\s+rates', re.I), "Rate Hike Fear"),
    (re.compile(r'rate\s+cut|dovish|cuts?\s+rates|easing', re.I), "Rate Cut Hope"),
    (re.compile(r'earnings\s+beat|tops?\s+estimates|crushes|blowout|raises?\s+guidance', re.I), "Earnings Beat"),
    (re.compile(r'earnings\s+miss|misses|cuts?\s+guidance|profit\s+warning', re.I), "Earnings Miss"),
    (re.compile(r'recession|contraction|downturn|slowdown|growth\s+scare', re.I), "Recession Signal"),
    (re.compile(r'inflation|cpi|pce|price\s+(surge|spike|pressure)', re.I), "Inflation Surge"),
    (re.compile(r'tariff|trade\s+war|sanction|import\s+(tax|duty)', re.I), "Trade War Risk"),
    (re.compile(r'liquidity\s+crunch', re.I), "Liquidity Crunch"),
    (re.compile(r'credit|bank\s+(run|failure|collapse)|default|contagion|systemic', re.I), "Credit Risk"),
    (re.compile(r'\bwar\b|geopolit|conflict|military|nuclear|ukraine', re.I), "Geopolitical Risk"),
    (re.compile(r'supply\s+shock|shortage', re.I), "Supply Shock"),
    (re.compile(r'rally|record\s+high|all.time\s+high|risk-on|rebound', re.I), "Risk-On Rally"),
    (re.compile(r'jobs?|payrolls?|hiring|unemployment|labor', re.I), "Labor Market"),
    (re.compile(r'safe.haven|flight\s+to\s+safety|gold\s+(surge|rally)', re.I), "Safe Haven Bid"),
    (re.compile(r'dollar|dxy', re.I), "Dollar Strength"),
    (re.compile(r'central\s+bank|\bfed\b|fomc|powell|ecb|boj', re.I), "Central Bank Action"),
]


def _hash(title: str) -> str:
    return hashlib.sha1(title.encode()).hexdigest()[:16]


def fallback_tag(art: ScoredArticle) -> str:
    """Deterministic reasoning tag from the headline + scored direction."""
    for rx, tag in _FALLBACK_RULES:
        if rx.search(art.title):
            return tag
    if art.direction > 0.1:
        return "Risk-On Rally"
    if art.direction < -0.1:
        return "Growth Slowdown"
    return "Neutral Signal"


def _call_groq(titles: list[str]) -> list[str]:
    """One batched tag-only call at temperature 0. Returns [] on any failure."""
    numbered = "\n".join(f"{i + 1}. {t}" for i, t in enumerate(titles))
    prompt = (
        "You are a financial-news classifier. For each headline, choose the single best "
        "macro reasoning tag describing its broad-market driver.\n"
        "Return ONLY a JSON array of strings, one per headline, SAME ORDER as input.\n"
        f"Allowed tags (use these exact strings): {', '.join(config.REASONING_TAGS)}.\n"
        f"Return EXACTLY {len(titles)} strings. No markdown, no extra text.\n\n"
        f"Headlines:\n{numbered}"
    )
    try:
        from ai_client import groq_chat

        resp = groq_chat(
            [{"role": "user", "content": prompt}],
            model=config.ENRICH_MODEL,
            max_tokens=config.ENRICH_MAX_TOKENS,
            temperature=config.ENRICH_TEMPERATURE,
        )
        raw = resp.choices[0].message.content or ""
        clean = re.sub(r'```[a-z]*\n?', '', raw).strip()
        start, end = clean.find('['), clean.rfind(']')
        if start == -1 or end == -1:
            raise ValueError("no JSON array in response")
        arr = json.loads(clean[start:end + 1])
        return [str(x) for x in arr]
    except Exception as ex:
        _log.warning("Enrichment call failed: %s", ex)
        return []


def enrich(articles: list[ScoredArticle]) -> dict[str, str]:
    """Return ``{f'{source_key}::{title}': reasoning_tag}`` for every article.

    LLM tags for uncached items (capped), deterministic fallback otherwise. Never
    influences the numeric score.
    """
    now = time.time()
    out: dict[str, str] = {}
    uncached: list[ScoredArticle] = []

    for art in articles:
        key = f"{art.source_key}::{art.title}"
        entry = _tag_cache.get(_hash(art.title))
        if entry and now < entry[1]:
            out[key] = entry[0]
        else:
            uncached.append(art)

    tags: list[str] = []
    if uncached and os.getenv("GROQ_API_KEY"):
        tags = _call_groq([a.title for a in uncached[:config.MAX_ENRICH_ITEMS]])

    for i, art in enumerate(uncached):
        key = f"{art.source_key}::{art.title}"
        candidate = tags[i] if i < len(tags) else ""
        tag = candidate if candidate in config.REASONING_TAGS else fallback_tag(art)
        out[key] = tag
        _tag_cache[_hash(art.title)] = (tag, now + config.ENRICH_CACHE_TTL)

    return out
