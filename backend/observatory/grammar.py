"""Pattern Grammar — deterministic state reads over sparse observation series.

Every number on an observation board comes from a feed that misses days: a
satellite pass that did not clear cloud, an AIS receiver that went dark, a
statistical agency that publishes weekly. The grammar exists so those series can
be described without ever inventing a value to describe.

Three rules hold everywhere in this module:

1. Nothing is interpolated. A trailing average is computed only over days that
   carry a usable observation, and a gap is returned as an explicit gap so the
   chart can break its line instead of drawing through it.
2. Nothing is forecast. Every state describes the trailing window against an
   earlier trailing window. There is no projection, and callers must not present
   the output as one.
3. The rules are fixed and versioned. The same series always yields the same
   state, so a changed read means changed data, not a changed model. Bump
   GRAMMAR_VERSION whenever a threshold below moves.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date, timedelta
from enum import Enum

GRAMMAR_VERSION = "1.1"


class Kind(str, Enum):
    """What a station measures, which decides the vocabulary of its states.

    A level and a rate move for different reasons and deserve different words:
    ships sitting at anchor BUILD and DRAW, crossings per day RISE and FALL.
    """

    STOCK = "stock"
    FLOW = "flow"
    SHARE = "share"


class State(str, Enum):
    STEADY = "steady"
    RISING = "rising"
    FALLING = "falling"
    BUILDING = "building"
    DRAWING = "drawing"
    NORMALISING = "normalising"
    DIVERGING = "diverging"
    STALE = "stale"


_VOCAB: dict[Kind, tuple[State, State]] = {
    Kind.STOCK: (State.BUILDING, State.DRAWING),
    Kind.FLOW: (State.RISING, State.FALLING),
    Kind.SHARE: (State.NORMALISING, State.DIVERGING),
}

# Movement inside this band is noise, not a direction. Expressed as a fraction of
# the earlier window's level so it scales with the series instead of assuming units.
_DEADBAND = 0.05

# A share station is judged by whether it closed the distance to its reference,
# not by which way it moved, so it needs its own band in percentage points.
_SHARE_DEADBAND_PP = 2.0

_DEFAULT_WINDOW = 7
_DEFAULT_STALE_AFTER = 7

# Below this share of the window carrying observations the average is reported but
# marked, because a "7-day average" over two passes is a different object.
_SPARSE_COVERAGE = 0.5

# A silence up to this multiple of the feed's own reporting interval is cadence,
# not a missed observation. Weekly data slipping a day should not read as a gap.
_CADENCE_TOLERANCE = 1.6


class WindowMode(str, Enum):
    """How wide the trailing window is measured.

    DAYS suits a feed that reports most days, where "the last week" is a
    meaningful span. OBSERVATIONS suits anything irregular or low-frequency: a
    monthly statistic has no seven-day window, and judging one against a daily
    yardstick reads every series as steady forever.
    """

    DAYS = "days"
    OBSERVATIONS = "observations"


@dataclass
class StationSpec:
    key: str
    label: str
    kind: Kind
    unit: str
    caption: str = ""
    reference: float | None = None
    source: str = ""
    stale_after_days: int = _DEFAULT_STALE_AFTER
    window: int = _DEFAULT_WINDOW
    window_mode: WindowMode = WindowMode.DAYS
    # How often this feed is expected to report. A monthly series is not full of
    # 29-day coverage gaps; that is simply its cadence, and only a silence well
    # beyond it means the feed actually missed something.
    expected_interval_days: int = 1
    detail: str = ""
    tags: list[str] = field(default_factory=list)


def _parse_points(points: list[dict], value_key: str) -> list[tuple[date, float]]:
    """Usable observations only, de-duplicated by day, oldest first.

    A None, a non-numeric, or an unparseable date is dropped rather than coerced:
    a zero that came from a missing field is indistinguishable from a real zero
    once it is in the series, and the whole point of the grammar is that they
    stay distinguishable.
    """
    seen: dict[date, float] = {}
    for row in points or []:
        raw_d = row.get("d") or row.get("date")
        raw_v = row.get(value_key)
        if raw_d is None or raw_v is None:
            continue
        try:
            day = raw_d if isinstance(raw_d, date) else date.fromisoformat(str(raw_d)[:10])
            value = float(raw_v)
        except (TypeError, ValueError):
            continue
        if value != value:
            continue
        seen[day] = value
    return sorted(seen.items())


def find_gaps(
    observations: list[tuple[date, float]],
    *,
    min_days: int = 2,
    expected_interval_days: int = 1,
) -> list[dict]:
    """Runs of consecutive days with no usable observation, between the first and
    last observation.

    Two things this deliberately does not call a gap. Trailing absence is
    staleness, reported separately so the two never get conflated. And a silence
    no longer than the feed's own cadence is just the cadence — a monthly series
    is not 11 coverage gaps a year.
    """
    gaps: list[dict] = []
    tolerated = max(min_days, int(expected_interval_days * _CADENCE_TOLERANCE))
    for (prev_day, _), (next_day, _) in zip(observations, observations[1:]):
        missing = (next_day - prev_day).days - 1
        if missing >= tolerated:
            gaps.append({
                "from": (prev_day + timedelta(days=1)).isoformat(),
                "to": (next_day - timedelta(days=1)).isoformat(),
                "days": missing,
            })
    return gaps


def _window_mean(
    observations: list[tuple[date, float]],
    end: date,
    window: int,
    mode: WindowMode = WindowMode.DAYS,
) -> tuple[float | None, int]:
    """Mean over the trailing window ending at `end`, counting only real observations.

    Returns (mean, n_observations). n is what tells the caller whether the mean is
    a week's worth of evidence or a single pass wearing a week's label.
    """
    if mode is WindowMode.OBSERVATIONS:
        values = [v for day, v in observations if day <= end][-window:]
    else:
        start = end - timedelta(days=window - 1)
        values = [v for day, v in observations if start <= day <= end]
    if not values:
        return None, 0
    return sum(values) / len(values), len(values)


def _prior_window_end(
    observations: list[tuple[date, float]], end: date, window: int, mode: WindowMode
) -> date | None:
    """Where the comparison window ends.

    In day mode that is a fixed span back. In observation mode it is the day of
    the observation immediately preceding the current window, which is the only
    way to compare like with like when the spacing is irregular.
    """
    if mode is WindowMode.DAYS:
        return end - timedelta(days=window)
    prior = [day for day, _ in observations if day <= end][:-window]
    return prior[-1] if prior else None


def trailing_series(
    observations: list[tuple[date, float]],
    window: int,
    *,
    gap_min_days: int = 2,
    mode: WindowMode = WindowMode.DAYS,
    expected_interval_days: int = 1,
) -> list[dict]:
    """Trailing mean per observed day, with an explicit break across every gap.

    The break is the product, not a side effect. A gap row carries v=None so the
    frontend renders a discontinuity, which is the honest picture of a satellite
    that did not pass rather than a level that held.
    """
    out: list[dict] = []
    if not observations:
        return out

    gaps = find_gaps(observations, min_days=gap_min_days,
                     expected_interval_days=expected_interval_days)

    if mode is WindowMode.OBSERVATIONS:
        # An irregular feed is plotted at the points it actually reported;
        # emitting a value for every calendar day between them would be
        # interpolation wearing a trailing-average label. A gap therefore falls
        # BETWEEN two plotted points rather than on a plotted day of its own, so
        # the break row is dated to the gap's own first missing day. Without it
        # the line joins across the gap, which is the one thing this must never do.
        gap_after = {date.fromisoformat(gap["from"]): gap for gap in gaps}
        previous_day: date | None = None
        for day, _ in observations:
            if previous_day is not None:
                gap = gap_after.get(previous_day + timedelta(days=1))
                if gap:
                    out.append({"d": gap["from"], "v": None})
            mean, n = _window_mean(observations, day, window, mode)
            out.append({"d": day.isoformat(), "v": round(mean, 4), "n": n}
                       if mean is not None else {"d": day.isoformat(), "v": None})
            previous_day = day
        return out

    gap_days = {
        day
        for gap in gaps
        for day in _daterange(date.fromisoformat(gap["from"]), date.fromisoformat(gap["to"]))
    }
    for day in _daterange(observations[0][0], observations[-1][0]):
        if day in gap_days:
            out.append({"d": day.isoformat(), "v": None})
            continue
        mean, n = _window_mean(observations, day, window, mode)
        out.append({"d": day.isoformat(), "v": round(mean, 4), "n": n}
                   if mean is not None else {"d": day.isoformat(), "v": None})
    return out


def _daterange(start: date, end: date):
    day = start
    while day <= end:
        yield day
        day += timedelta(days=1)


def _classify(
    spec: StationSpec, current: float, earlier: float | None
) -> State:
    if earlier is None:
        return State.STEADY
    up, down = _VOCAB[spec.kind]
    if spec.kind is Kind.SHARE and spec.reference is not None:
        # A share is read as distance to its reference band: moving from 41% to
        # 58% against a 60% reference is normalising even though it is "up", and
        # the same move against a 30% reference is diverging.
        before = abs(earlier - spec.reference)
        after = abs(current - spec.reference)
        if abs(after - before) < _SHARE_DEADBAND_PP:
            return State.STEADY
        return up if after < before else down
    if earlier == 0:
        return State.STEADY if current == 0 else up
    change = (current - earlier) / abs(earlier)
    if abs(change) < _DEADBAND:
        return State.STEADY
    return up if change > 0 else down


def read_station(
    spec: StationSpec,
    points: list[dict],
    *,
    value_key: str = "v",
    as_of: date | None = None,
) -> dict:
    """Describe one station's present. Never projects it."""
    today = as_of or date.today()
    observations = _parse_points(points, value_key)
    if not observations:
        return {
            "key": spec.key,
            "label": spec.label,
            "kind": spec.kind.value,
            "unit": spec.unit,
            "caption": spec.caption,
            "detail": spec.detail,
            "source": spec.source,
            "state": State.STALE.value,
            "stale": True,
            "staleDays": None,
            "quality": "dark",
            "value": None,
            "delta": None,
            "lastObs": None,
            "observations": [],
            "trailing": [],
            "gaps": [],
            "grammarVersion": GRAMMAR_VERSION,
        }

    last_day, _ = observations[-1]
    stale_days = (today - last_day).days
    stale = stale_days > spec.stale_after_days

    current, n_current = _window_mean(observations, last_day, spec.window, spec.window_mode)
    prior_end = _prior_window_end(observations, last_day, spec.window, spec.window_mode)
    earlier = (
        _window_mean(observations, prior_end, spec.window, spec.window_mode)[0]
        if prior_end is not None else None
    )

    state = State.STALE if stale else _classify(spec, current, earlier)
    coverage = n_current / spec.window if spec.window else 0.0
    quality = "ok" if coverage >= _SPARSE_COVERAGE else "sparse"

    return {
        "key": spec.key,
        "label": spec.label,
        "kind": spec.kind.value,
        "unit": spec.unit,
        "caption": spec.caption,
        "detail": spec.detail,
        "source": spec.source,
        # A stale station keeps the direction it last showed, so the UI can grey
        # it out while still saying what it said. Hiding it entirely loses the
        # only information a dark feed still carries.
        "state": state.value,
        "lastKnownState": _classify(spec, current, earlier).value if stale else None,
        "stale": stale,
        "staleDays": stale_days,
        "quality": quality,
        "value": round(current, 4) if current is not None else None,
        "delta": round(current - earlier, 4) if (current is not None and earlier is not None) else None,
        "deltaWindow": f"{spec.window}d",
        "reference": spec.reference,
        "lastObs": last_day.isoformat(),
        "observations": [{"d": d.isoformat(), "v": v} for d, v in observations],
        "trailing": trailing_series(
            observations, spec.window,
            mode=spec.window_mode, expected_interval_days=spec.expected_interval_days,
        ),
        "gaps": find_gaps(observations, expected_interval_days=spec.expected_interval_days),
        "windowMode": spec.window_mode.value,
        "grammarVersion": GRAMMAR_VERSION,
    }


