import logging
import os, re, sys
import requests
from fastapi import APIRouter, HTTPException
import yfinance as yf

sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))
from cache import get_history, get_info
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
async def company_search(q: str):
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
    "FIN":  ["JPM", "BAC", "MS", "GS", "WFC", "C"],
}

def _get_peers_for_ticker(ticker: str, sector: str) -> list:
    """Comparable companies for relative comps. Prefers FMP's curated, size-ranked
    peer list (real business comps, not just same-sector); falls back to broad
    hardcoded groups only when FMP is unavailable or returns nothing."""
    sym = ticker.strip().upper()

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
    if sym in ["JPM", "BAC", "MS", "GS"]:
        return [p for p in PEER_GROUPS["FIN"] if p != sym]
    
    # Generic sector fallback map if explicit ticker match isn't found
    sec_lower = (sector or "").lower()
    if "tech" in sec_lower: return [p for p in PEER_GROUPS["TECH"] if p != sym]
    if "comm" in sec_lower: return [p for p in PEER_GROUPS["COMM"] if p != sym]
    if "financial" in sec_lower: return [p for p in PEER_GROUPS["FIN"] if p != sym]
    return [p for p in PEER_GROUPS["CONS"] if p != sym]

def safe_float(d, keys, default=0.0) -> float:
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


@router.get("/hub")
async def get_corporate_hub(ticker: str):
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
                t_pct_1d = round((t_price - t_prev) / t_prev * 100, 3) if t_prev else None
        elif t_price and t_prev and t_prev > 0:
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
            "consensus": None,
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
async def get_corporate_hub_short(ticker: str):
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


@router.get("/hub/insider")
async def get_corporate_hub_insider(ticker: str):
    """Returns recent insider transactions for a ticker."""
    try:
        symbol = ticker.strip().upper()
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
        }
    except Exception as e:
        logger.error(f"Error fetching insider data for {ticker}: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/hub/analyst")
async def get_corporate_hub_analyst(ticker: str):
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


@router.get("/profile")
async def get_corporate_profile(ticker: str):
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
async def get_peer_valuation(ticker: str):
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
        })
    return out


@router.get("/institutional")
async def get_institutional_ownership(ticker: str):
    """Institutional ownership: % held by institutions/insiders plus the top
    13F holders and mutual-fund holders (yfinance, sourced from quarterly 13Fs)."""
    symbol = ticker.strip().upper()
    cache_key = f"instown:v1:{symbol}"
    cached = disk_get(cache_key)
    if cached:
        return cached
    try:
        stock = yf.Ticker(symbol)
        holders = funds = []
        try: holders = _holder_rows(stock.institutional_holders)
        except Exception as e: logger.warning(f"institutional_holders {symbol}: {e}")
        try: funds = _holder_rows(stock.mutualfund_holders)
        except Exception as e: logger.warning(f"mutualfund_holders {symbol}: {e}")

        inst_pct = insider_pct = float_pct = None
        try:
            info = get_info(symbol)
            if isinstance(info, dict):
                inst_pct    = info.get("heldPercentInstitutions")
                insider_pct = info.get("heldPercentInsiders")
                float_pct   = info.get("floatShares")
        except Exception:
            pass

        result = {
            "ticker":          symbol,
            "pct_institutions": round(float(inst_pct), 4) if _holder_num(inst_pct) else None,
            "pct_insiders":     round(float(insider_pct), 4) if _holder_num(insider_pct) else None,
            "float_shares":     int(float_pct) if _holder_num(float_pct) else None,
            "holders":          holders,
            "funds":            funds,
            "source":           "yfinance",
        }
        # 13F data is quarterly — cache hard so we don't re-hit yfinance per view.
        disk_set(cache_key, result, ttl=43200)   # 12h
        return result
    except Exception as e:
        logger.error(f"Error fetching institutional ownership for {symbol}: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/supply-chain")
async def get_supply_chain(ticker: str):
    """Company profile: basic info + product/geo revenue segments + peer list."""
    try:
        symbol = ticker.strip().upper()
        try:
            info = get_info(symbol)
        except Exception:
            info = {}

        price = safe_float(info, ["currentPrice", "previousClose", "navPrice"]) or None
        mcap  = safe_float(info, ["marketCap", "totalAssets"]) or None
        emp   = info.get("fullTimeEmployees")
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

        import fmp as _fmp
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
            "name":             info.get("longName") or info.get("shortName") or symbol,
            "sector":           info.get("sector") or "N/A",
            "industry":         info.get("industry") or "N/A",
            "description":      info.get("longBusinessSummary") or "",
            "price":            float(price) if price else None,
            "market_cap":       float(mcap) if mcap else None,
            "employees":        int(emp) if emp else None,
            "pe_ratio":         round(float(pe), 1) if _holder_num(pe) and pe > 0 else None,
            "eps_ttm":          round(float(eps), 2) if _holder_num(eps) else None,
            "rev_growth":       round(float(rev_g), 4) if _holder_num(rev_g) else None,
            "div_yield":        div_y,
            "product_segments": product_segments,
            "geo_segments":     geo_segments,
            "revenue_activity": revenue_activity,
            "peers":            peers,
        }
    except Exception as e:
        logger.error(f"Error in supply chain endpoint: {e}")
        raise HTTPException(status_code=500, detail=str(e))