"""Gap attribution is pure given a coverage map, so it is tested without network."""
from observatory import copernicus


def coverage(**days):
    return {
        day: {"passes": p, "usable": u, "bestCloud": c, "platforms": ["SENTINEL-1"]}
        for day, (p, u, c) in days.items()
    }


GAP = [{"from": "2026-08-02", "to": "2026-08-04", "days": 3}]


def test_gap_with_no_pass_is_unobservable():
    out = copernicus.attribute_gaps(GAP, coverage())
    assert out[0]["reason"] == "no_pass"
    assert out[0]["passes"] == 0


def test_gap_with_only_clouded_passes_names_cloud():
    cov = coverage(**{
        "2026-08-02": (2, 0, 91.0),
        "2026-08-03": (1, 0, 88.0),
    })
    out = copernicus.attribute_gaps(GAP, cov)
    assert out[0]["reason"] == "cloud"
    assert out[0]["usablePasses"] == 0


def test_gap_with_clear_passes_is_flagged_unexplained():
    cov = coverage(**{
        "2026-08-02": (2, 2, 3.0),
        "2026-08-03": (1, 1, 0.0),
        "2026-08-04": (1, 1, 1.0),
    })
    out = copernicus.attribute_gaps(GAP, cov)
    assert out[0]["reason"] == "unexplained", (
        "a gap the satellites could see through is a pipeline fault, not an observability limit"
    )
    assert "measurement is missing" in out[0]["detail"]


def test_mixed_coverage_reports_partial():
    cov = coverage(**{
        "2026-08-02": (1, 1, 5.0),
        "2026-08-03": (2, 0, 95.0),
    })
    out = copernicus.attribute_gaps(GAP, cov)
    assert out[0]["reason"] == "partial"


def test_attribution_preserves_the_original_gap_fields():
    out = copernicus.attribute_gaps(GAP, coverage())
    assert out[0]["from"] == "2026-08-02"
    assert out[0]["to"] == "2026-08-04"
    assert out[0]["days"] == 3


def test_coverage_summary_counts_usable_days_not_passes():
    cov = coverage(**{
        "2026-08-02": (4, 4, 0.0),
        "2026-08-03": (3, 0, 99.0),
    })
    summary = copernicus.coverage_summary(cov, days=10)
    assert summary["daysWithPass"] == 2
    assert summary["daysWithUsablePass"] == 1
    assert summary["lookRate"] == 0.1


def test_firms_degrades_without_a_key(monkeypatch):
    from observatory import firms
    monkeypatch.delenv("FIRMS_MAP_KEY", raising=False)
    out = firms.radiant_power_series((-104.6, 31.0, -101.5, 33.0), days=30)
    assert out["available"] is False
    assert out["points"] == [], "a missing key must never produce a fabricated series"
    assert "map_key" in out["reason"]


def test_firms_emits_real_zeros_for_days_it_actually_queried(monkeypatch):
    """A covered day with no detections is 'nothing burning', not 'we did not look'.

    Dropping it would break the chart line exactly when flaring stops, turning the
    single most meaningful reading into an apparent outage.
    """
    from datetime import date
    from observatory import firms

    monkeypatch.setenv("FIRMS_MAP_KEY", "test-key")
    monkeypatch.setattr(firms, "disk_get", lambda _k: None)
    monkeypatch.setattr(firms, "disk_set", lambda *_a, **_k: None)
    monkeypatch.setattr(firms, "data_availability",
                        lambda _s: (date(2026, 8, 1), date(2026, 8, 10)))

    def fake_window(_key, _source, _bbox, start, span):
        if start == date(2026, 8, 1):
            return [{"acq_date": "2026-08-01", "confidence": "h", "frp": "12.5"}]
        return []

    monkeypatch.setattr(firms, "_fetch_window", fake_window)

    out = firms.radiant_power_series((-1.0, 1.0, 1.0, 2.0), days=10,
                                     sources=("VIIRS_SNPP_NRT",), as_of=date(2026, 8, 10))
    by_day = {p["d"]: p["v"] for p in out["points"]}

    assert by_day["2026-08-01"] == 12.5
    assert by_day["2026-08-05"] == 0.0, "a queried day with no fire is a real zero"
    assert len(out["points"]) == 10, "every day inside the archive window was asked about"
    assert out["degraded"] is False


