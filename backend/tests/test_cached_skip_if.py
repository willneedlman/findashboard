import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))

from cache import cached  # noqa: E402


def test_failures_are_not_retained():
    """A transient failure must not hold a long-TTL slot. This is the 2026-08-20
    incident: one bad second at boot served 'unavailable' for six hours."""
    calls = {"n": 0}

    @cached(ttl=3600, maxsize=4, skip_if=lambda r: not r.get("available"))
    def read():
        calls["n"] += 1
        return {"available": calls["n"] > 2, "n": calls["n"]}

    assert read()["available"] is False
    assert read()["available"] is False
    assert read()["available"] is True     # third attempt succeeds
    assert calls["n"] == 3                 # each failure re-ran rather than serving cache
    assert read()["n"] == 3                # the success IS cached
    assert calls["n"] == 3


def test_without_the_predicate_everything_caches():
    """Default behaviour is unchanged for every existing caller."""
    calls = {"n": 0}

    @cached(ttl=3600, maxsize=4)
    def read():
        calls["n"] += 1
        return {"available": False}

    read(); read()
    assert calls["n"] == 1


def test_arguments_key_the_cache_separately():
    calls = {"n": 0}

    @cached(ttl=3600, maxsize=4, skip_if=lambda r: not r["ok"])
    def read(x):
        calls["n"] += 1
        return {"ok": True, "x": x}

    assert read(1)["x"] == 1
    assert read(2)["x"] == 2
    assert read(1)["x"] == 1
    assert calls["n"] == 2
