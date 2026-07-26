"""
/api/data-audit — cross-source, multi-domain data audit for the Admin Hub.

Pulls the same data point from every connected source and reconciles them with
`data_audit_engine`, flagging rows that are CONFLICT (sources disagree beyond a
variance threshold), STALE (a source's datum is older than its TTL), or OUTLIER
(a source is an extreme vs the median).

Domains (each with its own universe, sources, metrics, and thresholds):
  - equity : price, prev_close, market_cap, pe, eps, beta (market-data sources)
             plus revenue, shares reconciled SEC-vs-FMP (same definition).
             sources: yfinance, fmp, finnhub, alpaca, tradier, alphavantage, sec, serpapi
  - fx     : spot rate per currency pair. sources: yfinance (+ serpapi opt-in)
  - crypto : coin price. sources: yfinance, binance (both keyless) (+ serpapi opt-in)
  - macro  : latest FRED observation — single-source, so a freshness/staleness monitor.

State lives in data_audit.db:
  audit_config       — singleton row (interval + per-domain thresholds/universe/sources).
  audit_results      — current reconciled state per (domain, entity, metric), upserted each run.
  audit_runs         — one summary row per run.
  audit_resolutions  — append-only admin override / accept log (audit history).

A periodic asyncio loop re-runs the audit; `/run` triggers on demand and
`trigger_audit()` is the hook to call whenever new source data is ingested.
"""
from __future__ import annotations

import asyncio
import json
import logging
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable

import sqlite3
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from admin_auth import require_admin
import cache
import fmp
import finnhub
import alphavantage
import alpaca
import tradier
import quotes
import fred_client
import sec_fundamentals
import serpapi_finance
from data_audit_engine import (
    SourceReading, reconcile, run_summary,
    DEFAULT_VARIANCE_PCT, DEFAULT_OUTLIER_PCT, DEFAULT_TTL_SECONDS,
)

logger = logging.getLogger("data_audit")

router = APIRouter(dependencies=[Depends(require_admin)])

_DB_PATH = Path(__file__).resolve().parents[1] / "data_audit.db"
_run_lock = threading.Lock()


def _num(v) -> float | None:
    try:
        f = float(v)
        return f if f == f and f not in (float("inf"), float("-inf")) else None
    except (TypeError, ValueError):
        return None


def _reading(values: dict, fetched_at=None, error=None, raw=None) -> dict:
    return {"values": {k: _num(v) for k, v in values.items()}, "fetched_at": _num(fetched_at), "error": error, "raw": raw or {}}


# ── Source fetchers ───────────────────────────────────────────────────────────
# Each returns {"values": {metric: float|None}, "fetched_at", "error", "raw"}.
# Best-effort: a provider failure degrades to an error string, never aborts a run.

# equity ------------------------------------------------------------------------

def _eq_yf(sym: str) -> dict:
    try:
        info = cache.get_info(sym) or {}
    except Exception as e:  # noqa: BLE001
        return _reading({}, error=f"yfinance: {e}")
    if not info:
        return _reading({}, error="yfinance: no data")
    price = info.get("currentPrice") or info.get("regularMarketPrice") or info.get("regularMarketPreviousClose")
    return _reading(
        {"price": price, "prev_close": info.get("regularMarketPreviousClose"),
         "market_cap": info.get("marketCap"), "pe": info.get("trailingPE"),
         "eps": info.get("trailingEps"), "beta": info.get("beta")},
        fetched_at=info.get("regularMarketTime"),
        raw={k: info.get(k) for k in ("currentPrice", "regularMarketPrice", "regularMarketPreviousClose",
                                      "marketCap", "trailingPE", "trailingEps", "beta", "regularMarketTime") if k in info},
    )


