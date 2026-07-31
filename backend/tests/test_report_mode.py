"""Tests for the Report Creator's subject/mode detection (routers.ai).

Locks the fix for reports collapsing a multi-ticker comparison goal onto a
single-subject price-range verdict: 2+ named subjects (or explicit comparison
language) must route to "open" mode, where keyResult is trusted verbatim
instead of being rewritten into a dollar range. Network-free (no LLM calls).
"""
import json
import os
import sys
from types import SimpleNamespace

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))

import routers.ai as ai  # noqa: E402
from routers.ai import (  # noqa: E402
    ReportClipIn, ReportGenRequest, _all_kpis_by_ticker, _apply_section_layout_architecture,
    _auto_must_include, _build_sections,
    _clean_chart, _clip_ticker, _first_number, _grouped_kpi_chart, _inject_mechanical_charts,
    _length_key, _mechanical_chart_pool, _mechanical_segments_pie, _mechanical_sensitivity_chart,
    _must_include_section, _normalize_key_result, _parse_kpi_summary, _parse_table_summary,
    _ranked_subjects, _report_mode, _report_system_prompt, _subject_ticker, _valuation_gap_chart,
    _annotate_sensitivity_swing, _revise_block_before, _sensitivity_swing_summary, _ALLOWED_REVISE_FIELDS,
    _select_report_appendix_clip_ids, _remove_unverified_numeric_sentences,
    _filter_unverified_key_figures, _build_report_slot_ctx,
)


def _clip(id_, source, title, summary):
    return ReportClipIn(id=id_, sourceTab=source, dataType="kpi", title=title,
                         dataSummary=summary, userDescription="")


def test_report_research_planner_keeps_only_supported_nonbaseline_tools(monkeypatch):
    monkeypatch.setattr(ai, "groq_complete", lambda *args, **kwargs: """{
      "summary": "Add visual dependence and rates evidence.",
      "additions": [
        {"id": "correlation", "reason": "Show whether the subjects diversify one another."},
        {"id": "company", "reason": "Repeat the baseline."},
        {"id": "invented", "reason": "Not a real tool."},
        {"id": "rate-engine", "reason": "Frame duration-sensitive valuation risk."},
        {"id": "rate-engine", "reason": "Duplicate."}
      ]
    }""")
    req = ai.ReportResearchPlanRequest(
        objective="Compare AAPL and MSFT risk",
        symbols=["AAPL", "MSFT"],
        baselineSourceIds=["company"],
        tools=[
            ai.ReportResearchToolIn(id="company", label="Company"),
            ai.ReportResearchToolIn(id="correlation", label="Correlation", producesVisuals=True),
            ai.ReportResearchToolIn(id="rate-engine", label="Rate Engine", producesVisuals=True),
        ],
    )
    result = ai.plan_report_research(req)
    assert result == {
        "summary": "Add visual dependence and rates evidence.",
        "additions": [
            {"id": "correlation", "reason": "Show whether the subjects diversify one another."},
            {"id": "rate-engine", "reason": "Frame duration-sensitive valuation risk."},
        ],
        "directives": {},
    }


def test_planner_directives_are_kept_only_for_known_tools():
    """Directives configure a tool instead of accepting its default view. They may
    target baseline tools as well as additions, but never an unknown id."""
    ai.groq_complete = staticmethod(lambda *a, **k: """{
      "summary": "Chart the pair with trend context.",
      "additions": [{"id": "correlation", "reason": "Show co-movement."}],
      "directives": {
        "company": "  pull the   latest quarter  ",
        "correlation": "use a 90 day rolling window",
        "invented": "should be dropped"
      }
    }""")
    req = ai.ReportResearchPlanRequest(
        objective="Compare AAPL and MSFT",
        symbols=["AAPL", "MSFT"],
        baselineSourceIds=["company"],
        tools=[
            ai.ReportResearchToolIn(id="company", label="Company"),
            ai.ReportResearchToolIn(id="correlation", label="Correlation"),
        ],
    )
    got = ai.plan_report_research(req)["directives"]
    assert got == {
        "company": "pull the latest quarter",          # whitespace collapsed
        "correlation": "use a 90 day rolling window",
    }


def test_report_title_uses_ai_headline_and_outline_fallback():
    req = ReportGenRequest(projectName="Untitled report", goal="Compare AAPL and MSFT", clips=[])
    assert ai._report_title({"headline": "AAPL Leads on Quality"}, None, req) == "AAPL Leads on Quality"
    assert ai._report_title({}, {"thesis": "MSFT offers the stronger risk adjusted profile over this horizon."}, req) == (
        "MSFT Offers the Stronger Risk Adjusted Profile over This Horizon"
    )


def test_report_appendix_omits_unused_and_explicit_chart_clips():
    clips = [
        ReportClipIn(id="used-chart", sourceTab="Chart", dataType="chart"),
        ReportClipIn(id="unused-chart", sourceTab="Chart", dataType="chart"),
        ReportClipIn(id="supporting-table", sourceTab="Peers", dataType="table"),
        ReportClipIn(id="unselected-kpi", sourceTab="Company", dataType="kpi"),
    ]
    assert _select_report_appendix_clip_ids(
        ["unused-chart", "supporting-table", "supporting-table"],
        clips,
        {"used-chart"},
    ) == ["supporting-table"]


def test_two_dcf_subjects_route_to_open_mode():
    clips = [
        _clip("1", "DCF Valuation", "DCF Verdict · AAPL", "Intrinsic / Share: $185.58, Market Price: $333.02"),
        _clip("2", "DCF Valuation", "DCF Verdict · NVDA", "Intrinsic / Share: $172.15, Market Price: $206.84"),
    ]
    req = ReportGenRequest(
        projectName="NVDA vs AAPL Valuation",
        purpose="Compare NVDA and AAPL on valuation and growth",
        goal="Determine which is the better value based on valuation and growth",
        clips=clips,
    )
    subjects = _ranked_subjects(req)
    assert {"AAPL", "NVDA"}.issubset(set(subjects))
    assert _report_mode(req, subjects) == "open"


def test_single_subject_price_target_goal_stays_range_mode():
    clips = [_clip("1", "DCF Valuation", "DCF Verdict · NVDA", "Intrinsic / Share: $172.15, Market Price: $206.84")]
    req = ReportGenRequest(
        projectName="NVDA Near-Term Outlook",
        purpose="Options desk daily briefing",
        goal="Estimate the near-term fair value range for NVDA",
        clips=clips,
    )
    subjects = _ranked_subjects(req)
    assert subjects == ["NVDA"]
    assert _report_mode(req, subjects) == "range"
    # Legacy single-subject resolver is unchanged by the refactor.
    assert _subject_ticker(req) == "NVDA"


def test_generic_single_company_research_uses_an_actionable_open_verdict():
    req = ReportGenRequest(
        projectName="JPMorgan Equity Research",
        purpose="Investment research",
        goal="Create an equity research report on JPMorgan",
        subjectTicker="JPM",
        clips=[_clip("1", "Corporate Hub", "JPM company snapshot", "Price: $349.50, ROE: 12%")],
    )

    subjects = _ranked_subjects(req)

    assert subjects[0] == "JPM"
    assert _subject_ticker(req) == "JPM"
    assert _report_mode(req, subjects) == "open"


def test_stale_explicit_subject_cannot_override_named_company():
    req = ReportGenRequest(
        projectName="JPMorgan Chase Equity Research Report",
        purpose="Investment research",
        goal="Create an equity research report on JPMorgan",
        subjectTicker="HBAN",
        clips=[_clip("1", "Corporate Hub", "HBAN company snapshot", "Price: $16.50, ROE: 10%")],
    )

    assert _subject_ticker(req) == "JPM"
    assert _ranked_subjects(req) == ["JPM", "HBAN"]


def test_generation_refuses_company_evidence_for_the_wrong_subject(monkeypatch):
    req = ReportGenRequest(
        projectName="JPMorgan Chase Equity Research Report",
        purpose="Investment research",
        goal="Create an equity research report on JPMorgan",
        subjectTicker="HBAN",
        clips=[
            _clip("1", "Corporate Hub", "HBAN company snapshot", "Price: $16.50, ROE: 10%"),
            _clip("2", "Peer Comparison", "Peer valuation · HBAN", "P/E: 12x"),
        ],
    )
    monkeypatch.setattr(
        ai,
        "_fetch_market_quote",
        lambda *_args, **_kwargs: pytest.fail("identity mismatch must fail before market lookup"),
    )

    with pytest.raises(ai.HTTPException) as exc:
        ai.generate_report(req)

    assert exc.value.status_code == 409
    assert "resolves to JPM" in exc.value.detail
    assert "evidence is for HBAN" in exc.value.detail


def test_comparison_language_forces_open_mode_even_with_one_scored_subject():
    clips = [_clip("1", "Company Profile", "AAPL · Snapshot", "Price $333.02, P/E 40.3")]
    req = ReportGenRequest(
        projectName="Sector Pick",
        purpose="Screen review",
        goal="Which is the better buy right now, AAPL versus its semiconductor peers",
        clips=clips,
    )
    subjects = _ranked_subjects(req)
    assert _report_mode(req, subjects) == "open"


