"""Deterministic evidence selection for the report pipeline.

The model used to be handed forty tool names and asked to choose well. It chose
the ones whose names matched the objective's words, which is why every report
cited the same handful of numbers. The fix is not a better prompt: it is to do
the narrowing here, in code, and leave the model a short list it can reason about.

    decompose   (model)  objective -> 3-6 tagged questions
    shortlist   (code)   question tags -> <=10 candidate tools, ranked
    pick        (model)  2-3 of those ten, shown their real measurements
    enforce     (code)   coverage floor, shape budget, novelty, redundancy
    validate    (code)   seven levels, then a repair prompt naming the failure

Nothing here calls an LLM. `routers/ai.py` owns the two model calls and uses
these functions on either side of them, so the selection logic stays testable
without a network.
"""
from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from pathlib import Path

from .tool_registry import (
    EVIDENCE_CLASSES,
    QUESTION_TAGS,
    REPORT_TOOL_BY_ID,
    REPORT_TOOL_REGISTRY,
    ReportToolSpec,
    VISUAL_BY_SHAPE,
)

_CATALOG_PATH = Path(__file__).resolve().parent.parent / "data" / "report_metric_catalog.json"


def _load_catalog() -> dict[str, list[dict]]:
    try:
        return json.loads(_CATALOG_PATH.read_text()).get("metricsByTool", {})
    except (OSError, ValueError):
        # The catalog enriches selection; it never gates it. A missing file
        # degrades the planner to registry-level descriptions rather than
        # taking the report offline.
        return {}


METRICS_BY_TOOL: dict[str, list[dict]] = _load_catalog()

# Declaration order in the registry, used as a tiebreak. The registry lists
# general-purpose tools before specialised ones, so this is a deliberate
# preference and not an accident of naming the way alphabetical order was.
_REGISTRY_ORDER: dict[str, int] = {tool.id: index for index, tool in enumerate(REPORT_TOOL_REGISTRY)}

SHORTLIST_SIZE = 10
MAX_PICKS_PER_QUESTION = 3
MAX_QUESTIONS = 6

# What an argument of each shape has to contain before it is worth writing. A
# thesis with no `risk` evidence is not a thesis, it is a pitch — so the floor
# is enforced in code rather than asked for in a prompt.
TEMPLATE_CLASS_FLOOR: dict[str, tuple[str, ...]] = {
    "equity-note": ("level", "trend", "risk", "relative"),
    "comparison": ("relative", "level", "risk"),
    "macro-brief": ("context", "trend", "risk"),
    "portfolio-review": ("level", "risk", "relative", "context"),
    "screen-summary": ("relative", "level"),
    "thesis": ("level", "trend", "risk", "catalyst"),
}

# A short note cannot carry seven pulls, and a long one should not rest on two.
BUDGET_BY_LENGTH: dict[str, int] = {"short": 5, "medium": 8, "long": 12}

# Ceiling on any one output shape, so a report cannot be five line charts. Keyed
# by report length because a long note can carry more of everything.
SERIES_CAP_BY_LENGTH: dict[str, int] = {"short": 2, "medium": 3, "long": 4}

_NOVELTY_TTL_SECONDS = 60 * 60 * 24 * 30
_NOVELTY_DEPTH = 5          # how many prior reports of a template we remember
_NOVELTY_PENALTY = 0.6      # per appearance in recent history


@dataclass
class Question:
    text: str
    tags: tuple[str, ...]
    priority: int = 2

    def as_dict(self) -> dict:
        return {"q": self.text, "tags": list(self.tags), "priority": self.priority}


@dataclass
class Availability:
    """What the client can actually satisfy. Filters candidates before ranking."""
    has_symbols: bool = False
    symbol_count: int = 0
    has_portfolio: bool = False
    allow_slow: bool = True
    disabled_tool_ids: frozenset[str] = frozenset()

    def satisfies(self, tool: ReportToolSpec) -> bool:
        if tool.id in self.disabled_tool_ids:
            return False
        if tool.cost == "slow" and not self.allow_slow:
            return False
        mode = tool.target_mode
        if mode == "symbols" and not self.has_symbols:
            return False
        if mode == "portfolio" and not self.has_portfolio:
            return False
        if mode == "portfolio-or-symbols" and not (self.has_portfolio or self.has_symbols):
            return False
        # A relationship tool with one series has nothing to relate.
        if tool.id in {"correlation", "regression", "pairs", "market-compare"} and self.symbol_count < 2:
            return False
        return True


