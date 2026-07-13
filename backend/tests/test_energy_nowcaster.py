"""Tests for the AIS energy nowcaster (energy_nowcaster) and the maritime crossing
detector. Network-free: the disk cache is redirected to a throwaway temp DB before
import, and the crossing test stubs record_transit so no DB is touched.

Covers the capacity proxy math, the 96h prune, the confidence tiers, the
live-vs-baseline delta, and one-event-per-crossing debounce.
"""
import importlib
import os
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))

# Redirect the SQLite disk cache to a temp file, then (re)load the cache + nowcaster
# so this test suite never touches the real .cache DB, regardless of import order.
os.environ["DISK_CACHE_PATH"] = os.path.join(tempfile.mkdtemp(), "nowcast_test.db")
import disk_cache  # noqa: E402
importlib.reload(disk_cache)
import energy_nowcaster as en  # noqa: E402
importlib.reload(en)

import pytest  # noqa: E402

HOUR = 3600
NOW = 1_800_000_000.0


@pytest.fixture(autouse=True)
def _clean_table():
    with disk_cache._write_lock:
        disk_cache._conn().execute("DELETE FROM ais_transits")
        disk_cache._conn().commit()
    yield


# ── capacity proxy ──────────────────────────────────────────────────────────
def test_capacity_proxy_vlcc_order_of_magnitude():
    # VLCC ~330 x 60 x 22 m -> laden displacement ~300-400k t.
    cap = en._capacity_est("tanker", 22, 330, 60)
    assert 300_000 < cap < 420_000


def test_capacity_proxy_lng_uses_finer_block_coeff():
    tanker = en._capacity_est("tanker", 12, 290, 45)
    lng = en._capacity_est("lng", 12, 290, 45)
    assert lng < tanker                       # 0.74 vs 0.82 block coefficient


def test_capacity_proxy_none_when_dims_missing():
    assert en._capacity_est("tanker", None, 330, 60) is None
    assert en._capacity_est("tanker", 22, 0, 60) is None
    assert en._capacity_est("tanker", 22, 330, None) is None


# ── record + aggregate ──────────────────────────────────────────────────────
def test_nowcast_counts_capacity_and_delta():
    for _ in range(3):
        en.record_transit("111", "hormuz", "tanker", 22, 330, 60, now=NOW)
    out = en.nowcast({"hormuz": 0.5}, ["hormuz"], {"hormuz"}, connected=True,
                     activity={"hormuz": 3}, now=NOW)["hormuz"]
    assert out["calls_96h"] == 3
    assert out["calls_per_day_live"] == 0.75          # 3 crossings / 4 days
    assert out["live_vs_baseline_pct"] == 50.0        # 0.75 vs 0.5/day
    assert out["capacity_est_dwt"] > 900_000          # ~366k x 3
    assert out["capacity_coverage_pct"] == 100
    assert out["confidence"] == "high"
    assert out["as_of"] is not None


def test_transit_without_dims_still_counted_partial_capacity():
    en.record_transit("1", "suez", "tanker", 22, 330, 60, now=NOW)   # with dims
    en.record_transit("2", "suez", "tanker", None, None, None, now=NOW)  # no dims
    out = en.nowcast({}, ["suez"], {"suez"}, connected=True, activity={"suez": 4}, now=NOW)["suez"]
    assert out["calls_96h"] == 2
    assert out["capacity_coverage_pct"] == 50         # only one carried a capacity estimate


def test_96h_prune_drops_stale_rows():
    en.record_transit("old", "malacca", "tanker", 20, 300, 55, now=NOW - 100 * HOUR)
    en.record_transit("new", "malacca", "tanker", 20, 300, 55, now=NOW)   # prunes the 100h-old row
    out = en.nowcast({}, ["malacca"], {"malacca"}, connected=True, now=NOW)["malacca"]
    assert out["calls_96h"] == 1


def test_uncovered_chokepoint_reports_none_confidence():
    out = en.nowcast({}, ["goodhope"], covered_ids=set(), connected=True, now=NOW)["goodhope"]
    assert out["calls_96h"] == 0
    assert out["confidence"] == "none"


def test_uncovered_chokepoint_with_edge_crossings_is_not_none():
    # bosphorus-style: center outside every bbox, but edge vessels logged crossings.
    en.record_transit("e1", "bosphorus", "tanker", 15, 250, 44, now=NOW)
    out = en.nowcast({}, ["bosphorus"], covered_ids=set(), connected=True,
                     activity={}, now=NOW)["bosphorus"]
    assert out["calls_96h"] == 1
    assert out["confidence"] != "none"        # real data must not read as "no coverage"


# ── confidence tiers ────────────────────────────────────────────────────────
def test_confidence_tiers():
    assert en._confidence(False, True, 5, NOW, 5, NOW) == "none"        # no AIS bbox
    assert en._confidence(True, False, 5, NOW, 5, NOW) == "stale"       # feed down
    assert en._confidence(True, True, 5, NOW, 3, NOW) == "high"         # fresh + busy
    assert en._confidence(True, True, 5, NOW - 10 * HOUR, 0, NOW) == "medium"  # recent-ish, quiet
    assert en._confidence(True, True, 0, None, 0, NOW) == "low"         # covered but no events


