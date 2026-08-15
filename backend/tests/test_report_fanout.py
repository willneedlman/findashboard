"""The fan-out must not let one rate-limited section sink a whole report.

Before this, any single failed section discarded every section that had been
written and retried the entire report as one call on the bucket the fan-out had
just drained — so a transient 429 on section 11 of 12 surfaced to the user as
"Every AI provider is rate-limited right now" with nothing to show.
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))

import routers.ai as ai  # noqa: E402
from ai_client import MODEL_POOL  # noqa: E402


def _outline(n):
    return {"sections": [{"heading": f"H{i}", "templateSection": f"s{i}"} for i in range(n)]}


def _run(monkeypatch, n, fail_for, *, wait_heals=True):
    """Fan out n sections; `fail_for` is a set of indices that fail on the first
    sweep. If wait_heals, they succeed on the recovery sweep."""
    monkeypatch.setattr(ai, "_FANOUT_RECOVERY_WAIT", 0)
    slept = []
    monkeypatch.setattr(ai.time, "sleep", lambda s: slept.append(s))
    # A section walks every model in the pool per sweep, so "failed the first
    # sweep" means failing that many attempts before the recovery sweep is
    # allowed to heal it.
    per_sweep = len(MODEL_POOL)
    tries: dict[str, int] = {}

    def one(sys_prompt, payload, section, siblings, model, per_section, valid_ids):
        key = section["templateSection"]
        idx = int(key[1:])
        tries[key] = tries.get(key, 0) + 1
        if idx in fail_for and not (wait_heals and tries[key] > per_sweep):
            raise RuntimeError("429 rate limited")
        return {"clipId": "c1", "templateSection": key, "heading": section["heading"]}

    monkeypatch.setattr(ai, "_generate_one_section", one)
    out = ai._generate_sections_fanned("sys", {}, _outline(n), "medium", None, {"c1"})
    return out, slept


def test_all_sections_written_returns_all(monkeypatch):
    out, slept = _run(monkeypatch, 8, set())
    assert out is not None and len(out) == 8
    assert not slept, "no section failed, so nothing should wait on the buckets"


def test_a_stray_failure_is_retried_after_the_buckets_refill(monkeypatch):
    # One section fails on both models, then writes on the recovery sweep.
    out, slept = _run(monkeypatch, 12, {11})
    assert out is not None and len(out) == 12
    assert len(slept) == 1, "waits exactly once per report, not per section"


def test_a_section_that_never_writes_is_dropped_not_fatal(monkeypatch):
    out, _ = _run(monkeypatch, 12, {11}, wait_heals=False)
    assert out is not None, "11 written sections beat a 503"
    assert len(out) == 11
    assert all(s is not None for s in out)
    assert "s11" not in [s["templateSection"] for s in out]


def test_a_gutted_fan_out_still_falls_back(monkeypatch):
    # Half the sections gone is not the report that was asked for; the single
    # call is worth paying for.
    out, _ = _run(monkeypatch, 12, set(range(6)), wait_heals=False)
    assert out is None


def test_a_wide_failure_does_not_wait_before_giving_up(monkeypatch):
    # Waiting only pays when the gap is a tail, not when the pool is dead.
    _, slept = _run(monkeypatch, 12, set(range(6)), wait_heals=False)
    assert not slept