def _eq_fmp(sym: str) -> dict:
    if not fmp.available():
        return _reading({}, error="fmp: no API key")
    try:
        q = fmp.get_quote(sym) or {}
        prof = fmp.get_profile(sym) or {}
        inc = (fmp.get_income(sym, limit=1) or [{}])[0] or {}
    except Exception as e:  # noqa: BLE001
        return _reading({}, error=f"fmp: {e}")
    if not q and not inc:
        return _reading({}, error="fmp: no data")
    return _reading(
        {"price": q.get("price"), "prev_close": q.get("previousClose"), "market_cap": q.get("marketCap"),
         "pe": q.get("pe"), "eps": q.get("eps"), "beta": prof.get("beta"),
         "revenue": inc.get("revenue"), "shares": inc.get("weightedAverageShsOutDil")},
        fetched_at=q.get("timestamp"),
        raw={"price": q.get("price"), "marketCap": q.get("marketCap"), "pe": q.get("pe"),
             "eps": q.get("eps"), "beta": prof.get("beta"), "revenue": inc.get("revenue"),
             "shares": inc.get("weightedAverageShsOutDil"), "fy": inc.get("date")},
    )


def _eq_finnhub(sym: str) -> dict:
    if not finnhub.available():
        return _reading({}, error="finnhub: no API key")
    try:
        q = finnhub.get_quote(sym) or {}
        prof = finnhub.get_profile(sym) or {}
    except Exception as e:  # noqa: BLE001
        return _reading({}, error=f"finnhub: {e}")
    if not q:
        return _reading({}, error="finnhub: no data")
    return _reading(
        {"price": q.get("price"), "prev_close": q.get("previousClose"), "market_cap": prof.get("marketCap")},
        fetched_at=q.get("t") or q.get("timestamp"),
        raw={"price": q.get("price"), "previousClose": q.get("previousClose"), "marketCap": prof.get("marketCap")},
    )


def _eq_alpaca(sym: str) -> dict:
    if not alpaca.available():
        return _reading({}, error="alpaca: no API key")
    if not alpaca.is_equity(sym):
        return _reading({}, error="alpaca: not an equity")
    try:
        px = alpaca.get_latest_price(sym)
    except Exception as e:  # noqa: BLE001
        return _reading({}, error=f"alpaca: {e}")
    if px is None:
        return _reading({}, error="alpaca: no data")
    return _reading({"price": px}, fetched_at=time.time(), raw={"lastPrice": px, "feed": "iex"})


def _eq_tradier(sym: str) -> dict:
    if not tradier.available():
        return _reading({}, error="tradier: no API key")
    try:
        q = tradier.get_quote(sym) or {}
    except Exception as e:  # noqa: BLE001
        return _reading({}, error=f"tradier: {e}")
    price = q.get("last") or q.get("close")
    if price is None:
        return _reading({}, error="tradier: no data")
    return _reading({"price": price, "prev_close": q.get("prevclose")}, fetched_at=time.time(),
                    raw={"last": q.get("last"), "close": q.get("close"), "prevclose": q.get("prevclose")})


def _eq_av(sym: str) -> dict:
    if not alphavantage.available():
        return _reading({}, error="alphavantage: no API key")
    try:
        df = alphavantage.get_history_df(sym)
    except Exception as e:  # noqa: BLE001
        return _reading({}, error=f"alphavantage: {e}")
    if df is None or getattr(df, "empty", True):
        return _reading({}, error="alphavantage: no data")
    try:
        last = df["Close"].iloc[-1]
        ts = df.index[-1].timestamp() if hasattr(df.index[-1], "timestamp") else None
    except Exception as e:  # noqa: BLE001
        return _reading({}, error=f"alphavantage: {e}")
    return _reading({"price": last}, fetched_at=ts, raw={"lastClose": _num(last), "lastBar": str(df.index[-1])[:10]})


def _eq_sec(sym: str) -> dict:
    # SEC has no price/market data — it contributes the fundamental lines
    # (revenue, diluted shares) that reconcile against FMP's same figures.
    try:
        if not sec_fundamentals.statements_available(sym):
            return _reading({}, error="sec: no filings")
        inc = (sec_fundamentals.get_income(sym, limit=1) or [{}])[0] or {}
    except Exception as e:  # noqa: BLE001
        return _reading({}, error=f"sec: {e}")
    if not inc:
        return _reading({}, error="sec: no data")
    return _reading({"revenue": inc.get("revenue"), "shares": inc.get("weightedAverageShsOutDil")},
                    raw={"revenue": inc.get("revenue"), "shares": inc.get("weightedAverageShsOutDil")})