# ── crossing detector debounce (maritime) ───────────────────────────────────
def test_check_crossing_debounces_and_filters(monkeypatch):
    from routers import maritime
    calls = []
    monkeypatch.setattr(maritime.energy_nowcaster, "record_transit",
                        lambda *a, **k: calls.append(a))
    maritime._vessels.clear()
    mmsi = "999"
    maritime._vessels[mmsi] = {"mmsi": mmsi, "category": "tanker",
                               "draught": 20, "loa": 300, "beam": 55}
    hormuz, far = (26.57, 56.25), (0.0, 0.0)
    maritime._check_crossing(mmsi, *far)      # outside — no event
    maritime._check_crossing(mmsi, *hormuz)   # enter — event
    maritime._check_crossing(mmsi, *hormuz)   # still inside — no event
    maritime._check_crossing(mmsi, *far)      # exit — no event
    maritime._check_crossing(mmsi, *hormuz)   # re-enter — event
    assert len(calls) == 2
    assert calls[0][1] == "hormuz"


def test_check_crossing_records_cargo_for_history_without_affecting_energy_nowcast(monkeypatch):
    from routers import maritime
    calls = []
    monkeypatch.setattr(maritime.energy_nowcaster, "record_transit",
                        lambda *a, **k: calls.append(a))
    maritime._vessels.clear()
    maritime._vessels["888"] = {"mmsi": "888", "category": "cargo"}
    maritime._check_crossing("888", 26.57, 56.25)   # a container ship over Hormuz
    assert len(calls) == 1
    assert calls[0][2] == "cargo"


def test_static_message_backfills_already_observed_entry(monkeypatch):
    from routers import maritime
    calls = []
    monkeypatch.setattr(maritime.energy_nowcaster, "record_transit",
                        lambda *a, **k: calls.append(a))
    maritime._vessels.clear()
    maritime._static_reg.clear()
    maritime._vessels["static-late"] = {
        "mmsi": "static-late", "in_choke": "hormuz", "category": "tanker",
        "sog": 12, "draught": 20, "loa": 300, "beam": 55,
    }
    maritime._record_classified_chokepoint("static-late")
    maritime._record_classified_chokepoint("static-late")
    assert len(calls) == 1
    assert calls[0][1:3] == ("hormuz", "tanker")


def test_daily_counts_keep_vessel_class_breakdown():
    en.record_transit("t", "hormuz", "tanker", 20, 300, 55, now=NOW)
    en.record_transit("c", "hormuz", "cargo", None, None, None, now=NOW)
    day = __import__("datetime").datetime.fromtimestamp(NOW, tz=__import__("datetime").timezone.utc).strftime("%Y-%m-%d")
    got = en.daily_counts(["hormuz"], now=NOW)["hormuz"][day]
    assert got["total"] == 2
    assert got["tanker"] == 1
    assert got["cargo"] == 1
    assert got["cap"] > 0


def test_history_bridge_keeps_ais_overlap_for_calibration(monkeypatch):
    from routers import maritime
    rows = {
        "2026-07-01": {"total": 8, "tanker": 3, "cargo": 5, "cap": 0},
        "2026-07-05": {"total": 10, "tanker": 4, "cargo": 6, "cap": 0},
        "2026-07-10": {"total": 9, "tanker": 3, "cargo": 6, "cap": 0},
    }
    monkeypatch.setattr(maritime.energy_nowcaster, "daily_counts", lambda _ids: {"danish": rows})
    series = [{"id": "danish", "points": [{"d": "2026-07-05", "total": 42}]}]
    maritime._attach_history_nowcast(series)
    assert series[0]["nowcast_days"][-1] == maritime.datetime.now(maritime.timezone.utc).date().isoformat()
    assert series[0]["nowcast_daily"] == rows


def test_ais_stream_covers_expanded_chokepoints():
    from routers import maritime
    covered = maritime._ais_covered_chokes()
    assert {"bosphorus", "goodhope", "gibraltar", "taiwan"} <= covered


def test_check_crossing_skips_anchored_vessel(monkeypatch):
    from routers import maritime
    calls = []
    monkeypatch.setattr(maritime.energy_nowcaster, "record_transit",
                        lambda *a, **k: calls.append(a))
    maritime._vessels.clear()
    maritime._vessels["555"] = {"mmsi": "555", "category": "tanker", "sog": 0.4}  # at anchor
    maritime._check_crossing("555", 26.57, 56.25)
    assert calls == []                                   # near-stationary = not a transit
    maritime._vessels["556"] = {"mmsi": "556", "category": "tanker", "sog": 11.0}  # underway
    maritime._check_crossing("556", 26.57, 56.25)
    assert len(calls) == 1


def test_nearest_choke_uses_tight_per_chokepoint_radius():
    from routers import maritime
    assert maritime._nearest_choke(26.57, 56.25) == "hormuz"   # dead centre
    assert maritime._nearest_choke(26.72, 56.25) == "hormuz"   # ~17km, inside 30km
    assert maritime._nearest_choke(26.95, 56.25) is None       # ~42km, outside 30km


def test_check_crossing_coordless_ping_does_not_reset_state(monkeypatch):
    from routers import maritime
    calls = []
    monkeypatch.setattr(maritime.energy_nowcaster, "record_transit",
                        lambda *a, **k: calls.append(a))
    maritime._vessels.clear()
    mmsi = "777"
    maritime._vessels[mmsi] = {"mmsi": mmsi, "category": "tanker"}
    maritime._check_crossing(mmsi, 26.57, 56.25)   # enter Hormuz — one event
    maritime._check_crossing(mmsi, None, None)     # coord-less ping — must NOT mark exit
    maritime._check_crossing(mmsi, 26.57, 56.25)   # still inside — no second event
    assert len(calls) == 1
    assert maritime._vessels[mmsi]["in_choke"] == "hormuz"
