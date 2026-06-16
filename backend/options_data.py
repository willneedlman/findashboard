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
