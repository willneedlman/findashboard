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


@router.get("/datasets")
def datasets():
    """Freshness of every offline SQLite dataset baked into the image."""
    from observatory import datasets as ds

    return ds.inventory()


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


_FREIGHT_STATIONS = (
    ("cass_shipments", "Cass shipments", Kind.FLOW, "index",
     "Freight shipment volume across the Cass payment network. Counts loads, not dollars."),
    ("cass_expenditures", "Cass expenditures", Kind.FLOW, "index",
     "Freight spend across the same network. Read against shipments: spend rising on flat "
     "loads is price, not volume."),
    ("truck_tonnage", "Truck tonnage", Kind.FLOW, "index",
     "ATA truckload tonnage hauled."),
    ("inventory_sales", "Inventories to sales", Kind.STOCK, "ratio",
     "Total business inventories divided by sales. Rising means goods are piling up "
     "faster than they clear."),
)


@router.get("/air-cargo-hubs")
def air_cargo_hubs():
    """Hubs with accrued history, and how many days each has."""
    from observatory import air_cargo_history

    hubs = air_cargo_history.hubs_known()
    return {
        "hubs": hubs,
        "note": "History accrues from the day sampling started; nothing is backfilled. "
                "A hub needs roughly three weeks before its baseline is worth trusting.",
    }


@router.get("/air-cargo-board")
def air_cargo_board(
    icao: str = Query(..., description="hub ICAO code (see /air-cargo-hubs)"),
):
    """One cargo hub's freighter movements, read against its own baseline.

    OpenSky is community ADS-B with uneven receiver coverage, so a hub can look
    idle because nobody heard it. Days far below the hub's own median are held
    out as unheard rather than averaged in, the same rule the flaring board uses
    for cloud.
    """
    from observatory import air_cargo_history

    series = air_cargo_history.hub_series(icao)
    if not series["points"]:
        raise HTTPException(503, (
            f"No accrued history for {series['icao']} yet. Movements are sampled "
            "forward from when the sampler started and are never backfilled."
        ))

    spec = StationSpec(
        "movements", f"{series['city']} freighter movements", Kind.FLOW, "/day",
        caption="Freighter arrivals and departures over a settled 24h window. "
                "Community ADS-B undercounts, so this is a floor on real traffic, not a census.",
        source="OpenSky (community ADS-B)", stale_after_days=3,
    )
    board = build_board(f"{series['city']} ({series['icao']})", [spec],
                        {"movements": series["points"]})
    board["viewing"] = {
        "medianDetections": series["medianMoves"],
        "partialViewDays": len(series["partialViews"]),
        "partialViewThreshold": series.get("partialViewThreshold"),
        "filtering": series["partialViewFiltering"],
        "note": "Days whose movement count fell far below this hub's baseline are held out "
                "as receiver gaps rather than counted as quiet days.",
    }
    board["sampledDays"] = series["sampledDays"]
    board["source"] = "OpenSky (community ADS-B)"
    return board


@router.get("/freight-board")
def freight_board():
    """US domestic freight as independent gauges.

    Every series here is monthly and revised, so the window counts observations
    rather than days; judged against a daily yardstick they would all read steady
    forever. Shipments and expenditures are kept apart on purpose — merged into a
    'freight activity index' they can no longer tell volume from price.
    """
    from logistics import free_ingest

    tracks: dict[str, list] = {}
    failures: list[str] = []

    try:
        indices = (free_ingest.freight_indices() or {}).get("indices") or {}
    except Exception as e:                            # noqa: BLE001 — partial board still useful
        indices, failures = {}, [f"FRED freight indices: {e}"]
    for key in ("cass_shipments", "cass_expenditures", "truck_tonnage"):
        entry = indices.get(key) or {}
        tracks[key] = [
            {"d": point["date"], "v": point["value"]}
            for point in (entry.get("series") or [])
            if point.get("date") and point.get("value") is not None
        ]

    try:
        mtis = free_ingest.inventory_sales() or {}
        # MTIS reports a month as YYYY-MM. It is pinned to the first of the month
        # rather than spread across it, because attributing a month's ratio to any
        # single day would be an interpolation.
        tracks["inventory_sales"] = [
            {"d": f"{row['time']}-01" if len(str(row["time"])) == 7 else str(row["time"]),
             "v": row["ratio"]}
            for row in (mtis.get("series") or [])
            if row.get("time") and row.get("ratio") is not None
        ]
    except Exception as e:                            # noqa: BLE001
        tracks["inventory_sales"] = []
        failures.append(f"Census MTIS: {e}")

    if not any(tracks.values()):
        raise HTTPException(502, "No usable freight series returned")

    specs = [
        StationSpec(
            key, label, kind, unit, caption=caption,
            source="FRED" if key != "inventory_sales" else "US Census MTIS",
            # Cass and MTIS publish weeks after month end and revise afterwards.
            stale_after_days=120, window=3,
            window_mode=WindowMode.OBSERVATIONS, expected_interval_days=30,
        )
        for key, label, kind, unit, caption in _FREIGHT_STATIONS
        if tracks.get(key)
    ]
    out = build_board("US domestic freight", specs, tracks)
    out["source"] = "FRED (Cass, ATA) + US Census MTIS"
    if failures:
        out["failures"] = failures
    return out


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
