"""Stock-valuation models beyond DCF: SOTP, dividend discount, multiples.
The DCF and reverse-DCF live in dcf.py; this router holds the rest of the
Stock Valuation tool's tabs."""
import logging
logger = logging.getLogger(__name__)

from fastapi import APIRouter, HTTPException
import sys, os
sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))
import fmp
from validation import validate_ticker

router = APIRouter()


def _fundamentals(ticker: str) -> dict:
    """Shares (M), net debt ($M), market price — reused across the SOTP/DDM tabs."""
    if fmp.available():
        try:
            return fmp.get_dcf_fundamentals(ticker)
        except Exception:
            pass
    from cache import get_info
    info = get_info(ticker)
    shares     = (info.get("sharesOutstanding") or 0) / 1e6
    total_debt = (info.get("totalDebt") or 0) / 1e6
    cash       = (info.get("totalCash") or info.get("cashAndCashEquivalents") or 0) / 1e6
    price      = float(info.get("currentPrice") or info.get("regularMarketPrice") or 0) or None
    return {"shares": shares, "net_debt": total_debt - cash, "market_price": price}


@router.get("/sotp")
def sotp(ticker: str):
    """Segment revenue for a sum-of-the-parts valuation. The client applies an
    EV/Sales multiple per segment, sums to enterprise value, then subtracts net
    debt for an equity value per share. Revenue returned in $M."""
    sym = validate_ticker(ticker)
    if not fmp.available():
        raise HTTPException(503, "Segment data source unavailable")

    seg = fmp.get_revenue_segments(sym)
    latest = seg.get("latest") or []
    if not latest:
        if seg.get("error"):
            note = ("Segment data is temporarily unavailable (the data provider is rate-limiting). "
                    "Try again in a moment, or use the DCF or Reverse DCF tabs.")
        else:
            note = ("This issuer does not report a product-segment revenue breakdown, "
                    "so a sum-of-the-parts valuation is not available. Use the DCF or Reverse DCF tabs instead.")
        return {"ticker": sym, "segments": [], "note": note, "error": bool(seg.get("error"))}

    segments = [{"name": s["name"], "revenue": round(s["value"] / 1e6, 1), "pct": s.get("pct")}
                for s in latest if s.get("value", 0) > 0]
    total_rev = round(sum(s["revenue"] for s in segments), 1)

    f = _fundamentals(sym)
    net_debt = round(f.get("net_debt") or 0, 1)
    shares   = round(f.get("shares") or 0, 1)
    price    = f.get("market_price")

    # Seed the UI at the company's current blended EV/Sales so SOTP starts near the
    # market price and the user tunes individual segments up or down from fair.
    suggested = None
    if price and shares and total_rev:
        implied_ev = price * shares + net_debt
        suggested = round(max(0.5, min(implied_ev / total_rev, 25.0)), 1)

    return {
        "ticker":             sym,
        "fiscalYear":         seg.get("fiscalYear"),
        "currency":           seg.get("currency"),
        "segments":           segments,
        "total_revenue":      total_rev,
        "net_debt":           net_debt,
        "shares":             shares,
        "market_price":       price,
        "suggested_multiple": suggested,
    }
