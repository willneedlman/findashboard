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
        for key in ("coverage", "unresolvedGaps", "requiredSourceIds"):
            assert key not in out["dataBank"]

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
