from contextlib import asynccontextmanager
from pathlib import Path
import os
from dotenv import load_dotenv
# backend/.env is authoritative when present; the repo-root .env fills any gaps
# (e.g. GROQ_API_KEY) so every module sees the same keys sentiment.py already loads.
# Must run before the router imports below, which read keys at import time.
load_dotenv(Path(__file__).parent / ".env")
load_dotenv(Path(__file__).parent.parent / ".env")

from fastapi import FastAPI, Depends
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
    paper_scheduler, paper_strategies,
    iv_tracker, valuation,
)

@asynccontextmanager
async def lifespan(app: FastAPI):
    paper_scheduler.start_scheduler()
    yield
    paper_scheduler.stop_scheduler()

app = FastAPI(title="Alphatape Terminal API", lifespan=lifespan)

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
    """Drive browser + Cloudflare-edge caching from one place.

    - /assets/*  content-hashed bundles never change → cache a year, immutable.
    - /api/*     no-store by default so authenticated/user responses never reach a
                 shared cache. Public GET endpoints in _PUBLIC_API_TTL opt in to
                 edge caching; non-GET and errors are never made public.
    - everything else is the SPA HTML shell → revalidate so deploys are picked up.
    """
    response = await call_next(request)
    path = request.url.path
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
app.include_router(corporate.router,         prefix="/api/corporate",         tags=["corporate"])
app.include_router(rates.router,             prefix="/api/rates",             tags=["rates"])
app.include_router(correlation.router,       prefix="/api/correlation",       tags=["correlation"])
app.include_router(dcf.router,               prefix="/api/dcf",               tags=["dcf"])
app.include_router(users.router,             prefix="/api/users",             tags=["users"])
app.include_router(strategy.router,          prefix="/api/strategy",          tags=["strategy"])
app.include_router(probability.router,       prefix="/api/prob",              tags=["probability"])
app.include_router(ai.router,                prefix="/api/ai",                tags=["ai"])
app.include_router(alerts.router,            prefix="/api/alerts",            tags=["alerts"])
app.include_router(algo.router,              prefix="/api/algo",              tags=["algo"])
app.include_router(sentiment.router,         prefix="/api/sentiment",         tags=["sentiment"])
app.include_router(trading.router,           prefix="/api/trading",           tags=["trading"])
app.include_router(filings.router,           prefix="/api/filings",           tags=["filings"])
app.include_router(lob.router,               prefix="/api/lob",               tags=["lob"])
app.include_router(regression.router,        prefix="/api/regression",        tags=["regression"], dependencies=[Depends(require_admin)])
app.include_router(screener.router,          prefix="/api/screener",          tags=["screener"])
app.include_router(paper_scheduler.router,   prefix="/api/paper/scheduler",   tags=["paper-trading"])
app.include_router(paper_strategies.router,  prefix="/api/paper/strategies",  tags=["paper-trading"])
app.include_router(iv_tracker.router,        prefix="/api/iv",                tags=["iv-tracker"])
app.include_router(valuation.router,         prefix="/api/valuation",         tags=["valuation"])


@app.get("/api/health")
def health_check():
    return {"status": "Terminal Backend Online", "systems": "Nominal"}


_DIST = Path(os.getenv("FRONTEND_DIST", Path(__file__).parent.parent / "frontend" / "dist"))
_DIST_RESOLVED = _DIST.resolve()
if _DIST.exists():
    app.mount("/assets", StaticFiles(directory=str(_DIST / "assets")), name="assets")

    @app.get("/{full_path:path}")
    def serve_spa(full_path: str):
        # Serve real root files (favicon.svg, robots.txt, ...) when they exist;
        # otherwise fall back to index.html so client-side routes resolve.
        if full_path:
            candidate = (_DIST / full_path).resolve()
            if candidate.is_file() and _DIST_RESOLVED in candidate.parents:
                return FileResponse(str(candidate))
        return FileResponse(str(_DIST / "index.html"))
