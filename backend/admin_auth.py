"""Shared admin-secret guard in FastAPI-dependency form.

Mirrors the check in routers/users.py, but as a dependency so routers can gate
whole endpoints with `dependencies=[Depends(require_admin)]`. Used to lock tools
that should only be reachable from the admin console (/admin).
"""
import os
import hmac
from fastapi import Header, HTTPException

_ADMIN_SECRET = os.getenv("ADMIN_SECRET", "")


def require_admin(x_admin_secret: str = Header(default="")):
    if not _ADMIN_SECRET:
        raise HTTPException(403, "Admin access not configured (set ADMIN_SECRET env var)")
    if not hmac.compare_digest(x_admin_secret, _ADMIN_SECRET):
        raise HTTPException(403, "Invalid admin secret")
