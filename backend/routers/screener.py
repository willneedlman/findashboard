import logging
import concurrent.futures
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field
from cachetools import TTLCache
import threading
import yfinance as yf
import numpy as np
import sys, os
sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))
import fmp
from validation import validate_ticker

logger = logging.getLogger(__name__)
router = APIRouter()

_screen_cache: TTLCache = TTLCache(maxsize=50, ttl=3600)   # 1 hr — screener results rarely change intraday
_detail_cache: TTLCache = TTLCache(maxsize=500, ttl=3600)  # 1 hr
_lock = threading.Lock()

try:
    from disk_cache import disk_get, disk_set
    _DISK = True
except ImportError:
    _DISK = False
    def disk_get(_k): return None  # type: ignore
    def disk_set(_k, _v, ttl=0): pass  # type: ignore

# ── Request schema ────────────────────────────────────────────────────────────

class FilterRule(BaseModel):
    field:    str
    operator: str   # gt | lt | gte | lte | eq | between
    value:    float
    value2:   float | None = None  # for 'between'

class ScreenRequest(BaseModel):
    filters:    list[FilterRule] = []
    sector:     str | None = None
    industry:   str | None = None
    exchange:   str | None = None
    sort_by:    str = "marketCap"
    sort_dir:   str = "desc"
    limit:      int = Field(default=50, ge=1, le=200)

# ── Field definitions visible to the frontend ─────────────────────────────────

SCREENER_FIELDS = [
    # Price & Market
    {"id": "price",          "label": "Price ($)",           "group": "Price & Market"},
    {"id": "marketCap",      "label": "Market Cap ($B)",      "group": "Price & Market"},
    {"id": "volume",         "label": "Volume",               "group": "Price & Market"},
    {"id": "avgVolume",      "label": "Avg Volume",           "group": "Price & Market"},
    {"id": "beta",           "label": "Beta",                 "group": "Price & Market"},
    {"id": "change1d",       "label": "1D Change (%)",        "group": "Price & Market"},
    {"id": "change52wHiPct", "label": "% Below 52W High",    "group": "Price & Market"},
    # Valuation
    {"id": "peRatio",        "label": "P/E Ratio",            "group": "Valuation"},
    {"id": "forwardPE",      "label": "Forward P/E",          "group": "Valuation"},
    {"id": "pbRatio",        "label": "P/B Ratio",            "group": "Valuation"},
    {"id": "psRatio",        "label": "P/S Ratio",            "group": "Valuation"},
    {"id": "evEbitda",       "label": "EV/EBITDA",            "group": "Valuation"},
    {"id": "pegRatio",       "label": "PEG Ratio",            "group": "Valuation"},
    # Growth
    {"id": "revenueGrowth",  "label": "Revenue Growth YoY (%)", "group": "Growth"},
    {"id": "epsGrowth",      "label": "EPS Growth YoY (%)",  "group": "Growth"},
    # Profitability
    {"id": "grossMargin",    "label": "Gross Margin (%)",     "group": "Profitability"},
    {"id": "operatingMargin","label": "Operating Margin (%)", "group": "Profitability"},
    {"id": "netMargin",      "label": "Net Margin (%)",       "group": "Profitability"},
    {"id": "roe",            "label": "ROE (%)",              "group": "Profitability"},
    {"id": "roa",            "label": "ROA (%)",              "group": "Profitability"},
    # Financial Health
    {"id": "debtEquity",     "label": "Debt / Equity",        "group": "Financial Health"},
    {"id": "currentRatio",   "label": "Current Ratio",        "group": "Financial Health"},
    {"id": "interestCoverage","label": "Interest Coverage",   "group": "Financial Health"},
    # Dividends
    {"id": "dividendYield",  "label": "Dividend Yield (%)",   "group": "Dividends"},
    {"id": "payoutRatio",    "label": "Payout Ratio (%)",     "group": "Dividends"},
]

SECTORS = ["Technology","Healthcare","Financial Services","Consumer Cyclical",
           "Industrials","Communication Services","Consumer Defensive",
           "Energy","Utilities","Real Estate","Basic Materials"]

EXCHANGES = ["NASDAQ", "NYSE", "AMEX"]

@router.get("/fields")
def get_fields():
    return {"fields": SCREENER_FIELDS, "sectors": SECTORS, "exchanges": EXCHANGES}

# ── FMP screener params builder ───────────────────────────────────────────────

