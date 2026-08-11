from datetime import date, timedelta

import pytest

from observatory import Kind, StationSpec, build_board, find_gaps, read_station, trailing_series

TODAY = date(2026, 8, 11)


def series(days: int, fn, *, skip=(), end: date = TODAY):
    out = []
    for i in range(days):
        if i in skip:
            continue
        out.append({"d": (end - timedelta(days=days - 1 - i)).isoformat(), "v": fn(i)})
    return out


def spec(key="s", kind=Kind.STOCK, **kw):
    return StationSpec(key, kw.pop("label", "Station"), kind, kw.pop("unit", "ships"), **kw)


def test_gap_is_reported_and_never_interpolated():
    obs = series(30, lambda i: 50.0, skip=range(10, 17))
    station = read_station(spec(), obs, as_of=TODAY)

    assert len(station["gaps"]) == 1
    assert station["gaps"][0]["days"] == 7

    gap_points = [p for p in station["trailing"] if p["v"] is None]
    assert len(gap_points) == 7, "every missing day must break the line"

    observed_days = {p["d"] for p in station["observations"]}
    assert all(p["d"] not in observed_days for p in gap_points)


def test_trailing_average_only_counts_real_observations():
    obs = [{"d": (TODAY - timedelta(days=d)).isoformat(), "v": 10.0} for d in (0, 3)]
    station = read_station(spec(window=7), obs, as_of=TODAY)
    assert station["value"] == 10.0, "two 10s must average 10, not be diluted by absent days"
    assert station["quality"] == "sparse", "a 7d window holding 2 passes must say so"


def test_trailing_leading_absence_is_staleness_not_a_gap():
    obs = series(10, lambda i: 5.0, end=TODAY - timedelta(days=20))
    station = read_station(spec(stale_after_days=7), obs, as_of=TODAY)
    assert station["stale"] is True
    assert station["staleDays"] == 20
    assert station["gaps"] == [], "trailing absence is not a coverage gap"


def test_stale_station_keeps_its_last_known_direction():
    obs = series(20, lambda i: 10.0 + i, end=TODAY - timedelta(days=30))
    station = read_station(spec(kind=Kind.FLOW, unit="/day", stale_after_days=7), obs, as_of=TODAY)
    assert station["state"] == "stale"
    assert station["lastKnownState"] == "rising"
    assert station["value"] is not None


def test_stock_and_flow_use_different_vocabulary():
    rising = series(30, lambda i: 10.0 + i)
    assert read_station(spec(kind=Kind.STOCK), rising, as_of=TODAY)["state"] == "building"
    assert read_station(spec(kind=Kind.FLOW), rising, as_of=TODAY)["state"] == "rising"


def test_share_is_read_as_distance_to_reference():
    toward = series(30, lambda i: 41.0 + i * 0.8)
    away = series(30, lambda i: 74.0 - i * 0.8)
    assert read_station(spec(kind=Kind.SHARE, unit="%", reference=75.0), toward, as_of=TODAY)["state"] == "normalising"
    assert read_station(spec(kind=Kind.SHARE, unit="%", reference=75.0), away, as_of=TODAY)["state"] == "diverging"


def test_deadband_suppresses_noise():
    noisy = series(30, lambda i: 100.0 + (1 if i % 2 else -1))
    assert read_station(spec(), noisy, as_of=TODAY)["state"] == "steady"


def test_zero_and_missing_are_not_the_same():
    with_zero = [{"d": (TODAY - timedelta(days=i)).isoformat(), "v": 0.0} for i in range(8)]
    with_none = [{"d": (TODAY - timedelta(days=i)).isoformat(), "v": None} for i in range(8)]
    assert read_station(spec(), with_zero, as_of=TODAY)["value"] == 0.0
    assert read_station(spec(), with_none, as_of=TODAY)["state"] == "stale"
    assert read_station(spec(), with_none, as_of=TODAY)["quality"] == "dark"


def test_regional_read_states_disagreement():
    specs = [
        StationSpec("up", "Gate transits", Kind.FLOW, "/day"),
        StationSpec("down", "Outside queue", Kind.STOCK, "ships"),
    ]
    board = build_board("Test corridor", specs, {
        "up": series(30, lambda i: 8.0 + i * 0.5),
        "down": series(30, lambda i: 90.0 - i * 1.5),
    }, as_of=TODAY)

    assert board["read"]["directions"] == "split"
    assert "do not share a single direction" in board["read"]["body"]


def test_regional_read_reports_alignment_without_claiming_cause():
    specs = [
        StationSpec("a", "Gate transits", Kind.FLOW, "/day"),
        StationSpec("b", "Inside staging", Kind.STOCK, "ships"),
    ]
    board = build_board("Test corridor", specs, {
        "a": series(30, lambda i: 8.0 + i * 0.5),
        "b": series(30, lambda i: 40.0 + i * 1.5),
    }, as_of=TODAY)

    assert board["read"]["directions"] == "aligned"
    assert "not a cause" in board["read"]["body"]


