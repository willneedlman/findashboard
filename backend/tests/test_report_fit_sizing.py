"""A fitted request must fit what the provider actually charges for it.

Groq counts the *requested* completion against the model's per-minute limit, and
a reasoning model reserves about twice the answer it is asked for. The fit
function budgeted the bare answer, so every section call on the pool went over
its own limit and came back 413 — which fails over, so the user was shown the
next provider's 429 and told to wait out a quota that was never the problem.
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))

import routers.ai as ai  # noqa: E402
from ai_client import (  # noqa: E402
    MODEL_OSS, MODEL_FAST, MODEL_TPM, answer_tokens_within, completion_cost,
)


def _payload(n_clips, chars=400):
    return {"dataBank": {"evidence": [
        {"id": f"c{i}", "title": f"clip {i}", "body": "x" * chars} for i in range(n_clips)
    ]}}


def _reserved(sys_prompt, payload, answer, model):
    import json
    return (ai._estimate_tokens(sys_prompt)
            + ai._estimate_tokens(json.dumps(payload, ensure_ascii=False))
            + completion_cost(model, answer))


def test_completion_cost_and_its_inverse_agree():
    for answer in (700, 900, 1800, 4000):
        assert answer_tokens_within(MODEL_OSS, completion_cost(MODEL_OSS, answer)) >= answer - 1
    # A non-reasoning model reserves exactly what it asks for.
    assert completion_cost(MODEL_FAST, 1800) == 1800
    assert answer_tokens_within(MODEL_FAST, 1800) == 1800


def test_a_reasoning_model_reserves_more_than_it_asks_for():
    # The gap that was being ignored.
    assert completion_cost(MODEL_OSS, 1800) > 1800 * 2


def test_a_fitted_request_stays_under_the_models_per_minute_limit():
    # 91 clips is the report that failed in production on 2026-08-15.
    payload = _payload(91)
    sys_prompt = "S" * 4000
    ceiling = MODEL_TPM[MODEL_OSS]
    fitted, tokens, report = ai._fit_report_request(
        sys_prompt, payload, 1800, ceiling=ceiling, model=MODEL_OSS, min_output=700)
    assert report["fitted"], "a 91-clip payload cannot fit an 8k bucket untouched"
    assert _reserved(sys_prompt, fitted, tokens, MODEL_OSS) <= ceiling, (
        "the fitted request still exceeds the model's limit, which Groq answers with 413"
    )


def test_the_old_accounting_would_have_overshot():
    # Guards the regression directly: ignoring the scratchpad puts the same
    # request over the limit, which is exactly what shipped.
    payload = _payload(91)
    sys_prompt = "S" * 4000
    ceiling = MODEL_TPM[MODEL_OSS]
    fitted, tokens, _ = ai._fit_report_request(
        sys_prompt, payload, 1800, ceiling=ceiling, model=None, min_output=700)
    assert _reserved(sys_prompt, fitted, tokens, MODEL_OSS) > ceiling


def test_a_small_request_is_left_alone():
    payload = _payload(2, chars=100)
    fitted, tokens, report = ai._fit_report_request(
        "short", payload, 700, ceiling=MODEL_TPM[MODEL_OSS], model=MODEL_OSS, min_output=700)
    assert report["fitted"] is False
    assert tokens == 700
    assert fitted is payload


def test_shed_evidence_is_named_so_it_can_be_disclosed():
    fitted, _, report = ai._fit_report_request(
        "S" * 2000, _payload(91), 1800,
        ceiling=MODEL_TPM[MODEL_OSS], model=MODEL_OSS, min_output=700)
    assert report["droppedClips"], "clips were shed, so they must be named"
    kept = len(fitted["dataBank"]["evidence"])
    assert kept + len(report["droppedClips"]) == 91


class _Err(Exception):
    def __init__(self, status):
        super().__init__(str(status))
        self.status_code = status


def test_a_413_anywhere_in_the_chain_is_not_reported_as_a_quota():
    # What production actually did: groq 413 -> failover -> cerebras 429. The
    # user was told to wait out a rate limit on a request that was too big.
    import ai_client
    out = ai_client._exhausted(_Err(429), "cerebras", [("groq", "413"), ("cerebras", "429")])
    assert "size problem" in out.detail
    assert "groq" in out.detail
    assert "rate-limited" not in out.detail


def test_a_genuine_rate_limit_still_reads_as_one():
    import ai_client
    out = ai_client._exhausted(_Err(429), "cerebras", [("groq", "429"), ("cerebras", "429")])
    assert "rate-limited" in out.detail
