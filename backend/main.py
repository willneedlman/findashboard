import os
import logging
import pathlib
from pathlib import Path
import appdirs as ad
from dotenv import load_dotenv

# Load .env from project root (one level above backend/)
load_dotenv(Path(__file__).parent.parent / ".env")

CACHE_DIR = ".cache"
ad.user_cache_dir = lambda *args: CACHE_DIR
Path(CACHE_DIR).mkdir(exist_ok=True)

from fastapi import FastAPI, Request, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
from starlette.middleware.base import BaseHTTPMiddleware

from routers import market, options, bond, portfolio, nav, corporate, rates, correlation, dcf, probability, strategy, users, screener, filings, lob, trading, algo, ai, sentiment, alerts, regression, paper_strategies
from contextlib import asynccontextmanager

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")


@asynccontextmanager
async def lifespan(app):
    alerts.start_evaluation_loop()
    yield
    alerts.stop_evaluation_loop()


app = FastAPI(title="Finance Terminal API", version="2.0.0", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://localhost:3000"],
    allow_methods=["GET", "POST", "DELETE"],
    allow_headers=["Content-Type", "Accept", "X-Admin-Secret"],
    allow_credentials=False,
)


class SecurityHeadersMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next) -> Response:
        response = await call_next(request)
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["X-Frame-Options"] = "DENY"
        response.headers["Referrer-Policy"] = "strict-origin-when-cross-origin"
        # Static assets get long-lived cache; everything else (API, HTML) gets no-store
        if request.url.path.startswith("/assets/"):
            response.headers["Cache-Control"] = "public, max-age=31536000, immutable"
        else:
            response.headers["Cache-Control"] = "no-store"
        return response

app.add_middleware(SecurityHeadersMiddleware)

app.include_router(market.router,      prefix="/api/market",      tags=["market"])
app.include_router(options.router,     prefix="/api/options",     tags=["options"])
app.include_router(bond.router,        prefix="/api/bond",        tags=["bond"])
app.include_router(portfolio.router,   prefix="/api/portfolio",   tags=["portfolio"])
app.include_router(nav.router,         prefix="/api/nav",         tags=["nav"])
app.include_router(corporate.router,   prefix="/api/corporate",   tags=["corporate"])
app.include_router(rates.router,       prefix="/api/rates",       tags=["rates"])
app.include_router(correlation.router, prefix="/api/correlation", tags=["correlation"])
app.include_router(dcf.router,         prefix="/api/dcf",         tags=["dcf"])
app.include_router(probability.router, prefix="/api/prob",        tags=["probability"])
app.include_router(strategy.router,   prefix="/api/strategy",    tags=["strategy"])
app.include_router(users.router,      prefix="/api/users",       tags=["users"])
app.include_router(screener.router,   prefix="/api/screener",    tags=["screener"])
app.include_router(filings.router,    prefix="/api/filings",     tags=["filings"])
app.include_router(lob.router,        prefix="/api/admin/lob",   tags=["lob"])
app.include_router(trading.router,    prefix="/api/trading",     tags=["trading"])
app.include_router(algo.router,       prefix="/api/algo",        tags=["algo"])
app.include_router(ai.router,         prefix="/api/ai",          tags=["ai"])
app.include_router(sentiment.router,  prefix="/api/sentiment",   tags=["sentiment"])
app.include_router(alerts.router,      prefix="/api/alerts",      tags=["alerts"])
app.include_router(regression.router,       prefix="/api/regression",        tags=["regression"])
app.include_router(paper_strategies.router, prefix="/api/paper-strategies",  tags=["paper-strategies"])

@app.get("/api/health")
def health():
    return {"status": "ok"}


# ── Serve React build in production ──────────────────────────────────────────
_FRONTEND_DIST = os.getenv("FRONTEND_DIST", "")

if _FRONTEND_DIST and Path(_FRONTEND_DIST).exists():
    _dist = Path(_FRONTEND_DIST)

    # /assets/* — Vite JS/CSS/image bundles (long-lived, immutable)
    if (_dist / "assets").exists():
        app.mount("/assets", StaticFiles(directory=str(_dist / "assets")), name="assets")

    # Catch-all: serve real files from dist root (favicon.svg, robots.txt, etc.)
    # then fall through to index.html for SPA routes
    @app.get("/{full_path:path}", include_in_schema=False)
    async def serve_spa(full_path: str):
        candidate = _dist / full_path
        if candidate.exists() and candidate.is_file():
            return FileResponse(str(candidate))
        return FileResponse(str(_dist / "index.html"))
