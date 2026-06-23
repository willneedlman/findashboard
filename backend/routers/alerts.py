"""
Price Alert System
- SQLite persistence (alerts.db)
- Evaluation loop as asyncio background task (lifespan-managed)
- Batch yfinance fetch via run_in_executor (non-blocking)
- WebSocket push per user + polling fallback endpoint
- 1-hour cooldown after trigger to prevent spam
- WS auth via ?token= (SHA-256 of user PIN, same as users.py)
"""
import asyncio
import logging
import os
import sqlite3
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import aiosqlite
from fastapi import APIRouter, HTTPException, WebSocket, WebSocketDisconnect
from pydantic import BaseModel

_log = logging.getLogger(__name__)
router = APIRouter()

# ── DB ────────────────────────────────────────────────────────────────────────

_DB_PATH = Path(os.getenv("ALERTS_DB_PATH", "./alerts.db"))
_DB_WRITE_LOCK = asyncio.Lock()

_SCHEMA = """
CREATE TABLE IF NOT EXISTS alerts (
    id            TEXT PRIMARY KEY,
    user_id       TEXT NOT NULL,
    ticker        TEXT NOT NULL,
    condition     TEXT NOT NULL,
    threshold     REAL NOT NULL,
    active        INTEGER NOT NULL DEFAULT 1,
    cooldown_until INTEGER NOT NULL DEFAULT 0,
    created_at    INTEGER NOT NULL
);
"""

def _init_db_sync():
    with sqlite3.connect(str(_DB_PATH)) as conn:
        conn.execute(_SCHEMA)
        conn.commit()

_init_db_sync()


async def _db_execute(sql: str, params: tuple = ()):
    async with _DB_WRITE_LOCK:
        async with aiosqlite.connect(str(_DB_PATH)) as db:
            await db.execute(sql, params)
            await db.commit()


async def _db_fetchall(sql: str, params: tuple = ()) -> list[dict]:
    async with aiosqlite.connect(str(_DB_PATH)) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute(sql, params) as cur:
            rows = await cur.fetchall()
    return [dict(r) for r in rows]

# ── WebSocket hub ─────────────────────────────────────────────────────────────

# user_id → set of WebSocket connections
_ws_connections: dict[str, set[WebSocket]] = {}
_ws_lock = asyncio.Lock()


async def _ws_broadcast(user_id: str, payload: dict):
    async with _ws_lock:
        conns = set(_ws_connections.get(user_id, set()))
    dead = set()
    for ws in conns:
        try:
            await ws.send_json(payload)
        except Exception:
            dead.add(ws)
    if dead:
        async with _ws_lock:
            _ws_connections.get(user_id, set()).difference_update(dead)

# ── Auth ──────────────────────────────────────────────────────────────────────

def _valid_token(user_id: str, token: str) -> bool:
    """Validate a session token (from /api/users/login) against users.db.

    Uses the sessions table rather than the credential hash — the hash is now a
    salted PBKDF2 digest, and a credential hash should never be used as a bearer
    token anyway."""
    if not token:
        return False
    try:
        from pathlib import Path as _Path
        users_db = _Path(os.getenv("USERS_DB_PATH", "./users.db"))
        with sqlite3.connect(str(users_db)) as conn:
            row = conn.execute("SELECT user_id FROM sessions WHERE token = ?", (token,)).fetchone()
        return row is not None and row[0] == user_id
    except Exception as e:
        _log.warning("Token validation error: %s", e)
        return False

# ── Evaluation loop ───────────────────────────────────────────────────────────

_EXECUTOR = ThreadPoolExecutor(max_workers=4)
_eval_task: asyncio.Task | None = None
_EVAL_INTERVAL = 30   # seconds


def _fetch_quotes_sync(tickers: list[str]) -> dict[str, dict]:
    """Blocking yfinance call — runs in the thread pool. Uses Ticker().history —
    the same method the (working) /market/quote endpoint uses, so it's reliable
    from the datacenter IP where the batch yf.download / 1m intraday endpoints get
    throttled. Reads are uncached so the price is fresh each 30s cycle; the
    current-day daily close tracks the live price during market hours, and the
    prior close gives the 1D% baseline."""
    import yfinance as yf
    out: dict[str, dict] = {}
    for t in tickers:
        price = prev = None
        # Daily 5d: reliable, and supplies the prior close (1D% baseline).
        try:
            d = yf.Ticker(t).history(period="5d")
            c = d["Close"].dropna() if "Close" in d else None
            if c is not None and len(c) >= 1:
                price = float(c.iloc[-1])
                prev = float(c.iloc[-2]) if len(c) >= 2 else price
        except Exception as e:
            _log.warning("alerts daily quote %s: %s", t, e)
        # 1m bars incl. pre/post — catches extended-hours moves the daily close
        # misses. Best-effort: if it's empty/throttled, the daily close stands.
        try:
            m = yf.Ticker(t).history(period="1d", interval="1m", prepost=True)
            c = m["Close"].dropna() if "Close" in m else None
            if c is not None and len(c) >= 1:
                price = float(c.iloc[-1])
        except Exception:
            pass
        if price is None:
            continue
        if prev is None:
            prev = price
        out[t.upper()] = {"price": price, "pct_1d": float((price / prev - 1) * 100) if prev else 0.0}
    return out


