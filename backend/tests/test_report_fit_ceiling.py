"""The request has to fit the bucket the call will actually use.

The user saw "The request was larger than groq accepts in one call" on a report
that had already been trimmed. Two independent reasons, both here.
"""
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))

import routers.ai as ai  # noqa: E402
from ai_client import MODEL_OSS, MODEL_POOL, MODEL_TPM, completion_cost  # noqa: E402

SYS_PROMPT = "S" * int(3700 * 3.4)   # the measured report system prompt


def _payload(n=101):
    return {"dataBank": {"evidence": [
        {"id": f"c{i}", "title": f"clip {i}", "body": "x" * 400} for i in range(n)]}}


def _reserved(sys_prompt, payload, answer, model):
    return (ai._estimate_tokens(sys_prompt)
            + ai._estimate_tokens(json.dumps(payload, ensure_ascii=False))
            + completion_cost(model, answer))


def test_the_default_ceiling_matches_the_tightest_pool_bucket():
    # It was 12000, left from a model that no longer exists, while every model
    # the call can land on is metered at 8000.
    assert ai._REPORT_TPM_CEILING == min(MODEL_TPM[m] for m in MODEL_POOL)


def test_the_whole_report_call_fits_after_shedding():
    # Previously impossible: prompt 3700 + a hard 1800-token floor costing 4112
    # came to 7812 against a 7040 budget with every clip already gone.
    payload, tokens, _ = ai._fit_report_request(
        SYS_PROMPT, _payload(), 4000, ceiling=MODEL_TPM[MODEL_OSS], model=MODEL_OSS)
    assert _reserved(SYS_PROMPT, payload, tokens, MODEL_OSS) <= MODEL_TPM[MODEL_OSS]


def test_the_answer_is_squeezed_below_the_floor_rather_than_refused():
    _, tokens, _ = ai._fit_report_request(
        SYS_PROMPT, _payload(), 4000, ceiling=MODEL_TPM[MODEL_OSS], model=MODEL_OSS)
    assert tokens < ai._REPORT_MIN_OUTPUT_TOKENS
    assert tokens >= ai._ABSOLUTE_MIN_OUTPUT


def test_a_roomy_request_keeps_the_floor():
    # The squeeze is a last resort, not the normal path.
    _, tokens, report = ai._fit_report_request(
        "short prompt", _payload(1), 900, ceiling=MODEL_TPM[MODEL_OSS], model=MODEL_OSS)
    assert report["fitted"] is False
    assert tokens == 900


class TestPerSectionEvidence:
    def _bank(self):
        return {"dataBank": {"evidence": [
            {"id": "a", "title": "Peer valuation multiples", "sourceTab": "Compare",
             "dataSummary": "P/E and EV/EBITDA by name"},
            {"id": "b", "title": "Correlation matrix", "sourceTab": "Correlation",
             "dataSummary": "pairwise correlation over the lookback"},
            {"id": "c", "title": "Implied and realised volatility",
             "sourceTab": "Options", "dataSummary": "ATM implied vol against realised"},
        ]}}

    def test_each_section_gets_its_own_evidence_first(self):
        vol = ai._section_payload(self._bank(), {
            "heading": "Volatility", "argues": "what the options market is pricing",
            "templateSection": "volatility-gap"})
        assert vol["dataBank"]["evidence"][0]["id"] == "c"

        val = ai._section_payload(self._bank(), {
            "heading": "Valuation Comparison", "argues": "peer multiples",
            "templateSection": "valuation-comparison"})
        assert val["dataBank"]["evidence"][0]["id"] == "a"

    def test_it_reorders_and_never_drops(self):
        out = ai._section_payload(self._bank(), {
            "heading": "Correlation", "argues": "how the four names move together",
            "templateSection": "correlation"})
        assert out["dataBank"]["evidence"][0]["id"] == "b"
        assert len(out["dataBank"]["evidence"]) == 3

    def test_a_section_with_no_words_leaves_the_order_alone(self):
        bank = self._bank()
        out = ai._section_payload(bank, {"heading": "", "argues": "", "templateSection": ""})
        assert [c["id"] for c in out["dataBank"]["evidence"]] == ["a", "b", "c"]
