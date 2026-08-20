"""The morning brief's opening paragraph.

Everything handed to the model here was measured somewhere else: the book's own
P&L and breadth, Mover Radar's grounded read on the names that actually moved
it, the earnings and macro dates already on the calendar. The model's only job
is to say what they add up to for this book this morning.

It replaced a list of deterministic bullets. Those were true but they read as
separate facts, and the thing a brief owes you is the sentence that connects
them: whether the day was the market or the names, whether the drag has a
reason, and what is coming that would change it.
"""
from __future__ import annotations

import json
import logging
import re

from fastapi import APIRouter, Body

router = APIRouter()
logger = logging.getLogger(__name__)

_SYSTEM = (
    "You write the opening paragraph of a trader's morning brief. You are given "
    "measurements of their own portfolio and of what moved it. Write what the "
    "morning amounts to for this book.\n"
    "Rules you must not break:\n"
    "- Use only what you are given. You know nothing else about these companies "
    "or this market. Never add a catalyst, a number or a piece of news that is "
    "not in the input.\n"
    "- Do not list the figures back. They are on screen directly below. Say what "
    "they mean together.\n"
    "- Lead with whatever actually matters most this morning. That is usually "
    "the reason behind the move rather than the move itself.\n"
    "- If the moves were the market or the sector rather than the names, say so. "
    "If nothing explains a drop, say that plainly instead of reaching.\n"
    "- Mention what is coming this week only when it would change what they do.\n"
    "- Three sentences at most, roughly 55 words. Plain and direct, addressed as "
    "'you'. No semicolons, no em dashes, no hedging, no advice, no greeting.\n"
    'Return JSON only: {"brief": "..."}'
)


@router.post("/summary")
async def brief_summary(payload: dict = Body(...)):
    """One paragraph over the whole book, or nothing at all.

    Its own endpoint so the brief renders before it arrives, and a provider
    outage costs the paragraph rather than the page. The caller keeps its
    computed bullets and shows those when this returns unavailable.
    """
    if not payload:
        return {"brief": None, "available": False}
    import ai_client

    try:
        raw = ai_client.groq_complete(
            json.dumps(payload, separators=(",", ":"))[:6000],
            system=_SYSTEM, max_tokens=400,
        )
        parsed = ai_client.parse_json(raw) or {}
    except Exception as e:                          # noqa: BLE001 — never 500 the brief
        logger.info("brief summary unavailable (%s)", e)
        return {"brief": None, "available": False}

    text = _ascii_punctuation(str(parsed.get("brief") or "").strip())
    if not text:
        return {"brief": None, "available": False}
    return {"brief": text[:600], "available": True}


# The house rules ban curly quotes, em dashes and ellipsis characters, and a
# model reaches for all three unprompted. Asking it not to costs prompt budget
# and still fails sometimes, so the substitution happens here instead.
_PUNCT = str.maketrans({
    "’": "'", "‘": "'", "“": '"', "”": '"',
    "—": ",", "–": "-", "−": "-", "…": "...",
})


def _ascii_punctuation(text: str) -> str:
    out = text.translate(_PUNCT).replace(";", ".")
    # An em dash was surrounded by spaces, so swapping it for a comma leaves one
    # floating in front of the comma.
    return re.sub(r"\s+([,.])", r"\1", out)
