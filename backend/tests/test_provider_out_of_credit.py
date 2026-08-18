"""A provider out of credit must be named, not surfaced as a 500.

Cerebras hit $0.00 on 2026-08-18 and answered 402 payment_required. _exhausted
handled 429 and 413 but not 402, so the raw APIStatusError escaped the router
and reached the browser as "Internal server error". The error log caught it;
nothing else did.
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))

import ai_client  # noqa: E402


class _Err(Exception):
    def __init__(self, status):
        super().__init__(str(status))
        self.status_code = status


def test_a_402_fails_over_rather_than_stopping_the_chain():
    # The next provider may well have credit; give it the chance.
    assert ai_client._should_failover(_Err(402)) is True


def test_a_402_is_not_retried_in_place():
    # Topping up an account is not something a retry can achieve.
    assert ai_client._is_retryable(_Err(402)) is False


def test_the_message_names_the_broke_provider():
    out = ai_client._exhausted(_Err(402), "cerebras", [("groq", "429"), ("cerebras", "402")])
    assert "cerebras is out of credit" in out.detail
    assert out.status_code == 503


def test_a_rate_limit_still_reads_as_a_rate_limit():
    out = ai_client._exhausted(_Err(429), "cerebras", [("groq", "429"), ("cerebras", "429")])
    assert "rate-limited" in out.detail
    assert "out of credit" not in out.detail


class TestUnpaidCooldown:
    def setup_method(self):
        ai_client._unpaid_until.clear()

    def teardown_method(self):
        ai_client._unpaid_until.clear()

    def test_a_provider_that_answered_402_is_set_aside(self):
        assert ai_client._is_unpaid("cerebras") is False
        ai_client._mark_unpaid("cerebras")
        assert ai_client._is_unpaid("cerebras") is True

    def test_it_comes_back_after_the_cooldown(self, monkeypatch):
        ai_client._mark_unpaid("cerebras")
        later = ai_client.time.monotonic() + ai_client._UNPAID_COOLDOWN_S + 1
        monkeypatch.setattr(ai_client.time, "monotonic", lambda: later)
        assert ai_client._is_unpaid("cerebras") is False, "a top-up must be picked up"

    def test_one_provider_being_broke_does_not_touch_the_other(self):
        ai_client._mark_unpaid("cerebras")
        assert ai_client._is_unpaid("groq") is False
