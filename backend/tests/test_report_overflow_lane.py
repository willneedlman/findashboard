"""The wide lane is what makes a report writable when the metered ones cannot.

Production, 2026-08-24: a portfolio review with a one-line objective and an
empty must-include list was refused with "the report instructions leave no room
for an answer: they take 7939 of the 7040 tokens one model call allows". Nothing
the user could shorten would have fixed it. The instructions are 7,939 tokens
because the system prompt alone is 5,000 and a reasoning model reserves about
two and a half tokens per token of answer, and the pool lanes are 8,000 wide.

Two things had also quietly died: llama-3.1-8b-instant was withdrawn by Groq, so
every rescue attempt 404'd, and the Cerebras fail-over account is out of credit.
The pool was the only capacity left.

The first attempt at a fix read groq/compound-mini's 70,000 TPM as a request
size and re-fitted oversized reports against it. That built ~60,000-token
requests which Groq answered 413, everywhere. A per-minute allowance and a
per-request size limit are different limits: measured by bisection on
2026-08-24, compound-mini caps a single call at ~6,900 tokens, which is
*smaller* than a pool lane's budget. It is a rate lane, not a size lane.
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))

import routers.ai as ai  # noqa: E402
from ai_client import (  # noqa: E402
    MODEL_COMPOUND, MODEL_FAST, MODEL_MAX_INPUT, MODEL_OSS, MODEL_OVERFLOW,
    MODEL_POOL, MODEL_TPM, request_ceiling,
)


class TestTheLanesAreRealModels:
    """A withdrawn model in the rotation is invisible: it 404s, the caller logs
    a failure and moves on, and the only symptom is that everything is slower
    and more fragile. It went unnoticed for days."""

    DEAD = "llama-3.1-8b-instant"

    def test_no_lane_points_at_the_withdrawn_model(self):
        assert MODEL_FAST != self.DEAD
        assert self.DEAD not in MODEL_POOL
        assert self.DEAD not in MODEL_OVERFLOW
        assert self.DEAD not in MODEL_TPM

    def test_every_routed_model_is_metered(self):
        # A model with no MODEL_TPM entry falls back to the default ceiling,
        # which is the pool minimum, so a wide lane would be sized as a narrow
        # one and lose exactly the headroom it was added for.
        for model in tuple(MODEL_POOL) + tuple(MODEL_OVERFLOW):
            assert MODEL_TPM.get(model), f"{model} is routed to but not metered"

    def test_fast_is_not_silently_the_same_key_as_a_pool_model_with_a_worse_limit(self):
        # MODEL_TPM used to carry a MODEL_FAST entry. Now that FAST is a pool
        # model, a stale entry would overwrite that model's real limit.
        assert MODEL_TPM[MODEL_FAST] == 8_000


class TestRateIsNotSize:
    """The bug this file exists to prevent recurring: sizing a request from
    MODEL_TPM. compound-mini is metered at 70,000 tokens a minute and refuses
    any single call over ~6,900, so TPM overstates it by nearly ten times."""

    def test_the_two_limits_are_tracked_separately(self):
        for model in tuple(MODEL_POOL) + tuple(MODEL_OVERFLOW):
            assert MODEL_MAX_INPUT.get(model), f"{model} has no measured size limit"

    def test_the_ceiling_is_the_tighter_of_the_two(self):
        for model in tuple(MODEL_POOL) + tuple(MODEL_OVERFLOW):
            assert request_ceiling(model) == min(MODEL_TPM[model], MODEL_MAX_INPUT[model])

    def test_the_overflow_lane_is_sized_by_its_limit_not_its_allowance(self):
        # The exact regression: 70,000 must never reach the fitter.
        assert MODEL_TPM[MODEL_COMPOUND] > 60_000, "premise: it is a wide rate lane"
        assert request_ceiling(MODEL_COMPOUND) < 8_000, (
            "sizing the overflow lane from its per-minute allowance builds "
            "requests Groq answers 413"
        )

    def test_a_request_fitted_for_the_overflow_lane_would_be_accepted_by_it(self):
        sys_prompt = "S" * int(1_800 * 3.4)
        payload = {"dataBank": {"evidence": [
            {"id": f"c{i}", "title": f"clip {i}", "body": "x" * 400} for i in range(328)
        ]}}
        fitted, tokens, _ = ai._fit_report_request(
            sys_prompt, payload, 700,
            ceiling=request_ceiling(MODEL_COMPOUND), model=MODEL_COMPOUND,
            min_output=ai._SECTION_MIN_TOKENS)
        import json
        total = (ai._estimate_tokens(sys_prompt)
                 + ai._estimate_tokens(json.dumps(fitted, ensure_ascii=False))
                 + tokens)
        assert total <= MODEL_MAX_INPUT[MODEL_COMPOUND], (
            f"fitted request is {total} tokens against a {MODEL_MAX_INPUT[MODEL_COMPOUND]} limit"
        )

    def test_no_lane_is_sized_above_what_it_accepts(self):
        for model in tuple(MODEL_POOL) + tuple(MODEL_OVERFLOW):
            assert request_ceiling(model) <= MODEL_MAX_INPUT[model]


class TestTheFanOutIsWhatScalesWithClipCount:
    """328 clips cannot go into one call on this tier, and they do not need to:
    the fan-out writes one section per call, and each section's budget is what
    has to hold evidence. A section leaves ~2,100 tokens for it, which is the
    number to watch if the section prompt grows."""

    def test_a_section_still_has_room_for_evidence(self):
        from ai_client import completion_cost
        sec = {"templateSection": "correlation-and-factor-risk",
               "heading": "Correlation and Factor Risk", "argues": "factor exposure"}
        prompt = ai._section_system_prompt("", sec, ["Portfolio Verdict"], {"portfolio", "factor"})
        budget = int(request_ceiling(MODEL_OSS) * ai._REPORT_TPM_SAFETY)
        answer = completion_cost(MODEL_OSS, ai._SECTION_MIN_TOKENS)
        payload_skeleton = 1133          # measured in production
        room = budget - ai._estimate_tokens(prompt) - answer - payload_skeleton
        assert room > 1_500, (
            f"only {room} tokens left for evidence; the fan-out is the only path "
            f"that scales with clip count, so this is the budget that matters"
        )