# ── Fallback decomposition ───────────────────────────────────────────────────
# Keyword -> tags. Used when the model call fails, and to seed the tag set so a
# decomposition that misses an explicit topic still retrieves for it. Every
# pattern here was previously an arm of the single-label detectIntent regex;
# the difference is that these accumulate instead of returning on first match.
_TAG_PATTERNS: tuple[tuple[str, tuple[str, ...]], ...] = (
    (r"\b(valuation|value|fair value|multiple|p/e|peg|cheap|expensive|intrinsic|dcf|overvalu|undervalu)\b",
     ("valuation_level",)),
    (r"\b(peer|comparable|versus|vs\.?|compare|comparison|relative|better|against)\b",
     ("relative_performance",)),
    (r"\b(trend|momentum|breakout|uptrend|downtrend|rally|selloff|drawdown)\b",
     ("trend_direction",)),
    (r"\b(risk|downside|tail|loss|stress|worst case|var|hedge|protect)\b",
     ("risk_downside",)),
    (r"\b(volatility|implied vol|iv|vix|skew|straddle|strangle|expected move)\b",
     ("volatility_regime",)),
    (r"\b(positioning|flow|insider|institution|13f|short interest|gamma|gex|dealer|cot|crowded)\b",
     ("positioning_flow",)),
    (r"\b(catalyst|event|earnings|news|announce|guidance|filing)\b",
     ("catalyst_event",)),
    (r"\b(margin|growth|quality|roic|roe|fundamental|revenue|profit|cash flow|moat)\b",
     ("quality_fundamental",)),
    (r"\b(debt|leverage|balance sheet|maturity|refinanc|dividend|buyback|capital structure)\b",
     ("capital_structure",)),
    (r"\b(macro|economy|economic|recession|cycle|inflation|cpi|pce|gdp|employment|payroll)\b",
     ("macro_regime",)),
    (r"\b(rates?|fed|fomc|yield|curve|credit|spread|treasury|duration)\b",
     ("rates_credit",)),
    (r"\b(breadth|participation|liquidity|advance.decline|new highs)\b",
     ("liquidity_breadth",)),
    (r"\b(concentration|diversif|weight|allocation|exposure|position size)\b",
     ("concentration",)),
    (r"\b(correlat|beta|factor|systematic|idiosyncratic|regression|pair)\b",
     ("correlation_struct",)),
    (r"\b(seasonal|season|month of|calendar effect|time of year)\b",
     ("seasonality_timing",)),
    (r"\b(supply chain|shipping|freight|chokepoint|logistics|tariff|import|export)\b",
     ("supply_chain_real",)),
    (r"\b(scenario|forecast|outlook|probability|projection|what if|expect)\b",
     ("scenario_forward",)),
)


def tags_from_text(text: str) -> tuple[str, ...]:
    """Every tag the objective mentions, not just the first one that matches."""
    lowered = (text or "").lower()
    found: list[str] = []
    for pattern, tags in _TAG_PATTERNS:
        if re.search(pattern, lowered):
            found.extend(tag for tag in tags if tag not in found)
    return tuple(found)


def fallback_questions(objective: str, template_id: str) -> list[Question]:
    """A usable question set when the decomposition call fails.

    Never returns empty: without tags, retrieval has nothing to match and the
    report would fall back to the same two clips this rebuild exists to avoid.
    """
    tags = list(tags_from_text(objective))
    for tag in TEMPLATE_DEFAULT_TAGS.get(template_id, ()):
        if tag not in tags:
            tags.append(tag)
    if not tags:
        tags = list(TEMPLATE_DEFAULT_TAGS["equity-note"])
    # One question per tag, capped, so the shortlist stage still runs per-topic.
    return [
        Question(text=f"What does the evidence say about {tag.replace('_', ' ')}?",
                 tags=(tag,), priority=index + 1)
        for index, tag in enumerate(tags[:MAX_QUESTIONS])
    ]


