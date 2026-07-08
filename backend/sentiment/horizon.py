"""Forward- vs backward-looking horizon classifier for a headline.

Deterministic and lexicon-based (no I/O, no LLM), so it is fast, free, and unit
testable. Returns a ``forward_looking_weight`` in [0, 1]:

  1.0  entirely forward-looking — forecasts, guidance, price targets, rate-cut bets
  0.0  entirely backward-looking — reported results, past price moves, recaps
  0.5  no horizon markers (ambiguous / balanced)

The weight is the strength-weighted share of forward markers:
``forward_strength / (forward_strength + backward_strength)``. Decisive framing
(a forecast, a reported result) counts double a weak marker (a bare "may"), so a
headline that both forecasts and references the past leans the right way instead
of splitting 50/50 on marker counts.
"""
from __future__ import annotations

import re

# (pattern, weight). STRONG markers (2) are unambiguous horizon cues; WEAK
# markers (1) are suggestive but easily incidental, so a single strong cue
# outweighs a lone weak one on the other side.
_FORWARD: list[tuple[str, int]] = [
    # strong — explicit prediction / guidance / scheduled-future framing
    (r"forecasts?", 2), (r"forecasted", 2), (r"outlook", 2), (r"guidance", 2), (r"guides?", 2),
    (r"projects?", 2), (r"projected", 2), (r"projections?", 2),
    (r"expects?", 2), (r"expected", 2), (r"expectations?", 2), (r"expected to", 2),
    (r"anticipates?", 2), (r"anticipated", 2), (r"estimates?", 2), (r"estimated", 2),
    (r"price target", 2), (r"targets?", 2), (r"upcoming", 2), (r"to report", 2), (r"ahead of", 2),
    (r"futures?", 2), (r"rate (?:cut|hike)s?", 2), (r"predicts?", 2), (r"predicted", 2), (r"predictions?", 2),
    (r"poised", 2), (r"set to", 2), (r"on track", 2), (r"plans? to", 2), (r"aims? to", 2),
    (r"next (?:quarter|year|month|week)", 2), (r"to launch", 2), (r"to acquire", 2), (r"warns?", 2),
    (r"bets?", 2), (r"odds", 2), (r"20(?:2[6-9]|3\d)", 2),
    # strong — added: forward risk / trajectory framing
    (r"risk of", 2), (r"threat(?:en(?:s|ed|ing)?|s)?", 2), (r"braces? for", 2), (r"bracing", 2),
    (r"looms?", 2), (r"looming", 2), (r"could face", 2), (r"to hit", 2), (r"to reach", 2),
    (r"will likely", 2), (r"likely to", 2), (r"seen (?:rising|falling|climbing|slipping|higher|lower|topping)", 2),
    (r"by 20\d\d", 2), (r"heading (?:for|into)", 2), (r"in focus", 2),
    # weak — suggestive modality
    (r"will", 1), (r"could", 1), (r"may", 1), (r"might", 1),
    (r"sees", 1), (r"eyes", 1), (r"looking to", 1), (r"weighs?", 1),
]

_BACKWARD: list[tuple[str, int]] = [
    # strong — reported outcomes / completed price action
    (r"reported", 2), (r"posted", 2), (r"beat", 2), (r"missed", 2), (r"announced", 2),
    (r"fell", 2), (r"rose", 2), (r"jumped", 2), (r"dropped", 2), (r"slumped", 2), (r"surged", 2),
    (r"gained", 2), (r"plunged", 2), (r"tumbled", 2), (r"climbed", 2), (r"slid", 2), (r"rallied", 2),
    (r"sank", 2), (r"soared", 2), (r"recap", 2), (r"logged", 2),
    (r"last (?:quarter|year|month|week)", 2), (r"year[- ]over[- ]year", 2), (r"yoy", 2),
    (r"q[1-4] (?:results|earnings|revenue|profit)", 2), (r"earnings (?:beat|miss)", 2),
    (r"closed (?:up|down|lower|higher)", 2), (r"record (?:high|low)", 2),
    (r"downtrend", 2), (r"uptrend", 2),
    # weak — current-state / past-performance / recap framing
    (r"results", 1), (r"prior", 1), (r"previously", 1), (r"data shows?", 1), (r"shows?", 1),
    (r"as expected", 1), (r"grew", 1), (r"grows", 1), (r"growing", 1), (r"enjoys?", 1), (r"enjoyed", 1),
    (r"driving", 1), (r"drove", 1), (r"first half", 1), (r"second half", 1),
    (r"first quarter", 1), (r"third quarter", 1), (r"fourth quarter", 1),
    (r"resistance", 1), (r"support at", 1), (r"live levels", 1),
    (r"in \d+ years", 1), (r"\d+[- ]year (?:high|low)", 1), (r"best .* in", 1), (r"worst .* in", 1),
    (r"so far this year", 1), (r"this year", 1), (r"impact", 1), (r"after", 1),
]

_FORWARD_RE = [(re.compile(rf"\b{p}\b", re.IGNORECASE), w) for p, w in _FORWARD]
_BACKWARD_RE = [(re.compile(rf"\b{p}\b", re.IGNORECASE), w) for p, w in _BACKWARD]


def forward_looking_weight(title: str) -> float:
    """Strength-weighted share of forward markers. 0.5 when none match."""
    if not title:
        return 0.5
    fwd = sum(w for rx, w in _FORWARD_RE if rx.search(title))
    bwd = sum(w for rx, w in _BACKWARD_RE if rx.search(title))
    total = fwd + bwd
    if total == 0:
        return 0.5
    return round(fwd / total, 3)
