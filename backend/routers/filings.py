"""
Earnings & Filings router — fetches transcripts, financial statements,
and SEC filings, then summarises them with Claude.
"""
import os, logging, re, threading, json, asyncio
from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field
from cachetools import TTLCache
import requests
import sys
sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))
import fmp
from validation import validate_tickers, validate_ticker

try:
    from disk_cache import disk_get, disk_set
    _DISK = True
except ImportError:
    _DISK = False
    def disk_get(_k): return None  # type: ignore
    def disk_set(_k, _v, ttl=0): pass  # type: ignore

logger = logging.getLogger(__name__)
router = APIRouter()

_GROQ_KEY = os.getenv("GROQ_API_KEY", "")
_transcript_cache: TTLCache = TTLCache(maxsize=200, ttl=86400)   # 24h — transcripts don't change
_summary_cache:    TTLCache = TTLCache(maxsize=200, ttl=86400)
_filing_cache:     TTLCache = TTLCache(maxsize=200, ttl=3600)
_lock = threading.Lock()
# Bump to invalidate cached EDGAR context + summaries after a fetch-logic change
# (e.g. the annual-10-K/annual-financials fix).
_CACHE_VER = "v7"


# ── SEC EDGAR helpers ─────────────────────────────────────────────────────────

_EDGAR_HEADERS = {"User-Agent": "FinanceTerminal research@finterm.io"}

# Module-level cache so we only download the 5 MB company_tickers.json once per process
_cik_by_ticker: dict[str, str] = {}
_name_by_ticker: dict[str, str] = {}
_company_tickers_loaded = False

def _ensure_company_tickers():
    global _company_tickers_loaded
    if _company_tickers_loaded:
        return
    try:
        r = requests.get(
            "https://www.sec.gov/files/company_tickers.json",
            headers=_EDGAR_HEADERS, timeout=20,
        )
        for entry in r.json().values():
            t = entry.get("ticker", "")
            if t:
                _cik_by_ticker[t.upper()] = str(entry["cik_str"]).zfill(10)
                title = entry.get("title", "")
                if title:
                    _name_by_ticker[t.upper()] = title.title()
        _company_tickers_loaded = True
    except Exception as e:
        logger.warning("company_tickers.json load failed: %s", e)


def _get_cik(ticker: str) -> str | None:
    upper = ticker.upper()
    if upper in _cik_by_ticker:
        return _cik_by_ticker[upper]
    _ensure_company_tickers()
    return _cik_by_ticker.get(upper)


def _get_recent_filings(ticker: str, form_types: list[str]) -> list[dict]:
    cik = _get_cik(ticker)
    if not cik:
        return []
    try:
        r = requests.get(
            f"https://data.sec.gov/submissions/CIK{cik.zfill(10)}.json",
            headers=_EDGAR_HEADERS, timeout=8,
        )
        data = r.json()
        filings = data.get("filings", {}).get("recent", {})
        forms   = filings.get("form", [])
        dates   = filings.get("filingDate", [])
        accessions = filings.get("accessionNumber", [])
        primary_docs = filings.get("primaryDocument", [])
        items_col = filings.get("items", [])
        results = []
        for idx, (form, date, acc, doc) in enumerate(zip(forms, dates, accessions, primary_docs)):
            if form in form_types:
                acc_clean = acc.replace("-", "")
                url = f"https://www.sec.gov/Archives/edgar/data/{int(cik)}/{acc_clean}/{doc}"
                items = items_col[idx] if idx < len(items_col) else ""
                results.append({"form": form, "date": date, "url": url, "accession": acc, "items": items})
                # Scan deep enough to capture a 10-K even amid the more frequent
                # 10-Qs (a 10-K can be 3+ filings back).
                if len(results) >= 12:
                    break
        return results
    except Exception as e:
        logger.warning("EDGAR filings %s: %s", ticker, e)
        return []


# ── FMP transcript fetcher ────────────────────────────────────────────────────

def _get_transcripts(ticker: str, limit: int = 2) -> list[dict]:
    cache_key = f"{ticker}:tx:{limit}"
    with _lock:
        if cache_key in _transcript_cache:
            return _transcript_cache[cache_key]
    disk_val = disk_get(f"transcript:{cache_key}")
    if disk_val is not None:
        with _lock:
            _transcript_cache[cache_key] = disk_val
        return disk_val
    try:
        data = fmp._get("/earning-call-transcript", {"symbol": ticker, "limit": limit})
        result = data if isinstance(data, list) else []
    except Exception as e:
        logger.warning("transcript %s: %s", ticker, e)
        result = []
    with _lock:
        _transcript_cache[cache_key] = result
    if result:
        disk_set(f"transcript:{cache_key}", result, ttl=7 * 86400)  # 7 days — transcripts never change
    return result


def _get_quarterly_financials(ticker: str) -> dict:
    cache_key = f"{ticker}:qfin"
    with _lock:
        if cache_key in _filing_cache:
            return _filing_cache[cache_key]
    result = {}
    try:
        inc = fmp._get("/income-statement", {"symbol": ticker, "period": "quarter", "limit": 4})
        bal = fmp._get("/balance-sheet-statement", {"symbol": ticker, "period": "quarter", "limit": 2})
        cf  = fmp._get("/cash-flow-statement", {"symbol": ticker, "period": "quarter", "limit": 2})
        result = {
            "income":    inc[:4] if isinstance(inc, list) else [],
            "balance":   bal[:2] if isinstance(bal, list) else [],
            "cashflow":  cf[:2]  if isinstance(cf, list) else [],
        }
    except Exception as e:
        logger.warning("quarterly fin %s: %s", ticker, e)
    if not result.get("income"):
        try:
            import sec_fundamentals
            income = sec_fundamentals.get_quarterly_income(ticker, 8)
            if income:
                result = {"income": income, "balance": [], "cashflow": []}
        except Exception as e:
            logger.warning("SEC quarterly fundamentals %s: %s", ticker, e)
    with _lock:
        _filing_cache[cache_key] = result
    return result


