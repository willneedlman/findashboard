"""Daily snapshots for series that only exist as live computations (dealer
GEX, ATM IV30). Neither has a historical source, so history must accrue:
points are recorded write-through whenever the live tools compute them, by
the /series endpoint on first view of the day, and by a slow daily loop over
a core watchlist. One point per ticker per day, persisted via disk_cache.
"""
import logging
import threading
import sys, os
from datetime import date, datetime, timedelta
from fastapi import APIRouter, HTTPException, Query

sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))
from disk_cache import disk_get, disk_set
from validation import validate_ticker

router = APIRouter()
_log = logging.getLogger("snapshots")

_KINDS = ("gex", "iv30")
_CORE = ["SPY", "QQQ", "AAPL", "NVDA", "MSFT", "TSLA"]
_MAX_POINTS = 1600
_TTL = 5 * 365 * 86400


def record_point(kind: str, sym: str, payload: dict) -> None:
    """Insert/overwrite today's point in a ticker's snapshot series."""
    sym = sym.strip().upper()
    key = f"snap:{kind}:{sym}"
    series = disk_get(key) or []
    today = date.today().isoformat()
    series = [p for p in series if p.get("d") != today]
    series.append({"d": today, **payload})
    series.sort(key=lambda p: p["d"])
    disk_set(key, series[-_MAX_POINTS:], ttl=_TTL)


def get_points(kind: str, sym: str) -> list:
    return disk_get(f"snap:{kind}:{sym.strip().upper()}") or []


def _compute_gex(sym: str) -> dict | None:
    """Net dealer gamma exposure ($M) from the live GEX profile."""
    from routers.options import dealer_gex
    d = dealer_gex(sym)
    rows = d.get("data") or []
    if not rows:
        return None
    net = sum((r.get("call_gex") or 0) + (r.get("put_gex") or 0) for r in rows)
    out = {"v": round(float(net), 2)}
    if d.get("spot"):
        out["spot"] = round(float(d["spot"]), 2)
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


_COMPUTE = {"gex": _compute_gex, "iv30": _compute_iv30}


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
            p = _COMPUTE[kind](sym)
            if p:
                record_point(kind, sym, p)
                pts = get_points(kind, sym)
        except Exception as e:
            _log.warning("snapshot compute failed %s:%s: %s", kind, sym, e)

    out: dict = {"ticker": sym.upper(), "kind": kind, "points": pts,
                 "note": "History accrues from first use. One point per trading day."}
    if kind == "iv30" and len(pts) >= 20:
        vals = [p["v"] for p in pts if p.get("v") is not None]
        cur, lo, hi = vals[-1], min(vals), max(vals)
        if hi > lo:
            out["iv_rank"] = round((cur - lo) / (hi - lo) * 100, 1)
        out["iv_percentile"] = round(sum(v < cur for v in vals) / len(vals) * 100, 1)
    return out


# ── Daily core-watchlist loop ────────────────────────────────────────────────
# Sequential and slow on purpose: one ticker at a time with gaps, well after
# boot, so the snapshot pass never stacks memory on the small prod VM.
_stop = threading.Event()
_thread = None


def _run_loop():
    _stop.wait(240)
    while not _stop.is_set():
        today = date.today().isoformat()
        if disk_get("snap:coreloop") != today:
            for sym in _CORE:
                for kind in _KINDS:
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
