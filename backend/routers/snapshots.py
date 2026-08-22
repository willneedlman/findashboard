"""Daily snapshots for series that only exist as live computations (dealer
GEX, ATM IV30). Neither has a historical source, so history must accrue:
points are recorded write-through whenever the live tools compute them, by
the /series endpoint on first view of the day, and by a slow daily loop over
a core watchlist. One point per ticker per day, persisted via disk_cache.
"""
import json
import logging
import sqlite3
import threading
import sys, os
from datetime import date, datetime, timedelta
from pathlib import Path
from fastapi import APIRouter, HTTPException, Query

sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))
from disk_cache import disk_get, disk_set
from validation import validate_ticker

router = APIRouter()
_log = logging.getLogger("snapshots")

_KINDS = ("gex", "iv30", "est")
_CORE = ["SPY", "QQQ", "AAPL", "NVDA", "MSFT", "TSLA"]
_MAX_POINTS = 1600
_TTL = 5 * 365 * 86400
_MAX_BOOK_TICKERS = 60   # protect the daily pass from a pathological watchlist size

_USERS_DB_PATH = Path(os.getenv("USERS_DB_PATH", str(Path(__file__).resolve().parents[2] / "users.db")))


def _book_tickers() -> list[str]:
    """Every ticker held across all saved portfolios, so the daily snapshot
    pass covers what's actually in the book — not just the fixed core watch
    list — and features like the Morning Brief's gamma-flip badge have real
    data to show for the names that matter, not just SPY/QQQ/megacaps."""
    try:
        conn = sqlite3.connect(f"file:{_USERS_DB_PATH}?mode=ro", uri=True)
        rows = conn.execute("SELECT portfolio_json FROM users WHERE portfolio_json IS NOT NULL").fetchall()
        conn.close()
    except Exception as e:
        _log.warning("book ticker read failed: %s", e)
        return []
    tickers: set[str] = set()
    for (raw,) in rows:
        try:
            for h in json.loads(raw or "[]"):
                t = str(h.get("ticker") or "").strip().upper()
                if t:
                    tickers.add(t)
        except Exception:
            continue
    return sorted(tickers)[:_MAX_BOOK_TICKERS]


def record_point(kind: str, sym: str, payload: dict, day: str | None = None,
                 keep_existing: bool = False) -> None:
    """Insert/overwrite one day's point in a ticker's snapshot series.

    `day` writes to a past date, which only backfill uses. `keep_existing`
    makes it a no-op when that date already has a point, so a reconstructed
    figure can never overwrite one that was actually observed.
    """
    sym = sym.strip().upper()
    key = f"snap:{kind}:{sym}"
    series = disk_get(key) or []
    when = day or date.today().isoformat()
    if keep_existing and any(p.get("d") == when for p in series):
        return
    series = [p for p in series if p.get("d") != when]
    series.append({"d": when, **payload})
    series.sort(key=lambda p: p["d"])
    disk_set(key, series[-_MAX_POINTS:], ttl=_TTL)


def get_points(kind: str, sym: str) -> list:
    return disk_get(f"snap:{kind}:{sym.strip().upper()}") or []


def _compute_gex(sym: str) -> dict | None:
    """Net dealer gamma exposure ($M) from the live GEX profile, plus the
    gamma-flip level (per-strike net sign change nearest spot) so alerts can
    watch price/flip crosses without re-running the 20-40s profile."""
    from routers.options import dealer_gex
    d = dealer_gex(sym)
    rows = d.get("data") or []
    if not rows:
        return None

    def _net(r: dict) -> float:
        v = r.get("net_gex")
        return float(v) if v is not None else float((r.get("call_gex") or 0) + (r.get("put_gex") or 0))

    out = {"v": round(sum(_net(r) for r in rows), 2)}
    spot = d.get("spot")
    if spot:
        spot = float(spot)
        out["spot"] = round(spot, 2)
        srt = sorted((r for r in rows if r.get("strike") is not None), key=lambda r: r["strike"])
        flip = None
        for a, b in zip(srt, srt[1:]):
            if _net(a) * _net(b) < 0:
                cand = a["strike"] if abs(a["strike"] - spot) <= abs(b["strike"] - spot) else b["strike"]
                if flip is None or abs(cand - spot) < abs(flip - spot):
                    flip = cand
        if flip is not None:
            out["flip"] = round(float(flip), 2)
    return out


