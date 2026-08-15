import logging
import os, re, sys
import requests
from fastapi import APIRouter, HTTPException
import yfinance as yf

sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))
from cache import get_history, get_info, cached
import corporate_db
import market_cap as market_cap_lib
try:
    import fmp
except ImportError:                                   # pragma: no cover
    fmp = None
try:
    from disk_cache import disk_get, disk_set
except ImportError:                                   # pragma: no cover
    def disk_get(_k): return None
    def disk_set(_k, _v, ttl=0): pass

router = APIRouter()
logger = logging.getLogger("backend.routers.corporate")

_SEC_UA = {"User-Agent": "Alphatape Research admin@alphatape.app"}
_COMPANY_INDEX: "list[tuple[str, str]] | None" = None


def _company_index() -> "list[tuple[str, str]]":
    """SEC's full ticker -> company-name index, fetched once and cached in-process."""
    global _COMPANY_INDEX
    if _COMPANY_INDEX:
        return _COMPANY_INDEX
    try:
        data = requests.get("https://www.sec.gov/files/company_tickers.json",
                            headers=_SEC_UA, timeout=15).json()
        idx = [(str(r["ticker"]).upper(), str(r["title"])) for r in data.values()]
        if idx:                       # only cache a good fetch; retry next call otherwise
            _COMPANY_INDEX = idx
        return idx
    except Exception as e:
        logger.warning("company index load failed: %s", e)
        return []


def _pretty_company(name: str) -> str:
    return name.title().replace("'S", "'s")


def _sec_company_name(ticker: str) -> str | None:
    symbol = ticker.strip().upper()
    return next((title for listed, title in _company_index() if listed == symbol), None)


# Yahoo exchange codes that are US-listed (incl. OTC ADRs) — used to rank a US
# ADR above the foreign primary so e.g. "nestle" resolves to NSRGY, not NESN.SW.
_YH_US_EX = {"NYQ", "NMS", "NGM", "NCM", "NYE", "ASE", "PCX", "BTS", "BATS",
             "PNK", "OID", "OEM", "OQB", "OQX", "OBB", "OTC"}
# Instrument types we surface as alertable symbols: stocks, futures, indices.
_YH_TYPES = {"EQUITY", "FUTURE", "INDEX"}

_CO_SUFFIX = re.compile(r"\b(incorporated|inc|corporation|corp|company|co|ltd|limited|plc|sa|nv|ag|se|holdings?|group|the|adr)\b")
def _norm_company(name: str) -> str:
    """Collapse a company name to a comparison key so a US line and its foreign
    listings (NVIDIA Corp / NVIDIA) dedupe to one entry."""
    n = re.sub(r"[^a-z0-9 ]", " ", name.lower())
    n = _CO_SUFFIX.sub(" ", n)
    return re.sub(r"\s+", " ", n).strip()

def _yahoo_search(q: str) -> list:
    """Free Yahoo Finance symbol search — global coverage (foreign primaries and
    ADRs), and exactly the tickers yfinance can load on the profile. US listings
    are ranked first so an ADR wins over the foreign line. Cached on disk."""
    ql = q.strip()
    if len(ql) < 2:
        return []
    ck = f"yahsearch:v1:{ql.lower()}"
    cached = disk_get(ck)
    if cached is not None:
        return cached
    try:
        r = requests.get(
            "https://query2.finance.yahoo.com/v1/finance/search",
            params={"q": ql, "quotesCount": 10, "newsCount": 0, "enableFuzzyQuery": "false"},
            headers={"User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36"},
            timeout=8,
        )
        r.raise_for_status()
        quotes = [x for x in r.json().get("quotes", []) if x.get("quoteType") in _YH_TYPES and x.get("symbol")]
        quotes.sort(key=lambda x: 0 if str(x.get("exchange", "")).upper() in _YH_US_EX else 1)
        out, seen = [], set()
        for x in quotes:
            sym = str(x["symbol"]).upper()
            if sym in seen:
                continue
            seen.add(sym)
            out.append({"ticker": sym, "name": str(x.get("longname") or x.get("shortname") or sym)})
            if len(out) >= 8:
                break
    except Exception as e:
        logger.warning("yahoo search failed for %s: %s", ql, e)
        return []          # don't cache transient failures
    disk_set(ck, out, ttl=21600)   # 6 h
    return out


@router.get("/search")
def company_search(q: str):
    """Resolve a company name or ticker prefix to candidate tickers (free SEC index)."""
    ql = q.strip().lower()
    if len(ql) < 2:
        return {"results": []}
    fund_words = ("trust", "fund", " etf", "portfolio", "muni")
    scored = []
    for ticker, title in _company_index():
        tl, nl = ticker.lower(), title.lower()
        if tl == ql:
            score = 0
        elif nl.startswith(ql):
            score = 1
        elif tl.startswith(ql):
            score = 2
        elif ql in nl:
            score = 3
        else:
            continue
        # Within a match tier, surface the operating company above same-named funds/CEFs.
        is_fund = 1 if any(w in nl for w in fund_words) else 0
        scored.append((score, is_fund, len(title), ticker, title))
    scored.sort()
    results = [{"ticker": tk, "name": _pretty_company(title)} for _, _, _, tk, title in scored[:8]]

    # International + ADR/OTC coverage: the SEC index is US-only. Supplement with
    # Yahoo's free global search (also exactly what yfinance can load on the
    # profile), then FMP for any OTC ADRs still missing. Both cached so quotas /
    # rate limits are barely touched.
    if len(results) < 6 and len(ql) >= 2:
        have = {r["ticker"] for r in results}
        for h in _yahoo_search(q.strip()):
            if h["ticker"] not in have:
                results.append(h)
                have.add(h["ticker"])
        if len(results) < 5 and len(ql) >= 3:
            try:
                import fmp as _fmp
                if _fmp.available():
                    ck = f"fmpsearch:v2:{ql}"
                    hits = disk_get(ck)
                    if hits is None:
                        hits = _fmp.search_symbols(q.strip(), limit=8)
                        disk_set(ck, hits, ttl=21600)        # 6 h
                    for h in hits:
                        if h["ticker"] not in have:
                            results.append(h)
                            have.add(h["ticker"])
            except Exception as e:
                logger.warning("fmp search supplement failed: %s", e)

    # One listing per company: when a primary US (non-suffixed) symbol is present,
    # drop the foreign-exchange duplicates (e.g. NVDA keeps NVDA, not NVDA.TO /
    # NVD.DE); then dedupe whatever remains by normalized company name. Futures
    # (ES=F) and indices carry no "." suffix, so they're never dropped here.
    if any("." not in r["ticker"] for r in results):
        results = [r for r in results if "." not in r["ticker"]]
    seen: set = set()
    deduped = []
    for r in results:
        key = _norm_company(r["name"])
        if key and key in seen:
            continue
        seen.add(key)
        deduped.append(r)

    return {"results": deduped[:8]}

# Hardcoded institutional peer groups for relative valuation fallbacks
PEER_GROUPS = {
    "TECH": ["AAPL", "MSFT", "NVDA", "AVGO", "AMD", "INTC", "QCOM"],
    "COMM": ["GOOGL", "META", "NFLX", "TMUS", "DIS", "CHTR"],
    "CONS": ["AMZN", "TSLA", "WMT", "HD", "COST", "TGT"],
    "MONEY_CENTER_BANKS": ["JPM", "BAC", "WFC", "C", "USB", "PNC"],
    "REGIONAL_BANKS": ["HBAN", "KEY", "RF", "FITB", "CFG", "MTB", "PNC", "USB"],
    "FIN": ["JPM", "BAC", "MS", "GS", "WFC", "C"],
}