def _eq_serpapi(sym: str) -> dict:
    if not serpapi_finance.available():
        return _reading({}, error="serpapi: unavailable")
    try:
        q = serpapi_finance.quote(sym) or {}
    except Exception as e:  # noqa: BLE001
        return _reading({}, error=f"serpapi: {e}")
    if not q.get("price"):
        return _reading({}, error="serpapi: no data")
    return _reading({"price": q.get("price")}, fetched_at=time.time(), raw={"price": q.get("price")})


# fx ----------------------------------------------------------------------------

def _fx_yf(pair: str) -> dict:
    try:
        info = cache.get_info(pair) or {}
        rate = info.get("regularMarketPrice") or info.get("regularMarketPreviousClose")
        ts = info.get("regularMarketTime")
        if rate is None:
            df = cache.get_history(pair, period="5d")
            if df is not None and not df.empty:
                rate = df["Close"].iloc[-1]
                ts = df.index[-1].timestamp() if hasattr(df.index[-1], "timestamp") else None
    except Exception as e:  # noqa: BLE001
        return _reading({}, error=f"yfinance: {e}")
    if rate is None:
        return _reading({}, error="yfinance: no data")
    return _reading({"rate": rate}, fetched_at=ts, raw={"rate": _num(rate)})


def _fx_serpapi(pair: str) -> dict:
    if not serpapi_finance.available():
        return _reading({}, error="serpapi: unavailable")
    q_sym = pair.replace("=X", "")
    q_sym = f"{q_sym[:3]}-{q_sym[3:]}" if len(q_sym) == 6 else q_sym
    try:
        q = serpapi_finance.quote(q_sym) or {}
    except Exception as e:  # noqa: BLE001
        return _reading({}, error=f"serpapi: {e}")
    if not q.get("price"):
        return _reading({}, error="serpapi: no data")
    return _reading({"rate": q.get("price")}, fetched_at=time.time(), raw={"rate": q.get("price")})


# crypto ------------------------------------------------------------------------

def _cx_yf(sym: str) -> dict:
    try:
        info = cache.get_info(sym) or {}
        price = info.get("currentPrice") or info.get("regularMarketPrice") or info.get("regularMarketPreviousClose")
        ts = info.get("regularMarketTime")
    except Exception as e:  # noqa: BLE001
        return _reading({}, error=f"yfinance: {e}")
    if price is None:
        return _reading({}, error="yfinance: no data")
    return _reading({"price": price}, fetched_at=ts, raw={"price": _num(price)})


def _cx_binance(sym: str) -> dict:
    try:
        px = quotes.live_price(sym)
    except Exception as e:  # noqa: BLE001
        return _reading({}, error=f"binance: {e}")
    if px is None:
        return _reading({}, error="binance: no data")
    return _reading({"price": px}, fetched_at=time.time(), raw={"price": _num(px)})


def _cx_serpapi(sym: str) -> dict:
    return _eq_serpapi(sym)  # same COIN-USD query shape


# macro -------------------------------------------------------------------------

def _macro_fred(sid: str) -> dict:
    if not fred_client.available():
        return _reading({}, error="fred: no API key")
    try:
        latest = fred_client.latest(sid)
    except Exception as e:  # noqa: BLE001
        return _reading({}, error=f"fred: {e}")
    if not latest:
        return _reading({}, error="fred: no data")
    obs_date, value = latest
    try:
        fetched = time.mktime(obs_date.timetuple())
    except Exception:  # noqa: BLE001
        fetched = None
    return _reading({"value": value}, fetched_at=fetched, raw={"value": _num(value), "date": str(obs_date)})


# ── Domain registry ───────────────────────────────────────────────────────────

@dataclass
class AuditSource:
    key: str
    available: Callable[[], bool]
    fetch: Callable[[str], dict]


@dataclass
class AuditDomain:
    key: str
    label: str
    metrics: list[str]
    metric_labels: dict[str, str]
    sources: dict[str, AuditSource]
    default_universe: list[str]
    default_sources: list[str]
    variance_pct: float = DEFAULT_VARIANCE_PCT
    outlier_pct: float = DEFAULT_OUTLIER_PCT
    default_ttl_s: float = float(DEFAULT_TTL_SECONDS * 24)


def _src(key, avail, fn) -> AuditSource:
    return AuditSource(key=key, available=avail, fetch=fn)


