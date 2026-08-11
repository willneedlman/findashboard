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
import json
import logging
import os
import sqlite3
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, time as _dtime
from pathlib import Path

try:
    from zoneinfo import ZoneInfo
    _ET = ZoneInfo("America/New_York")
except Exception:                                    # pragma: no cover
    _ET = None

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
    created_at    INTEGER NOT NULL,
    payload       TEXT
);
"""

def _init_db_sync():
    with sqlite3.connect(str(_DB_PATH)) as conn:
        conn.execute(_SCHEMA)
        # Additive migration for DBs created before strategy alerts: `payload`
        # holds the rules + ticker list for strategy_* conditions (NULL otherwise).
        cols = {r[1] for r in conn.execute("PRAGMA table_info(alerts)")}
        if "payload" not in cols:
            conn.execute("ALTER TABLE alerts ADD COLUMN payload TEXT")
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
_EVAL_INTERVAL = 30    # seconds, while a US session is open
_CLOSED_INTERVAL = 300 # seconds, when markets are closed — just re-checks the clock
# Latest extended-hours quote per ticker, refreshed by the loop and served to the
# alerts page so its "Last" readout matches exactly what the loop evaluates.
_LAST_QUOTES: dict[str, dict] = {}


def _market_session() -> str:
    """'regular' (09:30-16:00 ET), 'extended' (04:00-09:30 & 16:00-20:00 ET), or
    'closed' (overnight/weekends). Prices don't move while closed, so the loop
    skips all yfinance calls then. Holidays are not special-cased (a handful of
    over-polled days a year)."""
    if _ET is None:
        return "regular"
    now = datetime.now(_ET)
    if now.weekday() >= 5:                            # Sat/Sun
        return "closed"
    t = now.time()
    if _dtime(9, 30) <= t < _dtime(16, 0):
        return "regular"
    if _dtime(4, 0) <= t < _dtime(20, 0):
        return "extended"
    return "closed"


def _fetch_quotes_sync(tickers: list[str], extended: bool = True) -> dict[str, dict]:
    """Blocking yfinance call — runs in the thread pool. Uses Ticker().history —
    the same method the (working) /market/quote endpoint uses, so it's reliable
    from the datacenter IP where the batch yf.download / 1m intraday endpoints get
    throttled. Reads are uncached so the price is fresh each cycle; the current-day
    daily close tracks the live price during regular hours, and the prior close
    gives the 1D% baseline. The 1m pre/post call is made only when `extended`, so
    regular-hours cycles cost one yfinance call per ticker instead of two."""
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
        # misses. Only needed in pre/post sessions; skipped during regular hours
        # where the daily close already tracks the live price.
        if extended:
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


_QUOTE_CONDITIONS = {"price_above", "price_below", "pct_change_1d_above", "pct_change_1d_below"}
# Indicator conditions evaluate against price history. For rsi_* the threshold is
# the RSI level (e.g. 30); for the SMA conditions it is the SMA period (e.g. 50).
_INDICATOR_CONDITIONS = {"rsi_below", "rsi_above", "price_above_sma", "price_below_sma",
                         "price_cross_above_sma", "price_cross_below_sma"}
# Slow-data conditions read daily/derived series (IV-rank + GEX snapshots, the
# sentiment composite, next-earnings dates). Their inputs move on a daily-ish
# clock, so they evaluate on a 10-min cadence and fire at most once per day.
# sentiment_* alerts are market-wide: ticker is stored as the MARKET sentinel.
_SLOW_CONDITIONS = {"iv_rank_above", "iv_rank_below", "price_cross_gex_flip",
                    "sentiment_above", "sentiment_below", "earnings_within_days"}
_SENTIMENT_CONDITIONS = {"sentiment_above", "sentiment_below"}
# Strategy-signal alerts: a saved custom strategy's entry/exit rule, swept across
# a ticker list. Evaluated on the slow cadence (rules resolve on daily bars, so a
# signal only flips once per day) and off the quote path (each ticker's history is
# fetched by the rule engine, not from the shared quote batch). The `ticker` column
# holds the strategy name for display; the real rules + tickers live in `payload`.
_STRATEGY_CONDITIONS = {"strategy_entry", "strategy_exit"}
_STRATEGY_MAX_TICKERS = 15   # cap the fan-out per sweep to bound the fetch cost
# Macro-event alerts: a daily heads-up when a watched economic event is within N
# days, read off /macro-calendar. Market-wide (MARKET sentinel). The filter (which
# events) lives in payload. Default watches the marquee market-movers so routine
# daily releases don't spam; "monetary" narrows to Fed/Treasury, "high" widens.
_MACRO_CONDITIONS = {"macro_event_within_days"}
# Macro *print* alerts, as distinct from the scheduling alert above: fire on the
# released figure itself crossing a level. "Tell me when CPI comes in over 3%" is
# a different question from "tell me CPI is on Thursday", and only the second one
# was answerable. The FRED series id lives in payload.series.
_MACRO_PRINT_CONDITIONS = {"macro_print_above", "macro_print_below"}
# Portfolio drawdown: the basket in payload.holdings valued daily over the last
# year, measured from its own peak. Stateless by design — a running peak stored
# on the row would silently reset whenever the alert was edited.
_PORTFOLIO_CONDITIONS = {"portfolio_drawdown_above"}
# Observation-board alerts: fire when a Pattern Grammar station changes state.
# Better suited to these feeds than a threshold, because the grammar already
# applies a deadband, excludes stations past their freshness window, and can say
# why it moved — so the alert carries an explanation instead of a bare crossing.
# `ticker` holds "<board>:<id>" (e.g. "chokepoint:hormuz"); payload.station may
# narrow it to one station, otherwise any station changing state fires it.
_BOARD_CONDITIONS = {"board_state_change"}
_BOARD_KINDS = {"chokepoint", "flaring", "port"}
_MACRO_MARQUEE = frozenset({
    "FOMC Decision", "FOMC Minutes", "Fed Chair Press Conference", "Fed Beige Book",
    "CPI (Headline)", "Core CPI (ex Food/Energy)", "Jobs Report (NFP)", "Unemployment Rate",
    "PCE Price Index", "Core PCE", "GDP (Advance)", "GDP (Preliminary)", "GDP (Final)",
    "PPI (Final Demand)", "Retail Sales", "ISM Manufacturing PMI", "ISM Services PMI",
    "Treasury Quarterly Refunding",
})
_MARKET_TICKER = "MARKET"
_SLOW_INTERVAL = 600     # seconds between slow-condition sweeps
_SLOW_COOLDOWN = 86400   # daily-clock data → at most one fire per day
_last_slow_sweep = 0.0


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


def _indicator_triggered_sync(ticker: str, cond: str, threshold: float) -> tuple[bool, float | None]:
    """Evaluate an indicator alert against history. Returns (triggered, price)."""
    try:
        from cache import get_history
        from routers.algo import _compute_rsi
        close = get_history(ticker, period="1y")["Close"].dropna()
        if len(close) < 30:
            return False, None
        price = float(close.iloc[-1])
        if cond == "rsi_below":
            return float(_compute_rsi(close, 14).iloc[-1]) < threshold, price
        if cond == "rsi_above":
            return float(_compute_rsi(close, 14).iloc[-1]) > threshold, price
        period = max(2, int(threshold))
        if len(close) < period + 2:
            return False, price
        sma = close.rolling(period).mean()
        cur_sma = float(sma.iloc[-1])
        if cond == "price_above_sma":
            return price > cur_sma, price
        if cond == "price_below_sma":
            return price < cur_sma, price
        prev_price, prev_sma = float(close.iloc[-2]), float(sma.iloc[-2])
        if cond == "price_cross_above_sma":
            return (prev_price <= prev_sma and price > cur_sma), price
        if cond == "price_cross_below_sma":
            return (prev_price >= prev_sma and price < cur_sma), price
        return False, price
    except Exception as e:
        _log.warning("indicator eval %s %s: %s", ticker, cond, e)
        return False, None


def _board_state_sync(alert_id, board_ref: str, payload: dict | None) -> tuple[bool, str]:
    """Fire when a board station's state differs from the last state we saw.

    The previous state is held per alert rather than per board, so two alerts on
    the same board cannot consume each other's transition. First evaluation only
    records the baseline: without that a freshly created alert would fire once on
    whatever the board happened to be doing, which is a state, not a change.
    """
    try:
        from disk_cache import disk_get, disk_set
    except ImportError:                               # pragma: no cover
        return False, ""
    try:
        kind, _, board_id = (board_ref or "").strip().lower().partition(":")
        if not board_id:
            return False, ""
        if kind == "flaring":
            from routers.maritime import flaring_board
            board = flaring_board(site=board_id, days=60)
        elif kind == "chokepoint":
            from routers.maritime import chokepoint_board
            board = chokepoint_board(id=board_id, days=90)
        elif kind == "port":
            from routers.maritime import port_board
            board = port_board(port_id=board_id, days=180)
        else:
            return False, ""

        wanted = ((payload or {}).get("station") or "").strip()
        stations = [s for s in board["stations"] if not wanted or s["key"] == wanted]
        # A station past its freshness window is excluded: its state is frozen at
        # whatever it last showed, so a transition into or out of "stale" is a
        # statement about the feed, not about the corridor.
        current = {s["key"]: s["state"] for s in stations if not s["stale"]}
        if not current:
            return False, ""

        key = f"board_alert_state_{alert_id}"
        previous = disk_get(key) or {}
        disk_set(key, current, ttl=90 * 86400)
        if not previous:
            return False, ""

        changes = [
            f"{s['label']} {previous[s['key']]} → {current[s['key']]}"
            for s in stations
            if s["key"] in current and s["key"] in previous
            and previous[s["key"]] != current[s["key"]]
        ]
        if not changes:
            return False, ""
        read = (board.get("read") or {}).get("body") or ""
        label = f"{board['subject']}: {'; '.join(changes)}"
        return True, f"{label}. {read}"[:400]
    except Exception as e:
        _log.warning("board alert eval %s: %s", board_ref, e)
        return False, ""


def _slow_triggered_sync(ticker: str, cond: str, threshold: float,
                         quote: dict | None) -> tuple[bool, float | None]:
    """Evaluate a slow-data alert. Returns (triggered, metric value) — the
    metric is the IV rank, flip level, composite score, or days-to-earnings."""
    try:
        if cond in ("iv_rank_above", "iv_rank_below"):
            from routers.snapshots import series
            r = series(kind="iv30", ticker=ticker, compute=True)
            rank = r.get("iv_rank")
            if rank is None:                      # needs ~20 accrued daily points
                return False, None
            hit = rank > threshold if cond == "iv_rank_above" else rank < threshold
            return hit, float(rank)
        if cond == "price_cross_gex_flip":
            from routers.snapshots import get_points
            pts = get_points("gex", ticker)
            flip = next((p.get("flip") for p in reversed(pts) if p.get("flip") is not None), None)
            if flip is None or not quote:
                return False, None
            price = quote["price"]
            pct = quote.get("pct_1d")
            if pct is None or pct <= -100:
                return False, float(flip)
            prev = price / (1 + pct / 100)        # prior close, from the 1D% baseline
            return (prev - flip) * (price - flip) < 0, float(flip)
        if cond in _SENTIMENT_CONDITIONS:
            from sentiment.engine import build_snapshot
            score = float(build_snapshot(refresh=False).composite_score)
            hit = score > threshold if cond == "sentiment_above" else score < threshold
            return hit, round(score, 1)
        if cond == "earnings_within_days":
            from datetime import date
            from routers.earnings import _prior_report
            nd = (_prior_report(ticker) or {}).get("nextDate")
            if not nd:
                return False, None
            days = (date.fromisoformat(str(nd)[:10]) - date.today()).days
            return 0 <= days <= int(threshold), float(days)
    except Exception as e:
        _log.warning("slow eval %s %s: %s", ticker, cond, e)
    return False, None


def _strategy_triggered_sync(payload_json: str | None, cond: str) -> tuple[bool, list[str]]:
    """Evaluate a saved strategy's entry/exit rule across its ticker list.

    Runs the shared custom-rule engine over recent history for each ticker and
    detects a fresh edge on the latest bar: entry = the buy rule flips the signal
    0→1 (cash→invested) on the most recent bar; exit = the sell rule flips it 1→0.
    Returns (triggered, [tickers whose rule fired this bar])."""
    try:
        payload = json.loads(payload_json) if payload_json else {}
        rules = payload.get("rules") or {}
        tickers = [str(t).strip().upper() for t in (payload.get("tickers") or []) if str(t).strip()]
        if not rules or not tickers:
            return False, []
        from datetime import date, timedelta
        from routers.strategy import _run_custom_rules
        end = (date.today() + timedelta(days=1)).isoformat()
        start = (date.today() - timedelta(days=420)).isoformat()  # covers up to SMA200 lookback
        want_entry = cond == "strategy_entry"
        fired: list[str] = []
        for tk in tickers[:_STRATEGY_MAX_TICKERS]:
            try:
                sig, close = _run_custom_rules(tk, rules, start, end)
            except Exception as e:
                _log.warning("strategy eval %s: %s", tk, e)
                continue
            if sig is None or len(sig) < 2:
                continue
            last, prev = float(sig[-1]), float(sig[-2])
            edge = (prev == 0.0 and last == 1.0) if want_entry else (prev == 1.0 and last == 0.0)
            if edge:
                fired.append(tk)
        return bool(fired), fired
    except Exception as e:
        _log.warning("strategy eval (%s): %s", cond, e)
        return False, []


def _macro_print_sync(payload_json: str | None, cond: str, threshold: float) -> tuple[bool, float | None, str]:
    """Fire on the latest released value of a FRED series crossing `threshold`.

    Reads the same observations the Macro Monitor plots. The comparison is on
    the released figure, so a revision to a prior month cannot trigger it — only
    a new print can.
    """
    try:
        import fred as _fred
        p = json.loads(payload_json) if payload_json else {}
        series_id = str(p.get("series") or "").strip()
        if not series_id:
            return False, None, ""
        transform = p.get("transform")          # "yoy" | None
        obs = _fred.observations(series_id, 400)
        if not obs:
            return False, None, ""
        latest = obs[-1]
        value = float(latest["value"])
        if transform == "yoy":
            # Year-over-year needs the print from twelve periods back, not a
            # calendar lookup: the series may be monthly, weekly or quarterly.
            if len(obs) < 13:
                return False, None, ""
            base = float(obs[-13]["value"])
            if base == 0:
                return False, None, ""
            value = (value / base - 1.0) * 100.0
        hit = value > threshold if cond == "macro_print_above" else value < threshold
        label = f"{p.get('label') or series_id} {value:.2f}{'%' if transform == 'yoy' else ''} ({latest['date']})"
        return hit, round(value, 4), label
    except Exception as e:
        _log.warning("macro print eval: %s", e)
        return False, None, ""


def _portfolio_drawdown_sync(payload_json: str | None, threshold: float) -> tuple[bool, float | None, str]:
    """Fire when the basket is more than `threshold` percent below its own peak.

    The holdings ride in the payload because portfolios live in the browser, the
    same way strategy alerts carry their rules. Share counts are taken as fixed
    across the window, so this is the drawdown of the basket as held today, not
    a reconstruction of past trading.
    """
    try:
        import datetime as _d
        from cache import get_download
        p = json.loads(payload_json) if payload_json else {}
        holdings = [h for h in (p.get("holdings") or []) if h.get("ticker") and h.get("weight")]
        if not holdings:
            return False, None, ""
        symbols = tuple(dict.fromkeys(str(h["ticker"]).upper() for h in holdings))
        end = (_d.date.today() + _d.timedelta(days=1)).isoformat()
        start = (_d.date.today() - _d.timedelta(days=400)).isoformat()
        frame = get_download(symbols, start, end, "1d", cache_ttl=900)
        closes = frame.get("Close") if frame is not None and not frame.empty else None
        if closes is None:
            return False, None, ""
        if not hasattr(closes, "columns"):
            closes = closes.to_frame(name=symbols[0])
        # The client knows weights, not share counts, because a saved book is
        # stored by position rather than by lot. Convert at today's price so the
        # basket matches what is actually held right now, then hold those share
        # counts fixed back through the window.
        total = float(p.get("total_value") or 100_000)
        equity = None
        for h in holdings:
            sym = str(h["ticker"]).upper()
            if sym not in closes.columns:
                continue
            series = closes[sym].ffill().dropna()
            if series.empty or float(series.iloc[-1]) <= 0:
                continue
            shares = (total * float(h["weight"]) / 100.0) / float(series.iloc[-1])
            leg = closes[sym].ffill() * shares
            equity = leg if equity is None else equity.add(leg, fill_value=0)
        if equity is None or equity.dropna().empty:
            return False, None, ""
        equity = equity.dropna()
        peak = float(equity.max())
        last = float(equity.iloc[-1])
        if peak <= 0:
            return False, None, ""
        drawdown = (last / peak - 1.0) * 100.0
        label = f"{p.get('label') or 'Portfolio'} {drawdown:.1f}% from its 1-year peak"
        return drawdown <= -abs(threshold), round(drawdown, 2), label
    except Exception as e:
        _log.warning("portfolio drawdown eval: %s", e)
        return False, None, ""


def _macro_triggered_sync(payload_json: str | None, days_ahead: float) -> tuple[bool, list[str]]:
    """Fire when a watched macro event is within `days_ahead` days (inclusive).

    Reads the shared /macro-calendar. `payload.mode` selects the watch set:
    "marquee" (default market-movers), "monetary" (Fed/Treasury), or "high" (all
    high-importance); an explicit `payload.labels` list overrides mode. Returns
    (triggered, ["Label (date)", ...])."""
    try:
        from datetime import date
        from routers.rates import macro_calendar
        p = json.loads(payload_json) if payload_json else {}
        n = max(0, int(days_ahead))
        today = date.today()

        # Release Tape bells watch the tape feed by base event name.
        if p.get("source") == "release-hub":
            from routers.macro_events import macro_events
            names = set(p.get("names") or [])
            hits: list[str] = []
            for e in macro_events().get("events", []):
                if e.get("status") != "upcoming":
                    continue
                if e.get("name", "").split(" (")[0] not in names:
                    continue
                try:
                    du = (date.fromisoformat(e["datetime"][:10]) - today).days
                except (ValueError, KeyError, TypeError):
                    continue
                if 0 <= du <= n:
                    hits.append(f"{e['name']} ({e['datetime'][:10]})")
            return bool(hits), hits[:8]

        mode = p.get("mode", "marquee")
        labels = set(p.get("labels") or [])
        events = macro_calendar().get("events", [])

        def match(e: dict) -> bool:
            if labels:
                return e.get("label") in labels
            if mode == "monetary":
                return e.get("category") == "monetary"
            if mode == "high":
                return e.get("importance") == "high"
            return e.get("label") in _MACRO_MARQUEE

        hits: list[str] = []
        for e in events:
            try:
                du = (date.fromisoformat(e["date"]) - today).days
            except (ValueError, KeyError, TypeError):
                continue
            if 0 <= du <= n and match(e):
                hits.append(f"{e['label']} ({e['date']})")
        return bool(hits), hits[:8]
    except Exception as e:
        _log.warning("macro eval: %s", e)
        return False, []


def _warm_gex_snapshot(ticker: str) -> None:
    """One live GEX profile (20-40s) so a flip level exists for a new alert;
    runs in the pool, off the request path. Daily accrual takes over after.
    Recomputes even when today's point exists but predates the flip field
    (record_point overwrites today's point, so this can't duplicate)."""
    try:
        from routers.snapshots import _compute_gex, get_points, record_point
        from datetime import date
        pts = get_points("gex", ticker)
        if pts and pts[-1].get("d") == date.today().isoformat() and pts[-1].get("flip") is not None:
            return
        p = _compute_gex(ticker)
        if p:
            record_point("gex", ticker, p)
    except Exception as e:
        _log.warning("gex warm %s: %s", ticker, e)


async def _run_evaluation_loop():
    _log.info("Alert evaluation loop started (interval=%ds)", _EVAL_INTERVAL)
    while True:
        try:
            session = _market_session()
            if session == "closed":
                # Prices are static; skip all upstream calls and just re-check the
                # clock. _LAST_QUOTES is retained so the page still shows last marks.
                await asyncio.sleep(_CLOSED_INTERVAL)
                continue
            now = int(time.time())
            # Fetch quotes for every active alert's ticker (incl. those in
            # cooldown) so the cached prices the UI reads cover all rows; only
            # armed alerts (cooldown elapsed) are evaluated for firing.
            alerts = await _db_fetchall("SELECT * FROM alerts WHERE active=1")
            if alerts:
                global _last_slow_sweep
                slow_due = (time.time() - _last_slow_sweep) >= _SLOW_INTERVAL
                tickers = list({a["ticker"].upper() for a in alerts
                                if a["ticker"].upper() != _MARKET_TICKER
                                and a["condition"] not in _STRATEGY_CONDITIONS})
                loop = asyncio.get_event_loop()
                quotes = await loop.run_in_executor(
                    _EXECUTOR, _fetch_quotes_sync, tickers, session == "extended")
                _LAST_QUOTES.update(quotes)   # serve these prices to the page

                for alert in alerts:
                    if alert["cooldown_until"] >= now:
                        continue
                    tkr = alert["ticker"].upper()
                    cond = alert["condition"]
                    value = None
                    fired_tickers = None
                    if cond in _MACRO_CONDITIONS:
                        if not slow_due:
                            continue
                        triggered, fired_tickers = await loop.run_in_executor(
                            _EXECUTOR, _macro_triggered_sync, alert.get("payload"), alert["threshold"])
                        if not triggered:
                            continue
                        price, pct = 0.0, 0.0
                        value = "; ".join(fired_tickers)
                        cooldown = now + _SLOW_COOLDOWN
                    elif cond in _STRATEGY_CONDITIONS:
                        if not slow_due:
                            continue
                        triggered, fired_tickers = await loop.run_in_executor(
                            _EXECUTOR, _strategy_triggered_sync, alert.get("payload"), cond)
                        if not triggered:
                            continue
                        price, pct = 0.0, 0.0
                        value = ", ".join(fired_tickers)
                        cooldown = now + _SLOW_COOLDOWN
                    elif cond in _MACRO_PRINT_CONDITIONS:
                        if not slow_due:
                            continue
                        triggered, printed, label = await loop.run_in_executor(
                            _EXECUTOR, _macro_print_sync, alert.get("payload"), cond, alert["threshold"])
                        if not triggered:
                            continue
                        price, pct, value = printed or 0.0, 0.0, label
                        cooldown = now + _SLOW_COOLDOWN
                    elif cond in _PORTFOLIO_CONDITIONS:
                        if not slow_due:
                            continue
                        triggered, dd, label = await loop.run_in_executor(
                            _EXECUTOR, _portfolio_drawdown_sync, alert.get("payload"), alert["threshold"])
                        if not triggered:
                            continue
                        price, pct, value = dd or 0.0, dd or 0.0, label
                        cooldown = now + _SLOW_COOLDOWN
                    elif cond in _BOARD_CONDITIONS:
                        if not slow_due:
                            continue
                        triggered, label = await loop.run_in_executor(
                            _EXECUTOR, _board_state_sync, alert["id"], tkr, alert.get("payload"))
                        if not triggered:
                            continue
                        price, pct, value = 0.0, 0.0, label
                        cooldown = now + _SLOW_COOLDOWN
                    elif cond in _SLOW_CONDITIONS:
                        if not slow_due:
                            continue
                        triggered, value = await loop.run_in_executor(
                            _EXECUTOR, _slow_triggered_sync, tkr, cond,
                            alert["threshold"], quotes.get(tkr))
                        if not triggered:
                            continue
                        price = quotes.get(tkr, {}).get("price", value or 0.0)
                        pct = quotes.get(tkr, {}).get("pct_1d", 0.0)
                        cooldown = now + _SLOW_COOLDOWN
                    elif cond in _INDICATOR_CONDITIONS:
                        triggered, ind_price = await loop.run_in_executor(
                            _EXECUTOR, _indicator_triggered_sync, tkr, cond, alert["threshold"])
                        if not triggered:
                            continue
                        price = ind_price if ind_price is not None else quotes.get(tkr, {}).get("price", 0.0)
                        pct = quotes.get(tkr, {}).get("pct_1d", 0.0)
                        cooldown = now + 3600
                    else:
                        if not _evaluate(alert, quotes):
                            continue
                        q = quotes[tkr]
                        price, pct = q["price"], q["pct_1d"]
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
                        "current_price": price,
                        "pct_1d":        pct,
                        "value":         value,
                        "fired_tickers": fired_tickers,
                        "triggered_at":  now,
                        "cooldown_until": cooldown,
                    }
                    await _ws_broadcast(alert["user_id"], payload)
                    _log.info("Alert triggered: %s %s %s (price=%.2f)",
                              alert["ticker"], alert["condition"], alert["threshold"], price)
                if slow_due:
                    _last_slow_sweep = time.time()
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
    # strategy_entry/strategy_exit only: {"name": str, "rules": {buy, sell}, "tickers": [...]}
    payload:   dict | None = None


_VALID_CONDITIONS = (_QUOTE_CONDITIONS | _INDICATOR_CONDITIONS | _SLOW_CONDITIONS | _BOARD_CONDITIONS
                     | _STRATEGY_CONDITIONS | _MACRO_CONDITIONS
                     | _MACRO_PRINT_CONDITIONS | _PORTFOLIO_CONDITIONS)
_MACRO_MODES = {"marquee", "monetary", "high"}


@router.post("")
async def create_alert(req: AlertCreate):
    if req.condition not in _VALID_CONDITIONS:
        raise HTTPException(400, f"condition must be one of {sorted(_VALID_CONDITIONS)}")
    payload_json = None
    if req.condition in _STRATEGY_CONDITIONS:
        p = req.payload or {}
        rules = p.get("rules") or {}
        raw_tickers = [str(t).strip().upper() for t in (p.get("tickers") or []) if str(t).strip()]
        if not rules.get("buy") and not rules.get("sell"):
            raise HTTPException(400, "strategy alert needs a rules block with buy/sell conditions")
        if not raw_tickers:
            raise HTTPException(400, "strategy alert needs at least one ticker")
        seen: list[str] = []
        for t in raw_tickers:                          # dedup, preserve order, cap
            if t not in seen:
                seen.append(t)
        tickers = seen[:_STRATEGY_MAX_TICKERS]
        name = str(p.get("name") or "Strategy").strip()[:40]
        ticker = name or "Strategy"                    # ticker column = display name
        payload_json = json.dumps({"name": name, "rules": rules, "tickers": tickers})
    elif req.condition in _MACRO_CONDITIONS:
        ticker = _MARKET_TICKER          # market-wide
        p = req.payload or {}
        if p.get("source") == "release-hub":
            # Per-series alert from the Release Tape bell: watch the tape feed by
            # base event name (recurs across each month's print).
            names = [str(x)[:80] for x in (p.get("names") or [])][:20]
            payload_json = json.dumps({"source": "release-hub", "names": names, "label": str(p.get("label") or "")[:80]})
        else:
            mode = p.get("mode") if p.get("mode") in _MACRO_MODES else "marquee"
            labels = [str(x)[:60] for x in (p.get("labels") or [])][:20]
            payload_json = json.dumps({"mode": mode, "labels": labels})
    elif req.condition in _MACRO_PRINT_CONDITIONS:
        ticker = _MARKET_TICKER          # market-wide
        p = req.payload or {}
        series = str(p.get("series") or "").strip().upper()
        if not series:
            raise HTTPException(400, "macro print alert needs a FRED series id, e.g. CPIAUCSL")
        transform = "yoy" if p.get("transform") == "yoy" else None
        payload_json = json.dumps({"series": series, "transform": transform,
                                   "label": str(p.get("label") or series)[:60]})
    elif req.condition in _PORTFOLIO_CONDITIONS:
        p = req.payload or {}
        holdings = [
            {"ticker": str(h.get("ticker", "")).strip().upper(), "weight": float(h.get("weight") or 0)}
            for h in (p.get("holdings") or [])
            if str(h.get("ticker", "")).strip() and float(h.get("weight") or 0) > 0
        ][:60]
        if not holdings:
            raise HTTPException(400, "portfolio alert needs at least one weighted holding")
        label = str(p.get("label") or "Portfolio").strip()[:40]
        ticker = label or "Portfolio"    # ticker column = display name
        payload_json = json.dumps({"label": label, "holdings": holdings,
                                   "total_value": float(p.get("total_value") or 100_000)})
    elif req.condition in _BOARD_CONDITIONS:
        # The ticker column holds a board reference, not a symbol. It must not go
        # through the uppercase default below: board and station ids are lowercase
        # and would stop resolving.
        ref = (req.ticker or "").strip().lower()
        kind, _, board_id = ref.partition(":")
        if kind not in _BOARD_KINDS or not board_id:
            raise HTTPException(
                400, f"board alert needs a reference like '<kind>:<id>', kind one of {sorted(_BOARD_KINDS)}")
        ticker = f"{kind}:{board_id}"
        station = str((req.payload or {}).get("station") or "").strip()
        payload_json = json.dumps({"station": station}) if station else None
    elif req.condition in _SENTIMENT_CONDITIONS:
        ticker = _MARKET_TICKER          # market-wide: no per-ticker input
    else:
        ticker = req.ticker.strip().upper()
        if not ticker:
            raise HTTPException(400, "ticker required")
    if req.condition == "price_cross_gex_flip":
        # Seed a flip level now (20-40s, in the pool); daily accrual takes over.
        _EXECUTOR.submit(_warm_gex_snapshot, ticker)
    alert_id = str(uuid.uuid4())
    now = int(time.time())
    await _db_execute(
        "INSERT INTO alerts (id, user_id, ticker, condition, threshold, active, cooldown_until, created_at, payload) VALUES (?,?,?,?,?,1,0,?,?)",
        (alert_id, req.user_id, ticker, req.condition, req.threshold, now, payload_json),
    )
    return {"id": alert_id, "ticker": ticker, "condition": req.condition, "threshold": req.threshold,
            "active": True, "cooldown_until": 0, "created_at": now, "payload": payload_json}


# Declared before /{user_id} so "quotes" isn't captured as a user id.
@router.get("/quotes")
async def alert_quotes(tickers: str):
    """Latest extended-hours price per ticker — the same values the eval loop
    uses — so the page's Last readout matches what alerts fire on."""
    syms = [t.strip().upper() for t in tickers.split(",") if t.strip()][:50]
    missing = [t for t in syms if t not in _LAST_QUOTES]
    if missing:
        loop = asyncio.get_event_loop()
        fetched = await loop.run_in_executor(_EXECUTOR, _fetch_quotes_sync, missing)
        _LAST_QUOTES.update(fetched)
    out: dict[str, dict] = {}
    for t in syms:
        q = _LAST_QUOTES.get(t)
        if q:
            out[t] = {"current_price": round(q["price"], 2), "pct_change_1d": round(q["pct_1d"], 3)}
    return out


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