def _get_peers_for_ticker(ticker: str, sector: str) -> list:
    """Comparable companies for relative comps.

    Curated cohorts win for businesses where broad vendor classifications are
    predictably noisy (especially banks). Other names use FMP/Finnhub peers and
    the broad sector groups remain the final fallback.
    """
    sym = ticker.strip().upper()

    for cohort in ("MONEY_CENTER_BANKS", "REGIONAL_BANKS"):
        if sym in PEER_GROUPS[cohort]:
            return [peer for peer in PEER_GROUPS[cohort] if peer != sym]

    try:
        import fmp as _fmp
        if _fmp.available():
            fmp_peers = [p for p in _fmp.get_stock_peers(sym, limit=8) if p != sym]
            if fmp_peers:
                return fmp_peers
    except Exception:
        pass

    if sym in ["NVDA", "AMD", "INTC", "AVGO", "QCOM", "MSFT", "AAPL"]:
        return [p for p in PEER_GROUPS["TECH"] if p != sym]
    if sym in ["GOOGL", "META", "NFLX"]:
        return [p for p in PEER_GROUPS["COMM"] if p != sym]
    if sym in ["AMZN", "TSLA", "WMT", "HD"]:
        return [p for p in PEER_GROUPS["CONS"] if p != sym]
    if sym in ["MS", "GS"]:
        return [p for p in PEER_GROUPS["FIN"] if p != sym]
    
    # Generic sector fallback map if explicit ticker match isn't found
    sec_lower = (sector or "").lower()
    if "tech" in sec_lower: return [p for p in PEER_GROUPS["TECH"] if p != sym]
    if "comm" in sec_lower: return [p for p in PEER_GROUPS["COMM"] if p != sym]
    if "financial" in sec_lower: return [p for p in PEER_GROUPS["FIN"] if p != sym]
    return [p for p in PEER_GROUPS["CONS"] if p != sym]

def safe_float(d, keys, default=None):
    """Defensive helper to safely capture and cast numerical properties."""
    if not d or not isinstance(d, dict):
        return default
    for k in keys:
        val = d.get(k)
        if val is not None and val != "":
            try:
                return float(val)
            except (ValueError, TypeError):
                continue
    return default


def _extract_news(stock) -> list:
    """Pulls up to 10 news items from yfinance, handling both old and new payload shapes."""
    items = []
    try:
        for item in (stock.news or [])[:10]:
            try:
                content = item.get("content") or {}
                title = content.get("title") or item.get("title") or ""
                link  = (content.get("canonicalUrl") or {}).get("url") or item.get("link") or ""
                pub   = (content.get("provider") or {}).get("displayName") or item.get("publisher") or ""
                date  = content.get("pubDate") or str(item.get("providerPublishTime") or "")
                if title:
                    items.append({"title": title, "link": link, "publisher": pub, "pubDate": date})
            except Exception:
                continue
    except Exception:
        pass
    return items


def _extract_earnings_date(stock) -> tuple:
    """Returns (date_str, horizon_str) for the next earnings date, or (None, None)."""
    try:
        cal = stock.calendar
        dates = []
        if isinstance(cal, dict):
            dates = cal.get("Earnings Date") or []
        elif hasattr(cal, "loc"):
            try:
                row = cal.loc["Earnings Date"]
                dates = list(row) if hasattr(row, "__iter__") else [row]
            except Exception:
                pass
        if not dates:
            return None, None
        dt = dates[0]
        if hasattr(dt, "strftime"):
            date_str = dt.strftime("%Y-%m-%d")
        else:
            date_str = str(dt)[:10]
        # derive quarter label
        from datetime import datetime
        parsed = datetime.strptime(date_str, "%Y-%m-%d")
        q = (parsed.month - 1) // 3 + 1
        return date_str, f"Q{q}'{str(parsed.year)[2:]}"
    except Exception:
        return None, None


def _consensus_label(info: dict):
    """Map yfinance analyst recommendation to the UI's consensus labels."""
    key = (info.get("recommendationKey") or "").lower()
    mapping = {
        "strong_buy": "Strong Buy",
        "buy": "Moderate Buy",
        "hold": "Hold",
        "underperform": "Underperform",
        "sell": "Underperform",
        "strong_sell": "Underperform",
    }
    if key in mapping:
        return mapping[key]
    try:
        m = float(info.get("recommendationMean"))
    except (TypeError, ValueError):
        return None
    if m <= 1.5:
        return "Strong Buy"
    if m <= 2.5:
        return "Moderate Buy"
    if m <= 3.5:
        return "Hold"
    return "Underperform"


@router.get("/hub")
def get_corporate_hub(ticker: str):
    """Fetches fundamental financial data or ETF asset structures resiliently with nested metric safeties."""
    try:
        symbol = ticker.strip().upper()
        stock = yf.Ticker(symbol)

        try:
            info = get_info(symbol)
        except Exception as info_err:
            logger.error(f"Error fetching info for symbol {symbol}: {info_err}")
            info = None

        if info is None or not isinstance(info, dict):
            info = {}

        is_etf = info.get("quoteType") == "ETF" or "longBusinessSummary" not in info
        
        t_mcap = safe_float(info, ["marketCap", "totalAssets"])
        t_pe = safe_float(info, ["trailingPE", "forwardPE"])
        t_fpe = safe_float(info, ["forwardPE", "forwardPe"]) or t_pe
        t_ev_rev = safe_float(info, ["enterpriseToRevenue"])
        t_ev_ebitda = safe_float(info, ["enterpriseToEbitda"])
        t_price = safe_float(info, ["currentPrice", "navPrice", "previousClose"])
        t_ps = safe_float(info, ["priceToSalesTrailing12Months", "priceToSales"])
        t_pb = safe_float(info, ["priceToBook"])
        t_peg = safe_float(info, ["pegRatio"])
        t_div = safe_float(info, ["dividendYield", "yield"])

        # 1-day % change: prefer regularMarketChangePercent, else compute from prev close
        t_prev = safe_float(info, ["regularMarketPreviousClose", "previousClose"])
        if info.get("regularMarketChangePercent") is not None:
            try:
                t_pct_1d = round(float(info["regularMarketChangePercent"]), 3)
            except Exception:
                t_pct_1d = round((t_price - t_prev) / t_prev * 100, 3) if (t_price is not None and t_prev) else None
        elif t_price is not None and t_prev and t_prev > 0:
            t_pct_1d = round((t_price - t_prev) / t_prev * 100, 3)
        else:
            t_pct_1d = None

        earnings_date, earnings_horizon = _extract_earnings_date(stock)
        news_items = _extract_news(stock)

        # 30-day closing price sparkline
        sparkline = []
        try:
            hist = get_history(symbol, period="1mo")
            if hist is not None and not hist.empty and "Close" in hist.columns:
                closes = hist["Close"].dropna().tolist()
                sparkline = [round(float(v), 2) for v in closes]
        except Exception:
            pass

        payload = {
            "ticker": symbol,
            "company_name": info.get("longName") or info.get("shortName") or symbol,
            "summary": info.get("longBusinessSummary") or info.get("description") or f"Index asset tracking and historical analysis profile for {symbol}.",
            "sector": info.get("sector") or ("Exchange-Traded Fund" if is_etf else "N/A"),
            "industry": info.get("industry") or ("Index Tracking" if is_etf else "N/A"),
            "market_cap": t_mcap,
            "pe_ratio": t_pe,
            "estimated_pe": t_pe,
            "forward_pe": t_fpe,
            "dividend_yield": t_div,
            "fifty_two_week_high": safe_float(info, ["fiftyTwoWeekHigh"]),
            "fifty_two_week_low": safe_float(info, ["fiftyTwoWeekLow"]),
            "current_price": t_price,
            "spot": t_price,
            "open": safe_float(info, ["open", "regularMarketOpen"], None),
            "previous_close": t_prev or None,
            "day_high": safe_float(info, ["dayHigh", "regularMarketDayHigh"], None),
            "day_low": safe_float(info, ["dayLow", "regularMarketDayLow"], None),
            "volume": safe_float(info, ["volume", "regularMarketVolume"], None),
            "avg_volume": safe_float(info, ["averageVolume", "averageDailyVolume10Day", "averageDailyVolume3Month"], None),
            "beta": safe_float(info, ["beta", "beta3Year"], None),
            "exchange": info.get("exchange") or info.get("fullExchangeName") or None,
            "price_to_sales": t_ps,
            "ev_to_revenue": t_ev_rev,
            "ev_ebitda": t_ev_ebitda,
            "peg_ratio": t_peg,
            "pct_change_1d": t_pct_1d,
            "implied_move": None,
            "consensus": _consensus_label(info),
            "date": earnings_date,
            "horizon": earnings_horizon,
            "news": news_items,
            "sparkline": sparkline,
        }

        nested_metrics = {
            "market_cap": t_mcap, "marketCap": t_mcap, "mcap": t_mcap, "marketcap": t_mcap,
            "price": t_price, "current_price": t_price, "currentPrice": t_price, "close": t_price, "lastPrice": t_price,
            "pe_ratio": t_pe, "peRatio": t_pe, "pe": t_pe, "price_to_earnings": t_pe, "trailing_pe": t_pe, "trailingPe": t_pe, "trailingPE": t_pe,
            "forward_pe": t_fpe, "forwardPe": t_fpe, "forwardPE": t_fpe, "fwd_pe": t_fpe, "fwdPe": t_fpe,
            "ev_to_revenue": t_ev_rev, "evToRevenue": t_ev_rev, "ev_revenue": t_ev_rev, "evRevenue": t_ev_rev, "ev_to_sales": t_ev_rev, "evToSales": t_ev_rev,
            "price_to_sales": t_ps, "priceToSales": t_ps, "ps_ratio": t_ps, "psRatio": t_ps, "ps": t_ps,
            "price_to_book": t_pb, "priceToBook": t_pb, "pb_ratio": t_pb, "pbRatio": t_pb, "pb": t_pb,
            "peg_ratio": t_peg, "pegRatio": t_peg, "dividend_yield": t_div, "dividendYield": t_div, "yield": t_div
        }
        
        payload["metrics"] = nested_metrics
        payload["fundamentals"] = nested_metrics
        payload["stats"] = nested_metrics
        
        return payload
    except Exception as e:
        logger.error(f"Error in corporate hub master block: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/hub/short")
