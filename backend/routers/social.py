"""Social-mention endpoints — best-effort, no-auth sources only."""
import sys, os
sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))
from fastapi import APIRouter

import reddit_social
from validation import validate_ticker

router = APIRouter()


@router.get("/reddit")
def reddit_mentions(ticker: str):
    sym = validate_ticker(ticker)
    return reddit_social.ticker_mentions(sym)
