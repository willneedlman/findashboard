"""Housing-market analytics API.

Thin HTTP layer over housing_market. The mock cycle is deterministic, so it is
built once per process and reused. Every metric is computed by the engine.
"""

import logging
logger = logging.getLogger(__name__)

import sys
import os

from fastapi import APIRouter, HTTPException, Query

sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))
import housing_market as hm

router = APIRouter()

_REGIONS: list[hm.HousingSeries] | None = None
_RATES: list[hm.MortgageRateRecord] | None = None
_RMAP: dict = {}


def _book() -> tuple[list[hm.HousingSeries], dict]:
    global _REGIONS, _RATES, _RMAP
    if _REGIONS is None:
        _REGIONS, _RATES = hm.generate_mock(months=36)
        _RMAP = hm.rate_map(_RATES)
    return _REGIONS, _RMAP


def _parse_region(value: str | None) -> hm.Region | None:
    if not value:
        return None
    try:
        return hm.Region(value)
    except ValueError:
        raise HTTPException(400, f"Unknown region '{value}'. Valid: {[r.value for r in hm.Region]}")


@router.get("/report")
def report():
    """National-vs-regional posture (price, affordability, supply/demand) + anomaly flags."""
    regions, rmap = _book()
    return hm.market_report(regions, rmap)


@router.get("/region/{region}")
def region_detail(region: str):
    """Full metrics, MoM/YoY trends and monthly history for one region."""
    reg = _parse_region(region)
    regions, rmap = _book()
    match = next((hs for hs in regions if hs.region == reg), None)
    if match is None:
        raise HTTPException(404, f"Region '{region}' not found")
    return hm.region_report(match, rmap)


@router.get("/rates")
def rates():
    """National 30y / 15y / ARM mortgage-rate history."""
    _, rmap = _book()
    return {
        "history": [
            {"asof": r.asof.isoformat(), "rate_30y": r.rate_30y, "rate_15y": r.rate_15y, "rate_arm": r.rate_arm}
            for r in sorted((_RATES or []), key=lambda r: r.asof)
        ],
    }


@router.get("/construction")
def construction(region: str = "national"):
    """New-construction pipeline (starts / permits / completions) for a region."""
    reg = _parse_region(region)
    regions, _ = _book()
    match = next((hs for hs in regions if hs.region == reg), None)
    if match is None:
        raise HTTPException(404, f"Region '{region}' not found")
    return {
        "region": match.region.value,
        "history": [
            {"asof": c.asof.isoformat(), "housing_starts": c.housing_starts,
             "building_permits": c.building_permits, "completions": c.completions}
            for c in sorted(match.construction, key=lambda c: c.asof)
        ],
    }


@router.get("/affordability")
def affordability(
    median_price: float = Query(..., gt=0),
    median_income: float = Query(..., gt=0),
    rate_30y: float = Query(..., gt=0),
    down_pct: float = 0.20,
    front_ratio: float = 0.25,
):
    """On-demand HAI calculator for custom price/income/rate inputs."""
    if not 0 <= down_pct < 1:
        raise HTTPException(400, "down_pct must be in [0, 1)")
    if not 0 < front_ratio <= 1:
        raise HTTPException(400, "front_ratio must be in (0, 1]")
    from datetime import date
    snap = hm.HousingMarketSnapshot(
        region=hm.Region.NATIONAL, asof=date.today(),
        median_price=median_price, price_per_sqft=0, median_income=median_income,
        sales_volume=0, pending_sales=0, days_on_market=0, active_listings=0,
    )
    qi = hm.qualifying_income(median_price, rate_30y, down_pct, front_ratio)
    loan = median_price * (1 - down_pct)
    return {
        "affordability_index": round(hm.affordability_index(snap, rate_30y, down_pct, front_ratio), 1),
        "qualifying_income": round(qi, 2),
        "monthly_pi": round(hm.monthly_payment(loan, rate_30y), 2),
        "loan_amount": round(loan, 2),
        "price_to_income": round(median_price / median_income, 3),
        "assumptions": {"down_pct": down_pct, "front_ratio": front_ratio, "term_months": 360},
    }