def get_corporate_hub_short(ticker: str):
    """Returns short interest data for a ticker."""
    try:
        symbol = ticker.strip().upper()
        try:
            info = get_info(symbol)
        except Exception:
            info = {}

        short_pct = info.get("shortPercentOfFloat") or info.get("shortPercent")
        short_ratio = info.get("shortRatio")
        shares_short = info.get("sharesShort")
        shares_short_prior = info.get("sharesShortPriorMonth")

        return {
            "ticker": symbol,
            "shortPercentOfFloat": short_pct,
            "shortRatio": short_ratio,
            "sharesShort": shares_short,
            "sharesShortPriorMonth": shares_short_prior,
        }
    except Exception as e:
        logger.error(f"Error fetching short interest for {ticker}: {e}")
        raise HTTPException(status_code=500, detail=str(e))


def _tx_side(t: str) -> str:
    """Normalize yfinance's free-text transaction strings to one side so every
    consumer classifies filings identically. Grants/awards/exercises are
    'neutral' — they are not conviction buys."""
    tl = t.lower()
    if any(w in tl for w in ("sale", "sell", "sold", "disposi")):
        return "sell"
    if any(w in tl for w in ("purchase", "buy", "bought")):
        return "buy"
    return "neutral"


@router.get("/hub/implied")
def get_corporate_hub_implied(tickers: str):
    """Options-implied move into the next report for a batch of tickers, from
    the ATM straddle spanning the earnings date. Reuses the earnings router's
    disk-cached helpers; worker pool stays at 2 for yfinance headroom."""
    from concurrent.futures import ThreadPoolExecutor
    from routers.earnings import _implied_move, _prior_report

    syms = [t.strip().upper() for t in tickers.split(",") if t.strip()][:20]

    def one(sym: str):
        try:
            im = _implied_move(sym, _prior_report(sym).get("nextDate"))
            return sym, im.get("pct")
        except Exception as e:
            logger.warning(f"implied move failed for {sym}: {e}")
            return sym, None

    with ThreadPoolExecutor(max_workers=2) as pool:
        return {"implied": dict(pool.map(one, syms))}


@cached(ttl=43200, persist=True)
def _lseg_insider_data(symbol: str):
    """Raw LSEG insider transactions + returns + ownership rollup for a ticker,
    or None when the ticker has no LSEG coverage at all. This is build-time ETL
    output (refreshed on a schedule, not per-request), so it's cached the same
    way the yfinance fallback below caches its own quarterly data. A ticker can
    have rollup data with zero transactions (or vice versa), so "covered" means
    either is present — not just transactions."""
    tx_rows = corporate_db.query(
        "SELECT * FROM lseg_insider_transactions WHERE ticker = ? ORDER BY date DESC LIMIT 20", (symbol,)
    )
    ret_rows = corporate_db.query("SELECT * FROM lseg_insider_returns WHERE ticker = ?", (symbol,))
    rollup = corporate_db.query_one("SELECT * FROM lseg_ownership_rollup WHERE ticker = ?", (symbol,))
    if not tx_rows and not rollup:
        return None
    return {
        "transactions": [dict(r) for r in tx_rows],
        "returns": [dict(r) for r in ret_rows],
        "rollup": dict(rollup) if rollup else None,
    }


@router.get("/hub/insider")
def get_corporate_hub_insider(ticker: str):
    """Returns recent insider transactions for a ticker, using LSEG tables with yfinance fallback."""
    try:
        symbol = ticker.strip().upper()

        lseg = _lseg_insider_data(symbol)
        if lseg:
            transactions = []
            for r in lseg["transactions"]:
                cls = r["txn_classification"] or ""
                transactions.append({
                    "date": r["date"],
                    "insider": r["insider_name"],
                    "title": r["title"],
                    "transaction": cls,
                    "side": "sell" if "Sell" in cls or "Filing" in cls or "Form 144" in cls else ("buy" if "Buy" in cls or "Acquisition" in cls else "neutral"),
                    "shares": r["shares"],
                    "value": r["value"],
                    "is_amendment": r["is_amendment"],
                    "is_form144": r["is_form144"],
                    "is_10b51": r["is_10b51"]
                })
            avg_returns = [
                {
                    "txn_type": r["txn_type"],
                    "avg_return_3m": r["avg_return_3m"],
                    "avg_return_6m": r["avg_return_6m"],
                    "avg_return_12m": r["avg_return_12m"],
                }
                for r in lseg["returns"]
            ]
            rollup = lseg["rollup"] or {}
            passive_pct = rollup.get("passive_pct")
            active_pct = rollup.get("active_pct")
            insider_pct = rollup.get("insider_pct")
            held_pct_inst = (passive_pct + active_pct) / 100.0 if (passive_pct is not None and active_pct is not None) else None
            held_pct_ins = insider_pct / 100.0 if insider_pct is not None else None
            return {
                "ticker": symbol,
                "transactions": transactions,
                "held_pct_institutions": held_pct_inst,
                "held_pct_insiders": held_pct_ins,
                "passive_pct": passive_pct,
                "active_pct": active_pct,
                "average_returns": avg_returns,
                "source": "LSEG"
            }

        # Fallback to yfinance if not covered by LSEG
        stock = yf.Ticker(symbol)
        transactions = []
        try:
            df = stock.insider_transactions
            if df is not None and not df.empty:
                df = df.head(20)
                for _, row in df.iterrows():
                    shares = row.get("Shares") or row.get("shares")
                    value = row.get("Value") or row.get("value") or row.get("Value (USD)")
                    date_val = row.get("Start Date") or row.get("startDate") or row.get("Date") or row.get("date")
                    insider = row.get("Insider") or row.get("insider") or row.get("Name") or "Unknown"
                    title = row.get("Position") or row.get("position") or row.get("Title") or ""
                    txn_type = row.get("Transaction") or row.get("transaction") or row.get("Type") or ""
                    transactions.append({
                        "date": str(date_val)[:10] if date_val else "—",
                        "insider": str(insider),
                        "title": str(title),
                        "transaction": str(txn_type),
                        "side": _tx_side(str(txn_type)),
                        "shares": int(shares) if shares and not (isinstance(shares, float) and shares != shares) else 0,
                        "value": float(value) if value and not (isinstance(value, float) and value != value) else 0,
                    })
        except Exception as e:
            logger.warning(f"Could not fetch insider transactions for {symbol}: {e}")

        inst_pct = insider_pct = None
        try:
            info = get_info(symbol)
            if isinstance(info, dict):
                inst_pct = info.get("heldPercentInstitutions")
                insider_pct = info.get("heldPercentInsiders")
        except Exception:
            pass

        return {
            "ticker": symbol,
            "transactions": transactions,
            "held_pct_institutions": round(float(inst_pct), 4) if isinstance(inst_pct, (int, float)) else None,
            "held_pct_insiders": round(float(insider_pct), 4) if isinstance(insider_pct, (int, float)) else None,
            "source": "yfinance"
        }
    except Exception as e:
        logger.error(f"Error fetching insider data for {ticker}: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/hub/earnings-detail")
