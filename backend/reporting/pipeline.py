from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field

from .tool_registry import REPORT_TOOL_BY_ID


class ReportObjectivePlanIn(BaseModel):
    thesis: str = ""
    requiredDataPoints: list[str] = Field(default_factory=list)
    requiredChecks: list[str] = Field(default_factory=list)


class ReportToolRunIn(BaseModel):
    sourceId: str
    label: str = ""
    status: Literal["complete", "partial", "failed"]
    targets: list[str] = Field(default_factory=list)
    clipIds: list[str] = Field(default_factory=list)
    missingTargets: list[str] = Field(default_factory=list)
    error: str = ""


class ReportDataBankIn(BaseModel):
    phase: Literal["complete"]
    requiredSourceIds: list[str] = Field(default_factory=list)
    runs: list[ReportToolRunIn] = Field(default_factory=list)
    objectivePlan: ReportObjectivePlanIn = Field(default_factory=ReportObjectivePlanIn)


_TEMPLATE_SECTIONS = {
    "equity-note": {
        "short": (
            ("investment-view", "Investment View", "State the call and the decisive evidence."),
            ("valuation-and-risk", "Valuation and Risk", "Reconcile valuation with the strongest risk to the call."),
        ),
        "medium": (
            ("investment-view", "Investment View", "State the call, what changed, and the decisive evidence."),
            ("operating-drivers", "Operating Drivers", "Explain the financial and business mechanisms behind the call."),
            ("valuation", "Valuation", "Reconcile intrinsic and relative valuation evidence."),
            ("catalysts-and-risks", "Catalysts and Risks", "Separate dated catalysts from the risks that could weaken the call."),
        ),
        "long": (
            ("investment-view", "Investment View", "State the call, what changed, and the decisive evidence."),
            ("financial-trajectory", "Financial Trajectory", "Establish the reported and forecast financial path."),
            ("operating-drivers", "Operating Drivers", "Explain the business mechanisms behind the forecast."),
            ("valuation", "Valuation", "Reconcile intrinsic and relative valuation evidence."),
            ("scenarios", "Scenarios", "Show the assumptions that create material upside and downside."),
            ("catalysts-and-risks", "Catalysts and Risks", "Separate dated catalysts from the risks that could weaken the call."),
        ),
    },
    "comparison": {
        "short": (
            ("relative-call", "Relative Call", "Name the preferred subject and the evidence that decides the comparison."),
            ("valuation-and-risk", "Valuation and Risk", "Compare valuation and the main risk to the relative call."),
        ),
        "medium": (
            ("relative-call", "Relative Call", "Name the preferred subject and the evidence that decides the comparison."),
            ("operating-comparison", "Operating Comparison", "Compare growth, quality, margins, and financial durability on like-for-like measures."),
            ("valuation-comparison", "Valuation Comparison", "Compare separate valuation methods without blending their logic."),
            ("catalysts-and-risks", "Catalysts and Risks", "Compare dated catalysts and the risks that could reverse the ranking."),
        ),
        "long": (
            ("relative-call", "Relative Call", "Name the preferred subject and the evidence that decides the comparison."),
            ("market-context", "Market Context", "Establish the common regime and relative price behavior."),
            ("operating-comparison", "Operating Comparison", "Compare growth, quality, margins, and financial durability on like-for-like measures."),
            ("valuation-comparison", "Valuation Comparison", "Compare separate valuation methods without blending their logic."),
            ("catalysts", "Catalysts", "Compare only events supported by dates in the evidence."),
            ("risks", "Risks", "Identify what could reverse the ranking and how it would appear in the evidence."),
        ),
    },
    "macro-brief": {
        "short": (
            ("regime-call", "Regime Call", "State the macro conclusion and the measurements that support it."),
            ("market-implications", "Market Implications", "Translate the regime into cross-asset implications and risks."),
        ),
        "medium": (
            ("regime-call", "Regime Call", "State the macro conclusion and the measurements that support it."),
            ("macro-drivers", "Macro Drivers", "Explain inflation, growth, policy, rates, and credit using supplied evidence."),
            ("cross-asset-read", "Cross-Asset Read", "Connect the regime to measured market behavior."),
            ("outlook-and-risks", "Outlook and Risks", "Separate the outlook horizon, dated events, and invalidating risks."),
        ),
        "long": (
            ("regime-call", "Regime Call", "State the macro conclusion and the measurements that support it."),
            ("growth-and-inflation", "Growth and Inflation", "Establish the growth and inflation impulse."),
            ("policy-and-rates", "Policy and Rates", "Interpret policy expectations and the yield curve."),
            ("credit", "Credit", "Measure whether credit confirms or contradicts the regime."),
            ("cross-asset-read", "Cross-Asset Read", "Connect the regime to measured market behavior."),
            ("outlook-and-risks", "Outlook and Risks", "Separate the outlook horizon, dated events, and invalidating risks."),
        ),
    },
    "portfolio-review": {
        "short": (
            ("what-happened", "What Happened", "Compare portfolio and reference return, risk, and drawdown on matching windows."),
            ("why-it-happened", "Why It Happened", "Use attribution evidence and distinguish measured exposure from unsupported causation."),
            ("what-could-happen-next", "What Could Happen Next", "Show supplied stress, scenario, valuation, and dated catalyst evidence."),
            ("what-action-follows", "What Action Follows", "State only actions supported by current and proposed allocation evidence."),
        ),
    },
    "screen-summary": {
        "short": (
            ("screen-result", "Screen Result", "State what the screen selected for and the strongest result."),
            ("shortlist", "Shortlist", "Rank the surviving names and reject weak matches with evidence."),
        ),
        "medium": (
            ("screen-result", "Screen Result", "State what the screen selected for and the strongest result."),
            ("ranking-evidence", "Ranking Evidence", "Compare the metrics that separate the leaders from the rest."),
            ("shortlist", "Shortlist", "Rank the surviving names and reject weak matches with evidence."),
        ),
        "long": (
            ("screen-result", "Screen Result", "State what the screen selected for and the strongest result."),
            ("ranking-evidence", "Ranking Evidence", "Compare the metrics that separate the leaders from the rest."),
            ("quality-check", "Quality Check", "Test whether the leading screen metrics survive fundamental scrutiny."),
            ("valuation-check", "Valuation Check", "Compare the separate valuation evidence for the leading names."),
            ("shortlist", "Shortlist", "Rank the surviving names and reject weak matches with evidence."),
        ),
    },
    "thesis": {
        "short": (
            ("thesis", "Thesis", "State the mechanism and the strongest evidence."),
            ("bear-case", "Bear Case", "Argue the strongest opposing case and say what remains unresolved."),
        ),
        "medium": (
            ("thesis", "Thesis", "State the mechanism and the strongest evidence."),
            ("evidence", "Evidence", "Build the supporting case from distinct evidence families."),
            ("valuation", "Valuation", "Show how separate valuation methods affect the thesis."),
            ("bear-case", "Bear Case", "Argue the strongest opposing case and say what remains unresolved."),
        ),
        "long": (
            ("setup", "Setup", "State what changed and why the opportunity exists."),
            ("mechanism", "Mechanism", "Explain the causal mechanism without overstating the evidence."),
            ("evidence", "Evidence", "Build the supporting case from distinct evidence families."),
            ("valuation", "Valuation", "Show how separate valuation methods affect the thesis."),
            ("bear-case", "Bear Case", "Argue the strongest opposing case."),
            ("monitoring", "Monitoring", "Name the supplied measurements and events that would strengthen or weaken the thesis."),
        ),
    },
}


