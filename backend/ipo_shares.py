"""
IPO-time shares outstanding from the SEC prospectus.

For an IPO market cap we need the post-offering share count as stated in the
registration statement — the number outstanding *immediately after the offering*
— not the live count (which drifts with later buybacks and secondary sales). So
this reads the S-1/424B prospectus itself and parses that fixed figure.

Flow per name: EDGAR full-text search on the company name → the prospectus filing
(CIK, accession, primary document in one call) → download it once → regex the
"after this offering ... shares ... outstanding" language. Cached 30 days on disk
including misses, since an IPO's post-offering count never changes.
"""
from __future__ import annotations

import logging
import re

import requests

try:
    from disk_cache import disk_get, disk_set
except Exception:                                     # pragma: no cover
    def disk_get(_k): return None                     # type: ignore
    def disk_set(_k, _v, ttl=0): pass                 # type: ignore

_log = logging.getLogger(__name__)
_UA = {"User-Agent": "Alphatape Research admin@alphatape.app"}
_TIMEOUT = 20
# Prospectus forms only — never 10-K/10-Q, whose counts already include post-IPO
# buybacks and issuance. Final prospectus (424B) beats the amended/original S-1.
_FORMS = ("424B4", "424B1", "424B3", "424B2", "F-1/A", "S-1/A", "F-1", "S-1")
_FORM_RANK = {f: i for i, f in enumerate(_FORMS)}
# Foreign-private-issuer forms. Their presence is a hard ADR/foreign-listing tell
# a name like "SK hynix" hides: F-6 registers the American Depositary Shares, F-1
# is the foreign IPO registration, 20-F/40-F/6-K are the foreign periodic reports.
# Domestic issuers use S-1/10-K/8-K exclusively and never these.
_FOREIGN_FORMS = {"F-1", "F-1/A", "F-3", "F-3/A", "F-4", "F-6", "F-6/A", "20-F", "40-F", "6-K"}

# Post-offering share count. A prospectus states 20+ share numbers (per class,
# pro-forma, authorized, restricted); the reliable signal is the canonical
# sentence "upon completion of this offering, we will have N shares outstanding".
# Patterns are tried in priority order; the first match clearing the offered-share
# floor wins, so summary-table fragments below the raise are rejected.
_SHARE_PATS = [
    r'(?:upon|after|following)\s+(?:the\s+)?(?:completion|closing|consummation)\s+of\s+(?:this|the)\s+offering,?\s+(?:we\s+will\s+have\s+)?(?:a\s+total\s+of\s+)?([\d,]{7,})\s+shares[^.]{0,45}?outstanding',
    r'we\s+will\s+have\s+(?:a\s+total\s+of\s+)?([\d,]{7,})\s+shares[^.]{0,45}?outstanding[^.]{0,45}?(?:after|upon|immediately\s+following)',
    r'after\s+giving\s+effect\s+to\s+(?:this|the)\s+offering[^.]{0,70}?([\d,]{7,})\s+shares\s+(?:of\s+(?:our\s+)?common\s+stock\s+)?(?:will\s+be\s+)?outstanding',
    r'([\d,]{7,})\s+shares[^.]{0,55}?outstanding[^.]{0,50}?(?:immediately\s+)?(?:after|following|upon\s+(?:the\s+)?(?:completion|closing)\s+of)[^.]{0,25}?(?:this|the)\s+offering',
]


_STOP = {"inc", "incorporated", "corp", "corporation", "ltd", "limited", "llc",
         "lp", "plc", "sa", "co", "company", "group", "holdings", "the", "class",
         "common", "stock", "ord", "ordinary", "shares", "spa", "nv", "ag", "plc"}


def _core(s: str) -> set[str]:
    toks = re.sub(r"[^a-z0-9 ]", " ", (s or "").lower()).split()
    return {t for t in toks if t not in _STOP and len(t) > 1}


