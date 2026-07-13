"""Real aggregate credit-stress API.

The previous modeled loan portfolios, delinquency buckets, and roll rates were
removed. This route serves observed Federal Reserve bank-loan, financial-stress,
and lending-standards series.
"""
from __future__ import annotations

import logging
import os
import sys
from concurrent.futures import ThreadPoolExecutor

from fastapi import APIRouter

sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))
import fred_credit


logger = logging.getLogger(__name__)
router = APIRouter()


@router.get("/summary")
def summary():
    with ThreadPoolExecutor(max_workers=2) as pool:
        asset_future = pool.submit(fred_credit.market_series)
        stress_future = pool.submit(fred_credit.stress_indicators)
        asset_classes = asset_future.result()
        stress_indicators = stress_future.result()
    all_dates = [item["asof"] for item in asset_classes] + [item["asof"] for item in stress_indicators]
    return {
        "available": bool(asset_classes or stress_indicators),
        "source": "Federal Reserve via FRED",
        "as_of": max(all_dates, default=None),
        "asset_classes": asset_classes,
        "stress_indicators": stress_indicators,
        "method_note": "Observed Federal Reserve aggregates only. No modeled portfolios, loan buckets, roll rates, or merchant-spend proxies.",
    }
