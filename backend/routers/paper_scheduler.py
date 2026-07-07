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
from fastapi import APIRouter, HTTPException, Header
from pydantic import BaseModel

from strategies.base import MarketDataPoint, SignalEvent, Strategy
import paper_engine
from routers.users import _require_owner

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
        # Per-user columns (idempotent for pre-existing installs).
        for ddl in (
            "ALTER TABLE paper_schedule_jobs ADD COLUMN user_id TEXT DEFAULT ''",
            "ALTER TABLE paper_schedule_log  ADD COLUMN user_id TEXT DEFAULT ''",
            # OCC symbol of the option contract a job currently holds (option
            # instruments only) so the exit closes exactly what the entry opened.
            "ALTER TABLE paper_schedule_jobs ADD COLUMN open_occ TEXT",
        ):
            try:
                conn.execute(ddl)
            except Exception:
                pass

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


def _place_order_sync(user_id: str, ticker: str, side: str, qty: int) -> str | None:
    """Place a market order into the user's own paper account. Returns the order
    id when filled, else None (rejected/resting)."""
    if not user_id:
        return None
    try:
        result = paper_engine.place_order(user_id, ticker, side, qty, "market")
        if result.get("status") == "filled":
            return str(result.get("id") or "") or None
        _log.info("Scheduler order not filled (%s %s x%d): %s", side, ticker, qty, result.get("reason") or result.get("status"))
        return None
    except Exception as e:
        _log.warning("Paper order failed (%s %s x%d): %s", side, ticker, qty, e)
        return None


def _resolve_option_contract(ticker: str, spec: dict, spot: float) -> str | None:
    """Pick a REAL contract from the live chain for an option instrument: the
    expiry nearest today+DTE and the listed strike nearest moneyness×spot. Returns
    an OCC symbol (which paper_engine prices off the same chain), or None if the
    chain is unavailable."""
    try:
        import datetime as _dt
        otype = "put" if str(spec.get("type", "call")).lower().startswith("p") else "call"
        moneyness = float(spec.get("moneyness", 1.0))
        dte = max(1, int(spec.get("dte", 30)))
        tk = yf.Ticker(ticker)
        exps = [e for e in (tk.options or []) if e]
        if not exps or not spot:
            return None
        target = _dt.date.today() + _dt.timedelta(days=dte)
        expiry = min(exps, key=lambda e: abs((_dt.date.fromisoformat(e) - target).days))
        chain = tk.option_chain(expiry)
        df = chain.calls if otype == "call" else chain.puts
        if df is None or df.empty:
            return None
        strikes = [float(s) for s in df["strike"].tolist()]
        strike = min(strikes, key=lambda s: abs(s - spot * moneyness))
        y, m, d = expiry.split("-")
        cp = "C" if otype == "call" else "P"
        return f"{ticker.upper()}{y[2:]}{m}{d}{cp}{int(round(strike * 1000)):08d}"
    except Exception as e:
        _log.warning("Option contract resolve failed for %s: %s", ticker, e)
        return None


