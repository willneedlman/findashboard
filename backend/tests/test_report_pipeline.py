import json
from pathlib import Path

from reporting.pipeline import (
    ReportDataBankIn,
    guard_evidence_domain_text,
    template_contract,
    validate_data_bank,
    validate_template_sections,
)
from types import SimpleNamespace
from reporting.tool_registry import (
    EVIDENCE_CLASSES, QUESTION_TAGS, REPORT_TOOL_BY_ID, report_tool_manifest,
)
from fastapi import HTTPException
from routers import ai


PORTFOLIO_REVIEW_FIXTURE = json.loads(
    (Path(__file__).parents[2] / "frontend/src/fixtures/portfolioReview16.json").read_text()
)


def test_tool_manifest_is_authoritative_and_schema_complete():
    manifest = report_tool_manifest()

    assert len(manifest) == len(REPORT_TOOL_BY_ID)
    assert len({tool["id"] for tool in manifest}) == len(manifest)
    assert all(tool["description"] and tool["targetMode"] for tool in manifest)
    assert all(tool["domain"] in {"portfolio", "issuer", "macro", "benchmark"} for tool in manifest)
    assert {tool["id"] for tool in manifest} == set(REPORT_TOOL_BY_ID)

    # The machine fields are what retrieval ranks on. A tool that ships without
    # them is invisible to every question and would silently never be selected.
    for tool in manifest:
        assert tool["questionTags"], f"{tool['id']} answers no question"
        assert set(tool["questionTags"]) <= set(QUESTION_TAGS)
        assert tool["evidenceClass"] in EVIDENCE_CLASSES
        assert tool["outputShapes"]
        assert tool["cost"] in {"cheap", "normal", "slow"}

    # Every tag must be answerable, or a question carrying it retrieves nothing.
    covered = {tag for tool in manifest for tag in tool["questionTags"]}
    assert covered == set(QUESTION_TAGS)


def test_data_bank_requires_terminal_record_for_every_required_tool():
    data_bank = ReportDataBankIn.model_validate({
        "phase": "ready",
        "requiredSourceIds": ["company", "dcf-valuation"],
        "runs": [{
            "sourceId": "company",
            "status": "complete",
            "clipIds": ["company-clip"],
            "coveredTargetCount": 1,
            "coveragePct": 100,
        }],
    })

    errors = validate_data_bank(data_bank, {"company-clip"})

    assert errors == ["AlphaTape tool did not reach a terminal state: dcf-valuation"]


def test_data_bank_keeps_noncritical_failure_as_explicit_missing_evidence():
    data_bank = ReportDataBankIn.model_validate({
        "phase": "ready",
        "requiredSourceIds": ["company", "dcf-valuation"],
        "runs": [
            {
                "sourceId": "company", "status": "complete", "clipIds": ["company-clip"],
                "coveredTargetCount": 1, "coveragePct": 100,
            },
            {
                "sourceId": "dcf-valuation", "status": "failed", "error": "No statement data.",
                "unresolvedGaps": ["DCF valuation: No statement data."],
            },
        ],
        "coverage": {
            "requestedTargets": 2,
            "coveredTargets": 1,
            "targetCoveragePct": 50,
            "domainCoveragePct": {"portfolio": 100, "issuer": 50, "macro": 100, "benchmark": 100},
        },
        "unresolvedGaps": ["DCF valuation: No statement data."],
    })

    assert validate_data_bank(data_bank, {"company-clip"}) == []


def test_data_bank_rejects_inconsistent_domain_coverage():
    data_bank = ReportDataBankIn.model_validate({
        "phase": "ready",
        "requiredSourceIds": ["company"],
        "runs": [{
            "sourceId": "company", "status": "complete", "domain": "issuer",
            "clipIds": ["company-clip"], "requestedTargetCount": 2,
            "coveredTargetCount": 2, "coveragePct": 100,
        }],
        "coverage": {
            "requestedTargets": 2,
            "coveredTargets": 2,
            "targetCoveragePct": 100,
            "domainCoveragePct": {"portfolio": 100, "issuer": 50, "macro": 100, "benchmark": 100},
        },
    })

    assert "DataBank issuer coverage is inconsistent" in validate_data_bank(data_bank, {"company-clip"})


def test_selected_template_defines_exact_sections_by_length():
    contract = template_contract("comparison", "medium")

    assert contract["id"] == "comparison"
    assert [section["key"] for section in contract["sections"]] == [
        "relative-call",
        "operating-comparison",
        "valuation-comparison",
        "catalysts-and-risks",
    ]