DOMAINS: dict[str, AuditDomain] = {
    "equity": AuditDomain(
        key="equity", label="Equities",
        metrics=["price", "prev_close", "market_cap", "pe", "eps", "beta", "revenue", "shares"],
        metric_labels={"price": "Price", "prev_close": "Prev Close", "market_cap": "Market Cap",
                       "pe": "Trailing P/E", "eps": "EPS", "beta": "Beta", "revenue": "Revenue (FY)", "shares": "Dil. Shares"},
        sources={
            "yfinance": _src("yfinance", lambda: True, _eq_yf),
            "fmp": _src("fmp", fmp.available, _eq_fmp),
            "finnhub": _src("finnhub", finnhub.available, _eq_finnhub),
            "alpaca": _src("alpaca", alpaca.available, _eq_alpaca),
            "tradier": _src("tradier", tradier.available, _eq_tradier),
            "alphavantage": _src("alphavantage", alphavantage.available, _eq_av),
            "sec": _src("sec", lambda: True, _eq_sec),
            "serpapi": _src("serpapi", serpapi_finance.available, _eq_serpapi),
        },
        default_universe=["AAPL", "MSFT", "NVDA", "AMZN", "GOOGL", "META", "TSLA", "JPM"],
        default_sources=["yfinance", "fmp", "finnhub", "alpaca", "sec"],
    ),
    "fx": AuditDomain(
        key="fx", label="FX",
        metrics=["rate"], metric_labels={"rate": "Spot Rate"},
        sources={
            "yfinance": _src("yfinance", lambda: True, _fx_yf),
            "serpapi": _src("serpapi", serpapi_finance.available, _fx_serpapi),
        },
        default_universe=["EURUSD=X", "GBPUSD=X", "USDJPY=X", "USDCHF=X", "AUDUSD=X", "USDCAD=X"],
        default_sources=["yfinance"],
        variance_pct=0.3, outlier_pct=1.0,
    ),
    "crypto": AuditDomain(
        key="crypto", label="Crypto",
        metrics=["price"], metric_labels={"price": "Price"},
        sources={
            "yfinance": _src("yfinance", lambda: True, _cx_yf),
            "binance": _src("binance", lambda: True, _cx_binance),
            "serpapi": _src("serpapi", serpapi_finance.available, _cx_serpapi),
        },
        default_universe=["BTC-USD", "ETH-USD", "SOL-USD", "XRP-USD", "DOGE-USD", "ADA-USD"],
        default_sources=["yfinance", "binance"],
        variance_pct=1.0, outlier_pct=3.0,
    ),
    "macro": AuditDomain(
        key="macro", label="Macro (FRED)",
        metrics=["value"], metric_labels={"value": "Latest Value"},
        sources={"fred": _src("fred", fred_client.available, _macro_fred)},
        default_universe=["CPIAUCSL", "UNRATE", "GDPC1", "DGS10", "FEDFUNDS", "PAYEMS", "T10Y2Y"],
        default_sources=["fred"],
        default_ttl_s=3888000.0,   # 45d — monthly macro flags only when genuinely stalled
    ),
}


def _default_domain_cfg(d: AuditDomain) -> dict:
    return {
        "enabled": True,
        "universe": list(d.default_universe),
        "enabled_sources": list(d.default_sources),
        "variance_pct": d.variance_pct,
        "outlier_pct": d.outlier_pct,
        "default_ttl_s": d.default_ttl_s,
        "source_ttl": {},
    }


def _default_config() -> dict:
    return {
        "interval_s": 21600,   # 6h — respects the FMP free-tier daily call cap
        "auto_run": 1,
        "domains": {k: _default_domain_cfg(d) for k, d in DOMAINS.items()},
    }


# ── DB ────────────────────────────────────────────────────────────────────────

def _db() -> sqlite3.Connection:
    conn = sqlite3.connect(str(_DB_PATH), timeout=15)
    conn.row_factory = sqlite3.Row
    return conn


