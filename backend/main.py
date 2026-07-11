from contextlib import asynccontextmanager
from pathlib import Path
import mimetypes
import os
import time
from dotenv import load_dotenv
# backend/.env is authoritative when present; the repo-root .env fills any gaps
# (e.g. GROQ_API_KEY) so every module sees the same keys sentiment.py already loads.
# Must run before the router imports below, which read keys at import time.
load_dotenv(Path(__file__).parent / ".env")
load_dotenv(Path(__file__).parent.parent / ".env")

from fastapi import FastAPI, Depends, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse

from admin_auth import require_admin

from routers import (
    market, options, bond, portfolio, nav,
    corporate, rates, correlation, dcf, users,
    strategy, probability, ai, alerts, algo,
    sentiment, trading,
    filings, lob, regression, screener,
    paper_scheduler, paper_strategies, paper,
    iv_tracker, valuation, analytics,
    earnings, ipo, leaderboard, etf, fx,
    maritime, snapshots, credit, housing,
    portfolio_optimizer, macro_events,
    logistics, factset, comtrade, bcc,
)

# Pin the MIME types the PWA depends on. A service worker served as anything but
# a JS type is rejected by the browser ("unsupported MIME type"), and some hosts'
# registries map .js to application/json or .webmanifest to octet-stream. Force
# the correct types before any file is served, independent of the host registry.
mimetypes.add_type("text/javascript", ".js")
mimetypes.add_type("text/javascript", ".mjs")
mimetypes.add_type("application/manifest+json", ".webmanifest")


@asynccontextmanager
async def lifespan(app: FastAPI):
    paper_scheduler.start_scheduler()
    alerts.start_evaluation_loop()   # price-alert monitor — previously never started
    screener.start_backfill_loop()   # warm fundamentals cache within the free-tier daily cap
    import bond_prices
    bond_prices.warm_etf_map()       # SSGA holdings are minutes to fetch; build off the request path
    maritime.start_ais_stream()      # live AIS worker (no-op without AISSTREAM_API_KEY)
    maritime.start_rest_poll()       # REST vessel fallback (no-op without VESSELAPI_KEY)
    maritime.start_history_sampler() # 24h AIS ring buffer for the replay scrubber
    rates.start_curve_warmer()       # keep yield-curve + Fed-path caches warm (cold path is ~30s)
    snapshots.start_snapshot_loop()  # daily GEX/IV30 points for the core watchlist (240s post-boot)
    import maritime_kystverket        # Norway coastal AIS (open TCP feed)
    maritime_kystverket.start_stream(maritime._upsert, maritime._classify, maritime._remember)
    yield
    snapshots.stop_snapshot_loop()
    rates.stop_curve_warmer()
    maritime_kystverket.stop_stream()
    maritime.stop_ais_stream()
    screener.stop_backfill_loop()
    alerts.stop_evaluation_loop()
    paper_scheduler.stop_scheduler()

app = FastAPI(title="Alphatape Terminal API", lifespan=lifespan)


# Alert on unhandled crashes so they're never silent (gated by ERROR_ALERTS=1).
import logging as _logging
import error_alert
import metrics
from fastapi import Request as _Request
from fastapi.responses import JSONResponse as _JSONResponse

_log = _logging.getLogger("main")


@app.exception_handler(Exception)
async def _on_unhandled_error(request: _Request, exc: Exception):
    _log.exception("unhandled error on %s %s", request.method, request.url.path)
    error_alert.alert_exception(request.url.path, request.method, exc, 500)
    return _JSONResponse({"detail": "Internal server error"}, status_code=500)

# CORS: never combine wildcard origins with credentials (browsers reflect the
# Origin, effectively allowing every site to make credentialed requests). The SPA
# is served same-origin by this app, so an explicit allowlist is sufficient.
# Override in other environments via ALLOWED_ORIGINS (comma-separated).
_DEFAULT_ORIGINS = (
    "http://localhost:5173,http://127.0.0.1:5173,"
    "https://alphatape.app,https://www.alphatape.app,"
    "https://finance-terminal.fly.dev"
)
_ALLOWED_ORIGINS = [o.strip() for o in os.getenv("ALLOWED_ORIGINS", _DEFAULT_ORIGINS).split(",") if o.strip()]

