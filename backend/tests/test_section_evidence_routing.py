"""A section must be given the clips that argue its own case.

From a real report, 2026-08-25: the section "Concentration and Exposure" printed
"No sector weights, top-five position shares, or derivative limits are present"
directly above Figure 3, a sector-weights chart. "Return and Drawdown" said SPY
drawdown was "not provided in the clips" while page 4 printed it.

The cause was lexical. Sections are named in abstract language ("concentration",
"exposure") and clips are titled in concrete language ("Direct Issuer Sector
Weights", "Holding-level beta"), so literal word overlap scored ZERO and the
section fell back to the globally top-ranked clips, which belonged to whichever
section happened to rank first.
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))

from routers.ai import (  # noqa: E402
    _section_payload, expand_section_terms, requirement_terms,
)

SECTOR = "Fidelity Individual Direct Issuer Sector Weights"
BETA = "Holding-level beta and portfolio risk contribution"
DRAWDOWN = "Fidelity Individual drawdown vs SPY"
SHOCK = "Fidelity Individual market-shock scenario losses"
FED = "Market-implied Fed Funds path"
ALL = [SECTOR, BETA, DRAWDOWN, SHOCK, FED]


def _rank(heading, argues, template, titles=ALL):
    payload = {"dataBank": {"evidence": [{"id": t, "title": t} for t in titles]}}
    out = _section_payload(payload, {
        "heading": heading, "argues": argues, "templateSection": template,
    })
    return [clip["title"] for clip in out["dataBank"]["evidence"]]


class TestASectionGetsItsOwnEvidenceFirst:
    def test_concentration_leads_with_the_sector_weights(self):
        # The exact failure: this scored zero against every clip in the bank.
        assert _rank("Concentration and Exposure", "concentration",
                     "concentration-and-exposure")[0] == SECTOR

    def test_drawdown_leads_with_the_drawdown_series(self):
        assert _rank("Return and Drawdown", "return drawdown",
                     "return-and-drawdown")[0] == DRAWDOWN

    def test_factor_risk_leads_with_the_beta_evidence(self):
        assert _rank("Correlation and Factor Risk", "factor exposure",
                     "correlation-and-factor-risk")[0] == BETA

    def test_downside_leads_with_the_shock_scenarios(self):
        assert _rank("Downside Scenarios", "loss under stress",
                     "downside-scenarios")[0] == SHOCK

    def test_an_unrelated_clip_is_never_first(self):
        for heading, argues, template in [
            ("Concentration and Exposure", "concentration", "concentration-and-exposure"),
            ("Return and Drawdown", "return drawdown", "return-and-drawdown"),
            ("Correlation and Factor Risk", "factor exposure", "correlation-and-factor-risk"),
            ("Downside Scenarios", "loss under stress", "downside-scenarios"),
        ]:
            assert _rank(heading, argues, template)[0] != FED


class TestTheVocabulariesAreBridged:
    """The concept map is the whole mechanism; without it every assertion above
    passes only by the accident of global ordering."""

    def test_a_section_word_reaches_the_words_clips_use(self):
        assert "sector" in expand_section_terms({"concentration"})
        assert "weight" in expand_section_terms({"concentration"})
        assert "beta" in expand_section_terms({"factor"})
        assert "scenario" in expand_section_terms({"downside"})

    def test_expansion_never_returns_the_section_words_themselves(self):
        # They are already scored, at double weight; counting them twice would
        # flatten the distinction between a direct hit and a concept hit.
        terms = {"concentration", "exposure"}
        assert not (expand_section_terms(terms) & terms)

    def test_a_direct_hit_still_outranks_a_concept_hit(self):
        want = requirement_terms("Return and Drawdown return drawdown")
        concepts = expand_section_terms(want)
        direct = requirement_terms(DRAWDOWN)          # carries "drawdown" itself
        indirect = requirement_terms(SHOCK)           # only a concept match
        score = lambda ct: 2 * len(want & ct) + len(concepts & ct)
        assert score(direct) > score(indirect)


def test_ordering_does_not_drop_or_duplicate_evidence():
    # It reorders; the fit is what sheds. Losing a clip here would be silent.
    ranked = _rank("Concentration and Exposure", "concentration", "concentration-and-exposure")
    assert sorted(ranked) == sorted(ALL)
