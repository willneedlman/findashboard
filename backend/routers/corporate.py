import sys, os
sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))
from validation import validate_ticker
import datetime as _dt
import yfinance as yf
import numpy as np
from fastapi import APIRouter
from cachetools import TTLCache
import threading
import fmp
import re
import json
import logging

_log = logging.getLogger(__name__)

# Load GROQ_API_KEY from root .env (one level above backend/)
from dotenv import load_dotenv as _load_dotenv
_load_dotenv(os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(__file__))), ".env"))
_GROQ_API_KEY = os.getenv("GROQ_API_KEY", "")

try:
    from groq import Groq as _Groq
    _GROQ = bool(_GROQ_API_KEY)
except ImportError:
    _GROQ = False

router = APIRouter()

# In-memory caches (fast path) + disk cache below for persistence across restarts
_hub_cache: TTLCache     = TTLCache(maxsize=200, ttl=1800)   # 30 min (was 5)
_short_cache: TTLCache   = TTLCache(maxsize=200, ttl=1800)   # 30 min (was 5)
_insider_cache: TTLCache = TTLCache(maxsize=200, ttl=3600)   # 1 hr   (was 10)
_cache_lock = threading.Lock()

try:
    from disk_cache import disk_get, disk_set
    _DISK_CACHE = True
    _HUB_DISK_TTL = 1800   # match in-memory TTL
except ImportError:
    _DISK_CACHE = False
    def disk_get(_k): return None   # type: ignore
    def disk_set(_k, _v, ttl=0): pass  # type: ignore

try:
    import finnhub as _finnhub
    _FINNHUB = True
except ImportError:
    _FINNHUB = False


def _extract_news(raw_news: list) -> list:
    out = []
    for article in raw_news[:8]:
        content = article.get('content', article)
        title = content.get('title') or article.get('title') or 'Market Update'
        url = (
            (content.get('clickThroughUrl') or {}).get('url')
            or (content.get('canonicalUrl') or {}).get('url')
            or article.get('link', '#')
        )
        publisher = (
            (content.get('provider') or {}).get('displayName')
            or article.get('publisher', 'Financial Wire')
        )
        pub_date = content.get('pubDate') or article.get('providerPublishTime')
        out.append({'title': title, 'link': url, 'publisher': publisher, 'pubDate': pub_date})
    return out


@router.get("/hub")
def corporate_hub(ticker: str):
    """Fast scan endpoint — only fetches price history and news. No tkr.info calls."""
    sym = validate_ticker(ticker)
    with _cache_lock:
        if sym in _hub_cache:
            return _hub_cache[sym]
    # Check persistent disk cache before hitting any external API
    disk_val = disk_get(f"hub:{sym}")
    if disk_val is not None:
        with _cache_lock:
            _hub_cache[sym] = disk_val
        return disk_val
    tkr = yf.Ticker(sym)

    implied_move  = 4.5
    estimated_pe  = 24.5
    current_spot  = None
    pct_change_1d = None
    market_cap    = None

    try:
        # 6mo history — covers vol calc and 60-day trailing quarter; no slow .info call
        hist = tkr.history(period="6mo")
        if not hist.empty:
            if hist.index.tz is not None:
                hist.index = hist.index.tz_localize(None)
            close = hist['Close'].dropna()
            current_spot = float(close.iloc[-1])

            # Day % change from last two closes
            if len(close) >= 2:
                pct_change_1d = round(float((close.iloc[-1] / close.iloc[-2] - 1) * 100), 2)

            log_ret = np.log(close / close.shift(1)).dropna()
            realized_vol = float(log_ret.std() * np.sqrt(252))
            implied_move = round(realized_vol * np.sqrt(7 / 365) * 100, 2)

            trailing_qtr = float((close.iloc[-1] / close.iloc[-60]) - 1) if len(close) >= 60 else 0.05
            if current_spot and current_spot > 250:
                estimated_pe = max(5.0, min(22.4 + trailing_qtr * 12, 140.0))
            else:
                estimated_pe = max(5.0, min(15.8 + trailing_qtr * 8, 140.0))
            estimated_pe = round(estimated_pe, 2)
    except Exception:
        pass

    # Market cap + real % change via FMP quote, with Finnhub fallback
    q = {}
    if fmp.available():
        try:
            q = fmp.get_quote(sym)
        except Exception:
            pass
    if not q.get('price') and _FINNHUB and _finnhub.available():
        try:
            q = _finnhub.get_quote(sym)
        except Exception:
            pass
    if q:
        if q.get('marketCap'):
            market_cap = int(q['marketCap'])
        chg = q.get('changesPercentage') if q.get('changesPercentage') is not None else q.get('changePercentage')
        if chg is not None:
            pct_change_1d = round(float(chg), 2)
        if fmp.available():
            try:
                inc = fmp.get_income(sym, 1)
                eps = inc[0].get('epsDiluted') if inc else None
                price = q.get('price')
                if eps and price and eps > 0:
                    estimated_pe = round(price / eps, 1)
            except Exception:
                pass

    # Always fall back to yfinance fast_info if market_cap still missing
    # (covers FMP-enabled path where a ticker returns no marketCap)
    if market_cap is None:
        try:
            fi = tkr.fast_info
            mc = getattr(fi, 'market_cap', None)
            if mc is not None and mc == mc and mc > 0:  # guard against nan/None/0
                market_cap = int(mc)
            else:
                shares = getattr(fi, 'shares', None)
                if shares is not None and shares == shares and shares > 0 and current_spot:
                    market_cap = int(shares * current_spot)
        except Exception:
            pass

    if estimated_pe < 18:
        consensus = 'Strong Buy'
    elif estimated_pe < 32:
        consensus = 'Moderate Buy'
    elif estimated_pe < 55:
        consensus = 'Hold'
    else:
        consensus = 'Underperform'

    news = []
    try:
        news = _extract_news(tkr.news or [])
    except Exception:
        pass

    est_date    = (_dt.date.today() + _dt.timedelta(days=45)).strftime("%B %d, %Y")
    horizon_lbl = f"Q2 {_dt.date.today().year}"

    # 30-day sparkline — raw closes for frontend SVG path
    sparkline: list[float] = []
    try:
        tkr2 = yf.Ticker(sym)
        h30 = tkr2.history(period="1mo")
        if not h30.empty:
            c30 = h30['Close'].dropna().iloc[-30:]
            sparkline = [round(float(v), 4) for v in c30]
    except Exception:
        pass

    result = {
        "ticker": sym,
        "spot": round(current_spot, 4) if current_spot else None,
        "implied_move": implied_move,
        "estimated_pe": estimated_pe,
        "pct_change_1d": pct_change_1d,
        "market_cap": market_cap,
        "consensus": consensus,
        "date": est_date,
        "horizon": horizon_lbl,
        "is_confirmed": True,
        "news": news,
        "sparkline": sparkline,
    }
    with _cache_lock:
        _hub_cache[sym] = result
    disk_set(f"hub:{sym}", result, ttl=_HUB_DISK_TTL)
    return result