def _init_db() -> None:
    with _db() as conn:
        conn.execute("CREATE TABLE IF NOT EXISTS audit_config (id INTEGER PRIMARY KEY CHECK (id = 1), config_json TEXT NOT NULL)")
        conn.execute("""
            CREATE TABLE IF NOT EXISTS audit_results (
                key TEXT PRIMARY KEY,            -- domain + '|' + entity + '|' + metric
                domain TEXT NOT NULL,
                entity TEXT NOT NULL,
                metric TEXT NOT NULL,
                primary_value REAL, median REAL, spread_pct REAL,
                status TEXT NOT NULL, valid_count INTEGER, source_count INTEGER,
                sources_json TEXT NOT NULL, run_id TEXT, updated_at REAL NOT NULL,
                resolved_source TEXT, resolved_by TEXT, resolved_at REAL
            )""")
        conn.execute("""
            CREATE TABLE IF NOT EXISTS audit_runs (
                run_id TEXT PRIMARY KEY, started_at REAL NOT NULL, finished_at REAL,
                trigger TEXT, universe_size INTEGER, duration_ms INTEGER, summary_json TEXT
            )""")
        conn.execute("""
            CREATE TABLE IF NOT EXISTS audit_resolutions (
                id INTEGER PRIMARY KEY AUTOINCREMENT, ts REAL NOT NULL,
                domain TEXT, entity TEXT NOT NULL, metric TEXT NOT NULL,
                action TEXT NOT NULL, chosen_source TEXT, prior_status TEXT, note TEXT
            )""")
        conn.commit()


def _load_config() -> dict:
    with _db() as conn:
        row = conn.execute("SELECT config_json FROM audit_config WHERE id = 1").fetchone()
    cfg = _default_config()
    if row:
        try:
            stored = json.loads(row["config_json"])
        except (ValueError, TypeError):
            stored = {}
        if isinstance(stored, dict):
            for k in ("interval_s", "auto_run"):
                if k in stored:
                    cfg[k] = stored[k]
            for dk, dcfg in (stored.get("domains") or {}).items():
                if dk in cfg["domains"] and isinstance(dcfg, dict):
                    cfg["domains"][dk].update(dcfg)
    return cfg


def _save_config(cfg: dict) -> None:
    with _db() as conn:
        conn.execute(
            "INSERT INTO audit_config (id, config_json) VALUES (1, ?) "
            "ON CONFLICT(id) DO UPDATE SET config_json = excluded.config_json",
            (json.dumps(cfg),),
        )
        conn.commit()


_init_db()


# ── Run ───────────────────────────────────────────────────────────────────────

def _gather_readings(entity: str, domain: AuditDomain, enabled: list[str]) -> dict[str, dict]:
    srcs = [s for s in enabled if s in domain.sources]
    out: dict[str, dict] = {}
    with ThreadPoolExecutor(max_workers=max(1, min(4, len(srcs) or 1))) as ex:
        futs = {ex.submit(domain.sources[s].fetch, entity): s for s in srcs}
        for fut, s in futs.items():
            try:
                out[s] = fut.result()
            except Exception as e:  # noqa: BLE001
                out[s] = _reading({}, error=f"{s}: {e}")
    return out


def _existing_resolution(conn: sqlite3.Connection, key: str) -> tuple:
    row = conn.execute("SELECT resolved_source, resolved_by, resolved_at FROM audit_results WHERE key = ?", (key,)).fetchone()
    return (row["resolved_source"], row["resolved_by"], row["resolved_at"]) if row else (None, None, None)


