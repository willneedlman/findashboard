"""Email alerting on unhandled server errors so outages aren't silent.

Emails ADMIN_ALERT_EMAIL on an unhandled exception, deduplicated by error
signature with a cooldown so a sustained failure can't flood the inbox. Gated by
ERROR_ALERTS=1 (set in prod only) so local dev never sends. Uses the existing
Resend email path (falls back to console in dev).
"""
import os
import time
import hashlib
import logging
import threading
import traceback

logger = logging.getLogger(__name__)

_ENABLED = os.getenv("ERROR_ALERTS", "") == "1"
_TO = os.getenv("ADMIN_ALERT_EMAIL", "wneedlman@gmail.com")
_COOLDOWN = int(os.getenv("ERROR_ALERT_COOLDOWN", "900"))   # seconds per unique error
_lock = threading.Lock()
_last: dict[str, float] = {}


def alert_exception(path: str, method: str, exc: BaseException, status: int = 500) -> None:
    """Fire-and-forget alert; never raises (an alert failure must not mask the error)."""
    if not _ENABLED:
        return
    try:
        sig = hashlib.sha256(f"{path}|{type(exc).__name__}|{str(exc)[:200]}".encode()).hexdigest()[:16]
        now = time.time()
        with _lock:
            if now - _last.get(sig, 0) < _COOLDOWN:
                return
            _last[sig] = now
        tb = "".join(traceback.format_exception(type(exc), exc, exc.__traceback__))[-3500:]
        from email_sender import send_email
        send_email(
            _TO,
            f"[alphatape] {status} on {method} {path}",
            f"{type(exc).__name__}: {exc}\n\n"
            f"Path: {method} {path}\n"
            f"Time: {time.strftime('%Y-%m-%d %H:%M:%S UTC', time.gmtime())}\n\n"
            f"{tb}",
        )
        logger.info("error alert emailed for %s", path)
    except Exception:
        logger.exception("error-alert send failed")
