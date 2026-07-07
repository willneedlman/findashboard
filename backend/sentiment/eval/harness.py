"""Reusable eval logic: score a labeled headline set with the lexicon alone and
with the corrective overlay, and diff the two against the gold labels.

Shared by ``run.py`` (human-readable report) and the regression test (lexicon
floor). Pure functions apart from ``overlay_predictions``, which makes one LLM
call per uncertain headline via ``correction.apply``.
"""
from __future__ import annotations

import json
from pathlib import Path

from sentiment import correction, lexicon
from sentiment.schemas import ScoredArticle

_DATASET = Path(__file__).with_name("dataset.json")


def load_dataset() -> list[dict]:
    data = json.loads(_DATASET.read_text())
    return data["items"]


def _score(title: str) -> ScoredArticle:
    """Build a ScoredArticle from the pure lexicon read (no I/O)."""
    ents = lexicon.extract_entities(title)
    lex = lexicon.score_text(title, ents)
    return ScoredArticle(
        source_key="eval", source_label="eval", source_type="eval", title=title, url="",
        published_at=0, age_hours=0.0, recency_weight=1.0, score=lex.score,
        direction=lex.direction, confidence=lex.confidence, macro_tier=lex.macro_tier,
        sentiment=lex.sentiment, market_impact_weight=1.0, reasoning_tag="",
        asset_directions=lex.by_asset_class,
    )


def lexicon_predictions(items: list[dict]) -> list[ScoredArticle]:
    return [_score(it["title"]) for it in items]


def overlay_predictions(scored: list[ScoredArticle]) -> list[ScoredArticle]:
    """Apply the corrective overlay. If no LLM key is configured this is a
    pass-through and the result equals the lexicon read."""
    return correction.apply(scored)


def accuracy(preds: list[ScoredArticle], items: list[dict]) -> float:
    if not items:
        return 0.0
    hits = sum(1 for p, it in zip(preds, items) if p.sentiment == it["expected"])
    return hits / len(items)


def evaluate(offline: bool = False) -> dict:
    """Run both scorers over the dataset and return a structured report."""
    items = load_dataset()
    lex = lexicon_predictions(items)
    ov = lex if offline else overlay_predictions(lex)

    rows = []
    fixed = broke = changed = 0
    for lp, op, it in zip(lex, ov, items):
        exp = it["expected"]
        lex_ok, ov_ok = lp.sentiment == exp, op.sentiment == exp
        outcome = "same"
        if op.corrected:
            changed += 1
            if not lex_ok and ov_ok:
                outcome, fixed = "FIXED", fixed + 1
            elif lex_ok and not ov_ok:
                outcome, broke = "BROKE", broke + 1
            else:
                outcome = "adjusted"
        rows.append({
            "title": it["title"], "expected": exp,
            "lexicon": lp.sentiment, "overlay": op.sentiment,
            "lex_ok": lex_ok, "ov_ok": ov_ok, "outcome": outcome,
        })

    return {
        "n": len(items), "offline": offline,
        "lexicon_accuracy": accuracy(lex, items),
        "overlay_accuracy": accuracy(ov, items),
        "corrected": changed, "fixed": fixed, "broke": broke,
        "rows": rows,
    }