TEMPLATE_DEFAULT_TAGS: dict[str, tuple[str, ...]] = {
    "equity-note": ("quality_fundamental", "valuation_level", "trend_direction", "risk_downside"),
    "comparison": ("relative_performance", "valuation_level", "risk_downside"),
    "macro-brief": ("macro_regime", "rates_credit", "risk_downside", "liquidity_breadth"),
    "portfolio-review": ("concentration", "risk_downside", "correlation_struct", "relative_performance"),
    "screen-summary": ("quality_fundamental", "valuation_level", "relative_performance"),
    "thesis": ("quality_fundamental", "valuation_level", "catalyst_event", "risk_downside"),
}


def normalize_questions(raw: object, objective: str, template_id: str) -> list[Question]:
    """Coerce the model's decomposition into the closed vocabulary.

    Unknown tags are dropped rather than rejected: a question that keeps one
    valid tag is still useful, and a hard failure here would send an otherwise
    good plan to the fallback.
    """
    items = raw if isinstance(raw, list) else []
    questions: list[Question] = []
    for index, item in enumerate(items):
        if not isinstance(item, dict):
            continue
        text = re.sub(r"\s+", " ", str(item.get("q", "")).strip())[:200]
        tags = tuple(dict.fromkeys(
            str(tag).strip()
            for tag in (item.get("tags") or [])
            if str(tag).strip() in QUESTION_TAGS
        ))
        if not text or not tags:
            continue
        try:
            priority = int(item.get("priority", index + 1))
        except (TypeError, ValueError):
            priority = index + 1
        questions.append(Question(text=text, tags=tags, priority=max(1, min(priority, 9))))
        if len(questions) >= MAX_QUESTIONS:
            break
    if not questions:
        return fallback_questions(objective, template_id)

    # Anything the objective plainly asks about that the model did not tag. This
    # is additive insurance, not a correction: a missed tag silently removes a
    # whole family of tools from retrieval.
    covered = {tag for question in questions for tag in question.tags}
    for tag in tags_from_text(objective):
        if tag in covered or len(questions) >= MAX_QUESTIONS:
            continue
        questions.append(Question(
            text=f"What does the evidence say about {tag.replace('_', ' ')}?",
            tags=(tag,),
            priority=9,
        ))
    return sorted(questions, key=lambda question: question.priority)


# ── Retrieval ────────────────────────────────────────────────────────────────

def _novelty_counts(template_id: str) -> dict[str, int]:
    try:
        from disk_cache import disk_get
    except ImportError:
        return {}
    history = disk_get(f"report:novelty:{template_id}")
    if not isinstance(history, list):
        return {}
    counts: dict[str, int] = {}
    for entry in history[-_NOVELTY_DEPTH:]:
        for tool_id in entry if isinstance(entry, list) else []:
            counts[str(tool_id)] = counts.get(str(tool_id), 0) + 1
    return counts


def record_selection(template_id: str, tool_ids: list[str]) -> None:
    """Remember this report's pulls so the next one is pushed somewhere new."""
    try:
        from disk_cache import disk_get, disk_set
    except ImportError:
        return
    key = f"report:novelty:{template_id}"
    history = disk_get(key)
    history = history if isinstance(history, list) else []
    history.append(sorted(set(tool_ids)))
    disk_set(key, history[-_NOVELTY_DEPTH:], ttl=_NOVELTY_TTL_SECONDS)


