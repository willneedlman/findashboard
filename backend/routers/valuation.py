"""Stock-valuation models beyond DCF: SOTP, dividend discount, multiples.
The DCF and reverse-DCF live in dcf.py; this router holds the rest of the
Stock Valuation tool's tabs."""
import logging
logger = logging.getLogger(__name__)

from fastapi import APIRouter, HTTPException
import sys, os
sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))
import fmp
import sec_segments
from validation import validate_ticker

router = APIRouter()


def _fundamentals(ticker: str) -> dict:
    """Shares (M), net debt ($M), market price — reused across the SOTP/DDM tabs."""
    if fmp.available():
        try:
            return fmp.get_dcf_fundamentals(ticker)
        except Exception:
            pass
    from cache import get_info
    info = get_info(ticker)
    shares     = (info.get("sharesOutstanding") or 0) / 1e6
    total_debt = (info.get("totalDebt") or 0) / 1e6
    cash       = (info.get("totalCash") or info.get("cashAndCashEquivalents") or 0) / 1e6
    price      = float(info.get("currentPrice") or info.get("regularMarketPrice") or 0) or None
    return {"shares": shares, "net_debt": total_debt - cash, "market_price": price}


# Bundled sector P/S reference snapshot (US median price/sales, refresh annually —
# same fallback pattern as data/damodaran.json). These are the "if each part traded
# like its pure-play peers" anchors the SOTP tab offers as a one-click apply.
SECTOR_PS = {
    "Software / Cloud":       7.5,
    "Semiconductors":         6.0,
    "Payments / Fintech":     6.0,
    "Internet / Media":       4.5,
    "Healthcare / Pharma":    3.5,
    "Gaming / Entertainment": 3.0,
    "Financials / Banks":     2.5,
    "Advertising":            2.5,
    "Consumer Electronics":   2.2,
    "Hardware / Devices":     2.0,
    "Aerospace / Defense":    1.9,
    "Industrials":            1.8,
    "Telecom":                1.5,
    "Consumer Staples":       1.4,
    "E-commerce / Retail":    1.2,
    "Energy":                 1.1,
    "Automotive":             0.8,
}

# Keyword → sector, checked in order so more specific tags win. Best-effort: the
# UI pre-selects the guess but never forces it into the headline value.
_SECTOR_KEYWORDS = [
    ("Semiconductors",         ("semiconduct", "chip", "silicon", "processor", "gpu", "foundry", "data center", "datacenter")),
    ("Software / Cloud",       ("cloud", "azure", "aws", "saas", "software", "platform", "subscription", "license")),
    ("Payments / Fintech",     ("payment", "fintech", "merchant", "card network")),
    ("Gaming / Entertainment", ("gaming", "game", "xbox", "console", "studio")),
    ("Advertising",            ("advertis", "ad ", "ads", "marketing")),
    ("Internet / Media",       ("service", "search", "youtube", "media", "streaming", "content", "network")),
    ("Consumer Electronics",   ("wearable", "accessor", "audio", "headphone")),
    ("Hardware / Devices",     ("iphone", "mac", "ipad", "device", "hardware", "equipment", "instrument")),
    ("Automotive",             ("auto", "vehicle", "automotive", "mobility")),
    ("Energy",                 ("energy", "oil", "gas", "petroleum", "refining")),
    ("Financials / Banks",     ("bank", "lending", "credit", "deposit", "insurance")),
    ("Healthcare / Pharma",    ("health", "pharma", "drug", "medical", "biotech", "therapeut")),
    ("Aerospace / Defense",    ("aerospace", "defense", "aviation", "space")),
    ("E-commerce / Retail",    ("retail", "store", "commerce", "marketplace", "merchandise")),
    ("Industrials",            ("industrial", "manufactur", "logistics", "machinery")),
    ("Consumer Staples",       ("food", "beverage", "household", "staple")),
]


def _guess_sector(name: str) -> str | None:
    low = name.lower()
    for sector, keys in _SECTOR_KEYWORDS:
        if any(k in low for k in keys):
            return sector
    return None