def test_firms_flags_a_mostly_failed_fetch_instead_of_returning_a_thin_series(monkeypatch):
    from datetime import date
    from observatory import firms

    monkeypatch.setenv("FIRMS_MAP_KEY", "test-key")
    monkeypatch.setattr(firms, "disk_get", lambda _k: None)
    monkeypatch.setattr(firms, "disk_set", lambda *_a, **_k: None)
    monkeypatch.setattr(firms, "data_availability",
                        lambda _s: (date(2026, 6, 1), date(2026, 8, 10)))

    def mostly_failing(_key, _source, _bbox, start, span):
        if start.day % 10 == 1:
            return [{"acq_date": start.isoformat(), "confidence": "h", "frp": "5"}]
        raise RuntimeError("Invalid day range. Expects [1..5].")

    monkeypatch.setattr(firms, "_fetch_window", mostly_failing)

    out = firms.radiant_power_series((-1.0, 1.0, 1.0, 2.0), days=70,
                                     sources=("VIIRS_SNPP_NRT",), as_of=date(2026, 8, 10))
    assert out["degraded"] is True
    assert "should not be read as a level" in out["reason"]


def _firms_env(monkeypatch, rows_for):
    from datetime import date
    from observatory import firms
    monkeypatch.setenv("FIRMS_MAP_KEY", "test-key")
    monkeypatch.setattr(firms, "disk_get", lambda _k: None)
    monkeypatch.setattr(firms, "disk_set", lambda *_a, **_k: None)
    monkeypatch.setattr(firms, "data_availability",
                        lambda _s: (date(2026, 8, 1), date(2026, 8, 20)))
    monkeypatch.setattr(firms, "_fetch_window", rows_for)
    return firms


def test_obscured_days_are_held_out_not_averaged_in(monkeypatch):
    """A cloud-obscured day reads as a collapse if it is treated as a level."""
    from datetime import date, timedelta

    def rows(_k, _s, _b, start, span):
        out = []
        for offset in range(span):
            day = start + timedelta(days=offset)
            # 2026-08-10 is obscured: 2 detections against a baseline of 40.
            n = 2 if day == date(2026, 8, 10) else 40
            out += [{"acq_date": day.isoformat(), "confidence": "h", "frp": "10"}] * n
        return out

    firms = _firms_env(monkeypatch, rows)
    out = firms.radiant_power_series((-1.0, 1.0, 1.0, 2.0), days=20,
                                     sources=("VIIRS_SNPP_NRT",), as_of=date(2026, 8, 20))

    assert out["partialViewFiltering"] is True
    assert out["medianDetections"] == 40
    held = {row["d"] for row in out["partialViews"]}
    assert "2026-08-10" in held
    assert "2026-08-10" not in {p["d"] for p in out["points"]}
    # The reading is disclosed rather than deleted.
    assert next(r for r in out["partialViews"] if r["d"] == "2026-08-10")["frp"] == 20.0
    assert all(p["v"] == 400.0 for p in out["points"]), "no obscured day may enter the level series"


def test_low_baseline_field_keeps_its_real_zeros(monkeypatch):
    """Where nothing much burns, a zero is a zero and the ratio test must stand down."""
    from datetime import date, timedelta

    def rows(_k, _s, _b, start, span):
        out = []
        for offset in range(span):
            day = start + timedelta(days=offset)
            if day.day % 2 == 0:
                out.append({"acq_date": day.isoformat(), "confidence": "h", "frp": "3"})
        return out

    firms = _firms_env(monkeypatch, rows)
    out = firms.radiant_power_series((-1.0, 1.0, 1.0, 2.0), days=20,
                                     sources=("VIIRS_SNPP_NRT",), as_of=date(2026, 8, 20))

    assert out["partialViewFiltering"] is False
    assert out["partialViews"] == []
    assert any(p["v"] == 0.0 for p in out["points"]), "a queried quiet day stays a real zero"


def test_flaring_gaps_are_attributed_by_firms_not_by_sentinel():
    """Sentinel passes cannot explain a VIIRS gap; different satellites, different times."""
    from observatory import firms

    gaps = [{"from": "2026-08-09", "to": "2026-08-10", "days": 2}]
    result = {"partialViews": [{"d": "2026-08-09", "detections": 1, "frp": 0.4},
                               {"d": "2026-08-10", "detections": 2, "frp": 1.1}]}
    out = firms.attribute_gaps(gaps, result)
    assert out[0]["reason"] == "partial_view"
    assert out[0]["obscuredDays"] == 2
    assert "not quiet" in out[0]["detail"]


def test_gap_with_no_partial_view_record_is_not_blamed_on_cloud():
    from observatory import firms

    out = firms.attribute_gaps([{"from": "2026-08-09", "to": "2026-08-10", "days": 2}],
                               {"partialViews": []})
    assert out[0]["reason"] == "no_reading"
    assert out[0]["obscuredDays"] == 0
