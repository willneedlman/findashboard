import os
import sys
import sqlite3
import hashlib
import hmac
import secrets
import time
import threading
from pathlib import Path
from datetime import datetime, timezone
from fastapi import APIRouter, HTTPException, Header, Request
from pydantic import BaseModel, Field, EmailStr

sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))
from email_sender import send_password_reset

router = APIRouter()

# Base URL the reset link points at (the frontend /reset-password route).
APP_BASE_URL = os.getenv("APP_BASE_URL", "http://localhost:5174")

# ── Database setup ─────────────────────────────────────────────────────────────
# Store in /data on Fly (persistent volume), else the canonical repo-root users.db.
# Anchor to the repo root (not the cwd) so launching the server from backend/ vs the
# repo root doesn't silently create a second, separate user database.
_DEFAULT_DB = Path(__file__).resolve().parents[2] / "users.db"
_DB_PATH = Path(os.getenv("USERS_DB_PATH", str(_DEFAULT_DB)))
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
        # password_set = 1 once a user has chosen a real password. Existing rows
        # default to 0 so they are forced to migrate off their legacy 4-digit PIN.
        try:
            c.execute("ALTER TABLE users ADD COLUMN password_set INTEGER NOT NULL DEFAULT 0")
        except Exception:
            pass
        # Email is required for new accounts. Existing rows are NULL until the user
        # adds one (must_set_email gate on login). Unique only among non-NULL values.
        try:
            c.execute("ALTER TABLE users ADD COLUMN email TEXT")
        except Exception:
            pass
        c.execute("CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email ON users(email) WHERE email IS NOT NULL")
        # Session tokens — bind portfolio access to the authenticated user.
        c.execute("""
            CREATE TABLE IF NOT EXISTS sessions (
                token      TEXT PRIMARY KEY,
                user_id    TEXT NOT NULL,
                created_at TEXT NOT NULL
            )
        """)
        # Self-service password reset. token_hash = sha256 of the emailed token,
        # so a leaked DB does not expose usable reset links. Single-use, 1h expiry.
        c.execute("""
            CREATE TABLE IF NOT EXISTS password_resets (
                token_hash TEXT PRIMARY KEY,
                user_id    TEXT NOT NULL,
                expires_at REAL NOT NULL,
                used       INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL
            )
        """)
        c.commit()

_init_db()

# ── Helpers ───────────────────────────────────────────────────────────────────

_ADMIN_SECRET = os.getenv("ADMIN_SECRET", "")

# Credential hashing — salted PBKDF2-HMAC-SHA256 (stdlib, no extra dependency).
# Stored format: "pbkdf2_sha256$<iters>$<salt_hex>$<hash_hex>". Legacy values are
# bare 64-char SHA-256 hex (no "$") and are upgraded on next successful login.
_PBKDF2_ITERS = 240_000

def _hash_credential(secret: str) -> str:
    salt = secrets.token_bytes(16)
    dk = hashlib.pbkdf2_hmac("sha256", secret.encode(), salt, _PBKDF2_ITERS)
    return f"pbkdf2_sha256${_PBKDF2_ITERS}${salt.hex()}${dk.hex()}"

def _verify_credential(stored: str, secret: str) -> bool:
    if stored.startswith("pbkdf2_sha256$"):
        try:
            _, iters_s, salt_hex, hash_hex = stored.split("$")
            dk = hashlib.pbkdf2_hmac("sha256", secret.encode(), bytes.fromhex(salt_hex), int(iters_s))
            return hmac.compare_digest(dk.hex(), hash_hex)
        except Exception:
            return False
    # Legacy unsalted SHA-256 — constant-time compare against the old scheme.
    return hmac.compare_digest(stored, hashlib.sha256(secret.encode()).hexdigest())

def _is_legacy_hash(stored: str) -> bool:
    return not stored.startswith("pbkdf2_sha256$")

def _now() -> str:
    return datetime.now(timezone.utc).isoformat()

def _normalize_email(email: str) -> str:
    return email.strip().lower()

def _hash_token(token: str) -> str:
    """Reset tokens are high-entropy, so a fast hash (not PBKDF2) is correct here."""
    return hashlib.sha256(token.encode()).hexdigest()

_RESET_TTL_SECONDS = 3600   # reset links valid for 1 hour

def _require_admin(secret: str):
    if not _ADMIN_SECRET:
        raise HTTPException(403, "Admin access not configured (set ADMIN_SECRET env var)")
    if not hmac.compare_digest(secret, _ADMIN_SECRET):
        raise HTTPException(403, "Invalid admin secret")

# ── Session tokens ──────────────────────────────────────────────────────────────

def _issue_token(user_id: str) -> str:
    token = secrets.token_urlsafe(32)
    with _lock, _conn() as c:
        c.execute("INSERT INTO sessions (token, user_id, created_at) VALUES (?,?,?)",
                  (token, user_id, _now()))
        c.commit()
    return token

