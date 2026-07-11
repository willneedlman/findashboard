"""BCC Research market-sizing endpoint (public MCP semantic search)."""
import sys, os
from fastapi import APIRouter, Query

sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))
import bcc_research

router = APIRouter()


@router.get("/market-size")
def market_size(query: str = Query(..., min_length=2), count: int = Query(5, ge=1, le=20)):
    """Top BCC Research reports for a query, each with a market-size headline
    (from -> to by year, CAGR) parsed from the report highlights."""
    rows = bcc_research.market_size(query, count)
    return {"query": query, "count": len(rows), "reports": rows, "source": "BCC Research"}
