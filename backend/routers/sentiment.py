"""Sentiment HTTP surface — thin delegator over the `sentiment` engine package.

All logic lives in `backend/sentiment/` (ingest -> validate -> qualify -> score
-> enrich -> aggregate). This module only parses query params and serialises the
`SentimentSnapshot`. The response contract is preserved; optional fields are
stripped when absent, matching the legacy behaviour.
"""
import os
import sys

from dotenv import load_dotenv
from fastapi import APIRouter, Header, Query
from pydantic import BaseModel

sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))
load_dotenv(os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(__file__))), ".env"))

from sentiment import reports as reports_store  # noqa: E402
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


# ── Admin: mis-score reports ─────────────────────────────────────────────────
class SentimentReport(BaseModel):
    text: str
    url: str | None = None
    source: str | None = None
    published_at: int | None = None
    scored: dict = {}              # as-scored context (sentiment/direction/conf/tier/tag/…)
    correct_sentiment: str | None = None  # admin's read: bullish|bearish|neutral
    note: str | None = None


def _require_admin(secret: str) -> None:
    from routers.users import _require_admin as _check
    _check(secret)


@router.post("/report")
def submit_report(req: SentimentReport, x_admin_secret: str = Header(default="")) -> dict:
    _require_admin(x_admin_secret)
    return reports_store.add(req.model_dump())


@router.get("/reports")
def list_reports(x_admin_secret: str = Header(default="")) -> dict:
    _require_admin(x_admin_secret)
    return {"reports": reports_store.all_reports()}


@router.delete("/reports")
def clear_reports(x_admin_secret: str = Header(default="")) -> dict:
    _require_admin(x_admin_secret)
    return {"cleared": reports_store.clear()}


@router.delete("/reports/{rid}")
def delete_report(rid: str, x_admin_secret: str = Header(default="")) -> dict:
    _require_admin(x_admin_secret)
    return {"deleted": reports_store.delete(rid)}