def test_normalize_key_result_open_mode_preserves_model_verdict_verbatim():
    kr = {"label": "Relative Pick", "value": "NVDA over AAPL on growth-adjusted value", "context": ""}
    out = _normalize_key_result(
        kr, subject="AAPL", market=333.02, change_pct=0.4,
        subject_dcf=True, dcf_intrinsic=185.58,
        stance={"lean": "bullish", "thesis": "NVDA offers superior growth at a comparable multiple"},
        signal_digest={}, force_range=False,
    )
    assert out["value"] == "NVDA over AAPL on growth-adjusted value"
    assert "$" not in out["value"]


def test_normalize_key_result_open_mode_falls_back_to_thesis_not_a_price_range():
    out = _normalize_key_result(
        None, subject="AAPL", market=333.02, change_pct=0.4,
        subject_dcf=True, dcf_intrinsic=185.58,
        stance={"lean": "bullish", "thesis": "NVDA offers superior growth at a comparable multiple"},
        signal_digest={}, force_range=False,
    )
    assert out["value"] == "NVDA offers superior growth at a comparable multiple"


def test_normalize_key_result_open_mode_rejects_bare_ticker_as_a_verdict():
    # A lone ticker/name is not a verdict — it has no action or comparison to it.
    kr = {"label": "Verdict", "value": "NVDA", "context": ""}
    out = _normalize_key_result(
        kr, subject="AAPL", market=333.02, change_pct=0.4,
        subject_dcf=True, dcf_intrinsic=185.58,
        stance={"lean": "bullish", "thesis": "NVDA offers superior growth at a comparable multiple"},
        signal_digest={}, force_range=False,
    )
    assert out["value"] != "NVDA"
    assert out["value"] == "NVDA offers superior growth at a comparable multiple"

    # Same bare ticker with no thesis to fall back on still gets an action word.
    out2 = _normalize_key_result(
        kr, subject="AAPL", market=333.02, change_pct=0.4,
        subject_dcf=True, dcf_intrinsic=185.58,
        stance={"lean": "bullish"}, signal_digest={}, force_range=False,
    )
    assert out2["value"] == "Favor NVDA"

    # A real verdict phrase naming the same ticker passes through untouched.
    out3 = _normalize_key_result(
        {"label": "Verdict", "value": "Buy NVDA", "context": ""}, subject="AAPL", market=333.02,
        change_pct=0.4, subject_dcf=True, dcf_intrinsic=185.58,
        stance={"lean": "bullish"}, signal_digest={}, force_range=False,
    )
    assert out3["value"] == "Buy NVDA"


def test_normalize_key_result_range_mode_unchanged_behavior():
    out = _normalize_key_result(
        None, subject="AAPL", market=333.02, change_pct=0.4,
        subject_dcf=True, dcf_intrinsic=185.58,
        stance={"lean": "bearish"}, signal_digest={}, force_range=True,
    )
    assert out["value"].startswith("$")
    assert "–" in out["value"]


def test_length_key_defaults_to_medium_for_unknown_values():
    assert _length_key("short") == "short"
    assert _length_key("long") == "long"
    assert _length_key("medium") == "medium"
    assert _length_key("") == "medium"
    assert _length_key(None) == "medium"
    assert _length_key("gigantic") == "medium"


def test_outline_targets_three_pages_but_keeps_material_evidence(monkeypatch):
    sections = [
        {"heading": f"Section {index}", "argues": f"Evidence {index}", "chartHint": "none"}
        for index in range(12)
    ]
    response = SimpleNamespace(
        choices=[SimpleNamespace(message=SimpleNamespace(content=json.dumps({
            "thesis": "Use every material piece of evidence.",
            "sections": sections,
        })))],
    )
    captured = {}

    def fake_chat(messages, **_kwargs):
        captured["system"] = messages[0]["content"]
        return response

    monkeypatch.setattr(ai, "groq_chat", fake_chat)

    long_outline = ai._generate_outline({"reportLength": "long"})
    short_outline = ai._generate_outline({"reportLength": "short"})

    assert long_outline is not None
    assert short_outline is not None
    assert len(long_outline["sections"]) == 8
    assert len(short_outline["sections"]) == 2
    assert "Target a compact two-to-three-page decision note" in captured["system"]
    assert "Continue beyond three pages only when material evidence" in captured["system"]


def test_clean_chart_accepts_valid_comparison_bar_chart():
    raw = {
        "chartType": "bar", "title": "Growth vs Margin", "xKey": "metric",
        "data": [
            {"metric": "Rev Growth", "NVDA": 85.2, "AAPL": "16.6%"},
            {"metric": "Gross Margin", "NVDA": "74.1%", "AAPL": 47.9},
        ],
        "series": [{"key": "NVDA", "label": "NVDA"}, {"key": "AAPL", "label": "AAPL"}],
    }
    out = _clean_chart(raw)
    assert out["kind"] == "chart"
    assert out["chartType"] == "bar"
    assert out["data"][0]["AAPL"] == 16.6
    assert out["data"][1]["NVDA"] == 74.1


def test_clean_chart_rejects_malformed_or_sparse_input():
    assert _clean_chart(None) is None
    assert _clean_chart({}) is None
    assert _clean_chart({"chartType": "pie", "xKey": "m", "data": [], "series": []}) is None
    # single data point is not a comparison worth charting
    assert _clean_chart({
        "chartType": "bar", "xKey": "m",
        "data": [{"m": "a", "x": 1}],
        "series": [{"key": "x"}],
    }) is None
    # no numeric values resolve for the declared series -> nothing to plot
    assert _clean_chart({
        "chartType": "bar", "xKey": "m",
        "data": [{"m": "a", "x": "n/a"}, {"m": "b", "x": "also not a number"}],
        "series": [{"key": "x"}],
    }) is None


def test_clean_chart_pie_caps_to_one_series():
    out = _clean_chart({
        "chartType": "pie", "xKey": "segment",
        "data": [{"segment": "Compute", "share": 75.2}, {"segment": "Gaming", "share": 7.4}],
        "series": [{"key": "share", "label": "Share %"}, {"key": "extra", "label": "Ignored"}],
    })
    assert len(out["series"]) == 1
    assert out["series"][0]["key"] == "share"


def test_clean_chart_scatter_requires_numeric_x_and_keeps_point_label():
    out = _clean_chart({
        "chartType": "scatter", "xKey": "pe",
        "data": [
            {"pe": 31.6, "growth": 85.2, "label": "NVDA"},
            {"pe": "n/a", "growth": 47.9, "label": "AVGO"},  # non-numeric x -> dropped
            {"pe": 40.3, "growth": "16.6", "label": "AAPL"},
        ],
        "series": [{"key": "growth", "label": "Rev Growth %"}],
    })
    assert len(out["data"]) == 2
    assert out["data"][0]["label"] == "NVDA"
    assert out["data"][1]["growth"] == 16.6


def test_clean_chart_range_takes_a_low_high_tuple_per_series():
    out = _clean_chart({
        "chartType": "range", "xKey": "driver",
        "data": [
            {"driver": "WACC", "NVDA": [148.27, 203.29], "AAPL": [138.69, 277.87]},
            {"driver": "Tax rate", "NVDA": "not a tuple", "AAPL": [178.78, 192.38]},  # NVDA dropped for this row
            {"driver": "Terminal growth", "NVDA": [180.05, 165.44], "AAPL": [162.63, 221.28]},  # NVDA swapped -> normalized
        ],
        "series": [{"key": "NVDA", "label": "NVDA $/sh swing"}, {"key": "AAPL", "label": "AAPL $/sh swing"}],
    })
    assert len(out["data"]) == 3
    assert out["data"][0]["NVDA"] == [148.27, 203.29]
    assert "NVDA" not in out["data"][1]
    assert out["data"][1]["AAPL"] == [178.78, 192.38]
    assert out["data"][2]["NVDA"] == [165.44, 180.05]


def test_clean_chart_rejects_hand_rolled_range_disguised_as_bar():
    # A near-certain sign the model tried to fake a range chart with a plain
    # "bar" chart and series literally named "<x>_low"/"<x>_high" — the raw
    # field name would leak into the legend, so drop it outright.
    out = _clean_chart({
        "chartType": "bar", "xKey": "driver",
        "data": [
            {"driver": "WACC", "NVDA_low": 148.27, "NVDA_high": 203.29},
            {"driver": "Tax rate", "NVDA_low": 178.78, "NVDA_high": 192.38},
        ],
        "series": [{"key": "NVDA_low", "label": "NVDA_low"}, {"key": "NVDA_high", "label": "NVDA $/sh"}],
    })
    assert out is None


def test_must_include_section_empty_when_blank():
    assert _must_include_section("") == ""
    assert _must_include_section(None) == ""
    assert _must_include_section("   \n  ") == ""


def test_must_include_section_lists_every_non_blank_line():
    block = _must_include_section("PEG ratio comparison chart\n\nstate the analyst price target explicitly")
    assert "MUST INCLUDE" in block
    assert "- PEG ratio comparison chart" in block
    assert "- state the analyst price target explicitly" in block


def _bar_chart(title, cat_a="Gross Margin", cat_b="Net Margin"):
    return {
        "chartType": "bar", "title": title, "xKey": "metric",
        "data": [{"metric": cat_a, "NVDA": 74.1}, {"metric": cat_b, "NVDA": 63.0}],
        "series": [{"key": "NVDA", "label": "NVDA"}],
    }


