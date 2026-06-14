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


# ── SEC EDGAR helpers ─────────────────────────────────────────────────────────

_EDGAR_HEADERS = {"User-Agent": "FinanceTerminal research@finterm.io"}

# Module-level cache so we only download the 5 MB company_tickers.json once per process
_cik_by_ticker: dict[str, str] = {}
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
        results = []
        for form, date, acc, doc in zip(forms, dates, accessions, primary_docs):
            if form in form_types:
                acc_clean = acc.replace("-", "")
                url = f"https://www.sec.gov/Archives/edgar/data/{int(cik)}/{acc_clean}/{doc}"
                results.append({"form": form, "date": date, "url": url, "accession": acc})
                if len(results) >= 4:
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


def _get_edgar_filing_context(ticker: str, form_types: list[str]) -> str:
    """Fetch actual text of most recent 10-K or 10-Q from SEC EDGAR."""
    cache_key = f"{ticker}:edgar:{'_'.join(form_types)}"
    disk_val = disk_get(f"edgar:{cache_key}")
    if disk_val:
        return disk_val

    filings = _get_recent_filings(ticker, form_types)
    if not filings:
        return ""

    parts = []
    for filing in filings[:2]:  # at most 2 filings
        text = _fetch_edgar_filing_text(filing["url"], max_chars=12000)
        if text and len(text) > 500:
            parts.append(
                f"=== SEC {filing['form']} FILING ({filing['date']}) ===\n{text}"
            )

    result = "\n\n".join(parts)
    if result:
        disk_set(f"edgar:{cache_key}", result, ttl=7 * 86400)  # 7 days
    return result


def _get_finnhub_financials(ticker: str) -> str:
    """Fetch reported financials from Finnhub as an additional context source."""
    try:
        import finnhub as fh
        if not fh.available():
            return ""
        data = fh._get("/stock/financials-reported", {"symbol": ticker, "freq": "quarterly"})
        if not isinstance(data, dict) or not data.get("data"):
            return ""
        reports = data["data"][:2]
        import json
        return f"=== REPORTED FINANCIALS (Finnhub, last 2 quarters) ===\n{json.dumps(reports, indent=2)[:6000]}"
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


