"""A request that cannot fit must not be sent.

Production logged "instructions take 9572 of a 7040 budget" and then sent the
request anyway: every section tried four models, each retried three times on
Groq and three on Cerebras, and the browser lost the connection first. The user
saw "the origin web server returned an invalid or incomplete response", which
points at the server rather than at a report asking for more than a call allows.
"""
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))

import pytest  # noqa: E402

import routers.ai as ai  # noqa: E402
from ai_client import MODEL_OSS, MODEL_TPM  # noqa: E402
from fastapi import HTTPException  # noqa: E402


def _huge_prompt():
    # Larger than the whole per-minute bucket, which is what production had.
    return "S" * int(9_500 * 3.4)


def test_an_impossible_request_is_flagged_rather_than_sized():
    _, _, fit = ai._fit_report_request(
        _huge_prompt(), {"dataBank": {"evidence": []}}, 1800,
        ceiling=MODEL_TPM[MODEL_OSS], model=MODEL_OSS)
    assert fit["unfittable"] is True
    assert fit["instructionTokens"] > fit["budget"]


def test_a_fittable_request_carries_no_such_flag():
    _, _, fit = ai._fit_report_request(
        "short", {"dataBank": {"evidence": []}}, 700,
        ceiling=MODEL_TPM[MODEL_OSS], model=MODEL_OSS)
    assert "unfittable" not in fit


def test_the_section_writer_refuses_before_calling_the_provider(monkeypatch):
    called = []
    monkeypatch.setattr(ai, "groq_chat", lambda *a, **k: called.append(1))
    # A section builds its own instructions now, so the only way to make one
    # impossible is to require more than a call can hold.
    huge_requirements = ai._must_include_section("\n".join(["R" * 400] * 70))
    with pytest.raises(HTTPException) as excinfo:
        ai._generate_one_section(
            {"dataBank": {"evidence": []}},
            {"templateSection": "valuation", "heading": "Valuation", "argues": "x"},
            ["Risks"], MODEL_OSS, 700, {"c1"}, huge_requirements, {"multiples"})
    assert not called, "no provider call may be made for a doomed request"
    assert "leave no room for an answer" in excinfo.value.detail


class TestSectionPayloadIsTrimmed:
    def _payload(self):
        return {
            "projectName": "P", "goal": "g", "purpose": "p",
            "templateContract": {"id": "comparison", "sections": [{"key": "a"}] * 8},
            "outline": {"thesis": "t", "sections": [{"templateSection": "a"}] * 8},
            "dataBank": {
                "evidence": [{"id": "c1", "title": "Peer multiples"},
                             {"id": "c2", "title": "Correlation matrix"}],
                "valuationContext": {"note": "keep me"},
                "coverage": {"x": 1}, "unresolvedGaps": ["g"], "requiredSourceIds": ["s"],
            },
        }

    def test_the_whole_report_scaffolding_is_dropped(self):
        out = ai._section_payload(self._payload(), {
            "heading": "Valuation", "argues": "multiples", "templateSection": "valuation"})
        # The section's own brief and its siblings are already in the system
        # prompt, so repeating every section's contract just costs evidence.
        assert "templateContract" not in out
        assert "outline" not in out
        # coverage and unresolvedGaps stay. The prompt tells the writer to state
        # decision-relevant gaps from them, and they cost a few dozen tokens now
        # that the research record is no longer sent whole.
        assert out["dataBank"]["coverage"] == {"x": 1}
        assert out["dataBank"]["unresolvedGaps"] == ["g"]

    def test_what_the_writer_reads_survives(self):
        out = ai._section_payload(self._payload(), {
            "heading": "Valuation", "argues": "multiples", "templateSection": "valuation"})
        assert out["goal"] == "g" and out["purpose"] == "p"
        assert out["dataBank"]["valuationContext"] == {"note": "keep me"}
        assert len(out["dataBank"]["evidence"]) == 2

    def test_it_is_smaller_than_what_it_replaced(self):
        raw = self._payload()
        out = ai._section_payload(raw, {
            "heading": "Valuation", "argues": "multiples", "templateSection": "valuation"})
        size = lambda o: len(json.dumps(o, ensure_ascii=False))
        assert size(out) < size(raw)


class TestWriterBankCarriesOnlyWhatIsRead:
    """Measured in production: the dataBank sent to the model was 3,445 tokens
    with the evidence already shed to zero, on a 7,040 budget. It was the whole
    client research record, one entry per run with its targets, clip ids and
    missing targets, plus the objective plan and the source id lists. The prompt
    refers to dataBank.coverage and dataBank.unresolvedGaps and nothing else."""

    def _meta(self):
        return {
            "phase": "ready",
            "requiredSourceIds": [f"src-{i}" for i in range(32)],
            "criticalSourceIds": [f"src-{i}" for i in range(5)],
            "runs": [{"sourceId": f"src-{i}", "status": "complete",
                      "targets": ["NVDA", "AMD"], "clipIds": [f"c{i}"],
                      "missingTargets": [], "error": ""} for i in range(32)],
            "objectivePlan": {"thesis": "t" * 400, "requiredDataPoints": ["d" * 60] * 20},
            "coverage": {"requestedTargets": 4, "coveredTargets": 4},
            "unresolvedGaps": ["gap one"],
        }

    def _writer_bank(self, meta):
        # The shape routers.ai builds for the prompt.
        return {
            "evidence": [],
            "valuationContext": {"note": "n"},
            "coverage": meta.get("coverage", {}),
            "unresolvedGaps": meta.get("unresolvedGaps", []),
        }

    def test_the_research_record_is_not_sent_to_the_writer(self):
        bank = self._writer_bank(self._meta())
        for key in ("runs", "objectivePlan", "criticalSourceIds", "requiredSourceIds", "phase"):
            assert key not in bank

    def test_what_the_prompt_names_is_still_there(self):
        bank = self._writer_bank(self._meta())
        assert bank["coverage"] == {"requestedTargets": 4, "coveredTargets": 4}
        assert bank["unresolvedGaps"] == ["gap one"]
        assert "evidence" in bank and "valuationContext" in bank

    def test_it_is_an_order_of_magnitude_smaller(self):
        meta = self._meta()
        full = {**meta, "evidence": [], "valuationContext": {"note": "n"}}
        slim = self._writer_bank(meta)
        size = lambda o: ai._estimate_tokens(json.dumps(o, ensure_ascii=False))
        assert size(slim) * 5 < size(full), (
            f"slim={size(slim)} full={size(full)}; the whole point is the difference"
        )