def _fmp_params_from_filters(filters: list[FilterRule], sector, exchange, limit) -> dict:
    p: dict = {"limit": min(limit * 4, 500)}  # over-fetch; we filter more precisely client-side
    if sector:
        p["sector"] = sector
    if exchange:
        p["exchange"] = exchange

    field_map = {
        "marketCap":     ("marketCapMoreThan", "marketCapLessThan", 1e9),
        "price":         ("priceMoreThan",     "priceLessThan",     1),
        "volume":        ("volumeMoreThan",    "volumeLessThan",    1),
        "beta":          ("betaMoreThan",      "betaLessThan",      1),
        "dividendYield": ("dividendMoreThan",  "dividendLessThan",  0.01),
    }

    for f in filters:
        if f.field not in field_map:
            continue
        more_key, less_key, scale = field_map[f.field]
        val = f.value * scale
        if f.operator in ("gt", "gte"):
            p[more_key] = val
        elif f.operator in ("lt", "lte"):
            p[less_key] = val
        elif f.operator == "between" and f.value2 is not None:
            p[more_key] = val
            p[less_key] = f.value2 * scale

    return p

# ── Detail enrichment per ticker ──────────────────────────────────────────────

def _enrich(ticker: str, base: dict) -> dict:
    cache_key = ticker
    with _lock:
        if cache_key in _detail_cache:
            return {**base, **_detail_cache[cache_key]}

    try:
        tkr = yf.Ticker(ticker)
        fi = tkr.fast_info

        hi52       = getattr(fi, "year_high",                    None)
        last_price = getattr(fi, "last_price",                   None)
        prev_close = getattr(fi, "previous_close",               None)
        avg_vol    = getattr(fi, "three_month_average_volume",   None)
        price      = base.get("price") or last_price

        change52 = round((price / hi52 - 1) * 100, 1) if hi52 and price and hi52 > 0 else None

        # Always calculate 1D% from fast_info; only fall back to base if unavailable
        change1d = base.get("change1d")
        if change1d is None and prev_close and last_price and prev_close > 0:
            change1d = round((last_price / prev_close - 1) * 100, 2)

        detail: dict = {
            "avgVolume":      int(avg_vol) if avg_vol else None,
            "change52wHiPct": change52,
            "change1d":       change1d,
        }

        fmp_ok = False
        if fmp.available():
            try:
                prof = fmp.get_profile(ticker)
                inc  = fmp.get_income(ticker, 2)
                bal  = fmp.get_balance(ticker)
                income       = inc[0] if inc else {}
                income_prior = inc[1] if len(inc) > 1 else {}

                rev       = income.get("revenue") or 0
                rev_prior = income_prior.get("revenue") or 0
                eps       = income.get("epsDiluted") or 0
                eps_prior = income_prior.get("epsDiluted") or 0
                gross     = income.get("grossProfit") or 0
                op_inc    = income.get("operatingIncome") or 0
                net_inc   = income.get("netIncome") or 0
                price_val = prof.get("price") or price
                mktcap    = prof.get("marketCap") or 0
                ebitda    = income.get("ebitda") or 0
                total_debt      = bal.get("totalDebt") or 0
                equity          = bal.get("totalStockholdersEquity") or 1
                total_assets    = bal.get("totalAssets") or 1
                current_assets  = bal.get("totalCurrentAssets") or 0
                current_liab    = bal.get("totalCurrentLiabilities") or 1
                interest        = abs(income.get("interestExpense") or 0)
                ev_raw          = mktcap + total_debt - (bal.get("cashAndCashEquivalents") or 0)

                detail.update({
                    "companyName":    prof.get("companyName") or base.get("companyName"),
                    "sector":         prof.get("sector") or base.get("sector"),
                    "industry":       prof.get("industry") or base.get("industry"),
                    "peRatio":        round(price_val / eps, 1) if eps > 0 and price_val else None,
                    "forwardPE":      None,
                    "pbRatio":        round(mktcap / equity, 2) if equity > 0 else None,
                    "psRatio":        round(mktcap / rev, 2) if rev > 0 else None,
                    "evEbitda":       round(ev_raw / ebitda, 1) if ebitda > 0 else None,
                    "grossMargin":    round(gross / rev * 100, 1) if rev else None,
                    "operatingMargin":round(op_inc / rev * 100, 1) if rev else None,
                    "netMargin":      round(net_inc / rev * 100, 1) if rev else None,
                    "roe":            round(net_inc / equity * 100, 1) if equity > 0 else None,
                    "roa":            round(net_inc / total_assets * 100, 1) if total_assets > 0 else None,
                    "debtEquity":     round(total_debt / equity, 2) if equity > 0 else None,
                    "currentRatio":   round(current_assets / current_liab, 2) if current_liab > 0 else None,
                    "interestCoverage": round(op_inc / interest, 1) if interest > 0 else None,
                    "revenueGrowth":  round((rev / rev_prior - 1) * 100, 1) if rev and rev_prior else None,
                    "epsGrowth":      round((eps / eps_prior - 1) * 100, 1) if eps and eps_prior and eps_prior > 0 else None,
                    "dividendYield":  round((prof.get("lastAnnualDividend") or 0) / price_val * 100, 2) if price_val and price_val > 0 else None,
                })
                fmp_ok = True
            except Exception:
                pass

        # Always use yfinance for company name if FMP didn't provide it or it equals the ticker
        company_from_base = base.get("companyName") or ""
        needs_name = not detail.get("companyName") or detail.get("companyName") == ticker

        if not fmp_ok or needs_name:
            try:
                info_dict = tkr.info
                cn = info_dict.get("longName") or info_dict.get("shortName")
                if cn:
                    detail["companyName"] = cn
                # Fill fundamentals from yfinance when FMP was unavailable/failed
                if not fmp_ok:
                    detail.update({
                        "peRatio":        info_dict.get("trailingPE"),
                        "forwardPE":      info_dict.get("forwardPE"),
                        "pbRatio":        info_dict.get("priceToBook"),
                        "psRatio":        info_dict.get("priceToSalesTrailing12Months"),
                        "evEbitda":       info_dict.get("enterpriseToEbitda"),
                        "pegRatio":       info_dict.get("trailingPegRatio"),
                        "grossMargin":    round((info_dict.get("grossMargins") or 0) * 100, 1),
                        "operatingMargin":round((info_dict.get("operatingMargins") or 0) * 100, 1),
                        "netMargin":      round((info_dict.get("profitMargins") or 0) * 100, 1),
                        "roe":            round((info_dict.get("returnOnEquity") or 0) * 100, 1),
                        "roa":            round((info_dict.get("returnOnAssets") or 0) * 100, 1),
                        "debtEquity":     info_dict.get("debtToEquity"),
                        "currentRatio":   info_dict.get("currentRatio"),
                        "revenueGrowth":  round((info_dict.get("revenueGrowth") or 0) * 100, 1),
                        "epsGrowth":      round((info_dict.get("earningsGrowth") or 0) * 100, 1),
                        "dividendYield":  round((info_dict.get("dividendYield") or 0) * 100, 2),
                        "sector":         info_dict.get("sector") or base.get("sector"),
                        "industry":       info_dict.get("industry") or base.get("industry"),
                    })
            except Exception:
                if needs_name:
                    detail["companyName"] = company_from_base or ticker

    except Exception as e:
        logger.warning("enrich %s: %s", ticker, e)
        detail = {}

    with _lock:
        _detail_cache[cache_key] = detail

    return {**base, **detail}