def _cik_for(name: str, symbol: str) -> str | None:
    """10-digit CIK for a company, via EDGAR full-text search on its name. Only a
    confident match is accepted — the ticker appears in the hit's display_names,
    or the company-name tokens overlap strongly — so a fuzzy near-miss returns
    None (→ market cap "unavailable") rather than another company's share count."""
    try:
        r = requests.get("https://efts.sec.gov/LATEST/search-index",
                         params={"q": f'"{name}"', "forms": ",".join(_FORMS)},
                         headers=_UA, timeout=_TIMEOUT)
        hits = (r.json().get("hits") or {}).get("hits") or []
    except Exception as e:
        _log.warning("edgar fts %s: %s", name, e)
        return None
    if not hits:
        return None
    sym = symbol.upper()
    qcore = _core(name)

    def match(h) -> tuple[bool, str]:
        src = h.get("_source", {})
        names = " ".join(src.get("display_names") or [])
        if f"({sym})" in names.upper():
            return True, src.get("file_date") or ""
        hcore = _core(names)
        overlap = len(qcore & hcore) / max(len(qcore), 1)
        strong = qcore and (qcore <= hcore or overlap >= 0.6)
        return bool(strong), src.get("file_date") or ""

    scored = [(m, d, h) for h in hits for m, d in [match(h)]]
    accepted = [t for t in scored if t[0]]
    if not accepted:
        return None
    src = max(accepted, key=lambda t: t[1])[2].get("_source", {})
    ciks = src.get("ciks") or src.get("cik") or []
    cik = ciks[0] if isinstance(ciks, list) else ciks
    return str(cik).zfill(10) if cik else None


def _edgar(name: str, symbol: str) -> tuple[str | None, bool]:
    """From one submissions fetch: (primary prospectus URL, is-foreign-issuer).
    Prospectus is the final 424B if present, else the most recent S-1/F-1
    amendment (full-text search points at whichever sub-document matched, often
    an exhibit, so the primary doc is resolved from submissions). Foreign is true
    when the filing history contains any foreign-private-issuer form."""
    cik = _cik_for(name, symbol)
    if not cik:
        return None, False
    try:
        j = requests.get(f"https://data.sec.gov/submissions/CIK{cik}.json",
                         headers=_UA, timeout=_TIMEOUT).json()
        recent = j.get("filings", {}).get("recent", {})
    except Exception as e:
        _log.warning("edgar submissions %s: %s", cik, e)
        return None, False

    forms = recent.get("form") or []
    foreign = any(f in _FOREIGN_FORMS for f in forms)
    best = None   # (rank, date, url); lowest rank then newest date wins
    for i, form in enumerate(forms):
        if form not in _FORM_RANK:
            continue
        doc = (recent.get("primaryDocument") or [None] * len(forms))[i]
        if not doc:
            continue
        acc = recent["accessionNumber"][i].replace("-", "")
        date = recent["filingDate"][i]
        url = f"https://www.sec.gov/Archives/edgar/data/{int(cik)}/{acc}/{doc}"
        key = (_FORM_RANK[form], date)
        if best is None or (key[0] < best[0][0] or (key[0] == best[0][0] and key[1] > best[0][1])):
            best = (key, url)
    return (best[1] if best else None), foreign


def _parse_shares(html: str, floor: int) -> int | None:
    text = re.sub(r"<[^>]+>", " ", html)
    text = re.sub(r"&#160;|&nbsp;|&#xa0;|&#x00a0;", " ", text)
    text = re.sub(r"\s+", " ", text)
    # A valid post-offering count is at least the offered shares and not absurd.
    lo = max(floor, 100_000)
    for pat in _SHARE_PATS:                       # priority order
        for m in re.finditer(pat, text, re.IGNORECASE):
            try:
                val = int(m.group(1).replace(",", ""))
            except ValueError:
                continue
            if lo <= val <= 50_000_000_000:
                return val
    return None


def ipo_profile(symbol: str, name: str, offered: int = 0) -> dict:
    """{'shares': int|None, 'foreign': bool} for one IPO from a single EDGAR pass.
    `shares` is the post-offering count from the prospectus, or None when it can't
    be read confidently (`offered` is the deal's share count; a parsed value below
    it is a summary-table fragment, not the total, so it is rejected). `foreign`
    marks a foreign private issuer (→ ADR listing). Cached 30 days (misses too)."""
    sym = (symbol or "").strip().upper()
    if not sym or not name:
        return {"shares": None, "foreign": False}
    ck = f"ipo:profile:{sym}"
    cached = disk_get(ck)
    if cached is not None:
        return cached

    shares: int | None = None
    url, foreign = _edgar(name, sym)
    if url:
        try:
            html = requests.get(url, headers=_UA, timeout=30).text
            shares = _parse_shares(html, offered or 0)
        except Exception as e:
            _log.warning("ipo shares %s: %s", sym, e)

    out = {"shares": shares, "foreign": foreign}
    disk_set(ck, out, ttl=30 * 86400)
    return out


def ipo_shares(symbol: str, name: str, offered: int = 0) -> int | None:
    """Post-offering shares only. See ipo_profile for the combined lookup."""
    return ipo_profile(symbol, name, offered)["shares"]
