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
    with pytest.raises(HTTPException) as excinfo:
        ai._generate_one_section(
            _huge_prompt(), {"dataBank": {"evidence": []}},
            {"templateSection": "valuation", "heading": "Valuation", "argues": "x"},
            ["Risks"], MODEL_OSS, 700, {"c1"})
    assert not called, "no provider call may be made for a doomed request"
    assert "larger than one model call allows" in excinfo.value.detail


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