def _compute_iv30(sym: str) -> dict | None:
    """ATM implied vol (%) at the expiry nearest 30 DTE, call/put mid."""
    import options_data
    from cache import get_history
    exps = options_data.get_expirations(sym)
    if not exps:
        return None
    today = date.today()
    target = min(exps, key=lambda e: abs((date.fromisoformat(e) - today).days - 30))
    chain = options_data.get_chain(sym, target)
    hist = get_history(sym, period="5d")
    if hist.empty:
        return None
    spot = float(hist["Close"].dropna().iloc[-1])

    def atm_iv(df) -> float | None:
        if df is None or df.empty or "impliedVolatility" not in df.columns:
            return None
        d = df.dropna(subset=["impliedVolatility"])
        d = d[d["impliedVolatility"] > 0.005]
        if d.empty:
            return None
        row = d.iloc[(d["strike"] - spot).abs().argsort().iloc[0]]
        return float(row["impliedVolatility"])

    ivs = [v for v in (atm_iv(chain.calls), atm_iv(chain.puts)) if v is not None]
    if not ivs:
        return None
    iv = sum(ivs) / len(ivs)
    return {"v": round(iv * 100, 2), "expiry": target}


# ── Analyst estimates ────────────────────────────────────────────────────────
# Consensus for the fiscal years not yet reported. No free source carries a
# dense history of where consensus HAS been, so the series has to accrue the
# same way GEX does. Alpha Vantage does carry four lookback points per row
# (7, 30, 60 and 90 days), which is enough to start with a quarter of history
# instead of a single dot.

def _num(v) -> float | None:
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    return None if f != f else f


_AV_DAILY_BUDGET = 15   # of Alpha Vantage's 25/day, shared with holdings and history


def _av_fiscal_years(sym: str) -> list[dict]:
    """Alpha Vantage fiscal-year rows, within a daily call budget.

    Returning nothing when the budget is spent is deliberate: the caller falls
    back to Yahoo, which covers the same two years without the lookbacks, and
    that is a better outcome than a quota error taking the whole series down.
    """
    day = date.today().isoformat()
    used = disk_get(f"snap:avbudget:{day}") or 0
    if used >= _AV_DAILY_BUDGET:
        return []
    import alphavantage as av
    rows = av.earnings_estimates(sym)
    disk_set(f"snap:avbudget:{day}", used + 1, ttl=2 * 86400)
    return [r for r in rows if r.get("horizon") == "fiscal year"]


def _compute_est(sym: str) -> dict | None:
    """Today's consensus per fiscal year: EPS, revenue and analyst count."""
    fy: dict[str, dict] = {}
    for row in _av_fiscal_years(sym):
        year = str(row.get("date") or "")[:4]
        if not year:
            continue
        eps, rev = _num(row.get("eps_estimate_average")), _num(row.get("revenue_estimate_average"))
        n = _num(row.get("eps_estimate_analyst_count"))
        if eps is None and rev is None:
            continue
        fy[year] = {k: v for k, v in
                    (("eps", eps), ("rev", rev), ("n", int(n) if n else None)) if v is not None}
    if not fy:
        # Yahoo has no lookbacks but covers names Alpha Vantage misses, and is
        # where every over-budget call lands. Its periods are offsets from the
        # last reported fiscal year, so that year has to be looked up: guessing
        # from the calendar names the wrong year for any June or September filer.
        try:
            import estimates
            import sec_fundamentals as sec
            rows = sec.get_fundamental_history(sym)
            if rows:
                last_fy = rows[-1]["fiscalYear"]
                for f in estimates.forward_periods(sym):
                    if f.get("offset", 0) < 1:
                        continue
                    fy[str(last_fy + f["offset"])] = {
                        k: v for k, v in (("eps", f.get("epsEstimate")), ("rev", f.get("revenueEstimate")),
                                          ("n", f.get("analysts"))) if v is not None}
        except Exception as e:
            _log.warning("estimate fallback failed for %s: %s", sym, e)
    return {"fy": fy} if fy else None


_LOOKBACKS = (("eps_estimate_average_7_days_ago", 7), ("eps_estimate_average_30_days_ago", 30),
              ("eps_estimate_average_60_days_ago", 60), ("eps_estimate_average_90_days_ago", 90))


def seed_est(sym: str) -> int:
    """Backfill the four lookback points. Returns how many days were added.

    These carry EPS only: the revenue estimate has no published history, so
    those days simply have no revenue rather than today's number stamped
    backwards. Never overwrites a day already observed.
    """
    rows = _av_fiscal_years(sym)
    if not rows:
        return 0
    today = date.today()
    by_day: dict[str, dict[str, dict]] = {}
    for row in rows:
        year = str(row.get("date") or "")[:4]
        if not year:
            continue
        for column, days in _LOOKBACKS:
            eps = _num(row.get(column))
            if eps is None:
                continue
            by_day.setdefault((today - timedelta(days=days)).isoformat(), {})[year] = {"eps": eps}
    for day, fy in by_day.items():
        record_point("est", sym, {"fy": fy, "src": "av-lookback"}, day=day, keep_existing=True)
    return len(by_day)


def _diluted_shares(sym: str) -> float | None:
    """Latest reported diluted share count, on today's split basis.

    Read from the fundamentals endpoint rather than SEC directly, because that
    is where the split restatement lives: an as-filed count against a
    split-adjusted EPS would be wrong by every split since.
    """
    try:
        from routers.corporate import fundamental_history
        periods = fundamental_history(sym).get("periods") or []
    except Exception as e:
        _log.info("share count lookup failed for %s: %s", sym, e)
        return None
    for p in reversed(periods):
        if p.get("estimate"):
            continue
        n = p.get("weightedAverageShsOutDil")
        if n:
            return float(n)
    return None


