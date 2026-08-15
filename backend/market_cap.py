"""One market capitalisation, with the basis it was computed on attached.

Six implementations disagreed about the same company on the same evening.
AAPL came out $4,041.2B on the Stock Screener, $4.46T on Company Profile and
$4,590.4B on Master Valuation, because one banked a July snapshot, one took the
vendor's own figure over a basic share count, and one multiplied a live price by
diluted shares. A user comparing a multiple across two tabs was comparing two
different companies.

Diluted is the right basis for valuation, so that is what this prefers, and the
basis rides along with the number so a surface can print which one it used
rather than leaving the reader to guess.

The price lookup here is deliberately narrow. When the single price service
lands it replaces `_price`, and every consumer of this module inherits it.
"""

import datetime as _dt
import logging

logger = logging.getLogger(__name__)

# Diluted share count from the income statement: what a valuation should divide
# by, because it counts the claims that already exist against the equity.
BASIS_DILUTED = "diluted"
# Shares outstanding as reported: what most vendors quote, and what the yfinance
# `marketCap` field is built on.
BASIS_BASIC = "basic"
# The vendor's own market cap, with no share count of ours behind it. Used only
# when neither share count is available; it cannot be reconciled against a price.
BASIS_VENDOR = "vendor"


def _now_iso() -> str:
    return _dt.datetime.now(_dt.timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def _price(ticker: str) -> "tuple[float | None, str | None]":
    """Last trade or close, and where it came from."""
    try:
        import quotes
        last = quotes.live_price(ticker)
        if last and float(last) > 0:
            return float(last), "quotes.live_price"
    except Exception as e:
        logger.debug("market_cap price %s: %s", ticker, e)
    try:
        from cache import get_info
        info = get_info(ticker) or {}
        for key in ("currentPrice", "regularMarketPrice", "previousClose"):
            value = info.get(key)
            if value and float(value) > 0:
                return float(value), f"yfinance.info.{key}"
    except Exception as e:
        logger.debug("market_cap price fallback %s: %s", ticker, e)
    return None, None


def _diluted_shares(ticker: str) -> "tuple[float | None, str | None]":
    """Diluted share count, SEC first, then the vendor's income statement."""
    try:
        import sec_fundamentals
        for row in sec_fundamentals.get_income(ticker, limit=1) or []:
            shares = row.get("weightedAverageShsOutDil")
            if shares and float(shares) > 0:
                return float(shares), "sec.WeightedAverageNumberOfDilutedSharesOutstanding"
    except Exception as e:
        logger.debug("market_cap sec shares %s: %s", ticker, e)
    try:
        import fmp
        if fmp.available():
            bundle = fmp.get_fundamentals(ticker, cached_only=True) or {}
            income = (bundle.get("income") or [{}])[0]
            shares = income.get("weightedAverageShsOutDil")
            if shares and float(shares) > 0:
                return float(shares), "fmp.income.weightedAverageShsOutDil"
    except Exception as e:
        logger.debug("market_cap fmp shares %s: %s", ticker, e)
    return None, None


def market_cap(ticker: str) -> dict:
    """Market capitalisation in USD with its provenance.

    Returns {value, basis, shares, price, as_of, source}. `value` is None when
    nothing usable was found — a placeholder here reads downstream as a real cap
    and silently misprices everything derived from it.
    """
    sym = (ticker or "").strip().upper()
    if not sym:
        return {"value": None, "basis": None, "shares": None, "price": None,
                "as_of": None, "source": None}

    price, price_source = _price(sym)
    shares, shares_source = _diluted_shares(sym)
    basis = BASIS_DILUTED

    if shares is None:
        try:
            from cache import get_info
            info = get_info(sym) or {}
            raw = info.get("sharesOutstanding")
            if raw and float(raw) > 0:
                shares, shares_source, basis = float(raw), "yfinance.info.sharesOutstanding", BASIS_BASIC
        except Exception as e:
            logger.debug("market_cap basic shares %s: %s", sym, e)

    if price is not None and shares is not None:
        return {
            "value": round(price * shares), "basis": basis, "shares": shares,
            "price": round(price, 4), "as_of": _now_iso(),
            "source": f"{price_source} x {shares_source}",
        }

    # No share count of ours: fall back to the vendor's figure and say so, since
    # it cannot be reconciled against the price shown beside it.
    try:
        from cache import get_info
        vendor = (get_info(sym) or {}).get("marketCap")
        if vendor and float(vendor) > 0:
            return {"value": round(float(vendor)), "basis": BASIS_VENDOR, "shares": None,
                    "price": round(price, 4) if price else None, "as_of": _now_iso(),
                    "source": "yfinance.info.marketCap"}
    except Exception as e:
        logger.debug("market_cap vendor %s: %s", sym, e)

    return {"value": None, "basis": None, "shares": shares, "price": price,
            "as_of": _now_iso(), "source": None}
