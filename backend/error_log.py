"""Durable record of every error that reached a user.

Fly's log stream rotates within hours, so by the time a failure is reported the
evidence is often gone: this session lost a report-generation failure that way
and had to wait for it to happen again. Alerts do not fill the gap either, since
they email one message and keep no history to audit.

This keeps the last _MAX_ROWS failures on the mounted volume, grouped by a stable
fingerprint so a fault that fires two hundred times is one row with a count
rather than two hundred rows. It records what the user was told alongside what
actually happened, because the two have diverged repeatedly: a 502 whose body
the edge replaced, a sandbox kill reported as a lookahead violation, a bare
"Internal server error" for a strategy that merely ran long.
"""
from __future__ import annotations

import hashlib
import logging
import os
import re
import sqlite3
import threading
import time
import traceback as _tb

logger = logging.getLogger(__name__)

_DB = os.getenv("ERROR_LOG_PATH") or os.path.join(
    os.getenv("DATA_DIR", "/data") if os.path.isdir("/data") else ".", "error_log.db")
_MAX_ROWS = 500
_TRACE_CHARS = 4000
_lock = threading.Lock()
_ready = False

# Digits, ids and addresses differ between two firings of the same fault, so a
# fingerprint that keeps them groups nothing.
_VOLATILE = re.compile(r"0x[0-9a-f]+|\b\d[\d,.]*\b|'[^']{24,}'", re.I)


def _connect() -> sqlite3.Connection:
    conn = sqlite3.connect(_DB, timeout=5)
    conn.execute("PRAGMA journal_mode=WAL")
    return conn


def _init() -> None:
    global _ready
    if _ready:
        return
    with _connect() as c:
        c.execute("""
            CREATE TABLE IF NOT EXISTS errors (
                fingerprint TEXT PRIMARY KEY,
                first_seen  REAL NOT NULL,
                last_seen   REAL NOT NULL,
                count       INTEGER NOT NULL DEFAULT 1,
                method      TEXT,
                path        TEXT,
                status      INTEGER,
                kind        TEXT,
                message     TEXT,
                user_saw    TEXT,
                traceback   TEXT
            )
        """)
        c.execute("CREATE INDEX IF NOT EXISTS errors_last_seen ON errors(last_seen DESC)")
    _ready = True


def _fingerprint(path: str, kind: str, message: str) -> str:
    stable = _VOLATILE.sub("#", f"{path}|{kind}|{message}")[:400]
    return hashlib.sha1(stable.encode("utf-8", "replace")).hexdigest()[:16]


def record(path: str, method: str, status: int, kind: str, message: str,
           user_saw: str = "", exc: BaseException | None = None) -> None:
    """Never raises: a failure to log an error must not become another error."""
    try:
        _init()
        trace = ""
        if exc is not None:
            trace = "".join(_tb.format_exception(type(exc), exc, exc.__traceback__))[-_TRACE_CHARS:]
        now = time.time()
        fp = _fingerprint(path, kind, message)
        with _lock, _connect() as c:
            c.execute("""
                INSERT INTO errors (fingerprint, first_seen, last_seen, count, method, path,
                                    status, kind, message, user_saw, traceback)
                VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(fingerprint) DO UPDATE SET
                    last_seen = excluded.last_seen,
                    count     = errors.count + 1,
                    status    = excluded.status,
                    user_saw  = excluded.user_saw,
                    traceback = excluded.traceback
            """, (fp, now, now, method, path, status, kind, message[:1000],
                  str(user_saw)[:500], trace))
            # Bounded: the volume is 1GB and shared with the caches.
            c.execute("""
                DELETE FROM errors WHERE fingerprint NOT IN
                    (SELECT fingerprint FROM errors ORDER BY last_seen DESC LIMIT ?)
            """, (_MAX_ROWS,))
    except Exception:                       # noqa: BLE001 — logging must not fail a request
        logger.debug("error_log.record failed", exc_info=True)


def recent(limit: int = 50, path_like: str = "", since_hours: float = 0) -> list[dict]:
    try:
        _init()
        sql = "SELECT * FROM errors"
        where, args = [], []
        if path_like:
            where.append("path LIKE ?")
            args.append(f"%{path_like}%")
        if since_hours:
            where.append("last_seen >= ?")
            args.append(time.time() - since_hours * 3600)
        if where:
            sql += " WHERE " + " AND ".join(where)
        sql += " ORDER BY last_seen DESC LIMIT ?"
        args.append(max(1, min(limit, _MAX_ROWS)))
        with _connect() as c:
            c.row_factory = sqlite3.Row
            return [dict(r) for r in c.execute(sql, args).fetchall()]
    except Exception:                       # noqa: BLE001
        logger.debug("error_log.recent failed", exc_info=True)
        return []


def clear() -> int:
    try:
        _init()
        with _lock, _connect() as c:
            n = c.execute("SELECT COUNT(*) FROM errors").fetchone()[0]
            c.execute("DELETE FROM errors")
            return int(n)
    except Exception:                       # noqa: BLE001
        return 0
