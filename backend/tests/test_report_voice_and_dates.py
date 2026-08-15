"""Defects found in a shipped report (AI Momentum Trade, 15 Aug 2026).

Every string here is quoted from that PDF. The prompt already forbade most of
it and the model did it anyway, which is why these are deterministic passes
rather than more prompt text.
"""
import os
import sys
from datetime import datetime, timezone

sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))

import routers.ai as ai  # noqa: E402

NOW = datetime(2026, 8, 15, tzinfo=timezone.utc)


class TestSemicolons:
    def test_the_conclusion_semicolon_becomes_a_sentence(self):
        out = ai._split_on_semicolons(
            "We are highly confident that NVDA is the preferred risk-adjusted buy and MU "
            "should be avoided; the main risk is a sudden rise in implied volatility."
        )
        assert ";" not in out
        assert "avoided. The main risk" in out

    def test_a_headline_takes_a_comma_not_a_full_stop(self):
        # A title split by a period reads as two failed headlines.
        title = ai._report_title(
            {"headline": "NVDA Is the Superior Risk-adjusted Buy; MU Is the Clear Avoid"}, None, None)
        assert ";" not in title
        assert "." not in title
        assert "Buy, MU" in title

    def test_a_semicolon_inside_brackets_is_a_list_not_a_clause(self):
        out = ai._split_on_semicolons("Three drivers (return; strength; valuation) support it.")
        assert ";" not in out
        assert "return, strength, valuation" in out


class TestFirstPerson:
    def test_we_are_highly_confident_becomes_the_finding(self):
        out = ai._strip_first_person(
            "We are highly confident that NVDA is the preferred risk-adjusted buy.")
        assert not out.lower().startswith("we")
        assert out.startswith("NVDA is the preferred")

    def test_in_our_view_is_dropped(self):
        assert "our" not in ai._strip_first_person("In our view, MU is the avoid.").lower()

    def test_an_unrelated_we_is_left_alone(self):
        # Only the narrator constructions are targeted.
        assert ai._strip_first_person("Weighted average cost of capital is 9%.") \
            == "Weighted average cost of capital is 9%."


class TestDuplicatedWords:
    def test_upside_limited_upside_collapses(self):
        out = ai._fix_duplicated_words(
            "indicating upside-limited upside and heightened downside risk")
        assert out.lower().count("upside") == 1
        assert "heightened downside risk" in out


class TestKeyFigures:
    def test_a_placeholder_is_not_a_figure(self):
        for bad in ("Data not provided in supplied clips", "N/A", "not available",
                    "unavailable", "—", "TBD", "none"):
            assert not ai._is_real_figure(bad), bad

    def test_a_measurement_is_a_figure(self):
        for good in ("1.42", "12.0%", "$280", "23.0%", "0.58x"):
            assert ai._is_real_figure(good), good

    def test_a_bare_phrase_is_not_a_figure(self):
        # A strip of headline numbers is not the place for a sentence.
        assert not ai._is_real_figure("Recovery expected")


class TestUnavailableContradiction:
    def test_prose_cannot_assert_what_the_strip_says_is_missing(self):
        sections = [{
            "templateSection": "risks",
            "heading": "Risks",
            "keyFigures": [{"label": "90-day drawdown (MU)",
                            "value": "Data not provided in supplied clips"}],
            "analysis": (
                "Macro evidence points to a slowdown in AI spending. "
                "The price-history clip shows a recent 90-day drawdown that exceeds "
                "historical averages."
            ),
        }]
        ai._filter_unverified_key_figures(sections, [], None)
        assert sections[0]["keyFigures"] == [], "the placeholder should be gone"
        ai._reconcile_unavailable_figures(sections)
        analysis = sections[0]["analysis"]
        assert "shows a recent 90-day drawdown" not in analysis
        assert "do not quantify" in analysis
        assert "slowdown in AI spending" in analysis, "unrelated prose must survive"
        assert "_unavailableFigures" not in sections[0], "internal key must not leak"


