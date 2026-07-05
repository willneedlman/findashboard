"""Credit delinquency & default API.

Thin HTTP layer over credit_delinquencies. The mock book is deterministic, so
it is built once per process and reused. Every metric is computed by the engine.
"""

import logging
logger = logging.getLogger(__name__)

import sys
import os
from datetime import date

from fastapi import APIRouter, HTTPException, Query

sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))
import credit_delinquencies as cd

router = APIRouter()

# Deterministic mock book, built lazily and cached for the process lifetime.
_BOOK: list[cd.Portfolio] | None = None
_BENCHMARKS: dict[str, cd.MarketBenchmark] | None = None


def _book() -> list[cd.Portfolio]:
    global _BOOK, _BENCHMARKS
    if _BOOK is None:
        _BOOK = cd.generate_mock_portfolios(months=60)   # 5y history for period-over-period change
        _BENCHMARKS = cd.mock_benchmarks(_BOOK)
    return _BOOK


def _parse_asset_class(value: str | None) -> cd.AssetClass | None:
    if not value:
        return None
    try:
        return cd.AssetClass(value)
    except ValueError:
        raise HTTPException(400, f"Unknown asset_class '{value}'. "
                                 f"Valid: {[a.value for a in cd.AssetClass]}")


def _parse_region(value: str | None) -> cd.Region | None:
    if not value:
        return None
    try:
        return cd.Region(value)
    except ValueError:
        raise HTTPException(400, f"Unknown region '{value}'. "
                                 f"Valid: {[r.value for r in cd.Region]}")


@router.get("/summary")
def summary(threshold: float = Query(5.0, ge=0), region: str | None = None):
    """Book-wide risk posture with asset-class rollups and threshold flags."""
    book = _book()
    reg = _parse_region(region)
    if reg is not None:
        book = [p for p in book if p.region == reg]
    return cd.risk_report(book, default_threshold=threshold)


@router.get("/portfolios")
def portfolios(asset_class: str | None = None, region: str | None = None):
    """Lightweight list of portfolios with their current headline metrics."""
    ac = _parse_asset_class(asset_class)
    reg = _parse_region(region)
    out = []
    for p in _book():
        if ac is not None and p.asset_class != ac:
            continue
        if reg is not None and p.region != reg:
            continue
        latest = p.latest
        if latest is None:
            continue
        out.append({
            "portfolio_id": p.portfolio_id,
            "name": p.name,
            "product": p.product.value,
            "product_label": cd.PRODUCT_LABEL[p.product],
            "asset_class": p.asset_class.value,
            "region": p.region.value,
            "outstanding": round(latest.outstanding, 2),
            "delinquency_rate_30plus": round(cd.delinquency_rate(latest), 4),
            "npa_ratio": round(cd.npa_ratio(latest), 4),
            "annualized_default_rate": round(cd.annualized_default_rate(p.records), 4),
        })
    return {"count": len(out), "portfolios": sorted(out, key=lambda x: -x["annualized_default_rate"])}


@router.get("/portfolio/{portfolio_id}")
def portfolio_detail(portfolio_id: str):
    """Full metrics, roll rates, 24-month trend and benchmark for one book."""
    match = next((p for p in _book() if p.portfolio_id == portfolio_id), None)
    if match is None:
        raise HTTPException(404, f"Portfolio '{portfolio_id}' not found")
    benchmark = (_BENCHMARKS or {}).get(match.asset_class.value)
    return cd.portfolio_summary(match, benchmark=benchmark)


@router.get("/roll-rates")
def roll_rates(asset_class: str | None = None, region: str | None = None):
    """Average bucket-to-bucket roll probabilities for the selected slice."""
    ac = _parse_asset_class(asset_class)
    reg = _parse_region(region)
    records = cd.filter_records(
        [r for p in _book() for r in p.records], asset_class=ac, region=reg,
    )
    if not records:
        raise HTTPException(404, "No records for that selection")
    agg = cd.aggregate_records(records, "selection")
    return {
        "asset_class": ac.value if ac else "all",
        "region": reg.value if reg else "all",
        "roll_rates": {k: round(v, 4) for k, v in cd.roll_rates(agg).items()},
    }


@router.get("/benchmarks")
def benchmarks():
    """Industry composite delinquency/default/NPA per asset class."""
    _book()
    return {
        k: {
            "asset_class": b.asset_class.value,
            "period": b.period,
            "delinquency_rate": b.delinquency_rate,
            "default_rate": b.default_rate,
            "npa_ratio": b.npa_ratio,
            "source": b.source,
        }
        for k, b in (_BENCHMARKS or {}).items()
    }