def test_build_sections_drops_a_chart_that_repeats_an_earlier_section_verbatim():
    # The model built the exact same "Margin Comparison" chart independently
    # for two different sections (same categories, same series) — the
    # duplicate must be dropped, not shown twice in the printed report.
    valid_ids = {"k1", "k2"}
    raw = [
        {"clipId": "k1", "heading": "Growth Momentum", "analysis": "NVDA outgrows AAPL.",
         "chart": _bar_chart("Margin Comparison")},
        {"clipId": "k2", "heading": "Profitability Edge", "analysis": "NVDA margins lead.",
         "chart": _bar_chart("Margin Comparison")},
    ]
    sections = _build_sections(raw, valid_ids)
    assert sections[0]["chart"] is not None
    assert sections[1]["chart"] is None


def test_build_sections_keeps_charts_that_are_genuinely_different():
    valid_ids = {"k1", "k2"}
    raw = [
        {"clipId": "k1", "heading": "Margins", "analysis": "NVDA margins lead.",
         "chart": _bar_chart("Margin Comparison", "Gross Margin", "Net Margin")},
        {"clipId": "k2", "heading": "Valuation Gap", "analysis": "NVDA trades closer to fair value.",
         "chart": _bar_chart("Valuation Gap", "Intrinsic", "Market Price")},
    ]
    sections = _build_sections(raw, valid_ids)
    assert sections[0]["chart"] is not None
    assert sections[1]["chart"] is not None


def test_build_sections_skips_sections_with_no_analysis_or_unknown_clip_id():
    raw = [
        {"clipId": "k1", "heading": "No analysis", "analysis": "  "},
        {"clipId": "not-a-real-clip", "heading": "Unknown clip", "analysis": "some text"},
    ]
    assert _build_sections(raw, {"k1"}) == []


def test_build_sections_keeps_only_simple_ai_design_intents():
    sections = _build_sections([
        {
            "clipId": "k1",
            "heading": "Compact comparison",
            "analysis": "A small comparison can sit beside the interpretation.",
            "design": "compact",
        },
        {
            "clipId": "k2",
            "heading": "Evidence first",
            "analysis": "A supported metric rail can lead the interpretation.",
            "design": "visual",
        },
        {
            "clipId": "k3",
            "heading": "Unknown intent",
            "analysis": "An invented intent must not reach the layout engine.",
            "design": "cinematic",
        },
    ], {"k1", "k2", "k3"})
    assert sections[0]["design"] == "compact"
    assert sections[1]["design"] == "visual"
    assert "design" not in sections[2]
    assert all("layout" not in section for section in sections)


def test_layout_architecture_uses_real_evidence_then_removes_ai_intent():
    clips = [
        ReportClipIn(id="visual", dataType="chart", title="Peer Comparison"),
        ReportClipIn(id="narrative", dataType="kpi", title="Operating Metrics"),
        ReportClipIn(id="compact-a", dataType="kpi", title="Supporting Metrics"),
        ReportClipIn(id="compact-b", dataType="kpi", title="Secondary Metrics"),
        ReportClipIn(id="dense", dataType="table", title="Sensitivity Grid"),
    ]
    sections = [
        {
            "clipId": "visual", "heading": "Evidence", "analysis": "The comparison decides the call.",
            "keyFigures": [{"label": "Lead", "value": "12%"}, {"label": "Gap", "value": "4 pp"}],
            "chart": None, "design": "visual",
        },
        {
            "clipId": "narrative", "heading": "Interpretation", "analysis": "The mechanism matters.",
            "keyFigures": [{"label": "Margin", "value": "20%"}, {"label": "Growth", "value": "15%"}],
            "chart": None, "design": "narrative",
        },
        {
            "clipId": "compact-a", "heading": "Support A", "analysis": "Compact support.",
            "keyFigures": [{"label": "Beta", "value": "0.8"}, {"label": "Vol", "value": "16%"}],
            "chart": None, "design": "compact",
        },
        {
            "clipId": "compact-b", "heading": "Support B", "analysis": "More compact support.",
            "keyFigures": [{"label": "ROE", "value": "18%"}, {"label": "P/E", "value": "22x"}],
            "chart": None, "design": "compact",
        },
        {
            "clipId": "dense", "heading": "Sensitivity", "analysis": "The grid needs label room.",
            "keyFigures": [{"label": "Low", "value": "$80"}],
            "chart": None, "design": "compact",
        },
    ]

    _apply_section_layout_architecture(sections, clips)

    assert [section["layout"] for section in sections] == [
        "visual-left",
        "wrap-left",
        "wrap-right",
        "wrap-left",
        "full-width",
    ]
    assert [section.get("placement") for section in sections] == [
        None, "half", "half", None, None,
    ]
    assert all("design" not in section for section in sections)


def test_layout_architecture_varies_repeated_ai_intents():
    clips = [
        ReportClipIn(id="a", dataType="chart", title="Growth Comparison"),
        ReportClipIn(id="b", dataType="chart", title="Margin Comparison"),
    ]
    sections = [
        {
            "clipId": clip.id, "heading": clip.title, "analysis": "The evidence supports the thesis.",
            "keyFigures": [{"label": "Lead", "value": "12%"}, {"label": "Gap", "value": "4 pp"}],
            "chart": None, "design": "visual",
        }
        for clip in clips
    ]

    _apply_section_layout_architecture(sections, clips)

    assert [section["layout"] for section in sections] == ["visual-left", "visual-right"]


def test_layout_architecture_infers_a_safe_design_when_llama_omits_it():
    clip = ReportClipIn(id="kpi", dataType="kpi", title="Quality Metrics")
    section = {
        "clipId": "kpi", "heading": "Quality", "analysis": "Quality supports the thesis.",
        "keyFigures": [{"label": "ROE", "value": "18%"}, {"label": "Margin", "value": "24%"}],
        "chart": None,
    }

    _apply_section_layout_architecture([section], [clip])

    assert section["layout"] == "visual-right"


def test_report_prompt_hides_renderer_presets_and_includes_only_the_active_mode():
    range_prompt = _report_system_prompt("range", "short", "")
    open_prompt = _report_system_prompt("open", "short", "")

    assert '"design": "visual | narrative | balanced | compact"' in range_prompt
    assert "metric-rail" not in range_prompt
    assert "visual-left" not in range_prompt
    assert "price call on ONE equity" in range_prompt
    assert "comparison, screen, ranking" not in range_prompt
    assert "the midpoint as '$X'" in range_prompt
    assert "favored ticker/name" not in range_prompt
    assert "comparison, screen, ranking" in open_prompt
    assert "price call on ONE equity" not in open_prompt
    assert "favored ticker/name" in open_prompt
    assert "the midpoint as '$X'" not in open_prompt
    assert "The headline states the conclusion and the tension" in range_prompt
    assert "Section headings are conclusions, not topics" in range_prompt
    assert "{{" not in range_prompt
    assert "{{" not in open_prompt


def test_numeric_provenance_removes_an_unsupported_peer_multiple_sentence():
    clips = [
        _clip(
            "profile",
            "Company Profile",
            "ULTA Snapshot",
            "P/E: 19.0x, Revenue Growth (TTM): 11.1%, Current Price: $507.23",
        ),
    ]
    slot_ctx = _build_report_slot_ctx(clips, "ULTA", "Ulta Beauty", 507.23, None)
    text = (
        "ULTA trades at 19.0x P/E, below a sector average of roughly 25x. "
        "Revenue growth of 11.1% supports the thesis."
    )

    assert _remove_unverified_numeric_sentences(text, clips, slot_ctx) == (
        "Revenue growth of 11.1% supports the thesis."
    )


def test_numeric_provenance_keeps_horizons_rounding_and_filters_key_figures():
    clips = [_clip("profile", "Company Profile", "ULTA Snapshot", "Price: $507.23, ROE: 47.4%")]
    slot_ctx = _build_report_slot_ctx(clips, "ULTA", "Ulta Beauty", 507.23, None)
    text = "Over the next 90 days, spot near $507 and ROE near 47% support the call."
    sections = [{
        "keyFigures": [
            {"label": "Spot", "value": "$507.23"},
            {"label": "Peer median", "value": "25x"},
        ],
    }]

    assert _remove_unverified_numeric_sentences(text, clips, slot_ctx) == text
    _filter_unverified_key_figures(sections, clips, slot_ctx)
    assert sections[0]["keyFigures"] == [{"label": "Spot", "value": "$507.23"}]


def _sensitivity_clip(id_, ticker, rows):
    header = "Columns: Driver | Range | Low $/sh | High $/sh | Swing $/sh"
    body = "\n".join(
        f"{drv} | {lo}-{hi}% | ${lo_sh} | ${hi_sh} | ${hi_sh - lo_sh:.2f}"
        for drv, lo, hi, lo_sh, hi_sh in rows
    )
    return ReportClipIn(
        id=id_, sourceTab="DCF Valuation", dataType="table",
        title=f"Value Drivers — one-way sensitivity · {ticker}",
        dataSummary=f"{header}\n{body}", userDescription="",
    )


def _segments_clip(id_, kind, rows):
    header = "Columns: Segment | Value | Share % | YoY %" if kind == "Product" else "Columns: Region | Value | Share % | YoY %"
    body = "\n".join(f"{name} | {value} | {share} | " for name, value, share in rows)
    return ReportClipIn(
        id=id_, sourceTab="Company Profile", dataType="table",
        title=f"{kind} Segments", dataSummary=f"{header}\n{body}", userDescription="",
    )