@router.get("/hub/short")
def corporate_hub_short(ticker: str):
    """Slow supplemental endpoint — fetches short interest from tkr.info. Called lazily."""
    sym = validate_ticker(ticker)
    with _cache_lock:
        if sym in _short_cache:
            return _short_cache[sym]
    try:
        info = yf.Ticker(sym).info
        result = {
            "ticker": sym,
            "shortRatio": info.get("shortRatio"),
            "shortPercentOfFloat": info.get("shortPercentOfFloat"),
            "sharesShort": info.get("sharesShort"),
            "sharesShortPriorMonth": info.get("sharesShortPriorMonth"),
        }
    except Exception:
        result = {"ticker": sym, "shortRatio": None, "shortPercentOfFloat": None,
                  "sharesShort": None, "sharesShortPriorMonth": None}
    with _cache_lock:
        _short_cache[sym] = result
    return result


@router.get("/hub/insider")
def corporate_hub_insider(ticker: str):
    """Insider transactions for a ticker — up to 10 most recent rows."""
    ticker = validate_ticker(ticker)
    import datetime as dt
    sym = ticker.strip().upper()
    with _cache_lock:
        if sym in _insider_cache:
            return _insider_cache[sym]
    rows = []
    try:
        df = yf.Ticker(sym).insider_transactions
        if df is not None and not df.empty:
            df = df.head(10).copy()
            for _, row in df.iterrows():
                # Derive buy/sale from the Text description
                text = str(row.get("Text") or "")
                tx_lower = text.lower()
                if "sale" in tx_lower:
                    tx_type = "Sale"
                elif "purchase" in tx_lower or "buy" in tx_lower or "bought" in tx_lower:
                    tx_type = "Purchase"
                elif "gift" in tx_lower:
                    tx_type = "Gift"
                elif "exercise" in tx_lower or "option" in tx_lower:
                    tx_type = "Option Exercise"
                else:
                    tx_type = str(row.get("Transaction") or "").strip() or "Other"

                date_raw = row.get("Start Date")
                date_str = str(date_raw)[:10] if date_raw and str(date_raw) != "NaT" else "—"

                rows.append({
                    "date":        date_str,
                    "insider":     str(row.get("Insider") or "Unknown").strip(),
                    "title":       str(row.get("Position") or "Unknown").strip() or "Unknown",
                    "transaction": tx_type,
                    "shares":      int(row.get("Shares") or 0),
                    "value":       float(row.get("Value") or 0),
                })
    except Exception:
        pass
    result = {"ticker": sym, "transactions": rows}
    with _cache_lock:
        _insider_cache[sym] = result
    return result


_groq_peers_cache: TTLCache = TTLCache(maxsize=500, ttl=86400)   # 24hr — peers rarely change
_groq_lock = threading.Lock()

_TICKER_RE = re.compile(r'^[A-Z]{1,5}(-[A-Z])?$')

def _get_groq_peers(sym: str, name: str, industry: str, description: str) -> list[str] | None:
    """Ask Groq for the 7 closest public-company comps. Returns None on failure."""
    if not _GROQ:
        return None
    with _groq_lock:
        if sym in _groq_peers_cache:
            return _groq_peers_cache[sym]
    try:
        client = _Groq(api_key=_GROQ_API_KEY)
        desc_snippet = (description or "")[:350]
        prompt = (
            f"You are a sell-side equity analyst. List the 7 most comparable publicly-traded companies "
            f"(trading on US exchanges) to {name} (ticker: {sym}).\n"
            f"Industry: {industry}\n"
            f"Business: {desc_snippet}\n\n"
            f"Criteria: same sub-vertical/business model, similar revenue scale or growth stage. "
            f"Do NOT include {sym} itself. Do NOT pick generic mega-caps unless they are genuine comps.\n"
            f"Respond with ONLY a JSON array of ticker symbols, e.g. [\"SQ\",\"OLO\",\"PAR\"]."
        )
        resp = client.chat.completions.create(
            model="llama-3.3-70b-versatile",
            messages=[{"role": "user", "content": prompt}],
            temperature=0.1,
            max_tokens=120,
        )
        raw = resp.choices[0].message.content or ""
        # Extract JSON array from response
        m = re.search(r'\[.*?\]', raw, re.DOTALL)
        if not m:
            return None
        tickers: list[str] = json.loads(m.group())
        # Sanitize — keep valid-looking US tickers only
        tickers = [t.strip().upper() for t in tickers if isinstance(t, str) and _TICKER_RE.match(t.strip().upper())][:8]
        if not tickers:
            return None
        with _groq_lock:
            _groq_peers_cache[sym] = tickers
        return tickers
    except Exception as e:
        _log.warning("Groq peers failed for %s: %s", sym, e)
        return None


_valid_ticker_cache: TTLCache = TTLCache(maxsize=1000, ttl=86400)  # 24hr
_valid_lock = threading.Lock()

def _validate_tickers(tickers: list[str]) -> list[str]:
    """Filter to tickers with a live price. Uses yf history (1d) — avoids fast_info bugs."""
    import concurrent.futures

    def _check(t: str) -> str | None:
        with _valid_lock:
            cached = _valid_ticker_cache.get(t)
            if cached is not None:
                return t if cached else None
        try:
            hist = yf.Ticker(t).history(period="5d")
            ok = not hist.empty and len(hist) > 0
        except Exception:
            ok = False
        with _valid_lock:
            _valid_ticker_cache[t] = ok
        return t if ok else None

    with concurrent.futures.ThreadPoolExecutor(max_workers=10) as ex:
        results = list(ex.map(_check, tickers))
    return [r for r in results if r is not None]


_groq_segs_cache: TTLCache = TTLCache(maxsize=500, ttl=86400)   # 24hr
_groq_segs_lock  = threading.Lock()

