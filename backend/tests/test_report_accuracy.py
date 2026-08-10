"""Deterministic accuracy guardrails for the Report Creator's prose.

Every case here is a real defect found in an exported note. The writer runs on a
free model that cannot be trusted to compare two numbers, so none of these
repairs are asked of it: each one is computed from the clips and applied after
generation. Network-free (no LLM calls).
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))

from routers.ai import (  # noqa: E402
    ReportClipIn,
    _beta_coherence_note,
    _beta_source_conflict_note,
    _drop_impossible_upside_claims,
    _fix_explanatory_power_claims,
    _fix_upside_sign_vocabulary,
    _repair_key_figures,
    _disambiguate_portfolio_beta,
    _fix_availability_contradictions,
    _fix_dcf_direction,
    _fix_risk_adjusted_claims,
    _fix_sector_share_claims,
    _fix_spliced_beta_range,
    _holding_beta_maps,
    _portfolio_alpha,
    _reframe_action_headline,
    _strip_em_dashes,
    _suppress_extreme_dcf_claims,
)


def _clip(id_, title, summary, source="Portfolio Manager", data_type="table"):
    return ReportClipIn(
        id=id_, sourceTab=source, dataType=data_type, title=title,
        dataSummary=summary, userDescription="", evidenceDomain="portfolio",
    )


FACTOR_BETAS = _clip(
    "factor-betas",
    "Holding-level beta and portfolio risk contribution",
    "Columns: Ticker | Weight % | Market beta | Book variance share %\n"
    "NVDA | 14.3 | 2.3548 | 8.9\n"
    "MSFT | 7.3 | 1.1316 | 3.3\n"
    "NBIS | 6.2 | 6.2524 | 13.2\n"
    "TOST | 8.8 | 1.181 | 2.5",
)

CORRELATION_BETAS = _clip(
    "correlation-betas",
    "Beta vs SPY",
    "Columns: Ticker | Beta\n"
    "NVDA | 1.83\n"
    "MSFT | 0.94\n"
    "NBIS | 3.62\n"
    "TOST | 0.70",
)

AMZN_DCF = _clip(
    "amzn-dcf",
    "AMZN DCF verdict",
    "Intrinsic / Share: $22.65; Market Price: $274.48",
    source="Valuation",
    data_type="kpi",
)

SECTORS = _clip(
    "sectors",
    "Fidelity Individual · Direct issuer sector allocation",
    "Columns: Classification | Portfolio weight % | Basis\n"
    "Technology | 55.79 | Provider classification\n"
    "Industrials | 10.81 | Provider classification\n"
    "Communication Services | 5.82 | Provider classification\n"
    "Cash | 6.58 | Portfolio cash balance",
)

RISK_METRICS = _clip(
    "risk",
    "Risk metrics",
    "Active return vs SPY: +16.0%; Portfolio single-factor beta vs SPY: 2.15; "
    "Benchmark return: +14.6%; Portfolio max drawdown: -25.8%",
    data_type="kpi",
)

FACTOR_MODEL = _clip(
    "factor-model",
    "Macro factor model coefficients",
    "Columns: Factor | Proxy | Beta | T-statistic\n"
    "Market | SPY | 2.565 | 10.77\n"
    "Credit | HYG | -0.897 | -0.95",
)

METHODOLOGY = _clip(
    "method",
    "Fidelity Individual · Performance methodology",
    "Columns: Item | Definition\n"
    "Sharpe / Sortino | Annualized daily excess return · 3.740% risk-free rate",
)


class TestDcfDirection:
    def test_discount_without_the_word_value_is_still_reversed(self):
        """The live pattern required "intrinsic value"; the cover said
        "discount to intrinsic" and shipped the claim backwards."""
        text = "Per DCF, AMZN trades at a 92% discount to intrinsic."
        fixed = _fix_dcf_direction(text, [AMZN_DCF])
        assert "discount to intrinsic" not in fixed
        assert "91.7% downside" in fixed

    def test_a_genuinely_cheap_name_keeps_its_discount(self):
        cheap = _clip(
            "cheap-dcf", "XYZ DCF verdict",
            "Intrinsic / Share: $150.00; Market Price: $100.00",
            source="Valuation", data_type="kpi",
        )
        text = "XYZ trades at a 33% discount to intrinsic value."
        assert _fix_dcf_direction(text, [cheap]) == text

    def test_an_order_of_magnitude_gap_is_a_model_failure_not_a_finding(self):
        text = (
            "DCF valuations reveal severe over-pricing for AMZN (intrinsic $22.65 vs "
            "price $274.48). Concentration remains the dominant risk."
        )
        fixed = _suppress_extreme_dcf_claims(text, [AMZN_DCF])
        assert "$22.65 vs price" not in fixed
        assert "not decision-grade" in fixed
        assert "Concentration remains the dominant risk." in fixed


class TestBetaProvenance:
    def test_both_panels_are_read(self):
        maps = _holding_beta_maps([FACTOR_BETAS, CORRELATION_BETAS])
        assert len(maps) == 2
        assert maps[0][1]["MSFT"] == 1.1316
        assert maps[1][1]["MSFT"] == 0.94

    def test_a_range_spliced_across_two_panels_is_rebuilt_from_one(self):
        """0.70 came from one panel and 6.25 from the other; no single estimate
        ever contained that range."""
        text = "Holding-level beta ranges from 0.70 (TOST) to 6.25 (NBIS)."
        fixed = _fix_spliced_beta_range(text, [FACTOR_BETAS, CORRELATION_BETAS])
        assert "0.70" not in fixed
        assert "1.13 (MSFT)" in fixed and "6.25 (NBIS)" in fixed

    def test_a_range_inside_one_panel_is_left_alone(self):
        text = "Holding-level beta ranges from 1.13 to 6.25 across the book."
        assert _fix_spliced_beta_range(text, [FACTOR_BETAS]) == text

    def test_disagreeing_panels_are_disclosed(self):
        note = _beta_source_conflict_note([FACTOR_BETAS, CORRELATION_BETAS])
        assert note and "different windows" in note
        assert _beta_source_conflict_note([FACTOR_BETAS]) is None

    def test_two_portfolio_betas_are_each_named(self):
        text = "The book carries a 2.15 beta, and the regression reports beta of 2.565."
        fixed = _disambiguate_portfolio_beta(text, [RISK_METRICS, FACTOR_MODEL])
        assert "2.15 single-factor beta" in fixed
        assert "macro-factor regression beta of 2.565" in fixed


class TestSectorShare:
    def test_an_unsourced_aggregate_is_recomputed(self):
        """71% appeared nowhere in the sector table. It was the market factor's
        variance share from the next page."""
        text = "Direct sector classification shows 71% of assets in tech-related categories."
        fixed = _fix_sector_share_claims(text, [SECTORS])
        assert "71%" not in fixed
        assert "55.79%" in fixed and "61.61%" in fixed

    def test_a_correct_claim_survives(self):
        text = "Technology is 55.79% of portfolio weight by direct sector classification."
        assert _fix_sector_share_claims(text, [SECTORS]) == text

    def test_a_concentration_claim_is_not_a_sector_claim(self):
        text = "The top five holdings represent 43% of the book, concentrated in technology."
        assert _fix_sector_share_claims(text, [SECTORS]) == text


class TestAttributionClaims:
    def test_alpha_is_computed_from_the_evidence(self):
        alpha = _portfolio_alpha([RISK_METRICS, METHODOLOGY])
        # 16.0 + (1 - 2.15)(14.6 - 3.74) = +3.51 points
        assert alpha is not None and abs(alpha - 3.51) < 0.05

    def test_pure_market_exposure_is_replaced_with_the_measured_alpha(self):
        text = "The Sharpe of 1.73 versus 2.04 shows the excess is pure market exposure."
        fixed = _fix_risk_adjusted_claims(text, [RISK_METRICS, METHODOLOGY])
        assert "pure market exposure" not in fixed
        assert "+3.5 points" in fixed

    def test_without_the_inputs_the_claim_is_removed_not_guessed(self):
        text = "The excess is pure market exposure."
        fixed = _fix_risk_adjusted_claims(text, [RISK_METRICS])
        assert "pure market exposure" not in fixed
        assert "not determined" in fixed


class TestAvailabilityContradictions:
    def test_absent_evidence_claim_is_corrected_when_the_figure_is_on_the_page(self):
        sections = [{"chart": {"title": "Consensus upside across the peer set"}}]
        text = "No analyst consensus figures are available, so the valuation picture is mixed."
        fixed = _fix_availability_contradictions(text, sections, [])
        assert "No analyst consensus figures are available" not in fixed
        assert "peer set" in fixed

    def test_a_genuine_gap_stands(self):
        text = "No analyst consensus figures are available for the book."
        assert _fix_availability_contradictions(text, [], []) == text


class TestHouseVoice:
    def test_a_pair_of_em_dashes_becomes_parentheses(self):
        text = "The top five holdings—NVDA, ORCL, MSFT—represent 43% of the book."
        assert _strip_em_dashes(text) == "The top five holdings (NVDA, ORCL, MSFT) represent 43% of the book."

    def test_a_lone_em_dash_becomes_a_comma(self):
        assert _strip_em_dashes("Beta is high—risk follows.") == "Beta is high, risk follows."

    def test_en_dashes_survive_because_they_carry_ranges(self):
        assert _strip_em_dashes("Fair value is $280–$310.") == "Fair value is $280–$310."


class TestHeadlineAgreement:
    def test_an_instruction_headline_becomes_the_measured_finding(self):
        """The note's own conclusion said it could not support a trade while its
        title told the reader to make one."""
        headline = _reframe_action_headline(
            "Trim High-beta Tech, Rebalance for Risk-adjusted Efficiency",
            [RISK_METRICS, FACTOR_MODEL],
            {"value": "Beta-driven outperformance"},
        )
        assert "Trim" not in headline and "Rebalance" not in headline
        assert "16.0 Points" in headline and "2.15 Beta" in headline

    def test_a_finding_headline_is_untouched(self):
        headline = "Beta-driven Outperformance, Over-valued Top Holdings"
        assert _reframe_action_headline(headline, [RISK_METRICS], None) == headline


UPSIDE_SECTION = [{
    "keyFigures": [
        {"label": "AMZN upside to intrinsic", "value": "-91.9%"},
        {"label": "JOBY upside to intrinsic", "value": "-158.7%"},
        {"label": "Technology sector weight", "value": "71%"},
    ],
}]

HOLDING_BETAS = _clip(
    "holding-betas",
    "Holding-level beta and portfolio risk contribution",
    "Columns: Ticker | Weight % | Market beta\n"
    "NVDA | 13.9 | 1.49\nORCL | 9.8 | 1.67\nTOST | 9.1 | 1.38\n"
    "MSFT | 7.4 | 1.08\nJOBY | 6.9 | 2.47\nAMZN | 6.5 | 1.31",
)

FACTOR_CONTRIBUTION = _clip(
    "contribution", "Factor exposure",
    "Market factor contribution: 51.8%; Market factor beta: 1.683",
    data_type="kpi",
)


class TestValuationSigns:
    def test_a_negative_upside_is_not_undervaluation(self):
        text = "JOBY is deeply undervalued (-158.7% upside) and MSFT shows a modest discount (-59.8% upside)."
        fixed = _fix_upside_sign_vocabulary(text)
        assert "undervalued" not in fixed
        assert "overvalued" in fixed
        assert "discount" not in fixed

    def test_a_real_discount_keeps_its_word(self):
        text = "XYZ is undervalued (+42.0% upside)."
        assert _fix_upside_sign_vocabulary(text) == text

    def test_an_upside_past_minus_one_hundred_is_struck(self):
        text = (
            "JOBY shows -158.7% upside to intrinsic value. Concentration remains the dominant risk."
        )
        fixed = _drop_impossible_upside_claims(text, [])
        assert "-158.7%" not in fixed
        assert "not attainable" in fixed
        assert "Concentration remains the dominant risk." in fixed


class TestKeyFigureRepair:
    def test_the_rail_gets_the_same_correction_as_the_paragraph(self):
        sections = [{"keyFigures": list(UPSIDE_SECTION[0]["keyFigures"])}]
        _repair_key_figures(sections, [SECTORS])
        values = {figure["label"]: figure["value"] for figure in sections[0]["keyFigures"]}
        assert values["Technology sector weight"] == "55.79%"

    def test_an_impossible_upside_figure_is_dropped(self):
        sections = [{"keyFigures": list(UPSIDE_SECTION[0]["keyFigures"])}]
        _repair_key_figures(sections, [SECTORS])
        labels = [figure["label"] for figure in sections[0]["keyFigures"]]
        assert "JOBY upside to intrinsic" not in labels
        assert "AMZN upside to intrinsic" in labels


class TestBetaCoherence:
    def test_a_book_beta_outside_its_holdings_range_is_disclosed(self):
        note = _beta_coherence_note([RISK_METRICS, HOLDING_BETAS])
        assert note and "does not reconcile" in note
        assert "1.55" in note and "2.47" in note

    def test_a_coherent_book_beta_is_silent(self):
        coherent = _clip(
            "coherent-risk", "Risk metrics",
            "Portfolio single-factor beta vs SPY: 1.55", data_type="kpi",
        )
        assert _beta_coherence_note([coherent, HOLDING_BETAS]) is None


class TestExplanatoryPower:
    def test_two_meanings_of_explains_are_separated(self):
        text = "Beta explains ~98% of the YTD gain."
        fixed = _fix_explanatory_power_claims(text, [FACTOR_CONTRIBUTION])
        assert "explains ~98%" not in fixed
        assert "98% of the beta-implied return" in fixed
        assert "51.8% of return to the market factor" in fixed
