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
def managers(
    q: str = Query("", description="Name to search, blank for the largest filers"),
    kinds: str = Query("", description="Comma-separated labels to keep"),
    min_value: float = Query(0, ge=0, description="Smallest reported book to include"),
    sort: str = Query("value", pattern="^(value|name)$"),
    confirmed: bool = Query(False, description="Only labels confirmed by Form ADV"),
    limit: int = Query(40, le=200),
):
    """Managers matching a name and filters, largest book first."""
    picked = tuple(k.strip() for k in kinds.split(",") if k.strip())
    return {"query": q, "kinds": list(picked), "minValue": min_value,
            "managers": thirteenf.search_managers(q, picked, min_value, sort, confirmed)[:limit]}


@router.get("/kinds")
def kinds():
    """Every label in the dataset with a count, for the filter to offer."""
    return {"kinds": thirteenf.db_kinds()}


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