def test_parse_table_summary_roundtrips_the_report_capture_format():
    clip = _sensitivity_clip("s1", "NVDA", [("WACC", 13.3, 16.3, 148.27, 203.29)])
    parsed = _parse_table_summary(clip.dataSummary)
    assert parsed is not None
    columns, rows = parsed
    assert columns == ["Driver", "Range", "Low $/sh", "High $/sh", "Swing $/sh"]
    assert rows[0][0] == "WACC"
    assert _parse_table_summary("not a table dump") is None


def test_mechanical_sensitivity_chart_merges_two_subjects_by_driver():
    nvda = _sensitivity_clip("s-nvda", "NVDA", [
        ("WACC", 13.3, 16.3, 148.27, 203.29),
        ("Yr 1 growth", 31.0, 39.0, 158.00, 187.15),
    ])
    aapl = _sensitivity_clip("s-aapl", "AAPL", [
        ("WACC", 5.6, 8.6, 138.69, 277.87),
        ("Terminal growth", 1.5, 3.5, 162.63, 221.28),
    ])
    chart = _mechanical_sensitivity_chart([nvda, aapl])
    assert chart["chartType"] == "range"
    assert {s["key"] for s in chart["series"]} == {"NVDA", "AAPL"}
    wacc_row = next(r for r in chart["data"] if r["driver"] == "WACC")
    assert wacc_row["NVDA"] == [148.27, 203.29]
    assert wacc_row["AAPL"] == [138.69, 277.87]
    # a driver only present for one subject still appears, just without the other's bar
    growth_row = next(r for r in chart["data"] if r["driver"] == "Yr 1 growth")
    assert "AAPL" not in growth_row


def test_mechanical_sensitivity_chart_none_when_no_matching_clips():
    unrelated = ReportClipIn(id="x", sourceTab="Company Profile", dataType="kpi",
                              title="Snapshot", dataSummary="Price: $100", userDescription="")
    assert _mechanical_sensitivity_chart([unrelated]) is None


def test_mechanical_segments_pie_reads_share_column():
    clip = _segments_clip("seg1", "Product", [("Compute", 162361000000, 75.2), ("Gaming", 16042000000, 7.4)])
    pie = _mechanical_segments_pie(clip)
    assert pie["chartType"] == "pie"
    assert pie["data"] == [{"segment": "Compute", "share": 75.2}, {"segment": "Gaming", "share": 7.4}]


def test_mechanical_segments_pie_none_for_unrelated_table():
    clip = ReportClipIn(id="t1", sourceTab="Peer Comparison", dataType="table", title="All Metrics",
                         dataSummary="Columns: Ticker | P/E\nNVDA | 31.6", userDescription="")
    assert _mechanical_segments_pie(clip) is None


def test_auto_must_include_names_every_subject_with_sensitivity_data():
    nvda = _sensitivity_clip("s-nvda", "NVDA", [("WACC", 13.3, 16.3, 148.27, 203.29)])
    aapl = _sensitivity_clip("s-aapl", "AAPL", [("WACC", 5.6, 8.6, 138.69, 277.87)])
    directives = _auto_must_include([nvda, aapl])
    # First directive is the sensitivity-section instruction naming both subjects;
    # it tells the model to write the section but NOT build a chart (the site does).
    assert "AAPL" in directives[0] and "NVDA" in directives[0]
    assert "sensitivity" in directives[0].lower()
    assert "chart is added automatically" in directives[0]


def test_auto_must_include_empty_when_no_sensitivity_clips():
    unrelated = ReportClipIn(id="x", sourceTab="Company Profile", dataType="kpi",
                              title="Snapshot", dataSummary="Price: $100", userDescription="")
    assert _auto_must_include([unrelated]) == []


def test_auto_must_include_enforces_company_and_bank_research_coverage():
    clips = [
        _clip("1", "Corporate Hub", "JPM Financials and Estimates", "Revenue: $182B"),
        _clip("2", "Corporate Hub", "JPM Revenue Activity History", "Net Interest Income: $95B"),
        _clip("3", "FDIC", "Bank Profitability and Credit Context · JPM", "NIM: 2.6%"),
        _clip("4", "Peer Comparison", "Peer Valuation · JPM", "P/E: 15.0x"),
        _clip("5", "Corporate Hub", "Analyst View · JPM", "Mean target: $372"),
        _clip("6", "Mover Radar", "Recent News · JPM", "Headline: Big Banks Deliver Strong Q2"),
    ]

    directives = " ".join(_auto_must_include(clips))

    assert "financial-trajectory section" in directives
    assert "This is bank research" in directives
    assert "dedicated valuation section" in directives
    assert "Separate catalysts from risks" in directives
    assert "options-implied move" in directives


def test_inject_mechanical_charts_overrides_a_bar_chart_on_the_sensitivity_section():
    nvda = _sensitivity_clip("s-nvda", "NVDA", [
        ("WACC", 13.3, 16.3, 148.27, 203.29), ("Yr 1 growth", 31.0, 39.0, 158.00, 187.15),
    ])
    aapl = _sensitivity_clip("s-aapl", "AAPL", [
        ("WACC", 5.6, 8.6, 138.69, 277.87), ("Yr 1 growth", 2.4, 10.4, 165.81, 206.85),
    ])
    # The model attached a plain bar chart instead of a range chart — this is
    # exactly the observed failure mode this mechanism exists to backstop.
    sections = [{
        "clipId": "s-nvda", "heading": "DCF Sensitivity Drivers", "analysis": "text",
        "keyFigures": [], "chart": {
            "kind": "chart", "chartType": "bar", "title": "WACC Sensitivity", "xKey": "driver",
            "data": [{"driver": "WACC", "NVDA": 55.02}, {"driver": "AAPL WACC", "AAPL": 139.18}],
            "series": [{"key": "NVDA", "label": "NVDA"}, {"key": "AAPL", "label": "AAPL"}],
        },
    }]
    _inject_mechanical_charts(sections, [nvda, aapl])
    assert sections[0]["chart"]["chartType"] == "range"
    assert {s["key"] for s in sections[0]["chart"]["series"]} == {"NVDA", "AAPL"}


def test_inject_mechanical_charts_only_injects_once_even_if_multiple_sections_qualify():
    nvda = _sensitivity_clip("s-nvda", "NVDA", [
        ("WACC", 13.3, 16.3, 148.27, 203.29), ("Yr 1 growth", 31.0, 39.0, 158.00, 187.15),
    ])
    aapl = _sensitivity_clip("s-aapl", "AAPL", [
        ("WACC", 5.6, 8.6, 138.69, 277.87), ("Yr 1 growth", 2.4, 10.4, 165.81, 206.85),
    ])
    sections = [
        {"clipId": "s-nvda", "heading": "NVDA Sensitivity", "analysis": "a", "keyFigures": [], "chart": None},
        {"clipId": "s-aapl", "heading": "AAPL Sensitivity", "analysis": "b", "keyFigures": [], "chart": None},
    ]
    _inject_mechanical_charts(sections, [nvda, aapl])
    charted = [s for s in sections if s["chart"] is not None]
    assert len(charted) == 1


def test_must_include_section_merges_user_text_and_auto_directives():
    block = _must_include_section("state the analyst target explicitly", ["auto-detected directive"])
    assert "- state the analyst target explicitly" in block
    assert "- auto-detected directive" in block


# ── Deterministic chart layer (the fix for chart monotony under a weak model) ──

def _kpi(id_, title, summary):
    return ReportClipIn(id=id_, sourceTab="Company Profile", dataType="kpi",
                        title=title, dataSummary=summary, userDescription="")


def test_clip_ticker_reads_prefix_and_suffix_positions():
    assert _clip_ticker(_kpi("a", "NVDA · Profitability", "")) == "NVDA"
    assert _clip_ticker(_kpi("b", "DCF Verdict · AAPL", "")) == "AAPL"
    assert _clip_ticker(_kpi("c", "Product Segments", "")) is None


def test_first_number_tolerates_currency_percent_and_unicode_minus():
    assert _first_number("$333.02") == 333.02
    assert _first_number("74.1%") == 74.1
    assert _first_number("−16.8% (Overvalued)") == -16.8
    assert _first_number("—") is None


def test_parse_kpi_summary_splits_label_value_pairs():
    kv = _parse_kpi_summary("Gross Margin: 74.1%; Net Margin: 63.0%; ROE: 114.3%")
    assert kv == {"Gross Margin": "74.1%", "Net Margin": "63.0%", "ROE": "114.3%"}


def test_all_kpis_by_ticker_merges_multiple_clips_per_company():
    clips = [
        _kpi("nvda-snap", "NVDA · Snapshot", "P/E: 31.6; Rev Growth: 85.2%"),
        _kpi("nvda-prof", "NVDA · Profitability", "Gross Margin: 74.1%; Net Margin: 63.0%"),
        _kpi("aapl-snap", "AAPL · Snapshot", "P/E: 40.3; Rev Growth: 16.6%"),
    ]
    by_t = _all_kpis_by_ticker(clips)
    assert set(by_t) == {"NVDA", "AAPL"}
    assert by_t["NVDA"]["Gross Margin"] == "74.1%"
    assert by_t["NVDA"]["Rev Growth"] == "85.2%"


