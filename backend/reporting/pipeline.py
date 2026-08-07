from __future__ import annotations

import re
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
    domain: Literal["portfolio", "issuer", "macro", "benchmark"] = "issuer"
    critical: bool = False
    requestedTargetCount: int = 1
    coveredTargetCount: int = 0
    coveragePct: float = 0.0
    unresolvedGaps: list[str] = Field(default_factory=list)


class ReportCoverageIn(BaseModel):
    requestedTargets: int = 0
    coveredTargets: int = 0
    targetCoveragePct: float = 0.0
    domainCoveragePct: dict[str, float] = Field(default_factory=lambda: {
        "portfolio": 100.0,
        "issuer": 100.0,
        "macro": 100.0,
        "benchmark": 100.0,
    })


class ReportDataBankIn(BaseModel):
    phase: Literal["ready", "blocked"]
    requiredSourceIds: list[str] = Field(default_factory=list)
    criticalSourceIds: list[str] = Field(default_factory=list)
    runs: list[ReportToolRunIn] = Field(default_factory=list)
    objectivePlan: ReportObjectivePlanIn = Field(default_factory=ReportObjectivePlanIn)
    coverage: ReportCoverageIn = Field(default_factory=ReportCoverageIn)
    unresolvedGaps: list[str] = Field(default_factory=list)


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
            ("portfolio-verdict", "Portfolio Verdict", "Answer the portfolio question, state the measured window, and disclose any decision-limiting gap."),
            ("risk-and-return", "Risk and Return", "Compare matched-period return, volatility, drawdown, and benchmark evidence without overstating attribution."),
            ("outlook-and-action", "Outlook and Action", "Summarize supplied downside, upside, forward horizon, and only actions supported by tested alternatives."),
        ),
        "medium": (
            ("portfolio-verdict", "Portfolio Verdict", "Answer the portfolio question and identify the two measurements that decide the view."),
            ("performance", "Performance", "Compare matched-period return, volatility, drawdown, and risk-adjusted performance."),
            ("exposure-and-diversification", "Exposure and Diversification", "Measure concentration, sector classification limits, correlation, and factor exposure."),
            ("downside-and-upside", "Downside and Upside", "Separate historical downside from supplied scenarios, probabilities, valuation ranges, and dated forward evidence."),
            ("action-and-gaps", "Action and Evidence Gaps", "State supported actions and list the missing evidence that prevents stronger decisions."),
        ),
        "long": (
            ("portfolio-verdict", "Portfolio Verdict", "Answer the portfolio question, identify the decisive evidence, and disclose coverage limits."),
            ("return-and-drawdown", "Return and Drawdown", "Compare matched-period portfolio and reference returns, volatility, drawdown, and risk-adjusted performance."),
            ("concentration-and-exposure", "Concentration and Exposure", "Measure holding concentration, directly classified sectors, fund look-through gaps, and derivative sleeve limits."),
            ("correlation-and-factor-risk", "Correlation and Factor Risk", "Assess diversification, market sensitivity, factor coefficients, residual risk, and statistical confidence."),
            ("downside-scenarios", "Downside Scenarios", "Show historical tail evidence, stress losses, drawdown, VaR or CVaR when supplied, and scenario limitations."),
            ("upside-and-forward-outlook", "Upside and Forward Outlook", "Cover the selected forward horizon using probabilities, valuations, catalysts, and explicit model limitations."),
            ("portfolio-actions-and-gaps", "Portfolio Actions and Evidence Gaps", "State only supported actions, distinguish monitoring from trading, and enumerate unresolved evidence."),
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
    critical = set(data_bank.criticalSourceIds)
    for source_id in critical:
        if source_id not in required:
            errors.append(f"Critical AlphaTape tool is not required: {source_id}")
    run_by_id = {run.sourceId: run for run in data_bank.runs}
    for source_id in required:
        if source_id not in REPORT_TOOL_BY_ID:
            errors.append(f"Unknown required AlphaTape tool: {source_id}")
            continue
        run = run_by_id.get(source_id)
        if run is None:
            errors.append(f"AlphaTape tool did not reach a terminal state: {source_id}")
            continue
        expected_domain = REPORT_TOOL_BY_ID[source_id].domain
        if run.domain != expected_domain:
            errors.append(f"AlphaTape tool {source_id} has evidence domain {run.domain}; expected {expected_domain}")
        missing_clip_ids = [clip_id for clip_id in run.clipIds if clip_id not in clip_ids]
        if missing_clip_ids:
            errors.append(f"DataBank references unavailable clips for {source_id}")
        if run.status == "complete" and not run.clipIds:
            errors.append(f"Completed AlphaTape tool returned no evidence: {source_id}")
        if run.status == "partial" and not run.error and not run.missingTargets:
            errors.append(f"Partial AlphaTape tool is missing its data-gap record: {source_id}")
        if run.status == "failed" and not run.error:
            errors.append(f"Failed AlphaTape tool is missing an error record: {source_id}")
        if run.status != "complete" and not run.unresolvedGaps:
            errors.append(f"AlphaTape tool is missing explicit unresolved gaps: {source_id}")
        if run.requestedTargetCount < 1:
            errors.append(f"AlphaTape tool has invalid requested target count: {source_id}")
        if not 0 <= run.coveredTargetCount <= run.requestedTargetCount:
            errors.append(f"AlphaTape tool has invalid covered target count: {source_id}")
        expected_coverage = round((run.coveredTargetCount / max(1, run.requestedTargetCount)) * 100, 1)
        if abs(run.coveragePct - expected_coverage) > 0.11:
            errors.append(f"AlphaTape tool has inconsistent target coverage: {source_id}")
        if run.critical != (source_id in critical):
            errors.append(f"AlphaTape critical-source declaration is inconsistent: {source_id}")
        if source_id in critical and (run.status != "complete" or run.coveragePct < 100):
            errors.append(f"Critical AlphaTape tool is incomplete: {source_id} ({run.coveragePct:.1f}% coverage)")
    if data_bank.phase != "ready":
        gaps = "; ".join(data_bank.unresolvedGaps[:3]) or "critical evidence is incomplete"
        errors.append(f"DataBank is blocked: {gaps}")
    if data_bank.coverage.requestedTargets:
        expected_total = round(
            (data_bank.coverage.coveredTargets / data_bank.coverage.requestedTargets) * 100,
            1,
        )
        if abs(data_bank.coverage.targetCoveragePct - expected_total) > 0.11:
            errors.append("DataBank target coverage is inconsistent")
    for domain in ("portfolio", "issuer", "macro", "benchmark"):
        domain_runs = [run for run in data_bank.runs if run.domain == domain]
        requested = sum(run.requestedTargetCount for run in domain_runs)
        covered = sum(run.coveredTargetCount for run in domain_runs)
        expected = round((covered / requested) * 100, 1) if requested else 100.0
        supplied = data_bank.coverage.domainCoveragePct.get(domain)
        if supplied is None or abs(supplied - expected) > 0.11:
            errors.append(f"DataBank {domain} coverage is inconsistent")
    run_gaps = {
        gap.strip()
        for run in data_bank.runs
        for gap in run.unresolvedGaps
        if gap.strip()
    }
    top_level_gaps = {gap.strip() for gap in data_bank.unresolvedGaps if gap.strip()}
    if not run_gaps.issubset(top_level_gaps):
        errors.append("DataBank unresolved gaps do not include every tool-run gap")
    return errors


def validate_template_sections(sections: list[dict], contract: dict) -> list[str]:
    expected = [section["key"] for section in contract["sections"]]
    expected_labels = [section["label"] for section in contract["sections"]]
    actual = [str(section.get("templateSection", "")) for section in sections]
    errors: list[str] = []
    if actual != expected:
        errors.append(f"Template sections must be {', '.join(expected)} in order")
    for index, section in enumerate(sections):
        if not str(section.get("heading", "")).strip():
            errors.append(f"Section {index + 1} is missing a heading")
        elif index < len(expected_labels) and str(section.get("heading", "")).strip() != expected_labels[index]:
            errors.append(f"Section {index + 1} heading must be {expected_labels[index]}")
        if not str(section.get("analysis", "")).strip():
            errors.append(f"Section {index + 1} is missing analysis")
    return errors


_PORTFOLIO_SEGMENT_CLAIM = re.compile(
    r"(?:\bportfolio\b.{0,80}\b(?:revenue|business segments?|customer mix)\b|"
    r"\b(?:revenue|business segments?|customer mix)\b.{0,80}\bportfolio\b)",
    re.IGNORECASE,
)
_PORTFOLIO_SEGMENT_LIMITATION = (
    "Issuer segment evidence cannot be aggregated into a portfolio revenue-mix claim "
    "without portfolio-level look-through data."
)


def guard_evidence_domain_text(text: str, clips: list[object], *, headline: bool = False) -> str:
    """Remove issuer-to-portfolio claim leakage while preserving supported prose."""
    has_portfolio_segment_evidence = any(
        str(getattr(clip, "evidenceDomain", "") or "") == "portfolio"
        and re.search(
            r"portfolio.{0,40}(?:revenue|business segments?|customer mix|look-through)",
            f"{getattr(clip, 'title', '')} {getattr(clip, 'dataSummary', '')}",
            re.IGNORECASE,
        )
        for clip in clips
    )
    if has_portfolio_segment_evidence or not _PORTFOLIO_SEGMENT_CLAIM.search(text or ""):
        return text
    retained = [
        sentence.strip()
        for sentence in re.split(r"(?<=[.!?])\s+", text or "")
        if sentence.strip() and not _PORTFOLIO_SEGMENT_CLAIM.search(sentence)
    ]
    if headline:
        return " ".join(retained).strip()
    cleaned = " ".join(retained).strip()
    if _PORTFOLIO_SEGMENT_LIMITATION not in cleaned:
        cleaned = f"{cleaned} {_PORTFOLIO_SEGMENT_LIMITATION}".strip()
    return cleaned
