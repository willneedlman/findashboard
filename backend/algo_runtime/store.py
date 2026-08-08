"""Revision store: an append-only DAG of strategy source.

Code is the state; the chat transcript is a log of how it got there. That
inversion is the fix for the current builder, where conversation state IS the
state and a session cannot be replayed or undone.

Properties this buys:
  * every backtest pins an immutable source hash  -> reproducible
  * undo is `head = parent_id`                    -> no destructive edits
  * diff is difflib between any two revisions     -> reviewable history

SQLite alongside the app's other DBs. Local-first: one row per revision, no
migrations beyond CREATE TABLE IF NOT EXISTS.
"""
from __future__ import annotations

import difflib
import hashlib
import json
import os
import sqlite3
import time
import uuid

DB_PATH = os.getenv("ALGO_CODE_DB") or os.path.abspath(
    os.path.join(os.path.dirname(os.path.dirname(__file__)), "algo_code.db"))

_SCHEMA = """
CREATE TABLE IF NOT EXISTS strategy (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    head_id     TEXT,
    created_at  REAL NOT NULL,
    updated_at  REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS revision (
    id           TEXT PRIMARY KEY,
    strategy_id  TEXT NOT NULL,
    parent_id    TEXT,
    source       TEXT NOT NULL,
    source_hash  TEXT NOT NULL,
    author       TEXT NOT NULL,          -- 'user' | 'ai'
    prompt       TEXT,                   -- null for hand edits
    diagnostics  TEXT NOT NULL DEFAULT '[]',
    created_at   REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_rev_strategy ON revision(strategy_id, created_at);
"""


def _conn() -> sqlite3.Connection:
    c = sqlite3.connect(DB_PATH, timeout=10)
    c.row_factory = sqlite3.Row
    c.executescript(_SCHEMA)
    return c


def _uid() -> str:
    return uuid.uuid4().hex[:16]


def source_hash(source: str) -> str:
    return hashlib.sha256((source or "").encode()).hexdigest()[:16]


def create_strategy(name: str, source: str, author: str = "ai",
                    prompt: str | None = None, diagnostics: list | None = None) -> dict:
    now = time.time()
    sid, rid = _uid(), _uid()
    with _conn() as c:
        c.execute("INSERT INTO strategy (id, name, head_id, created_at, updated_at) VALUES (?,?,?,?,?)",
                  (sid, name, rid, now, now))
        c.execute("INSERT INTO revision (id, strategy_id, parent_id, source, source_hash, author, "
                  "prompt, diagnostics, created_at) VALUES (?,?,?,?,?,?,?,?,?)",
                  (rid, sid, None, source, source_hash(source), author, prompt,
                   json.dumps(diagnostics or []), now))
    return {"strategy_id": sid, "revision_id": rid}


def commit(strategy_id: str, source: str, author: str = "user",
           prompt: str | None = None, diagnostics: list | None = None) -> dict:
    """Append a revision and move head. Identical source is a no-op, so
    re-running a backtest without editing does not litter the history."""
    now = time.time()
    with _conn() as c:
        row = c.execute("SELECT head_id FROM strategy WHERE id = ?", (strategy_id,)).fetchone()
        if row is None:
            raise KeyError(strategy_id)
        parent = row["head_id"]
        if parent:
            prev = c.execute("SELECT source_hash FROM revision WHERE id = ?", (parent,)).fetchone()
            if prev and prev["source_hash"] == source_hash(source):
                return {"strategy_id": strategy_id, "revision_id": parent, "unchanged": True}
        rid = _uid()
        c.execute("INSERT INTO revision (id, strategy_id, parent_id, source, source_hash, author, "
                  "prompt, diagnostics, created_at) VALUES (?,?,?,?,?,?,?,?,?)",
                  (rid, strategy_id, parent, source, source_hash(source), author, prompt,
                   json.dumps(diagnostics or []), now))
        c.execute("UPDATE strategy SET head_id = ?, updated_at = ? WHERE id = ?", (rid, now, strategy_id))
    return {"strategy_id": strategy_id, "revision_id": rid, "unchanged": False}


def head(strategy_id: str) -> dict | None:
    with _conn() as c:
        row = c.execute(
            "SELECT r.* FROM revision r JOIN strategy s ON s.head_id = r.id WHERE s.id = ?",
            (strategy_id,)).fetchone()
    return _rev(row) if row else None


def history(strategy_id: str, limit: int = 50) -> list[dict]:
    with _conn() as c:
        rows = c.execute("SELECT * FROM revision WHERE strategy_id = ? ORDER BY created_at DESC LIMIT ?",
                         (strategy_id, limit)).fetchall()
    return [_rev(r) for r in rows]


def get_revision(revision_id: str) -> dict | None:
    with _conn() as c:
        row = c.execute("SELECT * FROM revision WHERE id = ?", (revision_id,)).fetchone()
    return _rev(row) if row else None


def revert(strategy_id: str, revision_id: str) -> dict:
    """Undo is a pointer move, not a delete — the discarded revisions stay
    reachable, so an accidental revert costs nothing."""
    with _conn() as c:
        row = c.execute("SELECT id FROM revision WHERE id = ? AND strategy_id = ?",
                        (revision_id, strategy_id)).fetchone()
        if row is None:
            raise KeyError(revision_id)
        c.execute("UPDATE strategy SET head_id = ?, updated_at = ? WHERE id = ?",
                  (revision_id, time.time(), strategy_id))
    return {"strategy_id": strategy_id, "revision_id": revision_id}


def list_strategies(limit: int = 100) -> list[dict]:
    with _conn() as c:
        rows = c.execute(
            "SELECT s.id, s.name, s.updated_at, r.source_hash, r.author "
            "FROM strategy s LEFT JOIN revision r ON r.id = s.head_id "
            "ORDER BY s.updated_at DESC LIMIT ?", (limit,)).fetchall()
    return [dict(r) for r in rows]


def delete_strategy(strategy_id: str) -> None:
    with _conn() as c:
        c.execute("DELETE FROM revision WHERE strategy_id = ?", (strategy_id,))
        c.execute("DELETE FROM strategy WHERE id = ?", (strategy_id,))


def diff(before: str, after: str, n: int = 3) -> list[str]:
    return list(difflib.unified_diff((before or "").splitlines(), (after or "").splitlines(),
                                     "before", "after", lineterm="", n=n))


def _rev(row: sqlite3.Row) -> dict:
    d = dict(row)
    d["diagnostics"] = json.loads(d.get("diagnostics") or "[]")
    return d
