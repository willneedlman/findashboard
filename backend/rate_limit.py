"""Lightweight per-IP rate limiting — in-process (single Fly machine), no Redis.

Protects the expensive/abusable surface (LLM endpoints, auth, data/compute) from
a scripted client exhausting free-tier API quotas or brute-forcing logins, while
staying generous enough not to trip real users (dashboards fire request bursts).

Fixed-window counters keyed by (ip, tier, window). Disable with
RATE_LIMIT_DISABLED=1. Tune any tier with RL_<TIER>=<max>/<seconds>.
"""
import os
import time
import threading

from starlette.middleware.base import BaseHTTPMiddleware
from starlette.responses import JSONResponse

# tier -> (max requests, window seconds). Generous vs. a human; deadly to a script.
_TIERS = {
    "ai":      (20, 60),    # /api/ai, filings, sentiment — Groq/Cerebras/Anthropic quota
    "auth":    (30, 60),    # /api/users — login/register/reset brute-force guard
    "data":    (150, 60),   # market/options/compute — bursty dashboards
    "default": (400, 60),
}
for _t in list(_TIERS):
    _ov = os.getenv(f"RL_{_t.upper()}", "")
    if _ov and "/" in _ov:
        try:
            mx, win = _ov.split("/"); _TIERS[_t] = (int(mx), int(win))
        except ValueError:
            pass

# Longest prefix wins (ordered specific -> general).
_PREFIX_TIER = [
    ("/api/ai", "ai"), ("/api/filings", "ai"), ("/api/sentiment", "ai"),
    ("/api/portfolio-import", "ai"),   # must precede /api/portfolio below — Claude vision call
    ("/api/users", "auth"),
    ("/api/options", "data"), ("/api/market", "data"), ("/api/screener", "data"),
    ("/api/portfolio", "data"), ("/api/iv", "data"), ("/api/corporate", "data"),
    ("/api/valuation", "data"), ("/api/prob", "data"), ("/api/dcf", "data"),
    ("/api/regression", "data"), ("/api/correlation", "data"), ("/api/nav", "data"),
]
_EXEMPT = ("/api/analytics/pageview",)   # fires on every page load — cheap, must not throttle

_DISABLED = os.getenv("RATE_LIMIT_DISABLED", "") == "1"
_lock = threading.Lock()
_counts: dict = {}   # (ip, tier, window) -> count


def _tier(path: str) -> str:
    for pre, t in _PREFIX_TIER:
        if path.startswith(pre):
            return t
    return "default"


class RateLimitMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request, call_next):
        path = request.url.path
        if (_DISABLED or request.method == "OPTIONS"
                or not path.startswith("/api/")
                or any(path.startswith(e) for e in _EXEMPT)):
            return await call_next(request)

        tier = _tier(path)
        limit, window = _TIERS[tier]
        ip = request.headers.get("fly-client-ip") or (request.client.host if request.client else "anon")
        now = int(time.time())
        win = now // window
        key = (ip, tier, win)

        with _lock:
            n = _counts.get(key, 0) + 1
            _counts[key] = n
            if len(_counts) > 10000:   # opportunistic eviction of stale windows
                keep = {k: v for k, v in _counts.items() if k[2] >= win - 1}
                _counts.clear(); _counts.update(keep)

        if n > limit:
            # Same-origin in prod needs no CORS headers; reflect Origin so the
            # 429 is still readable cross-origin (dev / future subdomains).
            headers = {"Retry-After": str(window - (now % window))}
            origin = request.headers.get("origin")
            if origin:
                headers["Access-Control-Allow-Origin"] = origin
                headers["Access-Control-Allow-Credentials"] = "true"
            return JSONResponse({"detail": "Rate limit exceeded — please slow down."},
                                status_code=429, headers=headers)
        return await call_next(request)
