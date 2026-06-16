import os
import httpx
from functools import lru_cache
from cachetools.func import ttl_cache  # thread-safe short-TTL memoisation

_KEY = os.getenv("TRADIER_API_KEY", "")
_ENV = os.getenv("TRADIER_ENV", "sandbox")
_BASE = "https://sandbox.tradier.com/v1" if _ENV == "sandbox" else "https://api.tradier.com/v1"
_HEADERS = {"Authorization": f"Bearer {_KEY}", "Accept": "application/json"}


class TradierError(Exception):
    """A rejection or error reported by Tradier, carrying its human message."""


def _extract_error(r: httpx.Response) -> str:
    """Pull Tradier's actual rejection reason out of an error response."""
    try:
        j = r.json()
    except Exception:
        return (r.text or f"HTTP {r.status_code}").strip()[:300]
    if isinstance(j, dict):
        errs = j.get("errors")
        if isinstance(errs, dict):
            e = errs.get("error")
            return "; ".join(e) if isinstance(e, list) else str(e)
        if errs:
            return str(errs)
        if j.get("error"):
            return str(j["error"])
        fault = j.get("fault")
        if isinstance(fault, dict):
            return str(fault.get("faultstring", "Tradier fault"))
    return f"HTTP {r.status_code}"


def _get(path: str, params: dict | None = None) -> dict:
    if params is None: params = {}
    r = httpx.get(f"{_BASE}{path}", headers=_HEADERS, params=params, timeout=10)
    r.raise_for_status()
    return r.json()


def _post(path: str, data: dict | None = None) -> dict:
    if data is None: data = {}
    if not _KEY:
        raise TradierError("Paper trading is not configured (no Tradier token).")
    r = httpx.post(f"{_BASE}{path}", headers=_HEADERS, data=data, timeout=10)
    if r.status_code >= 400:
        raise TradierError(_extract_error(r))
    j = r.json()
    # Tradier can return 200 with an error/rejection body.
    if isinstance(j, dict) and (j.get("errors") or j.get("error")):
        raise TradierError(_extract_error(r))
    return j


# ── Market data ───────────────────────────────────────────────────────────────

@ttl_cache(maxsize=512, ttl=20)   # live quotes — dedupe bursts, ~real-time
def get_quote(symbol: str) -> dict:
    data = _get("/markets/quotes", {"symbols": symbol, "greeks": "false"})
    q = data.get("quotes", {}).get("quote", {})
    return q


@ttl_cache(maxsize=256, ttl=3600)   # expirations barely change intraday
def get_expirations(symbol: str) -> list[str]:
    data = _get("/markets/options/expirations", {"symbol": symbol, "includeAllRoots": "true"})
    exps = data.get("expirations", {})
    if not exps:
        return []
    dates = exps.get("date", [])
    return dates if isinstance(dates, list) else [dates]


@ttl_cache(maxsize=2048, ttl=45)   # chains: OI/greeks move slowly; 45s dedupes the GEX fan-out
def get_options_chain(symbol: str, expiration: str, greeks: bool = True) -> dict:
    """Returns {"calls": [...], "puts": [...]} with full OI, bid, ask, greeks."""
    data = _get("/markets/options/chains", {
        "symbol": symbol,
        "expiration": expiration,
        "greeks": "true" if greeks else "false",
    })
    options = data.get("options", {})
    if not options:
        return {"calls": [], "puts": []}
    raw = options.get("option", [])
    if isinstance(raw, dict):
        raw = [raw]

    calls, puts = [], []
    for o in raw:
        row = {
            "strike":          o.get("strike", 0),
            "lastPrice":       o.get("last", 0) or 0,
            "bid":             o.get("bid", 0) or 0,
            "ask":             o.get("ask", 0) or 0,
            "volume":          o.get("volume", 0) or 0,
            "openInterest":    o.get("open_interest", 0) or 0,
            "impliedVolatility": (o.get("greeks", {}) or {}).get("smv_vol", 0) or 0,
            "delta":           (o.get("greeks", {}) or {}).get("delta", 0) or 0,
            "gamma":           (o.get("greeks", {}) or {}).get("gamma", 0) or 0,
        }
        if o.get("option_type") == "call":
            calls.append(row)
        else:
            puts.append(row)

    return {"calls": sorted(calls, key=lambda x: x["strike"]),
            "puts":  sorted(puts,  key=lambda x: x["strike"])}


# ── Account (paper trading) ───────────────────────────────────────────────────