def _summarise_with_claude(ticker: str, context: str) -> dict:
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
  "verdict": "one-sentence overall assessment",
  "bull_points": ["point 1", "point 2", "point 3"],
  "bear_points": ["point 1", "point 2", "point 3"],
  "key_metrics": [
    {{"name": "Revenue", "value": "$X.XB", "vs_est": "+2.3%", "yoy": "+18%"}},
    {{"name": "EPS", "value": "$X.XX", "vs_est": "+$0.12", "yoy": "+22%"}}
  ],
  "guidance": "management guidance summary or N/A",
  "management_tone": "bullish | neutral | cautious | mixed",
  "key_themes": ["AI adoption", "margin expansion"],
  "risks": ["macro headwinds", "competition"],
  "analyst_questions_focus": "main topics analysts pressed on"
}}"""

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
        _sanitise_quarter(parsed, _cur_year)
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
        _sanitise_quarter(parsed, _cur_year)
        return parsed
    except Exception:
        raise HTTPException(500, "Claude returned malformed JSON — try again")


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
        cache_key = f"{ticker}:summary:{req.include_10q}:{req.include_10k}:{req.transcript_limit}"
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

        # 3. SEC EDGAR 10-K / 10-Q actual filing text (always free, no API key)
        if req.include_10k:
            edgar_text = _get_edgar_filing_context(ticker, ["10-K", "10-Q"])
            if edgar_text:
                context_parts.append(edgar_text)
        elif req.include_10q:
            edgar_text = _get_edgar_filing_context(ticker, ["10-Q"])
            if edgar_text:
                context_parts.append(edgar_text)

        # 4. Finnhub reported financials (free backup)
        if not any("INCOME" in p or "BALANCE" in p for p in context_parts):
            fh_fin = _get_finnhub_financials(ticker)
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
            summary = _summarise_with_claude(ticker, context)
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


def _summarise_one_streaming(ticker: str, req: SummariseRequest, queue: list):
    """Run the full summarise pipeline for one ticker, appending SSE strings to queue."""
    cache_key = f"{ticker}:summary:{req.include_10q}:{req.include_10k}:{req.transcript_limit}"

    queue.append(_sse({"type": "progress", "ticker": ticker, "stage": "Checking cache…", "pct": 5}))

    # Cache hit
    with _lock:
        cached = _summary_cache.get(cache_key)
    if cached:
        queue.append(_sse({"type": "result", "ticker": ticker, "data": cached, "cached": True}))
        return
    disk_val = disk_get(f"summary:{cache_key}")
    if disk_val:
        with _lock:
            _summary_cache[cache_key] = disk_val
        queue.append(_sse({"type": "result", "ticker": ticker, "data": disk_val, "cached": True}))
        return

    context_parts = []

    queue.append(_sse({"type": "progress", "ticker": ticker, "stage": "Fetching transcripts…", "pct": 15}))
    if fmp.available():
        txs = _get_transcripts(ticker, req.transcript_limit)
        for tx in txs:
            content = tx.get("content", "")[:12000]
            if content:
                context_parts.append(
                    f"=== EARNINGS CALL TRANSCRIPT {tx.get('date','')[:10]} Q{tx.get('quarter','')} {tx.get('year','')} ===\n{content}"
                )

    queue.append(_sse({"type": "progress", "ticker": ticker, "stage": "Fetching financials…", "pct": 35}))
    if fmp.available() and (req.include_10q or req.include_10k):
        fin = _get_quarterly_financials(ticker)
        if fin.get("income"):
            context_parts.append(f"=== QUARTERLY INCOME STATEMENTS ===\n{json.dumps(fin['income'], indent=2)[:5000]}")
        if fin.get("balance"):
            context_parts.append(f"=== BALANCE SHEET ===\n{json.dumps(fin['balance'], indent=2)[:3000]}")
        if fin.get("cashflow"):
            context_parts.append(f"=== CASH FLOW ===\n{json.dumps(fin['cashflow'], indent=2)[:2000]}")

    queue.append(_sse({"type": "progress", "ticker": ticker, "stage": "Fetching SEC filings…", "pct": 55}))
    if req.include_10k:
        edgar_text = _get_edgar_filing_context(ticker, ["10-K", "10-Q"])
        if edgar_text:
            context_parts.append(edgar_text)
    elif req.include_10q:
        edgar_text = _get_edgar_filing_context(ticker, ["10-Q"])
        if edgar_text:
            context_parts.append(edgar_text)

    if not any("INCOME" in p or "BALANCE" in p for p in context_parts):
        fh_fin = _get_finnhub_financials(ticker)
        if fh_fin:
            context_parts.append(fh_fin)

    if not context_parts:
        queue.append(_sse({"type": "result", "ticker": ticker, "data": {"ticker": ticker, "error": "No financial data found. Enable 10-Q or 10-K."}}))
        return

    queue.append(_sse({"type": "progress", "ticker": ticker, "stage": "Analyzing with Claude…", "pct": 75}))
    context = "\n\n".join(context_parts)
    try:
        summary = _summarise_with_claude(ticker, context)
        entry = {"ticker": ticker, "summary": summary, "sources": len(context_parts)}
        with _lock:
            _summary_cache[cache_key] = entry
        disk_set(f"summary:{cache_key}", entry, ttl=86400)
        queue.append(_sse({"type": "result", "ticker": ticker, "data": entry}))
    except Exception as e:
        logger.exception("summarise-stream %s", ticker)
        queue.append(_sse({"type": "result", "ticker": ticker, "data": {"ticker": ticker, "error": str(e)}}))


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