def test_grouped_kpi_chart_builds_metric_by_metric_bar_across_companies():
    by_t = {
        "NVDA": {"Gross Margin": "74.1%", "Net Margin": "63.0%"},
        "AAPL": {"Gross Margin": "47.9%", "Net Margin": "27.2%"},
    }
    chart = _grouped_kpi_chart(by_t, [("Gross Margin", "Gross Margin"), ("Net Margin", "Net Margin")], "Margins")
    assert chart["chartType"] == "bar"
    assert {s["key"] for s in chart["series"]} == {"NVDA", "AAPL"}
    gm = next(r for r in chart["data"] if r["metric"] == "Gross Margin")
    assert gm["NVDA"] == 74.1 and gm["AAPL"] == 47.9


def test_grouped_kpi_chart_needs_two_metrics_present_for_two_companies():
    # Only one metric resolves for both companies -> not enough for a chart.
    by_t = {"NVDA": {"P/E": "31.6"}, "AAPL": {"P/E": "40.3", "ROE": "141.5%"}}
    assert _grouped_kpi_chart(by_t, [("P/E", "P/E"), ("ROE", "ROE")], "x") is None


def test_valuation_gap_chart_pairs_intrinsic_and_market():
    by_t = {
        "NVDA": {"Intrinsic / Share": "$172.15", "Market Price": "$206.84"},
        "AAPL": {"Intrinsic / Share": "$185.58", "Market Price": "$333.02"},
    }
    chart = _valuation_gap_chart(by_t)
    assert chart["chartType"] == "bar"
    assert {s["key"] for s in chart["series"]} == {"intrinsic", "market"}
    nvda = next(r for r in chart["data"] if r["name"] == "NVDA")
    assert nvda["intrinsic"] == 172.15 and nvda["market"] == 206.84


def _full_nvda_aapl_clips():
    return [
        _kpi("nvda-snap", "NVDA · Snapshot", "P/E: 31.6; Rev Growth: 85.2%"),
        _kpi("nvda-prof", "NVDA · Profitability", "Gross Margin: 74.1%; Operating Margin: 65.6%; Net Margin: 63.0%; ROE: 114.3%; ROA: 52.7%"),
        _kpi("aapl-snap", "AAPL · Snapshot", "P/E: 40.3; Rev Growth: 16.6%"),
        _kpi("aapl-prof", "AAPL · Profitability", "Gross Margin: 47.9%; Operating Margin: 32.3%; Net Margin: 27.2%; ROE: 141.5%; ROA: 26.2%"),
        _kpi("nvda-dcf", "DCF Verdict · NVDA", "Intrinsic / Share: $172.15; Market Price: $206.84; Upside: −16.8%"),
        _kpi("aapl-dcf", "DCF Verdict · AAPL", "Intrinsic / Share: $185.58; Market Price: $333.02; Upside: −44.3%"),
        _sensitivity_clip("nvda-sens", "NVDA", [("WACC", 13.3, 16.3, 148.27, 203.29), ("Yr 1 growth", 31.0, 39.0, 158.00, 187.15)]),
        _sensitivity_clip("aapl-sens", "AAPL", [("WACC", 5.6, 8.6, 138.69, 277.87), ("Yr 1 growth", 2.4, 10.4, 165.81, 206.85)]),
        _segments_clip("nvda-seg", "Product", [("Compute", 162361000000, 75.2), ("Networking", 31376000000, 14.5), ("Gaming", 16042000000, 7.4)]),
    ]


def test_mechanical_chart_pool_produces_varied_chart_types():
    pool = _mechanical_chart_pool(_full_nvda_aapl_clips())
    types = {chart["chartType"] for chart, _kw, _prio in pool}
    # The whole point: the pool is not all bars — it spans several types.
    assert "range" in types
    assert "pie" in types
    assert "bar" in types
    assert len(types) >= 3


def test_inject_mechanical_charts_gives_each_section_its_matching_chart_type():
    clips = _full_nvda_aapl_clips()
    sections = [
        {"clipId": "nvda-prof", "heading": "Growth and Margin Edge",
         "analysis": "NVDA revenue growth and gross margin lead", "keyFigures": [],
         "chart": {"kind": "chart", "chartType": "line", "title": "junk", "xKey": "x",
                   "data": [{"x": "a", "y": 1}, {"x": "b", "y": 2}], "series": [{"key": "y", "label": "y"}]}},
        {"clipId": "aapl-dcf", "heading": "Valuation Gap",
         "analysis": "Apple trades at a premium to intrinsic value", "keyFigures": [], "chart": None},
        {"clipId": "nvda-sens", "heading": "DCF One-Way Sensitivity Swing",
         "analysis": "NVDA WACC swing is tighter than Apple's", "keyFigures": [], "chart": None},
        {"clipId": "nvda-seg", "heading": "Revenue Composition",
         "analysis": "NVDA revenue by segment mix", "keyFigures": [], "chart": None},
    ]
    _inject_mechanical_charts(sections, clips)
    by_heading = {s["heading"]: s["chart"]["chartType"] for s in sections}
    assert by_heading["Growth and Margin Edge"] == "bar"   # junk line chart overridden
    assert by_heading["Valuation Gap"] == "bar"
    assert by_heading["DCF One-Way Sensitivity Swing"] == "range"
    assert by_heading["Revenue Composition"] == "pie"


def test_inject_mechanical_charts_never_reuses_the_same_chart_on_two_sections():
    clips = _full_nvda_aapl_clips()
    sections = [
        {"clipId": "nvda-sens", "heading": "NVDA Sensitivity", "analysis": "wacc swing driver", "keyFigures": [], "chart": None},
        {"clipId": "aapl-sens", "heading": "AAPL Sensitivity", "analysis": "wacc swing driver", "keyFigures": [], "chart": None},
    ]
    _inject_mechanical_charts(sections, clips)
    charted = [s["chart"] for s in sections if s["chart"]]
    # both sections score for the single sensitivity chart, but it is used once
    assert sum(1 for c in charted if c and c["chartType"] == "range") == 1


def test_inject_mechanical_charts_discards_the_model_chart_on_unmatched_sections():
    # The site owns all charts now: a section that matches no site-built chart
    # renders as prose + key figures, and any chart the model tried to emit is
    # thrown away rather than shown.
    clips = _full_nvda_aapl_clips()
    model_chart = {"kind": "chart", "chartType": "line", "title": "model chart", "xKey": "x",
                   "data": [{"x": "a", "v": 1}, {"x": "b", "v": 2}], "series": [{"key": "v", "label": "v"}]}
    sections = [{"clipId": "nvda-snap", "heading": "Company Background",
                 "analysis": "NVDA operates data center infrastructure worldwide", "keyFigures": [],
                 "chart": dict(model_chart)}]
    _inject_mechanical_charts(sections, clips)
    assert sections[0]["chart"] is None


def _all_metrics_clip(id_, ticker, company_pe, median_pe):
    header = "Columns: Ticker | Name | P/E | EV/EBITDA | P/S | P/B | P/FCF | ROE | Rev Growth"
    body = (f"Median | — | {median_pe}x | 30.0x | 16.4x | 10.3x | 76.8x | 35.2% | 37.2%\n"
            f"{ticker} | {ticker} Inc | {company_pe}x | 30.0x | 19.8x | 25.6x | 108.1x | 114.3% | 85.2%")
    return ReportClipIn(id=id_, sourceTab="Peer Comparison", dataType="table",
                        title=f"All Metrics · {ticker}", dataSummary=f"{header}\n{body}", userDescription="")


def _consensus_clip(id_, ticker, upside):
    header = "Columns: Ticker | Rec | Analysts | Target | Upside"
    body = f"{ticker} | Strong Buy | 58 | $303 | {upside}"
    return ReportClipIn(id=id_, sourceTab="Peer Comparison", dataType="table",
                        title=f"Analyst Consensus · {ticker}", dataSummary=f"{header}\n{body}", userDescription="")


def test_peer_pe_median_chart_reads_company_and_median_rows():
    from routers.ai import _peer_pe_median_chart
    clips = [_all_metrics_clip("m1", "NVDA", 31.6, 48.9), _all_metrics_clip("m2", "AAPL", 40.3, 34.8)]
    chart = _peer_pe_median_chart(clips)
    assert chart["chartType"] == "bar"
    nvda = next(r for r in chart["data"] if r["name"] == "NVDA")
    assert nvda["company"] == 31.6 and nvda["median"] == 48.9


def test_analyst_upside_chart_is_a_bar_of_each_subjects_upside():
    from routers.ai import _analyst_upside_chart
    clips = [_consensus_clip("c1", "NVDA", "+46.4%"), _consensus_clip("c2", "AAPL", "-4.3%")]
    chart = _analyst_upside_chart(clips)
    # A bar (straddling zero) reads cleaner than a 2-point dot plot.
    assert chart["chartType"] == "bar"
    ups = {r["name"]: r["upside"] for r in chart["data"]}
    assert ups["NVDA"] == 46.4 and ups["AAPL"] == -4.3