def shortlist(
    question: Question,
    availability: Availability,
    *,
    already_selected: frozenset[str] = frozenset(),
    class_counts: dict[str, int] | None = None,
    novelty: dict[str, int] | None = None,
    size: int = SHORTLIST_SIZE,
) -> list[ReportToolSpec]:
    """Candidate tools for one question, best first.

    Ranking is deliberately boring: match strength, then whatever the plan is
    short of. The interesting behaviour comes from *what the model never sees* —
    thirty tools that do not answer this question.
    """
    class_counts = class_counts or {}
    novelty = novelty or {}
    scored: list[tuple[float, str, ReportToolSpec]] = []
    for tool in REPORT_TOOL_REGISTRY:
        if tool.id in already_selected or not availability.satisfies(tool):
            continue
        overlap = len(set(tool.question_tags) & set(question.tags))
        if not overlap:
            continue
        # A tool tagged for three things is less specific to this question than
        # one tagged for exactly it, so divide the hits by the tool's breadth.
        score = overlap * 2.0 + overlap / len(tool.question_tags)
        # Favour an evidence class the plan does not have yet.
        score += 1.5 / (1 + class_counts.get(tool.evidence_class, 0))
        score -= _NOVELTY_PENALTY * novelty.get(tool.id, 0)
        if tool.cost == "slow":
            score -= 0.4
        if tool.produces_visuals:
            score += 0.2
        scored.append((-score, tool.id, tool))
    scored.sort()
    return [tool for _, _, tool in scored[:size]]


def shortlist_payload(tools: list[ReportToolSpec]) -> list[dict]:
    """What the model sees for one question.

    Carries `yields` and `limits` so the choice is about fit, not name
    similarity. Metrics come from the inventory when the catalog is present.
    """
    payload = []
    for tool in tools:
        metrics = METRICS_BY_TOOL.get(tool.id, [])
        payload.append({
            "id": tool.id,
            "label": tool.label,
            "answers": list(tool.question_tags),
            "evidenceClass": tool.evidence_class,
            "gives": list(tool.yields)[:6] or [tool.description],
            "shape": list(tool.output_shapes),
            "measurements": [metric["name"] for metric in metrics[:6]],
            "limits": tool.limits or (metrics[0]["limits"] if metrics else ""),
        })
    return payload


# ── Enforcement ──────────────────────────────────────────────────────────────

@dataclass
class SelectionResult:
    tool_ids: list[str] = field(default_factory=list)
    reasons: dict[str, str] = field(default_factory=dict)
    notes: list[str] = field(default_factory=list)

    def as_dict(self) -> dict:
        return {"toolIds": self.tool_ids, "reasons": self.reasons, "notes": self.notes}


def protected_ids(tool_ids: list[str], template_id: str) -> set[str]:
    """The one pull carrying each class the template requires.

    Both the budget stages and the validator have to agree on this set. A cap
    that removes the only `trend` evidence in the plan has not enforced a budget,
    it has broken the floor the previous stage just satisfied — and if the
    validator does not know a pull is protected, `enforce` produces plans its own
    validation then rejects on every run.
    """
    floor_classes = set(TEMPLATE_CLASS_FLOOR.get(template_id, ()))
    protected: set[str] = set()
    covered: set[str] = set()
    for tool_id in tool_ids:
        tool = REPORT_TOOL_BY_ID.get(tool_id)
        if tool and tool.evidence_class in floor_classes and tool.evidence_class not in covered:
            covered.add(tool.evidence_class)
            protected.add(tool_id)
    return protected


