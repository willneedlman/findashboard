"""
Company logos from logo.dev, resolved by name.

Ticker-based logo CDNs (Parqet, FMP, and logo.dev's own /ticker endpoint) only
cover established listings, so they miss almost every name on the IPO calendar.
logo.dev's Brand Search maps a company name to its domain, and the domain image
endpoint has broad coverage — that is the only path that resolves logos for
freshly filed / just-listed companies.

The secret key (Brand Search) stays here on the server; the returned image URL
carries only the publishable key, which is safe in the browser. A resolved URL is
verified to actually render a logo (fallback=404) before it is handed back, so the
client never loads a broken image. Cached 30 days, misses included.
"""
from __future__ import annotations

import logging
import os
import re

import requests

try:
    from disk_cache import disk_get, disk_set
except Exception:                                     # pragma: no cover
    def disk_get(_k): return None                     # type: ignore
    def disk_set(_k, _v, ttl=0): pass                 # type: ignore

_log = logging.getLogger(__name__)
_SK = os.getenv("LOGODEV_SECRET", "")
_PK = os.getenv("LOGODEV_PUBLISHABLE", "")
_TIMEOUT = 10
_SUFFIX = {"inc", "incorporated", "corp", "corporation", "ltd", "limited", "llc",
           "lp", "plc", "sa", "co", "company", "group", "holdings", "spa", "nv",
           "ag", "the", "class", "common", "stock", "ord", "ordinary"}


def available() -> bool:
    return bool(_SK and _PK)


def _tokens(s: str) -> list[str]:
    return [t for t in re.sub(r"[^a-z0-9 ]", " ", (s or "").lower()).split() if t not in _SUFFIX]


def _label(domain: str) -> str:
    """Second-level label of a domain, letters/digits only (x-energy.com → xenergy)."""
    host = re.sub(r"^www\.", "", (domain or "").lower())
    return re.sub(r"[^a-z0-9]", "", host.split(".")[0])


def _matches(tokens: list[str], domain: str) -> bool:
    """The domain plausibly belongs to the company: its first token, or any
    distinctive (>=4 char) token, appears in the domain label. Tolerates
    abbreviations like Scribe Therapeutics -> scribetx.com."""
    label = _label(domain)
    if not label or not tokens:
        return False
    if tokens[0] in label or label in "".join(tokens):
        return True
    return any(len(t) >= 4 and t in label for t in tokens)


def _image_url(domain: str) -> str:
    return f"https://img.logo.dev/{domain}?token={_PK}&size=64&format=png&retina=true"


def logo_url(name: str, symbol: str) -> str | None:
    """A working logo image URL for the company, or None. Matched by name against
    logo.dev Brand Search (its own ranking, first match wins), then verified to
    render so the client never loads a broken image."""
    if not available() or not name:
        return None
    sym = (symbol or "").strip().upper()
    ck = f"logodev:{sym}"
    cached = disk_get(ck)
    if cached is not None:
        return cached or None

    url = None
    tokens = _tokens(name)
    # Query on the bare company name (suffixes stripped) for cleaner ranking.
    query = " ".join(tokens) or name
    try:
        r = requests.get("https://api.logo.dev/search", params={"q": query},
                         headers={"Authorization": f"Bearer {_SK}"}, timeout=_TIMEOUT)
        results = r.json() if r.ok else []
        for item in (results if isinstance(results, list) else [])[:5]:
            domain = item.get("domain") or ""
            if not _matches(tokens, domain):
                continue
            candidate = _image_url(domain)
            try:
                if requests.get(candidate + "&fallback=404", timeout=_TIMEOUT).status_code == 200:
                    url = candidate
                    break
            except Exception:
                continue
    except Exception as e:
        _log.warning("logodev %s: %s", sym, e)

    disk_set(ck, url or "", ttl=30 * 86400)
    return url