def test_full_report_body_gets_distinct_chart_types_not_all_bars():
    # End-to-end: the exact clip families of the NVDA-vs-AAPL report, assigned
    # to its actual section headings, must span several chart types (range + pie
    # + bar) — the core guarantee that the report is not wall-to-wall bars/lines.
    clips = _full_nvda_aapl_clips() + [
        _all_metrics_clip("m1", "NVDA", 31.6, 48.9), _all_metrics_clip("m2", "AAPL", 40.3, 34.8),
        _consensus_clip("c1", "NVDA", "+46.4%"), _consensus_clip("c2", "AAPL", "-4.3%"),
    ]
    sections = [
        {"clipId": "x", "heading": "DCF Sensitivity Comparison", "analysis": "wide swing in intrinsic value as WACC changes", "keyFigures": [], "chart": None},
        {"clipId": "x", "heading": "Valuation Gap & Analyst Upside", "analysis": "NVDA analyst upside vs Apple consensus rating", "keyFigures": [], "chart": None},
        {"clipId": "x", "heading": "Profitability Edge", "analysis": "gross margin and net margin lead", "keyFigures": [], "chart": None},
        {"clipId": "x", "heading": "Peer Relative Valuation", "analysis": "trades at a discount to the sector median", "keyFigures": [], "chart": None},
        {"clipId": "x", "heading": "Revenue Composition", "analysis": "revenue concentrated by segment mix", "keyFigures": [], "chart": None},
    ]
    _inject_mechanical_charts(sections, clips)
    types = {s["chart"]["chartType"] for s in sections if s["chart"]}
    assert {"range", "pie", "bar"}.issubset(types)
    assert len(types) >= 3


def test_inject_mechanical_charts_discards_any_model_supplied_chart_even_when_matched():
    clips = _full_nvda_aapl_clips()
    sections = [{"clipId": "x", "heading": "Profitability Edge", "analysis": "gross margin lead",
                 "keyFigures": [], "chart": {"chartType": "line", "title": "model made this"}}]
    _inject_mechanical_charts(sections, clips)
    # the model's line chart is gone; the site's grouped bar took its place
    assert sections[0]["chart"]["title"] != "model made this"
    assert sections[0]["chart"]["chartType"] == "bar"


def test_chart_facts_digests_bar_and_range_chart_numbers():
    from routers.ai import _chart_facts
    sections = [
        {"chart": {"title": "Growth & Margin Comparison", "chartType": "bar", "xKey": "metric",
                   "data": [{"metric": "Gross Margin", "NVDA": 74.1, "AAPL": 47.9}],
                   "series": [{"key": "NVDA", "label": "NVDA"}, {"key": "AAPL", "label": "AAPL"}]}},
        {"chart": {"title": "DCF Sensitivity", "chartType": "range", "xKey": "driver",
                   "data": [{"driver": "WACC", "NVDA": [148.27, 203.29]}],
                   "series": [{"key": "NVDA", "label": "NVDA $/sh"}]}},
        {"chart": None},
    ]
    facts = _chart_facts(sections)
    assert "Growth & Margin Comparison" in facts
    assert "NVDA 74.1" in facts and "AAPL 47.9" in facts
    assert "148.27-203.29" in facts


def test_chart_facts_empty_when_no_charts():
    from routers.ai import _chart_facts
    assert _chart_facts([{"chart": None}, {}]) == ""


# ── New chart recipes + diversity (report-builder refinement) ─────────────────

def _chart_clip(id_, title, xkey, series_label, xs, vals):
    pts = f"POINTS: {xkey}=[{','.join(xs)}]; {series_label}=[{','.join(str(v) for v in vals)}]"
    return ReportClipIn(id=id_, sourceTab="DCF Valuation", dataType="chart",
                        title=title, dataSummary=f"line chart. {pts}", userDescription="")


def test_parse_chart_points_splits_numeric_and_label_arrays():
    from routers.ai import _parse_chart_points
    pts = _parse_chart_points("line chart. POINTS: year=[Y1,Y2,Y3]; Revenue ($M)=[300,450,700]")
    assert pts["year"] == ["Y1", "Y2", "Y3"]
    assert pts["Revenue ($M)"] == [300.0, 450.0, 700.0]
    assert _parse_chart_points("no points here") is None


def test_revenue_overlay_builds_a_dual_line_across_shared_years():
    from routers.ai import _revenue_overlay_chart
    clips = [
        _chart_clip("r1", "Revenue Projection · NVDA", "year", "Revenue ($M)",
                    ["Y1", "Y2", "Y3", "Y4"], [300000, 450000, 700000, 1100000]),
        _chart_clip("r2", "Revenue Projection · AAPL", "year", "Revenue ($M)",
                    ["Y1", "Y2", "Y3", "Y4"], [440000, 470000, 510000, 560000]),
    ]
    chart = _revenue_overlay_chart(clips)
    assert chart["chartType"] == "line"
    assert {s["key"] for s in chart["series"]} == {"NVDA", "AAPL"}
    assert chart["data"][0]["year"] == "Y1"


def _all_metrics_pe_clip(id_, ticker, pe_by_ticker):
    header = "Columns: Ticker | Name | P/E"
    body = "\n".join(f"{tk} | {tk} Inc | {pe}x" for tk, pe in pe_by_ticker)
    return ReportClipIn(id=id_, sourceTab="Peer Comparison", dataType="table",
                        title=f"All Metrics · {ticker}", dataSummary=f"{header}\n{body}", userDescription="")


def test_peer_distribution_box_computes_quartiles_and_marks_subjects():
    from routers.ai import _peer_distribution_box, _clean_chart
    clips = [
        _kpi("n", "NVDA · Snapshot", "P/E: 31.6"), _kpi("a", "AAPL · Snapshot", "P/E: 40.3"),
        _all_metrics_pe_clip("m", "NVDA", [
            ("Median", "—"), ("NVDA", 31.6), ("AVGO", 63.7), ("MU", 20.8),
            ("AMD", 175.2), ("INTC", 29.8), ("TXN", 42.6), ("QCOM", 18.0)]),
    ]
    chart = _clean_chart(_peer_distribution_box(clips))
    assert chart["chartType"] == "box"
    row = chart["data"][0]
    assert row["min"] == 18.0 and row["max"] == 63.7
    labels = {m["label"] for m in row["markers"]}
    assert labels == {"NVDA", "AAPL"}


def test_clean_chart_validates_and_rejects_box():
    from routers.ai import _clean_chart
    ok = _clean_chart({"chartType": "box", "xKey": "metric",
                       "data": [{"metric": "P/E", "min": 10, "q1": 20, "median": 30, "q3": 40, "max": 50,
                                 "markers": [{"label": "NVDA", "value": 25}]}],
                       "series": [{"key": "P/E", "label": "P/E"}]})
    assert ok["chartType"] == "box" and ok["data"][0]["markers"][0]["label"] == "NVDA"
    # missing a quartile -> row dropped -> whole chart None
    assert _clean_chart({"chartType": "box", "xKey": "metric",
                         "data": [{"metric": "P/E", "min": 10, "q1": 20, "median": 30}],
                         "series": [{"key": "P/E", "label": "P/E"}]}) is None


def test_peg_comparison_reads_the_screener_peg_column():
    from routers.ai import _peg_comparison_chart
    clips = [
        _kpi("n", "NVDA · Snapshot", "P/E: 31.6"), _kpi("a", "AAPL · Snapshot", "P/E: 40.3"),
        ReportClipIn(id="s", sourceTab="Stock Screener", dataType="table",
                     title="Top Matches · Liquid Large Caps",
                     dataSummary="Columns: Ticker | Company | Sector | Price | Chg% | Mkt Cap | P/E | PEG | OP%\n"
                                 "NVDA | NVIDIA | Tech | $195 | - | $4.7T | 39.9 | 0.60 | 60.4%\n"
                                 "AAPL | Apple | Tech | $275 | - | $4.0T | 36.9 | 1.63 | 32.0%", userDescription=""),
    ]
    chart = _peg_comparison_chart(clips)
    assert chart["chartType"] == "bar"
    peg = {r["name"]: r["peg"] for r in chart["data"]}
    assert peg["NVDA"] == 0.6 and peg["AAPL"] == 1.63


def test_price_performance_overlay_fetches_and_indexes_to_100(monkeypatch):
    import pandas as pd
    import cache
    def fake_history(ticker, period="1y", **kw):
        idx = pd.date_range("2025-07-01", periods=60, freq="D")
        base = 100.0 if ticker == "NVDA" else 200.0
        return pd.DataFrame({"Close": [base * (1 + i * 0.01) for i in range(60)]}, index=idx)
    monkeypatch.setattr(cache, "get_history", fake_history)
    from routers.ai import _price_performance_overlay
    clips = [_kpi("n", "NVDA · Snapshot", "P/E: 31.6"), _kpi("a", "AAPL · Snapshot", "P/E: 40.3")]
    chart = _price_performance_overlay(clips)
    assert chart["chartType"] == "line"
    assert {s["key"] for s in chart["series"]} == {"NVDA", "AAPL"}
    assert chart["data"][0]["NVDA"] == 100.0 and chart["data"][0]["AAPL"] == 100.0


def test_price_performance_overlay_degrades_to_none_on_fetch_failure(monkeypatch):
    import cache
    monkeypatch.setattr(cache, "get_history", lambda *a, **k: (_ for _ in ()).throw(RuntimeError("boom")))
    from routers.ai import _price_performance_overlay
    clips = [_kpi("n", "NVDA · Snapshot", "P/E: 31.6"), _kpi("a", "AAPL · Snapshot", "P/E: 40.3")]
    assert _price_performance_overlay(clips) is None


