"""
Persistent SQLite-backed cache that survives server restarts.

Usage:
    from disk_cache import disk_get, disk_set

    val = disk_get("my-key")
    if val is None:
        val = expensive_fetch()
        disk_set("my-key", val, ttl=3600)
"""
import sqlite3, json, time, threading, os
from pathlib import Path

_DB = Path(os.getenv("DISK_CACHE_PATH", ".cache/disk_cache.db"))
_DB.parent.mkdir(parents=True, exist_ok=True)

# Single persistent connection per thread (thread-local avoids lock contention).
_local = threading.local()
_write_lock = threading.Lock()   # serialize DDL/writes


def _conn() -> sqlite3.Connection:
    """Return (or create) a thread-local read connection."""
    if not getattr(_local, "conn", None):
        c = sqlite3.connect(str(_DB), check_same_thread=False, timeout=10)
        c.execute("PRAGMA journal_mode=WAL")
        c.execute("PRAGMA synchronous=NORMAL")
        c.execute("PRAGMA cache_size=-8000")   # 8 MB page cache
        _local.conn = c
    return _local.conn


def _init():
    with _write_lock, _conn() as c:
        c.execute("""
            CREATE TABLE IF NOT EXISTS cache (
                key        TEXT PRIMARY KEY,
                value      TEXT NOT NULL,
                expires_at REAL NOT NULL
            )
        """)
        c.execute("CREATE INDEX IF NOT EXISTS idx_expires ON cache(expires_at)")
        c.commit()

_init()


def disk_get(key: str):
    """Return cached value or None if missing/expired."""
    try:
        row = _conn().execute(
            "SELECT value, expires_at FROM cache WHERE key = ?", (key,)
        ).fetchone()
    except sqlite3.OperationalError:
        # DB file may be temporarily locked; treat as miss
        return None
    if row is None:
        return None
    value, expires_at = row
    if time.time() > expires_at:
        _delete(key)
        return None
    try:
        return json.loads(value)
    except Exception:
        return None


def disk_set(key: str, value, ttl: int = 3600):
    """Store value with TTL in seconds."""
    try:
        serialized = json.dumps(value, default=str)
    except Exception:
        return
    expires_at = time.time() + ttl
    with _write_lock:
        try:
            _conn().execute(
                "INSERT OR REPLACE INTO cache (key, value, expires_at) VALUES (?, ?, ?)",
                (key, serialized, expires_at),
            )
            _conn().commit()
        except sqlite3.OperationalError:
            pass


def _delete(key: str):
    with _write_lock:
        try:
            _conn().execute("DELETE FROM cache WHERE key = ?", (key,))
            _conn().commit()
        except sqlite3.OperationalError:
            pass


def disk_evict_expired():
    """Remove expired entries — call occasionally to keep DB small."""
    with _write_lock:
        try:
            _conn().execute("DELETE FROM cache WHERE expires_at < ?", (time.time(),))
            _conn().commit()
        except sqlite3.OperationalError:
            pass