def run_audit_once(trigger: str = "manual", only_domain: str | None = None) -> dict:
    """Pull, reconcile, and persist one pass over every enabled domain. Serialized
    by a lock so overlapping triggers don't double-spend provider budgets."""
    if not _run_lock.acquire(blocking=False):
        return {"busy": True}
    started = time.time()
    run_id = f"run_{int(started * 1000)}"
    try:
        cfg = _load_config()
        results: list[dict] = []
        now = time.time()
        universe_total = 0

        for dkey, domain in DOMAINS.items():
            if only_domain and dkey != only_domain:
                continue
            dcfg = cfg["domains"].get(dkey, _default_domain_cfg(domain))
            if not dcfg.get("enabled", True):
                continue
            enabled = [s for s in dcfg.get("enabled_sources", []) if s in domain.sources and domain.sources[s].available()]
            if not enabled:
                continue
            universe = [str(e).strip().upper() for e in dcfg.get("universe", []) if str(e).strip()]
            universe_total += len(universe)
            variance = float(dcfg.get("variance_pct", domain.variance_pct))
            outlier = float(dcfg.get("outlier_pct", domain.outlier_pct))
            default_ttl = float(dcfg.get("default_ttl_s", domain.default_ttl_s))
            ttl_by_source = {k: float(v) for k, v in (dcfg.get("source_ttl") or {}).items()}

            for entity in universe:
                readings = _gather_readings(entity, domain, enabled)
                for metric in domain.metrics:
                    srs = [
                        SourceReading(
                            source=src, value=payload["values"].get(metric),
                            fetched_at=payload.get("fetched_at"),
                            error=payload.get("error") if payload["values"].get(metric) is None else None,
                            raw=payload.get("raw"),
                        )
                        for src, payload in readings.items()
                    ]
                    if not any(sr.value is not None for sr in srs):
                        continue
                    res = reconcile(entity, metric, srs, variance_pct=variance, outlier_pct=outlier,
                                    ttl_by_source=ttl_by_source, default_ttl=default_ttl, now=now)
                    res["domain"] = dkey
                    for s in res["sources"]:
                        s["raw"] = (readings.get(s["source"], {}) or {}).get("raw", {})
                    results.append(res)

        with _db() as conn:
            for res in results:
                key = f"{res['domain']}|{res['entity']}|{res['metric']}"
                rsrc, rby, rat = _existing_resolution(conn, key)
                conn.execute(
                    """INSERT INTO audit_results
                       (key, domain, entity, metric, primary_value, median, spread_pct, status,
                        valid_count, source_count, sources_json, run_id, updated_at,
                        resolved_source, resolved_by, resolved_at)
                       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
                       ON CONFLICT(key) DO UPDATE SET
                        primary_value=excluded.primary_value, median=excluded.median, spread_pct=excluded.spread_pct,
                        status=excluded.status, valid_count=excluded.valid_count, source_count=excluded.source_count,
                        sources_json=excluded.sources_json, run_id=excluded.run_id, updated_at=excluded.updated_at""",
                    (key, res["domain"], res["entity"], res["metric"], res["primaryValue"], res["median"],
                     res["spreadPct"], res["status"], res["validCount"], res["sourceCount"],
                     json.dumps(res["sources"]), run_id, now, rsrc, rby, rat),
                )
            summary = run_summary(results)
            duration_ms = int((time.time() - started) * 1000)
            conn.execute(
                "INSERT INTO audit_runs (run_id, started_at, finished_at, trigger, universe_size, duration_ms, summary_json) VALUES (?,?,?,?,?,?,?)",
                (run_id, started, time.time(), trigger, universe_total, duration_ms, json.dumps(summary)),
            )
            conn.commit()
        logger.info("data audit %s (%s): %d metrics, %d flagged in %dms",
                    run_id, trigger, summary["total"], summary["flagged"], duration_ms)
        return {"run_id": run_id, "trigger": trigger, "summary": summary, "duration_ms": duration_ms, "universe_size": universe_total}
    finally:
        _run_lock.release()


def trigger_audit(trigger: str = "ingest", only_domain: str | None = None) -> None:
    """Fire-and-forget hook for ingestion pipelines. No-op if a run is in flight."""
    threading.Thread(target=lambda: run_audit_once(trigger, only_domain), daemon=True).start()


# ── Scheduler ─────────────────────────────────────────────────────────────────

_loop_task: asyncio.Task | None = None


async def _audit_loop() -> None:
    await asyncio.sleep(240)   # let startup + cache warmers settle
    while True:
        try:
            cfg = _load_config()
            if int(cfg.get("auto_run", 1)):
                await asyncio.to_thread(run_audit_once, "cron")
            interval = max(300, int(cfg.get("interval_s", 21600)))
        except asyncio.CancelledError:
            return
        except Exception as e:  # noqa: BLE001
            logger.warning("data audit loop error: %s", e)
            interval = 21600
        await asyncio.sleep(interval)


def start_audit_loop() -> None:
    global _loop_task
    try:
        _loop_task = asyncio.get_event_loop().create_task(_audit_loop())
    except Exception as e:  # noqa: BLE001
        logger.warning("data audit loop start failed: %s", e)


def stop_audit_loop() -> None:
    global _loop_task
    if _loop_task:
        _loop_task.cancel()
        _loop_task = None


# ── API ───────────────────────────────────────────────────────────────────────