def test_inject_never_places_the_same_chart_twice_and_spreads_types():
    clips = _full_nvda_aapl_clips() + [
        _all_metrics_pe_clip("m1", "NVDA", [("Median", "—"), ("NVDA", 31.6), ("AVGO", 63.7),
                                            ("MU", 20.8), ("AMD", 175.2), ("INTC", 29.8), ("TXN", 42.6)]),
        _consensus_clip("c1", "NVDA", "+46.4%"), _consensus_clip("c2", "AAPL", "-4.3%"),
    ]
    sections = [
        {"clipId": "x", "heading": "Valuation Gap", "analysis": "premium to intrinsic dcf value discount", "keyFigures": [], "chart": None},
        {"clipId": "x", "heading": "Peer Distribution", "analysis": "sits in the peer p/e distribution versus sector median", "keyFigures": [], "chart": None},
        {"clipId": "x", "heading": "Profitability Edge", "analysis": "gross margin and net margin lead growth", "keyFigures": [], "chart": None},
        {"clipId": "x", "heading": "DCF Sensitivity", "analysis": "wacc swing driver one-way", "keyFigures": [], "chart": None},
        {"clipId": "x", "heading": "Segment Mix", "analysis": "revenue composition concentrated segment", "keyFigures": [], "chart": None},
    ]
    _inject_mechanical_charts(sections, clips)
    charts = [s["chart"] for s in sections if s["chart"]]
    sigs = [(_c := c)["chartType"] for c in charts]  # noqa: F841
    from routers.ai import _chart_signature
    all_sigs = [_chart_signature(c) for c in charts]
    assert len(all_sigs) == len(set(all_sigs))  # no duplicate chart appears twice
    # no two ADJACENT sections share a chart type
    placed = [s["chart"]["chartType"] if s["chart"] else None for s in sections]
    for a, b in zip(placed, placed[1:]):
        assert not (a is not None and a == b), f"adjacent same-type charts: {placed}"


def test_fix_comparative_reversals_corrects_roe_reversal():
    from routers.ai import _fix_comparative_reversals
    clips = [
        _kpi("1", "AAPL · Snapshot", "ROE: 141.5%"),
        _kpi("2", "NVDA · Snapshot", "ROE: 114.3%"),
    ]
    prose = "AAPL's diversified consumer electronics franchise yields slower growth and lower ROE (141.5%) than NVDA's 114.3%."
    fixed = _fix_comparative_reversals(prose, clips)
    assert "higher ROE" in fixed
    assert "lower ROE" not in fixed


def test_fix_upside_vocabulary_reversals_replaces_misleading_labels():
    from routers.ai import _fix_upside_vocabulary_reversals
    prose = "DCF analysis shows NVDA trading 16.8% above intrinsic value, and NVDA achieved a single-period 85.2% revenue cagr."
    fixed = _fix_upside_vocabulary_reversals(prose)
    assert "trading at a 16.8% downside to intrinsic value" in fixed
    assert "revenue growth rate" in fixed
    assert "revenue cagr" not in fixed.lower()


def test_ensure_risks_section_appends_qualitative_section_without_falsification():
    from routers.ai import _ensure_risks_section
    sections = [{"clipId": "1", "heading": "Valuation Gap", "analysis": "prose"}]
    _ensure_risks_section(sections, "NVDA", {})
    assert len(sections) == 2
    assert "Risks" in sections[1]["heading"]
    # No fabricated falsification trigger, floor/ceiling, or invented thresholds.
    body = sections[1]["analysis"].lower()
    assert "falsif" not in body
    assert "invalidated" not in body
    assert "then thesis" not in body
    assert not sections[1]["keyFigures"]



def test_sensitivity_swing_summary_is_percent_of_price():
    # NVDA envelope 150-250 on a $200 price is a 50% swing; the summary reports
    # the percent, not just the $100 dollar spread.
    clip = _sensitivity_clip("s1", "NVDA", [
        ("WACC", 8, 12, 150.0, 250.0),
        ("Growth", 10, 20, 170.0, 230.0),
    ])
    out = _sensitivity_swing_summary([clip], {"NVDA": 200.0})
    assert out["NVDA"]["low"] == 150.0
    assert out["NVDA"]["high"] == 250.0
    assert out["NVDA"]["swing"] == 100.0
    assert out["NVDA"]["swingPct"] == 50.0


def test_sensitivity_swing_summary_no_price_leaves_pct_none():
    clip = _sensitivity_clip("s1", "NVDA", [
        ("WACC", 8, 12, 150.0, 250.0),
        ("Growth", 10, 20, 170.0, 230.0),
    ])
    out = _sensitivity_swing_summary([clip], {})
    assert out["NVDA"]["swing"] == 100.0
    assert out["NVDA"]["swingPct"] is None


def test_annotate_sensitivity_swing_labels_percent_of_spot():
    sections = [{
        "clipId": "x",
        "chart": {
            "chartType": "range",
            "title": "DCF Sensitivity — One-Way Swing ($/sh)",
            "xKey": "driver",
            "data": [{"driver": "WACC", "NVDA": [150, 250]}, {"driver": "Growth", "NVDA": [170, 230]}],
            "series": [{"key": "NVDA", "label": "NVDA $/sh"}],
        },
    }]
    _annotate_sensitivity_swing(sections, {"NVDA": 200.0})
    assert sections[0]["chart"]["series"][0]["label"] == "NVDA (50% swing)"


def test_annotate_sensitivity_swing_ignores_non_sensitivity_range():
    sections = [{
        "clipId": "x",
        "chart": {
            "chartType": "range", "title": "Analyst Target Band", "xKey": "name",
            "data": [{"name": "NVDA", "NVDA": [180, 260]}], "series": [{"key": "NVDA", "label": "NVDA"}],
        },
    }]
    _annotate_sensitivity_swing(sections, {"NVDA": 200.0})
    assert sections[0]["chart"]["series"][0]["label"] == "NVDA"  # untouched


def test_revise_block_before_resolves_fields_and_sections():
    gen = {
        "headline": "H", "executiveSummary": "ES", "conclusion": "CC",
        "sections": [{"clipId": "c1", "heading": "Sec One", "analysis": "AN"}],
    }
    assert _revise_block_before(gen, "headline", "") == "H"
    assert _revise_block_before(gen, "executiveSummary", "") == "ES"
    assert _revise_block_before(gen, "section.analysis", "c1") == "AN"
    assert _revise_block_before(gen, "section.heading", "c1") == "Sec One"
    assert _revise_block_before(gen, "section.analysis", "missing") is None
    assert _ALLOWED_REVISE_FIELDS == {"headline", "executiveSummary", "conclusion", "section.analysis", "section.heading"}


def _setup_sections(n=2):
    clips = [ReportClipIn(id=f"c{i}", dataType="chart", title=f"Exhibit {i}") for i in range(n)]
    sections = [
        {
            "clipId": c.id, "heading": c.title, "analysis": "The evidence supports the thesis.",
            "keyFigures": [{"label": "Lead", "value": "12%"}, {"label": "Gap", "value": "4 pp"}],
            "chart": None, "design": "visual",
        }
        for c in clips
    ]
    return sections, clips


def test_layout_preset_outranks_the_models_per_section_intent():
    """The preset is an explicit user instruction; 'design: visual' is an inference."""
    for preset, expected in [
        ("visual-first", ["evidence-band", "full-width"]),
        ("data-dense", ["metric-rail-left", "metric-rail"]),
        ("narrative", ["analysis-first", "analysis-first"]),
    ]:
        sections, clips = _setup_sections()
        _apply_section_layout_architecture(sections, clips, preset)
        assert [s["layout"] for s in sections] == expected, preset


def test_editorial_preset_and_no_preset_keep_the_historical_behaviour():
    for preset in ("editorial", ""):
        sections, clips = _setup_sections()
        _apply_section_layout_architecture(sections, clips, preset)
        assert [s["layout"] for s in sections] == ["visual-left", "visual-right"], preset


def test_layout_preset_never_overrides_the_renderer_safety_rules():
    """A section with no visual cannot take a side-by-side layout however the user
    set the preset, and a dense table still claims the full width."""
    clip = ReportClipIn(id="t", dataType="table", title="Holdings")
    section = {
        "clipId": "t", "heading": "Book", "analysis": "Concentration is the risk.",
        "keyFigures": [{"label": "Top 5", "value": "48%"}], "chart": None, "design": "visual",
    }
    _apply_section_layout_architecture([section], [clip], "visual-first")
    assert section["layout"] in {"full-width", "metric-rail"}


def test_report_type_guidance_reaches_the_prompt_and_unknown_types_are_ignored():
    comparison = _report_system_prompt("open", "medium", "", "comparison")
    assert "REPORT TYPE — Comparison" in comparison
    assert "never one section per subject" in comparison

    portfolio = _report_system_prompt("open", "medium", "", "portfolio-review")
    assert "the reader's book" in portfolio
    assert "REPORT TYPE — Comparison" not in portfolio

    for unknown in ("", "not-a-type"):
        assert "REPORT TYPE" not in _report_system_prompt("open", "medium", "", unknown)


def test_report_type_guidance_does_not_leak_renderer_presets():
    """Layout stays out of the model's vocabulary no matter which type is picked."""
    for t in ("equity-note", "comparison", "macro-brief", "portfolio-review", "screen-summary", "thesis"):
        prompt = _report_system_prompt("open", "medium", "", t)
        assert "metric-rail" not in prompt
        assert "visual-left" not in prompt