@router.get("/sotp")
def sotp(ticker: str):
    """Segment revenue for a sum-of-the-parts valuation. The client applies a P/S
    multiple per segment and sums straight to an equity value per share (P/S is an
    equity multiple, so no net-debt step). Segments are seeded at the company's
    blended P/S; each can be retagged to a peer group for a pure-play comp. Revenue
    returned in $M."""
    sym = validate_ticker(ticker)

    # SEC EDGAR first: free, no quota, parsed from the latest 10-K's inline XBRL.
    seg = sec_segments.get_segment_revenue(sym)
    latest = seg.get("latest") or []
    source = "SEC 10-K"
    # Fall back to FMP (cleaner names, quarterly) only if SEC has nothing.
    if not latest and fmp.available():
        fseg = fmp.get_revenue_segments(sym)
        if fseg.get("latest"):
            latest, seg, source = fseg["latest"], fseg, "FMP"

    if not latest:
        note = ("No product-segment revenue breakdown was found in this issuer's latest 10-K. "
                "Single-segment reporters and foreign filers (20-F) will not have one. "
                "Use the DCF or Reverse DCF tabs instead.")
        return {"ticker": sym, "segments": [], "note": note, "error": False}

    segments = [{"name": s["name"], "revenue": round(s["value"] / 1e6, 1), "pct": s.get("pct"),
                 "sector": _guess_sector(s["name"])}
                for s in latest if s.get("value", 0) > 0]
    total_rev = round(sum(s["revenue"] for s in segments), 1)

    f = _fundamentals(sym)
    net_debt = round(f.get("net_debt") or 0, 1)
    shares   = round(f.get("shares") or 0, 1)
    price    = f.get("market_price")

    # Seed the UI at the company's current blended P/S so SOTP starts near the
    # market price and the user tunes individual segments up or down from fair.
    suggested = None
    if price and shares and total_rev:
        suggested = round(max(0.1, min(price * shares / total_rev, 25.0)), 2)

    return {
        "ticker":             sym,
        "fiscalYear":         seg.get("fiscalYear"),
        "currency":           seg.get("currency"),
        "source":             source,
        "segments":           segments,
        "total_revenue":      total_rev,
        "net_debt":           net_debt,
        "shares":             shares,
        "market_price":       price,
        "suggested_multiple": suggested,
        "sector_ps":          SECTOR_PS,
    }


# ── Dividend Discount Model ─────────────────────────────────────────────────────

_RISK_FREE = 4.3   # 3M T-bill proxy, %
_EQUITY_RISK_PREMIUM = 5.0   # %


@router.get("/ddm")
def ddm(ticker: str):
    """Inputs for a dividend discount model: trailing dividend per share, its
    historical growth, and a CAPM-suggested required return. The client runs the
    Gordon / two-stage math so growth and discount rate stay interactive."""
    sym = validate_ticker(ticker)
    from cache import get_info
    info = get_info(sym)
    price = float(info.get("currentPrice") or info.get("regularMarketPrice") or 0) or None
    dps = info.get("trailingAnnualDividendRate") or info.get("dividendRate")

    if not dps or float(dps) <= 0:
        return {"ticker": sym, "pays_dividend": False, "price": price,
                "note": ("This company does not currently pay a dividend, so a dividend "
                         "discount model does not apply. Use the DCF or Multiples tabs.")}
    dps = float(dps)

    # Historical dividend CAGR from full calendar years (exclude the partial current year).
    growth = None
    try:
        import yfinance as yf, datetime as _dt
        div = yf.Ticker(sym).dividends
        if div is not None and len(div) > 0:
            ann = div.groupby(div.index.year).sum()
            ann = ann[(ann > 0) & (ann.index < _dt.date.today().year)]
            if len(ann) >= 2:
                first, last = float(ann.iloc[0]), float(ann.iloc[-1])
                yrs = int(ann.index[-1]) - int(ann.index[0])
                if first > 0 and yrs > 0:
                    growth = round(((last / first) ** (1 / yrs) - 1) * 100, 1)
    except Exception:
        pass

    beta = info.get("beta")
    req = round(_RISK_FREE + (float(beta) if beta else 1.0) * _EQUITY_RISK_PREMIUM, 1)
    # Seed perpetual growth at the historical rate, but keep it safely below the
    # discount rate (Gordon diverges as g -> r).
    sug_g = growth if growth is not None else 4.0
    if sug_g >= req - 1.0:
        sug_g = round(req - 2.0, 1)

    div_yield = round(dps / price * 100, 2) if price else None
    low_yield = div_yield is not None and div_yield < 0.5

    return {
        "ticker":        sym,
        "pays_dividend": True,
        "price":         price,
        "dps":           round(dps, 2),
        "div_yield":     div_yield,
        "div_growth":    growth,
        "beta":          round(float(beta), 2) if beta else None,
        "suggested_r":   req,
        "suggested_g":   sug_g,
        "low_yield":     low_yield,
        "note":          (f"{sym} pays only a negligible dividend ({div_yield}% yield), so a dividend "
                          "discount model is not a meaningful valuation here. Prefer the DCF or Multiples tabs.") if low_yield else None,
    }