def _user_id_for_token(token: str) -> str | None:
    if not token:
        return None
    with _lock, _conn() as c:
        row = c.execute("SELECT user_id FROM sessions WHERE token = ?", (token,)).fetchone()
    return row["user_id"] if row else None

def _extract_token(authorization: str, x_session_token: str) -> str:
    if authorization and authorization.lower().startswith("bearer "):
        return authorization[7:].strip()
    return (x_session_token or "").strip()

def _require_owner(user_id: str, authorization: str, x_session_token: str):
    """Authorize that the caller's session token belongs to `user_id`."""
    token = _extract_token(authorization, x_session_token)
    owner = _user_id_for_token(token)
    if not owner:
        raise HTTPException(401, "Authentication required")
    if not hmac.compare_digest(owner, user_id):
        raise HTTPException(403, "You may only access your own data")

# ── Login rate limiting (per-IP sliding window over FAILED attempts) ─────────────

_LOGIN_WINDOW   = 60.0   # seconds
_LOGIN_MAX_FAILS = 8     # failures per IP per window before lockout
_login_fails: dict[str, list[float]] = {}
_rl_lock = threading.Lock()

def _client_ip(request: Request) -> str:
    xff = request.headers.get("x-forwarded-for", "")
    if xff:
        return xff.split(",")[0].strip()
    return request.client.host if request.client else "unknown"

def _check_login_rate(ip: str):
    now = time.time()
    with _rl_lock:
        fails = [t for t in _login_fails.get(ip, []) if now - t < _LOGIN_WINDOW]
        _login_fails[ip] = fails
        if len(fails) >= _LOGIN_MAX_FAILS:
            retry = int(_LOGIN_WINDOW - (now - fails[0])) + 1
            raise HTTPException(429, "Too many failed login attempts. Try again later.",
                                headers={"Retry-After": str(max(retry, 1))})

def _record_login_fail(ip: str):
    with _rl_lock:
        _login_fails.setdefault(ip, []).append(time.time())

def _clear_login_fails(ip: str):
    with _rl_lock:
        _login_fails.pop(ip, None)

# Forgot-password rate limit: throttle reset requests per IP (sliding window over
# ALL attempts, success or not, since the endpoint is intentionally non-revealing).
_FORGOT_WINDOW = 300.0   # 5 minutes
_FORGOT_MAX    = 5
_forgot_hits: dict[str, list[float]] = {}

def _check_forgot_rate(ip: str):
    now = time.time()
    with _rl_lock:
        hits = [t for t in _forgot_hits.get(ip, []) if now - t < _FORGOT_WINDOW]
        hits.append(now)
        _forgot_hits[ip] = hits
        if len(hits) > _FORGOT_MAX:
            raise HTTPException(429, "Too many reset requests. Try again later.",
                                headers={"Retry-After": str(int(_FORGOT_WINDOW))})

# ── Schemas ───────────────────────────────────────────────────────────────────

class RegisterRequest(BaseModel):
    id:           str = Field(min_length=1, max_length=64)
    username:     str = Field(min_length=2, max_length=32)
    display_name: str = Field(min_length=1, max_length=64)
    # `pin` is the wire/column name kept for compatibility; it now holds a password.
    pin:          str = Field(min_length=8, max_length=128)
    created_at:   str
    # Optional on the model so /sync (legacy migration) still works; /register
    # enforces presence below.
    email:        EmailStr | None = None

class LoginRequest(BaseModel):
    username: str
    pin:      str   # password (legacy 4-digit PINs still accepted until migrated)

class PortfolioSaveRequest(BaseModel):
    user_id:  str
    holdings: list  # list of {ticker, weight, strategy?}

# ── Routes ────────────────────────────────────────────────────────────────────

@router.post("/register")
def register(req: RegisterRequest):
    if not req.email:
        raise HTTPException(422, "Email is required")
    email = _normalize_email(req.email)
    pin_hash = _hash_credential(req.pin)
    with _lock, _conn() as c:
        if c.execute("SELECT id FROM users WHERE username = ?", (req.username.lower(),)).fetchone():
            raise HTTPException(409, "Username already taken")
        if c.execute("SELECT id FROM users WHERE email = ?", (email,)).fetchone():
            raise HTTPException(409, "Email already registered")
        c.execute(
            "INSERT INTO users (id, username, display_name, pin_hash, created_at, password_set, email) VALUES (?,?,?,?,?,1,?)",
            (req.id, req.username.lower(), req.display_name, pin_hash, req.created_at, email),
        )
        c.commit()
    return {"ok": True, "id": req.id, "username": req.username.lower(), "display_name": req.display_name,
            "created_at": req.created_at, "token": _issue_token(req.id),
            "must_set_password": False, "must_set_email": False}


