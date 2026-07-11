"""BCC Research market-sizing client — the public MCP semantic-search endpoint.

BCC Research exposes a single public, keyless MCP tool (``semantic_search``) over
streamable HTTP at ``https://public.mcp.bccresearch.com/mcp``. It returns market-
research reports with market-size and CAGR figures embedded in the highlights.
This module calls it server-side over JSON-RPC, extracts the report list, and
pulls a clean "size -> size by year, CAGR" headline out of the highlights text.

Report data changes slowly, so responses are cached 24h. Any failure returns []
so callers show an empty state rather than erroring.
"""
from __future__ import annotations

import json
import logging
import os
import re
import sys

import requests

sys.path.insert(0, os.path.dirname(__file__))
try:
    from disk_cache import disk_get, disk_set
except ImportError:                                   # pragma: no cover
    def disk_get(_k): return None
    def disk_set(_k, _v, ttl=0): pass

logger = logging.getLogger(__name__)

_URL = "https://public.mcp.bccresearch.com/mcp"
_TTL = 24 * 3600
_HEADERS = {"Content-Type": "application/json", "Accept": "application/json, text/event-stream"}

_SIZE = r"\$[\d.,]+\s?(?:trillion|billion|million)"


def _headline(h: str) -> dict | None:
    """Pull a market-size headline out of a report-highlights paragraph:
    {from, to, to_year, cagr} — best effort, None if no figures found."""
    if not h:
        return None
    frm = re.search(rf"from\s+({_SIZE})", h, re.I)
    to = re.search(rf"reach\s+({_SIZE})\s+by\s+(?:the end of\s+)?(\d{{4}})", h, re.I)
    cagr = re.search(r"CAGR\)?\s+of\s+([\d.]+)\s?%", h, re.I) or re.search(r"([\d.]+)\s?%\s+.*CAGR", h, re.I)
    if not (frm or to or cagr):
        return None
    return {
        "from": frm.group(1) if frm else None,
        "to": to.group(1) if to else None,
        "to_year": to.group(2) if to else None,
        "cagr": float(cagr.group(1)) if cagr else None,
    }


def _extract_rows(payload: str) -> list:
    """The MCP response may be JSON or SSE-framed. Return the report list."""
    text = payload.strip()
    if "data:" in text and text.split("\n", 1)[0].startswith(("event:", "data:", ":")):
        lines = [ln[5:].strip() for ln in text.splitlines() if ln.startswith("data:")]
        text = lines[-1] if lines else text
    d = json.loads(text)
    content = (d.get("result") or {}).get("content") or []
    blob = content[0].get("text", "") if content else ""
    m = re.search(r"\[\s*{.*}\s*\]", blob, re.S)
    return json.loads(m.group(0)) if m else []


def market_size(query: str, count: int = 5) -> list:
    """Top BCC reports for a natural-language query, shaped for display."""
    query = (query or "").strip()
    if not query:
        return []
    count = max(1, min(20, count))
    ck = f"bcc:{count}:{query.lower()}"
    cached = disk_get(ck)
    if cached is not None:
        return cached.get("rows", [])
    try:
        r = requests.post(_URL, headers=_HEADERS, timeout=30, json={
            "jsonrpc": "2.0", "id": 1, "method": "tools/call",
            "params": {"name": "semantic_search", "arguments": {
                "natural_language_search": query, "count": count, "format": "json"}},
        })
        if r.status_code != 200:
            logger.info("BCC market_size HTTP %s", r.status_code)
            disk_set(ck, {"rows": []}, ttl=1800)
            return []
        rows = _extract_rows(r.text)
    except Exception as e:
        logger.info("BCC market_size failed: %s", e)
        disk_set(ck, {"rows": []}, ttl=1800)
        return []

    out = []
    for x in rows:
        h = x.get("report_highlights", "")
        out.append({
            "report_code": x.get("report_code"),
            "heading": x.get("report_heading"),
            "category": x.get("category"),
            "published": x.get("published_date"),
            "author": x.get("author"),
            "url": x.get("report_page_name"),
            "score": round(x.get("score", 0), 3) if isinstance(x.get("score"), (int, float)) else None,
            "highlights": h,
            "headline": _headline(h),
        })
    disk_set(ck, {"rows": out}, ttl=_TTL)
    return out
