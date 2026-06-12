import logging
from fastapi import APIRouter, HTTPException
import yfinance as yf

router = APIRouter()
logger = logging.getLogger("backend.routers.corporate")

# Hardcoded institutional peer groups for relative valuation fallbacks
PEER_GROUPS = {
    "TECH": ["AAPL", "MSFT", "NVDA", "AVGO", "AMD", "INTC", "QCOM"],
    "COMM": ["GOOGL", "META", "NFLX", "TMUS", "DIS", "CHTR"],
    "CONS": ["AMZN", "TSLA", "WMT", "HD", "COST", "TGT"],
    "FIN":  ["JPM", "BAC", "MS", "GS", "WFC", "C"],
}

def _get_peers_for_ticker(ticker: str, sector: str) -> list:
    """Matches a ticker to an industry peer group for relative comps analysis."""
    sym = ticker.strip().upper()
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
            info = stock.info
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
            hist = stock.history(period="1mo")
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
        stock = yf.Ticker(symbol)
        try:
            info = stock.info or {}
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

        return {"ticker": symbol, "transactions": transactions}
    except Exception as e:
        logger.error(f"Error fetching insider data for {ticker}: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/profile")
async def get_corporate_profile(ticker: str):
    """Fetches deep corporate profile details, explicitly safeguarding executive list arrays."""
    try:
        symbol = ticker.strip().upper()
        stock = yf.Ticker(symbol)
        info = stock.info or {}

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
        stock = yf.Ticker(symbol)
        info = stock.info or {}
        
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
            try:
                roe = round(float(d["returnOnEquity"]) * 100, 2) if d.get("returnOnEquity") else None
            except (TypeError, ValueError):
                roe = None
            try:
                rev_growth = round(float(d["revenueGrowth"]) * 100, 2) if d.get("revenueGrowth") else None
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
                "ev_ebitda":            ev_ebitda,
                "ps":                   ps,
                "pb":                   pb,
                "pfcf":                 pfcf,
                "roe":                  roe,
                "revenue_growth":       rev_growth,
                "recommendation_key":   d.get("recommendationKey"),
                "recommendation_mean":  _n(d.get("recommendationMean")),
                "num_analyst_opinions": d.get("numberOfAnalystOpinions"),
                "target_mean_price":    _n(d.get("targetMeanPrice")),
            }

        # 1. Map Target Row
        comps.append(build_aligned_row(symbol, info, True))

        # 2. Map Peer Rows
        for peer in peers[:4]:
            try:
                p_stock = yf.Ticker(peer)
                p_info = p_stock.info
                if p_info is None or not isinstance(p_info, dict):
                    continue
                comps.append(build_aligned_row(peer, p_info, False))
            except Exception:
                continue

        return {
            "ticker":  symbol,
            "sector":  sector,
            "peers":   comps,
        }
    except Exception as e:
        logger.error(f"Error in peer valuation final recovery block: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/supply-chain")
async def get_supply_chain(ticker: str):
    """Company profile: basic info + product/geo revenue segments + peer list."""
    try:
        symbol = ticker.strip().upper()
        stock = yf.Ticker(symbol)

        try:
            info = stock.info or {}
        except Exception:
            info = {}

        price = safe_float(info, ["currentPrice", "previousClose", "navPrice"]) or None
        mcap  = safe_float(info, ["marketCap", "totalAssets"]) or None
        emp   = info.get("fullTimeEmployees")

        import fmp as _fmp
        product_segments = dict(_fmp.EMPTY_SEGMENTS)
        geo_segments     = dict(_fmp.EMPTY_SEGMENTS)
        try:
            if _fmp.available():
                product_segments = _fmp.get_revenue_segments(symbol)
                geo_segments     = _fmp.get_geo_segments(symbol)
        except Exception:
            pass

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
            "product_segments": product_segments,
            "geo_segments":     geo_segments,
            "peers":            peers,
        }
    except Exception as e:
        logger.error(f"Error in supply chain endpoint: {e}")
        raise HTTPException(status_code=500, detail=str(e))