class TestSectionPromptIsBuiltForOneSection:
    """Measured in production: the section prompt was 5,283 tokens of a 7,040
    budget, because a section was handed the whole report's instructions and
    then 458 more tokens telling it to ignore the parts that did not apply.
    With the payload it left nothing at all for evidence."""

    SECTION = {"templateSection": "valuation-comparison",
               "heading": "Valuation Comparison", "argues": "peer multiples"}
    SIBLINGS = ["Relative Call", "Risks"]
    FLAGS = {"multiples", "options"}

    def _prompt(self, must=""):
        return ai._section_system_prompt(must, self.SECTION, self.SIBLINGS, self.FLAGS)

    def test_the_house_voice_and_accuracy_guards_survive(self):
        p = self._prompt()
        assert "EQUITY-RESEARCH EDITORIAL STANDARD" in p, "the voice is not negotiable"
        assert "Never invent prices" in p, "the guards are what stop invented figures"

    def test_the_section_gets_its_own_brief_and_schema(self):
        p = self._prompt()
        assert "valuation-comparison" in p and "Valuation Comparison" in p
        assert "Relative Call" in p, "siblings tell it what not to write"
        assert '"keyFigures"' in p

    def test_the_users_requirements_are_carried(self):
        p = self._prompt(ai._must_include_section("State the market cap for each name"))
        assert "market cap" in p

    def test_what_a_section_cannot_use_is_gone(self):
        p = self._prompt()
        # The whole-report schema: this call returns one section.
        assert '"executiveSummary"' not in p
        assert '"stance"' not in p
        # The outline and the report-wide contract are not sent in a section
        # payload any more, so instructions about them would point at nothing.
        assert "outline.thesis" not in p
        assert "SELECTED TEMPLATE" not in p

    def test_it_is_far_smaller_than_the_whole_report_prompt(self):
        from reporting.pipeline import template_contract
        whole = ai._report_system_prompt(
            "open", "medium", "", "comparison", False,
            template_contract("comparison", "medium"), "standard", self.FLAGS)
        assert ai._estimate_tokens(self._prompt()) < ai._estimate_tokens(whole) * 0.75

    def test_a_section_call_now_leaves_room_for_evidence(self):
        from ai_client import MODEL_OSS, MODEL_TPM, completion_cost
        budget = int(MODEL_TPM[MODEL_OSS] * ai._REPORT_TPM_SAFETY)
        payload_skeleton = 1133          # measured in production
        answer = completion_cost(MODEL_OSS, ai._SECTION_MIN_TOKENS)
        room = budget - ai._estimate_tokens(self._prompt()) - payload_skeleton - answer
        assert room > 800, f"only {room} tokens left for the evidence the section argues from"


class TestASqueezedAnswerStaysBigEnoughToBeOne:
    """A whole report squeezed into a few hundred tokens comes back as a
    truncated JSON object. It fails to parse, and the endpoint answered a bare
    502, which the edge replaced with "the origin web server returned an invalid
    or incomplete response" — so the user saw a server fault instead of a
    rate-limited writer."""

    def _fit(self, prompt_tokens, min_output):
        return ai._fit_report_request(
            "S" * int(prompt_tokens * 3.4), {"dataBank": {"evidence": []}}, 4000,
            ceiling=MODEL_TPM[MODEL_OSS], model=MODEL_OSS, min_output=min_output)

    def test_a_report_is_not_squeezed_into_a_fragment(self):
        # Room for a few hundred tokens only: not a report, so say so.
        _, _, fit = self._fit(5_400, ai._REPORT_MIN_OUTPUT_TOKENS)
        assert fit.get("unfittable") is True

    def test_a_report_with_real_room_is_squeezed_rather_than_refused(self):
        _, tokens, fit = self._fit(3_700, ai._REPORT_MIN_OUTPUT_TOKENS)
        assert not fit.get("unfittable")
        assert tokens >= ai._REPORT_MIN_OUTPUT_TOKENS // 2

    def test_a_section_may_go_smaller_than_a_report(self):
        # A section object is far smaller, so its viable floor is lower.
        _, tokens, fit = self._fit(5_400, ai._SECTION_MIN_TOKENS)
        assert not fit.get("unfittable")
        assert tokens >= max(ai._ABSOLUTE_MIN_OUTPUT, ai._SECTION_MIN_TOKENS // 2)
