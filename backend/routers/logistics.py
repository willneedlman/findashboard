"""Geo-Logistics & Supply-Chain endpoints.

Thin wrappers over logistics.free_ingest — every ingest function already caches
aggressively, degrades to stale-on-failure, and never raises, so the routes stay
one-liners. Mounted at /api/logistics.

macro-flows (UN Comtrade bilateral trade -> ISO-3 vectors) and supplier-nodes
(Veridion manufacturers -> GeoJSON) power the network map's two overlay layers.
"""
import datetime
import logging
import os
import sys

from fastapi import APIRouter, Query

sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))
import comtrade  # noqa: E402
from logistics import free_ingest as fi  # noqa: E402
from logistics import veridion  # noqa: E402

logger = logging.getLogger("logistics")
router = APIRouter()


@router.get("/maritime-freight")
def maritime_freight():
    """Container connectivity (UNCTAD LSCI), container spot rate (Drewry WCI), and
    canal chokepoint transits (IMF PortWatch)."""
    return {
        "lsci": fi.liner_connectivity(),
        "wci": fi.drewry_wci(),
        "chokepoints": fi.port_transits(),
    }


@router.get("/air-cargo/vulnerability")
def air_cargo_vulnerability():
    """Freighter movements at the major cargo hubs (OpenSky, partial ADS-B, ~12h lag)."""
    return fi.air_cargo()


@router.get("/flights")
def flights():
    """Live positions of cargo aircraft for the map (OpenSky state vectors, 120s cache)."""
    return fi.flights()


@router.get("/freight-macro")
def freight_macro():
    """US domestic freight: inventories-to-sales (Census MTIS) plus the Cass Freight
    and Truck Tonnage indices (FRED)."""
    return {
        "inventory_sales": fi.inventory_sales(),
        "freight_indices": fi.freight_indices(),
    }


def _fnum(v):
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


@router.get("/macro-flows")
def macro_flows(
    reporter: str = Query("842", description="M49 reporter country code (default 842=USA)"),
    period: str | None = Query(None, description="4-digit year; default = most recent year with data"),
    cmd: str = Query("TOTAL", description="HS commodity code, or TOTAL for all goods"),
    flow: str = Query("X", description="X exports, M imports"),
    top: int = Query(40, ge=1, le=200, description="max partner vectors returned"),
):
    """UN Comtrade bilateral trade for one reporter, as reporter->partner vectors
    keyed by ISO-3 for the macro-flows map layer. Comtrade's public preview needs
    no key. Falls back across recent years when no period is given, and returns
    {available:false} (never an error) when Comtrade is unreachable/empty."""
    if flow not in ("X", "M"):
        flow = "X"
    # Preview data lags ~1-2 years; try the requested year, else the most recent.
    candidates = [period] if period else [str(datetime.date.today().year - n) for n in (1, 2, 3)]
    rows, used = None, None
    for per in candidates:
        if not (per and per.isdigit() and len(per) == 4):
            continue
        rows = comtrade.flows(reporter, per, cmd, flow)
        if rows:
            used = per
            break
    if not rows:
        return {"available": False, "reporter_iso": comtrade.area_iso(reporter), "vectors": []}

    r_iso = comtrade.area_iso(int(reporter)) or comtrade.area_iso(reporter)
    vectors = []
    for r in rows:
        pc = r.get("partnerCode")
        if pc in (0, None):                                # 0 = World aggregate, skip
            continue
        val = _fnum(r.get("primaryValue"))
        p_iso = comtrade.area_iso(pc)
        if not val or not p_iso or not r_iso:
            continue
        vectors.append({
            "from_iso": r_iso, "to_iso": p_iso,
            "from_m49": int(reporter) if str(reporter).isdigit() else reporter, "to_m49": pc,
            "partner": comtrade.area_name(pc), "value": val,
            "net_wgt": _fnum(r.get("netWgt")),
        })
    vectors.sort(key=lambda x: -x["value"])
    vectors = vectors[:top]
    return {
        "available": True,
        "reporter": comtrade.area_name(int(reporter)) if str(reporter).isdigit() else reporter,
        "reporter_iso": r_iso, "period": used,
        "flow": "Exports" if flow == "X" else "Imports", "cmd_code": cmd,
        "max_value": max((v["value"] for v in vectors), default=0),
        "vectors": vectors,
        "source": "UN Comtrade (public preview)",
    }


@router.get("/supplier-nodes")
def supplier_nodes(
    product_keyword: str | None = Query(None, description="substring filter on normalized product names"),
    industry: str | None = Query(None, description="substring filter on core industry"),
    bbox: str | None = Query(None, description="viewport filter 'south,west,north,east' — returns local density"),
    limit: int = Query(6000, ge=1, le=20000),
):
    """Geocoded Veridion manufacturers as a GeoJSON FeatureCollection for the
    supplier-nodes map layer. With a bbox the map loads only the current viewport
    (local density) instead of a global sample. Reads the bounded, pre-built
    data/veridion_nodes.db; returns an empty collection with available:false until
    the offline ETL (logistics.ingest_veridion) has been run with a valid key."""
    box = None
    if bbox:
        try:
            p = [float(x) for x in bbox.split(",")]
            if len(p) == 4:
                box = (min(p[0], p[2]), min(p[1], p[3]), max(p[0], p[2]), max(p[1], p[3]))
        except ValueError:
            box = None
    return veridion.nodes_geojson(product_keyword, industry, box, limit)


@router.get("/supplier-facets")
def supplier_facets():
    """Distinct industry + product tags that drive the map's filter dropdown.
    Data-driven, so no taxonomy is hard-coded; empty until the DB is built."""
    return veridion.facets()