def _get_groq_segments(sym: str, name: str, industry: str, description: str, total_rev: float) -> dict | None:
    """Ask Groq for product/geo revenue breakdown. Returns {product_segments, geo_segments}."""
    if not _GROQ:
        return None
    with _groq_segs_lock:
        if sym in _groq_segs_cache:
            return _groq_segs_cache[sym]
    try:
        client = _Groq(api_key=_GROQ_API_KEY)
        desc_snippet = (description or "")[:300]
        prompt = (
            f"You are a financial analyst. For {name} (ticker: {sym}, industry: {industry}), "
            f"provide estimated revenue breakdown percentages.\n"
            f"Business: {desc_snippet}\n\n"
            f"Return ONLY valid JSON in exactly this format:\n"
            f'{{"product_segments":[{{"name":"Segment A","pct":60.0}},{{"name":"Segment B","pct":40.0}}],'
            f'"geo_segments":[{{"name":"United States","pct":70.0}},{{"name":"International","pct":30.0}}]}}\n'
            f"Rules: percentages must sum to 100, use 2-5 segments per breakdown, be specific to the actual business."
        )
        resp = client.chat.completions.create(
            model="llama-3.3-70b-versatile",
            messages=[{"role": "user", "content": prompt}],
            temperature=0.1,
            max_tokens=300,
        )
        raw = resp.choices[0].message.content or ""
        m = re.search(r'\{.*\}', raw, re.DOTALL)
        if not m:
            return None
        data = json.loads(m.group())

        def _to_segs(items: list) -> list[dict]:
            out = []
            for item in items:
                n   = str(item.get("name", "")).strip()
                pct = float(item.get("pct", 0))
                if n and pct > 0:
                    val = round(total_rev * pct / 100) if total_rev else 0
                    out.append({"name": n, "value": val, "pct": round(pct, 1)})
            return out

        result = {
            "product_segments": _to_segs(data.get("product_segments", [])),
            "geo_segments":     _to_segs(data.get("geo_segments", [])),
        }
        with _groq_segs_lock:
            _groq_segs_cache[sym] = result
        return result
    except Exception as e:
        _log.warning("Groq segments failed for %s: %s", sym, e)
        return None


_SECTOR_PEERS: dict[str, list[str]] = {
    "Technology":             ["AAPL", "MSFT", "GOOGL", "META", "NVDA", "AMD", "INTC", "AVGO"],
    "Financial Services":     ["JPM", "BAC", "GS", "MS", "WFC", "C", "BLK", "AXP"],
    "Healthcare":             ["JNJ", "UNH", "PFE", "ABBV", "MRK", "LLY", "BMY", "AMGN"],
    "Consumer Cyclical":      ["AMZN", "TSLA", "HD", "NKE", "MCD", "SBUX", "TGT", "LOW"],
    "Consumer Defensive":     ["WMT", "COST", "PG", "KO", "PEP", "KR", "MDLZ", "CL"],
    "Consumer Staples":       ["WMT", "COST", "PG", "KO", "PEP", "KR", "MDLZ", "CL"],
    "Energy":                 ["XOM", "CVX", "COP", "SLB", "MPC", "VLO", "PSX", "OXY"],
    "Communication Services": ["GOOGL", "META", "NFLX", "DIS", "CMCSA", "T", "VZ", "ATVI"],
    "Industrials":            ["CAT", "DE", "RTX", "HON", "GE", "BA", "UPS", "LMT"],
    "Utilities":              ["NEE", "DUK", "SO", "AEP", "EXC", "SRE", "D", "XEL"],
    "Real Estate":            ["AMT", "PLD", "EQIX", "WELL", "SPG", "PSA", "DLR", "O"],
    "Basic Materials":        ["LIN", "APD", "SHW", "FCX", "NEM", "NUE", "ECL", "DOW"],
}
_FALLBACK_PEERS = ["AAPL", "MSFT", "GOOGL", "META", "NVDA", "AMD", "INTC", "AVGO"]

_peer_val_cache: TTLCache = TTLCache(maxsize=100, ttl=1800)
_peer_val_lock  = threading.Lock()


def _safe_float(val) -> float | None:
    try:
        f = float(val)
        return None if (f != f or abs(f) > 1e16) else round(f, 2)
    except Exception:
        return None


def _yf_peer_row(t: str) -> dict:
    from cache import get_info
    info = get_info(t)
    name = info.get("shortName") or info.get("longName") or t

    mktcap = _safe_float(info.get("marketCap"))
    fcf    = _safe_float(info.get("freeCashflow"))
    pfcf   = round(mktcap / fcf, 2) if mktcap and fcf and fcf > 0 else None

    return {
        "ticker":                 t,
        "name":                   name,
        "pe":                     _safe_float(info.get("trailingPE")),
        "ev_ebitda":              _safe_float(info.get("enterpriseToEbitda")),
        "ps":                     _safe_float(info.get("priceToSalesTrailing12Months")),
        "pb":                     _safe_float(info.get("priceToBook")),
        "pfcf":                   pfcf,
        "roe":                    _safe_float(info.get("returnOnEquity")),
        "revenue_growth":         _safe_float(info.get("revenueGrowth")),
        "price":                  _safe_float(info.get("currentPrice") or info.get("regularMarketPrice")),
        "recommendation_key":     info.get("recommendationKey"),
        "recommendation_mean":    _safe_float(info.get("recommendationMean")),
        "num_analyst_opinions":   info.get("numberOfAnalystOpinions"),
        "target_mean_price":      _safe_float(info.get("targetMeanPrice")),
    }


@router.get("/peer-valuation")
def peer_valuation(ticker: str):
    sym = validate_ticker(ticker)
    with _peer_val_lock:
        if sym in _peer_val_cache:
            return _peer_val_cache[sym]

    from cache import get_info
    info     = get_info(sym)
    sector   = info.get("sector") or ""
    industry = info.get("industry") or ""
    name     = info.get("shortName") or info.get("longName") or sym
    desc     = info.get("longBusinessSummary") or ""

    # Priority: Groq AI comps → broad sector map → fallback
    groq_peers = _get_groq_peers(sym, name, industry, desc)
    if groq_peers:
        raw_peers = _validate_tickers(groq_peers)   # drop delisted/invalid
        if not raw_peers:
            raw_peers = list(_SECTOR_PEERS.get(sector, _FALLBACK_PEERS))
    else:
        raw_peers = list(_SECTOR_PEERS.get(sector, _FALLBACK_PEERS))

    peers = [sym] + [p for p in raw_peers if p != sym][:7]

    import concurrent.futures
    with concurrent.futures.ThreadPoolExecutor(max_workers=8) as ex:
        futs = {t: ex.submit(_yf_peer_row, t) for t in peers}
    rows = [futs[t].result() for t in peers]
    # Filter out peers with no price data (truly delisted or invalid)
    rows = [r for r in rows if r["ticker"] == sym or r.get("price") is not None]

    result = {"ticker": sym, "sector": sector or None, "industry": industry or None, "peers": rows}
    with _peer_val_lock:
        _peer_val_cache[sym] = result
    return result


_supply_cache: TTLCache = TTLCache(maxsize=100, ttl=3600)
_supply_lock  = threading.Lock()