class TestStaleForwardDates:
    def _catalysts(self):
        return [{
            "templateSection": "catalysts",
            "heading": "Catalysts",
            "keyFigures": [
                {"label": "NVDA AI-chip launch", "value": "Q3 2024 (Oct)"},
                {"label": "AMD GPU rollout", "value": "Q4 2024 (Nov)"},
                {"label": "MU DRAM price cycle", "value": "Recovery expected Q3-Q4 2024"},
                {"label": "NVDA FY revenue growth", "value": "23.0%"},
            ],
            "analysis": (
                "NVDA's Q3 AI-chip launch is slated for Q3 2024. "
                "Monitoring shipment volumes will confirm the outlook."
            ),
        }]

    def test_catalysts_dated_two_years_ago_are_dropped(self):
        sections = self._catalysts()
        ai._drop_stale_forward_dates(sections, NOW)
        values = [f["value"] for f in sections[0]["keyFigures"]]
        assert values == ["23.0%"], "only the undated present-tense metric survives"

    def test_the_paragraph_loses_the_stale_date_too(self):
        sections = self._catalysts()
        ai._drop_stale_forward_dates(sections, NOW)
        analysis = sections[0]["analysis"]
        assert "2024" not in analysis
        assert "Monitoring shipment volumes" in analysis

    def test_a_historical_metric_keeps_its_past_year(self):
        # FY2024 revenue is history, not a catalyst, and must survive.
        sections = [{
            "templateSection": "operating-comparison",
            "heading": "Operating Comparison",
            "keyFigures": [{"label": "NVDA FY2024 revenue growth", "value": "23.0%"}],
            "analysis": "NVDA posted FY2024 revenue growth of 23%.",
        }]
        ai._drop_stale_forward_dates(sections, NOW)
        assert len(sections[0]["keyFigures"]) == 1
        assert "FY2024" in sections[0]["analysis"]

    def test_a_future_dated_catalyst_survives(self):
        sections = [{
            "templateSection": "catalysts",
            "heading": "Catalysts",
            "keyFigures": [{"label": "NVDA earnings", "value": "2026-08-26"}],
            "analysis": "NVDA reports on 2026-08-26.",
        }]
        ai._drop_stale_forward_dates(sections, NOW)
        assert len(sections[0]["keyFigures"]) == 1


class TestChartPlacement:
    def test_the_multiples_chart_goes_to_the_valuation_section(self, monkeypatch):
        """Figure 1 in the shipped report was a peer-multiples bar chart sitting
        under "Relative Call", whose paragraph argues Sharpe ratios and
        drawdowns, while "Valuation Comparison" carried no figure at all."""
        multiples = {"chartType": "bar", "title": "NVDA multiples vs peer median",
                     "xKey": "metric", "series": [{"key": "nvda", "label": "NVDA"}],
                     "data": [{"metric": "P/E", "nvda": 34.5}]}
        sharpe = {"chartType": "bar", "title": "Monte Carlo Sharpe by name",
                  "xKey": "name", "series": [{"key": "sharpe", "label": "Sharpe"}],
                  "data": [{"name": "NVDA", "sharpe": 1.42}]}
        monkeypatch.setattr(ai, "_mechanical_chart_pool", lambda clips: [
            (multiples, ["multiple", "valuation", "ev/ebitda"], 1),
            (sharpe, ["sharpe", "risk-adjusted", "relative"], 1),
        ])
        sections = [
            {"templateSection": "relative-call", "heading": "Relative Call",
             "analysis": "Monte Carlo shows NVDA delivering a Sharpe ratio of 1.42, "
                         "the clear risk-adjusted preference."},
            {"templateSection": "valuation-comparison", "heading": "Valuation Comparison",
             "analysis": "NVDA trades at a PE premium to the sector median, yet its "
                         "EV/EBITDA multiple remains in line once growth is accounted for."},
        ]
        ai._inject_mechanical_charts(sections, [])
        assert sections[1]["chart"] is not None, "the valuation section must get a figure"
        assert sections[1]["chart"]["title"] == multiples["title"]
        assert sections[0]["chart"]["title"] == sharpe["title"]
