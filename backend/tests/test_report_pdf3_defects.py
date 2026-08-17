"""Defects in a delivered report (AI Momentum Trade, 17 Aug 2026).

The report generated and argued well. These are what it got wrong on the page,
with the figures taken from that PDF.
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))

import routers.ai as ai  # noqa: E402
from routers.ai import ReportClipIn  # noqa: E402


def _clip(title, summary, tab="Factor Decomposition"):
    return ReportClipIn(id=title, sourceTab=tab, title=title, dataType="table",
                        dataSummary=summary, userDescription="", evidenceDomain="issuer")


class TestBetaStatedTwiceIsCaught:
    """Figure 1 gave AMD 4.30, AVGO 3.02, MU 4.65 from a factor table. The strip
    one page later gave AMD 3.89, AVGO 2.23, MU 4.39 as KPI cells. Both were
    presented as the name's beta and nothing flagged the disagreement, because
    only tables were ever read."""

    TABLE = _clip(
        "Factor decomposition",
        "Columns: Holding | Weight % | Market beta\nAMD | 25.0 | 4.30\n"
        "AVGO | 25.0 | 3.02\nMU | 25.0 | 4.65\nNVDA | 25.0 | 2.46")
    KPIS = _clip(
        "Holding beta snapshot",
        "AMD beta: 3.89; AVGO beta: 2.23; MU beta: 4.39; NVDA beta: 2.46",
        tab="Risk Metrics")

    def test_kpi_stated_betas_are_now_read(self):
        maps = ai._kpi_beta_maps([self.KPIS])
        assert maps, "a panel labelling cells 'AMD beta 3.89' must be seen"
        assert maps[0][1]["AMD"] == 3.89 and maps[0][1]["MU"] == 4.39

    def test_the_two_panels_are_detected_as_disagreeing(self):
        note = ai._beta_source_conflict_note([self.TABLE, self.KPIS])
        assert note is not None, "AMD 4.30 vs 3.89 is a disagreement the reader must be told"
        assert "different windows" in note

    def test_one_panel_alone_raises_nothing(self):
        assert ai._beta_source_conflict_note([self.TABLE]) is None

    def test_a_portfolio_level_beta_is_not_mistaken_for_a_holding(self):
        book = _clip("Risk metrics", "Portfolio beta: 1.14; Market beta: 1.00", tab="Risk")
        assert ai._kpi_beta_maps([book]) == []


class TestChartsLandUnderTheRightHeading:
    """Every figure in the report sat under the wrong heading: the operating
    chart under Market Context, the options chart under Operating Comparison,
    the weights donut under Risks."""

    def test_the_heading_outweighs_a_passing_mention_in_the_prose(self):
        operating = {"templateSection": "operating-comparison", "heading": "Operating Comparison",
                     "analysis": "Revenue and margin against the peer median."}
        context = {"templateSection": "market-context", "heading": "Market Context",
                   "analysis": "All four names sit in a high-beta regime with strong momentum "
                               "and market-driven risk."}
        # The growth/margin chart now names the section it belongs to. It also
        # no longer claims "momentum", which is what pulled it into Market
        # Context in the first place.
        keywords = ("operating", "growth", "margin", "profitab", "edge")
        assert ai._section_match_score(operating, keywords) >= 4, "a title match must dominate"
        assert (ai._section_match_score(operating, keywords)
                > ai._section_match_score(context, keywords)), (
            "the section named for the chart must beat one that merely mentions its words")

    def test_a_section_matching_nothing_scores_zero(self):
        risks = {"templateSection": "risks", "heading": "Risks", "analysis": "Downside."}
        assert ai._section_match_score(risks, ("segment", "mix", "composition")) == 0


class TestAnEmptyPieIsNotDrawn:
    """A donut of four identical 25% slices took a third of a page and said
    nothing the sentence beside it did not."""

    def _pie(self, values):
        return {"chartType": "pie", "title": "Weight %", "xKey": "name",
                "series": [{"key": "w", "label": "Weight %"}],
                "data": [{"name": n, "w": v} for n, v in values]}

    def test_equal_slices_are_dropped(self):
        chart = self._pie([("AMD", 25.0), ("AVGO", 25.0), ("MU", 25.0), ("NVDA", 25.0)])
        assert ai._clean_chart(chart) is None

    def test_a_real_mix_survives(self):
        chart = self._pie([("Compute", 75.2), ("Networking", 14.5),
                           ("Gaming", 7.4), ("Other", 2.9)])
        assert ai._clean_chart(chart) is not None

    def test_rounding_noise_still_counts_as_uniform(self):
        chart = self._pie([("A", 25.0), ("B", 25.1), ("C", 24.9), ("D", 25.0)])
        assert ai._clean_chart(chart) is None

    def test_a_bar_chart_of_equal_values_is_left_alone(self):
        # The rule is about pies, where equal slices carry no shape at all.
        bar = {"chartType": "bar", "title": "Weights", "xKey": "name",
               "series": [{"key": "w", "label": "Weight %"}],
               "data": [{"name": n, "w": 25.0} for n in ("AMD", "AVGO", "MU", "NVDA")]}
        assert ai._clean_chart(bar) is not None
