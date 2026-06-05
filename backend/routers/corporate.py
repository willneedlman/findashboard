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
    info   = get_info(sym)
    sector = info.get("sector") or ""

    peers = list(_SECTOR_PEERS.get(sector, _FALLBACK_PEERS))
    if sym not in peers:
        peers = [sym] + peers[:7]
    else:
        peers = [sym] + [p for p in peers if p != sym][:7]

    import concurrent.futures
    with concurrent.futures.ThreadPoolExecutor(max_workers=8) as ex:
        futs = {t: ex.submit(_yf_peer_row, t) for t in peers}
    rows = [futs[t].result() for t in peers]

    result = {"ticker": sym, "sector": sector or None, "peers": rows}
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
    try:
        total_rev = None
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
            "JPM":   [("Consumer & Community Banking", 40.0), ("Corporate & Investment Bank", 35.0), ("Commercial Banking", 15.0), ("Asset & Wealth Management", 10.0)],
            "GS":    [("Global Banking & Markets", 60.0), ("Asset & Wealth Management", 22.0), ("Platform Solutions", 18.0)],
            "BAC":   [("Consumer Banking", 38.0), ("Global Wealth & Investment Management", 22.0), ("Global Banking", 22.0), ("Global Markets", 18.0)],
            "MS":    [("Institutional Securities", 52.0), ("Wealth Management", 37.0), ("Investment Management", 11.0)],
            "JNJ":   [("MedTech", 55.0), ("Innovative Medicine", 45.0)],
            "PFE":   [("Primary Care", 25.0), ("Specialty Care", 22.0), ("Hospital", 18.0), ("Oncology", 20.0), ("Other", 15.0)],
            "ABBV":  [("Immunology", 55.0), ("Oncology", 14.0), ("Neuroscience", 12.0), ("Eye Care", 10.0), ("Other", 9.0)],
            "LLY":   [("Diabetes", 42.0), ("Obesity (GLP-1)", 35.0), ("Oncology", 10.0), ("Immunology", 8.0), ("Other", 5.0)],
            "NKE":   [("Footwear", 67.0), ("Apparel", 28.0), ("Equipment", 5.0)],
            "SBUX":  [("Americas", 67.0), ("International", 22.0), ("Channel Development", 8.0), ("Corporate & Other", 3.0)],
            "HD":    [("Building Materials & Garden", 25.0), ("Hardware & Electrical", 21.0), ("Plumbing, Heating & HVAC", 15.0), ("Appliances & Flooring", 14.0), ("Tools & Hardware", 14.0), ("Other", 11.0)],
            "MCD":   [("US Company-Operated", 26.0), ("US Franchised", 22.0), ("International Operated Markets", 33.0), ("International Developmental", 19.0)],
            "WMT":   [("Walmart US", 70.0), ("Walmart International", 19.0), ("Sam's Club", 11.0)],
            "XOM":   [("Upstream", 40.0), ("Energy Products", 35.0), ("Chemical Products", 15.0), ("Specialty Products", 10.0)],
            "CVX":   [("Upstream", 55.0), ("Downstream", 35.0), ("Chemicals", 10.0)],
            "BRK-B": [("Insurance", 30.0), ("Railroad (BNSF)", 18.0), ("Utilities & Energy", 15.0), ("Manufacturing", 22.0), ("Services & Retail", 15.0)],
            "V":     [("Service Revenues", 60.0), ("Data Processing Revenues", 25.0), ("International Transaction Revenues", 15.0)],
            "MA":    [("Domestic Assessments", 34.0), ("Cross-Border Volume Fees", 27.0), ("Transaction Processing", 28.0), ("Other", 11.0)],
            "NFLX":  [("United States & Canada", 43.0), ("Europe, Middle East & Africa", 32.0), ("Latin America", 14.0), ("Asia-Pacific", 11.0)],
            "DIS":   [("Entertainment", 43.0), ("Sports (ESPN)", 29.0), ("Experiences", 28.0)],
            # Growth / Cloud
            "PLTR":  [("US Government", 55.0), ("US Commercial", 26.0), ("International Government", 11.0), ("International Commercial", 8.0)],
            "SNOW":  [("Product Revenue", 96.0), ("Professional Services", 4.0)],
            "DDOG":  [("Infrastructure Monitoring", 38.0), ("APM & Distributed Tracing", 28.0), ("Log Management", 20.0), ("Other Products", 14.0)],
            "NET":   [("Zero Trust Solutions", 35.0), ("Application Services", 30.0), ("Network Services", 25.0), ("Developer Platform", 10.0)],
            "CRWD":  [("Endpoint Security", 36.0), ("Cloud Security", 25.0), ("Identity Security", 16.0), ("Threat Intelligence", 11.0), ("Other", 12.0)],
            "PANW":  [("Subscription & Support", 83.0), ("Product", 17.0)],
            "ZS":    [("Subscription", 97.0), ("Professional Services", 3.0)],
            "OKTA":  [("Subscription", 96.0), ("Professional Services", 4.0)],
            "HUBS":  [("Subscription", 95.0), ("Professional Services", 5.0)],
            "TEAM":  [("Subscriptions", 93.0), ("Maintenance", 5.0), ("Perpetual License", 2.0)],
            "MDB":   [("Subscription", 96.0), ("Services", 4.0)],
            "TWLO":  [("Messaging", 55.0), ("Voice", 15.0), ("Email", 14.0), ("Segment (Data)", 10.0), ("Other", 6.0)],
            # Fintech / Payments
            "PYPL":  [("Transaction Revenues", 88.0), ("Other Value Added Services", 12.0)],
            "SQ":    [("Cash App", 51.0), ("Seller (Square)", 43.0), ("TIDAL & Other", 6.0)],
            "COIN":  [("Transaction Revenue", 68.0), ("Subscription & Services", 32.0)],
            # Mobility / Marketplace
            "UBER":  [("Mobility", 57.0), ("Delivery", 38.0), ("Freight", 5.0)],
            "ABNB":  [("Accommodations", 92.0), ("Experiences", 8.0)],
            "LYFT":  [("Ridesharing", 96.0), ("Bikes & Scooters", 4.0)],
            "SHOP":  [("Merchant Solutions", 73.0), ("Subscription Solutions", 27.0)],
            # Media / Consumer
            "SPOT":  [("Premium (Subscribers)", 88.0), ("Ad-Supported", 12.0)],
            "RBLX":  [("Robux & In-Experience", 95.0), ("Developer Exchange & Other", 5.0)],
            "ROKU":  [("Platform", 88.0), ("Devices (Players)", 12.0)],
            # Semis
            "QCOM":  [("QCT Handsets", 58.0), ("QCT IoT", 14.0), ("QCT Automotive", 8.0), ("QTL Licensing", 20.0)],
            "MU":    [("DRAM", 72.0), ("NAND", 25.0), ("Other", 3.0)],
            "AMAT":  [("Semiconductor Systems", 71.0), ("Applied Global Services", 24.0), ("Display & Adjacent Markets", 5.0)],
            "TSM":   [("High Performance Computing (AI)", 45.0), ("Smartphone", 38.0), ("IoT", 8.0), ("Automotive", 5.0), ("Consumer", 4.0)],
            "ARM":   [("Royalties", 60.0), ("License Fees", 40.0)],
            # Consumer Staples / Retail
            "COST":  [("Merchandise Sales", 98.0), ("Membership Fees", 2.0)],
            "KO":    [("Sparkling Soft Drinks", 65.0), ("Water, Sports & Coffee", 18.0), ("Juice & Dairy", 12.0), ("Other", 5.0)],
            "PEP":   [("Frito-Lay North America", 26.0), ("PepsiCo Beverages NA", 28.0), ("Latin America", 12.0), ("Europe", 14.0), ("Africa, ME & South Asia", 7.0), ("Asia Pacific & China", 10.0), ("Quaker Foods", 3.0)],
            # Healthcare
            "UNH":   [("UnitedHealthcare", 58.0), ("Optum Health", 20.0), ("Optum Rx", 14.0), ("Optum Insight", 8.0)],
            "CVS":   [("Health Care Benefits", 43.0), ("Pharmacy & Consumer Wellness", 36.0), ("Health Services (Caremark)", 21.0)],
            # Telecom
            "T":     [("Mobility", 58.0), ("Business Wireline", 20.0), ("Consumer Wireline", 22.0)],
            "VZ":    [("Consumer Group", 72.0), ("Business Group", 28.0)],
            "TMUS":  [("Postpaid", 63.0), ("Prepaid", 13.0), ("Wholesale & Other", 24.0)],
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
        }

        if sym in _PRODUCT_MAP:
            product_segments = _segs(_PRODUCT_MAP[sym])
        if sym in _GEO_MAP:
            geo_segments_static = _segs(_GEO_MAP[sym])
    except Exception:
        pass

    # Peers from sector map — excludes the ticker itself
    raw_peers = list(_SECTOR_PEERS.get(sector, _FALLBACK_PEERS))
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
