import os
import sqlite3
import hashlib
import threading
from pathlib import Path
from datetime import datetime, timezone
from fastapi import APIRouter, HTTPException, Header
from pydantic import BaseModel, Field

router = APIRouter()

# ── Database setup ─────────────────────────────────────────────────────────────
# Store in /data on Fly (persistent volume) or local ./users.db for dev
_DB_PATH = Path(os.getenv("USERS_DB_PATH", "./users.db"))
_lock = threading.Lock()

def _conn():
    c = sqlite3.connect(str(_DB_PATH))
    c.row_factory = sqlite3.Row
    return c

def _init_db():
    with _lock, _conn() as c:
        c.execute("""
            CREATE TABLE IF NOT EXISTS users (
                id            TEXT PRIMARY KEY,
                username      TEXT NOT NULL UNIQUE,
                display_name  TEXT NOT NULL,
                pin_hash      TEXT NOT NULL,
                created_at    TEXT NOT NULL,
                last_login_at TEXT,
                login_count   INTEGER NOT NULL DEFAULT 0
            )
        """)
        c.commit()

_init_db()

# ── Helpers ───────────────────────────────────────────────────────────────────

_ADMIN_SECRET = os.getenv("ADMIN_SECRET", "")

def _hash_pin(pin: str) -> str:
    return hashlib.sha256(pin.encode()).hexdigest()

def _now() -> str:
    return datetime.now(timezone.utc).isoformat()

def _require_admin(secret: str):
    if not _ADMIN_SECRET:
        raise HTTPException(403, "Admin access not configured (set ADMIN_SECRET env var)")
    if secret != _ADMIN_SECRET:
        raise HTTPException(403, "Invalid admin secret")

# ── Schemas ───────────────────────────────────────────────────────────────────

class RegisterRequest(BaseModel):
    id:           str = Field(min_length=1, max_length=64)
    username:     str = Field(min_length=2, max_length=32)
    display_name: str = Field(min_length=1, max_length=64)
    pin:          str = Field(min_length=4, max_length=4, pattern=r"^\d{4}$")
    created_at:   str

class LoginRequest(BaseModel):
    username: str
    pin:      str

# ── Routes ────────────────────────────────────────────────────────────────────

@router.post("/register")
def register(req: RegisterRequest):
    pin_hash = _hash_pin(req.pin)
    with _lock, _conn() as c:
        c.execute(
            """INSERT INTO users (id, username, display_name, pin_hash, created_at)
               VALUES (?,?,?,?,?)
               ON CONFLICT(username) DO UPDATE SET
                 display_name = excluded.display_name,
                 pin_hash     = excluded.pin_hash""",
            (req.id, req.username.lower(), req.display_name, pin_hash, req.created_at),
        )
        c.commit()
    return {"ok": True}


@router.post("/login")
def login(req: LoginRequest):
    with _lock, _conn() as c:
        row = c.execute(
            "SELECT id, pin_hash FROM users WHERE username = ?",
            (req.username.lower(),)
        ).fetchone()
    if not row or row["pin_hash"] != _hash_pin(req.pin):
        raise HTTPException(401, "Invalid credentials")
    # Update last_login and count
    with _lock, _conn() as c:
        c.execute(
            "UPDATE users SET last_login_at = ?, login_count = login_count + 1 WHERE id = ?",
            (_now(), row["id"]),
        )
        c.commit()
    return {"ok": True, "id": row["id"]}


@router.get("/stats")
def stats(x_admin_secret: str = Header(default="")):
    _require_admin(x_admin_secret)
    with _lock, _conn() as c:
        total = c.execute("SELECT COUNT(*) FROM users").fetchone()[0]
        last_7d = c.execute(
            "SELECT COUNT(*) FROM users WHERE created_at >= datetime('now', '-7 days')"
        ).fetchone()[0]
        last_30d = c.execute(
            "SELECT COUNT(*) FROM users WHERE created_at >= datetime('now', '-30 days')"
        ).fetchone()[0]
        rows = c.execute(
            "SELECT username, display_name, created_at, last_login_at, login_count "
            "FROM users ORDER BY created_at DESC LIMIT 200"
        ).fetchall()
    return {
        "total_users":    total,
        "new_last_7d":    last_7d,
        "new_last_30d":   last_30d,
        "users": [dict(r) for r in rows],
    }
