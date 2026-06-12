"""
/api/paper-scheduler — background strategy runner.

Runs paper-trading strategies on a per-ticker schedule while the server is
running, even when no browser is connected.  Uses the same Strategy class
and Signal enum as the live paper-strategies module.

Tables
------
paper_schedule_jobs  — one row per scheduled job (ticker + strategy)
paper_schedule_log   — activity log (every signal + order attempt)

Background loop
---------------
Polls every POLL_INTERVAL seconds.  Outside US market hours (09:30-16:00 ET,
Mon-Fri) it sleeps but keeps the loop alive.  On each tick it:
  1. Fetches the latest price for every active ticker (batched yfinance call).
  2. Warms up any strategy that has not yet received its historical seed bars.
  3. Feeds the current tick to each job's strategy instance.
  4. If the signal is BUY or SELL, attempts a Tradier paper order and logs the
     result regardless of success.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import sqlite3
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime
from pathlib import Path
from typing import Any

import yfinance as yf
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from strategies.base import MarketDataPoint, SignalEvent, Strategy

_log = logging.getLogger(__name__)
router = APIRouter()

# ── DB ────────────────────────────────────────────────────────────────────────

_DB_PATH = Path(os.getenv("PAPER_SCHEDULER_DB", "./paper_scheduler.db"))
_LOOP_SLEEP      = 3     # how often the main loop wakes (seconds)
_POLL_INTERVAL   = 60    # default per-job interval for most strategies
_FAST_INTERVAL   = 3     # per-job interval for high-frequency strategies
_WARMUP_BARS     = 200   # historical bars fed on first run
_MAX_LOG_ROWS    = 5_000 # prune log beyond this

# Strategies that need sub-minute polling
_FAST_STRATEGIES: frozenset[str] = frozenset({"micro_scalp"})

def _job_interval(strategy_name: str) -> int:
    return _FAST_INTERVAL if strategy_name in _FAST_STRATEGIES else _POLL_INTERVAL

def _db() -> sqlite3.Connection:
    conn = sqlite3.connect(str(_DB_PATH))
    conn.row_factory = sqlite3.Row
    return conn

def _init_db() -> None:
    with _db() as conn:
        conn.executescript("""
            CREATE TABLE IF NOT EXISTS paper_schedule_jobs (
                id              TEXT PRIMARY KEY,
                ticker          TEXT NOT NULL,
                strategy_name   TEXT NOT NULL,
                params_json     TEXT NOT NULL DEFAULT '{}',
                qty             INTEGER NOT NULL DEFAULT 1,
                enabled         INTEGER NOT NULL DEFAULT 1,
                warmed_up       INTEGER NOT NULL DEFAULT 0,
                last_signal     TEXT,
                last_price      REAL,
                last_run_ts     INTEGER,
                created_at      INTEGER NOT NULL
            );

            CREATE TABLE IF NOT EXISTS paper_schedule_log (
                id              TEXT PRIMARY KEY,
                job_id          TEXT NOT NULL,
                ticker          TEXT NOT NULL,
                strategy_name   TEXT NOT NULL,
                signal          TEXT NOT NULL,
                price           REAL NOT NULL,
                timestamp       INTEGER NOT NULL,
                order_id        TEXT,
                notes           TEXT
            );
        """)

_init_db()

# ── Strategy instance cache ───────────────────────────────────────────────────
# Keyed by job id; value is an initialised + optionally warmed-up Strategy.
_instances: dict[str, Strategy] = {}
_executor = ThreadPoolExecutor(max_workers=6)


def _get_strategy_cls(name: str) -> type[Strategy]:
    """Return the Strategy class for the given registered name."""
    from routers.paper_strategies import _active
    rec = _active.get(name)
    if not rec:
        raise ValueError(f"Strategy '{name}' not registered")
    return rec["cls"]


def _build_instance(job_id: str, strategy_name: str, params: dict) -> Strategy:
    try:
        cls = _get_strategy_cls(strategy_name)
    except ValueError:
        # Custom rule strategies survive restarts if their rules are in params_json
        if "rules" in params:
            from strategies.builtin.custom_rule_strategy import CustomRuleStrategy
            from routers.paper_strategies import _active, _loader
            _active[strategy_name] = {
                "cls": CustomRuleStrategy, "params": params, "enabled": True,
            }
            _loader._registry[strategy_name] = CustomRuleStrategy
            cls = CustomRuleStrategy
        else:
            raise
    inst: Strategy = cls()
    inst.initialize(params)
    return inst


def _fetch_price_sync(ticker: str) -> float | None:
    try:
        fi = yf.Ticker(ticker).fast_info
        price = getattr(fi, "last_price", None)
        return float(price) if price else None
    except Exception:
        return None


def _fetch_history_sync(ticker: str, bars: int) -> list[dict]:
    try:
        hist = yf.Ticker(ticker).history(period=f"{bars + 20}d", interval="1d")
        if hist.empty:
            return []
        if hist.index.tz is not None:
            hist.index = hist.index.tz_localize(None)
        return [
            {"timestamp": row.name.timestamp(), "price": float(row["Close"]),
             "size": float(row.get("Volume", 0)), "side": "trade"}
            for _, row in hist.tail(bars).iterrows()
        ]
    except Exception:
        return []


def _warmup(inst: Strategy, ticker: str, params: dict) -> None:
    bars = _fetch_history_sync(ticker, _WARMUP_BARS)
    for b in bars:
        try:
            inst.on_data(MarketDataPoint(
                timestamp=b["timestamp"], symbol=ticker,
                price=b["price"], size=b["size"], side=b["side"],
            ))
        except Exception:
            pass


def _place_order_sync(ticker: str, side: str, qty: int) -> str | None:
    """Attempt to place a Tradier paper order. Returns order_id or None."""
    try:
        from routers.trading import tradier
        result = tradier.place_equity_order(
            symbol=ticker,
            side=side,        # "buy" or "sell"
            quantity=qty,
            order_type="market",
            duration="day",
        )
        return str(result.get("id", "")) or None
    except Exception as e:
        _log.warning("Tradier order failed (%s %s x%d): %s", side, ticker, qty, e)
        return None


def _is_market_open() -> bool:
    """True if current time is within NYSE regular hours (09:30–16:00 ET, Mon-Fri)."""
    from zoneinfo import ZoneInfo
    et = datetime.now(ZoneInfo("America/New_York"))
    if et.weekday() >= 5:   # Saturday=5, Sunday=6
        return False
    open_t  = et.replace(hour=9,  minute=30, second=0, microsecond=0)
    close_t = et.replace(hour=16, minute=0,  second=0, microsecond=0)
    return open_t <= et <= close_t


# ── Background loop ───────────────────────────────────────────────────────────

_loop_task: asyncio.Task | None = None
_loop_running = False


async def _run_scheduler_loop() -> None:
    global _loop_running
    _log.info("Paper scheduler loop started (loop=%ds, default=%ds, fast=%ds)",
              _LOOP_SLEEP, _POLL_INTERVAL, _FAST_INTERVAL)
    _loop_running = True
    loop = asyncio.get_event_loop()

    while _loop_running:
        try:
            if not _is_market_open():
                await asyncio.sleep(_LOOP_SLEEP)
                continue

            now_ts = int(time.time())

            # Load all enabled jobs
            with _db() as conn:
                jobs = [dict(r) for r in conn.execute(
                    "SELECT * FROM paper_schedule_jobs WHERE enabled=1"
                ).fetchall()]

            if not jobs:
                await asyncio.sleep(_LOOP_SLEEP)
                continue

            # Filter to jobs that are due (each job has its own interval)
            due_jobs = [
                j for j in jobs
                if (j["last_run_ts"] is None or
                    now_ts - j["last_run_ts"] >= _job_interval(j["strategy_name"]))
            ]

            if not due_jobs:
                await asyncio.sleep(_LOOP_SLEEP)
                continue

            tickers = list({j["ticker"].upper() for j in due_jobs})

            # Fetch prices (parallel via executor)
            prices: dict[str, float | None] = {}
            futures = {t: loop.run_in_executor(_executor, _fetch_price_sync, t) for t in tickers}
            for t, fut in futures.items():
                try:
                    prices[t] = await fut
                except Exception:
                    prices[t] = None

            log_rows: list[tuple] = []
            job_updates: list[tuple] = []

            for job in due_jobs:
                job_id = job["id"]
                ticker = job["ticker"].upper()
                price  = prices.get(ticker)
                if price is None:
                    continue

                strategy_name = job["strategy_name"]
                params = json.loads(job["params_json"] or "{}")
                qty = job["qty"]

                # Ensure strategy instance exists and is warmed up
                if job_id not in _instances:
                    try:
                        inst = _build_instance(job_id, strategy_name, params)
                        _instances[job_id] = inst
                    except Exception as e:
                        _log.warning("Could not build strategy %s: %s", strategy_name, e)
                        continue

                inst = _instances[job_id]

                # Warm up with history if not yet done
                if not job["warmed_up"]:
                    _log.info("Warming up %s/%s with %d bars", ticker, strategy_name, _WARMUP_BARS)
                    await loop.run_in_executor(
                        _executor, _warmup, inst, ticker, params
                    )
                    with _db() as conn:
                        conn.execute(
                            "UPDATE paper_schedule_jobs SET warmed_up=1 WHERE id=?", (job_id,)
                        )

                # Feed current tick
                try:
                    event: SignalEvent = inst.on_data(MarketDataPoint(
                        timestamp=float(now_ts), symbol=ticker,
                        price=price, size=0, side="trade",
                    ))
                    signal_str = event.signal.name if event else "HOLD"
                except Exception as e:
                    _log.warning("on_data error job %s: %s", job_id, e)
                    signal_str = "HOLD"

                order_id: str | None = None
                notes = ""

                # Execute if actionable
                if signal_str in ("BUY", "SELL"):
                    side = "buy" if signal_str == "BUY" else "sell"
                    order_id = await loop.run_in_executor(
                        _executor, _place_order_sync, ticker, side, qty
                    )
                    notes = f"order_id={order_id}" if order_id else "order_failed"
                    _log.info("Scheduler %s %s x%d @ %.2f → %s", signal_str, ticker, qty, price, notes)

                log_rows.append((
                    str(uuid.uuid4()), job_id, ticker, strategy_name,
                    signal_str, price, now_ts, order_id, notes
                ))
                job_updates.append((signal_str, price, now_ts, job_id))

            if log_rows or job_updates:
                with _db() as conn:
                    if log_rows:
                        conn.executemany(
                            "INSERT INTO paper_schedule_log "
                            "(id,job_id,ticker,strategy_name,signal,price,timestamp,order_id,notes) "
                            "VALUES (?,?,?,?,?,?,?,?,?)",
                            log_rows
                        )
                    if job_updates:
                        conn.executemany(
                            "UPDATE paper_schedule_jobs "
                            "SET last_signal=?, last_price=?, last_run_ts=? WHERE id=?",
                            job_updates
                        )
                    # Prune old log rows
                    conn.execute(
                        "DELETE FROM paper_schedule_log WHERE id NOT IN "
                        "(SELECT id FROM paper_schedule_log ORDER BY timestamp DESC LIMIT ?)",
                        (_MAX_LOG_ROWS,)
                    )

        except asyncio.CancelledError:
            break
        except Exception as e:
            _log.error("Scheduler loop error: %s", e)

        await asyncio.sleep(_LOOP_SLEEP)

    _loop_running = False
    _log.info("Paper scheduler loop stopped")


def start_scheduler() -> None:
    global _loop_task
    if _loop_task is None or _loop_task.done():
        _loop_task = asyncio.create_task(_run_scheduler_loop())


def stop_scheduler() -> None:
    global _loop_task, _loop_running
    _loop_running = False
    if _loop_task and not _loop_task.done():
        _loop_task.cancel()


# ── Request / Response models ─────────────────────────────────────────────────

class JobCreate(BaseModel):
    ticker:        str
    strategy_name: str
    params:        dict[str, Any] = {}
    qty:           int = 1

class JobOut(BaseModel):
    id:            str
    ticker:        str
    strategy_name: str
    params:        dict[str, Any]
    qty:           int
    enabled:       bool
    warmed_up:     bool
    last_signal:   str | None
    last_price:    float | None
    last_run_ts:   int | None
    created_at:    int

class LogEntry(BaseModel):
    id:            str
    job_id:        str
    ticker:        str
    strategy_name: str
    signal:        str
    price:         float
    timestamp:     int
    order_id:      str | None
    notes:         str | None


def _row_to_job(r: dict) -> JobOut:
    return JobOut(
        id=r["id"], ticker=r["ticker"], strategy_name=r["strategy_name"],
        params=json.loads(r["params_json"] or "{}"),
        qty=r["qty"], enabled=bool(r["enabled"]), warmed_up=bool(r["warmed_up"]),
        last_signal=r["last_signal"], last_price=r["last_price"],
        last_run_ts=r["last_run_ts"], created_at=r["created_at"],
    )


# ── Endpoints ─────────────────────────────────────────────────────────────────

@router.get("/status")
def scheduler_status():
    market_open = _is_market_open()
    running = _loop_task is not None and not _loop_task.done()
    with _db() as conn:
        total  = conn.execute("SELECT COUNT(*) FROM paper_schedule_jobs").fetchone()[0]
        active = conn.execute("SELECT COUNT(*) FROM paper_schedule_jobs WHERE enabled=1").fetchone()[0]
        logs   = conn.execute("SELECT COUNT(*) FROM paper_schedule_log").fetchone()[0]
    return {
        "scheduler_running": running,
        "market_open": market_open,
        "poll_interval_s": _POLL_INTERVAL,
        "fast_interval_s": _FAST_INTERVAL,
        "loop_sleep_s": _LOOP_SLEEP,
        "total_jobs": total,
        "active_jobs": active,
        "log_entries": logs,
    }


@router.get("/jobs", response_model=list[JobOut])
def list_jobs():
    with _db() as conn:
        rows = conn.execute(
            "SELECT * FROM paper_schedule_jobs ORDER BY created_at DESC"
        ).fetchall()
    return [_row_to_job(dict(r)) for r in rows]


@router.post("/jobs", response_model=JobOut)
def create_job(body: JobCreate):
    from routers.paper_strategies import _active
    if body.strategy_name not in _active:
        raise HTTPException(400, f"Unknown strategy: {body.strategy_name}")
    job_id = str(uuid.uuid4())
    now    = int(time.time())
    with _db() as conn:
        conn.execute(
            "INSERT INTO paper_schedule_jobs "
            "(id,ticker,strategy_name,params_json,qty,enabled,warmed_up,created_at) "
            "VALUES (?,?,?,?,?,1,0,?)",
            (job_id, body.ticker.upper(), body.strategy_name,
             json.dumps(body.params), body.qty, now)
        )
    with _db() as conn:
        row = dict(conn.execute(
            "SELECT * FROM paper_schedule_jobs WHERE id=?", (job_id,)
        ).fetchone())
    return _row_to_job(row)


@router.delete("/jobs/{job_id}")
def delete_job(job_id: str):
    with _db() as conn:
        deleted = conn.execute(
            "DELETE FROM paper_schedule_jobs WHERE id=?", (job_id,)
        ).rowcount
    _instances.pop(job_id, None)
    if not deleted:
        raise HTTPException(404, "Job not found")
    return {"deleted": job_id}


@router.patch("/jobs/{job_id}/toggle")
def toggle_job(job_id: str, body: dict):
    enabled = int(bool(body.get("enabled", True)))
    with _db() as conn:
        updated = conn.execute(
            "UPDATE paper_schedule_jobs SET enabled=? WHERE id=?",
            (enabled, job_id)
        ).rowcount
    if not updated:
        raise HTTPException(404, "Job not found")
    if not enabled:
        _instances.pop(job_id, None)
    return {"job_id": job_id, "enabled": bool(enabled)}


@router.get("/log", response_model=list[LogEntry])
def get_log(limit: int = 200, ticker: str | None = None, signal: str | None = None):
    query = "SELECT * FROM paper_schedule_log WHERE 1=1"
    params: list = []
    if ticker:
        query += " AND ticker=?"
        params.append(ticker.upper())
    if signal:
        query += " AND signal=?"
        params.append(signal.upper())
    query += " ORDER BY timestamp DESC LIMIT ?"
    params.append(min(limit, 1000))
    with _db() as conn:
        rows = conn.execute(query, params).fetchall()
    return [LogEntry(**dict(r)) for r in rows]


@router.delete("/log")
def clear_log():
    with _db() as conn:
        n = conn.execute("DELETE FROM paper_schedule_log").rowcount
    return {"cleared": n}
