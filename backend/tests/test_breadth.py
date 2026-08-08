import datetime as dt

import pandas as pd
import pytest

import breadth


def _frame(columns: dict[str, list[float]]) -> pd.DataFrame:
    index = pd.bdate_range(end=dt.date.today(), periods=len(next(iter(columns.values()))))
    return pd.DataFrame(columns, index=index)


def test_unknown_moving_average_is_not_reported_as_zero():
    """The bug this pins shipped a live chart whose 200-day line read a flat 0%
    for its first thirty-seven sessions. `price > NaN` is False in pandas, so
    summing the raw comparison reports "not enough history yet" as "no member is
    above its average" — a real and very wrong claim."""
    # Sixty rising bars: never enough for a 200-day average, always enough for 50.
    frame = _frame({"AAA": [100.0 + i for i in range(60)], "^X": [1.0] * 60})

    out = breadth._series(frame, "^X")
    first, last = out["points"][0], out["points"][-1]

    assert first["pct_above_200"] is None            # unknown, not zero
    assert last["pct_above_200"] is None
    assert last["pct_above_50"] == 100.0             # rising, so above its own 50-day


def test_a_member_without_enough_history_leaves_the_denominator():
    """A name added to the index last month has no 200-day average. Counting it
    as 'not above' would drag the reading down for every other member."""
    rising = [100.0 + i for i in range(260)]
    newcomer = [float("nan")] * 250 + [50.0 + i for i in range(10)]
    frame = _frame({"OLD": rising, "NEW": newcomer, "^X": [1.0] * 260})

    out = breadth._series(frame, "^X")
    last = out["points"][-1]

    # Only OLD qualifies for a 200-day reading, and it is above its own average.
    assert last["pct_above_200"] == 100.0


def test_advance_decline_line_is_cumulative_net_advancers():
    up, down = [100.0, 101.0, 102.0], [100.0, 99.0, 98.0]
    frame = _frame({"UP": up, "DOWN": down, "^X": [1.0, 1.0, 1.0]})

    points = breadth._series(frame, "^X")["points"]

    # One up and one down every bar nets to zero, so the line never moves.
    assert [p["net_advancers"] for p in points[1:]] == [0, 0]
    assert points[-1]["ad_line"] == 0.0


def test_the_index_is_excluded_from_its_own_breadth():
    """The index column rides along in the same download. Counting it as a
    member would put a 501st 'stock' in a 500-stock measure."""
    frame = _frame({"AAA": [100.0, 101.0], "^X": [5000.0, 4900.0]})
    points = breadth._series(frame, "^X")["points"]
    assert points[-1]["net_advancers"] == 1        # the falling index does not vote
    assert points[-1]["index"] == 4900.0           # but is carried for the overlay


def test_divergence_names_a_narrowing_rally():
    points = [{"date": f"d{i}", "index": 100.0 + i, "ad_line": 100.0 - i * 3} for i in range(21)]
    out = breadth._divergence(points)
    assert out["state"] == "narrowing"
    assert out["ad_line_change"] < 0
    assert out["index_change_pct"] > 0


def test_divergence_names_a_broadening_selloff():
    points = [{"date": f"d{i}", "index": 100.0 - i, "ad_line": 100.0 + i * 3} for i in range(21)]
    assert breadth._divergence(points)["state"] == "broadening"


def test_divergence_stays_quiet_when_both_move_together():
    points = [{"date": f"d{i}", "index": 100.0 + i, "ad_line": 100.0 + i * 3} for i in range(21)]
    assert breadth._divergence(points)["state"] == "aligned"


def test_divergence_needs_a_month_of_bars():
    assert breadth._divergence([{"date": "d0", "index": 1.0, "ad_line": 1.0}]) is None


def test_schema_is_part_of_the_persisted_cache_key():
    """The disk tier sits on a volume that outlives a deploy, so a change to the
    numbers has to invalidate itself or production keeps serving the old ones."""
    import inspect
    assert "schema" in inspect.signature(breadth._breadth.__wrapped__).parameters
    assert breadth._SCHEMA >= 2


def test_lookback_covers_the_plotted_window_for_a_200_day_average():
    """Sizing the download by eye is how the zero-line bug happened. The
    run-up has to clear 200 sessions before the window even starts."""
    sessions = breadth._LOOKBACK_DAYS * 252 / 365
    assert sessions - 200 >= breadth._WINDOW_SESSIONS


def test_untracked_index_explains_itself(monkeypatch):
    monkeypatch.setattr(breadth, "_load", lambda: {"indices": {}})
    out = breadth.breadth("^NOPE")
    assert out["available"] is False
    assert out["reason"]


def test_index_without_a_member_list_says_why(monkeypatch):
    monkeypatch.setattr(breadth, "_load", lambda: {
        "indices": {"^RUT": {"unavailable": "2,000 members, no free list."}}})
    assert breadth.breadth("^RUT")["reason"] == "2,000 members, no free list."


def test_tracked_indices_are_ordered_by_size(monkeypatch):
    monkeypatch.setattr(breadth, "_load", lambda: {"indices": {
        "^SMALL": {"members": [{"ticker": "A"}]},
        "^BIG": {"members": [{"ticker": "A"}, {"ticker": "B"}]},
        "^NONE": {"unavailable": "no list"},
    }})
    out = breadth.tracked_indices()
    assert [i["symbol"] for i in out] == ["^BIG", "^SMALL"]
