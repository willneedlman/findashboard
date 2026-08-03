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
import json
import logging
import os
import threading
from datetime import date, datetime, timedelta

import pandas as pd
import requests
import yfinance as yf
from fastapi import APIRouter, HTTPException, Query

import finnhub
import options_data
from cache import _run_yf
from disk_cache import disk_get, disk_set

router = APIRouter()
_log = logging.getLogger(__name__)

_MAX_ENRICH = 60
_NASDAQ_UA = {"User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36", "Accept": "application/json"}


def _load_us_fundamentals_seed() -> dict:
    """Bundled snapshot of ~915 major US companies (name/sector/market cap),
    built offline — see routers/screener.py's own loader for the same file.
    Used as phase-1's PRIMARY source: zero-network, zero-rate-limit, so any
    symbol in this seed skips the live Finnhub profile call entirely. Only
    names outside it (smaller/less-followed names, which is most of what a
    market-cap filter excludes anyway) fall back to a live call. Market cap
    here is a point-in-time snapshot, not live — the same staleness trade the
    screener already accepts elsewhere for this exact file."""
    try:
        path = os.path.join(os.path.dirname(os.path.dirname(__file__)), "data", "us_fundamentals.json")
        d = json.load(open(path))
        return {str(k).strip().upper().replace(".", "-"): v for k, v in d.items()} if isinstance(d, dict) else {}
    except Exception as e:
        _log.warning("earnings: us_fundamentals seed load failed: %s", e)
        return {}


_US_FUND_SEED = _load_us_fundamentals_seed()


def _nasdaq_calendar(day: str) -> list[dict]:
    """Earnings for a single date from Nasdaq's calendar API (more complete than
    Finnhub's free feed — includes large caps it omits). Cached 6h. Row shape
    matches finnhub.get_earnings_calendar so the two merge cleanly."""
    ck = f"earn:nasdaq:{day}"
    cached = disk_get(ck)
    if cached is not None:
        return cached
    out: list[dict] = []
    try:
        r = requests.get(f"https://api.nasdaq.com/api/calendar/earnings?date={day}", headers=_NASDAQ_UA, timeout=12)
        rows = ((r.json() or {}).get("data") or {}).get("rows") or []
        for x in rows:
            sym = (x.get("symbol") or "").strip().upper()
            if not sym:
                continue
            t = x.get("time") or ""
            hour = "bmo" if "pre-market" in t else "amc" if "after-hours" in t else ""
            eps = (x.get("epsForecast") or "").strip()
            neg = "(" in eps   # Nasdaq shows negative estimates as "$(0.05)"
            num = eps.replace("$", "").replace(",", "").replace("(", "").replace(")", "")
            try:
                eps_est = (-1 if neg else 1) * float(num) if num else None
            except ValueError:
                eps_est = None
            out.append({"symbol": sym, "date": day, "hour": hour, "quarter": None,
                        "year": None, "epsEstimate": eps_est})
    except Exception as e:
        _log.warning("nasdaq earnings %s: %s", day, e)
        return []
    disk_set(ck, out, ttl=21600)
    return out


