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

Groq's 413 is bucket-relative: a request is refused when it does not fit what is
LEFT of the per-minute allowance, not when it exceeds a fixed size. Measured
2026-08-24 against a refilled bucket, gpt-oss-120b accepted 7,000, 10,000 and
11,500-token requests, all of which 413 once the bucket is drawn down.

So a fan-out has to size each section to its share of a lane. Sizing every
section to the whole bucket means the first request drains the lane and every
section after it is refused as too large, which is the wall of 413s a
seven-section report produced.
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))

import routers.ai as ai  # noqa: E402
from ai_client import (  # noqa: E402
    MODEL_COMPOUND, MODEL_FAST, MODEL_OSS, MODEL_OVERFLOW, MODEL_POOL,
    MODEL_TPM, request_ceiling,
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


class TestASharedLaneIsSizedByTheShare:
    """The regression this file exists for: sizing every request to the whole
    per-minute bucket. It reads as correct and fails only under concurrency,
    which is exactly when a fan-out runs."""

    def test_a_lane_to_itself_gets_the_whole_bucket(self):
        assert request_ceiling(MODEL_OSS, 1) == MODEL_TPM[MODEL_OSS]

    def test_sharing_divides_the_bucket(self):
        assert request_ceiling(MODEL_OSS, 3) == MODEL_TPM[MODEL_OSS] // 3

    def test_a_hard_per_request_cap_wins_over_the_share(self):
        # compound-mini 413s a 10,000-token request with 63,000 still left in
        # its bucket: it is an agentic system with its own context budget, so
        # its share of the meter overstates what it will accept.
        from ai_client import MODEL_MAX_INPUT
        assert MODEL_TPM[MODEL_COMPOUND] // 7 > MODEL_MAX_INPUT[MODEL_COMPOUND]
        assert request_ceiling(MODEL_COMPOUND, 7) == MODEL_MAX_INPUT[MODEL_COMPOUND]

    def test_a_model_with_no_hard_cap_is_bound_by_its_meter(self):
        # Measured on a full bucket the pool models accept 11,500 tokens, so
        # there is no independent size limit to apply to them.
        from ai_client import MODEL_MAX_INPUT
        assert MODEL_OSS not in MODEL_MAX_INPUT
        assert request_ceiling(MODEL_OSS, 1) == MODEL_TPM[MODEL_OSS]

    def test_dividing_a_pool_lane_would_fall_below_what_a_section_costs(self):
        # Why the pool is left undivided: a section costs ~4,900 tokens before a
        # single clip, so a third of an 8k lane cannot carry one at all.
        SECTION_FLOOR = 4_900
        assert request_ceiling(MODEL_OSS, 3) < SECTION_FLOOR
        assert request_ceiling(MODEL_OSS, 1) > SECTION_FLOOR

    def test_the_overflow_lane_is_sized_for_the_whole_fan_out(self):
        # It is the lane every section falls back to, so all of them can land
        # on it at once and it must be sized for that, not for a third of them.
        assert request_ceiling(MODEL_COMPOUND, 7) * 7 <= MODEL_TPM[MODEL_COMPOUND]

    def test_the_overflow_lane_still_leaves_a_section_real_room(self):
        # Rate is the whole point of that lane: a 70k/min bucket split seven
        # ways is still far more per section than an 8k lane split three ways.
        assert request_ceiling(MODEL_COMPOUND, 7) > request_ceiling(MODEL_OSS, 3)


class TestTheWholeReportCallIsSizedToTheWidestLane:
    """Reported 2026-08-26: "This report needs 8557 tokens just for its
    instructions. One model call holds 6160."

    6160 is 7,000 x 0.88 — compound-mini's cap. The single-call writer fitted to
    the TIGHTEST lane in its rotation, so adding a narrow rescue lane made the
    largest request in the pipeline narrower than every lane it would actually
    use. The pool's widest lane had 8,800 and the report was refused anyway.
    """

    def _ceilings(self, mistral_key="a-key"):
        # build_pool rather than MODEL_POOL: the live pool depends on whether
        # MISTRAL_API_KEY is set in the environment running the tests, and the
        # configuration this regression happened on is the one WITH it.
        from ai_client import build_pool
        lanes = list(build_pool(mistral_key))
        lanes += [m for m in MODEL_OVERFLOW if m not in lanes]
        return lanes, [request_ceiling(m) for m in lanes]

    def test_the_rescue_lane_is_narrower_than_the_pool(self):
        # The premise. Without it this regression cannot occur and the tests
        # below are not testing anything.
        _, ceilings = self._ceilings()
        assert request_ceiling(MODEL_COMPOUND) < max(ceilings)

    def test_without_the_wide_lane_a_long_prompt_genuinely_does_not_fit(self):
        # Not a regression, a real limit: on the Groq pool alone an 8,557-token
        # instruction set leaves no room for a report, whatever it is fitted to.
        # This is why the wide lane exists, and why the message must not blame
        # the user's clips.
        _, groq_only = self._ceilings(mistral_key="")
        assert int(max(groq_only) * ai._REPORT_TPM_SAFETY) < 8_557

    def test_fitting_to_the_tightest_would_lose_capacity_the_pool_has(self):
        _, ceilings = self._ceilings()
        assert min(ceilings) < max(ceilings), (
            "the lanes must differ in width or this says nothing"
        )

    def test_the_widest_lane_can_hold_a_real_report_prompt(self):
        # The instructions that were refused, plus a full-length answer.
        _, ceilings = self._ceilings()
        budget = int(max(ceilings) * ai._REPORT_TPM_SAFETY)
        assert budget > 8_557 + ai._REPORT_MIN_OUTPUT_TOKENS, (
            f"widest budget is {budget}; the report that failed needed 8,557 "
            f"for instructions alone"
        )

    def test_that_report_now_fits(self):
        sys_prompt = "S" * int(8_557 * 3.4)
        _, ceilings = self._ceilings()
        _, tokens, fit = ai._fit_report_request(
            sys_prompt, {"dataBank": {"evidence": []}}, 1800,
            ceiling=max(ceilings), model=MODEL_COMPOUND)
        assert not fit.get("unfittable")
        assert tokens >= ai._REPORT_MIN_OUTPUT_TOKENS

    def test_and_would_still_be_refused_on_the_narrowest(self):
        # Guards the direction of the fix: if this ever passes, the fitter is no
        # longer sizing to anything meaningful.
        sys_prompt = "S" * int(8_557 * 3.4)
        _, _, fit = ai._fit_report_request(
            sys_prompt, {"dataBank": {"evidence": []}}, 1800,
            ceiling=request_ceiling(MODEL_COMPOUND), model=MODEL_COMPOUND)
        assert fit.get("unfittable") is True