def _fetch_edgar_filing_text(url: str, max_chars: int = 15000) -> str:
    """Fetch and lightly clean text from an SEC EDGAR filing HTML document."""
    try:
        r = requests.get(url, headers=_EDGAR_HEADERS, timeout=10)
        r.raise_for_status()
        text = r.text
        # Strip HTML tags
        import re as _re
        text = _re.sub(r'<[^>]+>', ' ', text)
        # Collapse whitespace
        text = _re.sub(r'\s+', ' ', text).strip()
        # Remove XBRL/boilerplate noise
        text = _re.sub(r'(?i)(XBRL|xmlns|xsi:|xlink:|schema|namespace)\S*', '', text)
        return text[:max_chars]
    except Exception as e:
        logger.warning("EDGAR text fetch %s: %s", url, e)
        return ""


def _get_edgar_filing_context(ticker: str, form_types: list[str], primary: str | None = None, count: int = 2) -> str:
    """Fetch SEC filing text. With a `primary` form (e.g. '10-K') it pulls the
    `count` most-recent filings of that form — so 'include annual, 4 reports'
    actually returns four 10-Ks — plus the latest of each other requested form.
    """
    n = max(1, min(count, 4))
    cache_key = f"{ticker}:edgar:{_CACHE_VER}:{'_'.join(form_types)}:{primary}:{n}"
    disk_val = disk_get(f"edgar:{cache_key}")
    if disk_val:
        return disk_val

    filings = _get_recent_filings(ticker, form_types)
    if not filings:
        return ""

    picked: list[dict] = []
    if primary:
        # The N most-recent filings of the primary form (e.g. annual 10-Ks)…
        picked = [f for f in filings if f["form"] == primary][:n]
        # …plus the latest of every other requested form for extra context.
        for form in form_types:
            if form == primary:
                continue
            match = next((f for f in filings if f["form"] == form), None)
            if match and match not in picked:
                picked.append(match)
    else:
        seen: set[str] = set()
        for f in filings:
            if f["form"] not in seen:
                picked.append(f)
                seen.add(f["form"])
        for f in filings:
            if len(picked) >= max(n, 2):
                break
            if f not in picked:
                picked.append(f)

    if not picked:
        return ""
    # Share the text budget across however many filings we pull.
    per_chars = 12000 if len(picked) <= 1 else max(4500, 30000 // len(picked))
    parts = []
    for filing in picked:
        text = _fetch_edgar_filing_text(filing["url"], max_chars=per_chars)
        if text and len(text) > 500:
            parts.append(
                f"=== SEC {filing['form']} FILING ({filing['date']}) ===\n{text}"
            )

    result = "\n\n".join(parts)
    if result:
        disk_set(f"edgar:{cache_key}", result, ttl=7 * 86400)  # 7 days
    return result


def _get_annual_financials(ticker: str, count: int = 3) -> dict:
    """Annual (10-K) income, balance sheet, and cash-flow statements from FMP."""
    n = max(1, min(count, 5))
    cache_key = f"{ticker}:afin:{n}"
    with _lock:
        if cache_key in _filing_cache:
            return _filing_cache[cache_key]
    result = {}
    try:
        inc = fmp._get("/income-statement", {"symbol": ticker, "period": "annual", "limit": n})
        bal = fmp._get("/balance-sheet-statement", {"symbol": ticker, "period": "annual", "limit": n})
        cf  = fmp._get("/cash-flow-statement", {"symbol": ticker, "period": "annual", "limit": n})
        result = {
            "income":   inc[:n] if isinstance(inc, list) else [],
            "balance":  bal[:n] if isinstance(bal, list) else [],
            "cashflow": cf[:n]  if isinstance(cf, list) else [],
        }
    except Exception as e:
        logger.warning("annual fin %s: %s", ticker, e)
    if not result.get("income"):
        try:
            import sec_fundamentals
            income = sec_fundamentals.get_income(ticker, n)
            if income:
                result = {
                    "income": income,
                    "balance": [sec_fundamentals.get_balance(ticker)],
                    "cashflow": [sec_fundamentals.get_cashflow(ticker)],
                }
        except Exception as e:
            logger.warning("SEC annual fundamentals %s: %s", ticker, e)
    with _lock:
        _filing_cache[cache_key] = result
    return result


def _annual_period_label(ticker: str) -> str | None:
    """Fiscal-year label for an annual (10-K) summary, e.g. 'FY2025'."""
    try:
        for row in _get_annual_financials(ticker, 1).get("income") or []:
            r = row or {}
            fy = str(r.get("fiscalYear") or r.get("calendarYear") or "").strip()
            d = str(r.get("date") or "")[:10]
            if not fy and d:
                fy = d[:4]
            if fy:
                return f"FY{fy}"
    except Exception:
        pass
    # Fallback: the year of the most recent 10-K filing.
    try:
        ks = _get_recent_filings(ticker, ["10-K"])
        if ks:
            return f"FY{ks[0]['date'][:4]}"
    except Exception:
        pass
    return None


def _get_finnhub_financials(ticker: str, freq: str = "quarterly", count: int = 2) -> str:
    """Reported financials from Finnhub — free, and the annual feed is the
    fallback annual-report source when FMP is unavailable."""
    try:
        import finnhub as fh
        if not fh.available():
            return ""
        data = fh._get("/stock/financials-reported", {"symbol": ticker, "freq": freq})
        if not isinstance(data, dict) or not data.get("data"):
            return ""
        n = max(1, min(count, 5))
        reports = data["data"][:n]
        import json
        unit = "fiscal years (10-K)" if freq == "annual" else "quarters"
        return f"=== REPORTED FINANCIALS (Finnhub, last {len(reports)} {unit}) ===\n{json.dumps(reports, indent=2)[:8000]}"
    except Exception:
        return ""


# ── Claude summariser ─────────────────────────────────────────────────────────

def _sanitise_quarter(result: dict, cur_year: int) -> None:
    """
    Guard against the LLM producing a plain calendar-year quarter that is in
    the future (e.g. "Q1 2027" when today is mid-2026).  If the label looks
    like "Q{N} {YYYY}" with YYYY > cur_year, rewrite it as "Q{N} FY{YYYY}" so
    the fiscal-year nature is explicit rather than appearing to be a future date.
    Also patches any text fields (verdict, guidance) that contain the same label.
    """
    q = result.get("quarter", "")
    if not q:
        return
    import re as _re
    m = _re.match(r"^(Q[1-4])\s+(\d{4})$", q.strip())
    if m and int(m.group(2)) > cur_year:
        old_label = q.strip()
        new_label = f"{m.group(1)} FY{m.group(2)}"
        result["quarter"] = new_label
        for field in ("verdict", "guidance", "analyst_questions_focus"):
            if isinstance(result.get(field), str):
                result[field] = result[field].replace(old_label, new_label)


def _canonical_quarter_label(income: list) -> str | None:
    """Authoritative fiscal-period label from the most recent FMP quarterly income
    statement, so the displayed quarter comes from real statement data rather than
    an LLM guess. Returns e.g. 'Q1 FY2027' (non-calendar fiscal year, fiscalYear
    differs from the calendar year of the period end) or 'Q3 2025'. Skips any row
    whose period-end is in the future (preliminary/bad data)."""
    import datetime as _d
    for row in income or []:
        row = row or {}
        period = str(row.get("period") or "").upper()
        if not re.match(r"^Q[1-4]$", period):
            continue
        date_str = str(row.get("date") or "")[:10]
        try:
            if date_str and _d.date.fromisoformat(date_str) > _d.date.today():
                continue
        except ValueError:
            date_str = ""
        fiscal   = str(row.get("fiscalYear") or "").strip()
        calendar = str(row.get("calendarYear") or (date_str[:4] if date_str else "")).strip()
        if fiscal and calendar and fiscal != calendar:
            return f"{period} FY{fiscal}"
        yr = fiscal or calendar
        return f"{period} {yr}" if yr else None
    return None


def _finalise_quarter(result: dict, ticker: str, cur_year: int) -> None:
    """Prefer the period straight from the financial statements (authoritative);
    fall back to sanitising the LLM's guess only when no statement data exists."""
    label = _canonical_quarter_label(_get_quarterly_financials(ticker).get("income", []))
    if label:
        result["quarter"] = label
    else:
        _sanitise_quarter(result, cur_year)


def _finalise_period(result: dict, ticker: str, annual: bool, cur_year: int) -> None:
    """Label the period — a fiscal year (FY2025) for an annual 10-K summary,
    otherwise the quarterly label."""
    if not annual:
        _finalise_quarter(result, ticker, cur_year)
        return
    label = _annual_period_label(ticker)
    if label:
        result["quarter"] = label
        return
    # No statement/filing data — coerce any quarterly guess into a fiscal year.
    q = str(result.get("quarter", "")).strip()
    m = re.match(r"^Q[1-4]\s+(?:FY)?(\d{4})$", q)
    if m:
        result["quarter"] = f"FY{m.group(1)}"


def _income_period_label(row: dict | None) -> str | None:
    """Fiscal-period label for one income-statement row, e.g. 'Q1 FY2027',
    'Q3 2025', or 'FY2025'. Used to label each per-filing card with its own
    period rather than the latest one."""
    row = row or {}
    period = str(row.get("period") or "").upper()
    fiscal = str(row.get("fiscalYear") or "").strip()
    date_str = str(row.get("date") or "")[:10]
    calendar = str(row.get("calendarYear") or (date_str[:4] if date_str else "")).strip()
    if re.match(r"^Q[1-4]$", period):
        if fiscal and calendar and fiscal != calendar:
            return f"{period} FY{fiscal}"
        yr = fiscal or calendar
        return f"{period} {yr}" if yr else None
    yr = fiscal or calendar
    return f"FY{yr}" if yr else None


def _summarise_with_claude(ticker: str, context: str, annual: bool = False, finalise: bool = True) -> dict:
    from ai_client import groq_chat, MODEL_SMART
    import datetime as _dt
    _today = _dt.date.today().strftime("%B %d, %Y")
    prompt = f"""You are a senior equity research analyst. Today's date is {_today}. Analyze the following earnings materials for {ticker} and produce a structured research note.

<materials>
{context[:40000]}
</materials>

Respond ONLY with valid JSON matching this exact schema (no markdown, no extra text):
{{
  "quarter": "Extract the fiscal period label from the materials — look for 'quarter ended', 'period ended', or explicit quarter labels in the financial statements. Use the MOST RECENT completed period found in the materials. If the company has a non-calendar fiscal year, use 'Q{{N}} FY{{YEAR}}' format (e.g. Q1 FY2027). If calendar year, use 'Q{{N}} {{YEAR}}' (e.g. Q3 2025). The period-end date MUST be on or before today ({_today}) — NEVER produce a future quarter.",
  "verdict": "one sentence that names the two or three most decision-relevant reported statistics and says whether the result beat, met, or missed the disclosed forecast where available",
  "bull_points": ["point 1", "point 2", "point 3"],
  "bear_points": ["point 1", "point 2", "point 3"],
  "key_metrics": [
    {{"name": "Revenue", "value": "$X.XB", "vs_est": "+2.3% or N/A", "yoy": "+18%"}},
    {{"name": "Diluted EPS", "value": "$X.XX", "vs_est": "+$0.12 or N/A", "yoy": "+22%"}},
    {{"name": "Net income", "value": "$X.XB", "vs_est": "N/A unless stated", "yoy": "+22%"}},
    {{"name": "Operating income or margin", "value": "$X.XB or XX.X%", "vs_est": "N/A unless stated", "yoy": "+XX% or +XXbps"}},
    {{"name": "Free cash flow or a company KPI", "value": "$X.XB or X", "vs_est": "N/A unless stated", "yoy": "+XX%"}}
  ],
  "guidance": "management guidance summary or N/A",
  "management_tone": "bullish | neutral | cautious | mixed",
  "key_themes": ["AI adoption", "margin expansion"],
  "risks": ["macro headwinds", "competition"],
  "analyst_questions_focus": "main topics analysts pressed on"
}}

Use only figures and forecast comparisons explicitly supported by the materials. Include Revenue, Diluted EPS, Net income, Operating income or margin, and Free cash flow when reported; then include up to two company-specific KPIs that management reports. For every metric with a disclosed analyst or management forecast, state the actual, forecast, and variance in `vs_est`. Write "N/A" when no comparable forecast exists—never invent consensus. Never output placeholders such as "$X.XB", "X%", or fabricated numbers. Keep every bull and bear point numeric where the materials support it."""

    msg = groq_chat(
        [{"role": "user", "content": prompt}],
        model=MODEL_SMART,
        max_tokens=2048,
    )
    raw = (msg.choices[0].message.content or "").strip()
    import datetime as _dt2
    _cur_year = _dt2.date.today().year
    # Strip any accidental markdown fences
    raw = re.sub(r"^```(?:json)?\s*", "", raw)
    raw = re.sub(r"\s*```$", "", raw)
    import json

    # Attempt direct parse first
    try:
        parsed = json.loads(raw)
        _remove_summary_placeholders(parsed)
        if finalise:
            _finalise_period(parsed, ticker, annual, _cur_year)
        return parsed
    except json.JSONDecodeError:
        pass

    # Repair truncated JSON: close any open structures so we get partial data
    # rather than a hard error
    try:
        # Count open braces/brackets and close them
        open_braces   = raw.count('{') - raw.count('}')
        open_brackets = raw.count('[') - raw.count(']')
        # Trim trailing incomplete value (mid-string truncation)
        repaired = raw.rstrip().rstrip(',')
        repaired += ']' * max(open_brackets, 0)
        repaired += '}' * max(open_braces, 0)
        parsed = json.loads(repaired)
        _remove_summary_placeholders(parsed)
        if finalise:
            _finalise_period(parsed, ticker, annual, _cur_year)
        return parsed
    except Exception:
        raise HTTPException(500, "Claude returned malformed JSON — try again")


def _remove_summary_placeholders(summary: dict) -> None:
    """Keep a failed extraction from appearing as a made-up reported figure."""
    marker = re.compile(r"\$?X(?:\.X+)?(?:[BMK%])?", re.I)

    def clean(value):
        return marker.sub("not disclosed", value) if isinstance(value, str) else value

    for key in ("verdict", "guidance", "analyst_questions_focus"):
        summary[key] = clean(summary.get(key))
    for key in ("bull_points", "bear_points", "key_themes", "risks"):
        if isinstance(summary.get(key), list):
            summary[key] = [clean(item) for item in summary[key]]
    if isinstance(summary.get("key_metrics"), list):
        summary["key_metrics"] = [
            {field: clean(value) for field, value in row.items()} if isinstance(row, dict) else row
            for row in summary["key_metrics"]
        ]


# ── Request / response schemas ────────────────────────────────────────────────

class SummariseRequest(BaseModel):
    tickers:       list[str] = Field(min_length=1, max_length=10)
    include_10q:   bool = True
    include_10k:   bool = False
    transcript_limit: int = Field(default=1, ge=1, le=4)

class FilingsRequest(BaseModel):
    ticker: str
    form_types: list[str] = ["10-Q", "10-K", "8-K"]


# ── Routes ────────────────────────────────────────────────────────────────────

@router.get("/transcripts/{ticker}")
def get_transcripts(ticker: str, limit: int = 3):
    sym = validate_ticker(ticker)
    # Try FMP transcripts first (requires paid plan — silently falls through if unavailable)
    if fmp.available():
        txs = _get_transcripts(sym, limit)
        if txs:
            return {"ticker": sym, "transcripts": txs, "source": "fmp"}
    # Fall back: EDGAR 8-K earnings releases are free and always available
    filings_8k = _get_recent_filings(sym, ["8-K"])
    if filings_8k:
        pseudo = [
            {
                "date": f["date"],
                "quarter": None,
                "year": int(f["date"][:4]),
                "form": "8-K",
                "url": f["url"],
                "content": "",
            }
            for f in filings_8k[:limit]
        ]
        return {"ticker": sym, "transcripts": pseudo, "source": "sec_8k"}
    raise HTTPException(404, f"No transcripts or 8-K filings found for {sym}")


@router.get("/filings/{ticker}")
def get_sec_filings(ticker: str):
    sym = validate_ticker(ticker)
    filings = _get_recent_filings(sym, ["10-K", "10-Q", "8-K"])
    return {"ticker": sym, "filings": filings}


@router.delete("/cache/{ticker}")
def clear_ticker_cache(ticker: str):
    """Evict all cached summaries for a ticker from both in-memory and disk caches."""
    sym = validate_ticker(ticker)
    evicted = 0
    with _lock:
        keys_to_delete = [k for k in list(_summary_cache.keys()) if k.startswith(f"{sym}:")]
        for k in keys_to_delete:
            del _summary_cache[k]
            evicted += 1
    try:
        import sqlite3, os
        # disk_cache.py resolves path relative to server's CWD (project root)
        db_path = os.path.join(os.getcwd(), '.cache', 'disk_cache.db')
        if os.path.exists(db_path):
            conn = sqlite3.connect(db_path)
            conn.execute("DELETE FROM cache WHERE key LIKE ?", (f"summary:{sym}:%",))
            evicted += conn.total_changes
            conn.commit()
            conn.close()
    except Exception as e:
        logger.warning("disk cache clear %s: %s", sym, e)
    return {"ticker": sym, "evicted": evicted}


@router.post("/summarise")
def summarise(req: SummariseRequest):
    tickers = validate_tickers(req.tickers)
    results = []

    for ticker in tickers:
        cache_key = f"{ticker}:summary:{_CACHE_VER}:{req.include_10q}:{req.include_10k}:{req.transcript_limit}"
        with _lock:
            if cache_key in _summary_cache:
                results.append(_summary_cache[cache_key])
                continue
        disk_val = disk_get(f"summary:{cache_key}")
        if disk_val is not None:
            with _lock:
                _summary_cache[cache_key] = disk_val
            results.append(disk_val)
            continue

        context_parts = []

        # 1. Earnings call transcripts (FMP — requires paid plan; silently skipped on 402)
        if fmp.available():
            txs = _get_transcripts(ticker, req.transcript_limit)
            for tx in txs:
                content = tx.get("content", "")[:12000]
                if content:
                    context_parts.append(
                        f"=== EARNINGS CALL TRANSCRIPT {tx.get('date','')[:10]} Q{tx.get('quarter','')} {tx.get('year','')} ===\n{content}"
                    )

        # 2. Quarterly financials from FMP (income, balance, cashflow)
        if fmp.available() and (req.include_10q or req.include_10k):
            fin = _get_quarterly_financials(ticker)
            import json as _json
            if fin.get("income"):
                context_parts.append(
                    f"=== QUARTERLY INCOME STATEMENTS (latest 4 quarters) ===\n{_json.dumps(fin['income'], indent=2)[:5000]}"
                )
            if fin.get("balance"):
                context_parts.append(
                    f"=== BALANCE SHEET (latest 2 quarters) ===\n{_json.dumps(fin['balance'], indent=2)[:3000]}"
                )
            if fin.get("cashflow"):
                context_parts.append(
                    f"=== CASH FLOW (latest 2 quarters) ===\n{_json.dumps(fin['cashflow'], indent=2)[:2000]}"
                )

        annual = req.include_10k and not req.include_10q
        count = req.transcript_limit

        # 2b. Annual (10-K) financial statements when annual data is requested —
        # `count` fiscal years so "4 reports" pulls four years.
        if fmp.available() and req.include_10k:
            afin = _get_annual_financials(ticker, count)
            import json as _json2
            if afin.get("income"):
                context_parts.append(
                    f"=== ANNUAL INCOME STATEMENTS (latest {len(afin['income'])} fiscal years, 10-K) ===\n{_json2.dumps(afin['income'], indent=2)[:7000]}"
                )
            if afin.get("balance"):
                context_parts.append(
                    f"=== ANNUAL BALANCE SHEET ({len(afin['balance'])} fiscal years, 10-K) ===\n{_json2.dumps(afin['balance'], indent=2)[:4000]}"
                )
            if afin.get("cashflow"):
                context_parts.append(
                    f"=== ANNUAL CASH FLOW ({len(afin['cashflow'])} fiscal years, 10-K) ===\n{_json2.dumps(afin['cashflow'], indent=2)[:3000]}"
                )

        # 3. SEC EDGAR filing text (always free) — `count` 10-Ks when annual.
        if req.include_10k:
            edgar_text = _get_edgar_filing_context(ticker, ["10-K", "10-Q"] if req.include_10q else ["10-K"], primary="10-K", count=count)
            if edgar_text:
                context_parts.append(edgar_text)
        elif req.include_10q:
            edgar_text = _get_edgar_filing_context(ticker, ["10-Q"], primary="10-Q", count=count)
            if edgar_text:
                context_parts.append(edgar_text)

        # 4. Finnhub reported financials (free) — the annual feed is the fallback
        # annual-report source when FMP is unavailable.
        if not any("INCOME" in p or "BALANCE" in p for p in context_parts):
            fh_fin = _get_finnhub_financials(ticker, "annual" if annual else "quarterly", count)
            if fh_fin:
                context_parts.append(fh_fin)

        # SEC filing links (fetch and include first 8K body if recent)
        if req.include_10k:
            filings = _get_recent_filings(ticker, ["10-K", "10-Q"])
            if filings:
                context_parts.append(
                    f"=== SEC FILINGS AVAILABLE ===\n" +
                    "\n".join(f"{f['form']} filed {f['date']}: {f['url']}" for f in filings)
                )

        if not context_parts:
            results.append({
                "ticker": ticker,
                "error": "No financial data found for this ticker. Try enabling '10-Q' or '10-K' to pull SEC filings.",
            })
            continue

        context = "\n\n".join(context_parts)
        try:
            summary = _summarise_with_claude(ticker, context, annual=annual)
            entry = {"ticker": ticker, "summary": summary, "sources": len(context_parts)}
            with _lock:
                _summary_cache[cache_key] = entry
            disk_set(f"summary:{cache_key}", entry, ttl=86400)  # 1 day
            results.append(entry)
        except HTTPException:
            raise
        except Exception as e:
            logger.exception("summarise %s", ticker)
            results.append({"ticker": ticker, "error": str(e)})

    return {"results": results}


# ── Streaming endpoint ────────────────────────────────────────────────────────

def _sse(data: dict) -> str:
    return f"data: {json.dumps(data)}\n\n"


def _income_statements(ticker: str, period: str, limit: int) -> list:
    """Income statements from FMP (period='quarter'|'annual'), cached. Used both
    for the per-filing context and for computing key metrics deterministically."""
    cache_key = f"{ticker}:inc:{period}:{limit}"
    with _lock:
        if cache_key in _filing_cache:
            return _filing_cache[cache_key]
    try:
        data = fmp._get("/income-statement", {"symbol": ticker, "period": period, "limit": limit})
        result = data if isinstance(data, list) else []
    except Exception as e:
        logger.warning("income %s: %s", ticker, e)
        result = []
    with _lock:
        _filing_cache[cache_key] = result
    return result


def _fmt_money(v: float) -> str:
    a = abs(v)
    if a >= 1e9:
        return f"${v / 1e9:.2f}B"
    if a >= 1e6:
        return f"${v / 1e6:.1f}M"
    return f"${v:,.0f}"


def _num(row: dict | None, *keys: str) -> float | None:
    for k in keys:
        v = (row or {}).get(k)
        if isinstance(v, (int, float)):
            return float(v)
    return None


def _yoy(cur: float | None, prev: float | None) -> str | None:
    if cur is None or prev is None or prev == 0:
        return None
    return f"{(cur - prev) / abs(prev) * 100:+.0f}%"


def _gross_margin(row: dict | None) -> float | None:
    rev = _num(row, "revenue")
    gp = _num(row, "grossProfit")
    return (gp / rev * 100) if (rev and gp is not None) else None


def _eps_of(row: dict | None) -> float | None:
    return _num(row, "epsdiluted", "epsDiluted", "eps")


def _metric_delta(actual: float | None, estimate: float | None, is_money: bool = False) -> tuple[str | None, str | None]:
    if actual is None or estimate is None:
        return None, None
    delta = actual - estimate
    if estimate:
        pct = f"{delta / abs(estimate) * 100:+.1f}%"
    else:
        pct = None
    return (_fmt_money(delta) if is_money else f"${delta:+.2f}"), pct


def _compute_metrics_block(hist: list, i: int, annual: bool, cashflow: dict | None = None,
                           surprise: dict | None = None) -> dict | None:
    """Headline metrics computed straight from the income statements (real
    numbers, never an LLM guess): EPS, Revenue, revenue YoY (vs the same period a
    year earlier) with the prior period's YoY for context, and gross margin with
    its change vs the previous period. `hist` is reverse-chronological; `i` is the
    filing's index within it. Returns None when there's no usable statement."""
    cur = hist[i] if i < len(hist) else None
    if not cur:
        return None
    step = 1 if annual else 4                      # periods back for a YoY comparison
    yb    = hist[i + step]     if i + step < len(hist)     else None   # year-ago
    prior = hist[i + 1]        if i + 1 < len(hist)        else None   # previous period
    pyb   = hist[i + 1 + step] if i + 1 + step < len(hist) else None   # prior period's year-ago

    rev, eps, gm = _num(cur, "revenue"), _eps_of(cur), _gross_margin(cur)
    net_income = _num(cur, "netIncome")
    operating_income = _num(cur, "operatingIncome")
    free_cash_flow = _num(cashflow, "freeCashFlow")
    eps_est = _num(surprise, "estimatedEarning", "estimatedEPS", "epsEstimate")
    revenue_est = _num(surprise, "estimatedRevenue", "revenueEstimate")
    block: dict = {}
    if eps is not None:
        block["eps"] = {"value": f"${eps:.2f}", "yoy": _yoy(eps, _eps_of(yb))}
    if rev is not None:
        block["revenue"] = {"value": _fmt_money(rev), "yoy": _yoy(rev, _num(yb, "revenue"))}
    rev_yoy = _yoy(rev, _num(yb, "revenue"))
    if rev_yoy:
        prior_yoy = _yoy(_num(prior, "revenue"), _num(pyb, "revenue")) if prior else None
        block["rev_yoy"] = {"value": rev_yoy, "prior": prior_yoy}
    if gm is not None:
        gm_prior = _gross_margin(prior)
        block["gross_margin"] = {
            "value": f"{gm:.1f}%",
            "delta_bps": round((gm - gm_prior) * 100) if gm_prior is not None else None,
            "basis": "YoY" if annual else "QoQ",
        }
    rows = []
    if eps is not None:
        variance, variance_pct = _metric_delta(eps, eps_est)
        rows.append({"name": "Diluted EPS", "actual": f"${eps:.2f}", "estimate": f"${eps_est:.2f}" if eps_est is not None else None,
                     "variance": variance, "variance_pct": variance_pct, "yoy": _yoy(eps, _eps_of(yb))})
    if rev is not None:
        variance, variance_pct = _metric_delta(rev, revenue_est, is_money=True)
        rows.append({"name": "Revenue", "actual": _fmt_money(rev), "estimate": _fmt_money(revenue_est) if revenue_est is not None else None,
                     "variance": variance, "variance_pct": variance_pct, "yoy": _yoy(rev, _num(yb, "revenue"))})
    if net_income is not None:
        rows.append({"name": "Net income", "actual": _fmt_money(net_income), "yoy": _yoy(net_income, _num(yb, "netIncome"))})
    if operating_income is not None:
        rows.append({"name": "Operating income", "actual": _fmt_money(operating_income), "yoy": _yoy(operating_income, _num(yb, "operatingIncome"))})
    if free_cash_flow is not None:
        rows.append({"name": "Free cash flow", "actual": _fmt_money(free_cash_flow), "yoy": None})
    if gm is not None:
        rows.append({"name": "Gross margin", "actual": f"{gm:.1f}%", "yoy": _yoy(gm, _gross_margin(yb))})
    if rows:
        block["reported_vs_consensus"] = rows
    return block or None


def _earnings_surprises(ticker: str) -> list[dict]:
    """Historical EPS and revenue consensus from FMP when the plan exposes it.
    The filing statements remain the source of actual results; this endpoint only
    supplies the contemporaneous consensus values used for the variance column."""
    cache_key = f"earnings-surprises:{ticker}"
    cached = disk_get(cache_key)
    if cached is not None:
        return cached
    rows: list[dict] = []
    if fmp.available():
        try:
            data = fmp._get("/earnings-surprises", {"symbol": ticker, "limit": 12})
            if isinstance(data, list):
                rows = data
        except Exception as e:
            logger.warning("earnings surprises %s: %s", ticker, e)
    disk_set(cache_key, rows, ttl=86400)
    return rows


def _match_earnings_surprise(rows: list[dict], filing_date: str) -> dict | None:
    """Match the closest reported earnings release before its related filing."""
    import datetime as _dt
    try:
        filed = _dt.date.fromisoformat(filing_date[:10])
    except ValueError:
        return None
    matches = []
    for row in rows:
        try:
            reported = _dt.date.fromisoformat(str(row.get("date") or row.get("fiscalDateEnding") or "")[:10])
        except ValueError:
            continue
        lag = (filed - reported).days
        if 0 <= lag <= 100:
            matches.append((lag, row))
    return min(matches, key=lambda item: item[0])[1] if matches else None


def _company_name(ticker: str) -> str | None:
    try:
        name = (fmp.get_profile(ticker) or {}).get("companyName")
        if name:
            return name
    except Exception:
        pass
    _ensure_company_tickers()                      # free EDGAR fallback
    return _name_by_ticker.get(ticker.upper())


def _earnings_reactions(ticker: str) -> list[dict]:
    """One-day price reaction for each recent earnings release, using the 8-K
    (Results of Operations) filing date as the announcement date and free
    yfinance daily closes for the move. After-close convention: the reaction is
    the next session's close vs the prior close (the norm for large caps).
    Returns [{date, pct}], cached for a day."""
    cache_key = f"reactions:8k2:{ticker}"
    cached = disk_get(cache_key)
    if cached is not None:
        return cached
    import datetime as _dt
    out: list[dict] = []
    try:
        import sys as _sys, os as _os
        _sys.path.insert(0, _os.path.dirname(_os.path.dirname(__file__)))
        import cache as _price_cache
        eights = _get_recent_filings(ticker, ["8-K"])
        # Earnings releases carry SEC item 2.02 (Results of Operations). Filter to
        # those so the reaction is the genuine earnings move, not an unrelated 8-K.
        earnings_8k = [f for f in eights if "2.02" in (f.get("items") or "")]
        eights = earnings_8k or eights
        hist = _price_cache.get_history(ticker, period="2y")
        if not eights or hist.empty or "Close" not in hist:
            disk_set(cache_key, [], ttl=86400)
            return []
        closes = hist["Close"].dropna()
        pdates = [d.date() for d in closes.index]
        vals = [float(v) for v in closes.values]
        seen: set = set()
        for f in eights:
            try:
                ann_date = _dt.date.fromisoformat(f["date"][:10])
            except ValueError:
                continue
            if ann_date in seen:
                continue
            seen.add(ann_date)
            day_i = next((i for i, d in enumerate(pdates) if d > ann_date), None)
            if day_i is None or day_i < 1 or day_i >= len(vals):
                continue
            c1, c0 = vals[day_i], vals[day_i - 1]
            if c0:
                out.append({"date": ann_date.isoformat(), "pct": round((c1 / c0 - 1) * 100, 1)})
    except Exception as e:
        logger.warning("reactions %s: %s", ticker, e)
    disk_set(cache_key, out, ttl=86400)
    return out


def _match_reaction(reactions: list[dict], filing_date: str) -> dict | None:
    """The earnings reaction for a filing's quarter: the most recent earnings
    release on or before the filing date (earnings always precede the 10-Q/10-K).
    A release after the filing belongs to the next quarter, so it's never matched.
    None when nothing lands within ~90 days before the filing."""
    if not reactions:
        return None
    import datetime as _dt
    try:
        fd = _dt.date.fromisoformat(filing_date[:10])
    except ValueError:
        return None
    before = []
    for r in reactions:
        try:
            rd = _dt.date.fromisoformat(r["date"])
        except ValueError:
            continue
        delta = (fd - rd).days
        if 0 <= delta <= 90:
            before.append((delta, r))
    if not before:
        return None
    before.sort(key=lambda x: x[0])
    return before[0][1]


def _summarise_one_filing(ticker: str, filing: dict, fin_rows: dict, annual: bool,
                          metrics: dict | None = None, company: str | None = None,
                          segments: list | None = None, reaction: dict | None = None) -> dict:
    """Summarise a single SEC filing into one research-note card. Context is that
    filing's own EDGAR text plus its matching period of financial statements, so
    each card reflects a distinct period rather than a synthesis of all of them."""
    cache_key = f"{ticker}:filing:{_CACHE_VER}:{filing['form']}:{filing['date']}"
    with _lock:
        cached = _summary_cache.get(cache_key)
    if cached:
        return cached
    disk_val = disk_get(f"summary:{cache_key}")
    if disk_val:
        with _lock:
            _summary_cache[cache_key] = disk_val
        return disk_val

    parts = []
    text = _fetch_edgar_filing_text(filing["url"], max_chars=15000)
    if text and len(text) > 500:
        parts.append(f"=== SEC {filing['form']} FILING ({filing['date']}) ===\n{text}")
    inc_row = fin_rows.get("income")
    if inc_row:
        parts.append(f"=== INCOME STATEMENT ===\n{json.dumps(inc_row, indent=2)[:4000]}")
    if fin_rows.get("balance"):
        parts.append(f"=== BALANCE SHEET ===\n{json.dumps(fin_rows['balance'], indent=2)[:3000]}")
    if fin_rows.get("cashflow"):
        parts.append(f"=== CASH FLOW ===\n{json.dumps(fin_rows['cashflow'], indent=2)[:2000]}")

    if not parts:
        return {"ticker": ticker, "id": cache_key, "filed": filing["date"], "url": filing["url"],
                "error": f"Could not read the {filing['form']} filed {filing['date']} from SEC EDGAR."}

    context = "\n\n".join(parts)
    summary = _summarise_with_claude(ticker, context, annual=annual, finalise=False)
    # Label this card with its own period (from its statement row, else the LLM
    # guess, else the filing date), never the latest overall period.
    generated_period = str(summary.get("quarter") or "").strip()
    usable_generated_period = generated_period if generated_period and generated_period.upper() not in {"N/A", "NA", "UNKNOWN"} else None
    summary["quarter"] = _income_period_label(inc_row) or usable_generated_period or (f"FY{filing['date'][:4]}" if annual else f"Filed {filing['date']}")
    entry = {"ticker": ticker, "id": cache_key, "company": company, "period": summary["quarter"],
             "form": filing["form"], "filed": filing["date"], "url": filing["url"],
             "metrics": metrics, "segments": segments or None, "reaction": reaction,
             "summary": summary, "sources": len(parts)}
    with _lock:
        _summary_cache[cache_key] = entry
    disk_set(f"summary:{cache_key}", entry, ttl=86400)
    return entry


def _summarise_one_streaming(ticker: str, req: SummariseRequest, queue: list):
    """Analyse the N most-recent filings for one ticker, emitting one card per
    filing. N is the requested filing count; form is 10-K when only annual data
    is requested, otherwise 10-Q."""
    annual = req.include_10k and not req.include_10q
    form = "10-K" if annual else "10-Q"
    n = max(1, min(req.transcript_limit, 4))

    queue.append(_sse({"type": "progress", "ticker": ticker, "stage": "Finding filings…", "pct": 8}))
    filings = _get_recent_filings(ticker, [form])[:n]
    if not filings:
        queue.append(_sse({"type": "result", "ticker": ticker, "data": {
            "ticker": ticker, "error": f"No {form} filings found on SEC EDGAR for {ticker}."}}))
        return

    # Income history goes one full year + one period past the requested count so
    # YoY and prior-period comparisons resolve for every card.
    hist = _income_statements(ticker, "annual" if annual else "quarter", n + (2 if annual else 6))
    fin = _get_annual_financials(ticker, n) if annual else _get_quarterly_financials(ticker)
    if not hist and fin.get("income"):
        hist = fin["income"]
    bal, cf = fin.get("balance") or [], fin.get("cashflow") or []
    company = _company_name(ticker)
    reactions = _earnings_reactions(ticker)
    surprises = _earnings_surprises(ticker)
    # Product-segment revenue (latest 10-K, free via SEC EDGAR) — attached to the
    # most recent card only since it reflects one annual breakdown.
    seg_latest = None
    try:
        import sec_segments
        seg = sec_segments.get_segment_revenue(ticker).get("latest") or []
        seg_latest = [{"name": s["name"], "value": s["value"]} for s in seg[:6]] or None
    except Exception:
        seg_latest = None

    total = len(filings)
    for i, filing in enumerate(filings):
        queue.append(_sse({"type": "progress", "ticker": ticker,
                           "stage": f"Analyzing {form} {i + 1} of {total}…",
                           "pct": int(15 + (i / total) * 80)}))
        rows = {
            "income":   hist[i] if i < len(hist) else None,
            "balance":  bal[i]  if i < len(bal)  else None,
            "cashflow": cf[i]   if i < len(cf)   else None,
        }
        try:
            entry = _summarise_one_filing(
                ticker, filing, rows, annual,
                metrics=_compute_metrics_block(
                    hist, i, annual, cashflow=rows["cashflow"],
                    surprise=_match_earnings_surprise(surprises, filing["date"]),
                ),
                company=company,
                segments=seg_latest if i == 0 else None,
                reaction=_match_reaction(reactions, filing["date"]),
            )
        except Exception as e:
            logger.exception("summarise-stream %s %s", ticker, filing.get("date"))
            entry = {"ticker": ticker, "id": f"{ticker}:{filing['date']}", "filed": filing["date"], "error": str(e)}
        queue.append(_sse({"type": "result", "ticker": ticker, "data": entry}))


@router.post("/summarise-stream")
async def summarise_stream(req: SummariseRequest):
    tickers = validate_tickers(req.tickers)

    async def generate():
        yield _sse({"type": "start", "tickers": tickers, "total": len(tickers)})

        # Run all tickers in parallel via threads, collect SSE chunks
        import concurrent.futures
        queues: dict[str, list] = {t: [] for t in tickers}

        with concurrent.futures.ThreadPoolExecutor(max_workers=min(len(tickers), 4)) as ex:
            futures = {ex.submit(_summarise_one_streaming, t, req, queues[t]): t for t in tickers}
            # Poll until all done, flushing SSE chunks as they appear
            done = set()
            while len(done) < len(tickers):
                for t in tickers:
                    while queues[t]:
                        yield queues[t].pop(0)
                await asyncio.sleep(0.1)
                for f, t in futures.items():
                    if f.done() and t not in done:
                        done.add(t)
                        # Flush remaining
                        while queues[t]:
                            yield queues[t].pop(0)

        yield _sse({"type": "done"})

    return StreamingResponse(generate(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})