def enforce(
    picked: list[str],
    reasons: dict[str, str],
    availability: Availability,
    *,
    template_id: str,
    length: str,
    baseline: list[str] | None = None,
    question_tags: frozenset[str] = frozenset(),
) -> SelectionResult:
    """Apply the coverage floor, the shape budget, and redundancy pruning.

    Order matters. Prune first so a redundant pull does not occupy a slot the
    floor then needs, and fill the floor before trimming to budget so a
    budget-driven cut cannot remove the only `risk` evidence in the report.
    """
    baseline = baseline or []
    asked = set(question_tags)
    budget = BUDGET_BY_LENGTH.get(length, BUDGET_BY_LENGTH["medium"])
    series_cap = SERIES_CAP_BY_LENGTH.get(length, SERIES_CAP_BY_LENGTH["medium"])
    notes: list[str] = []

    ordered = [tool_id for tool_id in dict.fromkeys([*baseline, *picked])
               if tool_id in REPORT_TOOL_BY_ID
               and availability.satisfies(REPORT_TOOL_BY_ID[tool_id])]

    # Redundancy: same evidence class from the same source surface twice.
    kept: list[str] = []
    seen_pairs: set[tuple[str, str]] = set()
    for tool_id in ordered:
        tool = REPORT_TOOL_BY_ID[tool_id]
        pair = (tool.evidence_class, tool.label.split()[0].lower())
        if pair in seen_pairs:
            notes.append(f"dropped {tool_id}: duplicates {pair[0]} evidence already covered")
            continue
        seen_pairs.add(pair)
        kept.append(tool_id)

    # Coverage floor: every class the template requires must be present.
    class_counts: dict[str, int] = {}
    for tool_id in kept:
        cls = REPORT_TOOL_BY_ID[tool_id].evidence_class
        class_counts[cls] = class_counts.get(cls, 0) + 1
    novelty = _novelty_counts(template_id)
    for required in TEMPLATE_CLASS_FLOOR.get(template_id, ()):
        if class_counts.get(required):
            continue
        candidates = [
            tool for tool in REPORT_TOOL_REGISTRY
            if tool.evidence_class == required
            and tool.id not in kept
            and availability.satisfies(tool)
        ]
        if not candidates:
            notes.append(f"no available tool supplies {required} evidence")
            continue
        # Prefer something the objective actually asked about. Without this the
        # tiebreak fell through to alphabetical order, which filled a portfolio
        # review's context slot with chokepoint exposure purely because the id
        # sorts first. Registry order is the final tiebreak rather than the id,
        # because the registry lists general-purpose tools before niche ones.
        candidates.sort(key=lambda tool: (
            -len(set(tool.question_tags) & asked),
            novelty.get(tool.id, 0),
            tool.cost == "slow",
            _REGISTRY_ORDER[tool.id],
        ))
        chosen = candidates[0]
        kept.append(chosen.id)
        reasons.setdefault(chosen.id, f"Coverage floor: the report had no {required} evidence.")
        class_counts[required] = 1
        notes.append(f"added {chosen.id} to satisfy the {required} floor")

    protected = protected_ids(kept, template_id)

    # Shape budget: cap `series` so the report is not a stack of line charts.
    series_seen = 0
    budgeted: list[str] = []
    for tool_id in kept:
        shapes = REPORT_TOOL_BY_ID[tool_id].output_shapes
        if shapes and shapes[0] == "series" and tool_id not in protected:
            series_seen += 1
            if series_seen > series_cap:
                notes.append(f"dropped {tool_id}: over the {series_cap}-series visual budget")
                continue
        budgeted.append(tool_id)

    # Budget: trim from the back, but never below the floor.
    if len(budgeted) > budget:
        essential = [tool_id for tool_id in budgeted if tool_id in protected]
        optional = [tool_id for tool_id in budgeted if tool_id not in protected]
        room = max(0, budget - len(essential))
        dropped = optional[room:]
        if dropped:
            notes.append(f"trimmed {len(dropped)} pull(s) to the {length} budget of {budget}")
        budgeted = [tool_id for tool_id in budgeted if tool_id in {*essential, *optional[:room]}]

    return SelectionResult(
        tool_ids=budgeted,
        reasons={tool_id: reasons.get(tool_id, "") for tool_id in budgeted},
        notes=notes,
    )


# ── Validation ───────────────────────────────────────────────────────────────

