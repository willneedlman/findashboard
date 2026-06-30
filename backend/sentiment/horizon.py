"""Forward- vs backward-looking horizon classifier for a headline.

Deterministic and lexicon-based (no I/O, no LLM), so it is fast, free, and unit
testable. Returns a ``forward_looking_weight`` in [0, 1]:

  1.0  entirely forward-looking — forecasts, guidance, price targets, rate-cut bets
  0.0  entirely backward-looking — reported results, past price moves, recaps
  0.5  no horizon markers (ambiguous / balanced)

The weight is the share of horizon markers that are forward-looking:
``forward_hits / (forward_hits + backward_hits)``.
"""
from __future__ import annotations

import re

# Forward-looking markers: prediction, guidance, future events, speculation.
_FORWARD_PATTERNS = [
    r"forecasts?", r"forecasted", r"outlook", r"guidance", r"guides?",
    r"projects?", r"projected", r"projections?", r"expects?", r"expected",
    r"expectations?", r"anticipates?", r"anticipated", r"estimates?", r"estimated",
    r"price target", r"targets?", r"upcoming", r"to report", r"ahead of",
    r"futures?", r"rate (?:cut|hike)s?", r"predicts?", r"predicted", r"predictions?",
    r"poised", r"set to", r"on track", r"plans? to", r"aims? to", r"looking to",
    r"next (?:quarter|year|month|week)", r"will", r"could", r"may", r"might",
    r"sees", r"eyes", r"bets?", r"odds", r"to launch", r"to acquire", r"warns?",
    r"20(?:2[6-9]|3\d)",
]

# Backward-looking markers: reported facts, completed events, past price action.
_BACKWARD_PATTERNS = [
    r"reported", r"posted", r"results", r"beat", r"missed", r"announced",
    r"fell", r"rose", r"jumped", r"dropped", r"slumped", r"surged", r"gained",
    r"plunged", r"tumbled", r"climbed", r"slid", r"rallied", r"sank", r"soared",
    r"recap", r"logged", r"last (?:quarter|year|month|week)",
    r"year[- ]over[- ]year", r"yoy", r"q[1-4] (?:results|earnings|revenue|profit)",
    r"earnings (?:beat|miss)", r"prior", r"previously", r"closed (?:up|down|lower|higher)",
]

_FORWARD_RE = [re.compile(rf"\b{p}\b", re.IGNORECASE) for p in _FORWARD_PATTERNS]
_BACKWARD_RE = [re.compile(rf"\b{p}\b", re.IGNORECASE) for p in _BACKWARD_PATTERNS]


def forward_looking_weight(title: str) -> float:
    """Share of horizon markers that are forward-looking. 0.5 when none match."""
    if not title:
        return 0.5
    fwd = sum(1 for rx in _FORWARD_RE if rx.search(title))
    bwd = sum(1 for rx in _BACKWARD_RE if rx.search(title))
    total = fwd + bwd
    if total == 0:
        return 0.5
    return round(fwd / total, 3)
