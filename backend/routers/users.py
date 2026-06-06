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
        # Add portfolio_json column if it doesn't exist yet (safe migration)
        try:
            c.execute("ALTER TABLE users ADD COLUMN portfolio_json TEXT")
        except Exception:
            pass
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
        existing = c.execute(
            "SELECT id FROM users WHERE username = ?", (req.username.lower(),)
        ).fetchone()
        if existing:
            raise HTTPException(409, "Username already taken")
        c.execute(
            "INSERT INTO users (id, username, display_name, pin_hash, created_at) VALUES (?,?,?,?,?)",
            (req.id, req.username.lower(), req.display_name, pin_hash, req.created_at),
        )
        c.commit()
    return {"ok": True, "id": req.id, "username": req.username.lower(), "display_name": req.display_name, "created_at": req.created_at}


@router.post("/sync")
def sync_user(req: RegisterRequest):
    """Upsert — used to migrate users created before server-side auth."""
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
            "SELECT id, username, display_name, created_at, pin_hash FROM users WHERE username = ?",
            (req.username.lower(),)
        ).fetchone()
    if not row or row["pin_hash"] != _hash_pin(req.pin):
        raise HTTPException(401, "Invalid username or PIN")
    with _lock, _conn() as c:
        c.execute(
            "UPDATE users SET last_login_at = ?, login_count = login_count + 1 WHERE id = ?",
            (_now(), row["id"]),
        )
        c.commit()
    return {
        "ok": True,
        "id":           row["id"],
        "username":     row["username"],
        "display_name": row["display_name"],
        "created_at":   row["created_at"],
    }


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
            "SELECT id, username, display_name, created_at, last_login_at, login_count "
            "FROM users ORDER BY created_at DESC LIMIT 200"
        ).fetchall()
    return {
        "total_users":    total,
        "new_last_7d":    last_7d,
        "new_last_30d":   last_30d,
        "users": [dict(r) for r in rows],
    }


@router.delete("/admin/user/{username}")
def admin_delete_user(username: str, x_admin_secret: str = Header(default="")):
    _require_admin(x_admin_secret)
    with _lock, _conn() as c:
        row = c.execute("SELECT id FROM users WHERE username = ?", (username.lower(),)).fetchone()
        if not row:
            raise HTTPException(404, f"User '{username}' not found")
        c.execute("DELETE FROM users WHERE username = ?", (username.lower(),))
        c.commit()
    return {"ok": True, "deleted": username}


class ResetPinRequest(BaseModel):
    new_pin: str = Field(min_length=4, max_length=4, pattern=r"^\d{4}$")

@router.post("/admin/reset-pin/{username}")
def admin_reset_pin(username: str, req: ResetPinRequest, x_admin_secret: str = Header(default="")):
    _require_admin(x_admin_secret)
    with _lock, _conn() as c:
        row = c.execute("SELECT id FROM users WHERE username = ?", (username.lower(),)).fetchone()
        if not row:
            raise HTTPException(404, f"User '{username}' not found")
        c.execute("UPDATE users SET pin_hash = ? WHERE username = ?",
                  (_hash_pin(req.new_pin), username.lower()))
        c.commit()
    return {"ok": True, "username": username}


@router.get("/admin/health")
def admin_health(x_admin_secret: str = Header(default="")):
    _require_admin(x_admin_secret)
    import os, sys
    from pathlib import Path

    # Cache stats
    cache_entries = 0
    cache_size_kb = 0
    try:
        from disk_cache import _DB
        import sqlite3 as _sq, time as _time
        if Path(_DB).exists():
            cache_size_kb = round(Path(_DB).stat().st_size / 1024, 1)
            with _sq.connect(str(_DB)) as cc:
                cache_entries = cc.execute("SELECT COUNT(*) FROM cache").fetchone()[0]
    except Exception:
        pass

    # API key config
    keys = {
        "FMP_API_KEY":      bool(os.getenv("FMP_API_KEY", "")),
        "FRED_API_KEY":     bool(os.getenv("FRED_API_KEY", "")),
        "ANTHROPIC_API_KEY":bool(os.getenv("ANTHROPIC_API_KEY", "")),
    }

    return {
        "python":        sys.version.split()[0],
        "users_db":      str(_DB_PATH),
        "cache_entries": cache_entries,
        "cache_size_kb": cache_size_kb,
        "api_keys":      keys,
    }


class PortfolioSaveRequest(BaseModel):
    user_id:  str
    holdings: list  # list of {ticker, weight, strategy?}

@router.get("/portfolio/{user_id}")
def get_portfolio(user_id: str):
    with _lock, _conn() as c:
        row = c.execute("SELECT portfolio_json FROM users WHERE id = ?", (user_id,)).fetchone()
    if not row:
        raise HTTPException(404, "User not found")
    import json
    return {"holdings": json.loads(row["portfolio_json"] or "[]")}

@router.put("/portfolio")
def save_portfolio(req: PortfolioSaveRequest):
    import json
    with _lock, _conn() as c:
        row = c.execute("SELECT id FROM users WHERE id = ?", (req.user_id,)).fetchone()
        if not row:
            raise HTTPException(404, "User not found")
        c.execute("UPDATE users SET portfolio_json = ? WHERE id = ?",
                  (json.dumps(req.holdings), req.user_id))
        c.commit()
    return {"ok": True}


@router.post("/admin/cache/evict")
def admin_evict_cache(x_admin_secret: str = Header(default="")):
    _require_admin(x_admin_secret)
    try:
        from disk_cache import disk_evict_expired
        disk_evict_expired()
        return {"ok": True, "message": "Expired cache entries evicted"}
    except Exception as e:
        raise HTTPException(500, str(e))
