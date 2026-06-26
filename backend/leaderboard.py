"""Durable global leaderboard for the timed (5-minute) MM simulator runs.

Stored in its own SQLite DB on the Fly persistent volume (/data via
LEADERBOARD_DB_PATH) so scores survive deploys and restarts, mirroring users.db.
The score is the trader's final Net P&L. The simulators run fully client-side, so
submissions are trust-based — name and score are sanitized/clamped at the router.
"""
import os
import sqlite3
import threading
import time
from pathlib import Path

# /data on Fly (persistent volume); repo-root file in dev.
_DEFAULT_DB = Path(__file__).resolve().parent.parent / "leaderboard.db"
_DB_PATH = Path(os.getenv("LEADERBOARD_DB_PATH", str(_DEFAULT_DB)))
_DB_PATH.parent.mkdir(parents=True, exist_ok=True)
_lock = threading.Lock()

GAMES = {"options-mm", "fixed-income-mm"}
MAX_NAME = 24


def _conn() -> sqlite3.Connection:
    c = sqlite3.connect(str(_DB_PATH))
    c.row_factory = sqlite3.Row
    return c


def _init() -> None:
    with _lock, _conn() as c:
        c.execute(
            """
            CREATE TABLE IF NOT EXISTS scores (
                id      INTEGER PRIMARY KEY AUTOINCREMENT,
                game    TEXT NOT NULL,
                name    TEXT NOT NULL,
                score   REAL NOT NULL,
                uid     TEXT,
                created REAL NOT NULL
            )
            """
        )
        c.execute("CREATE INDEX IF NOT EXISTS idx_game_score ON scores(game, score DESC)")
        c.commit()


_init()


def top(game: str, limit: int = 10) -> list:
    with _lock, _conn() as c:
        rows = c.execute(
            "SELECT name, score, created FROM scores WHERE game = ? "
            "ORDER BY score DESC, created ASC LIMIT ?",
            (game, limit),
        ).fetchall()
    return [
        {"rank": i + 1, "name": r["name"], "score": r["score"], "created": r["created"]}
        for i, r in enumerate(rows)
    ]


def submit(game: str, name: str, score: float, uid: "str | None" = None, limit: int = 10) -> dict:
    """Record a score and return the submitter's 1-based rank plus the new top board."""
    name = (name or "").strip()[:MAX_NAME] or "Anonymous"
    score = float(score)
    now = time.time()
    with _lock, _conn() as c:
        c.execute(
            "INSERT INTO scores (game, name, score, uid, created) VALUES (?, ?, ?, ?, ?)",
            (game, name, score, uid, now),
        )
        c.commit()
        # Rank = strictly-better scores + 1 (ties share the higher rank).
        better = c.execute(
            "SELECT COUNT(*) FROM scores WHERE game = ? AND score > ?", (game, score)
        ).fetchone()[0]
    return {"rank": better + 1, "name": name, "score": score, "top": top(game, limit)}
