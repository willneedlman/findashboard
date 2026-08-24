"""The wide lane is what makes a report writable when the metered ones cannot.

Production, 2026-08-24: a portfolio review with a one-line objective and an
empty must-include list was refused with "the report instructions leave no room
for an answer: they take 7939 of the 7040 tokens one model call allows". Nothing
the user could shorten would have fixed it. The instructions are 7,939 tokens
because the system prompt alone is 5,000 and a reasoning model reserves about
two and a half tokens per token of answer, and the pool lanes are 8,000 wide.

Two things had also quietly died: llama-3.1-8b-instant was withdrawn by Groq, so
every rescue attempt 404'd, and the Cerebras fail-over account is out of credit.
The pool was the only capacity left, and the pool cannot hold a whole report.
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))

import routers.ai as ai  # noqa: E402
from ai_client import (  # noqa: E402
    MODEL_COMPOUND, MODEL_FAST, MODEL_OSS, MODEL_OVERFLOW, MODEL_POOL, MODEL_TPM,
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


class TestTheOverflowLaneIsWiderThanThePool:
    def test_it_is_wider(self):
        assert MODEL_OVERFLOW, "there must be a rescue lane"
        widest = max(MODEL_TPM[m] for m in MODEL_OVERFLOW)
        pool = min(MODEL_TPM[m] for m in MODEL_POOL)
        assert widest > pool, (
            "a rescue lane no wider than the pool cannot rescue anything the "
            "pool already refused"
        )

    def test_the_real_report_that_failed_now_fits(self):
        # The production numbers: a 5,000-token system prompt and a payload that
        # measured 2,939 with the evidence already shed to nothing.
        sys_prompt = "S" * int(5_000 * 3.4)
        payload = {"dataBank": {"evidence": []}, "pad": "p" * int(2_939 * 3.4)}

        _, _, narrow = ai._fit_report_request(
            sys_prompt, payload, 1800,
            ceiling=MODEL_TPM[MODEL_OSS], model=MODEL_OSS)
        assert narrow.get("unfittable") is True, (
            "this is the request that failed in production; if it fits a narrow "
            "lane the test is no longer reproducing it"
        )

        _, tokens, wide = ai._fit_report_request(
            sys_prompt, payload, 1800,
            ceiling=MODEL_TPM[MODEL_COMPOUND], model=MODEL_COMPOUND)
        assert not wide.get("unfittable"), "the wide lane must be able to write it"
        assert tokens >= ai._REPORT_MIN_OUTPUT_TOKENS, (
            "and with a full-length answer, not a squeezed one"
        )


class TestTheRescueKeepsTheEvidence:
    """Fitting sheds evidence to make room. Re-fitting an already-shed payload
    against a wider lane would carry the shedding forward, so the rescue has to
    start from the original request. The failing report shed 31 clips."""

    def _payload(self, n=31, chars=400):
        return {"dataBank": {"evidence": [
            {"id": f"c{i}", "title": f"clip {i}", "body": "x" * chars} for i in range(n)
        ]}}

    def _evidence(self, payload):
        return len(payload["dataBank"]["evidence"])

    def test_the_wide_lane_keeps_clips_the_narrow_one_sheds(self):
        sys_prompt = "S" * int(3_000 * 3.4)
        original = self._payload()

        narrow_payload, _, _ = ai._fit_report_request(
            sys_prompt, original, 1800,
            ceiling=MODEL_TPM[MODEL_OSS], model=MODEL_OSS)
        wide_payload, _, _ = ai._fit_report_request(
            sys_prompt, original, 1800,
            ceiling=MODEL_TPM[MODEL_COMPOUND], model=MODEL_COMPOUND)

        assert self._evidence(narrow_payload) < self._evidence(original), (
            "the narrow lane has to shed here or there is nothing to compare"
        )
        assert self._evidence(wide_payload) == self._evidence(original), (
            "the wide lane has room for every clip"
        )

    def test_refitting_a_shed_payload_cannot_recover_it(self):
        # Guards the ordering bug directly: if the rescue is fitted from the
        # narrow result instead of the original, the clips stay gone even though
        # the wide lane had room for them.
        sys_prompt = "S" * int(3_000 * 3.4)
        original = self._payload()
        narrow_payload, _, _ = ai._fit_report_request(
            sys_prompt, original, 1800,
            ceiling=MODEL_TPM[MODEL_OSS], model=MODEL_OSS)
        rescued_wrongly, _, _ = ai._fit_report_request(
            sys_prompt, narrow_payload, 1800,
            ceiling=MODEL_TPM[MODEL_COMPOUND], model=MODEL_COMPOUND)
        assert self._evidence(rescued_wrongly) == self._evidence(narrow_payload)
        assert self._evidence(rescued_wrongly) < self._evidence(original)