def get_corporate_hub_earnings_detail(ticker: str):
    """Expanded-card earnings detail: next-report EPS/revenue estimates, prior-year
    EPS, historical post-report reaction stats, and report timing. Loaded lazily
    when a card expands; cached hard since these move at most daily."""
    import pandas as pd

    sym = ticker.strip().upper()
    ck = f"earndetail:v1:{sym}"
    cached = disk_get(ck)
    if cached is not None:
        return cached

    stock = yf.Ticker(sym)

    eps_est = rev_est = None
    try:
        cal = stock.calendar
        if isinstance(cal, dict):
            eps_est = cal.get("Earnings Average")
            rev_est = cal.get("Revenue Average")
    except Exception as e:
        logger.warning(f"calendar estimates failed for {sym}: {e}")

    timing = eps_prior = beat_rate = None
    past_events: list = []
    try:
        df = stock.get_earnings_dates(limit=12)
        if df is not None and not df.empty:
            now = pd.Timestamp.now(tz=df.index.tz)
            future = df[df.index > now]
            past = df[df.index <= now].sort_index(ascending=False)
            if not future.empty:
                hour = future.index.min().hour
                timing = "Before Open" if hour <= 10 else "After Close" if hour >= 15 else None
            if "Reported EPS" in past.columns:
                # Match the prior-year quarter by date, not by position: dropna can
                # skip quarters and silently shift a positional lookback.
                reported = past["Reported EPS"].dropna()
                if not reported.empty:
                    anchor_ts = future.index.min() if not future.empty else now
                    diffs = abs(reported.index - (anchor_ts - pd.DateOffset(years=1)))
                    i = int(diffs.argmin())
                    if diffs[i] <= pd.Timedelta(days=60):
                        eps_prior = round(float(reported.iloc[i]), 2)
            if "Surprise(%)" in past.columns:
                surp = past["Surprise(%)"].dropna().head(8)
                if len(surp) >= 2:
                    beat_rate = round(float((surp > 0).mean() * 100))
            past_events = [(ts.date(), ts.hour) for ts in past.index[:8]]
    except Exception as e:
        logger.warning(f"earnings dates failed for {sym}: {e}")

    hist_move = None
    if past_events:
        try:
            hist = get_history(sym, period="2y")
            if hist is not None and not hist.empty and "Close" in hist.columns:
                closes = hist["Close"].dropna()
                if getattr(closes.index, "tz", None) is not None:
                    closes.index = closes.index.tz_localize(None)
                reactions = []
                for rd, hour in past_events:
                    anchor = pd.Timestamp(rd)
                    # The report-day close is pre-print for AMC reporters and
                    # post-print for BMO; include it on the right side so the
                    # reaction spans one session, not two.
                    if hour >= 15:
                        before = closes[closes.index <= anchor]
                        after = closes[closes.index > anchor]
                    elif hour <= 10:
                        before = closes[closes.index < anchor]
                        after = closes[closes.index >= anchor]
                    else:
                        before = closes[closes.index < anchor]
                        after = closes[closes.index > anchor]
                    if not before.empty and not after.empty and before.iloc[-1]:
                        reactions.append(abs(after.iloc[0] / before.iloc[-1] - 1) * 100)
                if reactions:
                    hist_move = round(sum(reactions) / len(reactions), 1)
        except Exception as e:
            logger.warning(f"reaction history failed for {sym}: {e}")

    def _num(v):
        try:
            f = float(v)
            return None if f != f else f
        except (TypeError, ValueError):
            return None

    out = {
        "ticker": sym,
        "reportTiming": timing,
        "epsEst": _num(eps_est),
        "epsPriorYear": eps_prior,
        "revEst": _num(rev_est),
        "histAvgMovePct": hist_move,
        "beatRatePct": beat_rate,
    }
    disk_set(ck, out, ttl=43200)   # 12h
    return out


@router.get("/hub/estimates")
def get_corporate_hub_estimates(ticker: str):
    """Where consensus has been moving: EPS drift against 7/30/60/90 days ago,
    revision breadth, and recent price-target raises and cuts."""
    import estimates as _estimates
    return _estimates.revisions(ticker)


@router.get("/hub/analyst")
def get_corporate_hub_analyst(ticker: str):
    """Analyst consensus: rating distribution, mean/high/low targets, implied upside."""
    try:
        symbol = ticker.strip().upper()
        stock = yf.Ticker(symbol)
        dist = {"strongBuy": 0, "buy": 0, "hold": 0, "sell": 0, "strongSell": 0}
        try:
            summary = stock.recommendations_summary
            if summary is not None and not summary.empty:
                row = summary.iloc[0]
                for k in dist:
                    dist[k] = int(row.get(k, 0) or 0)
        except Exception as e:
            logger.warning(f"recommendations_summary failed for {symbol}: {e}")

        info = {}
        try:
            info = get_info(symbol) or {}
        except Exception:
            pass

        def _f(v):
            try:
                return round(float(v), 2) if v is not None else None
            except (TypeError, ValueError):
                return None

        total = sum(dist.values())
        mean_target = _f(info.get("targetMeanPrice"))
        price = _f(info.get("currentPrice") or info.get("regularMarketPrice") or info.get("previousClose"))
        implied_upside = round((mean_target / price - 1) * 100, 1) if mean_target and price and price > 0 else None
        rec_mean = _f(info.get("recommendationMean"))

        return {
            "ticker": symbol,
            "distribution": dist,
            "total_analysts": info.get("numberOfAnalystOpinions") or (total or None),
            "recommendation_key": info.get("recommendationKey"),
            "recommendation_mean": rec_mean,
            "target_mean": mean_target,
            "target_high": _f(info.get("targetHighPrice")),
            "target_low": _f(info.get("targetLowPrice")),
            "price": price,
            "implied_upside": implied_upside,
        }
    except Exception as e:
        logger.error(f"Error fetching analyst data for {ticker}: {e}")
        raise HTTPException(status_code=500, detail=str(e))


# ── Credit quality (synthetic, model-based — NOT an agency rating) ────────────
# Damodaran interest-coverage → synthetic rating → default spread (large-cap
# table). Spreads drift year to year; ratings map is stable. Public methodology.
_SYNTH_RATING = [
    (8.50, "AAA", 0.59), (6.50, "AA", 0.78), (5.50, "A+", 0.98), (4.25, "A", 1.08),
    (3.00, "A-", 1.22), (2.50, "BBB", 1.56), (2.25, "BB+", 2.00), (2.00, "BB", 2.40),
    (1.75, "B+", 3.51), (1.50, "B", 4.21), (1.25, "B-", 5.15), (0.80, "CCC", 8.20),
    (0.65, "CC", 8.64), (0.20, "C", 11.34), (-1e9, "D", 15.12),
]


def _synthetic_rating(cov):
    if cov is None:
        return None, None
    for lo, rating, spread in _SYNTH_RATING:
        if cov >= lo:
            return rating, spread
    return "D", 15.12


# Backup rating scale keyed on gross leverage (total debt / EBITDA) for names
# where interest expense is not broken out. Thresholds track how agencies weight
# leverage: no / very low leverage → high grade, >6x → deep sub-IG.
_LEV_RATING = [
    (0.0, "AA", 0.78), (1.0, "A", 1.08), (2.0, "BBB", 1.56), (3.0, "BB+", 2.00),
    (4.0, "BB", 2.40), (5.0, "B", 4.21), (6.0, "B-", 5.15), (1e9, "CCC", 8.20),
]