@router.get("/supply-chain")
def supply_chain(ticker: str):
    sym = validate_ticker(ticker)
    with _supply_lock:
        if sym in _supply_cache:
            return _supply_cache[sym]

    from cache import get_info
    info = get_info(sym)

    name        = info.get("shortName") or info.get("longName") or sym
    sector      = info.get("sector") or ""
    industry    = info.get("industry") or ""
    description = info.get("longBusinessSummary") or ""
    price       = _safe_float(info.get("currentPrice") or info.get("regularMarketPrice"))
    market_cap  = _safe_float(info.get("marketCap"))

    # Revenue segmentation — static product breakdown for major tickers,
    # scaled to actual TTM revenue from yfinance where available
    product_segments: list[dict] = []
    geo_segments_static: list[dict] = []
    total_rev: float = 0.0
    try:
        total_rev = 0.0
        try:
            t_obj = yf.Ticker(sym)
            stmt = t_obj.income_stmt
            if stmt is not None and not stmt.empty and "Total Revenue" in stmt.index:
                total_rev = float(stmt.loc["Total Revenue"].iloc[0])
        except Exception:
            pass
        if total_rev is None:
            total_rev = float(info.get("totalRevenue") or 0)

        def _segs(pcts: list[tuple[str, float]]) -> list[dict]:
            out = []
            for name, pct in pcts:
                value = round(total_rev * pct / 100) if total_rev else 0
                out.append({"name": name, "value": value, "pct": round(pct, 1)})
            return out

        _PRODUCT_MAP: dict[str, list[tuple[str, float]]] = {
            # ── Mega-cap Tech ──
            "AAPL":  [("iPhone", 52.3), ("Services", 22.2), ("Wearables, Home & Accessories", 9.1), ("Mac", 7.9), ("iPad", 8.5)],
            "MSFT":  [("Intelligent Cloud", 43.5), ("Productivity & Business Processes", 33.2), ("Personal Computing", 23.3)],
            "GOOGL": [("Google Search & Other", 57.0), ("Google Cloud", 11.4), ("YouTube Ads", 10.5), ("Google Network", 8.0), ("Google Other", 10.6), ("Other Bets", 0.5)],
            "GOOG":  [("Google Search & Other", 57.0), ("Google Cloud", 11.4), ("YouTube Ads", 10.5), ("Google Network", 8.0), ("Google Other", 10.6), ("Other Bets", 0.5)],
            "AMZN":  [("Online Stores", 38.5), ("Third-Party Seller Services", 23.1), ("AWS", 16.5), ("Advertising Services", 8.4), ("Subscription Services", 7.6), ("Physical Stores", 3.8), ("Other", 2.1)],
            "META":  [("Advertising (Family of Apps)", 97.5), ("Reality Labs", 2.5)],
            "NVDA":  [("Data Center", 83.0), ("Gaming", 9.0), ("Professional Visualization", 2.0), ("Automotive", 2.5), ("OEM & Other", 3.5)],
            "AMD":   [("Data Center", 52.0), ("Client", 28.0), ("Gaming", 12.0), ("Embedded", 8.0)],
            "INTC":  [("Intel Products", 80.0), ("Intel Foundry", 15.0), ("All Other", 5.0)],
            "TSLA":  [("Automotive", 84.0), ("Services & Other", 9.0), ("Energy Generation & Storage", 7.0)],
            "AVGO":  [("Semiconductor Solutions", 78.0), ("Infrastructure Software", 22.0)],
            "ORCL":  [("Cloud Services & License Support", 76.0), ("Cloud License & On-Premise License", 13.0), ("Hardware", 6.0), ("Services", 5.0)],
            "CRM":   [("Subscription & Support", 94.0), ("Professional Services", 6.0)],
            "ADBE":  [("Digital Media", 76.0), ("Digital Experience", 22.0), ("Publishing & Advertising", 2.0)],
            "NOW":   [("Subscription", 96.0), ("Professional Services & Other", 4.0)],
            "CSCO":  [("Products", 55.0), ("Services", 45.0)],
            "IBM":   [("Software", 42.0), ("Consulting", 33.0), ("Infrastructure", 25.0)],
            "ACN":   [("Technology Services", 55.0), ("Consulting", 30.0), ("Outsourcing", 15.0)],
            # ── Financials ──
            "JPM":   [("Consumer & Community Banking", 40.0), ("Corporate & Investment Bank", 35.0), ("Commercial Banking", 15.0), ("Asset & Wealth Management", 10.0)],
            "GS":    [("Global Banking & Markets", 60.0), ("Asset & Wealth Management", 22.0), ("Platform Solutions", 18.0)],
            "BAC":   [("Consumer Banking", 38.0), ("Global Wealth & Investment Management", 22.0), ("Global Banking", 22.0), ("Global Markets", 18.0)],
            "MS":    [("Institutional Securities", 52.0), ("Wealth Management", 37.0), ("Investment Management", 11.0)],
            "WFC":   [("Consumer Banking & Lending", 40.0), ("Commercial Banking", 22.0), ("Corporate & Investment Banking", 22.0), ("Wealth & Investment Management", 16.0)],
            "C":     [("Services", 40.0), ("Markets", 27.0), ("Banking", 18.0), ("US Personal Banking", 15.0)],
            "AXP":   [("US Consumer Services", 52.0), ("Commercial Services", 28.0), ("International Card Services", 20.0)],
            "BLK":   [("Investment Advisory & Admin Fees", 78.0), ("Performance Fees", 8.0), ("Technology Services", 8.0), ("Distribution Fees", 6.0)],
            "SCHW":  [("Net Interest Revenue", 52.0), ("Asset Management Fees", 26.0), ("Trading Revenue", 10.0), ("Other", 12.0)],
            "COF":   [("Credit Card", 73.0), ("Consumer Banking", 16.0), ("Commercial Banking", 11.0)],
            # ── Insurance ──
            "BRK-B": [("Insurance", 30.0), ("Railroad (BNSF)", 18.0), ("Utilities & Energy", 15.0), ("Manufacturing", 22.0), ("Services & Retail", 15.0)],
            "PGR":   [("Personal Lines", 80.0), ("Commercial Lines", 18.0), ("Other", 2.0)],
            "MET":   [("Group Benefits", 38.0), ("Retirement & Income Solutions", 30.0), ("Asia", 18.0), ("Latin America", 7.0), ("EMEA", 7.0)],
            # ── Payments ──
            "V":     [("Service Revenues", 60.0), ("Data Processing Revenues", 25.0), ("International Transaction Revenues", 15.0)],
            "MA":    [("Domestic Assessments", 34.0), ("Cross-Border Volume Fees", 27.0), ("Transaction Processing", 28.0), ("Other", 11.0)],
            "PYPL":  [("Transaction Revenues", 88.0), ("Other Value Added Services", 12.0)],
            "SQ":    [("Cash App", 51.0), ("Seller (Square)", 43.0), ("TIDAL & Other", 6.0)],
            "GPN":   [("Merchant Solutions", 72.0), ("Issuer Solutions", 25.0), ("Consumer Solutions", 3.0)],
            "FISV":  [("Merchant Acceptance", 51.0), ("Financial Solutions", 44.0), ("Corporate & Other", 5.0)],
            "FIS":   [("Banking Solutions", 56.0), ("Capital Markets Solutions", 37.0), ("Corporate & Other", 7.0)],
            "ADP":   [("Employer Services", 68.0), ("PEO & Insurance Solutions", 32.0)],
            "PAYX":  [("Management Solutions", 72.0), ("PEO & Insurance Solutions", 28.0)],
            "FOUR":  [("Payments", 76.0), ("Software & Services", 15.0), ("Other", 9.0)],
            "TOST":  [("Financial Technology Solutions", 74.0), ("Subscription Services", 22.0), ("Hardware", 4.0)],
            "HOOD":  [("Options", 41.0), ("Equities", 22.0), ("Crypto", 16.0), ("Net Interest", 17.0), ("Other", 4.0)],
            "SOFI":  [("Financial Services", 40.0), ("Lending", 42.0), ("Technology Platform", 18.0)],
            "AFRM":  [("Merchant Network Revenue", 58.0), ("Interest Income", 30.0), ("Gain on Sales", 12.0)],
            "UPST":  [("Revenue from Fees", 92.0), ("Net Interest Income", 8.0)],
            "COIN":  [("Transaction Revenue", 68.0), ("Subscription & Services", 32.0)],
            # ── Healthcare ──
            "JNJ":   [("MedTech", 55.0), ("Innovative Medicine", 45.0)],
            "PFE":   [("Primary Care", 25.0), ("Specialty Care", 22.0), ("Hospital", 18.0), ("Oncology", 20.0), ("Other", 15.0)],
            "ABBV":  [("Immunology", 55.0), ("Oncology", 14.0), ("Neuroscience", 12.0), ("Eye Care", 10.0), ("Other", 9.0)],
            "LLY":   [("Diabetes", 42.0), ("Obesity (GLP-1)", 35.0), ("Oncology", 10.0), ("Immunology", 8.0), ("Other", 5.0)],
            "MRK":   [("Oncology (Keytruda)", 44.0), ("Hospital Acute Care", 18.0), ("Vaccines", 15.0), ("Cardiovascular", 8.0), ("Other", 15.0)],
            "BMY":   [("Oncology", 35.0), ("Hematology", 28.0), ("Cardiovascular", 15.0), ("Immunology", 12.0), ("Other", 10.0)],
            "AMGN":  [("Immunology", 35.0), ("Oncology", 25.0), ("Cardiovascular", 18.0), ("Bone Health", 12.0), ("Other", 10.0)],
            "MRNA":  [("COVID-19 Vaccine", 65.0), ("RSV Vaccine", 20.0), ("Other Pipeline", 15.0)],
            "GILD":  [("HIV", 72.0), ("Oncology", 14.0), ("Liver Disease", 10.0), ("Other", 4.0)],
            "REGN":  [("Dupixent", 58.0), ("Eylea", 18.0), ("Libtayo", 8.0), ("Other", 16.0)],
            "ISRG":  [("Instruments & Accessories", 72.0), ("Systems", 16.0), ("Services", 12.0)],
            "DXCM":  [("Sensor Revenue", 76.0), ("Hardware (Transmitter/Receiver)", 18.0), ("Other", 6.0)],
            "VEEV":  [("Subscription Services", 80.0), ("Professional Services", 20.0)],
            "TDOC":  [("Integrated Care", 52.0), ("BetterHelp", 40.0), ("Other", 8.0)],
            "UNH":   [("UnitedHealthcare", 58.0), ("Optum Health", 20.0), ("Optum Rx", 14.0), ("Optum Insight", 8.0)],
            "CVS":   [("Health Care Benefits", 43.0), ("Pharmacy & Consumer Wellness", 36.0), ("Health Services (Caremark)", 21.0)],
            "HCA":   [("Inpatient Revenue", 55.0), ("Outpatient Revenue", 38.0), ("Other", 7.0)],
            # ── Consumer ──
            "NKE":   [("Footwear", 67.0), ("Apparel", 28.0), ("Equipment", 5.0)],
            "SBUX":  [("Americas", 67.0), ("International", 22.0), ("Channel Development", 8.0), ("Corporate & Other", 3.0)],
            "HD":    [("Building Materials & Garden", 25.0), ("Hardware & Electrical", 21.0), ("Plumbing, Heating & HVAC", 15.0), ("Appliances & Flooring", 14.0), ("Tools & Hardware", 14.0), ("Other", 11.0)],
            "LOW":   [("DIY & Pro", 65.0), ("Services & Installation", 22.0), ("Other", 13.0)],
            "MCD":   [("US Company-Operated", 26.0), ("US Franchised", 22.0), ("International Operated Markets", 33.0), ("International Developmental", 19.0)],
            "YUM":   [("KFC Division", 42.0), ("Taco Bell Division", 35.0), ("Pizza Hut Division", 16.0), ("Habit Burger", 7.0)],
            "WMT":   [("Walmart US", 70.0), ("Walmart International", 19.0), ("Sam's Club", 11.0)],
            "TGT":   [("General Merchandise", 48.0), ("Apparel & Accessories", 18.0), ("Food & Beverage", 20.0), ("Beauty & Household", 14.0)],
            "COST":  [("Merchandise Sales", 98.0), ("Membership Fees", 2.0)],
            "AMZN":  [("Online Stores", 38.5), ("Third-Party Seller Services", 23.1), ("AWS", 16.5), ("Advertising Services", 8.4), ("Subscription Services", 7.6), ("Physical Stores", 3.8), ("Other", 2.1)],
            # ── Consumer Staples ──
            "KO":    [("Sparkling Soft Drinks", 65.0), ("Water, Sports & Coffee", 18.0), ("Juice & Dairy", 12.0), ("Other", 5.0)],
            "PEP":   [("Frito-Lay North America", 26.0), ("PepsiCo Beverages NA", 28.0), ("Latin America", 12.0), ("Europe", 14.0), ("Africa, ME & South Asia", 7.0), ("Asia Pacific & China", 10.0), ("Quaker Foods", 3.0)],
            "PG":    [("Fabric & Home Care", 35.0), ("Baby, Feminine & Family Care", 25.0), ("Beauty", 20.0), ("Health Care", 13.0), ("Grooming", 7.0)],
            "CL":    [("Oral, Personal & Home Care", 80.0), ("Pet Nutrition (Hill's)", 20.0)],
            "MDLZ":  [("Chocolate", 34.0), ("Biscuits", 29.0), ("Gum & Candy", 15.0), ("Beverages", 13.0), ("Cheese & Grocery", 9.0)],
            # ── Energy ──
            "XOM":   [("Upstream", 40.0), ("Energy Products", 35.0), ("Chemical Products", 15.0), ("Specialty Products", 10.0)],
            "CVX":   [("Upstream", 55.0), ("Downstream", 35.0), ("Chemicals", 10.0)],
            "COP":   [("Lower 48", 55.0), ("Alaska", 12.0), ("International", 25.0), ("Other", 8.0)],
            "EOG":   [("Oil", 72.0), ("Natural Gas Liquids", 15.0), ("Natural Gas", 13.0)],
            "PXD":   [("Oil", 74.0), ("NGL", 14.0), ("Natural Gas", 12.0)],
            "SLB":   [("Well Construction", 30.0), ("Reservoir Performance", 25.0), ("Production Systems", 26.0), ("Digital & Integration", 19.0)],
            "HAL":   [("Completion & Production", 57.0), ("Drilling & Evaluation", 43.0)],
            "MPC":   [("Refining & Marketing", 82.0), ("Midstream (MPLX)", 18.0)],
            "VLO":   [("Refining", 85.0), ("Ethanol", 8.0), ("Renewable Diesel", 7.0)],
            # ── Industrials ──
            "CAT":   [("Construction Industries", 38.0), ("Resource Industries", 23.0), ("Energy & Transportation", 33.0), ("Financial Products", 6.0)],
            "DE":    [("Production & Precision Ag", 48.0), ("Small Ag & Turf", 18.0), ("Construction & Forestry", 28.0), ("Financial Services", 6.0)],
            "HON":   [("Aerospace Technologies", 38.0), ("Industrial Automation", 28.0), ("Building Automation", 22.0), ("Energy & Sustainability", 12.0)],
            "GE":    [("Aerospace", 78.0), ("Renewable Energy", 12.0), ("Power", 10.0)],
            "RTX":   [("Pratt & Whitney", 38.0), ("Collins Aerospace", 38.0), ("Raytheon", 24.0)],
            "BA":    [("Commercial Airplanes", 42.0), ("Defense, Space & Security", 37.0), ("Global Services", 21.0)],
            "LMT":   [("Aeronautics", 41.0), ("Missiles & Fire Control", 17.0), ("Rotary & Mission Systems", 26.0), ("Space", 16.0)],
            "NOC":   [("Aeronautics Systems", 25.0), ("Defense Systems", 18.0), ("Mission Systems", 30.0), ("Space Systems", 27.0)],
            "UPS":   [("US Domestic Package", 62.0), ("International Package", 21.0), ("Supply Chain Solutions", 17.0)],
            "FDX":   [("FedEx Express", 50.0), ("FedEx Ground", 32.0), ("FedEx Freight", 12.0), ("FedEx Services", 6.0)],
            # ── Media / Streaming ──
            "NFLX":  [("United States & Canada", 43.0), ("Europe, Middle East & Africa", 32.0), ("Latin America", 14.0), ("Asia-Pacific", 11.0)],
            "DIS":   [("Entertainment", 43.0), ("Sports (ESPN)", 29.0), ("Experiences", 28.0)],
            "PARA":  [("TV Media", 60.0), ("Direct-to-Consumer (Paramount+)", 22.0), ("Filmed Entertainment", 18.0)],
            "WBD":   [("Networks", 52.0), ("Max (DTC)", 22.0), ("Studios", 18.0), ("Other", 8.0)],
            "CMCSA": [("Cable Communications", 57.0), ("NBCUniversal Media", 25.0), ("NBCUniversal Studios", 10.0), ("Sky", 8.0)],
            "SPOT":  [("Premium (Subscribers)", 88.0), ("Ad-Supported", 12.0)],
            "ROKU":  [("Platform", 88.0), ("Devices (Players)", 12.0)],
            "TTD":   [("Programmatic Advertising", 97.0), ("Other", 3.0)],
            # ── Social / Consumer Internet ──
            "SNAP":  [("Advertising Revenue", 99.0), ("Other", 1.0)],
            "PINS":  [("Advertising Revenue", 99.0), ("Other", 1.0)],
            "RDDT":  [("Advertising", 90.0), ("Data Licensing & Other", 10.0)],
            "RBLX":  [("Robux & In-Experience", 95.0), ("Developer Exchange & Other", 5.0)],
            # ── Mobility / Delivery ──
            "UBER":  [("Mobility", 57.0), ("Delivery", 38.0), ("Freight", 5.0)],
            "LYFT":  [("Ridesharing", 96.0), ("Bikes & Scooters", 4.0)],
            "DASH":  [("US Marketplace", 72.0), ("International Marketplace", 18.0), ("Platform Services (Wolt)", 10.0)],
            "ABNB":  [("Accommodations", 92.0), ("Experiences", 8.0)],
            # ── E-commerce ──
            "SHOP":  [("Merchant Solutions", 73.0), ("Subscription Solutions", 27.0)],
            "ETSY":  [("Marketplace Revenue", 73.0), ("Services Revenue", 27.0)],
            "EBAY":  [("Net Transaction Revenues", 90.0), ("Marketing Services", 10.0)],
            # ── Cloud / SaaS ──
            "PLTR":  [("US Government", 55.0), ("US Commercial", 26.0), ("International Government", 11.0), ("International Commercial", 8.0)],
            "SNOW":  [("Product Revenue", 96.0), ("Professional Services", 4.0)],
            "DDOG":  [("Infrastructure Monitoring", 38.0), ("APM & Distributed Tracing", 28.0), ("Log Management", 20.0), ("Other Products", 14.0)],
            "NET":   [("Zero Trust Solutions", 35.0), ("Application Services", 30.0), ("Network Services", 25.0), ("Developer Platform", 10.0)],
            "HUBS":  [("Subscription", 95.0), ("Professional Services", 5.0)],
            "TEAM":  [("Subscriptions", 93.0), ("Maintenance", 5.0), ("Perpetual License", 2.0)],
            "MDB":   [("Subscription", 96.0), ("Services", 4.0)],
            "TWLO":  [("Messaging", 55.0), ("Voice", 15.0), ("Email", 14.0), ("Segment (Data)", 10.0), ("Other", 6.0)],
            "ZM":    [("Subscription", 93.0), ("Online (SMB)", 43.0), ("Enterprise", 50.0), ("Other", 7.0)],
            "DOCN":  [("Infrastructure", 68.0), ("Platform (App Platform)", 14.0), ("Databases", 11.0), ("Other", 7.0)],
            "GTLB":  [("Subscription", 91.0), ("License", 5.0), ("Professional Services", 4.0)],
            "WDAY":  [("Subscription Services", 85.0), ("Professional Services", 15.0)],
            "INTU":  [("Small Business & Self-Employed", 46.0), ("Consumer (TurboTax)", 32.0), ("Credit Karma", 15.0), ("ProConnect", 7.0)],
            "SMAR":  [("Subscription", 91.0), ("Professional Services", 9.0)],
            "BOX":   [("Subscription", 96.0), ("Professional Services", 4.0)],
            "DOCU":  [("Subscription", 96.0), ("Professional Services", 4.0)],
            # ── Cybersecurity ──
            "CRWD":  [("Endpoint Security", 36.0), ("Cloud Security", 25.0), ("Identity Security", 16.0), ("Threat Intelligence", 11.0), ("Other", 12.0)],
            "PANW":  [("Subscription & Support", 83.0), ("Product", 17.0)],
            "ZS":    [("Subscription", 97.0), ("Professional Services", 3.0)],
            "OKTA":  [("Subscription", 96.0), ("Professional Services", 4.0)],
            "S":     [("Subscription", 95.0), ("Professional Services", 5.0)],
            "CYBR":  [("Subscription", 72.0), ("Perpetual License", 16.0), ("Professional Services", 12.0)],
            # ── Semiconductors ──
            "QCOM":  [("QCT Handsets", 58.0), ("QCT IoT", 14.0), ("QCT Automotive", 8.0), ("QTL Licensing", 20.0)],
            "MU":    [("DRAM", 72.0), ("NAND", 25.0), ("Other", 3.0)],
            "AMAT":  [("Semiconductor Systems", 71.0), ("Applied Global Services", 24.0), ("Display & Adjacent Markets", 5.0)],
            "LRCX":  [("Systems", 78.0), ("Customer Support-Related Revenue", 22.0)],
            "KLAC":  [("Semiconductor Process Control", 89.0), ("Specialty Semiconductor Process", 7.0), ("PCB, Display & Component Inspection", 4.0)],
            "MRVL":  [("Data Center", 69.0), ("Carrier Infrastructure", 13.0), ("Enterprise Networking", 9.0), ("Consumer & Automotive", 9.0)],
            "ON":    [("Power Solutions Group", 55.0), ("Advanced Solutions Group", 28.0), ("Intelligent Sensing Group", 17.0)],
            "TSM":   [("High Performance Computing (AI)", 45.0), ("Smartphone", 38.0), ("IoT", 8.0), ("Automotive", 5.0), ("Consumer", 4.0)],
            "ARM":   [("Royalties", 60.0), ("License Fees", 40.0)],
            # ── Automotive / EV ──
            "F":     [("Ford Blue (ICE)", 60.0), ("Ford Model e (EV)", 8.0), ("Ford Pro (Commercial)", 25.0), ("Ford Credit", 7.0)],
            "GM":    [("GMNA", 80.0), ("GMI (International)", 12.0), ("Cruise (AV)", 3.0), ("GM Financial", 5.0)],
            "RIVN":  [("Vehicle Sales", 85.0), ("Software & Services", 15.0)],
            "LCID":  [("Vehicle Sales", 90.0), ("Other", 10.0)],
            # ── Telecom ──
            "T":     [("Mobility", 58.0), ("Business Wireline", 20.0), ("Consumer Wireline", 22.0)],
            "VZ":    [("Consumer Group", 72.0), ("Business Group", 28.0)],
            "TMUS":  [("Postpaid", 63.0), ("Prepaid", 13.0), ("Wholesale & Other", 24.0)],
            # ── REITs ──
            "AMT":   [("US Tower", 57.0), ("International Tower", 35.0), ("Data Centers", 8.0)],
            "EQIX":  [("Colocation", 68.0), ("Interconnection", 18.0), ("Managed Infrastructure", 9.0), ("Other", 5.0)],
            "PLD":   [("Rental Income", 78.0), ("Development", 12.0), ("Strategic Capital", 10.0)],
            "SPG":   [("Mall Revenue", 52.0), ("Premium Outlets Revenue", 36.0), ("Mills Revenue", 12.0)],
            "O":     [("Retail Properties", 82.0), ("Industrial", 10.0), ("Other", 8.0)],
            # ── Utilities ──
            "NEE":   [("FPL (Regulated)", 65.0), ("NextEra Energy Resources (Renewables)", 35.0)],
            "DUK":   [("Electric Utilities & Infrastructure", 85.0), ("Gas Utilities & Infrastructure", 15.0)],
        }

        _GEO_MAP: dict[str, list[tuple[str, float]]] = {
            "AAPL":  [("Americas", 44.0), ("Europe", 25.0), ("Greater China", 17.0), ("Japan", 6.0), ("Rest of Asia Pacific", 8.0)],
            "MSFT":  [("United States", 51.0), ("Other Countries", 49.0)],
            "GOOGL": [("United States", 48.0), ("Europe, Middle East & Africa", 30.0), ("Asia-Pacific", 15.0), ("Other Americas", 7.0)],
            "GOOG":  [("United States", 48.0), ("Europe, Middle East & Africa", 30.0), ("Asia-Pacific", 15.0), ("Other Americas", 7.0)],
            "AMZN":  [("North America", 61.0), ("International", 22.0), ("AWS", 17.0)],
            "META":  [("United States & Canada", 44.0), ("Europe", 22.0), ("Asia-Pacific", 20.0), ("Rest of World", 14.0)],
            "NVDA":  [("United States", 29.0), ("Taiwan", 22.0), ("Singapore", 18.0), ("China (incl. Hong Kong)", 13.0), ("Other", 18.0)],
            "TSLA":  [("United States", 46.0), ("China", 23.0), ("Other", 31.0)],
            "NFLX":  [("United States & Canada", 43.0), ("Europe, Middle East & Africa", 32.0), ("Latin America", 14.0), ("Asia-Pacific", 11.0)],
            "NKE":   [("North America", 41.0), ("Europe, Middle East & Africa", 28.0), ("Greater China", 15.0), ("Asia Pacific & Latin America", 16.0)],
            "PLTR":  [("United States", 67.0), ("International", 33.0)],
            "UBER":  [("United States & Canada", 52.0), ("Europe, Middle East & Africa", 25.0), ("Latin America", 13.0), ("Asia Pacific", 10.0)],
            "ABNB":  [("North America", 47.0), ("Europe, Middle East & Africa", 36.0), ("Latin America", 9.0), ("Asia Pacific", 8.0)],
            "SPOT":  [("Europe", 32.0), ("North America", 31.0), ("Latin America", 22.0), ("Rest of World", 15.0)],
            "SHOP":  [("United States", 71.0), ("International", 29.0)],
            "PYPL":  [("United States", 52.0), ("International", 48.0)],
            "COIN":  [("United States", 81.0), ("International", 19.0)],
            "TSM":   [("North America", 68.0), ("Asia Pacific", 16.0), ("Europe, Middle East & Africa", 6.0), ("China", 10.0)],
            "QCOM":  [("China", 56.0), ("Rest of World", 23.0), ("United States", 14.0), ("South Korea", 7.0)],
            "KO":    [("North America", 33.0), ("Latin America", 13.0), ("Europe, Middle East & Africa", 25.0), ("Asia Pacific", 15.0), ("Global Ventures", 6.0), ("Bottling Investments", 8.0)],
            "PEP":   [("United States", 57.0), ("International", 43.0)],
            # Extended geo coverage
            "ADBE":  [("Americas", 56.0), ("Europe, Middle East & Africa", 28.0), ("Asia-Pacific", 16.0)],
            "CRM":   [("Americas", 68.0), ("Europe", 21.0), ("Asia Pacific", 11.0)],
            "ORCL":  [("Americas", 55.0), ("Europe, Middle East & Africa", 28.0), ("Asia Pacific", 17.0)],
            "NOW":   [("North America", 60.0), ("Europe, Middle East & Africa", 25.0), ("Asia Pacific & Other", 15.0)],
            "CSCO":  [("Americas", 57.0), ("Europe, Middle East & Africa", 26.0), ("Asia Pacific, Japan & China", 17.0)],
            "IBM":   [("Americas", 44.0), ("Europe, Middle East & Africa", 33.0), ("Asia Pacific", 23.0)],
            "AVGO":  [("United States", 35.0), ("China (incl. Hong Kong)", 19.0), ("Singapore", 13.0), ("Other", 33.0)],
            "AMD":   [("United States", 19.0), ("Japan", 15.0), ("China (incl. Hong Kong)", 22.0), ("Other", 44.0)],
            "INTC":  [("China (incl. Hong Kong)", 26.0), ("United States", 23.0), ("Taiwan", 17.0), ("Other", 34.0)],
            "SNAP":  [("North America", 67.0), ("Europe", 19.0), ("Rest of World", 14.0)],
            "PINS":  [("United States", 66.0), ("Europe", 18.0), ("Rest of World", 16.0)],
            "DDOG":  [("United States", 72.0), ("International", 28.0)],
            "CRWD":  [("United States", 66.0), ("International", 34.0)],
            "PANW":  [("United States", 67.0), ("International", 33.0)],
            "ZS":    [("Americas", 64.0), ("Europe, Middle East & Africa", 22.0), ("Asia Pacific", 14.0)],
            "OKTA":  [("United States", 80.0), ("International", 20.0)],
            "NET":   [("United States", 49.0), ("International", 51.0)],
            "HUBS":  [("United States", 58.0), ("International", 42.0)],
            "MDB":   [("United States", 60.0), ("International", 40.0)],
            "SNOW":  [("United States", 77.0), ("International", 23.0)],
            "WDAY":  [("United States", 70.0), ("International", 30.0)],
            "INTU":  [("United States", 94.0), ("International", 6.0)],
            "DASH":  [("United States", 70.0), ("International", 30.0)],
            "LYFT":  [("United States", 100.0)],
            "TOST":  [("United States", 95.0), ("International", 5.0)],
            "SOFI":  [("United States", 100.0)],
            "AFRM":  [("United States", 97.0), ("Canada", 3.0)],
            "HOOD":  [("United States", 98.0), ("International", 2.0)],
            "FOUR":  [("United States", 82.0), ("International", 18.0)],
            "COIN":  [("United States", 81.0), ("International", 19.0)],
            "RIVN":  [("United States", 100.0)],
            "F":     [("United States", 62.0), ("Europe", 18.0), ("Rest of World", 20.0)],
            "GM":    [("North America", 82.0), ("International", 18.0)],
            "BA":    [("United States", 55.0), ("International", 45.0)],
            "RTX":   [("United States", 61.0), ("International", 39.0)],
            "LMT":   [("United States", 71.0), ("International", 29.0)],
            "CAT":   [("United States", 47.0), ("Asia Pacific", 21.0), ("EAME", 21.0), ("Latin America", 7.0), ("Canada", 4.0)],
            "DE":    [("United States & Canada", 73.0), ("Outside US & Canada", 27.0)],
            "HON":   [("United States", 57.0), ("Europe", 17.0), ("Asia Pacific", 15.0), ("Other", 11.0)],
            "MRK":   [("United States", 52.0), ("Outside US", 48.0)],
            "JNJ":   [("United States", 50.0), ("International", 50.0)],
            "PFE":   [("United States", 42.0), ("Developed Markets", 37.0), ("Emerging Markets", 21.0)],
            "ABBV":  [("United States", 68.0), ("International", 32.0)],
            "LLY":   [("United States", 55.0), ("Outside US", 45.0)],
            "AMGN":  [("United States", 74.0), ("International", 26.0)],
            "GILD":  [("United States", 73.0), ("Europe", 18.0), ("Other", 9.0)],
            "UNH":   [("United States", 100.0)],
            "CVS":   [("United States", 100.0)],
            "UPS":   [("United States Domestic", 63.0), ("International", 21.0), ("Supply Chain Solutions", 16.0)],
            "FDX":   [("United States", 72.0), ("International", 28.0)],
            "WMT":   [("United States", 80.0), ("International", 20.0)],
            "COST":  [("United States", 73.0), ("Canada", 15.0), ("Other International", 12.0)],
            "XOM":   [("United States", 40.0), ("Asia Pacific", 22.0), ("Europe", 16.0), ("Other Americas", 12.0), ("Africa", 10.0)],
            "CVX":   [("United States", 47.0), ("International", 53.0)],
            "T":     [("United States", 98.0), ("International", 2.0)],
            "VZ":    [("United States", 100.0)],
            "TMUS":  [("United States", 100.0)],
            "DIS":   [("United States & Canada", 62.0), ("Europe, Middle East & Africa", 20.0), ("Asia Pacific", 10.0), ("Latin America", 8.0)],
            "CMCSA": [("United States", 74.0), ("International (Sky)", 26.0)],
        }

        if sym in _PRODUCT_MAP:
            product_segments = _segs(_PRODUCT_MAP[sym])
        if sym in _GEO_MAP:
            geo_segments_static = _segs(_GEO_MAP[sym])
    except Exception:
        pass

    # Groq fallback for tickers not in static maps
    if not product_segments and not geo_segments_static and _GROQ:
        try:
            groq_segs = _get_groq_segments(sym, name, industry, description, total_rev)
            if groq_segs:
                product_segments   = groq_segs.get("product_segments", [])
                geo_segments_static = groq_segs.get("geo_segments", [])
        except Exception as e:
            _log.warning("Groq segments failed for %s: %s", sym, e)

    # Peers: Groq AI comps → sector map fallback
    groq_p = _get_groq_peers(sym, name, industry, description)
    raw_peers = groq_p if groq_p else list(_SECTOR_PEERS.get(sector, _FALLBACK_PEERS))
    peer_list  = [p for p in raw_peers if p != sym][:10]

    employees = _safe_float(info.get("fullTimeEmployees"))
    result = {
        "ticker":           sym,
        "name":             name,
        "sector":           sector,
        "industry":         industry,
        "description":      description,
        "price":            price,
        "market_cap":       market_cap,
        "employees":        int(employees) if employees else None,
        "product_segments": product_segments,
        "geo_segments":     geo_segments_static,
        "peers":            peer_list,
    }
    with _supply_lock:
        _supply_cache[sym] = result
    return result
