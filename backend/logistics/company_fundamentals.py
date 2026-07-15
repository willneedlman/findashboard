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
import re
import sqlite3


_DB_PATH = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", "data", "supply_chain.db"))

# When a bare symbol resolves to more than one listing, the (US-centric) Company
# Profile page wants the US listing. Lower rank wins.
_US_EXCHANGES = ("NASDAQ", "NYSE", "NYSEARCA", "NYSEAMERICAN", "AMEX", "BATS", "CBOE", "OTCMKTS")
_IDENTITY_NOISE = {
    "inc", "incorporated", "corp", "corporation", "company", "co", "ltd",
    "limited", "llc", "plc", "ag", "sa", "se", "nv", "holdings", "holding",
    "group", "the", "adr", "com", "usa", "us",
}


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


def _identity_key(name: str | None) -> str:
    tokens = re.sub(r"[^a-z0-9 ]", " ", (name or "").lower()).split()
    return "".join(token for token in tokens if token not in _IDENTITY_NOISE)


def _identity_matches(candidate: str | None, expected: str | None) -> bool:
    """Match issuer names after removing legal and listing noise."""
    if not expected:
        return True
    candidate_key = _identity_key(candidate)
    expected_key = _identity_key(expected)
    if not candidate_key or not expected_key:
        return False
    return candidate_key == expected_key


def _resolve(conn: sqlite3.Connection, symbol: str, expected_name: str | None = None):
    """Resolve a bare U.S. symbol without falling through to a foreign collision."""
    rows = conn.execute(
        "SELECT DISTINCT veridion_id, exchange FROM ticker_index WHERE symbol = ?",
        (symbol,),
    ).fetchall()
    if not rows:
        return None, None
    us_rows = [row for row in rows if _exchange_rank(row["exchange"]) < len(_US_EXCHANGES)]
    for best in sorted(us_rows, key=lambda row: _exchange_rank(row["exchange"])):
        company = conn.execute("SELECT * FROM companies WHERE veridion_id = ?", (best["veridion_id"],)).fetchone()
        if company is not None and _identity_matches(company["name"], expected_name):
            return company, best["exchange"]
    return None, None


# Overlap weights: a shared sourcing focus is the strongest supply-chain signal,
# then shared end-markets, then being in the same industry / category.
_W_FOCUS, _W_MARKET, _W_INDUSTRY, _W_CATEGORY = 3, 2, 3, 2


def peers_by_tags(ticker: str, limit: int = 24, expected_name: str | None = None) -> dict:
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
        base, exchange = _resolve(conn, symbol, expected_name)
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
    returned = [p for _, _, p in scored[:limit]]
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
        "returned": len(returned),
        "peers": returned,
    }


def query_customer_links(ticker: str) -> dict:
    """Return disclosed customer segment relationships for one ticker in two directions:
      - customers: companies the given ticker sells to (revenue concentration risk)
      - suppliers: companies that sell to the given ticker (downstream dependency risk)
    """
    symbol = (ticker or "").strip().upper()
    if not available() or not symbol:
        return {"ticker": symbol, "customers": [], "suppliers": []}

    with _conn() as conn:
        table_exists = conn.execute(
            "SELECT count(*) FROM sqlite_master WHERE type='table' AND name='customer_links'"
        ).fetchone()[0] > 0
        if not table_exists:
            return {"ticker": symbol, "customers": [], "suppliers": []}

        # 1. Customers of this company (supplier_ticker = symbol)
        cust_rows = conn.execute(
            "SELECT customer_ticker, customer_name, customer_sales, pct_of_revenue, fiscal_year "
            "FROM customer_links WHERE supplier_ticker = ? ORDER BY customer_sales DESC, pct_of_revenue DESC, fiscal_year DESC",
            (symbol,)
        ).fetchall()

        customers = [
            {
                "customer_ticker": r["customer_ticker"],
                "customer_name": r["customer_name"],
                "customer_sales": r["customer_sales"],
                "pct_of_revenue": r["pct_of_revenue"],
                "fiscal_year": r["fiscal_year"]
            }
            for r in cust_rows
        ]

        # 2. Suppliers to this company (customer_ticker = symbol)
        supp_rows = conn.execute(
            "SELECT supplier_ticker, customer_sales, pct_of_revenue, fiscal_year "
            "FROM customer_links WHERE customer_ticker = ? ORDER BY customer_sales DESC, pct_of_revenue DESC, fiscal_year DESC",
            (symbol,)
        ).fetchall()

        suppliers = []
        for r in supp_rows:
            sup_ticker = r["supplier_ticker"]
            sup_name = sup_ticker
            company_row = conn.execute(
                "SELECT name FROM companies WHERE veridion_id IN "
                "(SELECT DISTINCT veridion_id FROM ticker_index WHERE symbol = ?)",
                (sup_ticker,)
            ).fetchone()
            if company_row:
                sup_name = company_row["name"]

            suppliers.append({
                "supplier_ticker": sup_ticker,
                "supplier_name": sup_name,
                "customer_sales": r["customer_sales"],
                "pct_of_revenue": r["pct_of_revenue"],
                "fiscal_year": r["fiscal_year"]
            })

    return {
        "ticker": symbol,
        "customers": customers,
        "suppliers": suppliers
    }