@router.post("/sync")
def sync_user(req: RegisterRequest):
    """Migrate users created before server-side auth. Insert-only: it must NOT
    overwrite an existing user's credentials, or it becomes an unauthenticated
    account-takeover (anyone could reset another user's PIN by username)."""
    pin_hash = _hash_credential(req.pin)
    with _lock, _conn() as c:
        c.execute(
            """INSERT INTO users (id, username, display_name, pin_hash, created_at)
               VALUES (?,?,?,?,?)
               ON CONFLICT(username) DO NOTHING""",
            (req.id, req.username.lower(), req.display_name, pin_hash, req.created_at),
        )
        c.commit()
    return {"ok": True}


@router.post("/login")
def login(req: LoginRequest, request: Request):
    ip = _client_ip(request)
    _check_login_rate(ip)
    with _lock, _conn() as c:
        row = c.execute(
            "SELECT id, username, display_name, created_at, pin_hash, password_set, email FROM users WHERE username = ?",
            (req.username.lower(),)
        ).fetchone()
    if not row or not _verify_credential(row["pin_hash"], req.pin):
        _record_login_fail(ip)
        raise HTTPException(401, "Invalid username or PIN")
    _clear_login_fails(ip)
    # Transparently upgrade legacy unsalted hashes to PBKDF2 on successful login.
    new_hash = _hash_credential(req.pin) if _is_legacy_hash(row["pin_hash"]) else None
    with _lock, _conn() as c:
        c.execute(
            "UPDATE users SET last_login_at = ?, login_count = login_count + 1 WHERE id = ?",
            (_now(), row["id"]),
        )
        if new_hash:
            c.execute("UPDATE users SET pin_hash = ? WHERE id = ?", (new_hash, row["id"]))
        c.commit()
    return {
        "ok": True,
        "id":                row["id"],
        "username":          row["username"],
        "display_name":      row["display_name"],
        "created_at":        row["created_at"],
        "token":             _issue_token(row["id"]),
        "must_set_password": row["password_set"] != 1,
        "must_set_email":    not row["email"],
    }


@router.post("/logout")
def logout(authorization: str = Header(default=""), x_session_token: str = Header(default="")):
    token = _extract_token(authorization, x_session_token)
    if token:
        with _lock, _conn() as c:
            c.execute("DELETE FROM sessions WHERE token = ?", (token,))
            c.commit()
    return {"ok": True}


class SetPasswordRequest(BaseModel):
    new_password: str = Field(min_length=8, max_length=128)


@router.post("/set-password")
def set_password(req: SetPasswordRequest, authorization: str = Header(default=""),
                 x_session_token: str = Header(default="")):
    """Set a real password (migrates a user off their legacy 4-digit PIN).
    Authorized by the caller's own session token."""
    user_id = _user_id_for_token(_extract_token(authorization, x_session_token))
    if not user_id:
        raise HTTPException(401, "Authentication required")
    with _lock, _conn() as c:
        c.execute("UPDATE users SET pin_hash = ?, password_set = 1 WHERE id = ?",
                  (_hash_credential(req.new_password), user_id))
        c.commit()
    return {"ok": True}


class SetEmailRequest(BaseModel):
    email: EmailStr


@router.post("/set-email")
def set_email(req: SetEmailRequest, authorization: str = Header(default=""),
              x_session_token: str = Header(default="")):
    """Add or replace the caller's email (satisfies the must_set_email gate)."""
    user_id = _user_id_for_token(_extract_token(authorization, x_session_token))
    if not user_id:
        raise HTTPException(401, "Authentication required")
    email = _normalize_email(req.email)
    with _lock, _conn() as c:
        if c.execute("SELECT id FROM users WHERE email = ? AND id != ?", (email, user_id)).fetchone():
            raise HTTPException(409, "Email already registered")
        c.execute("UPDATE users SET email = ? WHERE id = ?", (email, user_id))
        c.commit()
    return {"ok": True}


class ForgotPasswordRequest(BaseModel):
    email: EmailStr


@router.post("/forgot-password")
def forgot_password(req: ForgotPasswordRequest, request: Request):
    """Email a single-use reset link. Always returns the same response whether or
    not the address has an account, so it can't be used to enumerate users."""
    _check_forgot_rate(_client_ip(request))
    email = _normalize_email(req.email)
    with _lock, _conn() as c:
        row = c.execute("SELECT id FROM users WHERE email = ?", (email,)).fetchone()
    if row:
        token = secrets.token_urlsafe(32)
        with _lock, _conn() as c:
            c.execute(
                "INSERT INTO password_resets (token_hash, user_id, expires_at, used, created_at) VALUES (?,?,?,0,?)",
                (_hash_token(token), row["id"], time.time() + _RESET_TTL_SECONDS, _now()),
            )
            c.commit()
        send_password_reset(email, f"{APP_BASE_URL}/reset-password?token={token}")
    return {"ok": True}