def template_contract(template_id: str, length: str) -> dict:
    resolved_template = template_id if template_id in _TEMPLATE_SECTIONS else "equity-note"
    resolved_length = length if length in {"short", "medium", "long"} else "medium"
    by_length = _TEMPLATE_SECTIONS[resolved_template]
    rows = by_length.get(resolved_length) or by_length.get("medium") or next(iter(by_length.values()))
    return {
        "id": resolved_template,
        "length": resolved_length,
        "sections": [
            {"key": key, "label": label, "purpose": purpose}
            for key, label, purpose in rows
        ],
    }


def validate_data_bank(data_bank: ReportDataBankIn, clip_ids: set[str]) -> list[str]:
    errors: list[str] = []
    required = list(dict.fromkeys(data_bank.requiredSourceIds))
    run_by_id = {run.sourceId: run for run in data_bank.runs}
    for source_id in required:
        if source_id not in REPORT_TOOL_BY_ID:
            errors.append(f"Unknown required AlphaTape tool: {source_id}")
            continue
        run = run_by_id.get(source_id)
        if run is None:
            errors.append(f"AlphaTape tool did not reach a terminal state: {source_id}")
            continue
        missing_clip_ids = [clip_id for clip_id in run.clipIds if clip_id not in clip_ids]
        if missing_clip_ids:
            errors.append(f"DataBank references unavailable clips for {source_id}")
        if run.status == "complete" and not run.clipIds:
            errors.append(f"Completed AlphaTape tool returned no evidence: {source_id}")
        if run.status == "partial" and not run.error and not run.missingTargets:
            errors.append(f"Partial AlphaTape tool is missing its data-gap record: {source_id}")
        if run.status == "failed" and not run.error:
            errors.append(f"Failed AlphaTape tool is missing an error record: {source_id}")
    return errors


def validate_template_sections(sections: list[dict], contract: dict) -> list[str]:
    expected = [section["key"] for section in contract["sections"]]
    actual = [str(section.get("templateSection", "")) for section in sections]
    errors: list[str] = []
    if actual != expected:
        errors.append(f"Template sections must be {', '.join(expected)} in order")
    for index, section in enumerate(sections):
        if not str(section.get("heading", "")).strip():
            errors.append(f"Section {index + 1} is missing a heading")
        if not str(section.get("analysis", "")).strip():
            errors.append(f"Section {index + 1} is missing analysis")
    return errors