def _place_option_sync(user_id: str, ticker: str, signal: str, qty: int, spec: dict,
                       open_occ: str | None, spot: float) -> tuple[str | None, str | None]:
    """Trade a real option at the live chain price. On BUY, open a fresh contract;
    on SELL, close the exact contract the job is holding. Returns (order_id,
    new_open_occ) — new_open_occ is the OCC now held ('' when flat, None = no
    change)."""
    if not user_id:
        return None, None
    try:
        if signal == "BUY":
            if open_occ:
                return None, None   # already holding a contract
            occ = _resolve_option_contract(ticker, spec, spot)
            if not occ:
                return None, None
            res = paper_engine.place_option_order(user_id, occ, "buy_to_open", qty, "market")
            if res.get("status") == "filled":
                return str(res.get("id") or "") or None, occ
            _log.info("Scheduler option BUY not filled (%s): %s", occ, res.get("reason") or res.get("status"))
            return None, None
        else:  # SELL — close what we hold
            if not open_occ:
                return None, None
            res = paper_engine.place_option_order(user_id, open_occ, "sell_to_close", qty, "market")
            oid = str(res.get("id") or "") or None if res.get("status") == "filled" else None
            return oid, ("" if oid else None)   # clear holding once closed
    except Exception as e:
        _log.warning("Paper option order failed (%s %s): %s", signal, ticker, e)
        return None, None


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
            occ_updates: list[tuple] = []   # (open_occ, job_id) for option jobs whose holding changed

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
                occ_update: str | None = None   # new open_occ when it changes

                # Execute into the job owner's own paper account — only on a
                # signal TRANSITION. Strategies report BUY every bar while invested
                # ("remain invested"), so acting on the raw signal would re-buy on
                # every poll; fire only when the signal actually changes.
                transition = signal_str != (job.get("last_signal") or "HOLD")
                if signal_str in ("BUY", "SELL") and transition:
                    inst_spec = params.get("instrument") or {}
                    if inst_spec.get("kind") == "option":
                        order_id, occ_update = await loop.run_in_executor(
                            _executor, _place_option_sync, job.get("user_id", ""),
                            ticker, signal_str, qty, inst_spec, job.get("open_occ"), price,
                        )
                        notes = f"option={occ_update or job.get('open_occ') or ''} order_id={order_id}" if order_id else "option_order_failed"
                    else:
                        # Short positions invert: a BUY signal opens the short
                        # (sell-to-open), a SELL signal covers it (buy).
                        pos_side = str(params.get("side", "long")).lower()
                        if pos_side == "short":
                            side = "sell" if signal_str == "BUY" else "buy"
                        else:
                            side = "buy" if signal_str == "BUY" else "sell"
                        order_id = await loop.run_in_executor(
                            _executor, _place_order_sync, job.get("user_id", ""), ticker, side, qty
                        )
                        notes = f"{pos_side} order_id={order_id}" if order_id else "order_failed"
                    _log.info("Scheduler %s %s x%d @ %.2f → %s", signal_str, ticker, qty, price, notes)

                log_rows.append((
                    str(uuid.uuid4()), job_id, ticker, strategy_name,
                    signal_str, price, now_ts, order_id, notes, job.get("user_id", "")
                ))
                job_updates.append((signal_str, price, now_ts, job_id))
                if occ_update is not None:
                    occ_updates.append((occ_update, job_id))

            if log_rows or job_updates or occ_updates:
                with _db() as conn:
                    if log_rows:
                        conn.executemany(
                            "INSERT INTO paper_schedule_log "
                            "(id,job_id,ticker,strategy_name,signal,price,timestamp,order_id,notes,user_id) "
                            "VALUES (?,?,?,?,?,?,?,?,?,?)",
                            log_rows
                        )
                    if job_updates:
                        conn.executemany(
                            "UPDATE paper_schedule_jobs "
                            "SET last_signal=?, last_price=?, last_run_ts=? WHERE id=?",
                            job_updates
                        )
                    if occ_updates:
                        conn.executemany(
                            "UPDATE paper_schedule_jobs SET open_occ=? WHERE id=?",
                            occ_updates
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
    user_id:       str
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
def scheduler_status(user_id: str, authorization: str = Header(default=""), x_session_token: str = Header(default="")):
    _require_owner(user_id, authorization, x_session_token)
    market_open = _is_market_open()
    running = _loop_task is not None and not _loop_task.done()
    with _db() as conn:
        total  = conn.execute("SELECT COUNT(*) FROM paper_schedule_jobs WHERE user_id=?", (user_id,)).fetchone()[0]
        active = conn.execute("SELECT COUNT(*) FROM paper_schedule_jobs WHERE user_id=? AND enabled=1", (user_id,)).fetchone()[0]
        logs   = conn.execute("SELECT COUNT(*) FROM paper_schedule_log WHERE user_id=?", (user_id,)).fetchone()[0]
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
def list_jobs(user_id: str, authorization: str = Header(default=""), x_session_token: str = Header(default="")):
    _require_owner(user_id, authorization, x_session_token)
    with _db() as conn:
        rows = conn.execute(
            "SELECT * FROM paper_schedule_jobs WHERE user_id=? ORDER BY created_at DESC", (user_id,)
        ).fetchall()
    return [_row_to_job(dict(r)) for r in rows]


def _insert_job(user_id: str, ticker: str, strategy_name: str, params: dict, qty: int) -> str:
    """Insert one enabled scheduler job and return its id. Shared by create_job
    and the portfolio bridge (which fans a book out into one job per position)."""
    job_id = str(uuid.uuid4())
    now = int(time.time())
    with _db() as conn:
        conn.execute(
            "INSERT INTO paper_schedule_jobs "
            "(id,ticker,strategy_name,params_json,qty,enabled,warmed_up,created_at,user_id) "
            "VALUES (?,?,?,?,?,1,0,?,?)",
            (job_id, ticker.upper(), strategy_name, json.dumps(params), qty, now, user_id),
        )
    return job_id


@router.post("/jobs", response_model=JobOut)
def create_job(body: JobCreate, authorization: str = Header(default=""), x_session_token: str = Header(default="")):
    _require_owner(body.user_id, authorization, x_session_token)
    from routers.paper_strategies import _active
    if body.strategy_name not in _active:
        raise HTTPException(400, f"Unknown strategy: {body.strategy_name}")
    # Bake the strategy's own params (rules, instrument, drifts) into the job so a
    # scheduled custom strategy actually carries its rules — and survives restarts
    # without depending on the in-memory registry. Job-level params (risk, qty
    # tuning) override the registry defaults.
    reg_params = _active[body.strategy_name].get("params", {})
    params = {**reg_params, **body.params}
    job_id = str(uuid.uuid4())
    now    = int(time.time())
    with _db() as conn:
        conn.execute(
            "INSERT INTO paper_schedule_jobs "
            "(id,ticker,strategy_name,params_json,qty,enabled,warmed_up,created_at,user_id) "
            "VALUES (?,?,?,?,?,1,0,?,?)",
            (job_id, body.ticker.upper(), body.strategy_name,
             json.dumps(params), body.qty, now, body.user_id)
        )
    with _db() as conn:
        row = dict(conn.execute(
            "SELECT * FROM paper_schedule_jobs WHERE id=?", (job_id,)
        ).fetchone())
    return _row_to_job(row)


@router.delete("/jobs/{job_id}")
def delete_job(job_id: str, user_id: str, authorization: str = Header(default=""), x_session_token: str = Header(default="")):
    _require_owner(user_id, authorization, x_session_token)
    with _db() as conn:
        deleted = conn.execute(
            "DELETE FROM paper_schedule_jobs WHERE id=? AND user_id=?", (job_id, user_id)
        ).rowcount
    _instances.pop(job_id, None)
    if not deleted:
        raise HTTPException(404, "Job not found")
    return {"deleted": job_id}


@router.patch("/jobs/{job_id}/toggle")
def toggle_job(job_id: str, body: dict, user_id: str, authorization: str = Header(default=""), x_session_token: str = Header(default="")):
    _require_owner(user_id, authorization, x_session_token)
    enabled = int(bool(body.get("enabled", True)))
    with _db() as conn:
        updated = conn.execute(
            "UPDATE paper_schedule_jobs SET enabled=? WHERE id=? AND user_id=?",
            (enabled, job_id, user_id)
        ).rowcount
    if not updated:
        raise HTTPException(404, "Job not found")
    if not enabled:
        _instances.pop(job_id, None)
    return {"job_id": job_id, "enabled": bool(enabled)}


@router.get("/log", response_model=list[LogEntry])
def get_log(user_id: str, limit: int = 200, ticker: str | None = None, signal: str | None = None,
            authorization: str = Header(default=""), x_session_token: str = Header(default="")):
    _require_owner(user_id, authorization, x_session_token)
    query = "SELECT * FROM paper_schedule_log WHERE user_id=?"
    params: list = [user_id]
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


@router.get("/attribution")
def attribution(user_id: str, authorization: str = Header(default=""), x_session_token: str = Header(default="")):
    """Per-strategy realized P&L from executed scheduler trades.

    Strategies are long-only single-position, so each SELL closes the oldest
    open BUY for that (strategy, ticker). Uses the logged fill price and the
    job's qty. Open (unclosed) buys are reported but not realized.
    """
    _require_owner(user_id, authorization, x_session_token)
    with _db() as conn:
        rows = conn.execute(
            "SELECT l.strategy_name, l.ticker, l.signal, l.price, l.timestamp, "
            "COALESCE(j.qty, 1) AS qty FROM paper_schedule_log l "
            "LEFT JOIN paper_schedule_jobs j ON j.id = l.job_id "
            "WHERE l.user_id=? AND l.order_id IS NOT NULL AND l.signal IN ('BUY','SELL') "
            "ORDER BY l.timestamp ASC",
            (user_id,),
        ).fetchall()

    agg: dict[str, dict] = {}
    open_buys: dict[tuple, list] = {}   # (strategy, ticker) -> [(price, qty)]
    for r in rows:
        strat, tkr, sig, px, qty = r["strategy_name"], r["ticker"], r["signal"], float(r["price"]), int(r["qty"] or 1)
        a = agg.setdefault(strat, {"strategy": strat, "realized_pnl": 0.0, "trades": 0, "wins": 0, "open": 0})
        key = (strat, tkr)
        stack = open_buys.setdefault(key, [])
        if sig == "BUY":
            stack.append((px, qty))
        elif sig == "SELL" and stack:
            buy_px, buy_qty = stack.pop(0)
            q = min(qty, buy_qty)
            pnl = (px - buy_px) * q
            a["realized_pnl"] += pnl
            a["trades"] += 1
            if pnl > 0:
                a["wins"] += 1
            if buy_qty > q:                       # partial close: keep the remainder open
                stack.insert(0, (buy_px, buy_qty - q))
    for key, stack in open_buys.items():
        if stack:
            agg.setdefault(key[0], {"strategy": key[0], "realized_pnl": 0.0, "trades": 0, "wins": 0, "open": 0})["open"] += len(stack)

    out = [{
        "strategy": a["strategy"],
        "realized_pnl": round(a["realized_pnl"], 2),
        "trades": a["trades"],
        "win_rate": round(100 * a["wins"] / a["trades"], 1) if a["trades"] else 0.0,
        "open_positions": a["open"],
    } for a in agg.values()]
    out.sort(key=lambda x: x["realized_pnl"], reverse=True)
    return {"strategies": out, "total_realized": round(sum(x["realized_pnl"] for x in out), 2)}


@router.delete("/log")
def clear_log(user_id: str, authorization: str = Header(default=""), x_session_token: str = Header(default="")):
    _require_owner(user_id, authorization, x_session_token)
    with _db() as conn:
        n = conn.execute("DELETE FROM paper_schedule_log WHERE user_id=?", (user_id,)).rowcount
    return {"cleared": n}
