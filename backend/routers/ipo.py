"""
IPO calendar — date-driven view of upcoming and recent public offerings.

`/calendar` lists IPOs in a trailing window that also reaches ~30 days ahead for
the pipeline. Finnhub's feed is dominantly historical (only a handful of names
are ever scheduled more than two weeks out) and hard-caps a single call at 200
rows, so the window is fetched in 30-day chunks and merged — a 12-month view
would otherwise silently truncate to the most recent 200.

`/enrich` fills the market-cap column and a logo on demand for the rows the
client is showing, from Finnhub's company profile (parqet/FMP have no logo for
freshly listed names). Both come back in one profile lookup, cached 24h.

Finnhub statuses map to the lifecycle the UI shows: expected → Pending,
filed → Filed, priced → Released, withdrawn → Withdrawn.
"""
from __future__ import annotations

import concurrent.futures as cf
from datetime import datetime, timedelta

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel

import finnhub
import ipo_shares
import logodev

router = APIRouter()

_CHUNK_DAYS = 30          # single-call ceiling stays well under Finnhub's 200-row cap
_FORWARD_CUSHION = 30     # days past the anchor, so the upcoming pipeline still shows
_MAX_ENRICH = 60


def _chunks(d0, d1):
    cur = d0
    while cur <= d1:
        end = min(cur + timedelta(days=_CHUNK_DAYS - 1), d1)
        yield cur, end
        cur = end + timedelta(days=1)


@router.get("/calendar")
def calendar(
    date: str = Query(..., description="anchor date, YYYY-MM-DD"),
    days: int = Query(90, ge=1, le=400, description="trailing window length in days"),
):
    if not finnhub.available():
        raise HTTPException(503, "IPO calendar source unavailable")
    try:
        anchor = datetime.strptime(date, "%Y-%m-%d").date()
    except ValueError:
        raise HTTPException(400, "date must be YYYY-MM-DD")

    d0 = anchor - timedelta(days=days - 1)
    d1 = anchor + timedelta(days=_FORWARD_CUSHION)

    spans = list(_chunks(d0, d1))
    with cf.ThreadPoolExecutor(max_workers=6) as ex:
        parts = ex.map(lambda s: finnhub.get_ipo_calendar(s[0].isoformat(), s[1].isoformat()), spans)

    merged: dict[tuple, dict] = {}
    for part in parts:
        for r in part:
            merged[(r.get("date"), r.get("symbol"))] = r
    rows = list(merged.values())
    # Newest first (upcoming pipeline leads), then largest deals within a date.
    rows.sort(key=lambda r: (r.get("date") or "", r.get("dealValue") or 0), reverse=True)
    priced = sum(1 for r in rows if r.get("status") == "priced")
    return {
        "from": d0.isoformat(),
        "to": d1.isoformat(),
        "count": len(rows),
        "priced": priced,
        "rows": rows,
    }


class EnrichRow(BaseModel):
    symbol: str
    name: str = ""


class EnrichReq(BaseModel):
    rows: list[EnrichRow]


def _enrich_one(row: EnrichRow) -> dict:
    sym = row.symbol.strip().upper()
    # Post-offering shares from the prospectus (the IPO-time count, fixed), the
    # company logo, and the domicile country. The client multiplies shares by the
    # offer price for the cap, and treats a non-US domicile as an ADR listing.
    # logo.dev (name→domain) covers new listings; finnhub is a fallback for the
    # established names it happens to have (and the only source of country).
    # Two independent ADR tells: SEC foreign-issuer forms (covers names finnhub has
    # no profile for, e.g. SK hynix via its F-6) and a non-US finnhub domicile
    # (covers names EDGAR full-text search can't pin, e.g. Arm → GB). The finnhub
    # profile also backstops the logo, so it is only fetched when actually needed —
    # logo.dev came up empty, or SEC hasn't already settled foreign status.
    prof = ipo_shares.ipo_profile(sym, row.name)
    logo = logodev.logo_url(row.name, sym)
    foreign = bool(prof["foreign"])
    if not logo or not foreign:
        p = finnhub.get_profile(sym) or {}
        logo = logo or p.get("logo")
        country = (p.get("country") or "").upper()
        foreign = foreign or (bool(country) and country != "US")
    return {
        "symbol": sym,
        "shares": prof["shares"],
        "logo": logo,
        "foreign": foreign,
    }


@router.post("/enrich")
def enrich(req: EnrichReq):
    rows = req.rows[:_MAX_ENRICH]
    if not rows:
        return {"rows": []}
    with cf.ThreadPoolExecutor(max_workers=8) as ex:
        out = list(ex.map(_enrich_one, rows))
    return {"rows": out}
