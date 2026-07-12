"""Real aggregate credit stress and consumer-spend API.

The previous modeled loan portfolios, delinquency buckets, and roll rates were
removed. This route serves only observed FRED bank-loan series plus an optional
offline SafeGraph merchant-spend aggregate.
"""
from __future__ import annotations

import logging
import os
import sys

from fastapi import APIRouter

sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))
import consumer_spend
import fred_credit


logger = logging.getLogger(__name__)
router = APIRouter()


@router.get("/summary")
def summary():
    asset_classes = fred_credit.market_series()
    spend = consumer_spend.summary()
    return {
        "available": bool(asset_classes), "source": "FRED · St. Louis Fed",
        "as_of": max((item["asof"] for item in asset_classes), default=None),
        "asset_classes": asset_classes, "consumer_spend": spend,
        "method_note": "Bank-industry aggregate rates. No modeled portfolios, loan buckets, or roll rates.",
    }
