"""Sentiment HTTP surface — thin delegator over the `sentiment` engine package.

All logic lives in `backend/sentiment/` (ingest -> validate -> qualify -> score
-> enrich -> aggregate). This module only parses query params and serialises the
`SentimentSnapshot`. The response contract is preserved; optional fields are
stripped when absent, matching the legacy behaviour.
"""
import os
import sys

from dotenv import load_dotenv
from fastapi import APIRouter, Query

sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))
load_dotenv(os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(__file__))), ".env"))

from sentiment.config import DEFAULT_SAMPLE_SIZE  # noqa: E402
from sentiment.engine import build_snapshot, history_payload  # noqa: E402

router = APIRouter()


@router.get("/snapshot")
def sentiment_snapshot(
    refresh: bool = Query(False),
    sample_size: int = Query(DEFAULT_SAMPLE_SIZE, ge=50, le=2000),
    timeframe_hours: int = Query(24, ge=1, le=168),
) -> dict:
    snap = build_snapshot(refresh=refresh, sample_size=sample_size, timeframe_hours=timeframe_hours)
    return snap.model_dump(exclude_none=True)


@router.get("/history")
def sentiment_history() -> dict:
    return history_payload()
