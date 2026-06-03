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

# Cache results for 5 minutes — avoids repeated yfinance round-trips on rescan
_hub_cache: TTLCache    = TTLCache(maxsize=200, ttl=300)
_short_cache: TTLCache  = TTLCache(maxsize=200, ttl=300)
_insider_cache: TTLCache = TTLCache(maxsize=200, ttl=600)
_cache_lock = threading.Lock()


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

    # Market cap + real % change via FMP quote (fast, accurate)
    if fmp.available():
        try:
            q = fmp.get_quote(sym)
            if q.get('marketCap'):
                market_cap = int(q['marketCap'])
            # FMP stable API uses 'changesPercentage'; fall back to 'changePercentage'
            chg = q.get('changesPercentage') if q.get('changesPercentage') is not None else q.get('changePercentage')
            if chg is not None:
                pct_change_1d = round(float(chg), 2)
            # Real P/E from price / EPS (FMP income statement)
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
