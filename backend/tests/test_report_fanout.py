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
from ai_client import MODEL_OVERFLOW, MODEL_POOL  # noqa: E402


def _outline(n):
    return {"sections": [{"heading": f"H{i}", "templateSection": f"s{i}"} for i in range(n)]}


def _run(monkeypatch, n, fail_for, *, wait_heals=True):
    """Fan out n sections; `fail_for` is a set of indices that fail on the first
    sweep. If wait_heals, they succeed on the recovery sweep."""
    monkeypatch.setattr(ai, "_FANOUT_RECOVERY_WAIT", 0)
    slept = []
    monkeypatch.setattr(ai.time, "sleep", lambda s: slept.append(s))
    # A section walks every pool lane and then the overflow lane per sweep, so
    # "failed the first sweep" means failing that many attempts before the
    # recovery sweep is allowed to heal it.
    per_sweep = len(MODEL_POOL) + len(MODEL_OVERFLOW)
    tries: dict[str, int] = {}
    models_used: list[str] = []

    shares: list[tuple[str, int]] = []

    def one(payload, section, siblings, model, per_section, valid_ids,
            must_include="", rule_flags=None, sharing=1):
        key = section["templateSection"]
        idx = int(key[1:])
        tries[key] = tries.get(key, 0) + 1
        models_used.append(model)
        shares.append((model, sharing))
        if idx in fail_for and not (wait_heals and tries[key] > per_sweep):
            raise RuntimeError("429 rate limited")
        return {"clipId": "c1", "templateSection": key, "heading": section["heading"]}

    monkeypatch.setattr(ai, "_generate_one_section", one)
    dropped: list[str] = []
    out = ai._generate_sections_fanned(
        {}, _outline(n), "medium", None, {"c1"}, dropped_out=dropped)
    _run.shares = shares
    return out, slept, dropped, models_used


def test_all_sections_written_returns_all(monkeypatch):
    out, slept, dropped, _ = _run(monkeypatch, 8, set())
    assert out is not None and len(out) == 8
    assert not slept, "no section failed, so nothing should wait on the buckets"
    assert dropped == []


def test_a_stray_failure_is_retried_after_the_buckets_refill(monkeypatch):
    # One section fails every lane, then writes on the recovery sweep.
    out, slept, dropped, _ = _run(monkeypatch, 12, {11})
    assert out is not None and len(out) == 12
    assert len(slept) == 1, "waits exactly once per report, not per section"
    assert dropped == [], "it eventually wrote, so nothing was given up on"


def test_a_section_that_never_writes_is_dropped_not_fatal(monkeypatch):
    out, _, dropped, _ = _run(monkeypatch, 12, {11}, wait_heals=False)
    assert out is not None, "11 written sections beat a 503"
    assert len(out) == 11
    assert all(s is not None for s in out)
    assert "s11" not in [s["templateSection"] for s in out]


def test_a_dropped_section_is_named_never_silently_missing(monkeypatch):
    # The whole point: a short report must be distinguishable from a complete one.
    _, _, dropped, _ = _run(monkeypatch, 12, {11}, wait_heals=False)
    assert dropped == ["H11"]


def test_a_gutted_fan_out_still_falls_back(monkeypatch):
    # Most of the sections gone is not the report that was asked for.
    #
    # The bar was three quarters and is now half: the single call is not the
    # better report it was assumed to be, because on an 8k bucket the
    # instructions take over half the budget and it writes from no evidence at
    # all. Nine of twelve missing still falls back; six of twelve now ships.
    out, _, dropped, _ = _run(monkeypatch, 12, set(range(9)), wait_heals=False)
    assert out is None
    assert dropped == [], "the caller rewrites from scratch, so nothing is missing yet"


def test_half_the_sections_ship_rather_than_falling_back(monkeypatch):
    out, _, dropped, _ = _run(monkeypatch, 12, set(range(6)), wait_heals=False)
    assert out is not None and len(out) == 6
    assert len(dropped) == 6, "and every missing section is named"


def test_a_wide_failure_does_not_wait_before_giving_up(monkeypatch):
    # Waiting only pays when the gap is a tail, not when the pool is dead.
    _, slept, _, _ = _run(monkeypatch, 12, set(range(6)), wait_heals=False)
    assert not slept


def test_every_pool_lane_starts_a_section_and_overflow_starts_none(monkeypatch):
    # Overflow is a rescue lane, not a rotation slot: llama-3.1-8b is a weaker
    # writer, so no section should begin on it while the good buckets have room.
    _, _, _, models = _run(monkeypatch, len(MODEL_POOL) * 2, set())
    assert set(models) == set(MODEL_POOL)
    assert not set(models) & set(MODEL_OVERFLOW)


def test_overflow_rescues_a_section_the_pool_could_not_write(monkeypatch):
    seen: list[str] = []

    def one(payload, section, siblings, model, per_section, valid_ids,
            must_include="", rule_flags=None, sharing=1):
        seen.append(model)
        if model in MODEL_POOL:
            raise RuntimeError("429 rate limited")
        return {"clipId": "c1", "templateSection": section["templateSection"],
                "heading": section["heading"]}

    monkeypatch.setattr(ai, "_FANOUT_RECOVERY_WAIT", 0)
    monkeypatch.setattr(ai, "_generate_one_section", one)
    out = ai._generate_sections_fanned({}, _outline(4), "medium", None, {"c1"})
    assert out is not None and len(out) == 4, "overflow should have caught every section"
    assert set(seen) & set(MODEL_OVERFLOW)


def test_a_pool_lane_is_not_divided(monkeypatch):
    """A section costs ~4,900 tokens before any evidence, so an 8,000 lane split
    three ways is below the floor and every section would be refused as
    unwritable rather than merely rate-limited. An 8k lane cannot do three
    sections a minute, and pretending otherwise fails closed."""
    _run(monkeypatch, 7, set())
    pool_shares = {sh for m, sh in _run.shares if m in MODEL_POOL}
    assert pool_shares == {1}, f"pool lanes must keep their full budget, got {pool_shares}"


def test_the_overflow_lane_is_sized_for_every_section(monkeypatch):
    """It is where every section falls back to, so all of them can land on it
    at once and it must be sized for the whole fan-out, not a third of it."""
    _run(monkeypatch, 7, {0}, wait_heals=False)
    overflow_shares = {sh for m, sh in _run.shares if m in MODEL_OVERFLOW}
    assert overflow_shares == {7}, f"expected the whole fan-out, got {overflow_shares}"