_STATE_WORD = {
    State.STEADY: "steady",
    State.RISING: "rising",
    State.FALLING: "falling",
    State.BUILDING: "building",
    State.DRAWING: "drawing",
    State.NORMALISING: "normalising",
    State.DIVERGING: "diverging",
    State.STALE: "stale",
}

_DIRECTION = {
    State.RISING: 1, State.BUILDING: 1, State.NORMALISING: 1,
    State.FALLING: -1, State.DRAWING: -1, State.DIVERGING: -1,
}


def _fmt(value: float | None, unit: str) -> str:
    if value is None:
        return "no reading"
    text = f"{value:,.1f}".rstrip("0").rstrip(".")
    return f"{text} {unit}".strip()


def regional_read(stations: list[dict], *, subject: str) -> dict:
    """Compose the descriptive read across stations.

    Written as a template rather than a prompt on purpose. The claim being made
    is arithmetic, so it should be reproducible, auditable, and free — and it
    must be able to say the stations disagree, which is the sentence a summariser
    optimising for fluency is least likely to write.
    """
    live = [s for s in stations if not s["stale"] and s["value"] is not None]
    stale = [s for s in stations if s["stale"]]

    if not live:
        return {
            "subject": subject,
            "headline": f"No current reading for {subject}.",
            "body": (
                f"All {len(stations)} stations are beyond their freshness window. "
                "The last values are shown as they stood; nothing here describes today."
            ),
            "directions": "none",
            "grammarVersion": GRAMMAR_VERSION,
            "stationStates": _state_chips(stations),
        }

    moving = [s for s in live if State(s["state"]) in _DIRECTION]
    directions = {_DIRECTION[State(s["state"])] for s in moving}

    clauses = []
    for s in live:
        state = State(s["state"])
        clauses.append(f"{s['label'].lower()} {_STATE_WORD[state]} at {_fmt(s['value'], s['unit'])}")

    if not moving:
        verdict = "Every live station is inside its steady band."
        agreement = "flat"
    elif len(directions) == 1:
        way = "higher" if directions == {1} else "lower"
        verdict = (
            f"All {len(moving)} moving stations point the same way, {way}. "
            "That is a shared direction, not a cause."
        )
        agreement = "aligned"
    else:
        verdict = (
            "Taken together the stations do not share a single direction; "
            "read each on its own."
        )
        agreement = "split"

    body = ". ".join([", ".join(clauses).capitalize(), verdict])
    if stale:
        body += (
            f" {len(stale)} station{'s' if len(stale) != 1 else ''} "
            f"({', '.join(s['label'] for s in stale)}) "
            f"{'are' if len(stale) != 1 else 'is'} past the freshness window and excluded."
        )

    return {
        "subject": subject,
        "headline": f"{subject} — regional read",
        "body": body,
        "directions": agreement,
        "liveStations": len(live),
        "staleStations": len(stale),
        "grammarVersion": GRAMMAR_VERSION,
        "stationStates": _state_chips(stations),
    }


def _state_chips(stations: list[dict]) -> list[dict]:
    return [
        {
            "key": s["key"],
            "label": s["label"],
            "state": s["state"],
            "stale": s["stale"],
            "staleDays": s["staleDays"],
        }
        for s in stations
    ]


def build_board(
    subject: str,
    specs: list[StationSpec],
    series_by_key: dict[str, list[dict]],
    *,
    value_key_by_key: dict[str, str] | None = None,
    as_of: date | None = None,
) -> dict:
    """Assemble a full board: every station read independently, then described
    together. Stations are never blended into a composite index — the whole
    design premise is that each is its own measurement with its own freshness."""
    value_keys = value_key_by_key or {}
    stations = [
        read_station(spec, series_by_key.get(spec.key) or [],
                     value_key=value_keys.get(spec.key, "v"), as_of=as_of)
        for spec in specs
    ]
    observed = [s["lastObs"] for s in stations if s["lastObs"]]
    return {
        "subject": subject,
        "stations": stations,
        "read": regional_read(stations, subject=subject),
        "feedAsOf": max(observed) if observed else None,
        "grammarVersion": GRAMMAR_VERSION,
        "descriptive": True,
    }