def query_customer_edges(limit: int = 500) -> list[dict]:
    """Disclosed customer->supplier relationships where BOTH tickers resolve to
    a geocoded Veridion company, for the Freight Map's customer-link layer.
    One canonical location per ticker (MIN(veridion_id)) so a company with
    multiple Veridion facility records doesn't fan a single disclosed
    relationship out into duplicate edges."""
    if not available():
        return []
    with _conn() as conn:
        table_exists = conn.execute(
            "SELECT count(*) FROM sqlite_master WHERE type='table' AND name='customer_links'"
        ).fetchone()[0] > 0
        if not table_exists:
            return []
        # One edge per (supplier, customer) pair — customer_links carries one
        # row per disclosed fiscal year, and drawing every year as a separate
        # overlapping line would just clutter the map. Latest year wins.
        rows = conn.execute("""
            SELECT cl.supplier_ticker, cl.customer_ticker, cl.customer_name,
                   cl.customer_sales, cl.pct_of_revenue, cl.fiscal_year,
                   sc.name AS supplier_name, sc.latitude AS s_lat, sc.longitude AS s_lng,
                   cc.latitude AS c_lat, cc.longitude AS c_lng
            FROM customer_links cl
            JOIN (SELECT symbol, MIN(veridion_id) AS veridion_id FROM ticker_index GROUP BY symbol) sti
                ON sti.symbol = cl.supplier_ticker
            JOIN companies sc ON sc.veridion_id = sti.veridion_id
            JOIN (SELECT symbol, MIN(veridion_id) AS veridion_id FROM ticker_index GROUP BY symbol) cti
                ON cti.symbol = cl.customer_ticker
            JOIN companies cc ON cc.veridion_id = cti.veridion_id
            JOIN (
                SELECT supplier_ticker, customer_ticker, MAX(fiscal_year) AS fiscal_year
                FROM customer_links WHERE customer_ticker IS NOT NULL
                GROUP BY supplier_ticker, customer_ticker
            ) latest ON latest.supplier_ticker = cl.supplier_ticker
                    AND latest.customer_ticker = cl.customer_ticker
                    AND latest.fiscal_year = cl.fiscal_year
            WHERE cl.customer_ticker IS NOT NULL
              AND sc.latitude IS NOT NULL AND sc.longitude IS NOT NULL
              AND cc.latitude IS NOT NULL AND cc.longitude IS NOT NULL
            GROUP BY cl.supplier_ticker, cl.customer_ticker
            ORDER BY (cl.customer_sales IS NULL), cl.customer_sales DESC, cl.fiscal_year DESC
            LIMIT ?
        """, (limit,)).fetchall()
        return [
            {
                "supplier_ticker": r["supplier_ticker"], "supplier_name": r["supplier_name"],
                "supplier_lat": r["s_lat"], "supplier_lng": r["s_lng"],
                "customer_ticker": r["customer_ticker"], "customer_name": r["customer_name"],
                "customer_lat": r["c_lat"], "customer_lng": r["c_lng"],
                "customer_sales": r["customer_sales"], "pct_of_revenue": r["pct_of_revenue"],
                "fiscal_year": r["fiscal_year"],
            }
            for r in rows
        ]