def test_board_with_every_station_dark_refuses_to_describe_today():
    specs = [StationSpec("a", "A", Kind.STOCK, "ships", stale_after_days=3)]
    board = build_board("Dark corridor", specs, {
        "a": series(5, lambda i: 1.0, end=TODAY - timedelta(days=40)),
    }, as_of=TODAY)

    assert board["read"]["directions"] == "none"
    assert "nothing here describes today" in board["read"]["body"]


def test_output_is_deterministic():
    obs = series(40, lambda i: 20.0 + (i % 5), skip=(7, 8, 9))
    a = read_station(spec(), obs, as_of=TODAY)
    b = read_station(spec(), obs, as_of=TODAY)
    assert a == b


@pytest.mark.parametrize("min_days,expected", [(1, 1), (2, 1), (4, 0)])
def test_gap_threshold_is_configurable(min_days, expected):
    obs = series(20, lambda i: 1.0, skip=range(5, 8))
    parsed = [(date.fromisoformat(p["d"]), p["v"]) for p in obs]
    assert len(find_gaps(parsed, min_days=min_days)) == expected


def test_trailing_series_spans_only_observed_range():
    obs = series(15, lambda i: 3.0)
    parsed = [(date.fromisoformat(p["d"]), p["v"]) for p in obs]
    tr = trailing_series(parsed, 7)
    assert tr[0]["d"] == obs[0]["d"]
    assert tr[-1]["d"] == obs[-1]["d"]


def monthly(n: int, fn, *, end: date = TODAY):
    """n monthly observations pinned to the first of each month."""
    out = []
    for i in range(n):
        month = end.month - (n - 1 - i)
        year = end.year + (month - 1) // 12
        out.append({"d": date(year, (month - 1) % 12 + 1, 1).isoformat(), "v": fn(i)})
    return out


def test_monthly_series_is_readable_in_observation_mode():
    """A day-windowed read of monthly data sees one point and always says steady."""
    from observatory import WindowMode

    rising = monthly(12, lambda i: 100.0 + i * 8)

    day_mode = read_station(
        spec(kind=Kind.FLOW, unit="kb/d", window=7, stale_after_days=75), rising, as_of=TODAY)
    assert day_mode["state"] == "steady", "documents why day windows cannot read monthly data"

    obs_mode = read_station(
        spec(kind=Kind.FLOW, unit="kb/d", window=3, stale_after_days=75,
             window_mode=WindowMode.OBSERVATIONS, expected_interval_days=30),
        rising, as_of=TODAY)
    assert obs_mode["state"] == "rising"


def test_monthly_cadence_is_not_a_coverage_gap():
    from observatory import WindowMode

    station = read_station(
        spec(window=3, stale_after_days=75, window_mode=WindowMode.OBSERVATIONS,
             expected_interval_days=30),
        monthly(10, lambda i: 50.0), as_of=TODAY)
    assert station["gaps"] == [], "a monthly feed is not 9 coverage gaps"


def test_a_genuinely_missed_month_still_reads_as_a_gap():
    from observatory import WindowMode

    points = [p for p in monthly(10, lambda i: 50.0)]
    del points[5:7]
    station = read_station(
        spec(window=3, stale_after_days=75, window_mode=WindowMode.OBSERVATIONS,
             expected_interval_days=30),
        points, as_of=TODAY)
    assert len(station["gaps"]) == 1, "skipping two publications is a real gap"


def test_observation_mode_plots_only_reported_points():
    from observatory import WindowMode

    station = read_station(
        spec(window=3, stale_after_days=75, window_mode=WindowMode.OBSERVATIONS,
             expected_interval_days=30),
        monthly(6, lambda i: 10.0), as_of=TODAY)
    plotted = [p for p in station["trailing"] if p["v"] is not None]
    assert len(plotted) == 6, "no value may be emitted for a day nobody reported"


def test_observation_mode_breaks_the_line_across_a_missed_publication():
    """The gaps array was right while the plotted line joined straight across it.

    Reporting a gap in metadata but drawing through it in the chart is worse than
    not detecting it, because the picture contradicts the disclosure.
    """
    from observatory import WindowMode

    points = [{"d": date(2025, m, 1).isoformat(), "v": 100.0 + m}
              for m in (1, 2, 3, 4, 5, 8, 9, 10, 11, 12)]
    station = read_station(
        spec(kind=Kind.FLOW, unit="u", window=3, stale_after_days=9999,
             window_mode=WindowMode.OBSERVATIONS, expected_interval_days=30),
        points, as_of=date(2026, 1, 1))

    assert len(station["gaps"]) == 1
    breaks = [p for p in station["trailing"] if p["v"] is None]
    assert len(breaks) == 1, "a reported gap must also break the plotted line"
    assert breaks[0]["d"] == station["gaps"][0]["from"]

    dates = [p["d"] for p in station["trailing"]]
    assert len(dates) == len(set(dates)), "a break must not duplicate an observation date"


def test_observation_mode_without_gaps_has_no_breaks():
    from observatory import WindowMode

    station = read_station(
        spec(window=3, stale_after_days=9999, window_mode=WindowMode.OBSERVATIONS,
             expected_interval_days=30),
        monthly(8, lambda i: 40.0), as_of=TODAY)
    assert [p for p in station["trailing"] if p["v"] is None] == []