# ── Multiples ───────────────────────────────────────────────────────────────────

@router.get("/multiples")
def multiples(ticker: str):
    """Current per-share metrics and trading multiples. The client sets a target
    multiple per line to see the implied share price move."""
    sym = validate_ticker(ticker)
    from cache import get_info
    info = get_info(sym)
    price  = float(info.get("currentPrice") or info.get("regularMarketPrice") or 0) or None
    shares = (info.get("sharesOutstanding") or 0) / 1e6        # M
    total_debt = (info.get("totalDebt") or 0) / 1e6
    cash       = (info.get("totalCash") or info.get("cashAndCashEquivalents") or 0) / 1e6
    net_debt   = total_debt - cash

    eps      = info.get("trailingEps")
    eps_fwd  = info.get("forwardEps")
    book_ps  = info.get("bookValue")                          # per share
    revenue  = (info.get("totalRevenue") or 0) / 1e6          # $M
    ebitda   = (info.get("ebitda") or 0) / 1e6                # $M
    src = None

    # FactSet override: real diluted EPS (latest actual + next-year consensus),
    # book value, revenue, and EBITDA, all higher quality than the yfinance fields.
    import factset
    if factset.available():
        try:
            fin = factset.financial_highlights(sym)
            if fin:
                if factset.latest_actual(fin, "EPS (Diluted)"): eps = factset.latest_actual(fin, "EPS (Diluted)")
                if factset.next_estimate(fin, "EPS (Diluted)"): eps_fwd = factset.next_estimate(fin, "EPS (Diluted)")
                if factset.latest_actual(fin, "Book Value Per Share"): book_ps = factset.latest_actual(fin, "Book Value Per Share")
                if factset.latest_actual(fin, "Revenue"): revenue = factset.latest_actual(fin, "Revenue")
                if factset.latest_actual(fin, "EBITDA"): ebitda = factset.latest_actual(fin, "EBITDA")
                src = "FactSet"
        except Exception:
            pass

    sales_ps  = revenue / shares if shares else None
    ebitda_ps = ebitda / shares if shares else None
    ev = (price * shares + net_debt) if (price and shares) else None

    # Non-positive per-share figures (negative EPS for a loss-maker, negative book
    # equity from buybacks) have no valuation reading, so those lines are dropped.
    metrics: list[dict] = []
    def add(key, label, per_share, cur_mult, ev_based=False):
        if per_share and per_share > 0:
            metrics.append({"key": key, "label": label, "per_share": round(per_share, 2),
                            "current_mult": round(cur_mult, 1) if cur_mult and cur_mult > 0 else None,
                            "ev_based": ev_based})

    if eps:     add("pe",     "P/E (trailing)", float(eps),     price / eps if price else None)
    if eps_fwd: add("pe_fwd", "P/E (forward)",  float(eps_fwd), price / eps_fwd if price else None)
    if sales_ps: add("ps",    "P/S",            sales_ps,       price / sales_ps if price else None)
    if book_ps: add("pb",     "P/B",            float(book_ps), price / book_ps if price else None)
    if ebitda_ps: add("ev_ebitda", "EV/EBITDA", ebitda_ps,     ev / ebitda if (ev and ebitda > 0) else None, ev_based=True)

    if not metrics:
        return {"ticker": sym, "price": price, "metrics": [],
                "note": "No usable per-share metrics were available for this ticker."}

    return {
        "ticker":   sym,
        "price":    round(price, 2) if price else None,
        "shares":   round(shares, 1),
        "net_debt": round(net_debt, 1),
        "metrics":  metrics,
        "source":   src,
    }