def _evaluate(alert: dict, quotes: dict[str, dict]) -> bool:
    q = quotes.get(alert["ticker"].upper())
    if not q:
        return False
    cond = alert["condition"]
    threshold = alert["threshold"]
    if cond == "price_above":
        return q["price"] > threshold
    if cond == "price_below":
        return q["price"] < threshold
    if cond == "pct_change_1d_above":
        return q["pct_1d"] > threshold
    if cond == "pct_change_1d_below":
        return q["pct_1d"] < threshold
    return False


async def _run_evaluation_loop():
    _log.info("Alert evaluation loop started (interval=%ds)", _EVAL_INTERVAL)
    while True:
        try:
            now = int(time.time())
            alerts = await _db_fetchall(
                "SELECT * FROM alerts WHERE active=1 AND cooldown_until < ?", (now,)
            )
            if alerts:
                tickers = list({a["ticker"].upper() for a in alerts})
                loop = asyncio.get_event_loop()
                quotes = await loop.run_in_executor(_EXECUTOR, _fetch_quotes_sync, tickers)

                for alert in alerts:
                    if _evaluate(alert, quotes):
                        q = quotes[alert["ticker"].upper()]
                        cooldown = now + 3600
                        await _db_execute(
                            "UPDATE alerts SET cooldown_until=? WHERE id=?",
                            (cooldown, alert["id"]),
                        )
                        payload = {
                            "type":          "alert_triggered",
                            "alert_id":      alert["id"],
                            "ticker":        alert["ticker"],
                            "condition":     alert["condition"],
                            "threshold":     alert["threshold"],
                            "current_price": q["price"],
                            "pct_1d":        q["pct_1d"],
                            "triggered_at":  now,
                            "cooldown_until": cooldown,
                        }
                        await _ws_broadcast(alert["user_id"], payload)
                        _log.info("Alert triggered: %s %s %s (price=%.2f)",
                                  alert["ticker"], alert["condition"], alert["threshold"], q["price"])
        except asyncio.CancelledError:
            _log.info("Alert evaluation loop cancelled")
            return
        except Exception as e:
            _log.error("Evaluation loop error: %s", e)

        await asyncio.sleep(_EVAL_INTERVAL)


def start_evaluation_loop():
    global _eval_task
    if _eval_task and not _eval_task.done():
        return
    _eval_task = asyncio.create_task(_run_evaluation_loop())


def stop_evaluation_loop():
    global _eval_task
    if _eval_task:
        _eval_task.cancel()
        _eval_task = None

# ── REST endpoints ────────────────────────────────────────────────────────────

class AlertCreate(BaseModel):
    user_id:   str
    ticker:    str
    condition: str   # price_above | price_below | pct_change_1d_above | pct_change_1d_below
    threshold: float


_VALID_CONDITIONS = {"price_above", "price_below", "pct_change_1d_above", "pct_change_1d_below"}


@router.post("")
async def create_alert(req: AlertCreate):
    if req.condition not in _VALID_CONDITIONS:
        raise HTTPException(400, f"condition must be one of {sorted(_VALID_CONDITIONS)}")
    ticker = req.ticker.strip().upper()
    if not ticker:
        raise HTTPException(400, "ticker required")
    alert_id = str(uuid.uuid4())
    now = int(time.time())
    await _db_execute(
        "INSERT INTO alerts (id, user_id, ticker, condition, threshold, active, cooldown_until, created_at) VALUES (?,?,?,?,?,1,0,?)",
        (alert_id, req.user_id, ticker, req.condition, req.threshold, now),
    )
    return {"id": alert_id, "ticker": ticker, "condition": req.condition, "threshold": req.threshold, "active": True, "cooldown_until": 0, "created_at": now}


@router.get("/{user_id}")
async def list_alerts(user_id: str):
    rows = await _db_fetchall(
        "SELECT * FROM alerts WHERE user_id=? AND active=1 ORDER BY created_at DESC",
        (user_id,),
    )
    return {"alerts": rows}


@router.get("/{user_id}/pending")
async def pending_alerts(user_id: str):
    """Polling fallback: returns triggered alerts since last check (within last 2 min)."""
    cutoff = int(time.time()) - 120
    rows = await _db_fetchall(
        "SELECT * FROM alerts WHERE user_id=? AND cooldown_until > ? AND cooldown_until <= ?",
        (user_id, cutoff + 3600 - 5, int(time.time()) + 3600),
    )
    return {"triggered": rows}


@router.delete("/{alert_id}")
async def delete_alert(alert_id: str):
    await _db_execute("UPDATE alerts SET active=0 WHERE id=?", (alert_id,))
    return {"deleted": alert_id}


@router.post("/{alert_id}/rearm")
async def rearm_alert(alert_id: str):
    await _db_execute("UPDATE alerts SET cooldown_until=0 WHERE id=?", (alert_id,))
    return {"rearmed": alert_id}


# ── WebSocket endpoint ────────────────────────────────────────────────────────

@router.websocket("/ws/{user_id}")
async def ws_alerts(websocket: WebSocket, user_id: str, token: str = ""):
    if not _valid_token(user_id, token):
        await websocket.close(code=4001)
        return

    await websocket.accept()
    async with _ws_lock:
        _ws_connections.setdefault(user_id, set()).add(websocket)
    _log.info("WS connected: user=%s", user_id)
    try:
        while True:
            # Keep alive; client sends pings, we echo
            data = await websocket.receive_text()
            if data == "ping":
                await websocket.send_text("pong")
    except WebSocketDisconnect:
        pass
    finally:
        async with _ws_lock:
            _ws_connections.get(user_id, set()).discard(websocket)
        _log.info("WS disconnected: user=%s", user_id)
