from contextlib import asynccontextmanager
from pathlib import Path
import os
from dotenv import load_dotenv
load_dotenv(Path(__file__).parent / ".env")

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse

from routers import (
    market, options, bond, portfolio, nav,
    corporate, rates, correlation, dcf, users,
    strategy, probability, ai, alerts, algo,
    sentiment, trading,
    filings, lob, regression, screener,
    paper_scheduler, paper_strategies,
    iv_tracker,
)

@asynccontextmanager
async def lifespan(app: FastAPI):
    paper_scheduler.start_scheduler()
    yield
    paper_scheduler.stop_scheduler()

app = FastAPI(title="Finance Terminal API", lifespan=lifespan)

# CORS: never combine wildcard origins with credentials (browsers reflect the
# Origin, effectively allowing every site to make credentialed requests). The SPA
# is served same-origin by this app, so an explicit allowlist is sufficient.
# Override in other environments via ALLOWED_ORIGINS (comma-separated).
_DEFAULT_ORIGINS = "http://localhost:5173,http://127.0.0.1:5173,https://finance-terminal.fly.dev"
_ALLOWED_ORIGINS = [o.strip() for o in os.getenv("ALLOWED_ORIGINS", _DEFAULT_ORIGINS).split(",") if o.strip()]

app.add_middleware(
    CORSMiddleware,
    allow_origins=_ALLOWED_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

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
app.include_router(regression.router,        prefix="/api/regression",        tags=["regression"])
app.include_router(screener.router,          prefix="/api/screener",          tags=["screener"])
app.include_router(paper_scheduler.router,   prefix="/api/paper/scheduler",   tags=["paper-trading"])
app.include_router(paper_strategies.router,  prefix="/api/paper/strategies",  tags=["paper-trading"])
app.include_router(iv_tracker.router,        prefix="/api/iv",                tags=["iv-tracker"])


@app.get("/api/health")
def health_check():
    return {"status": "Terminal Backend Online", "systems": "Nominal"}


_DIST = Path(os.getenv("FRONTEND_DIST", Path(__file__).parent.parent / "frontend" / "dist"))
if _DIST.exists():
    app.mount("/assets", StaticFiles(directory=str(_DIST / "assets")), name="assets")

    @app.get("/{full_path:path}")
    def serve_spa(full_path: str):
        return FileResponse(str(_DIST / "index.html"))
