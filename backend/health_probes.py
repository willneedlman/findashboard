"""Live dependency health for the admin view.

Probes the external services the app depends on and reports up/down + latency.
Results are cached briefly so a refreshing admin can't hammer the providers, and
each probe runs in a worker with a hard timeout so a hung upstream can never
block the request. Quota-metered providers (FMP) are reported config-only to
avoid burning the daily budget on health checks.
"""
import os
import time
import logging
import threading
from concurrent.futures import ThreadPoolExecutor, wait

logger = logging.getLogger(__name__)

_TTL = 60.0
_PROBE_TIMEOUT = 5.0
_cache: dict | None = None
_cache_at = 0.0
_lock = threading.Lock()


def _yfinance() -> dict:
    import yfinance as yf
    t0 = time.perf_counter()
    h = yf.Ticker("AAPL").history(period="1d")
    ms = (time.perf_counter() - t0) * 1000
    ok = h is not None and not h.empty
    return {"status": "up" if ok else "degraded", "latency_ms": round(ms, 0),
            "detail": "live quote" if ok else "empty response"}


def _fred() -> dict:
    key = os.getenv("FRED_API_KEY", "").strip()
    if not key:
        return {"status": "unconfigured", "latency_ms": None, "detail": "no FRED_API_KEY"}
    import requests
    t0 = time.perf_counter()
    # Same endpoint + params the app actually uses (routers/rates.py) so the
    # probe reflects real FRED health, not a different endpoint's quirks.
    r = requests.get(
        "https://api.stlouisfed.org/fred/series/observations",
        params={"series_id": "DGS10", "sort_order": "desc", "limit": 1,
                "api_key": key, "file_type": "json"},
        timeout=4,
    )
    ms = (time.perf_counter() - t0) * 1000
    return {"status": "up" if r.ok else "down", "latency_ms": round(ms, 0),
            "detail": f"HTTP {r.status_code}"}


def _groq() -> dict:
    key = os.getenv("GROQ_API_KEY", "").strip()
    if not key:
        return {"status": "unconfigured", "latency_ms": None, "detail": "no GROQ_API_KEY"}
    from groq import Groq
    t0 = time.perf_counter()
    Groq(api_key=key).models.list()
    ms = (time.perf_counter() - t0) * 1000
    return {"status": "up", "latency_ms": round(ms, 0), "detail": "models reachable"}


def _mistral() -> dict:
    """The wide lane. Reports unconfigured rather than failing when the key is
    absent, because the app runs on the Groq pool without it."""
    key = os.getenv("MISTRAL_API_KEY", "").strip()
    if not key:
        return {"status": "unconfigured", "latency_ms": None,
                "detail": "no MISTRAL_API_KEY (report fan-out runs on Groq only)"}
    import httpx
    t0 = time.perf_counter()
    r = httpx.get("https://api.mistral.ai/v1/models", timeout=15,
                  headers={"Authorization": f"Bearer {key}"})
    ms = (time.perf_counter() - t0) * 1000
    if r.status_code >= 400:
        return {"status": "down", "latency_ms": round(ms, 0),
                "detail": f"{r.status_code}: {(r.text or '')[:120]}"}
    return {"status": "up", "latency_ms": round(ms, 0), "detail": "wide lane ready"}


# Config-only key check, BUT we surface real throttling passively: fmp records
# 429s seen on actual app calls, so a live rate-limit shows as "degraded" here
# without us spending any quota on a probe.
def _fmp() -> dict:
    ok = bool(os.getenv("FMP_API_KEY", "").strip())
    if not ok:
        return {"status": "unconfigured", "latency_ms": None, "detail": "no FMP_API_KEY"}
    try:
        import fmp
        rl = fmp.rate_limit_status()
        if rl.get("rate_limited"):
            mins = max(1, round(rl["window_sec"] / 60))
            return {"status": "degraded", "latency_ms": None,
                    "detail": f"rate-limited — {rl['recent_count']}× 429 in last {mins}m (passive)"}
    except Exception:
        pass
    return {"status": "configured", "latency_ms": None, "detail": "key present (not live-probed: quota)"}


def _tradier() -> dict:
    ok = bool(os.getenv("TRADIER_API_KEY", "").strip())
    env = os.getenv("TRADIER_ENV", "sandbox")
    return {"status": "configured" if ok else "unconfigured", "latency_ms": None,
            "detail": f"{env} token present" if ok else "no TRADIER_API_KEY"}


_PROBES = {
    "yfinance": _yfinance,
    "FMP":      _fmp,
    "FRED":     _fred,
    "Groq":     _groq,
    "Mistral":  _mistral,
    "Tradier":  _tradier,
}


def probe_all(force: bool = False) -> dict:
    global _cache, _cache_at
    if not force and _cache is not None and (time.time() - _cache_at) < _TTL:
        return _cache

    # Serialize the populate so concurrent admins (the tab auto-refreshes) don't
    # each fire a full probe burst at the providers; late arrivals re-read cache.
    with _lock:
        now = time.time()
        if not force and _cache is not None and (now - _cache_at) < _TTL:
            return _cache

        # One bounded wait for the whole batch: total time is capped at
        # _PROBE_TIMEOUT regardless of how many probes hang. shutdown(wait=False)
        # means a stuck probe thread can never block our return (it dies on its
        # own socket timeout) — so a hung upstream cannot freeze the request.
        pool = ThreadPoolExecutor(max_workers=len(_PROBES))
        try:
            fut_to_name = {pool.submit(fn): name for name, fn in _PROBES.items()}
            done, _pending = wait(fut_to_name.keys(), timeout=_PROBE_TIMEOUT)
            results: dict[str, dict] = {}
            for fut, name in fut_to_name.items():
                if fut in done:
                    try:
                        results[name] = fut.result()
                    except Exception as e:  # noqa: BLE001 — a probe failure is a health signal
                        results[name] = {"status": "down", "latency_ms": None, "detail": str(e)[:120]}
                else:
                    results[name] = {"status": "down", "latency_ms": None, "detail": "probe timed out"}
        finally:
            pool.shutdown(wait=False)

        _cache = {"checked_at": now, "services": results}
        _cache_at = now
        return _cache
