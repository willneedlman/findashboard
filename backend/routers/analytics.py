"""First-party, cookieless web analytics.

Records page views to a small SQLite table on the Fly /data volume. Privacy by
design: no cookies, no raw IP or PII stored — the visitor id is a salted SHA-256
of (IP + user-agent + date) truncated, so it rotates daily and can't be linked
across days or back to a person. Referrers are reduced to a bare domain. This
keeps it GDPR-friendly (no consent banner needed). The /summary view is
admin-gated.
"""
import os
import time
import hashlib
import datetime
import sqlite3
import threading
from pathlib import Path

from fastapi import APIRouter, Request, Depends, Header
from pydantic import BaseModel

from admin_auth import require_admin

router = APIRouter()

# Live alongside users.db (same Fly /data volume) so it persists across deploys.
_users = os.getenv("USERS_DB_PATH")
_DEFAULT = Path(__file__).resolve().parents[2] / "analytics.db"
_DB = Path(os.getenv("ANALYTICS_DB_PATH")
           or (str(Path(_users).parent / "analytics.db") if _users else str(_DEFAULT)))
_lock = threading.Lock()
_SALT = os.getenv("ANALYTICS_SALT", "ft-analytics-v1")


def _conn():
    c = sqlite3.connect(str(_DB))
    c.row_factory = sqlite3.Row
    return c


def _init_db():
    with _conn() as c:
        c.execute("""CREATE TABLE IF NOT EXISTS pageviews(
            ts INTEGER, day TEXT, path TEXT, referrer TEXT, visitor TEXT)""")
        c.execute("CREATE INDEX IF NOT EXISTS idx_pv_day ON pageviews(day)")


_init_db()


def _visitor_hash(ip: str, ua: str, day: str) -> str:
    return hashlib.sha256(f"{_SALT}|{day}|{ip}|{ua}".encode()).hexdigest()[:16]


def _referrer_domain(ref: str) -> str:
    if not ref:
        return ""
    try:
        from urllib.parse import urlparse
        d = urlparse(ref).netloc.lower()
        return d[4:] if d.startswith("www.") else d
    except Exception:
        return ""


class PageView(BaseModel):
    path: str = "/"
    referrer: str = ""


@router.post("/pageview")
def pageview(pv: PageView, request: Request, user_agent: str = Header(default="")):
    # Fly forwards the real client IP in fly-client-ip; fall back to the socket peer.
    ip = request.headers.get("fly-client-ip") or (request.client.host if request.client else "") or ""
    day = datetime.date.today().isoformat()
    path = (pv.path or "/")[:120]
    ref = _referrer_domain(pv.referrer)[:120]
    visitor = _visitor_hash(ip, user_agent[:200], day)
    try:
        with _lock, _conn() as c:
            c.execute("INSERT INTO pageviews(ts, day, path, referrer, visitor) VALUES (?,?,?,?,?)",
                      (int(time.time()), day, path, ref, visitor))
    except Exception:
        pass  # analytics must never break a page load
    return {"ok": True}


@router.get("/summary", dependencies=[Depends(require_admin)])
def summary(days: int = 30):
    today = datetime.date.today()
    cutoff = (today - datetime.timedelta(days=days)).isoformat()
    today_s = today.isoformat()
    with _conn() as c:
        rows = lambda sql, *a: [dict(r) for r in c.execute(sql, a).fetchall()]
        one = lambda sql, *a: c.execute(sql, a).fetchone()[0]
        return {
            "total_views":     one("SELECT COUNT(*) FROM pageviews"),
            "today_views":     one("SELECT COUNT(*) FROM pageviews WHERE day=?", today_s),
            "today_visitors":  one("SELECT COUNT(DISTINCT visitor) FROM pageviews WHERE day=?", today_s),
            "window_days":     days,
            "window_views":    one("SELECT COUNT(*) FROM pageviews WHERE day>=?", cutoff),
            "window_visitors": one("SELECT COUNT(DISTINCT visitor) FROM pageviews WHERE day>=?", cutoff),
            "by_day":      rows("SELECT day, COUNT(*) views, COUNT(DISTINCT visitor) visitors FROM pageviews WHERE day>=? GROUP BY day ORDER BY day", cutoff),
            "top_paths":   rows("SELECT path, COUNT(*) views, COUNT(DISTINCT visitor) visitors FROM pageviews WHERE day>=? GROUP BY path ORDER BY views DESC LIMIT 20", cutoff),
            "top_referrers": rows("SELECT referrer, COUNT(*) views FROM pageviews WHERE day>=? AND referrer<>'' GROUP BY referrer ORDER BY views DESC LIMIT 15", cutoff),
        }
