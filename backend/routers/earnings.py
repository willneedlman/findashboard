"""
Earnings calendar — date-driven view of upcoming reports.

`/calendar` lists every company reporting in a date window (finnhub, forward
only on the free tier). `/enrich` fills the heavier per-ticker columns on demand
for the rows the client is actually showing: company name, market cap, the prior
report's date and surprise, the one-day reaction to that report, and the run
since. Enrichment is cached 24h per ticker so repeat views are cheap.
"""
from __future__ import annotations

import concurrent.futures as cf
from datetime import date, datetime, timedelta

import pandas as pd
import yfinance as yf
from fastapi import APIRouter, HTTPException, Query

import finnhub
import options_data
from disk_cache import disk_get, disk_set

router = APIRouter()

_MAX_ENRICH = 60


@router.get("/calendar")
def calendar(
    date: str = Query(..., description="anchor date, YYYY-MM-DD"),
    days: int = Query(1, ge=1, le=14, description="window length in days, inclusive"),
):
    if not finnhub.available():
        raise HTTPException(503, "Earnings calendar source unavailable")
    try:
        d0 = datetime.strptime(date, "%Y-%m-%d").date()
    except ValueError:
        raise HTTPException(400, "date must be YYYY-MM-DD")

    d1 = d0 + timedelta(days=days - 1)
    rows = finnhub.get_earnings_calendar(d0.isoformat(), d1.isoformat())
    # Date first, then covered names (those with an estimate) ahead of the
    # long tail of micro-caps that report with no analyst coverage.
    rows.sort(key=lambda r: (r["date"] or "", r.get("epsEstimate") is None, r["symbol"]))
    covered = sum(1 for r in rows if r.get("epsEstimate") is not None)
    return {
        "from": d0.isoformat(),
        "to": d1.isoformat(),
        "count": len(rows),
        "covered": covered,
        "rows": rows,
    }


def _prior_report(sym: str) -> dict:
    """Most recent past earnings date and its surprise %, cached 24h.

    Returns {} when nothing is found so a miss is cached the same as a hit.
    """
    ck = f"earn:prior:{sym}"
    cached = disk_get(ck)
    if cached is not None:
        return cached

    out: dict = {}
    try:
        df = yf.Ticker(sym).get_earnings_dates(limit=12)
        if df is not None and not df.empty:
            now = pd.Timestamp.now(tz=df.index.tz)
            past = df[df.index < now]
            if not past.empty:
                surp = past.iloc[0].get("Surprise(%)")
                out = {
                    "date": past.index[0].date().isoformat(),
                    "surprisePct": None if pd.isna(surp) else round(float(surp), 2),
                }
            future = df[df.index >= now]
            if not future.empty:
                out["nextDate"] = future.index.min().date().isoformat()
    except Exception:
        out = {}

    disk_set(ck, out, ttl=86400)
    return out


def _implied_move(sym: str, on_or_after: str | None) -> dict:
    """Expected move into the upcoming report, from the ATM straddle of the expiry
    spanning the earnings date. Cached 1h so the calendar does not refetch chains."""
    ck = f"earn:im:{sym}"
    cached = disk_get(ck)
    if cached is not None:
        return cached
    im = options_data.implied_move(sym, on_or_after=on_or_after)
    out = {"pct": im["move_pct"], "expiry": im["expiry"]} if im else {}
    disk_set(ck, out, ttl=3600)
    return out


def _enrich_one(sym: str) -> dict:
    prof = finnhub.get_profile(sym) or {}
    prior = _prior_report(sym)
    im = _implied_move(sym, prior.get("nextDate"))
    return {
        "symbol": sym,
        "companyName": prof.get("companyName"),
        "marketCap": prof.get("marketCap") or None,
        "sector": prof.get("sector"),
        "priorReportDate": prior.get("date"),
        "surprisePct": prior.get("surprisePct"),
        "impliedMove": im.get("pct"),
        "impliedMoveExpiry": im.get("expiry"),
    }


def _close_frame(symbols: list[str], start: str, end: str) -> pd.DataFrame:
    if not symbols:
        return pd.DataFrame()
    data = yf.download(
        symbols, start=start, end=end,
        progress=False, auto_adjust=True, threads=True,
    )
    if data is None or data.empty:
        return pd.DataFrame()
    if isinstance(data.columns, pd.MultiIndex):
        return data["Close"]
    close = data[["Close"]].copy()
    close.columns = symbols[:1]
    return close


def _moves(closes: pd.Series, prior: date) -> tuple[float | None, float | None]:
    """One-day reaction to the report and the run since, in percent."""
    s = closes.dropna()
    if s.empty:
        return None, None
    anchor = pd.Timestamp(prior)
    before = s[s.index < anchor]
    after = s[s.index > anchor]
    if before.empty or after.empty:
        return None, None
    prev_c, next_c, last_c = before.iloc[-1], after.iloc[0], s.iloc[-1]
    reaction = round((next_c / prev_c - 1) * 100, 2) if prev_c else None
    run = round((last_c / next_c - 1) * 100, 2) if next_c else None
    return reaction, run


@router.get("/enrich")
def enrich(symbols: str = Query(..., description="comma-separated tickers")):
    syms = [s.strip().upper() for s in symbols.split(",") if s.strip()][:_MAX_ENRICH]
    if not syms:
        return {"rows": []}

    with cf.ThreadPoolExecutor(max_workers=8) as ex:
        base = list(ex.map(_enrich_one, syms))
    by_sym = {r["symbol"]: r for r in base}

    dated = [r["priorReportDate"] for r in base if r.get("priorReportDate")]
    close = pd.DataFrame()
    if dated:
        start = (date.fromisoformat(min(dated)) - timedelta(days=7)).isoformat()
        end = (date.today() + timedelta(days=1)).isoformat()
        price_syms = [r["symbol"] for r in base if r.get("priorReportDate")]
        close = _close_frame(price_syms, start, end)

    for sym in syms:
        r = by_sym[sym]
        r["reactionPct"] = r["runSincePct"] = None
        pd_ = r.get("priorReportDate")
        if pd_ and not close.empty and sym in close.columns:
            r["reactionPct"], r["runSincePct"] = _moves(close[sym], date.fromisoformat(pd_))

    return {"rows": [by_sym[s] for s in syms]}