_COMPUTE = {"gex": _compute_gex, "iv30": _compute_iv30, "est": _compute_est}


@router.get("/series")
def series(kind: str = Query(...), ticker: str = Query(...), compute: bool = Query(True)):
    """Accrued snapshot series for a ticker. With compute=true (default),
    today's point is computed and recorded if missing, so the series gains a
    point the first time anyone views it each day."""
    if kind not in _KINDS:
        raise HTTPException(400, f"kind must be one of {_KINDS}")
    sym = validate_ticker(ticker)
    pts = get_points(kind, sym)
    today = date.today().isoformat()
    if compute and (not pts or pts[-1].get("d") != today):
        try:
            # First touch of an estimate series backfills the lookbacks, so it
            # opens with a quarter of history rather than one dot.
            if kind == "est" and not pts:
                seed_est(sym)
            p = _COMPUTE[kind](sym)
            if p:
                record_point(kind, sym, p)
            pts = get_points(kind, sym)
        except Exception as e:
            _log.warning("snapshot compute failed %s:%s: %s", kind, sym, e)

    out: dict = {"ticker": sym.upper(), "kind": kind, "points": pts,
                 "note": "History accrues from first use. One point per trading day."}
    if kind == "est":
        # Net income is what a reader wants to compare across companies, but the
        # published estimate is EPS: neither Yahoo nor Alpha Vantage carries a
        # net-income consensus. So the SERIES stores what was published and the
        # dollar figure is derived here, per read, against the latest reported
        # diluted share count. Deriving at read rather than at write keeps the
        # accrued record faithful to the source and lets the conversion improve
        # as the share count does.
        shares = _diluted_shares(sym)
        # One line per fiscal year is what a revision chart plots, so pivot here
        # rather than making every caller do it.
        years = sorted({y for p in pts for y in (p.get("fy") or {})})
        out["fiscal_years"] = years
        def _point(p: dict, y: str) -> dict:
            vals = dict((p.get("fy") or {}).get(y, {}))
            eps = vals.get("eps")
            if shares and eps is not None:
                vals["ni"] = eps * shares
            if p.get("src") == "av-lookback":
                vals["reconstructed"] = True
            return {"d": p["d"], **vals}

        out["series"] = {y: [_point(p, y) for p in pts if y in (p.get("fy") or {})] for y in years}
        out["diluted_shares"] = shares
        out["note"] = ("Consensus accrues one point per day from first view. Net income is "
                       "derived from the published EPS estimate and the latest reported "
                       "diluted share count, because no free source publishes a net-income "
                       "consensus. Points marked reconstructed come from the published "
                       "7/30/60/90-day lookbacks and carry EPS only.")
    if kind == "iv30" and len(pts) >= 20:
        vals = [p["v"] for p in pts if p.get("v") is not None]
        cur, lo, hi = vals[-1], min(vals), max(vals)
        if hi > lo:
            out["iv_rank"] = round((cur - lo) / (hi - lo) * 100, 1)
        out["iv_percentile"] = round(sum(v < cur for v in vals) / len(vals) * 100, 1)
    return out


# ── Daily core-watchlist loop ────────────────────────────────────────────────
# Sequential and slow on purpose: one ticker at a time with gaps, well after
# boot, so the snapshot pass never stacks memory on the small prod VM. Covers
# the fixed core set plus every ticker in every saved portfolio, deduped —
# recomputed fresh each day since holdings change.
_stop = threading.Event()
_thread = None


def _run_loop():
    _stop.wait(240)
    while not _stop.is_set():
        today = date.today().isoformat()
        if disk_get("snap:coreloop") != today:
            watchlist = list(dict.fromkeys(_CORE + _book_tickers()))
            for sym in watchlist:
                # Estimates are not in the daily pass: each one costs an Alpha
                # Vantage call against a 25/day tier, and sixty tickers would
                # spend the quota the rest of the app shares. They accrue on
                # view instead, which is where they are actually read.
                for kind in ("gex", "iv30"):
                    if _stop.is_set():
                        return
                    try:
                        pts = get_points(kind, sym)
                        if pts and pts[-1].get("d") == today:
                            continue
                        p = _COMPUTE[kind](sym)
                        if p:
                            record_point(kind, sym, p)
                    except Exception as e:
                        _log.warning("core snapshot %s:%s failed: %s", kind, sym, e)
                    _stop.wait(8)
            disk_set("snap:coreloop", today, ttl=3 * 86400)
        _stop.wait(3600)


def start_snapshot_loop():
    global _thread
    if _thread and _thread.is_alive():
        return
    _thread = threading.Thread(target=_run_loop, name="snapshots", daemon=True)
    _thread.start()


def stop_snapshot_loop():
    _stop.set()
