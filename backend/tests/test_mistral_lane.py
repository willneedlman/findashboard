"""Mistral is the lane that makes a whole report writable.

The Groq pool supplies 24,000 tokens a minute across three lanes and a
seven-section report needs about 35,000 in a burst, so the fan-out starved by
arithmetic rather than by any remaining bug. Mistral's free Experiment tier is
metered at ~500,000 a minute, which removes the constraint outright.

Cerebras was the fail-over until its account ran out of credit (402), at which
point every Groq 429 fell through to a provider that could not answer. It is out
of the chain.
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))

import ai_client  # noqa: E402


class TestCerebrasIsOutOfTheChain:
    def test_nothing_routes_to_it(self):
        assert not hasattr(ai_client, "_cerebras_call")
        assert not hasattr(ai_client, "get_cerebras")

    def test_the_provider_chain_names_only_live_providers(self):
        names = {n for n, _ in ai_client._providers_for(ai_client.MODEL_SMART)}
        assert "cerebras" not in names


class TestProvidersFollowTheModel:
    """Trying Groq first for a Mistral model is the obvious shape and it is
    wrong: it spends the scarce Groq bucket to learn the model is not there."""

    def test_a_mistral_model_goes_to_mistral_first(self, monkeypatch):
        monkeypatch.setattr(ai_client, "_MISTRAL_KEY", "k")
        monkeypatch.setattr(ai_client, "_GROQ_KEY", "g")
        monkeypatch.setattr(ai_client, "_is_unpaid", lambda n: False)
        order = [n for n, _ in ai_client._providers_for(ai_client.MODEL_MISTRAL)]
        assert order[0] == "mistral"

    def test_a_groq_model_goes_to_groq_first(self, monkeypatch):
        monkeypatch.setattr(ai_client, "_MISTRAL_KEY", "k")
        monkeypatch.setattr(ai_client, "_GROQ_KEY", "g")
        monkeypatch.setattr(ai_client, "_is_unpaid", lambda n: False)
        order = [n for n, _ in ai_client._providers_for(ai_client.MODEL_SMART)]
        assert order[0] == "groq"

    def test_each_is_the_other_s_failover(self, monkeypatch):
        monkeypatch.setattr(ai_client, "_MISTRAL_KEY", "k")
        monkeypatch.setattr(ai_client, "_GROQ_KEY", "g")
        monkeypatch.setattr(ai_client, "_is_unpaid", lambda n: False)
        assert len(ai_client._providers_for(ai_client.MODEL_SMART)) == 2
        assert len(ai_client._providers_for(ai_client.MODEL_MISTRAL)) == 2

    def test_a_missing_key_drops_that_provider(self, monkeypatch):
        monkeypatch.setattr(ai_client, "_MISTRAL_KEY", "")
        monkeypatch.setattr(ai_client, "_GROQ_KEY", "g")
        monkeypatch.setattr(ai_client, "_is_unpaid", lambda n: False)
        assert [n for n, _ in ai_client._providers_for(ai_client.MODEL_SMART)] == ["groq"]


def test_groq_substitutes_its_own_model_on_failover(monkeypatch):
    """A Mistral call that fails over must not ask Groq for a Mistral model:
    that spends a request to be told the model does not exist."""
    sent = {}

    class _FakeClient:
        class chat:
            class completions:
                @staticmethod
                def create(**kw):
                    sent.update(kw)
                    return "resp"

    monkeypatch.setattr(ai_client, "get_client", lambda: _FakeClient)
    ai_client._groq_call(ai_client.MODEL_MISTRAL, [{"role": "user", "content": "x"}], 100, 0.3)
    assert sent["model"] == ai_client.MODEL_SMART
    assert sent["model"] not in ai_client._MISTRAL_MODELS


def test_a_raw_json_completion_reads_like_the_sdk_response():
    # Every caller does resp.choices[0].message.content; Mistral is called over
    # httpx, so the JSON has to be given the same attribute access.
    resp = ai_client._shape({
        "choices": [{"message": {"content": '{"ok": true}'}, "finish_reason": "stop"}],
        "usage": {"total_tokens": 12},
    })
    assert resp.choices[0].message.content == '{"ok": true}'
    assert resp.choices[0].finish_reason == "stop"
    assert resp.usage["total_tokens"] == 12


def test_an_empty_completion_is_a_string_not_none():
    # parse_json and .strip() are called on this directly.
    resp = ai_client._shape({"choices": [{"message": {}}]})
    assert resp.choices[0].message.content == ""


class TestTheLaneIsSizedDeliberately:
    def test_the_meter_matches_what_the_provider_reports(self):
        # Measured from x-ratelimit-limit-tokens-minute on the real key. The
        # published tier tables say 500,000 and are wrong for this account by
        # twenty times; the fitter sizes requests from this number, so an
        # optimistic value here is what a wall of 413s looks like.
        assert ai_client.MODEL_TPM[ai_client.MODEL_MISTRAL] == 25_000

    def test_contention_is_expressed_by_sharing_not_by_a_blanket_cap(self):
        # It WAS a blanket cap of 10,000, chosen so the lane could write two or
        # three sections a minute. But a cap applies to every call, including
        # the whole-report call, which has no contention to protect it from —
        # and that call was then refused for want of 243 tokens. A lane with the
        # meter to itself must be allowed the meter.
        from routers.ai import _lane_sharing
        alone = ai_client.request_ceiling(ai_client.MODEL_MISTRAL, 1)
        assert alone == ai_client.MODEL_TPM[ai_client.MODEL_MISTRAL]

        # Under contention it is divided, and the sections still fit together.
        shared = _lane_sharing(ai_client.MODEL_MISTRAL, 7, len(ai_client.MODEL_POOL))
        assert shared > 1
        per = ai_client.request_ceiling(ai_client.MODEL_MISTRAL, shared)
        assert per * shared <= ai_client.MODEL_TPM[ai_client.MODEL_MISTRAL]

    def test_a_lane_is_only_divided_if_it_survives_division(self):
        # A Groq lane's 8,000 split two ways is below what a section costs, so
        # every section would be refused as unwritable rather than merely
        # rate-limited. It keeps its whole allowance instead.
        from routers.ai import _lane_sharing, _SECTION_FLOOR
        assert _lane_sharing(ai_client.MODEL_OSS, 7, len(ai_client.MODEL_POOL)) == 1
        for model in ai_client.MODEL_POOL:
            share = _lane_sharing(model, 7, len(ai_client.MODEL_POOL))
            assert ai_client.request_ceiling(model, share) >= _SECTION_FLOOR

    def test_it_still_carries_more_evidence_than_a_groq_lane(self):
        assert (ai_client.request_ceiling(ai_client.MODEL_MISTRAL, 1)
                > ai_client.request_ceiling(ai_client.MODEL_OSS, 1))

    def test_the_pool_now_supplies_what_a_report_needs(self):
        # Seven sections need ~35,000 tokens in a window. Three Groq lanes give
        # 24,000, which is why the fan-out starved; with Mistral it is 49,000.
        total = sum(ai_client.MODEL_TPM[m] for m in ai_client.build_pool("a-key"))
        assert total >= 35_000


class TestTheDeployDegradesWithoutTheKey:
    """A deploy with no MISTRAL_API_KEY must run on the Groq pool exactly as
    before, not fail at import or route to a lane that cannot answer."""

    def test_without_the_key_the_pool_is_groq_only(self):
        pool = ai_client.build_pool("")
        assert ai_client.MODEL_MISTRAL not in pool
        assert ai_client.MODEL_OSS in pool

    def test_with_the_key_mistral_leads_the_pool(self):
        pool = ai_client.build_pool("a-key")
        assert pool[0] == ai_client.MODEL_MISTRAL
        # The Groq lanes stay: they are separate meters, and a report that can
        # draw on four finishes sooner than one drawing on a single meter.
        assert ai_client.MODEL_OSS in pool

    def test_the_live_pool_matches_the_live_key(self):
        assert ai_client.MODEL_POOL == ai_client.build_pool(ai_client._MISTRAL_KEY)


class TestFailoverRespectsLaneWidth:
    """Reported 2026-08-26. The log said it exactly:

        LLM provider mistral failed (429); failing over to groq
        POST api.groq.com/... "HTTP/1.1 413 Payload Too Large"

    A section built for Mistral's 25,000-a-minute meter is ~11,000 tokens. Groq
    is metered at 8,000, so the fail-over was refused on size, and _exhausted
    reported a SIZE problem — telling the user to use fewer clips about a
    request that fit the lane it was built for. The real failure was Mistral's
    quota. Lanes used to be the same width, which is why this never bit before.
    """

    def _messages(self, approx_tokens):
        return [{"role": "user", "content": "word " * int(approx_tokens * 3.4 / 5)}]

    def test_the_substitute_model_is_what_gets_measured(self):
        # Groq does not serve a Mistral id; it substitutes MODEL_SMART, so the
        # ceiling that matters on fail-over is the substitute's.
        assert ai_client._effective_model("groq", ai_client.MODEL_MISTRAL) == ai_client.MODEL_SMART
        assert ai_client._effective_model("mistral", ai_client.MODEL_SMART) == ai_client.MODEL_MISTRAL
        assert ai_client._effective_model("groq", ai_client.MODEL_OSS) == ai_client.MODEL_OSS

    def test_a_mistral_sized_request_is_not_offered_to_groq(self, monkeypatch):
        monkeypatch.setattr(ai_client, "_MISTRAL_KEY", "k")
        monkeypatch.setattr(ai_client, "_GROQ_KEY", "g")
        monkeypatch.setattr(ai_client, "_is_unpaid", lambda n: False)
        big = self._messages(11_000)
        need = ai_client._request_tokens(big, ai_client.MODEL_MISTRAL, 700)
        assert need > ai_client.request_ceiling(ai_client.MODEL_SMART), (
            "premise: this request cannot fit a Groq lane"
        )
        assert need <= ai_client.request_ceiling(ai_client.MODEL_MISTRAL), (
            "premise: it does fit the lane it was built for"
        )

    def test_a_small_request_may_still_fail_over(self, monkeypatch):
        monkeypatch.setattr(ai_client, "_MISTRAL_KEY", "k")
        monkeypatch.setattr(ai_client, "_GROQ_KEY", "g")
        monkeypatch.setattr(ai_client, "_is_unpaid", lambda n: False)
        small = self._messages(1_500)
        need = ai_client._request_tokens(small, ai_client.MODEL_MISTRAL, 700)
        assert need <= ai_client.request_ceiling(ai_client.MODEL_SMART), (
            "a request this size must keep its fail-over; blocking every one "
            "would trade a bad error message for a lost redundancy"
        )

    def test_the_quota_failure_is_what_surfaces(self, monkeypatch):
        """End to end: Mistral 429s, Groq is too narrow to be tried, and the
        user is told about the quota rather than about a size they cannot fix."""
        monkeypatch.setattr(ai_client, "_MISTRAL_KEY", "k")
        monkeypatch.setattr(ai_client, "_GROQ_KEY", "g")
        monkeypatch.setattr(ai_client, "_is_unpaid", lambda n: False)
        monkeypatch.setattr(ai_client, "_mark_unpaid", lambda n: None)

        class _RateLimited(Exception):
            status_code = 429

        tried: list[str] = []

        def _mistral(model, messages, max_tokens, temperature):
            tried.append("mistral")
            raise _RateLimited("429")

        def _groq(model, messages, max_tokens, temperature):
            tried.append("groq")
            raise AssertionError("groq must not be handed a request it cannot hold")

        monkeypatch.setattr(ai_client, "_mistral_call", _mistral)
        monkeypatch.setattr(ai_client, "_groq_call", _groq)
        monkeypatch.setattr(ai_client, "with_backoff",
                            lambda fn, **kw: fn())

        from fastapi import HTTPException
        try:
            ai_client.groq_chat(self._messages(11_000), model=ai_client.MODEL_MISTRAL,
                                max_tokens=700, temperature=0.3)
        except HTTPException as exc:
            assert "rate-limited" in exc.detail, exc.detail
            assert "fewer clips" not in exc.detail, (
                "this was a quota failure; blaming the clips sends the user "
                "deleting work that would not have helped"
            )
        except _RateLimited:
            pass
        assert tried == ["mistral"], f"providers tried: {tried}"
