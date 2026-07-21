"""SEC EDGAR real-time filings — 8-K material events, 10-Q/10-K reports, Form 4
insider trades, Schedule 13D/13G, Form 144 — via the free `data.sec.gov`
submissions API. No key; the only requirement is a compliant User-Agent
carrying a name + contact email (SEC blocks generic/missing UAs), same
convention already used elsewhere in this backend (alphavantage.py,
logistics/public_enrichment.py).

This is a separate module from sec_fundamentals.py / edgar_exhibit21.py —
those parse XBRL financial facts and Exhibit-21 subsidiary lists; this one is
purely "what got filed, and when," which is the actual real-time-catalyst
signal for a move-explainer (a same-day 8-K is a real event; a subsidiary
list is not).

Reuses the ticker -> CIK resolver already built for the Supply Chain Map's
public-evidence panel instead of re-implementing it.
"""
from __future__ import annotations

import logging

import requests

from disk_cache import disk_get, disk_set
from logistics.public_enrichment import _sec_cik as _resolve_cik
from social_schema import NewsEvent, dict_to_event, event_to_dict, retry_with_backoff, utc_now

logger = logging.getLogger(__name__)
_TIMEOUT = 12
_CACHE_TTL = 600   # 10 min — filings are infrequent enough that this stays close to real-time
_UA = {"User-Agent": "Alphatape Research admin@alphatape.app"}

# The forms that actually matter for "why did this move" — material events,
# periodic reports, and the trades corporate insiders/large holders must
# disclose. Everything else (proxy statements, registration boilerplate, etc.)
# is noise for this purpose.
DEFAULT_FORMS = {"8-K", "10-Q", "10-K", "4", "SC 13D", "SC 13D/A", "SC 13G", "SC 13G/A", "144"}


def _filing_url(cik_int: str, accession: str, primary_doc: str | None) -> str:
    acc_nodash = accession.replace("-", "")
    if primary_doc:
        return f"https://www.sec.gov/Archives/edgar/data/{cik_int}/{acc_nodash}/{primary_doc}"
    return f"https://www.sec.gov/Archives/edgar/data/{cik_int}/{acc_nodash}/"


def fetch_recent_filings(ticker: str, forms: set[str] | None = None, limit: int = 15) -> list[NewsEvent]:
    """Most recent qualifying filings for `ticker`, newest first. No sentiment
    (filings are facts, not opinions) — sentiment_score is always None. Never
    raises: no CIK match, a network failure, or a malformed response all
    degrade to an empty list."""
    sym = ticker.strip().upper()
    if not sym:
        return []
    wanted = forms or DEFAULT_FORMS
    cache_key = f"sec_filings:v1:{sym}"
    cached = disk_get(cache_key)
    if cached is not None:
        return [dict_to_event(d) for d in cached]

    cik = _resolve_cik(sym)
    if not cik:
        disk_set(cache_key, [], ttl=_CACHE_TTL)
        return []

    def _do():
        return requests.get(f"https://data.sec.gov/submissions/CIK{cik}.json", headers=_UA, timeout=_TIMEOUT)

    try:
        resp = retry_with_backoff(_do, label=f"sec submissions {sym}")
        resp.raise_for_status()
        data = resp.json()
    except Exception as exc:
        logger.warning("SEC submissions fetch failed for %s: %s", sym, exc)
        return []

    recent = ((data.get("filings") or {}).get("recent")) or {}
    forms_list = recent.get("form") or []
    n = len(forms_list)
    cik_int = str(int(cik))

    events: list[NewsEvent] = []
    for i in range(n):
        form = forms_list[i]
        if form not in wanted:
            continue
        accession = (recent.get("accessionNumber") or [None] * n)[i]
        primary_doc = (recent.get("primaryDocument") or [None] * n)[i]
        desc = (recent.get("primaryDocDescription") or [None] * n)[i]
        filing_date = (recent.get("filingDate") or [None] * n)[i]
        accepted = (recent.get("acceptanceDateTime") or [None] * n)[i]
        headline = f"{form} filed" + (f" — {desc}" if desc and desc != form else "")
        events.append(NewsEvent(
            timestamp=_parse_timestamp(accepted, filing_date), source_name="SEC EDGAR", ticker=sym,
            headline_or_text=headline, sentiment_score=None,
            url=_filing_url(cik_int, accession, primary_doc) if accession else None,
            raw_payload={"form": form, "accessionNumber": accession, "filingDate": filing_date,
                         "acceptanceDateTime": accepted, "primaryDocDescription": desc},
        ))
        if len(events) >= limit:
            break

    disk_set(cache_key, [event_to_dict(e) for e in events], ttl=_CACHE_TTL)
    return events


def _parse_timestamp(accepted: str | None, filing_date: str | None):
    import datetime as _dt
    for raw, fmt in ((accepted, "%Y-%m-%dT%H:%M:%S"), (filing_date, "%Y-%m-%d")):
        if not raw:
            continue
        try:
            return _dt.datetime.strptime(raw[:19], fmt).replace(tzinfo=_dt.timezone.utc)
        except ValueError:
            continue
    return utc_now()
