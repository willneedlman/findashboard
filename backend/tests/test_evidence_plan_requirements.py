"""The user's requirements must reach evidence selection.

Requirement 3 of the AI Momentum Trade report asked for each name's 90-day
realised volatility and its current ATM implied vol, with the gap called out.
The planner selected "volatility-skew", whose clip then reported that it did
not contain those figures. "options" yields exactly them. Both tools carry the
volatility_regime tag, and ranking never looked past the tag.
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))

from reporting.evidence_plan import Availability, Question, shortlist  # noqa: E402
from reporting.tool_registry import REPORT_TOOL_BY_ID  # noqa: E402
from routers.ai import requirement_terms  # noqa: E402

VOL_QUESTION = Question(
    text="How does implied volatility compare with realised volatility?",
    tags=("volatility_regime",),
)
REQUIREMENT = ("Each name's 90-day realised volatility and its current ATM implied vol, "
               "with the gap called out")


def _availability():
    return Availability(has_symbols=True, symbol_count=4)


def _rank(required_terms=frozenset()):
    return [t.id for t in shortlist(
        VOL_QUESTION, _availability(), size=8, required_terms=required_terms)]


class TestYieldsDriveSelection:
    def test_the_registry_still_holds_the_two_tools_this_is_about(self):
        assert "30-day realised volatility" in REPORT_TOOL_BY_ID["options"].yields
        assert "IV minus RV spread" in REPORT_TOOL_BY_ID["options"].yields
        skew = " ".join(REPORT_TOOL_BY_ID["volatility-skew"].yields)
        assert "realised volatility" not in skew

    def test_the_requirement_promotes_the_tools_that_yield_it(self):
        """The requirement names both halves of the gap, ATM implied and
        realised, and those live in two different tools. Both must reach the
        top of the shortlist, ahead of tools that share the tag and yield
        neither: dealer gamma and the FX matrix ranked first and second for
        this question, and "options" sat fifth."""
        terms = frozenset(requirement_terms(REQUIREMENT))
        ranked = _rank(terms)
        assert set(ranked[:2]) == {"options", "volatility-skew"}
        for irrelevant in ("dealer-gex", "fx-matrix"):
            assert ranked.index(irrelevant) > ranked.index("options")

    def test_it_is_a_promotion_not_the_previous_order(self):
        before, after = _rank(), _rank(frozenset(requirement_terms(REQUIREMENT)))
        assert before[:2] == ["dealer-gex", "fx-matrix"], "the behaviour being fixed"
        assert before.index("options") > after.index("options")

    def test_ranking_is_unchanged_when_nothing_was_required(self):
        # No requirements means the existing tag-and-class ranking stands.
        assert _rank() == _rank(frozenset())

    def test_an_unrelated_requirement_does_not_reshuffle_anything(self):
        terms = frozenset(requirement_terms("State the market cap for each name"))
        # "cap" and "basis" appear in no volatility tool's yields, so this
        # question's ranking is untouched.
        assert _rank(terms) == _rank()