def _book_req(goal, report_type="", clips=None):
    from routers.ai import ReportGenRequest
    return ReportGenRequest(
        goal=goal, reportType=report_type,
        clips=clips or [ReportClipIn(id="c", dataType="table", title="Holdings")],
    )


def test_portfolio_objective_is_book_level_even_without_a_report_type():
    """The regression: a project stored before the setup flow carries the default
    'equity-note', so the objective has to be what routes it. This is the report
    that came back rated 'Hold NVDA' on a four-holding book."""
    from routers.ai import _book_level_report
    req = _book_req("Assess risk and concentration in my portfolio", "equity-note")
    assert _book_level_report(req, ["NVDA", "MSFT", "QCOM", "MU"]) is True


def test_explicit_types_decide_without_consulting_the_objective():
    from routers.ai import _book_level_report
    assert _book_level_report(_book_req("anything", "portfolio-review"), ["NVDA"]) is True
    assert _book_level_report(_book_req("anything", "macro-brief"), []) is True
    assert _book_level_report(_book_req("anything", "screen-summary"), []) is True
    # A named-subject type is never overridden by portfolio words in the goal.
    assert _book_level_report(_book_req("NVDA vs MSFT in my portfolio", "comparison"), ["NVDA", "MSFT"]) is False


def test_a_single_name_note_mentioning_a_portfolio_keeps_its_subject():
    """Requiring 2+ candidates stops 'should I add NVDA to my portfolio' from
    losing the subject equity it genuinely has."""
    from routers.ai import _book_level_report
    assert _book_level_report(_book_req("Should I add NVDA to my portfolio?"), ["NVDA"]) is False
    assert _book_level_report(_book_req("Is MSFT worth holding?"), ["MSFT"]) is False
    assert _book_level_report(_book_req("Compare NVDA and AAPL"), ["NVDA", "AAPL"]) is False


def test_book_level_prompt_forbids_a_single_name_verdict():
    prompt = _report_system_prompt("open", "medium", "", "", True)
    assert "AGGREGATE SUBJECT" in prompt
    assert "Hold NVDA" in prompt              # named as the wrong answer
    assert "never a single ticker" in prompt
    # And stays absent for an ordinary single-name note.
    assert "AGGREGATE SUBJECT" not in _report_system_prompt("open", "medium", "", "equity-note", False)


def test_book_level_reports_never_use_range_mode():
    """A price range needs one issuer to price. A book has none."""
    from routers.ai import _report_mode, _book_level_report
    single = _book_req("What is the fair value price target for NVDA", "equity-note")
    assert _report_mode(single, ["NVDA"]) == "range"
    # Same wording routed as a portfolio review must not produce a range.
    assert _book_level_report(_book_req("What is the fair value price target for NVDA", "portfolio-review"), ["NVDA"]) is True


def test_portfolio_linter_cannot_reverse_negative_active_return():
    clips = [
        _clip(
            "risk", "Portfolio Compare", "Book risk metrics",
            "Period return: 8.1%; SPY period return: 8.4%; Active return vs SPY: -0.3% (Underperformance)",
        ),
    ]
    text = "Growth tilt drives outperformance. The portfolio outperformed SPY."

    fixed = ai._fix_portfolio_performance_claims(text, clips)

    assert "outperformance" not in fixed.lower()
    assert "underperformed SPY" in fixed
    assert "associated with underperformance" in fixed


def test_portfolio_quality_findings_are_advisory_for_incomplete_inputs():
    req = ReportGenRequest(
        reportType="portfolio-review",
        goal="Assess my portfolio and whether sticky inflation threatens upside",
        clips=[
            _clip(
                "holdings", "Portfolio Manager", "Book allocation data quality",
                "NVDA is unpriced and excluded from portfolio weights. Do not recommend maintaining allocation.",
            ),
            _clip(
                "risk", "Portfolio Compare", "Book risk metrics",
                "Period return: 8.1%; SPY period return: 8.4%; Active return vs SPY: -0.3% (Underperformance)",
            ),
        ],
    )

    warnings = ai._report_quality_warnings(req, True)
    codes = {warning["code"] for warning in warnings if warning["severity"] == "warning"}

    assert "allocation-incomplete" in codes
    assert "inflation-evidence-missing" in codes
    assert "benchmark-comparison-missing" not in codes
    assert not any(warning["severity"] == "blocking" for warning in warnings)


def test_portfolio_action_filter_removes_unsupported_recommendations_from_prose():
    text = (
        "NVDA retains strong operating momentum. We recommend adding NVDA to the portfolio. "
        "Investors should increase exposure while demand remains durable."
    )

    fixed = ai._remove_unsupported_portfolio_actions(text)

    assert fixed == "NVDA retains strong operating momentum."
    assert "recommend" not in fixed.lower()
    assert "increase exposure" not in fixed.lower()


def test_beta_does_not_become_an_unsupported_explanation_for_active_return():
    clips = [
        _clip(
            "risk", "Portfolio Compare", "Book risk metrics",
            "Period return: 8.1%; SPY period return: 8.4%; Active return vs SPY: -0.3% (Underperformance); Beta vs SPY: 1.11",
        ),
    ]

    fixed = ai._fix_portfolio_performance_claims(
        "The portfolio lagged SPY, driven by beta of 1.11.", clips,
    )

    assert "does not determine whether active return arose" in fixed
    assert "allocation, security selection, cash, fees, or trading" in fixed


def test_direct_sector_weight_is_not_presented_as_total_exposure_with_funds():
    clips = [
        _clip(
            "sector-limit", "Portfolio Manager", "Fund look-through limitation",
            "ETF and fund positions represent 61% of portfolio value. Direct issuer sector weights exclude fund look-through.",
        ),
    ]

    fixed = ai._clarify_direct_sector_weights(
        "Technology accounts for 9% of portfolio value.", clips,
    )

    assert fixed == (
        "Directly held technology securities represent 9% of the portfolio. "
        "Total economic technology exposure cannot be determined without fund holdings look-through."
    )


def test_portfolio_action_filter_removes_gerund_reallocation_language():
    fixed = ai._remove_unsupported_portfolio_actions(
        "Reducing tech exposure and adding low-beta bonds will lower volatility. Current risk remains measurable."
    )

    assert fixed == "Current risk remains measurable."


def test_beta_due_to_language_is_not_treated_as_active_return_attribution():
    clips = [_clip(
        "risk", "Portfolio Compare", "Portfolio risk metrics",
        "Active return vs SPY: -0.7% (Underperformance); Beta vs SPY: 1.21",
    )]

    fixed = ai._fix_portfolio_performance_claims(
        "The portfolio underperformed SPY by 0.7% due to a 1.21 beta.", clips,
    )

    assert "does not determine whether active return arose" in fixed
    assert "market exposure" in fixed


def test_portfolio_outline_is_always_the_four_decision_stages(monkeypatch):
    response = SimpleNamespace(choices=[SimpleNamespace(message=SimpleNamespace(content=json.dumps({
        "thesis": "Risk remains elevated.",
        "sections": [{"heading": "Risk", "argues": "Beta is high.", "chartHint": "risk"}],
    })))])
    monkeypatch.setattr(ai, "groq_chat", lambda *_args, **_kwargs: response)

    outline = ai._generate_outline({"reportLength": "medium", "reportType": "portfolio-review"})

    assert outline is not None
    assert [section["heading"].split(":")[0] for section in outline["sections"]] == [
        "What Happened", "Why It Happened", "What Could Happen Next", "What Action Follows",
    ]
    assert "Valuation" not in outline["sections"][2]["heading"]


def test_unfinished_fund_lookthrough_does_not_block_report_generation():
    req = ReportGenRequest(
        reportType="portfolio-review",
        goal="Assess my portfolio",
        clips=[
            _clip("holdings", "Portfolio Manager", "Current allocation", "VOO weight: 60%"),
            _clip("sector", "Portfolio Manager", "Fund look-through limitation", "60% requires fund holdings look-through"),
            _clip("risk", "Portfolio Compare", "Book risk metrics", "Active return vs SPY: -0.3%"),
        ],
    )

    warnings = ai._report_quality_warnings(req, True)

    assert not any(warning["code"] == "fund-lookthrough-incomplete" for warning in warnings)


def test_portfolio_trade_requires_proposal_and_quantified_impact():
    current_only = [
        _clip("allocation", "Portfolio Manager", "Current allocation", "NVDA weight: 30%"),
        _clip("risk", "Portfolio Compare", "Scenario losses", "SPY -10%: portfolio -11%"),
    ]
    complete = current_only + [
        _clip(
            "proposal", "Portfolio Optimizer", "Proposed allocation and trade impact",
            "Target allocation: NVDA 20%. Post-trade expected portfolio beta: 0.98. Before and after scenario loss supplied.",
        ),
    ]

    assert ai._has_portfolio_trade_impact_evidence(current_only) is False
    assert ai._has_portfolio_trade_impact_evidence(complete) is True


def test_portfolio_prompt_makes_computed_evidence_authoritative():
    prompt = _report_system_prompt("open", "medium", "", "portfolio-review", True)

    assert "Never describe a negative active return as outperformance" in prompt
    assert "period return, not CAGR" in prompt
    assert "holding-level or factor attribution" in prompt
