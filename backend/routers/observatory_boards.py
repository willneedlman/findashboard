"""Observation boards backed by official statistics rather than remote sensing.

Kept separate from the maritime router because these feeds fail differently:
they are revised, they publish on a lag of weeks, and their absence is a
publication schedule rather than a cloudy sky.
"""
import os
import sys

from fastapi import APIRouter, HTTPException, Query

sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))

from observatory import Kind, StationSpec, WindowMode, build_board, eia  # noqa: E402

router = APIRouter()


@router.get("/sources")
def sources():
    """Which board feeds are wired, and what to do about the ones that are not."""
    from observatory import copernicus, firms

    return {
        "sources": [
            {
                "id": "copernicus",
                "label": "Copernicus Data Space (Sentinel-1 / Sentinel-2)",
                "available": True,
                "requiresKey": False,
                "note": "Open catalogue. Provides satellite pass coverage, which is what "
                        "lets a coverage gap be distinguished from a real zero.",
                "cloudLimit": copernicus.CLOUD_LIMIT,
            },
            {
                "id": "portwatch",
                "label": "IMF PortWatch",
                "available": True,
                "requiresKey": False,
                "note": "Daily chokepoint transit counts and capacity.",
            },
            {
                "id": "firms",
                "label": "NASA FIRMS (VIIRS thermal anomalies)",
                "available": firms.available(),
                "requiresKey": True,
                "envVar": "FIRMS_MAP_KEY",
                "signup": "https://firms.modaps.eosdis.nasa.gov/api/map_key/",
                "note": "Radiant power for flaring and industrial heat.",
            },
            {
                "id": "eia",
                "label": "EIA v2 energy statistics",
                "available": eia.available(),
                "requiresKey": True,
                "envVar": "EIA_API_KEY",
                "signup": "https://www.eia.gov/opendata/register.php",
                "note": "Production and inventories, to separate a flaring signal into "
                        "more drilling versus less takeaway capacity.",
            },
        ],
    }


@router.get("/energy-board")
def energy_board(
    board: str = Query("us_crude", description="board id (us_crude, us_natgas)"),
    length: int = Query(120, ge=24, le=400),
):
    meta = eia.BOARDS.get(board)
    if not meta:
        raise HTTPException(404, f"Unknown board '{board}'")
    if not eia.available():
        raise HTTPException(503, (
            "EIA_API_KEY is not set. Get a free key at "
            "https://www.eia.gov/opendata/register.php"
        ))

    specs: list[StationSpec] = []
    data: dict[str, list] = {}
    failures: list[str] = []

    for station in meta["stations"]:
        fetched = eia.series(
            station["route"],
            facets=station.get("facets"),
            frequency=station.get("frequency", "monthly"),
            length=length,
        )
        if fetched.get("reason"):
            failures.append(f"{station['label']}: {fetched['reason']}")
        specs.append(StationSpec(
            station["key"], station["label"], Kind(station["kind"]),
            # Prefer the unit EIA reports over the one configured here: the series
            # is the authority on what it measures in.
            fetched.get("units") or station["unit"],
            caption=station.get("caption", ""),
            source=fetched.get("source", "EIA v2"),
            # Official statistics publish on their own cadence; judging a monthly
            # series against a daily freshness window would brand every one stale.
            stale_after_days=station.get("stale_after_days", 45),
            window=station.get("window", 3),
            # Official statistics arrive monthly or weekly, so the window counts
            # observations rather than days and the cadence defines what a gap is.
            window_mode=WindowMode.OBSERVATIONS,
            expected_interval_days=station.get("interval_days", 30),
        ))
        data[station["key"]] = fetched["points"]

    if not any(data.values()):
        raise HTTPException(502, "EIA returned no usable series for this board")

    out = build_board(meta["label"], specs, data)
    out["board"] = board
    out["source"] = "EIA v2"
    if failures:
        out["failures"] = failures
    return out
