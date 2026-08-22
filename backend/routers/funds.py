"""Institutional holdings from 13F filings.

Every response carries the as-of period and the quarter it is compared against,
because a 13F is a snapshot up to 45 days old and a reader who does not know
that will read stale positions as current ones.
"""
import logging

from fastapi import APIRouter, HTTPException, Query

import thirteenf
from validation import validate_ticker

router = APIRouter()
logger = logging.getLogger("funds")


@router.get("/managers")
def managers(q: str = Query("", description="Name to search, blank for the tracked list")):
    """Managers matching a name. Blank returns the tracked list."""
    return {"query": q, "managers": thirteenf.search_managers(q)}


@router.get("/book")
def book(cik: str = Query(...), accession: str | None = None, limit: int = Query(500, le=1000)):
    """One manager's positions for a quarter, against the quarter before."""
    if not cik.strip().isdigit():
        raise HTTPException(400, "cik must be numeric")
    out = thirteenf.book(cik.strip(), accession, limit)
    if not out.get("available"):
        raise HTTPException(404, out.get("reason") or f"No 13F on record for CIK {cik}")
    return out


@router.get("/holders")
def holders(ticker: str = Query(...), limit: int = Query(20, le=50)):
    """Which tracked managers reported a ticker. Bounded to the tracked list,
    because the filings offer no index from security back to holder."""
    return thirteenf.holders(validate_ticker(ticker), limit)
