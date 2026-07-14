"""Geo-Logistics & Supply-Chain endpoints.

Thin wrappers over logistics.free_ingest — every ingest function already caches
aggressively, degrades to stale-on-failure, and never raises, so the routes stay
one-liners. Mounted at /api/logistics.

supplier-nodes (Veridion manufacturers -> GeoJSON) powers the Freight Map's
supplier layer. Bilateral trade flows live in the Trade Flows tool (/api/comtrade).
"""
import logging
import os
import sys

from fastapi import APIRouter, Query

sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))
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


@router.get("/customer-links")
def get_customer_links(ticker: str = Query(..., description="Ticker to lookup")):
    """Return disclosed customer segment relationships for one ticker in two directions
    (customers/buyers and suppliers), sourced from manual WRDS exports."""
    from logistics import company_fundamentals as cf
    return cf.query_customer_links(ticker)

