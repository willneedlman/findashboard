"""Must-include enforcement, from the AI Momentum Trade report (15 Aug 2026).

The user listed seven requirements. The report covered some, quietly dropped
others, and nothing told the reader which was which. The prompt already
instructed the writer to say so explicitly when it could not source a
requirement, and it did not.
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))

import routers.ai as ai  # noqa: E402
from routers.ai import audit_requirements, requirement_terms  # noqa: E402

REQUIREMENTS = [
    "A P/E and EV/EBITDA comparison across all four names, with the peer median stated",
    "Revenue growth and operating margin for each, most recent fiscal year and the one before",
    "Each name's 90-day realised volatility and its current ATM implied vol, with the gap called out",
    "A correlation matrix across the four names over the lookback window",
    "State the market cap for each name and which share basis it is on",
    "The deepest 90-day drawdown for each, as a percent of price",
    "An explicit verdict naming one to own and one to avoid, with the single strongest counterargument to that call",
]

# Condensed from the delivered PDF, keeping the sentences that decide coverage.
DELIVERED = """
NVDA Is the Superior Risk-adjusted Buy, MU Is the Clear Avoid
Figure 1 NVDA multiples vs peer median. P/E 34.5x vs 57.8x. EV/EBITDA 32.7x vs 22.3x.
NVDA posted FY revenue growth of 23% versus 18% for AMD, 9% for AVGO and 2% for MU,
while expanding its FY operating margin to 38% from 33% a year earlier.
A widening gap between NVDA's ATM implied volatility and its 90-day realized volatility
would erode the risk-adjusted edge that currently favors NVDA. The volatility-skew clip
does not contain the exact figures, so the magnitude of the gap cannot be quantified.
Figure 5 Pair correlations. NVDA AMD 0.48. AMD MU 0.79.
NVDA projected max drawdown 12.0%. MU projected max drawdown 28.0%.
NVDA outperforms over the next two quarters and MU should be avoided.
"""


class TestRequirementTerms:
    def test_scaffolding_words_are_dropped(self):
        terms = requirement_terms("State the market cap for each name and which share basis it is on")
        assert "cap" in terms and "basis" in terms
        assert "state" not in terms and "each" not in terms


class TestAuditAgainstTheDeliveredReport:
    def test_the_market_cap_requirement_is_caught(self):
        # Never appeared anywhere in the report.
        unmet = audit_requirements(REQUIREMENTS, DELIVERED)
        assert REQUIREMENTS[4] in unmet

    def test_the_volatility_requirement_is_caught(self):
        # Discussed at length and never measured, which is the subtle case: the
        # words are all present, so only the missing quantity gives it away.
        unmet = audit_requirements(REQUIREMENTS, DELIVERED)
        assert REQUIREMENTS[2] in unmet

    def test_the_multiples_requirement_passes(self):
        # P/E, EV/EBITDA and the peer median are all stated with figures.
        assert REQUIREMENTS[0] not in audit_requirements(REQUIREMENTS, DELIVERED)

    def test_the_growth_and_margin_requirement_passes(self):
        assert REQUIREMENTS[1] not in audit_requirements(REQUIREMENTS, DELIVERED)

    def test_a_fully_covered_report_reports_nothing(self):
        covered = (
            "Market cap: NVDA $4.2T, AMD $260B, AVGO $780B, MU $110B, on a diluted share basis. "
            "P/E and EV/EBITDA for all four against a peer median of 34.5x. "
            "Revenue growth of 23.0% and operating margin of 38.0% in fiscal year 2026, "
            "against 19.0% and 33.0% the year before. "
            "90-day realised volatility of 42.1% against ATM implied vol of 48.6%, a gap of 6.5pp. "
            "Correlation matrix over the lookback window: 0.48, 0.79, 0.57. "
            "Deepest 90-day drawdown: NVDA 12.0% of price, MU 28.0% of price. "
            "Verdict: own NVDA, avoid MU. The strongest counterargument is a 6.5pp vol gap."
        )
        assert audit_requirements(REQUIREMENTS, covered) == []

    def test_no_requirements_means_no_findings(self):
        assert audit_requirements([], DELIVERED) == []
        assert audit_requirements(REQUIREMENTS, "") == []


class TestRequirementsProtectTheirEvidence:
    def test_a_required_clip_outranks_a_generic_one(self):
        """A market-cap clip scored a generic 500 and was shed first, so the
        requirement could not be satisfied by evidence already thrown away."""
        def clip(title, tab="Compare"):
            return ai.ReportClipIn(
                id=title, sourceTab=tab, title=title, dataType="table",
                dataSummary=f"{title} rows", userDescription="", evidenceDomain="issuer")

        clips = [clip(f"Filler panel {i}") for i in range(30)]
        clips.append(clip("Market cap and share basis"))
        selected = ai._report_prompt_clips(
            clips, "short", False,
            ["State the market cap for each name and which share basis it is on"])
        titles = [c.get("title") for c in selected]
        assert "Market cap and share basis" in titles
        # And it is ordered ahead of the filler, so trimming to fit sheds filler.
        assert titles.index("Market cap and share basis") < 3


SUBJECTS = ["NVDA", "AMD", "AVGO", "MU"]


class TestEverySubjectCoverage:
    def test_a_drawdown_for_two_of_four_names_does_not_satisfy_for_each(self):
        # The report gave NVDA 12.0% and MU 28.0% and nothing for AMD or AVGO,
        # then read as though the requirement had been answered.
        unmet = audit_requirements(REQUIREMENTS, DELIVERED, SUBJECTS)
        assert REQUIREMENTS[5] in unmet

    def test_multiples_for_one_name_does_not_satisfy_across_all_four(self):
        assert REQUIREMENTS[0] in audit_requirements(REQUIREMENTS, DELIVERED, SUBJECTS)

    def test_growth_and_margin_naming_all_four_still_passes(self):
        # One sentence carrying all four names with figures is a real answer.
        assert REQUIREMENTS[1] not in audit_requirements(REQUIREMENTS, DELIVERED, SUBJECTS)

    def test_subjects_are_ignored_when_the_requirement_is_not_per_name(self):
        line = "State the peer median P/E"
        text = "The peer median P/E is 34.5x."
        assert audit_requirements([line], text, SUBJECTS) == []


class TestChartsCountAsCoverage:
    def test_a_chart_plotting_all_four_names_satisfies_the_requirement(self):
        """A figure answers a requirement as well as a sentence does. Reading
        only the chart's title marked a covered requirement as missing."""
        chart = {
            "title": "Deepest 90-day drawdown by name",
            "xKey": "name",
            "series": [{"key": "dd", "label": "Drawdown % of price"}],
            "data": [
                {"name": "NVDA", "dd": 12.0}, {"name": "AMD", "dd": 18.5},
                {"name": "AVGO", "dd": 9.4}, {"name": "MU", "dd": 28.0},
            ],
        }
        text = ai._chart_audit_text(chart)
        for ticker in SUBJECTS:
            assert ticker in text
        assert audit_requirements([REQUIREMENTS[5]], text, SUBJECTS) == []

    def test_a_chart_covering_two_of_four_still_fails_the_per_name_check(self):
        chart = {
            "title": "Deepest 90-day drawdown by name",
            "xKey": "name",
            "series": [{"key": "dd", "label": "Drawdown % of price"}],
            "data": [{"name": "NVDA", "dd": 12.0}, {"name": "MU", "dd": 28.0}],
        }
        unmet = audit_requirements([REQUIREMENTS[5]], ai._chart_audit_text(chart), SUBJECTS)
        assert unmet == [REQUIREMENTS[5]]

    def test_a_missing_chart_contributes_nothing_and_does_not_crash(self):
        assert ai._chart_audit_text(None) == ""
        assert ai._chart_audit_text({}) == " ."
