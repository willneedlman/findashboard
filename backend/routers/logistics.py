"""Geo-Logistics & Supply-Chain endpoints.

Thin wrappers over logistics.free_ingest — every ingest function already caches
aggressively, degrades to stale-on-failure, and never raises, so the routes stay
one-liners. Mounted at /api/logistics.
"""
import logging

from fastapi import APIRouter

from logistics import free_ingest as fi

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
