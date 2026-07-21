"""Mover Radar — why a ticker is moving, or confirmation it's just noise."""
import sys, os
sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))
from fastapi import APIRouter

import mover_radar
from validation import validate_ticker

router = APIRouter()


@router.get("/explain")
def explain(ticker: str, timeframe: str = "1d"):
    sym = validate_ticker(ticker)
    return mover_radar.analyze(sym, timeframe)