# ── Filter application ────────────────────────────────────────────────────────

def _passes(row: dict, filters: list[FilterRule]) -> bool:
    for f in filters:
        val = row.get(f.field)
        if val is None:
            return False
        try:
            v = float(val)
            fv = float(f.value)
        except (TypeError, ValueError):
            continue
        if   f.operator in ("gt",  ">"):  ok = v > fv
        elif f.operator in ("gte", ">="): ok = v >= fv
        elif f.operator in ("lt",  "<"):  ok = v < fv
        elif f.operator in ("lte", "<="): ok = v <= fv
        elif f.operator == "eq":          ok = abs(v - fv) < 0.01
        elif f.operator == "between" and f.value2 is not None:
            ok = fv <= v <= float(f.value2)
        else:
            ok = True
        if not ok:
            return False
    return True

# ── Main screen endpoint ──────────────────────────────────────────────────────

@router.post("/run")
def run_screen(req: ScreenRequest):
    import json, hashlib
    cache_key = hashlib.md5(json.dumps(req.model_dump(), sort_keys=True).encode()).hexdigest()
    with _lock:
        if cache_key in _screen_cache:
            return _screen_cache[cache_key]
    disk_val = disk_get(f"screen:{cache_key}")
    if disk_val is not None:
        with _lock:
            _screen_cache[cache_key] = disk_val
        return disk_val

    candidates: list[dict] = []

    if fmp.available():
        try:
            params = _fmp_params_from_filters(req.filters, req.sector, req.exchange, req.limit)
            raw = fmp._get("/stock-screener", params)
            if isinstance(raw, list):
                for r in raw:
                    candidates.append({
                        "ticker":      r.get("symbol", ""),
                        "companyName": r.get("companyName", ""),
                        "price":       r.get("price"),
                        "marketCap":   round((r.get("marketCap") or 0) / 1e9, 2),
                        "beta":        r.get("beta"),
                        "volume":      r.get("volume"),
                        "sector":      r.get("sector", ""),
                        "industry":    r.get("industry", ""),
                        "exchange":    r.get("exchangeShortName", ""),
                        "change1d":    r.get("changesPercentage"),
                    })
        except Exception as e:
            logger.warning("FMP screener error: %s", e)

    # Fallback: sector-aware liquid tickers via yfinance
    SECTOR_TICKERS: dict[str, list[str]] = {
        "technology":            ["AAPL","MSFT","NVDA","GOOGL","META","ORCL","AMD","CSCO","ADBE","CRM","INTC","QCOM","TXN","AMAT","LRCX","MU","KLAC","SNPS","CDNS","ACN","IBM","INTU","NOW","PANW","CRWD"],
        "healthcare":            ["UNH","LLY","JNJ","ABBV","MRK","TMO","ABT","BMY","AMGN","DHR","PFE","CVS","CI","BSX","ELV","MDT","ISRG","VRTX","REGN","GILD","HCA","HUM","CNC","ZBH","MOH"],
        "financial services":    ["BRK-B","JPM","V","MA","BAC","GS","MS","AXP","BLK","SPGI","CME","ICE","SCHW","USB","WFC","C","PNC","TFC","MTB","ALLY","COF","SYF","DFS","FITB","KEY"],
        "consumer cyclical":     ["AMZN","TSLA","HD","MCD","NKE","SBUX","TGT","LOW","COST","BKNG","MAR","HLT","ROST","TJX","DHI","LEN","NVR","PHM","F","GM","UBER","LYFT","SHOP","W","ETSY"],
        "industrials":           ["CAT","RTX","HON","UPS","DE","BA","MMM","GE","LMT","NOC","GD","EMR","ETN","PH","ROK","CMI","PCAR","FDX","CSX","NSC","UNP","WM","RSG","EXPD","XPO"],
        "communication services":["GOOGL","META","DIS","CMCSA","NFLX","VZ","T","TMUS","ATVI","EA","TTWO","SNAP","PINS","MTCH","FOXA","PARA","WBD","IPG","OMC","NYT","IAC","ZM","TWLO","BANDWIDTH","SEZL"],
        "consumer defensive":    ["WMT","PG","KO","PEP","MO","PM","COST","MDLZ","CL","KMB","GIS","K","CPB","HRL","CAG","SJM","MKC","CHD","CLX","TSN","KHC","ADM","BG","CALM","POST"],
        "energy":                ["XOM","CVX","COP","EOG","SLB","PXD","MPC","VLO","PSX","OXY","DVN","HAL","BKR","FANG","APA","HES","MRO","PR","CLR","SM","RRC","AR","CNX","CTRA","EQT"],
        "utilities":             ["NEE","DUK","SO","D","AEP","SRE","EXC","XEL","PEG","ED","ES","EIX","FE","ETR","PPL","AES","NI","WEC","CMS","LNT","EVRG","ATO","NWE","OGE","AVA","PNW","OTTR","POR","MGEE","IDACORP","BKH","PNM","UIL","UGI"],
        "real estate":           ["PLD","AMT","EQIX","CCI","SPG","O","PSA","WELL","DLR","AVB","EQR","MAA","UDR","CPT","ESS","NNN","VICI","GLPI","MGM","MPW","VTR","PEAK","ARE","BXP","KIM"],
        "basic materials":       ["LIN","APD","ECL","SHW","FCX","NEM","NUE","STLD","RS","VMC","MLM","MOS","CF","DOW","LYB","PPG","RPM","EMN","HUN","OLN","ATI","CC","CSTM","AA","X"],
    }
    LIQUID_TICKERS = [
        "AAPL","MSFT","NVDA","AMZN","GOOGL","META","TSLA","BRK-B","JPM","V",
        "UNH","XOM","LLY","JNJ","WMT","MA","PG","HD","MRK","ORCL",
        "COST","ABBV","CVX","BAC","NFLX","KO","PEP","ADBE","TMO","CSCO",
        "AMD","ACN","MCD","NKE","DHR","INTC","QCOM","IBM","TXN","PM",
        "UPS","CAT","RTX","HON","AMGN","SBUX","GE","DE","BA","MMM",
        "GS","MS","AXP","BLK","SPGI","CME","ICE","SCHW","USB","WFC",
        "DIS","CMCSA","VZ","T","TMUS","CRM","NOW","INTU","AMAT","LRCX",
        "MU","KLAC","SNPS","CDNS","PANW","CRWD","ZS","OKTA","DDOG","NET",
        "SHOP","SQ","PYPL","COIN","HOOD","MSTR","PLTR","RBLX","UBER","LYFT",
    ]

    if not candidates:
        filter_sector = req.sector.lower() if req.sector else None
        # Use sector-specific tickers when sector is requested; otherwise use broad list
        if filter_sector and filter_sector in SECTOR_TICKERS:
            tickers_to_fetch = SECTOR_TICKERS[filter_sector]
        else:
            tickers_to_fetch = LIQUID_TICKERS

        def _quick(tk):
            try:
                fi = yf.Ticker(tk).fast_info
                price = getattr(fi, "last_price", None)
                mc    = getattr(fi, "market_cap", None)
                return {"ticker": tk, "companyName": tk,
                        "price":     round(float(price), 2) if price else None,
                        "marketCap": round(float(mc) / 1e9, 2) if mc else None,
                        "beta": None, "volume": None, "sector": "", "industry": "", "exchange": ""}
            except Exception:
                return None

        with concurrent.futures.ThreadPoolExecutor(max_workers=15) as ex:
            results = list(ex.map(_quick, tickers_to_fetch))
        candidates = [r for r in results if r and r.get("price")]
        # Pre-fill sector so post-enrichment filter doesn't strip them if yfinance/FMP fails
        if filter_sector and req.sector:
            for c in candidates:
                if not c.get("sector"):
                    c["sector"] = req.sector

    if not candidates:
        try:
            from ai_client import groq_complete, parse_json
            import json as _json
            tickers_str = ", ".join(LIQUID_TICKERS[:20])
            raw = groq_complete(
                f"Return estimated fundamentals for: {tickers_str}\n"
                "JSON array with fields: ticker, companyName, sector, exchange, marketCap(B), "
                "peRatio, operatingMargin(%), netMargin(%), revenueGrowth(%), beta, price, isAiEstimate=true. "
                "No markdown, just the array.",
                max_tokens=1500,
            )
            ai_rows = parse_json(raw)
            if isinstance(ai_rows, list):
                candidates = [
                    {
                        "ticker":    r.get("ticker", ""),
                        "companyName": r.get("companyName", r.get("ticker", "")),
                        "price":     r.get("price"),
                        "marketCap": r.get("marketCap"),
                        "peRatio":   r.get("peRatio"),
                        "operatingMargin": r.get("operatingMargin"),
                        "netMargin": r.get("netMargin"),
                        "revenueGrowth": r.get("revenueGrowth"),
                        "beta":      r.get("beta"),
                        "sector":    r.get("sector", ""),
                        "exchange":  r.get("exchange", ""),
                        "isAiEstimate": True,
                        "change1d": None, "volume": None, "forwardPE": None,
                        "pbRatio": None, "psRatio": None, "evEbitda": None,
                        "grossMargin": None, "roe": None, "debtEquity": None,
                        "currentRatio": None, "epsGrowth": None,
                        "dividendYield": None, "change52wHiPct": None, "avgVolume": None,
                    }
                    for r in ai_rows if r.get("ticker")
                ]
        except Exception as e:
            logger.warning("AI screener fallback failed: %s", e)

    if not candidates:
        raise HTTPException(503, "No data source available. Configure FMP_API_KEY for best results.")

    # Enrich top candidates in parallel (cap at 150 to leave room for sector/exchange filtering)
    to_enrich = candidates[:150]
    with concurrent.futures.ThreadPoolExecutor(max_workers=10) as ex:
        enriched = list(ex.map(lambda c: _enrich(c["ticker"], c), to_enrich))

    # Apply sector / exchange filters (post-enrichment so sector data is populated)
    if req.sector:
        fs = req.sector.lower()
        enriched = [r for r in enriched if (r.get("sector") or "").lower() == fs]
    if req.exchange:
        fe = req.exchange.lower()
        enriched = [r for r in enriched if (r.get("exchange") or "").lower() == fe]

    # Apply precise client-side filters
    filtered = [r for r in enriched if _passes(r, req.filters)]

    # Sort
    reverse = req.sort_dir == "desc"
    STRING_FIELDS = {"ticker", "name", "sector", "industry"}
    def sort_key(r):
        v = r.get(req.sort_by)
        if req.sort_by in STRING_FIELDS:
            return str(v).lower() if v is not None else ""
        if v is None:
            return float("-inf") if reverse else float("inf")
        try:
            return float(v)
        except (TypeError, ValueError):
            return float("-inf") if reverse else float("inf")
    filtered.sort(key=sort_key, reverse=reverse)

    result = {"results": filtered[:req.limit], "total": len(filtered)}
    with _lock:
        _screen_cache[cache_key] = result
    disk_set(f"screen:{cache_key}", result, ttl=3600)
    return result