app.add_middleware(
    CORSMiddleware,
    allow_origins=_ALLOWED_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Per-IP rate limiting (in-process). Added after CORS so it runs first; the 429
# reflects the Origin itself so it stays readable cross-origin.
from rate_limit import RateLimitMiddleware
app.add_middleware(RateLimitMiddleware)


# Public, read-only market data: identical for every user, safe to cache at the
# Cloudflare edge. Maps URL-path prefix -> edge TTL (seconds). Anything NOT listed
# here stays no-store. NEVER add a user-specific or auth-bearing prefix.
_PUBLIC_API_TTL = {
    "/api/rates":       600,
    "/api/dcf":         600,
    "/api/corporate":   600,
    "/api/bond":        300,
    "/api/correlation": 300,
    "/api/sentiment":   300,
    "/api/screener":    300,
    "/api/probability": 120,
    "/api/iv":          120,
    "/api/market":       60,
    "/api/options":      60,
}


@app.middleware("http")
async def cache_control(request, call_next):
    """Drive browser + Cloudflare-edge caching from one place, and record
    per-request telemetry for the admin health view.

    - /assets/*  content-hashed bundles never change → cache a year, immutable.
    - /api/*     no-store by default so authenticated/user responses never reach a
                 shared cache. Public GET endpoints in _PUBLIC_API_TTL opt in to
                 edge caching; non-GET and errors are never made public.
    - everything else is the SPA HTML shell → revalidate so deploys are picked up.
    """
    _t0 = time.perf_counter()
    try:
        response = await call_next(request)
    except Exception:
        # An unhandled route error becomes a 500 in the outer error middleware;
        # meter it here as a 500 before re-raising so the very failures the health
        # view exists to surface aren't the ones silently dropped.
        if request.url.path.startswith("/api/"):
            metrics.record_request(request.url.path, 500, (time.perf_counter() - _t0) * 1000)
        raise
    path = request.url.path
    # Only meter API calls; static assets and the SPA shell are noise here.
    if path.startswith("/api/"):
        metrics.record_request(path, response.status_code, (time.perf_counter() - _t0) * 1000)
    if path.startswith("/assets/"):
        response.headers["Cache-Control"] = "public, max-age=31536000, immutable"
    elif path.startswith("/api/"):
        ttl = None
        if request.method == "GET" and response.status_code == 200:
            for prefix, secs in _PUBLIC_API_TTL.items():
                if path.startswith(prefix):
                    ttl = secs
                    break
        if ttl is not None:
            response.headers["Cache-Control"] = (
                f"public, max-age={ttl}, s-maxage={ttl}, stale-while-revalidate={ttl * 2}"
            )
        else:
            response.headers.setdefault("Cache-Control", "no-store")
    else:
        response.headers["Cache-Control"] = "no-cache"
    return response

app.include_router(market.router,            prefix="/api/market",            tags=["market"])
app.include_router(options.router,           prefix="/api/options",           tags=["options"])
app.include_router(bond.router,              prefix="/api/bond",              tags=["bond"])
app.include_router(portfolio.router,         prefix="/api/portfolio",         tags=["portfolio"])
app.include_router(nav.router,               prefix="/api/nav",               tags=["nav"])
app.include_router(etf.router,               prefix="/api/etf",               tags=["etf"])
app.include_router(corporate.router,         prefix="/api/corporate",         tags=["corporate"])
app.include_router(rates.router,             prefix="/api/rates",             tags=["rates"])
app.include_router(snapshots.router,         prefix="/api/snapshots",         tags=["snapshots"])
app.include_router(fx.router,                prefix="/api/fx",                tags=["fx"])
app.include_router(correlation.router,       prefix="/api/correlation",       tags=["correlation"])
app.include_router(portfolio_optimizer.router, prefix="/api/portfolio-opt",    tags=["portfolio-opt"])
app.include_router(dcf.router,               prefix="/api/dcf",               tags=["dcf"])
app.include_router(factset.router,           prefix="/api/factset",           tags=["factset"])
app.include_router(users.router,             prefix="/api/users",             tags=["users"])
app.include_router(analytics.router,         prefix="/api/analytics",         tags=["analytics"])
app.include_router(strategy.router,          prefix="/api/strategy",          tags=["strategy"])
app.include_router(probability.router,       prefix="/api/prob",              tags=["probability"])
app.include_router(ai.router,                prefix="/api/ai",                tags=["ai"])
app.include_router(alerts.router,            prefix="/api/alerts",            tags=["alerts"])
app.include_router(algo.router,              prefix="/api/algo",              tags=["algo"])
app.include_router(sentiment.router,         prefix="/api/sentiment",         tags=["sentiment"])
app.include_router(credit.router,            prefix="/api/credit",            tags=["credit"])
app.include_router(housing.router,           prefix="/api/housing",           tags=["housing"])
app.include_router(macro_events.router,      prefix="/api/macro-events",      tags=["macro-events"])
app.include_router(trading.router,           prefix="/api/trading",           tags=["trading"])
app.include_router(filings.router,           prefix="/api/filings",           tags=["filings"])
app.include_router(lob.router,               prefix="/api/lob",               tags=["lob"])
app.include_router(regression.router,        prefix="/api/regression",        tags=["regression"])
app.include_router(screener.router,          prefix="/api/screener",          tags=["screener"])
app.include_router(paper.router,             prefix="/api/paper",             tags=["paper-trading"])
app.include_router(paper_scheduler.router,   prefix="/api/paper/scheduler",   tags=["paper-trading"])
app.include_router(paper_strategies.router,  prefix="/api/paper/strategies",  tags=["paper-trading"])
app.include_router(iv_tracker.router,        prefix="/api/iv",                tags=["iv-tracker"])
app.include_router(valuation.router,         prefix="/api/valuation",         tags=["valuation"])
app.include_router(earnings.router,          prefix="/api/earnings",          tags=["earnings"])
app.include_router(ipo.router,               prefix="/api/ipo",               tags=["ipo"])
app.include_router(leaderboard.router,       prefix="/api/leaderboard",       tags=["leaderboard"])
app.include_router(maritime.router,          prefix="/api/maritime",          tags=["maritime"])
app.include_router(logistics.router,         prefix="/api/logistics",         tags=["logistics"])
app.include_router(comtrade.router,          prefix="/api/comtrade",          tags=["comtrade"])
app.include_router(bcc.router,               prefix="/api/bcc",               tags=["bcc"])


@app.api_route("/api/health", methods=["GET", "HEAD"])
def health_check():
    return {"status": "Terminal Backend Online", "systems": "Nominal"}


_DIST = Path(os.getenv("FRONTEND_DIST", Path(__file__).parent.parent / "frontend" / "dist"))
_DIST_RESOLVED = _DIST.resolve()
if _DIST.exists():
    app.mount("/assets", StaticFiles(directory=str(_DIST / "assets")), name="assets")

    # HEAD included explicitly: FastAPI (unlike bare Starlette) does not add HEAD
    # to GET routes, and uptime monitors / link unfurlers probe with HEAD.
    @app.api_route("/{full_path:path}", methods=["GET", "HEAD"])
    def serve_spa(full_path: str):
        # Serve real root files (favicon.svg, robots.txt, ...) when they exist;
        # otherwise fall back to index.html so client-side routes resolve.
        # Unknown /api/* paths must 404, not serve HTML: browsers heuristically
        # disk-cache the HTML against the API URL, which then poisons the real
        # endpoint after it ships.
        if full_path.startswith("api/"):
            raise HTTPException(status_code=404, detail="Not found")
        if full_path:
            candidate = (_DIST / full_path).resolve()
            if candidate.is_file() and _DIST_RESOLVED in candidate.parents:
                return FileResponse(str(candidate))
        return FileResponse(str(_DIST / "index.html"))
