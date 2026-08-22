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


def test_version_changes_the_key_so_a_new_payload_shape_is_not_shadowed():
    """A deploy that adds a field to a long-TTL payload must not keep serving
    the old shape until the TTL expires."""
    from cache import cached

    calls = {"n": 0}

    def build():
        calls["n"] += 1
        return {"n": calls["n"]}

    v1 = cached(ttl=600)(lambda: build())
    v2 = cached(ttl=600, version=2)(lambda: build())
    # Same qualname, so without the version they would share a key.
    assert v1()["n"] == 1
    assert v1()["n"] == 1
    assert v2()["n"] == 2