def _leverage_rating(lev):
    """Rating from gross debt/EBITDA when interest coverage is missing."""
    if lev is None:
        return None, None
    for hi, rating, spread in _LEV_RATING:
        if lev <= hi:
            return rating, spread
    return "CCC", 8.20


def _altman_rating(z):
    """Last-resort rating tier from the Altman Z bankruptcy zone."""
    if z is None:
        return None, None
    if z > 2.99:
        return "BBB", 1.56
    if z >= 1.81:
        return "BB", 2.40
    return "CCC", 8.20


def _ttm(df, *names):
    """Trailing-twelve-month sum from a quarterly statement (newest-first cols).
    Sums the available reported quarters (>=2) so a missing latest quarter still
    yields a usable figure."""
    if df is None or getattr(df, "empty", True):
        return None
    for n in names:
        if n in df.index:
            try:
                vals = [float(v) for v in df.loc[n].values[:4]
                        if v is not None and not (isinstance(v, float) and v != v)]
                if len(vals) >= 2:
                    return sum(vals)
            except Exception:
                continue
    return None


def _fin_row(df, *names):
    """Most-recent NON-NaN value for the first matching income/balance line item.
    yfinance leaves the latest column NaN for items it no longer breaks out, so we
    fall back to the most recent period that actually reported the figure."""
    if df is None or getattr(df, "empty", True):
        return None
    for n in names:
        if n in df.index:
            try:
                for v in df.loc[n].values:   # columns are newest-first
                    if v is not None and not (isinstance(v, float) and v != v):
                        return float(v)
            except Exception:
                continue
    return None


@router.get("/credit")
def get_credit(ticker: str):
    """Model-based credit quality: synthetic (Damodaran) rating from interest
    coverage, leverage, an Altman Z bankruptcy score, and the implied default
    spread. Not an agency rating — computed from the latest financials."""
    sym = ticker.strip().upper()
    ck = f"credit:v2:{sym}"
    cached = disk_get(ck)
    if cached is not None:
        return cached
    try:
        stock = yf.Ticker(sym)
        inc = stock.income_stmt
        bs = stock.balance_sheet
    except Exception as e:
        raise HTTPException(502, f"financials unavailable: {e}")

    info = {}
    try:
        info = get_info(sym) or {}
    except Exception:
        pass

    ebit = _fin_row(inc, "EBIT", "Operating Income", "OperatingIncome")
    interest = _fin_row(inc, "Interest Expense", "InterestExpense", "Interest Expense Non Operating")
    revenue = _fin_row(inc, "Total Revenue", "TotalRevenue", "Operating Revenue")
    ebitda = info.get("ebitda") or _fin_row(inc, "EBITDA", "Normalized EBITDA")
    total_debt = info.get("totalDebt") or _fin_row(bs, "Total Debt", "TotalDebt")
    cash = info.get("totalCash") or _fin_row(bs, "Cash And Cash Equivalents", "Cash Cash Equivalents And Short Term Investments")
    mkt_cap = info.get("marketCap")

    total_assets = _fin_row(bs, "Total Assets", "TotalAssets")
    total_liab = _fin_row(bs, "Total Liabilities Net Minority Interest", "Total Liab", "TotalLiabilitiesNetMinorityInterest")
    cur_assets = _fin_row(bs, "Current Assets", "Total Current Assets")
    cur_liab = _fin_row(bs, "Current Liabilities", "Total Current Liabilities")
    retained = _fin_row(bs, "Retained Earnings", "RetainedEarnings")

    coverage = ebit / abs(interest) if ebit is not None and interest not in (None, 0) else None

    # Fallback 1: trailing-twelve-month coverage from the quarterly statement —
    # annual columns often drop interest expense that the quarters still report.
    if coverage is None:
        try:
            q = stock.quarterly_income_stmt
            q_ebit = _ttm(q, "EBIT", "Operating Income", "OperatingIncome")
            q_int = _ttm(q, "Interest Expense", "InterestExpense", "Interest Expense Non Operating")
            if q_ebit is not None and q_int not in (None, 0):
                coverage = q_ebit / abs(q_int)
        except Exception:
            pass

    # Fallback 2: FMP income statement (independent source; also backfills EBITDA
    # and debt/cash when yfinance omits them).
    if fmp is not None and (coverage is None or ebitda is None or total_debt is None or cash is None):
        try:
            fi = (fmp.get_income(sym, 1) or [None])[0] or {}
            if coverage is None:
                oi, ie = fi.get("operatingIncome"), fi.get("interestExpense")
                if oi is not None and ie not in (None, 0):
                    coverage = oi / abs(ie)
            ebitda = ebitda or fi.get("ebitda")
        except Exception:
            pass
        if total_debt is None or cash is None:
            try:
                fb = fmp.get_balance(sym) or {}
                total_debt = total_debt if total_debt is not None else fb.get("totalDebt")
                cash = cash if cash is not None else fb.get("cashAndCashEquivalents")
            except Exception:
                pass

    coverage = round(coverage, 2) if coverage is not None else None
    debt_to_ebitda = round(total_debt / ebitda, 2) if total_debt is not None and ebitda not in (None, 0) else None
    net_debt = round(total_debt - cash) if total_debt is not None and cash is not None else None

    altman = altman_zone = None
    if all(v not in (None, 0) for v in (total_assets, total_liab)) and ebit is not None:
        wc = (cur_assets - cur_liab) if cur_assets is not None and cur_liab is not None else 0.0
        A = wc / total_assets
        B = (retained or 0.0) / total_assets
        C = ebit / total_assets
        D = (mkt_cap or 0.0) / total_liab
        E = (revenue or 0.0) / total_assets
        altman = round(1.2 * A + 1.4 * B + 3.3 * C + 0.6 * D + 1.0 * E, 2)
        altman_zone = "safe" if altman > 2.99 else "grey" if altman >= 1.81 else "distress"

    # Layered rating: interest coverage → gross leverage → Altman Z. Each rung is
    # a coarser proxy used only when the finer input is unavailable.
    lev_ok = ebitda is not None and ebitda > 0 and debt_to_ebitda is not None  # a leverage ratio only reads correctly on positive EBITDA
    if coverage is not None:
        rating, spread = _synthetic_rating(coverage)
        rating_basis = "interest coverage"
    elif lev_ok:
        rating, spread = _leverage_rating(debt_to_ebitda)
        rating_basis = "gross leverage"
    elif altman is not None:
        rating, spread = _altman_rating(altman)
        rating_basis = "Altman Z"
    else:
        rating, spread, rating_basis = None, None, None

    out = {
        "ticker": sym,
        "synthetic_rating": rating,
        "rating_basis": rating_basis,
        "default_spread_pct": spread,
        "interest_coverage": coverage,
        "debt_to_ebitda": debt_to_ebitda,
        "net_debt": net_debt,
        "total_debt": round(total_debt) if total_debt is not None else None,
        "altman_z": altman,
        "altman_zone": altman_zone,
        "current_ratio": round(cur_assets / cur_liab, 2) if cur_assets and cur_liab else None,
    }
    # A real operating company (we have debt/cash) whose rating still came back
    # empty means income_stmt/balance_sheet likely failed transiently (yfinance
    # hiccup) rather than genuinely lacking financials — don't bake that failure
    # in for a full day. Genuine non-companies (ETFs, no debt/cash at all either)
    # keep the long TTL since that null result is stable.
    degraded = rating is None and (total_debt is not None or cash is not None)
    disk_set(ck, out, ttl=600 if degraded else 86400)
    return out


