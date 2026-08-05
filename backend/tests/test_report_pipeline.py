from reporting.pipeline import (
    ReportDataBankIn,
    template_contract,
    validate_data_bank,
    validate_template_sections,
)
from reporting.tool_registry import REPORT_TOOL_BY_ID, report_tool_manifest
from fastapi import HTTPException
from routers import ai


def test_tool_manifest_is_authoritative_and_schema_complete():
    manifest = report_tool_manifest()

    assert len(manifest) == len(REPORT_TOOL_BY_ID) == 23
    assert len({tool["id"] for tool in manifest}) == len(manifest)
    assert all(tool["description"] and tool["targetMode"] for tool in manifest)
    assert {tool["id"] for tool in manifest} == set(REPORT_TOOL_BY_ID)


def test_data_bank_requires_terminal_record_for_every_required_tool():
    data_bank = ReportDataBankIn.model_validate({
        "phase": "complete",
        "requiredSourceIds": ["company", "dcf-valuation"],
        "runs": [{
            "sourceId": "company",
            "status": "complete",
            "clipIds": ["company-clip"],
        }],
    })

    errors = validate_data_bank(data_bank, {"company-clip"})

    assert errors == ["AlphaTape tool did not reach a terminal state: dcf-valuation"]


def test_data_bank_keeps_failed_tool_as_explicit_missing_evidence():
    data_bank = ReportDataBankIn.model_validate({
        "phase": "complete",
        "requiredSourceIds": ["company", "dcf-valuation"],
        "runs": [
            {"sourceId": "company", "status": "complete", "clipIds": ["company-clip"]},
            {"sourceId": "dcf-valuation", "status": "failed", "error": "No statement data."},
        ],
    })

    assert validate_data_bank(data_bank, {"company-clip"}) == []


def test_selected_template_defines_exact_sections_by_length():
    contract = template_contract("comparison", "medium")

    assert contract["id"] == "comparison"
    assert [section["key"] for section in contract["sections"]] == [
        "relative-call",
        "operating-comparison",
        "valuation-comparison",
        "catalysts-and-risks",
    ]


def test_template_validation_rejects_missing_or_reordered_sections():
    contract = template_contract("macro-brief", "short")
    sections = [
        {"templateSection": "market-implications", "heading": "Rates Lead", "analysis": "Evidence."},
        {"templateSection": "regime-call", "heading": "Growth Slows", "analysis": "Evidence."},
    ]

    errors = validate_template_sections(sections, contract)

    assert errors == ["Template sections must be regime-call, market-implications in order"]


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
            "phase": "complete",
            "requiredSourceIds": ["company", "dcf-valuation"],
            "runs": [{"sourceId": "company", "status": "complete", "clipIds": ["company-clip"]}],
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
