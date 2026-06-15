"""In-process API telemetry for the admin health view.

Cheap, thread-safe, no external store. Counters live for the life of the
process and reset on deploy/restart (the admin view labels them "since
<uptime>"). This is observability for a single small machine, not a metrics
backend; if the app ever scales past one box, replace this with a real
collector.
"""
import threading
import time
from collections import deque

_START = time.time()
_lock = threading.Lock()

# Request counters
_total = 0
_by_class: dict[str, int] = {"2xx": 0, "3xx": 0, "4xx": 0, "5xx": 0}
_by_path: dict[str, dict] = {}        # path-prefix -> {count, errors, ms_sum, ms_max}
_lat_sum = 0.0
_lat_max = 0.0
_slow = 0                              # requests slower than _SLOW_MS

# Per-minute request ring (last 60 minutes) for a sparkline
_MINUTES = 60
_minute_ring: deque[list] = deque(maxlen=_MINUTES)  # [epoch_minute, count]

# AI provider usage (answers "is the Groq->Cerebras failover firing?")
_ai: dict[str, dict] = {
    "groq":     {"ok": 0, "fail": 0},
    "cerebras": {"ok": 0, "fail": 0},
}
_ai_last_error: str | None = None

_SLOW_MS = 1500.0


def _prefix(path: str) -> str:
    """Group a URL path into a stable bucket: /api/<segment>, else the first
    path segment. Keeps the table readable instead of one row per dynamic id."""
    parts = [p for p in path.split("/") if p]
    if not parts:
        return "/"
    if parts[0] == "api" and len(parts) >= 2:
        return f"/api/{parts[1]}"
    return f"/{parts[0]}"


def record_request(path: str, status: int, ms: float) -> None:
    global _total, _lat_sum, _lat_max, _slow
    cls = f"{status // 100}xx"
    pref = _prefix(path)
    minute = int(time.time() // 60)
    with _lock:
        _total += 1
        if cls in _by_class:
            _by_class[cls] += 1
        _lat_sum += ms
        if ms > _lat_max:
            _lat_max = ms
        if ms > _SLOW_MS:
            _slow += 1
        b = _by_path.get(pref)
        if b is None:
            b = {"count": 0, "errors": 0, "ms_sum": 0.0, "ms_max": 0.0}
            _by_path[pref] = b
        b["count"] += 1
        if status >= 500:
            b["errors"] += 1
        b["ms_sum"] += ms
        if ms > b["ms_max"]:
            b["ms_max"] = ms
        if _minute_ring and _minute_ring[-1][0] == minute:
            _minute_ring[-1][1] += 1
        else:
            _minute_ring.append([minute, 1])


def record_ai(provider: str, ok: bool, error: str | None = None) -> None:
    global _ai_last_error
    with _lock:
        slot = _ai.get(provider)
        if slot is not None:
            slot["ok" if ok else "fail"] += 1
        if not ok and error:
            _ai_last_error = f"{provider}: {error}"[:200]


def snapshot() -> dict:
    now_minute = int(time.time() // 60)
    with _lock:
        uptime = time.time() - _START
        errors = _by_class["5xx"]
        avg_ms = (_lat_sum / _total) if _total else 0.0
        # Build a dense 60-slot sparkline aligned to the current minute.
        ring = {m: c for m, c in _minute_ring}
        spark = [ring.get(now_minute - i, 0) for i in range(_MINUTES - 1, -1, -1)]
        per_min_now = ring.get(now_minute, 0)
        top = sorted(
            (
                {
                    "path":   k,
                    "count":  v["count"],
                    "errors": v["errors"],
                    "avg_ms": round(v["ms_sum"] / v["count"], 1) if v["count"] else 0,
                    "max_ms": round(v["ms_max"], 1),
                }
                for k, v in _by_path.items()
            ),
            key=lambda r: r["count"],
            reverse=True,
        )[:12]
        return {
            "uptime_seconds": round(uptime, 1),
            "total_requests": _total,
            "requests_per_min": per_min_now,
            "error_count": errors,
            "error_rate": round(errors / _total * 100, 2) if _total else 0.0,
            "avg_latency_ms": round(avg_ms, 1),
            "max_latency_ms": round(_lat_max, 1),
            "slow_requests": _slow,
            "by_status": dict(_by_class),
            "by_path": top,
            "sparkline": spark,
            "ai": {
                "groq":     dict(_ai["groq"]),
                "cerebras": dict(_ai["cerebras"]),
                "last_error": _ai_last_error,
            },
        }