class ResetPasswordRequest(BaseModel):
    token:        str = Field(min_length=16, max_length=256)
    new_password: str = Field(min_length=8, max_length=128)


@router.post("/reset-password")
def reset_password(req: ResetPasswordRequest):
    """Consume a reset token, set the new password, and invalidate the user's
    pending reset tokens and all existing sessions (force re-login)."""
    token_hash = _hash_token(req.token)
    now = time.time()
    with _lock, _conn() as c:
        row = c.execute(
            "SELECT user_id, expires_at, used FROM password_resets WHERE token_hash = ?",
            (token_hash,),
        ).fetchone()
        if not row or row["used"] or row["expires_at"] < now:
            raise HTTPException(400, "This reset link is invalid or has expired.")
        user_id = row["user_id"]
        c.execute("UPDATE users SET pin_hash = ?, password_set = 1 WHERE id = ?",
                  (_hash_credential(req.new_password), user_id))
        c.execute("UPDATE password_resets SET used = 1 WHERE user_id = ?", (user_id,))
        c.execute("DELETE FROM sessions WHERE user_id = ?", (user_id,))
        c.commit()
    return {"ok": True}


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
        with_email = c.execute("SELECT COUNT(*) FROM users WHERE email IS NOT NULL AND email <> ''").fetchone()[0]
        rows = c.execute(
            "SELECT id, username, display_name, email, created_at, last_login_at, login_count "
            "FROM users ORDER BY created_at DESC LIMIT 500"
        ).fetchall()
    return {
        "total_users":      total,
        "new_last_7d":      last_7d,
        "new_last_30d":     last_30d,
        "users_with_email": with_email,
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
    new_pin: str = Field(min_length=8, max_length=128)

@router.post("/admin/reset-pin/{username}")
def admin_reset_pin(username: str, req: ResetPinRequest, x_admin_secret: str = Header(default="")):
    _require_admin(x_admin_secret)
    with _lock, _conn() as c:
        row = c.execute("SELECT id FROM users WHERE username = ?", (username.lower(),)).fetchone()
        if not row:
            raise HTTPException(404, f"User '{username}' not found")
        c.execute("UPDATE users SET pin_hash = ? WHERE username = ?",
                  (_hash_credential(req.new_pin), username.lower()))
        c.commit()
    return {"ok": True, "username": username}


@router.get("/admin/health")
def admin_health(x_admin_secret: str = Header(default="")):
    _require_admin(x_admin_secret)
    import sys

    # Cache stats
    cache_entries = 0
    cache_size_kb = 0
    try:
        from disk_cache import _DB
        if Path(_DB).exists():
            cache_size_kb = round(Path(_DB).stat().st_size / 1024, 1)
            with sqlite3.connect(str(_DB)) as cc:
                cache_entries = cc.execute("SELECT COUNT(*) FROM cache").fetchone()[0]
    except Exception:
        pass

    # API key config
    keys = {
        "FMP_API_KEY":      bool(os.getenv("FMP_API_KEY", "")),
        "FRED_API_KEY":     bool(os.getenv("FRED_API_KEY", "")),
        "GROQ_API_KEY":     bool(os.getenv("GROQ_API_KEY", "")),
        "CEREBRAS_API_KEY": bool(os.getenv("CEREBRAS_API_KEY", "")),
    }

    import metrics
    import health_probes
    return {
        "python":        sys.version.split()[0],
        "users_db":      str(_DB_PATH),
        "cache_entries": cache_entries,
        "cache_size_kb": cache_size_kb,
        "api_keys":      keys,
        "metrics":       metrics.snapshot(),
        "dependencies":  health_probes.probe_all(),
    }


# ── Portfolio Management ──────────────────────────────────────────────────────

@router.get("/portfolio")
def get_default_portfolio():
    """Fallback route for generic dashboard requests without user scope context."""
    return {"holdings": []}


@router.get("/portfolio/{user_id}")
def get_portfolio(user_id: str, authorization: str = Header(default=""),
                  x_session_token: str = Header(default="")):
    """Fetch the caller's portfolio. Requires a session token bound to user_id."""
    import json
    _require_owner(user_id, authorization, x_session_token)
    with _lock, _conn() as c:
        row = c.execute("SELECT portfolio_json FROM users WHERE id = ?", (user_id,)).fetchone()
    if not row:
        return {"holdings": []}
    return {"holdings": json.loads(row["portfolio_json"] or "[]")}


@router.put("/portfolio")
def save_portfolio(req: PortfolioSaveRequest, authorization: str = Header(default=""),
                   x_session_token: str = Header(default="")):
    """Save the caller's portfolio. Requires a session token bound to req.user_id."""
    import json
    _require_owner(req.user_id, authorization, x_session_token)
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