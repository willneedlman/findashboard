"""Shared options-chain fetch with a short TTL cache.

The vol/options analytics tools (Vol Skew, Implied Probability, IV Tracker) each
need the same yfinance option chain for a ticker. Without a shared cache, a user
flipping between them re-fetches identical chains. This module fetches a chain
once per (ticker, expiry) per TTL and hands the same object to every caller.

Returns the native yfinance chain object (``.calls`` / ``.puts`` / ``.underlying``)
so call sites that already use those attributes need no other change.
"""
import threading

import yfinance as yf
from cachetools import TTLCache

_lock = threading.Lock()
# Chains move slowly enough for these analytics tools that a 2-minute reuse
# window is safe; expirations change far less often.
_chain_cache: TTLCache = TTLCache(maxsize=256, ttl=120)
_exp_cache: TTLCache = TTLCache(maxsize=256, ttl=300)


def get_expirations(sym: str) -> list[str]:
    sym = sym.strip().upper()
    with _lock:
        hit = _exp_cache.get(sym)
    if hit is not None:
        return hit
    exps = list(yf.Ticker(sym).options or [])
    with _lock:
        _exp_cache[sym] = exps
    return exps


def get_chain(sym: str, expiry: str):
    """Cached yfinance option_chain for one expiry (raises like yfinance on a
    bad expiry; callers handle as before)."""
    key = (sym.strip().upper(), expiry)
    with _lock:
        hit = _chain_cache.get(key)
    if hit is not None:
        return hit
    chain = yf.Ticker(key[0]).option_chain(expiry)
    with _lock:
        _chain_cache[key] = chain
    return chain


def _best_price(row) -> float:
    """Mid of bid/ask, else ask, else last — the same convention as the snapshot."""
    bid = float(row.get("bid") or 0)
    ask = float(row.get("ask") or 0)
    last = float(row.get("lastPrice") or 0)
    if bid > 0 and ask > 0:
        return (bid + ask) / 2
    if ask > 0:
        return ask
    return last


def _iso_date(s):
    import datetime as _dt
    try:
        return _dt.date.fromisoformat(str(s)[:10])
    except Exception:
        return None


def implied_move(sym: str, spot: float | None = None,
                 expiry: str | None = None, on_or_after: str | None = None) -> dict | None:
    """At-the-money straddle implied (expected) move for one expiry.

    move_pct = (ATM call + ATM put) / spot * 100 — what the options market is
    pricing as the one-sigma move through that expiry.

    Expiry selection: an explicit `expiry`, else the first expiry on/after
    `on_or_after` (e.g. an earnings date, so the straddle spans the event),
    else the first future expiry. Returns None when no usable chain exists.
    """
    import datetime as _dt
    sym = sym.strip().upper()
    try:
        today = _dt.date.today()
        if expiry:
            chosen = expiry
        else:
            future = [e for e in get_expirations(sym) if (_iso_date(e) or today) > today]
            if not future:
                return None
            tgt = _iso_date(on_or_after) if on_or_after else None
            chosen = next((e for e in future if (_iso_date(e) or today) >= tgt), future[-1]) if tgt else future[0]

        chain = get_chain(sym, chosen)
        calls, puts = chain.calls, chain.puts
        if calls.empty or puts.empty:
            return None

        if not spot or spot <= 0:
            und = getattr(chain, "underlying", None) or {}
            spot = float(und.get("regularMarketPrice") or 0) if isinstance(und, dict) else 0
        if not spot or spot <= 0:
            from cache import get_history
            h = get_history(sym, period="2d")
            spot = float(h["Close"].iloc[-1]) if not h.empty else 0
        if not spot or spot <= 0:
            return None

        strikes = sorted(set(calls["strike"].tolist()) | set(puts["strike"].tolist()))
        atm = min(strikes, key=lambda k: abs(k - spot))
        c = calls[calls["strike"] == atm]
        p = puts[puts["strike"] == atm]
        c_px = _best_price(c.iloc[0]) if not c.empty else 0.0
        p_px = _best_price(p.iloc[0]) if not p.empty else 0.0
        straddle = c_px + p_px
        if straddle <= 0.01:
            return None

        return {
            "move_pct": round(straddle / spot * 100, 1),
            "straddle": round(straddle, 2),
            "expiry": chosen,
            "spot": round(float(spot), 2),
        }
    except Exception:
        return None