class ConfigUpdate(BaseModel):
    interval_s: int | None = None
    auto_run: int | None = None
    domain: str | None = None
    enabled: bool | None = None
    universe: list[str] | None = None
    enabled_sources: list[str] | None = None
    variance_pct: float | None = None
    outlier_pct: float | None = None
    default_ttl_s: float | None = None
    source_ttl: dict[str, float] | None = None


class ResolveBody(BaseModel):
    domain: str
    entity: str
    metric: str
    action: str            # 'override' | 'clear' | 'accept'
    source: str | None = None
    note: str | None = None


def _row_to_result(r: sqlite3.Row) -> dict:
    try:
        sources = json.loads(r["sources_json"])
    except (ValueError, TypeError):
        sources = []
    return {
        "key": r["key"], "domain": r["domain"], "entity": r["entity"], "metric": r["metric"],
        "primaryValue": r["primary_value"], "median": r["median"], "spreadPct": r["spread_pct"],
        "status": r["status"], "validCount": r["valid_count"], "sourceCount": r["source_count"],
        "sources": sources, "runId": r["run_id"], "updatedAt": r["updated_at"],
        "resolvedSource": r["resolved_source"], "resolvedBy": r["resolved_by"], "resolvedAt": r["resolved_at"],
    }


def _domains_meta(cfg: dict) -> list[dict]:
    out = []
    for k, d in DOMAINS.items():
        out.append({
            "key": k, "label": d.label, "metrics": d.metrics, "metricLabels": d.metric_labels,
            "allSources": list(d.sources.keys()),
            "availableSources": [s for s in d.sources if d.sources[s].available()],
            "config": cfg["domains"].get(k, _default_domain_cfg(d)),
        })
    return out


@router.get("/status")
def status():
    cfg = _load_config()
    with _db() as conn:
        last = conn.execute("SELECT * FROM audit_runs ORDER BY started_at DESC LIMIT 1").fetchone()
        n = conn.execute("SELECT COUNT(*) c FROM audit_results").fetchone()["c"]
    last_run = None
    if last:
        try:
            summ = json.loads(last["summary_json"] or "{}")
        except (ValueError, TypeError):
            summ = {}
        last_run = {"runId": last["run_id"], "startedAt": last["started_at"], "finishedAt": last["finished_at"],
                    "trigger": last["trigger"], "durationMs": last["duration_ms"], "summary": summ}
    return {
        "schedulerRunning": _loop_task is not None and not _loop_task.done(),
        "auditInFlight": _run_lock.locked(),
        "intervalS": cfg["interval_s"], "autoRun": cfg["auto_run"],
        "domains": _domains_meta(cfg),
        "rowCount": n, "lastRun": last_run,
    }


@router.put("/config")
def update_config(body: ConfigUpdate):
    cfg = _load_config()
    if body.interval_s is not None:
        cfg["interval_s"] = max(300, int(body.interval_s))
    if body.auto_run is not None:
        cfg["auto_run"] = 1 if body.auto_run else 0
    if body.domain:
        if body.domain not in DOMAINS:
            raise HTTPException(400, f"Unknown domain {body.domain!r}")
        d = DOMAINS[body.domain]
        dc = cfg["domains"].setdefault(body.domain, _default_domain_cfg(d))
        if body.enabled is not None:
            dc["enabled"] = bool(body.enabled)
        if body.universe is not None:
            dc["universe"] = [str(e).strip().upper() for e in body.universe if str(e).strip()][:300]
        if body.enabled_sources is not None:
            dc["enabled_sources"] = [s for s in body.enabled_sources if s in d.sources]
        if body.variance_pct is not None:
            dc["variance_pct"] = float(body.variance_pct)
        if body.outlier_pct is not None:
            dc["outlier_pct"] = float(body.outlier_pct)
        if body.default_ttl_s is not None:
            dc["default_ttl_s"] = float(body.default_ttl_s)
        if body.source_ttl is not None:
            dc["source_ttl"] = {k: float(v) for k, v in body.source_ttl.items()}
    _save_config(cfg)
    return cfg


@router.post("/run")
def run_now(trigger: str = "manual", domain: str = ""):
    if domain and domain not in DOMAINS:
        raise HTTPException(400, f"Unknown domain {domain!r}")
    result = run_audit_once("manual" if trigger not in ("manual", "ingest", "cron") else trigger, domain or None)
    if result.get("busy"):
        raise HTTPException(409, "An audit run is already in progress")
    return result


