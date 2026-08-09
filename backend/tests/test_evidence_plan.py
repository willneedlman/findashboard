"""Tests for deterministic evidence selection.

These pin the behaviour the rebuild exists to produce: that the model is never
shown the whole registry, that a report cannot ship without the evidence classes
its template requires, and that repeated reports of the same kind stop citing
the same handful of tools.
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))

from reporting.evidence_plan import (  # noqa: E402
    SHORTLIST_SIZE,
    Availability,
    Question,
    allowed_visuals,
    coverage_report,
    enforce,
    fallback_questions,
    limits_for,
    normalize_questions,
    repair_instruction,
    shortlist,
    shortlist_payload,
    tags_from_text,
    validate_selection,
)
from reporting.tool_registry import REPORT_TOOL_BY_ID, REPORT_TOOL_REGISTRY  # noqa: E402

EQUITY = Availability(has_symbols=True, symbol_count=1)
COMPARISON = Availability(has_symbols=True, symbol_count=2)
MACRO = Availability(has_symbols=False, symbol_count=0)


def test_a_shortlist_is_never_the_whole_registry():
    """The core mechanism. Forty undifferentiated names is what made the model
    pick on name similarity; ten question-matched ones is a choice it can make."""
    question = Question("What could go wrong?", ("risk_downside",))
    candidates = shortlist(question, EQUITY)

    assert 0 < len(candidates) <= SHORTLIST_SIZE
    assert len(candidates) < len(REPORT_TOOL_REGISTRY)
    assert all("risk_downside" in tool.question_tags for tool in candidates)


def test_a_shortlist_only_offers_tools_the_report_can_actually_run():
    """A symbol tool in a market-only report is not a weaker option, it is an
    impossible one, and offering it wastes a slot the model cannot use."""
    question = Question("What could go wrong?", ("risk_downside",))
    for tool in shortlist(question, MACRO):
        assert tool.target_mode not in {"symbols", "portfolio"}

    single_name = {tool.id for tool in shortlist(Question("How do they relate?", ("correlation_struct",)), EQUITY)}
    two_names = {tool.id for tool in shortlist(Question("How do they relate?", ("correlation_struct",)), COMPARISON)}
    # Correlation of a thing with itself is 1, so relationship tools need two.
    assert "correlation" not in single_name
    assert "correlation" in two_names


def test_the_shortlist_shows_measurements_and_caveats_not_just_names():
    """Choosing on fit requires knowing what comes back. This is the payload the
    old flat menu did not carry."""
    payload = shortlist_payload(shortlist(Question("Is it cheap?", ("valuation_level",)), EQUITY))

    assert payload
    assert all(item["gives"] for item in payload)
    assert all(item["evidenceClass"] for item in payload)
    assert any(item["limits"] for item in payload)


def test_a_slow_tool_is_withheld_from_a_short_report():
    question = Question("How broad is the move?", ("liquidity_breadth",))
    assert "breadth" in {tool.id for tool in shortlist(question, Availability(allow_slow=True))}
    assert "breadth" not in {tool.id for tool in shortlist(question, Availability(allow_slow=False))}


def test_the_coverage_floor_adds_what_the_template_requires():
    """An equity note that is all valuation and no risk is a pitch. The floor is
    enforced here rather than asked for in a prompt, so a model that picks badly
    still cannot produce one."""
    result = enforce(["company"], {"company": "x"}, EQUITY, template_id="equity-note", length="medium")

    classes = {REPORT_TOOL_BY_ID[tool_id].evidence_class for tool_id in result.tool_ids}
    assert {"level", "trend", "risk", "relative"} <= classes
    assert any("floor" in note for note in result.notes)
    assert not validate_selection(result, EQUITY, template_id="equity-note", length="medium")


def test_the_budget_never_trims_below_the_coverage_floor():
    """Order matters: a length-driven cut must not remove the only risk evidence."""
    picks = [tool.id for tool in REPORT_TOOL_REGISTRY if EQUITY.satisfies(tool)]
    result = enforce(picks, {tool_id: "x" for tool_id in picks}, EQUITY,
                     template_id="equity-note", length="short")

    assert len(result.tool_ids) <= 8
    classes = {REPORT_TOOL_BY_ID[tool_id].evidence_class for tool_id in result.tool_ids}
    assert {"level", "trend", "risk", "relative"} <= classes


def test_the_series_budget_stops_a_report_of_nothing_but_line_charts():
    series_tools = [
        tool.id for tool in REPORT_TOOL_REGISTRY
        if tool.output_shapes[:1] == ("series",) and EQUITY.satisfies(tool)
    ]
    assert len(series_tools) > 3, "fixture assumes several series tools exist"
    result = enforce(series_tools, {tool_id: "x" for tool_id in series_tools}, EQUITY,
                     template_id="equity-note", length="medium")

    # The cap applies to series pulls that are decoration. One carrying a class
    # the template requires is exempt, or the budget would break the floor.
    from reporting.evidence_plan import protected_ids

    exempt = protected_ids(result.tool_ids, "equity-note")
    kept = sum(1 for tool_id in result.tool_ids
               if tool_id not in exempt
               and REPORT_TOOL_BY_ID[tool_id].output_shapes[:1] == ("series",))
    assert kept <= 3
    assert any("budget" in note for note in result.notes)
    assert not validate_selection(result, EQUITY, template_id="equity-note", length="medium")


def test_validation_names_the_missing_class_and_the_repair_offers_real_ids():
    """A repair prompt that says 'try again' teaches a small model nothing. It
    has to name the failure and the ids that would fix it."""
    from reporting.evidence_plan import SelectionResult

    broken = SelectionResult(tool_ids=["company"], reasons={"company": "x"})
    errors = validate_selection(broken, EQUITY, template_id="equity-note", length="medium")
    assert any("no risk evidence" in error for error in errors)

    instruction = repair_instruction(errors, EQUITY, "equity-note")
    assert "risk" in instruction
    offered = [tool.id for tool in REPORT_TOOL_REGISTRY
               if tool.evidence_class == "risk" and EQUITY.satisfies(tool)]
    assert any(tool_id in instruction for tool_id in offered)


def test_tags_accumulate_instead_of_stopping_at_the_first_match():
    """The single-label regex it replaces returned 'comparison' here and never
    reached valuation, which is why comparison reports had no valuation evidence."""
    tags = tags_from_text("Compare NVDA and AMD on valuation and downside risk")

    assert "relative_performance" in tags
    assert "valuation_level" in tags
    assert "risk_downside" in tags


def test_a_failed_decomposition_still_produces_usable_questions():
    questions = normalize_questions(None, "Is the seasonal pattern in AAPL real", "equity-note")

    assert questions
    assert all(question.tags for question in questions)
    assert "seasonality_timing" in {tag for question in questions for tag in question.tags}


def test_normalization_drops_invented_tags_but_keeps_the_question():
    questions = normalize_questions(
        [{"q": "Is it cheap?", "tags": ["valuation_level", "made_up_tag"], "priority": 1}],
        "Is it cheap", "equity-note",
    )

    assert questions[0].tags == ("valuation_level",)


def test_normalization_backfills_a_topic_the_model_failed_to_tag():
    """A missed tag silently removes a whole family of tools from retrieval, so
    anything the objective plainly asks about is added back."""
    questions = normalize_questions(
        [{"q": "Is it cheap?", "tags": ["valuation_level"], "priority": 1}],
        "Is it cheap, and what is the insider positioning", "equity-note",
    )

    assert "positioning_flow" in {tag for question in questions for tag in question.tags}


def test_fallback_questions_are_never_empty():
    """Without tags, retrieval matches nothing and the report falls back to the
    same two clips the rebuild exists to avoid."""
    for template_id in ("equity-note", "comparison", "macro-brief", "portfolio-review", "thesis"):
        questions = fallback_questions("", template_id)
        assert questions
        assert all(question.tags for question in questions)


def test_a_scalar_can_never_be_rendered_as_a_line_chart():
    visuals = allowed_visuals(["company", "price-history", "seasonality"])

    assert "line" not in visuals["company"]          # scalar and table only
    assert "line" in visuals["price-history"]        # a genuine series
    assert "bar" in visuals["seasonality"]           # categorical by month


def test_limits_travel_with_the_selection():
    """The caveat text is what stops a section claiming past its evidence."""
    limits = limits_for(["earnings", "implied-probability", "options-unusual"])

    assert "risk-neutral" in limits["implied-probability"].lower()
    assert "sweep" in limits["options-unusual"].lower()


def test_coverage_report_names_what_is_missing():
    coverage = coverage_report(["company", "price-history"], "equity-note")

    assert coverage["toolCount"] == 2
    assert "risk" in coverage["missingClasses"]
    assert "relative" in coverage["missingClasses"]


def test_novelty_pushes_a_repeated_report_toward_different_evidence(monkeypatch):
    """The direct answer to 'the data it uses is very similar'. A tool cited by
    recent reports of the same template is demoted, not banned."""
    import reporting.evidence_plan as plan

    question = Question("What could go wrong?", ("risk_downside",))
    fresh = shortlist(question, EQUITY)
    repeated = fresh[0].id

    monkeypatch.setattr(plan, "_novelty_counts", lambda template_id: {repeated: 3})
    # Ask for the whole ranked pool, not the top ten: with more than ten tools
    # answering this tag, a demoted tool falling off a fixed-size cut would look
    # like a ban when it is only truncation.
    after = shortlist(question, EQUITY, novelty={repeated: 3}, size=40)

    assert after[0].id != repeated, "an over-used tool should not stay top of the list"
    assert repeated in {tool.id for tool in after}, "demoted, not removed"
    assert [tool.id for tool in after].index(repeated) > 0


def test_every_template_floor_is_satisfiable_with_the_availability_it_implies():
    """A floor requiring a class no eligible tool supplies can never be met, so
    the plan fails validation on every single run. This caught macro-brief, whose
    trend floor had no market-mode tool behind it at all."""
    from reporting.evidence_plan import TEMPLATE_CLASS_FLOOR

    availabilities = {
        "equity-note": EQUITY,
        "comparison": COMPARISON,
        "thesis": EQUITY,
        "screen-summary": COMPARISON,
        "macro-brief": MACRO,
        "portfolio-review": Availability(has_symbols=True, symbol_count=3, has_portfolio=True),
    }
    for template_id, required in TEMPLATE_CLASS_FLOOR.items():
        availability = availabilities[template_id]
        for cls in required:
            suppliers = [
                tool.id for tool in REPORT_TOOL_REGISTRY
                if tool.evidence_class == cls and availability.satisfies(tool)
            ]
            assert suppliers, f"{template_id} requires {cls} evidence no available tool supplies"


def test_the_visual_budget_cannot_drop_the_only_evidence_of_a_required_class():
    """Ordering bug this pins: the coverage floor added breadth to satisfy the
    macro trend requirement, and the series cap then removed it again, leaving a
    plan that failed the very check that had just passed."""
    result = enforce(
        ["global-markets", "credit-spreads", "rate-engine", "breadth", "sector-rrg"],
        {}, MACRO, template_id="macro-brief", length="medium",
    )

    classes = {REPORT_TOOL_BY_ID[tool_id].evidence_class for tool_id in result.tool_ids}
    assert "trend" in classes
    assert not validate_selection(result, MACRO, template_id="macro-brief", length="medium")


def test_a_superseding_tool_removes_the_one_it_contains():
    """Master Valuation runs the DCF as one of its four methods, so selecting
    both spends a slot to state the same number twice."""
    result = enforce(
        ["company", "dcf-valuation", "master-valuation", "price-history"],
        {}, EQUITY, template_id="equity-note", length="medium",
    )

    assert "master-valuation" in result.tool_ids
    assert "dcf-valuation" not in result.tool_ids
    assert any("already contains it" in note for note in result.notes)


def test_the_modelled_tools_are_offered_only_where_they_can_run():
    """A simulator needs a book or named symbols; an optimiser needs a book. A
    market-only macro brief has neither, and offering them wastes a slot."""
    question = Question("What is the downside?", ("risk_downside", "scenario_forward"))

    macro = {tool.id for tool in shortlist(question, MACRO)}
    assert "monte-carlo" not in macro
    assert "portfolio-optimizer" not in macro

    book = Availability(has_symbols=True, symbol_count=4, has_portfolio=True)
    with_book = {tool.id for tool in shortlist(question, book, size=20)}
    assert "monte-carlo" in with_book


def test_a_backtest_the_client_cannot_run_is_never_offered():
    """The client disables it when no saved strategy exists, because there is no
    default rule set worth reporting and inventing one would attribute a
    strategy the user never chose."""
    question = Question("How would the rules have done?", ("scenario_forward",))
    book = Availability(has_symbols=True, symbol_count=4, has_portfolio=True)
    assert "portfolio-backtest" in {tool.id for tool in shortlist(question, book, size=20)}

    gated = Availability(has_symbols=True, symbol_count=4, has_portfolio=True,
                         disabled_tool_ids=frozenset({"portfolio-backtest"}))
    assert "portfolio-backtest" not in {tool.id for tool in shortlist(question, gated, size=20)}