@router.get("/profile")
def get_corporate_profile(ticker: str):
    """Fetches deep corporate profile details, explicitly safeguarding executive list arrays."""
    try:
        symbol = ticker.strip().upper()
        info = get_info(symbol)

        officers = []
        raw_officers = info.get("companyOfficers", [])
        if raw_officers and isinstance(raw_officers, list):
            for officer in raw_officers[:5]:
                if officer:
                    officers.append({
                        "name": officer.get("name") or "Unknown",
                        "title": officer.get("title") or "Executive",
                        "age": officer.get("age", "N/A"),
                        "total_pay": officer.get("totalPay", 0)
                    })

        return {
            "ticker": symbol,
            "website": info.get("website") or "N/A",
            "headquarters": f"{info.get('city', 'N/A')}, {info.get('state', 'N/A')}, {info.get('country', 'N/A')}",
            "full_time_employees": info.get("fullTimeEmployees") or 0,
            "audit_risk": info.get("auditRisk") or "N/A",
            "board_risk": info.get("boardRisk") or "N/A",
            "compensation_risk": info.get("compensationRisk") or "N/A",
            "share_holder_rights_risk": info.get("shareHolderRightsRisk") or "N/A",
            "executives": officers
        }
    except Exception as e:
        logger.error(f"Error in corporate profile master block: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/peer-valuation")
def get_peer_valuation(ticker: str):
    """Calculates relative comps matrix with exhaustive alignment variations to completely immunize against frontend .toFixed() crashes."""
    try:
        symbol = ticker.strip().upper()
        info = get_info(symbol)

        sector = info.get("sector", "")
        peers = _get_peers_for_ticker(symbol, sector)
        
        comps = []
        
        def _n(val) -> float | None:
            """Return float or None — never 0.0 for missing data."""
            try:
                f = float(val)
                return f if f != 0.0 else None
            except (TypeError, ValueError):
                return None

        def build_aligned_row(t_sym, d, is_target_flag):
            mcap  = _n(d.get("marketCap") or d.get("totalAssets"))
            price = _n(d.get("currentPrice") or d.get("navPrice") or d.get("previousClose"))
            pe    = _n(d.get("trailingPE"))
            ps    = _n(d.get("priceToSalesTrailing12Months") or d.get("priceToSales"))
            pb    = _n(d.get("priceToBook"))
            ev_ebitda = _n(d.get("enterpriseToEbitda"))
            # yfinance returns these as decimal fractions (0.6764 = 67.64%); the
            # frontend multiplies by 100 to render a percent, so keep them raw here.
            try:
                roe = round(float(d["returnOnEquity"]), 4) if d.get("returnOnEquity") else None
            except (TypeError, ValueError):
                roe = None
            try:
                rev_growth = round(float(d["revenueGrowth"]), 4) if d.get("revenueGrowth") else None
            except (TypeError, ValueError):
                rev_growth = None
            try:
                fcf = float(d["freeCashflow"]) if d.get("freeCashflow") else None
                pfcf = round(mcap / fcf, 2) if fcf and mcap and fcf > 0 else None
            except (TypeError, ValueError):
                pfcf = None

            return {
                "ticker":               t_sym,
                "name":                 d.get("longName") or d.get("shortName") or t_sym,
                "is_target":            is_target_flag,
                "price":                price,
                "pe":                   pe,
                "forward_pe":           _n(d.get("forwardPE")),
                "ev_ebitda":            ev_ebitda,
                "ps":                   ps,
                "pb":                   pb,
                "pfcf":                 pfcf,
                "peg":                  _n(d.get("trailingPegRatio") or d.get("pegRatio")),
                "dividend_yield":       _n(d.get("dividendYield")),
                "roe":                  roe,
                "revenue_growth":       rev_growth,
                "recommendation_key":   d.get("recommendationKey"),
                "recommendation_mean":  _n(d.get("recommendationMean")),
                "num_analyst_opinions": d.get("numberOfAnalystOpinions"),
                "target_mean_price":    _n(d.get("targetMeanPrice")),
            }

        # 1. Map Target Row
        comps.append(build_aligned_row(symbol, info, True))

        # 2. Map Peer Rows — fetched concurrently so a larger comp set stays fast
        def _peer_row(peer):
            try:
                p_info = get_info(peer)
                if isinstance(p_info, dict) and p_info:
                    return build_aligned_row(peer, p_info, False)
            except Exception:
                pass
            return None

        from concurrent.futures import ThreadPoolExecutor
        with ThreadPoolExecutor(max_workers=8) as pool:
            for row in pool.map(_peer_row, peers[:8]):
                if row:
                    comps.append(row)

        return {
            "ticker":  symbol,
            "sector":  sector,
            "peers":   comps,
        }
    except Exception as e:
        logger.error(f"Error in peer valuation final recovery block: {e}")
        raise HTTPException(status_code=500, detail=str(e))


def _holder_num(v) -> bool:
    return isinstance(v, (int, float)) and not (isinstance(v, float) and v != v)

def _holder_rows(df, limit: int = 12) -> list:
    """Shape a yfinance holders DataFrame into rows, tolerant of column-name
    drift across yfinance versions (pctHeld vs '% Out', etc.)."""
    out = []
    if df is None or getattr(df, "empty", True):
        return out
    for _, row in df.head(limit).iterrows():
        holder = row.get("Holder") or row.get("holder") or "—"
        shares = row.get("Shares") or row.get("shares")
        value  = row.get("Value") or row.get("value")
        pct    = row.get("pctHeld") or row.get("% Out") or row.get("pctOut")
        date   = row.get("Date Reported") or row.get("dateReported") or row.get("Date")
        # Fractional change in the position since the holder's prior filing.
        # This is the whole "who is accumulating" question and it was being
        # dropped on the floor.
        chg    = row.get("pctChange") or row.get("pct_change")
        # pctHeld is a fraction (0.071); older columns may already be a percent.
        pct_out = None
        if _holder_num(pct):
            pct_out = round(float(pct) * 100, 2) if float(pct) <= 1 else round(float(pct), 2)
        out.append({
            "holder": str(holder),
            "shares": int(shares) if _holder_num(shares) else 0,
            "value":  float(value) if _holder_num(value) else 0,
            "pct_out": pct_out,
            "date":   str(date)[:10] if date is not None else None,
            "pct_change": round(float(chg) * 100, 2) if _holder_num(chg) else None,
        })
    return out


@cached(ttl=43200, persist=True)
def _lseg_institutional_data_v2(symbol: str):
    """Raw LSEG institutional/fund holdings + ownership rollup for a ticker, or
    None when neither exists. The caller (get_institutional_ownership) decides
    what counts as "covered" — named holdings require actual holder rows, but
    the rollup (passive/active split) is real and useful even alone, so it's
    always returned here rather than filtered out early."""
    hold_rows = corporate_db.query(
        "SELECT * FROM lseg_institutional_holdings WHERE ticker = ? ORDER BY shares DESC", (symbol,)
    )
    rollup = corporate_db.query_one("SELECT * FROM lseg_ownership_rollup WHERE ticker = ?", (symbol,))
    if not hold_rows and not rollup:
        return None
    return {
        "holdings": [dict(r) for r in hold_rows],
        "rollup": dict(rollup) if rollup else None,
    }


def _position_changes(holders: list[dict]) -> dict | None:
    """Who added and who trimmed since the prior filing.

    A holders table without this is a snapshot of who owns the company, which
    is nearly static quarter to quarter. The change is the part that carries
    information, and it is the question "what are funds accumulating" is
    actually asking.

    Positions are 13F filings, so they lag by up to 45 days after quarter end
    and the payload carries the filing date to say so.
    """
    rows = [h for h in holders if h.get("pct_change") is not None]
    if not rows:
        return None
    # yfinance reports a brand-new position as +100%, which is indistinguishable
    # from a doubled one. Counted as "added" rather than guessed at.
    added = [h for h in rows if h["pct_change"] > 0.5]
    trimmed = [h for h in rows if h["pct_change"] < -0.5]
    held = len(rows) - len(added) - len(trimmed)
    net_shares = sum(
        (h.get("shares") or 0) * h["pct_change"] / (100 + h["pct_change"])
        for h in rows if h["pct_change"] > -100
    )
    ranked = sorted(rows, key=lambda h: h["pct_change"], reverse=True)
    return {
        "filed": max((h.get("date") for h in rows if h.get("date")), default=None),
        "added": len(added),
        "trimmed": len(trimmed),
        "unchanged": held,
        "net_share_change": int(net_shares),
        "biggest_adds": ranked[:3],
        "biggest_trims": list(reversed(ranked[-3:])) if len(ranked) > 3 else [],
    }