def _calendar_rows(d0: date, days: int) -> list[dict]:
    """Core calendar-window logic, shared by the /calendar route and the
    overnight cache-warm loop below."""
    d1 = d0 + timedelta(days=days - 1)
    rows = finnhub.get_earnings_calendar(d0.isoformat(), d1.isoformat())
    # Augment with Nasdaq (Finnhub's free feed omits many large caps, e.g. NKE).
    # One request per day in the window, each independent — fired concurrently
    # rather than in a sequential loop, since a 7-day window used to serialize
    # 7 ~10s HTTP round trips into ~70s of pure waiting for no reason.
    day_strs = [(d0 + timedelta(days=n)).isoformat() for n in range(days)]
    with cf.ThreadPoolExecutor(max_workers=min(14, len(day_strs))) as ex:
        day_results = list(ex.map(_nasdaq_calendar, day_strs))
    seen = {(r.get("date"), r.get("symbol")) for r in rows}
    for day_rows in day_results:
        for nr in day_rows:
            k = (nr["date"], nr["symbol"])
            if k not in seen:
                rows.append(nr)
                seen.add(k)
    rows.sort(key=lambda r: (r["date"] or "", r.get("epsEstimate") is None, r["symbol"]))
    return rows


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

    rows = _calendar_rows(d0, days)
    # Date first, then covered names (those with an estimate) ahead of the
    # long tail of micro-caps that report with no analyst coverage.
    covered = sum(1 for r in rows if r.get("epsEstimate") is not None)
    return {
        "from": d0.isoformat(),
        "to": (d0 + timedelta(days=days - 1)).isoformat(),
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
    ttl = 86400
    try:
        # Routed through cache._run_yf so this shares the app-wide yfinance
        # concurrency semaphore instead of bypassing it — a raw yf.Ticker()
        # call here previously let an 8-16-wide ThreadPoolExecutor batch fire
        # that many *unguarded* concurrent yfinance calls, undermining the
        # exact contention guard the rest of the app relies on.
        # Only the single most recent past date and single nearest future one
        # are ever used below — limit=4 (2 back, 2 forward) safely covers both
        # with far less payload/parse work per ticker than the old limit=12.
        df = _run_yf(f"earnings_dates {sym}", lambda: yf.Ticker(sym).get_earnings_dates(limit=4))
        if df is not None and not df.empty:
            now = pd.Timestamp.now(tz=df.index.tz)
            past = df[df.index < now]
            if not past.empty:
                row = past.iloc[0]
                surp = row.get("Surprise(%)")
                reported = row.get("Reported EPS")
                estimate = row.get("EPS Estimate")
                out = {
                    "date": past.index[0].date().isoformat(),
                    "surprisePct": None if pd.isna(surp) else round(float(surp), 2),
                    "reportedEps": None if pd.isna(reported) else round(float(reported), 2),
                    "epsEstimateAtReport": None if pd.isna(estimate) else round(float(estimate), 2),
                }
                # Yahoo's own actuals routinely lag the report date by a day or
                # more — a JUST-reported ticker with no surprise% yet means "not
                # backfilled by Yahoo," not "never has one." Recheck soon
                # instead of baking in a 24h null; bounded to a recent window so
                # a genuinely old report with no surprise% (Yahoo just never has
                # it) doesn't get stuck on a short TTL forever.
                if out["surprisePct"] is None and (now - past.index[0]).total_seconds() < 3 * 86400:
                    ttl = 1800
            future = df[df.index >= now]
            if not future.empty:
                out["nextDate"] = future.index.min().date().isoformat()
    except Exception:
        # Now that the yfinance call shares the app-wide semaphore, a busy
        # moment legitimately raises YFContention — that's a transient queueing
        # signal, not "this ticker has no earnings history," so it gets a short
        # retry-soon TTL instead of baking a false miss in for a full day.
        out = {}
        ttl = 120

    disk_set(ck, out, ttl=ttl)
    return out


def _report_history(sym: str, n: int = 5) -> list[dict]:
    """Last n reported quarters (oldest first): estimate, actual, surprise% —
    for the estimate-vs-actual bar chart on the ticker detail popup. Shares the
    same yfinance call shape as _prior_report but keeps n rows instead of one;
    cached separately since it's fetched lazily (on popup open), not as part of
    the bulk calendar enrichment."""
    ck = f"earn:history:{sym}:{n}"
    cached = disk_get(ck)
    if cached is not None:
        return cached

    out: list[dict] = []
    ttl = 86400
    try:
        df = _run_yf(f"earnings_dates {sym}", lambda: yf.Ticker(sym).get_earnings_dates(limit=8))
        if df is not None and not df.empty:
            now = pd.Timestamp.now(tz=df.index.tz)
            past = df[df.index < now].head(n)
            for ts, row in past.iloc[::-1].iterrows():
                surp = row.get("Surprise(%)")
                reported = row.get("Reported EPS")
                estimate = row.get("EPS Estimate")
                out.append({
                    "date": ts.date().isoformat(),
                    "estimate": None if pd.isna(estimate) else round(float(estimate), 2),
                    "actual": None if pd.isna(reported) else round(float(reported), 2),
                    "surprisePct": None if pd.isna(surp) else round(float(surp), 2),
                })
    except Exception:
        out = []
        ttl = 120

    disk_set(ck, out, ttl=ttl)
    return out


def _implied_move(sym: str, on_or_after: str | None) -> dict:
    """Expected move into the upcoming report, from the ATM straddle of the expiry
    spanning the earnings date. Cached 4h — was 1h; this is now fetched lazily
    per visible row rather than for the whole calendar upfront, so it's fetched
    far less often overall and can afford to hold a bit longer between refreshes."""
    ck = f"earn:im:{sym}"
    cached = disk_get(ck)
    if cached is not None:
        return cached
    try:
        im = _run_yf(f"implied_move {sym}", lambda: options_data.implied_move(sym, on_or_after=on_or_after))
        if im:
            out = {"pct": im["move_pct"], "expiry": im["expiry"]}
            disk_set(ck, out, ttl=4 * 3600)
        else:
            # No listed options chain (or nothing spans the report date) — for
            # the overwhelming majority of tickers this is a durable fact, not
            # a transient miss, so stop re-attempting a known-dead-end options
            # fetch every hour. Long TTL still self-corrects eventually if a
            # name later gets options listed.
            out = {}
            disk_set(ck, out, ttl=7 * 86400)
    except Exception:
        # Same reasoning as _prior_report: don't cache a contention timeout as
        # "no implied move," and don't let it escape uncaught — _enrich_one is
        # mapped across a ThreadPoolExecutor, where one uncaught exception
        # fails the entire batch's list(ex.map(...)) call, not just this ticker.
        out = {}
        disk_set(ck, out, ttl=120)
    return out


def _enrich_one(sym: str) -> dict:
    # Defensive top-level catch: this runs inside ex.map() across a thread
    # pool, where one uncaught exception fails list(ex.map(...)) for the
    # WHOLE batch, not just this ticker — a single bad symbol must degrade to
    # a mostly-empty row, never take the other 9-plus down with it.
    #
    # Implied move (the options-chain fetch, the single most expensive part
    # of enrichment) is deliberately NOT included here — it's fetched lazily,
    # only for rows actually visible on screen, via /implied-move below. This
    # is what the live calendar's phase-2 pass calls, so it stays as cheap as
    # possible (one yfinance call per symbol, not two).
    try:
        prof = finnhub.get_profile(sym) or {}
    except Exception:
        prof = {}
    try:
        prior = _prior_report(sym)
    except Exception:
        prior = {}
    return {
        "symbol": sym,
        "companyName": prof.get("companyName"),
        "marketCap": prof.get("marketCap") or None,
        "sector": prof.get("sector"),
        "priorReportDate": prior.get("date"),
        "surprisePct": prior.get("surprisePct"),
        "reportedEps": prior.get("reportedEps"),
        "epsEstimateAtReport": prior.get("epsEstimateAtReport"),
        # yfinance's own nearest-future-or-current earnings date — already
        # computed as a side effect of the same call above, so this is free.
        # Only meant as a fallback signal for the client to explain a missing
        # Result: when a row's calendar date doesn't match either
        # priorReportDate OR this, the calendar and yfinance's own confirmed
        # schedule disagree on when this ticker actually reports.
        "nextDate": prior.get("nextDate"),
    }


def _implied_move_one(sym: str) -> dict:
    """Implied move only, keyed off whatever prior-report data is already
    cached (or cheaply fetched) for nextDate. Used by /implied-move (lazy,
    visible-rows-only) and the warm loop (which still wants full coverage
    since nobody's waiting on it)."""
    try:
        prior = _prior_report(sym)
    except Exception:
        prior = {}
    try:
        im = _implied_move(sym, prior.get("nextDate"))
    except Exception:
        im = {}
    return {"symbol": sym, "impliedMove": im.get("pct"), "impliedMoveExpiry": im.get("expiry")}


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


# ── Overnight cache-warm loop ────────────────────────────────────────────────
# Pre-enriches the upcoming TWO weeks of covered names once a day, well before
# market hours, so opening the Scanner during the trading day mostly hits warm
# cache (_prior_report/_implied_move/finnhub.get_profile) instead of paying
# full cold cost on 1000+ names at once. 14 days — the /calendar route's own
# max window — so browsing anywhere within its full range gets the benefit,
# not just the default 1-day view. Sequential and paced on purpose — this
# trades a slow background pass (which nobody is watching) for a fast
# foreground one (which somebody is).
_warm_stop = threading.Event()
_warm_thread = None


def _run_warm_loop():
    _warm_stop.wait(300)   # let boot settle first
    while not _warm_stop.is_set():
        today = date.today().isoformat()
        if disk_get("earn:warmloop") != today:
            try:
                rows = _calendar_rows(date.today(), 14)
                syms = sorted({r["symbol"] for r in rows if r.get("epsEstimate") is not None})
                for sym in syms:
                    if _warm_stop.is_set():
                        return
                    try:
                        _enrich_one(sym)
                        _implied_move_one(sym)   # live /enrich skips this now — the warm pass still covers it
                    except Exception as e:
                        _log.warning("earnings warm-loop %s failed: %s", sym, e)
                    _warm_stop.wait(0.5)   # paced — not a race, nobody's waiting on this pass
                disk_set("earn:warmloop", today, ttl=3 * 86400)
            except Exception as e:
                _log.warning("earnings warm-loop pass failed: %s", e)
        _warm_stop.wait(3600)


def start_calendar_warm_loop():
    global _warm_thread
    if _warm_thread and _warm_thread.is_alive():
        return
    _warm_thread = threading.Thread(target=_run_warm_loop, name="earnings-warm", daemon=True)
    _warm_thread.start()


def stop_calendar_warm_loop():
    _warm_stop.set()


@router.get("/profile")
def profile_only(
    symbols: str = Query(..., description="comma-separated tickers"),
    seed_only: bool = Query(False, description="skip the live Finnhub fallback for symbols outside the bundled seed"),
):
    """Cheap phase-1 pass: company name/market cap/sector only. The client
    uses this to resolve the market-cap filter BEFORE spending the expensive
    /enrich calls — with a tight cap filter active, most rows never need the
    earnings-history or implied-move fetch at all because they're filtered
    out on cap alone.

    The bundled us_fundamentals seed (~1,022 major US names + large IPOs/ADRs)
    is checked first — zero network, zero rate-limit. By default, symbols
    outside it fall back to a live Finnhub profile call. When seed_only=true
    (the client sets this whenever a market-cap filter is active), that
    fallback is skipped entirely — a symbol outside the seed resolves
    instantly with a null cap and is naturally excluded by the filter,
    instead of paying for hundreds of live, rate-limited calls to confirm
    what a cap filter would exclude anyway. Trade-off: a genuine match
    outside the curated seed (very rare for anything at real filter-relevant
    size) won't appear until the filter is cleared and the page is reloaded."""
    syms = [s.strip().upper() for s in symbols.split(",") if s.strip()][:_MAX_ENRICH]
    if not syms:
        return {"rows": []}

    def _one(sym: str) -> dict:
        seed = _US_FUND_SEED.get(sym)
        if seed and seed.get("marketCap") is not None:
            return {"symbol": sym, "companyName": seed.get("companyName"),
                    "marketCap": float(seed["marketCap"]) * 1e9, "sector": seed.get("sector")}
        if seed_only:
            return {"symbol": sym, "companyName": None, "marketCap": None, "sector": None}
        try:
            prof = finnhub.get_profile(sym) or {}
        except Exception:
            prof = {}
        return {"symbol": sym, "companyName": prof.get("companyName"),
                "marketCap": prof.get("marketCap") or None, "sector": prof.get("sector")}

    # Finnhub isn't semaphore-gated like yfinance — this can run wide open.
    with cf.ThreadPoolExecutor(max_workers=min(4, len(syms))) as ex:
        rows = list(ex.map(_one, syms))
    return {"rows": rows}


@router.get("/history")
def history(symbol: str = Query(..., description="single ticker")):
    """Last 5 reported quarters for the detail popup's estimate-vs-actual bars.
    Fetched lazily on popup open, not as part of the bulk calendar enrichment —
    a single ticker's history is cheap, but firing it for every visible row
    would multiply the yfinance call volume for no benefit most of it unseen."""
    sym = symbol.strip().upper()
    if not sym:
        raise HTTPException(400, "symbol is required")
    return {"symbol": sym, "reports": _report_history(sym)}


@router.get("/enrich")
def enrich(symbols: str = Query(..., description="comma-separated tickers")):
    syms = [s.strip().upper() for s in symbols.split(",") if s.strip()][:_MAX_ENRICH]
    if not syms:
        return {"rows": []}

    with cf.ThreadPoolExecutor(max_workers=min(4, len(syms))) as ex:
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


@router.get("/implied-move")
def implied_move_route(symbols: str = Query(..., description="comma-separated tickers")):
    """Options-chain implied move, split out of /enrich and fetched lazily by
    the client only for rows actually visible on screen — this is the single
    most expensive part of enrichment (a full options-chain fetch per
    symbol), so deferring it well past the initial render cuts total yfinance
    call volume for any window bigger than one screenful."""
    syms = [s.strip().upper() for s in symbols.split(",") if s.strip()][:_MAX_ENRICH]
    if not syms:
        return {"rows": []}
    with cf.ThreadPoolExecutor(max_workers=min(4, len(syms))) as ex:
        rows = list(ex.map(_implied_move_one, syms))
    return {"rows": rows}