def test_portfolio_review_contracts_are_distinct_and_long_form_covers_forward_horizon():
    short = template_contract("portfolio-review", "short")
    medium = template_contract("portfolio-review", "medium")
    long = template_contract("portfolio-review", "long")

    assert len(short["sections"]) == 3
    assert len(medium["sections"]) == 5
    assert len(long["sections"]) == 7
    assert [section["key"] for section in long["sections"]] == [
        "portfolio-verdict",
        "return-and-drawdown",
        "concentration-and-exposure",
        "correlation-and-factor-risk",
        "downside-scenarios",
        "upside-and-forward-outlook",
        "portfolio-actions-and-gaps",
    ]


def test_16_position_portfolio_coverage_keeps_book_and_issuer_domains_separate():
    symbols = PORTFOLIO_REVIEW_FIXTURE["symbols"]
    clip_ids = {"portfolio-clip", "correlation-clip", "company-clip"}
    data_bank = ReportDataBankIn.model_validate({
        "phase": "ready",
        "requiredSourceIds": ["portfolio", "correlation", "company"],
        "criticalSourceIds": ["portfolio", "correlation"],
        "runs": [
            {
                "sourceId": "portfolio", "status": "complete", "domain": "portfolio", "critical": True,
                "clipIds": ["portfolio-clip"], "requestedTargetCount": 1,
                "coveredTargetCount": 1, "coveragePct": 100,
            },
            {
                "sourceId": "correlation", "status": "complete", "domain": "portfolio", "critical": True,
                "targets": symbols, "clipIds": ["correlation-clip"], "requestedTargetCount": 16,
                "coveredTargetCount": 16, "coveragePct": 100,
            },
            {
                "sourceId": "company", "status": "partial", "domain": "issuer", "critical": False,
                "targets": symbols, "clipIds": ["company-clip"], "missingTargets": ["TSLL"],
                "error": "TSLL fundamentals unavailable.", "requestedTargetCount": 16,
                "coveredTargetCount": 15, "coveragePct": 93.8,
                "unresolvedGaps": ["Company snapshot: TSLL fundamentals unavailable."],
            },
        ],
        "coverage": {
            "requestedTargets": 33,
            "coveredTargets": 32,
            "targetCoveragePct": 97.0,
            "domainCoveragePct": {"portfolio": 100, "issuer": 93.8, "macro": 100, "benchmark": 100},
        },
        "unresolvedGaps": ["Company snapshot: TSLL fundamentals unavailable."],
    })

    assert validate_data_bank(data_bank, clip_ids) == []
    assert data_bank.runs[1].targets == symbols
    assert data_bank.runs[2].coveragePct == 93.8


def test_16_position_fixture_long_contract_covers_the_selected_forward_horizon():
    contract = template_contract("portfolio-review", PORTFOLIO_REVIEW_FIXTURE["length"])

    assert PORTFOLIO_REVIEW_FIXTURE["lookforwardPreset"] == "next365"
    assert [section["key"] for section in contract["sections"]] == PORTFOLIO_REVIEW_FIXTURE["requiredLongSections"]
    assert "forward" in contract["sections"][-2]["purpose"].lower()


def test_issuer_segments_cannot_become_a_portfolio_revenue_claim():
    clips = [
        SimpleNamespace(
            evidenceDomain="issuer",
            title="Product Segments · NVDA",
            dataSummary="Data Center | Share 62%",
        ),
        SimpleNamespace(
            evidenceDomain="portfolio",
            title="Current Allocation",
            dataSummary="NVDA | Weight 12%",
        ),
    ]
    text = "Risk remains elevated. The portfolio revenue mix is 62% Data Center."

    guarded = guard_evidence_domain_text(text, clips)

    assert "portfolio revenue mix is 62%" not in guarded
    assert "Issuer segment evidence cannot be aggregated" in guarded
    assert guarded.startswith("Risk remains elevated.")


def test_template_validation_rejects_missing_or_reordered_sections():
    contract = template_contract("macro-brief", "short")
    sections = [
        {"templateSection": "market-implications", "heading": "Rates Lead", "analysis": "Evidence."},
        {"templateSection": "regime-call", "heading": "Growth Slows", "analysis": "Evidence."},
    ]

    errors = validate_template_sections(sections, contract)

    assert errors == [
        "Template sections must be regime-call, market-implications in order",
        "Section 1 heading must be Regime Call",
        "Section 2 heading must be Market Implications",
    ]


