"""Read the bundled Veridion firmographics serving database (``supply_chain.db``).

Network access is deliberately confined to ``ingest_supply_chain``.  The request
path uses this read-only SQLite reader only, so the Company Profile page stays
responsive and a Dewey outage cannot take the API down.

The DB carries private-company fundamentals (revenue, headcount, founding year,
industry, HQ, offerings, sourcing/market tags) for companies that publish an
exchange ticker, keyed by a bare-and-qualified ticker index.
"""
from __future__ import annotations

import os
import sqlite3


_DB_PATH = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", "data", "supply_chain.db"))

# When a bare symbol resolves to more than one listing, the (US-centric) Company
# Profile page wants the US listing. Lower rank wins.
_US_EXCHANGES = ("NASDAQ", "NYSE", "NYSEARCA", "NYSEAMERICAN", "AMEX", "BATS", "CBOE", "OTCMKTS")


def available() -> bool:
    return os.path.isfile(_DB_PATH)


def _conn() -> sqlite3.Connection:
    conn = sqlite3.connect(f"file:{_DB_PATH}?mode=ro", uri=True)
    conn.row_factory = sqlite3.Row
    return conn


def _split(v) -> list:
    """"a; b; c" -> ["a", "b", "c"]; empty/None -> []."""
    if not v:
        return []
    return [p.strip() for p in str(v).split(";") if p.strip()]


def _exchange_rank(exchange: str | None) -> int:
    try:
        return _US_EXCHANGES.index((exchange or "").upper())
    except ValueError:
        return len(_US_EXCHANGES)


def _primary_symbol(exchange_tickers: list) -> str | None:
    """From ["NASDAQ:COKE", "FRA:CCU"] pick a bare symbol, preferring a US listing,
    so a peer row is clickable straight into its Company Profile."""
    best, best_rank = None, len(_US_EXCHANGES) + 1
    for full in exchange_tickers:
        exch, _, sym = full.partition(":")
        if not sym:
            exch, sym = "", exch
        rank = _exchange_rank(exch)
        if rank < best_rank:
            best, best_rank = (sym or None), rank
    return best.upper() if best else None


def _resolve(conn: sqlite3.Connection, symbol: str):
    """(company row, matched exchange) for a bare symbol, or (None, None)."""
    rows = conn.execute(
        "SELECT DISTINCT veridion_id, exchange FROM ticker_index WHERE symbol = ?",
        (symbol,),
    ).fetchall()
    if not rows:
        return None, None
    best = min(rows, key=lambda r: _exchange_rank(r["exchange"]))
    c = conn.execute("SELECT * FROM companies WHERE veridion_id = ?", (best["veridion_id"],)).fetchone()
    return c, best["exchange"]


# Overlap weights: a shared sourcing focus is the strongest supply-chain signal,
# then shared end-markets, then being in the same industry / category.
_W_FOCUS, _W_MARKET, _W_INDUSTRY, _W_CATEGORY = 3, 2, 3, 2


def peers_by_tags(ticker: str, limit: int = 24) -> dict:
    """Rank the tickered universe by firmographic overlap with one name.

    Companies are scored on shared supply-chain-focus and target-market tags plus
    same industry / business category, so the result reads as a supply-chain peer
    and counterparty set rather than a price-correlation peer group. Runs entirely
    against the bundled read-only DB (no network).
    """
    if not available():
        return {"available": False, "matched": False, "ticker": ticker}
    symbol = (ticker or "").strip().upper()
    if not symbol:
        return {"available": True, "matched": False, "ticker": ticker}

    with _conn() as conn:
        base, exchange = _resolve(conn, symbol)
        if base is None:
            return {"available": True, "matched": False, "ticker": symbol}

        base_vid = base["veridion_id"]
        base_industry = base["main_industry"]
        base_category = base["business_category"]
        base_focus = set(_split(base["supply_chain_focus"]))
        base_markets = set(_split(base["target_markets"]))

        rows = conn.execute(
            "SELECT veridion_id, name, exchange_tickers, main_industry, business_category, "
            "country, city, revenue, revenue_type, employees, year_founded, description, "
            "core_offerings, supply_chain_focus, target_markets FROM companies"
        ).fetchall()

    scored = []
    for r in rows:
        if r["veridion_id"] == base_vid:
            continue
        shared_focus = sorted(base_focus & set(_split(r["supply_chain_focus"])))
        shared_markets = sorted(base_markets & set(_split(r["target_markets"])))
        same_industry = bool(r["main_industry"]) and r["main_industry"] == base_industry
        same_category = bool(r["business_category"]) and r["business_category"] == base_category
        score = (len(shared_focus) * _W_FOCUS + len(shared_markets) * _W_MARKET
                 + (_W_INDUSTRY if same_industry else 0) + (_W_CATEGORY if same_category else 0))
        if score <= 0:
            continue
        scored.append((score, r["revenue"] or 0, {
            "symbol": _primary_symbol(_split(r["exchange_tickers"])),
            "name": r["name"],
            "exchange_tickers": _split(r["exchange_tickers"]),
            "industry": r["main_industry"],
            "business_category": r["business_category"],
            "country": r["country"],
            "city": r["city"],
            "revenue": r["revenue"],
            "revenue_type": r["revenue_type"],
            "employees": r["employees"],
            "year_founded": r["year_founded"],
            "brief": r["description"],
            "core_offerings": _split(r["core_offerings"]),
            "supply_chain_focus": _split(r["supply_chain_focus"]),
            "target_markets": _split(r["target_markets"]),
            "score": score,
            "shared_focus": shared_focus,
            "shared_markets": shared_markets,
            "same_industry": same_industry,
            "same_category": same_category,
        }))

    scored.sort(key=lambda t: (-t[0], -t[1]))
    return {
        "available": True,
        "matched": True,
        "source": "Veridion",
        "ticker": symbol,
        "base": {
            "name": base["name"],
            "exchange": exchange,
            "industry": base_industry,
            "business_category": base_category,
            "country": base["country"],
            "city": base["city"],
            "revenue": base["revenue"],
            "revenue_type": base["revenue_type"],
            "employees": base["employees"],
            "year_founded": base["year_founded"],
            "brief": base["description"],
            "core_offerings": _split(base["core_offerings"]),
            "supply_chain_focus": sorted(base_focus),
            "target_markets": sorted(base_markets),
        },
        "count": len(scored),
        "peers": [p for _, _, p in scored[:limit]],
    }