@router.get("/institutional")
def get_institutional_ownership(ticker: str):
    """Institutional ownership: % held by institutions/insiders plus the top
    holders and fund holders, using LSEG ownership tables with yfinance fallback.

    The LSEG holdings export only carries real named holders for a subset of
    tickers — most rows are a security-level rollup with no per-holder detail
    at all. Only claim source=LSEG (and skip yfinance's real named holders)
    when LSEG actually has named holdings; otherwise fall through to yfinance
    for holders/funds but still merge in LSEG's passive/active split when
    that rollup exists, since it's real data yfinance doesn't have."""
    symbol = ticker.strip().upper()

    float_shares = None
    try:
        _info = get_info(symbol)
        if isinstance(_info, dict):
            _fs = _info.get("floatShares")
            float_shares = int(_fs) if _holder_num(_fs) else None
    except Exception:
        pass

    lseg = _lseg_institutional_data_v2(symbol)
    lseg_rollup = (lseg or {}).get("rollup") or {}
    lseg_passive_pct = lseg_rollup.get("passive_pct")
    lseg_active_pct = lseg_rollup.get("active_pct")

    if lseg and lseg["holdings"]:
        holders, funds = [], []
        for r in lseg["holdings"]:
            prior = (r["shares"] or 0) - (r["change_shares"] or 0)
            hold_dict = {
                "holder": r["holder_name"],
                "shares": r["shares"],
                "value": r["value"],
                "pct_out": r["pct_out"],
                "date": r["date"],
                "change_shares": r["change_shares"],
                # LSEG gives an absolute delta where yfinance gives a fraction.
                # Both summaries read pct_change, so normalise here.
                "pct_change": round(r["change_shares"] / prior * 100, 2) if (prior and r["change_shares"] is not None) else None,
                "investment_style": r["investment_style"]
            }
            if (r["holder_type"] or "").strip().lower() == "institutional":
                holders.append(hold_dict)
            else:
                funds.append(hold_dict)
        insider_pct = lseg_rollup.get("insider_pct")
        held_pct_inst = (lseg_passive_pct + lseg_active_pct) / 100.0 if (lseg_passive_pct is not None and lseg_active_pct is not None) else None
        held_pct_ins = insider_pct / 100.0 if insider_pct is not None else None
        return {
            "ticker": symbol,
            "pct_institutions": held_pct_inst,
            "pct_insiders": held_pct_ins,
            "passive_pct": lseg_passive_pct,
            "active_pct": lseg_active_pct,
            "float_shares": float_shares,
            "holders": holders,
            "funds": funds,
            "changes": _position_changes(holders),
            "source": "LSEG"
        }

    # Fallback to yfinance for named holders
    cache_key = f"instown:v2:{symbol}"
    cached = disk_get(cache_key)
    if cached:
        cached["passive_pct"] = lseg_passive_pct
        cached["active_pct"] = lseg_active_pct
        return cached
    try:
        stock = yf.Ticker(symbol)
        holders = funds = []
        try: holders = _holder_rows(stock.institutional_holders)
        except Exception as e: logger.warning(f"institutional_holders {symbol}: {e}")
        try: funds = _holder_rows(stock.mutualfund_holders)
        except Exception as e: logger.warning(f"mutualfund_holders {symbol}: {e}")

        inst_pct = insider_pct = None
        try:
            info = get_info(symbol)
            if isinstance(info, dict):
                inst_pct    = info.get("heldPercentInstitutions")
                insider_pct = info.get("heldPercentInsiders")
        except Exception:
            pass

        result = {
            "ticker":          symbol,
            "pct_institutions": round(float(inst_pct), 4) if _holder_num(inst_pct) else None,
            "pct_insiders":     round(float(insider_pct), 4) if _holder_num(insider_pct) else None,
            "float_shares":     float_shares,
            "holders":          holders,
            "funds":            funds,
            "changes":          _position_changes(holders),
            "source":           "yfinance",
        }
        # 13F data is quarterly — cache hard so we don't re-hit yfinance per view.
        # passive_pct/active_pct are cached separately (LSEG) so they're not
        # baked into this stale-tolerant blob and always reflect the latest ingest.
        disk_set(cache_key, result, ttl=43200)   # 12h
        result["passive_pct"] = lseg_passive_pct
        result["active_pct"] = lseg_active_pct
        return result
    except Exception as e:
        logger.error(f"Error fetching institutional ownership for {symbol}: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@cached(ttl=43200, persist=True)
def _sdc_deals_data(symbol: str):
    rows = corporate_db.query(
        "SELECT * FROM sdc_deals WHERE acquirer_ticker = ? OR target_ticker = ? ORDER BY date_announced DESC",
        (symbol, symbol)
    )
    return [dict(r) for r in rows]


@router.get("/deals")
def get_sdc_deals(ticker: str):
    """Returns announced/completed M&A deals from SDC Deals where the ticker
    is either the target or the acquirer."""
    symbol = ticker.strip().upper()
    try:
        deals = []
        for r in _sdc_deals_data(symbol):
            deals.append({
                "deal_id": r["deal_id"],
                "date_announced": r["date_announced"],
                "date_completed": r["date_completed"],
                "acquirer_ticker": r["acquirer_ticker"],
                "acquirer_name": r["acquirer_name"],
                "target_ticker": r["target_ticker"],
                "target_name": r["target_name"],
                "deal_value": r["deal_value"],
                "deal_terms": r["deal_terms"],
                "deal_status": r["deal_status"],
                "role": "acquirer" if r["acquirer_ticker"] == symbol else "target"
            })
        return {
            "ticker": symbol,
            "deals": deals,
            "source": "SDC"
        }
    except Exception as e:
        logger.error(f"Error fetching SDC deals for {symbol}: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/supply-chain")
def get_supply_chain(ticker: str):
    """Company profile: basic info + product/geo revenue segments + peer list."""
    try:
        symbol = ticker.strip().upper()
        try:
            info = get_info(symbol)
        except Exception:
            info = {}

        import fmp as _fmp
        fmp_profile = {}
        try:
            if _fmp.available():
                fmp_profile = _fmp.get_profile(symbol) or {}
        except Exception:
            pass

        def profile_value(*keys):
            for key in keys:
                value = info.get(key)
                if value not in (None, "", "N/A"):
                    return value
                value = fmp_profile.get(key)
                if value not in (None, "", "N/A"):
                    return value
            return None

        # One market cap for the whole app, on a stated basis. This page used to
        # print yfinance's basic-share figure ($4.46T for AAPL) while Master
        # Valuation multiplied the same price by diluted shares ($4,590.4B), so
        # the same name looked 3% cheaper depending on the tab. The price comes
        # off the same resolution as the cap, so cap divided by price is the
        # share count actually printed rather than an implied third number.
        cap = market_cap_lib.market_cap(symbol)
        price = cap["price"] or safe_float(info, ["currentPrice", "previousClose", "navPrice"]) or None
        mcap  = cap["value"] or safe_float(info, ["marketCap", "totalAssets"]) or None
        mcap_basis = cap["basis"] if cap["value"] else (market_cap_lib.BASIS_VENDOR if mcap else None)
        revenue = safe_float(info, ["totalRevenue"]) or safe_float(fmp_profile, ["revenue"]) or None
        emp   = profile_value("fullTimeEmployees", "employees")
        pe      = info.get("trailingPE")
        eps     = info.get("trailingEps")
        rev_g   = info.get("revenueGrowth")            # fraction, e.g. 0.051
        # Dividend yield as a percent. yfinance's dividendYield field flips
        # between a fraction and a percent across versions, so derive it from the
        # unambiguous annual dividend rate over price when available; fall back to
        # the field only when the rate is missing.
        div_rate = info.get("dividendRate")
        div_raw  = info.get("dividendYield")
        div_y    = None
        if _holder_num(div_rate) and div_rate > 0 and price and price > 0:
            div_y = round(div_rate / price * 100, 2)
        elif _holder_num(div_raw) and div_raw > 0:
            div_y = round(div_raw * 100, 2) if div_raw < 1 else round(div_raw, 2)

        product_segments = dict(_fmp.EMPTY_SEGMENTS)
        geo_segments     = dict(_fmp.EMPTY_SEGMENTS)
        try:
            if _fmp.available():
                product_segments = _fmp.get_revenue_segments(symbol)
                geo_segments     = _fmp.get_geo_segments(symbol)
        except Exception:
            pass
        if product_segments.get("latest"):
            product_segments["source"] = "fmp"
        if geo_segments.get("latest"):
            geo_segments["source"] = "fmp"

        # Backup: when FMP segments are empty (e.g. rate-limited), fall back to the
        # free SEC EDGAR 10-K breakdown (product and geography) so the page still
        # shows data, tagged source=sec.
        def _edgar_backup(block, fetch):
            if block.get("latest"):
                return block
            try:
                sec = fetch(symbol)
                if sec.get("latest"):
                    return {
                        **dict(_fmp.EMPTY_SEGMENTS),
                        "fiscalYear": sec.get("fiscalYear"),
                        "currency":   sec.get("currency") or "USD",
                        "latest":     sec["latest"],
                        "source":     "sec",
                    }
            except Exception:
                pass
            return block
        import sec_segments
        product_segments = _edgar_backup(product_segments, sec_segments.get_segment_revenue)
        geo_segments     = _edgar_backup(geo_segments, sec_segments.get_geo_revenue)

        import sec_bank_revenue
        try:
            revenue_activity = sec_bank_revenue.get_bank_revenue_activity(symbol)
        except Exception:
            revenue_activity = {"fiscalYear": None, "currency": "USD", "latest": [], "history": [], "concentration": None}

        peers = _get_peers_for_ticker(symbol, info.get("sector", ""))

        return {
            "ticker":           symbol,
            "name":             profile_value("longName", "shortName", "companyName") or symbol,
            "sector":           profile_value("sector") or "N/A",
            "industry":         profile_value("industry") or "N/A",
            "description":      profile_value("longBusinessSummary", "description") or "",
            "country":          profile_value("country"),
            "city":             profile_value("city"),
            "price":            float(price) if price else None,
            "market_cap":       float(mcap) if mcap else None,
            "market_cap_basis": mcap_basis,
            "market_cap_shares": cap["shares"],
            "market_cap_source": cap["source"],
            "revenue":          float(revenue) if revenue else None,
            "employees":        int(emp) if emp else None,
            "pe_ratio":         round(float(pe), 1) if _holder_num(pe) and pe > 0 else None,
            "eps_ttm":          round(float(eps), 2) if _holder_num(eps) else None,
            "rev_growth":       round(float(rev_g), 4) if _holder_num(rev_g) else None,
            "div_yield":        div_y,
            # Percent-scale fields (yfinance reports these as fractions), safe to
            # compare against industry_ratios' sector medians since both are
            # built the same way. debtToEquity is deliberately excluded — yfinance's
            # field uses a different scale than the FMP-derived debtEquity the
            # median dataset is built from (verified: NVDA reads 6.555 here vs.
            # ~0.07 in the FMP-derived screener data), so it isn't comparable.
            "gross_margin":     round(float(info["grossMargins"]) * 100, 1) if _holder_num(info.get("grossMargins")) else None,
            "operating_margin": round(float(info["operatingMargins"]) * 100, 1) if _holder_num(info.get("operatingMargins")) else None,
            "net_margin":       round(float(info["profitMargins"]) * 100, 1) if _holder_num(info.get("profitMargins")) else None,
            "roe":              round(float(info["returnOnEquity"]) * 100, 1) if _holder_num(info.get("returnOnEquity")) else None,
            "roa":              round(float(info["returnOnAssets"]) * 100, 1) if _holder_num(info.get("returnOnAssets")) else None,
            "current_ratio":    round(float(info["currentRatio"]), 2) if _holder_num(info.get("currentRatio")) else None,
            "product_segments": product_segments,
            "geo_segments":     geo_segments,
            "revenue_activity": revenue_activity,
            "peers":            peers,
            "profile_sources":  [source for source, present in (("Yahoo Finance", bool(info)), ("Financial Modeling Prep", bool(fmp_profile))) if present],
        }
    except Exception as e:
        logger.error(f"Error in supply chain endpoint: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/peers-by-tags")
def get_peers_by_tags(ticker: str, limit: int = 24, company_name: str = ""):
    """Supply-chain peer/counterparty set for one name, ranked by shared Veridion
    firmographic tags (sourcing focus, end-markets, industry). Read-only DB."""
    from logistics import company_fundamentals
    lim = max(1, min(limit, 600))
    symbol = ticker.strip().upper()
    canonical_name = company_name.strip() or _sec_company_name(symbol)
    ck = f"peers_tags:v5:{symbol}:{_norm_company(canonical_name or '')}:{lim}"
    cached = disk_get(ck)
    if cached is not None:
        return cached
    try:
        result = company_fundamentals.peers_by_tags(symbol, limit=lim, expected_name=canonical_name)
        if result.get("matched"):
            disk_set(ck, result, ttl=7 * 24 * 3600)
        return result
    except Exception as e:
        logger.error(f"Error in peers-by-tags endpoint: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/facilities")
def get_facilities(ticker: str):
    """Physical facility list for the Supply Chain Map, from the bundled Open
    Supply Hub ingest. Coverage is a curated ~9-ticker subset, not a general
    company lookup — the response's `available` flag says which case this is."""
    from logistics import company_fundamentals
    symbol = ticker.strip().upper()
    ck = f"facilities:v2:{symbol}"
    cached = disk_get(ck)
    if cached is not None:
        return cached
    try:
        result = company_fundamentals.facilities_for_ticker(symbol)
        if result.get("available"):
            disk_set(ck, result, ttl=24 * 3600)
        return result
    except Exception as e:
        logger.error(f"Error in facilities endpoint: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/short-interest")
def get_short_interest(ticker: str):
    """Latest FINRA biweekly short-interest snapshot for one symbol. Free,
    no-auth CDN file covering the whole market — see backend/short_interest.py."""
    import short_interest
    symbol = ticker.strip().upper()
    try:
        result = short_interest.short_interest_for_ticker(symbol)
        return result or {"available": False, "ticker": symbol}
    except Exception as e:
        logger.error(f"Error in short-interest endpoint: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/debt-maturity")
def get_debt_maturity(ticker: str):
    """Forward debt-maturity ladder from the company's own 10-K (SEC XBRL,
    free, no key). Returns null if the filer carries no long-term debt or the
    maturity-schedule tags aren't present (small/newly-listed filers)."""
    import sec_fundamentals
    symbol = ticker.strip().upper()
    try:
        result = sec_fundamentals.debt_maturity_schedule(symbol)
        return result or {"available": False, "ticker": symbol}
    except Exception as e:
        logger.error(f"Error in debt-maturity endpoint: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/public-company-evidence")
def get_public_company_evidence(ticker: str, company_name: str = ""):
    """Free public records, labelled separately from map similarity data."""
    from logistics.public_enrichment import get_public_company_evidence as evidence
    try:
        return evidence(ticker, company_name)
    except Exception as e:
        logger.error(f"Error in public-company-evidence endpoint: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/verified-supply-chain-relationships")
def get_verified_supply_chain_relationships(ticker: str):
    """First-party public supplier, buyer, and operating-partner disclosures —
    curated ledger + SEC Exhibit 21 + USAspending.gov + Open Supply Hub, merged.
    Cached at this layer too (not just inside each source) so a page load never
    pays for reassembling/re-requesting all four on every visit, matching how
    /facilities and /peers-by-tags already cache their merged output."""
    from logistics.verified_relationships import relationships_for_ticker
    symbol = ticker.strip().upper()
    ck = f"verified_relationships:v1:{symbol}"
    cached = disk_get(ck)
    if cached is not None:
        return cached
    try:
        result = relationships_for_ticker(symbol)
        disk_set(ck, result, ttl=24 * 3600)
        return result
    except Exception as e:
        logger.error(f"Error in verified-supply-chain-relationships endpoint: {e}")
        raise HTTPException(status_code=500, detail=str(e))