@lru_cache(maxsize=1)
def get_account_id() -> str:
    data = _get("/user/profile")
    profile = data.get("profile", {})
    accounts = profile.get("account", [])
    if isinstance(accounts, dict):
        accounts = [accounts]
    return accounts[0]["account_number"] if accounts else ""


def get_balances() -> dict:
    acct = get_account_id()
    if not acct:
        return {}
    data = _get(f"/accounts/{acct}/balances")
    raw = data.get("balances", {})

    # Tradier returns cash as a nested object for cash accounts
    cash_val = raw.get("cash", 0)
    if isinstance(cash_val, dict):
        cash_val = cash_val.get("cash_available", 0) or 0

    total_cash  = float(raw.get("total_cash",  0) or 0)
    market_val  = float(raw.get("market_value", raw.get("long_market_value", 0)) or 0)
    total_eq    = float(raw.get("total_equity", 0) or 0)
    bp          = float(raw.get("buying_power", raw.get("stock_buying_power",
                   raw.get("cash_available", cash_val))) or 0)
    day_change  = float((raw.get("open_pl") or 0)) + float((raw.get("close_pl") or 0))

    return {
        "cash":          round(cash_val if isinstance(cash_val, (int, float)) else total_cash, 2),
        "market_value":  round(market_val, 2),
        "equity":        round(float(raw.get("equity", 0) or 0), 2),
        "buying_power":  round(bp, 2),
        "total_equity":  round(total_eq, 2),
        "day_change":    round(day_change, 2),
    }


def get_positions() -> list:
    acct = get_account_id()
    if not acct:
        return []
    data = _get(f"/accounts/{acct}/positions")
    pos = data.get("positions", {})
    if not pos or pos == "null":
        return []
    items = pos.get("position", [])
    return items if isinstance(items, list) else [items]


def get_orders() -> list:
    acct = get_account_id()
    if not acct:
        return []
    data = _get(f"/accounts/{acct}/orders")
    orders = data.get("orders", {})
    if not orders or orders == "null":
        return []
    items = orders.get("order", [])
    return items if isinstance(items, list) else [items]


def place_equity_order(
    symbol: str,
    side: str,       # "buy" | "sell"
    quantity: int,
    order_type: str = "market",   # "market" | "limit" | "stop" | "stop_limit"
    price: float | None = None,
    stop: float | None = None,
    duration: str = "day",        # "day" | "gtc"
) -> dict:
    acct = get_account_id()
    payload = {
        "class":    "equity",
        "symbol":   symbol,
        "side":     side,
        "quantity": str(quantity),
        "type":     order_type,
        "duration": duration,
    }
    if price is not None:
        payload["price"] = str(price)
    if stop is not None:
        payload["stop"] = str(stop)
    data = _post(f"/accounts/{acct}/orders", payload)
    return data.get("order", data)


def place_option_order(
    symbol: str,
    option_symbol: str,
    side: str,        # "buy_to_open" | "sell_to_open" | "buy_to_close" | "sell_to_close"
    quantity: int,
    order_type: str = "market",
    price: float | None = None,
    duration: str = "day",
) -> dict:
    acct = get_account_id()
    payload = {
        "class":         "option",
        "symbol":        symbol,
        "option_symbol": option_symbol,
        "side":          side,
        "quantity":      str(quantity),
        "type":          order_type,
        "duration":      duration,
    }
    if price is not None:
        payload["price"] = str(price)
    data = _post(f"/accounts/{acct}/orders", payload)
    return data.get("order", data)


def place_multileg_order(
    symbol: str,
    legs: list[dict],   # [{"option_symbol", "side", "quantity"}, ...]
    order_type: str = "debit",   # "debit" | "credit" | "even" | "market"
    price: float | None = None,
    duration: str = "day",
) -> dict:
    """Submit a 2-4 leg options order (spread, straddle, combo, etc.)."""
    acct = get_account_id()
    payload: dict = {
        "class":    "multileg",
        "symbol":   symbol,
        "type":     order_type,
        "duration": duration,
    }
    if price is not None:
        payload["price"] = str(price)
    for i, leg in enumerate(legs):
        payload[f"legs[{i}][option_symbol]"] = leg["option_symbol"]
        payload[f"legs[{i}][side]"]          = leg["side"]
        payload[f"legs[{i}][quantity]"]      = str(leg["quantity"])
    data = _post(f"/accounts/{acct}/orders", payload)
    return data.get("order", data)


def cancel_order(order_id: str) -> dict:
    acct = get_account_id()
    r = httpx.delete(f"{_BASE}/accounts/{acct}/orders/{order_id}", headers=_HEADERS, timeout=10)
    r.raise_for_status()
    return r.json()