def validate_selection(
    selection: SelectionResult,
    availability: Availability,
    *,
    template_id: str,
    length: str,
) -> list[str]:
    """Levels L0-L4, cheapest first. L5 and L6 need the drafted outline."""
    errors: list[str] = []
    if not selection.tool_ids:
        errors.append("L0: the plan selected no evidence")
        return errors
    for tool_id in selection.tool_ids:                                    # L1
        if tool_id not in REPORT_TOOL_BY_ID:
            errors.append(f"L1: unknown tool id {tool_id}")
    for tool_id in selection.tool_ids:                                    # L2
        tool = REPORT_TOOL_BY_ID.get(tool_id)
        if tool and not availability.satisfies(tool):
            errors.append(f"L2: {tool_id} needs {tool.target_mode} which this report does not have")
    present = {REPORT_TOOL_BY_ID[tool_id].evidence_class
               for tool_id in selection.tool_ids if tool_id in REPORT_TOOL_BY_ID}
    for required in TEMPLATE_CLASS_FLOOR.get(template_id, ()):            # L3
        if required not in present:
            errors.append(f"L3: no {required} evidence for a {template_id}")
    # A series pull carrying a required class is exempt, exactly as in `enforce`.
    exempt = protected_ids(selection.tool_ids, template_id)
    series = sum(1 for tool_id in selection.tool_ids
                 if tool_id in REPORT_TOOL_BY_ID
                 and tool_id not in exempt
                 and REPORT_TOOL_BY_ID[tool_id].output_shapes[:1] == ("series",))
    cap = SERIES_CAP_BY_LENGTH.get(length, SERIES_CAP_BY_LENGTH["medium"])
    if series > cap:                                                      # L4
        errors.append(f"L4: {series} series visuals exceeds the budget of {cap}")
    if len(selection.tool_ids) != len(set(selection.tool_ids)):           # L4
        errors.append("L4: the plan selects the same tool twice")
    return errors


def repair_instruction(errors: list[str], availability: Availability, template_id: str) -> str:
    """Name the failure and the slot to fill, rather than asking to try again."""
    lines = ["The previous plan failed validation. Fix exactly these problems:"]
    lines.extend(f"  - {error}" for error in errors[:6])
    missing = [
        error.split("no ", 1)[1].split(" evidence", 1)[0]
        for error in errors if error.startswith("L3: no ")
    ]
    for required in missing:
        options = [
            tool.id for tool in REPORT_TOOL_REGISTRY
            if tool.evidence_class == required and availability.satisfies(tool)
        ][:6]
        if options:
            lines.append(f"For {required} evidence choose one of: {', '.join(options)}.")
    lines.append("Return the same JSON shape. Change only what the errors name.")
    return "\n".join(lines)


def allowed_visuals(tool_ids: list[str]) -> dict[str, list[str]]:
    """Chart types each pull may legitimately render, by output shape."""
    allowed: dict[str, list[str]] = {}
    for tool_id in tool_ids:
        tool = REPORT_TOOL_BY_ID.get(tool_id)
        if not tool:
            continue
        options: list[str] = []
        for shape in tool.output_shapes:
            for visual in VISUAL_BY_SHAPE.get(shape, ()):
                if visual not in options:
                    options.append(visual)
        allowed[tool_id] = options
    return allowed


def limits_for(tool_ids: list[str]) -> dict[str, str]:
    """The caveat text behind each pull, for the outline check and the prose."""
    out: dict[str, str] = {}
    for tool_id in tool_ids:
        tool = REPORT_TOOL_BY_ID.get(tool_id)
        if not tool:
            continue
        text = tool.limits
        if not text:
            metrics = METRICS_BY_TOOL.get(tool_id, [])
            text = next((metric["limits"] for metric in metrics if metric.get("limits")), "")
        if text:
            out[tool_id] = text
    return out


def coverage_report(tool_ids: list[str], template_id: str) -> dict:
    """What the plan covers, for the build note and the diversity check."""
    classes: dict[str, int] = {cls: 0 for cls in EVIDENCE_CLASSES}
    tags: dict[str, int] = {}
    for tool_id in tool_ids:
        tool = REPORT_TOOL_BY_ID.get(tool_id)
        if not tool:
            continue
        classes[tool.evidence_class] += 1
        for tag in tool.question_tags:
            tags[tag] = tags.get(tag, 0) + 1
    required = TEMPLATE_CLASS_FLOOR.get(template_id, ())
    return {
        "evidenceClasses": classes,
        "questionTags": tags,
        "requiredClasses": list(required),
        "missingClasses": [cls for cls in required if not classes.get(cls)],
        "toolCount": len(tool_ids),
        "distinctClasses": sum(1 for count in classes.values() if count),
    }