def test_template_validation_rejects_rewritten_section_labels():
    contract = template_contract("portfolio-review", "medium")
    sections = [
        {
            "templateSection": section["key"],
            "heading": f"{section['label']}: Model-Written Conclusion",
            "analysis": "Evidence-backed conclusion.",
        }
        for section in contract["sections"]
    ]

    errors = validate_template_sections(sections, contract)

    assert errors == [
        "Section 1 heading must be Portfolio Verdict",
        "Section 2 heading must be Performance",
        "Section 3 heading must be Exposure and Diversification",
        "Section 4 heading must be Downside and Upside",
        "Section 5 heading must be Action and Evidence Gaps",
    ]


def test_report_generation_blocks_before_phase_three_without_data_bank():
    request = ai.ReportGenRequest(
        goal="Assess AAPL",
        evidenceMode="alphatape",
        clips=[ai.ReportClipIn(id="company-clip", sourceTab="Corporate Hub", dataType="kpi")],
    )

    try:
        ai.generate_report(request)
    except HTTPException as error:
        assert error.status_code == 409
        assert "research must complete" in str(error.detail)
    else:
        raise AssertionError("generation should block before the DataBank checkpoint")


def test_report_generation_blocks_when_a_required_tool_never_finished():
    request = ai.ReportGenRequest(
        goal="Assess AAPL",
        evidenceMode="alphatape",
        dataBank={
            "phase": "ready",
            "requiredSourceIds": ["company", "dcf-valuation"],
            "runs": [{
                "sourceId": "company", "status": "complete", "clipIds": ["company-clip"],
                "coveredTargetCount": 1, "coveragePct": 100,
            }],
        },
        clips=[ai.ReportClipIn(id="company-clip", sourceTab="Corporate Hub", dataType="kpi")],
    )

    try:
        ai.generate_report(request)
    except HTTPException as error:
        assert error.status_code == 409
        assert "dcf-valuation" in str(error.detail)
    else:
        raise AssertionError("generation should block while a required tool is not terminal")


def test_a_custom_size_trims_from_the_middle_never_the_ends():
    """The opening states the call and the closing argues against it. An
    arbitrary truncation would leave a report that either never answers the
    question or never challenges its own answer."""
    from reporting.pipeline import template_contract, template_max_sections

    full = [section["key"] for section in template_contract("equity-note", "long")["sections"]]
    for count in range(2, len(full) + 1):
        keys = [section["key"] for section in template_contract("equity-note", "custom", count)["sections"]]
        assert len(keys) == count
        assert keys[0] == full[0]
        assert keys[-1] == full[-1]
        assert keys == [key for key in full if key in keys], "order must follow the template's arc"

    # Beyond the template's own arc there is nothing left to say, so it clamps
    # rather than inventing a section with no purpose text.
    ceiling = template_max_sections("equity-note")
    assert len(template_contract("equity-note", "custom", 40)["sections"]) == ceiling
    assert len(template_contract("equity-note", "custom", 1)["sections"]) == 2


def test_a_custom_size_without_a_count_falls_back_to_a_preset():
    from reporting.pipeline import template_contract

    assert template_contract("equity-note", "custom", 0)["length"] == "medium"
    assert template_contract("equity-note", "custom", None)["length"] == "medium"


def test_the_writer_budget_is_costed_from_the_custom_request():
    """Keyed by preset before, which had no entry for a custom size at all."""
    import routers.ai as ai

    assert ai._report_token_budget("medium", 4, None) == 4000
    tight = ai._report_token_budget("custom", 4, "tight")
    deep = ai._report_token_budget("custom", 4, "deep")
    assert tight < deep
    assert ai._report_token_budget("custom", 2, "tight") >= 2200      # floor
    assert ai._report_token_budget("custom", 20, "deep") <= 8000      # ceiling


def test_depth_is_independent_of_section_count():
    """A six-section tight brief and a three-section deep note are both askable;
    one dial could express neither."""
    import routers.ai as ai

    six_tight = ai._length_guidance("custom", 6, "tight")
    three_deep = ai._length_guidance("custom", 3, "deep")
    assert "6 sections" in six_tight and "2-3 tight sentences" in six_tight
    assert "3 sections" in three_deep and "2-4 paragraphs" in three_deep


def test_the_evidence_budget_scales_with_a_custom_section_count():
    from reporting.evidence_plan import budget_for

    assert budget_for("medium") == (8, 3)
    small, _ = budget_for("custom", 2)
    large, _ = budget_for("custom", 7)
    assert small < large
    assert budget_for("custom", 0) == budget_for("medium"), "no count means no custom size"