@router.get("/results")
def results(domain: str = "", status: str = "all", source: str = "", metric: str = "", q: str = ""):
    with _db() as conn:
        rows = [_row_to_result(r) for r in conn.execute("SELECT * FROM audit_results ORDER BY domain, entity, metric").fetchall()]
    if domain:
        rows = [r for r in rows if r["domain"] == domain]
    st = (status or "all").lower()
    if st == "flagged":
        rows = [r for r in rows if r["status"] in ("conflict", "stale", "outlier")]
    elif st in ("conflict", "stale", "outlier", "ok", "error"):
        rows = [r for r in rows if r["status"] == st]
    if metric:
        rows = [r for r in rows if r["metric"] == metric]
    if source:
        rows = [r for r in rows if any(s.get("source") == source and s.get("value") is not None for s in r["sources"])]
    if q:
        ql = q.strip().lower()
        rows = [r for r in rows if ql in r["entity"].lower()]
    return {"rows": rows, "count": len(rows)}


@router.get("/entity/{domain}/{entity}/{metric}")
def entity_detail(domain: str, entity: str, metric: str):
    key = f"{domain}|{entity.strip().upper()}|{metric}"
    with _db() as conn:
        r = conn.execute("SELECT * FROM audit_results WHERE key = ?", (key,)).fetchone()
        if not r:
            raise HTTPException(404, "No audit result for that domain/entity/metric")
        res = _row_to_result(r)
        res["resolutions"] = [dict(x) for x in conn.execute(
            "SELECT * FROM audit_resolutions WHERE domain = ? AND entity = ? AND metric = ? ORDER BY ts DESC LIMIT 50",
            (r["domain"], r["entity"], r["metric"])).fetchall()]
    return res


@router.post("/resolve")
def resolve(body: ResolveBody):
    key = f"{body.domain}|{body.entity.strip().upper()}|{body.metric}"
    action = body.action.lower()
    if action not in ("override", "clear", "accept"):
        raise HTTPException(400, "action must be override, clear, or accept")
    with _db() as conn:
        r = conn.execute("SELECT * FROM audit_results WHERE key = ?", (key,)).fetchone()
        if not r:
            raise HTTPException(404, "No audit result for that domain/entity/metric")
        if action == "override":
            if not body.source:
                raise HTTPException(400, "override requires a source")
            valid = {s.get("source") for s in json.loads(r["sources_json"]) if s.get("value") is not None}
            if body.source not in valid:
                raise HTTPException(400, f"{body.source} has no value for this metric")
            conn.execute("UPDATE audit_results SET resolved_source=?, resolved_by=?, resolved_at=? WHERE key=?",
                         (body.source, "admin", time.time(), key))
        else:
            conn.execute("UPDATE audit_results SET resolved_source=NULL, resolved_by=?, resolved_at=? WHERE key=?",
                         ("admin" if action == "accept" else None, time.time() if action == "accept" else None, key))
        conn.execute(
            "INSERT INTO audit_resolutions (ts, domain, entity, metric, action, chosen_source, prior_status, note) VALUES (?,?,?,?,?,?,?,?)",
            (time.time(), r["domain"], r["entity"], r["metric"], action, body.source, r["status"], (body.note or "").strip() or None),
        )
        conn.commit()
        updated = _row_to_result(conn.execute("SELECT * FROM audit_results WHERE key = ?", (key,)).fetchone())
    return updated


@router.get("/history")
def history(limit: int = 100):
    with _db() as conn:
        rows = [dict(x) for x in conn.execute(
            "SELECT * FROM audit_resolutions ORDER BY ts DESC LIMIT ?", (max(1, min(limit, 500)),)).fetchall()]
    return {"rows": rows, "count": len(rows)}


@router.get("/runs")
def runs(limit: int = 30):
    with _db() as conn:
        out = []
        for x in conn.execute("SELECT * FROM audit_runs ORDER BY started_at DESC LIMIT ?", (max(1, min(limit, 200)),)).fetchall():
            d = dict(x)
            try:
                d["summary"] = json.loads(d.pop("summary_json") or "{}")
            except (ValueError, TypeError):
                d["summary"] = {}
            out.append(d)
    return {"rows": out, "count": len(out)}
