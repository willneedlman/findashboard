"""Upload a brokerage transaction export and get its performance back.

Nothing is stored. The CSV is parsed, analysed and discarded inside the request:
these files carry account numbers, and the tool has no reason to keep one.
"""
from __future__ import annotations

import logging

from fastapi import APIRouter, File, Form, HTTPException, UploadFile

import brokerage_import
import trade_analytics

router = APIRouter()
logger = logging.getLogger(__name__)

_MAX_BYTES = 4 << 20        # a decade of activity is far under this
_ALLOWED = ("fidelity", "robinhood", "")


@router.post("/analyze")
async def analyze_history(
    file: UploadFile = File(...),
    source: str = Form(""),
    benchmark: str = Form("SPY"),
    account: str = Form(""),
):
    """Parse an export, reconstruct the equity curve, and measure it.

    `source` may be blank: the header identifies the broker on its own, and
    guessing wrong is better caught here than by a parser producing nonsense.
    `account` filters a Fidelity export, which carries several accounts in one
    file and would otherwise blend a taxable book with an IRA.
    """
    if (source or "").lower() not in _ALLOWED:
        raise HTTPException(400, f"Unknown source '{source}'. Use fidelity or robinhood.")

    raw = await file.read()
    if len(raw) > _MAX_BYTES:
        raise HTTPException(413, "That file is larger than 4MB. Export a narrower date range.")
    if not raw.strip():
        raise HTTPException(400, "That file is empty.")

    text = raw.decode("utf-8-sig", errors="replace")
    detected = brokerage_import.detect_source(text)
    if source and detected and detected != source.lower():
        raise HTTPException(400, (
            f"This looks like a {detected} export but {source} was selected. "
            "Pick the matching broker, or leave the selection on auto-detect."
        ))
    try:
        parsed = brokerage_import.parse(text, source)
    except ValueError as e:
        raise HTTPException(400, str(e)) from e
    if not parsed.txns:
        raise HTTPException(400, "No transactions were found in that file.")

    txns = parsed.txns
    if account:
        txns = [t for t in txns if t.account == account]
        if not txns:
            raise HTTPException(400, f"No transactions for account '{account}' in that file.")

    result = trade_analytics.analyze(txns, benchmark=(benchmark or "SPY").upper())
    if "error" in result:
        raise HTTPException(422, result["error"])

    return {
        **result,
        "source": parsed.source,
        "accounts": parsed.accounts,
        "selectedAccount": account,
        "parsed": {
            "transactions": len(txns),
            "skipped": parsed.skipped[:10],
            "skippedCount": len(parsed.skipped),
        },
        "transactions": [t.as_dict() for t in txns[-200:]],
    }


@router.post("/inspect")
async def inspect_history(file: UploadFile = File(...), source: str = Form("")):
    """Identify a file and list its accounts, without running the analysis.

    A Fidelity export holds several accounts, and mixing a taxable book with an
    IRA into one curve measures nothing, so the account has to be chosen before
    there is anything worth computing.
    """
    raw = await file.read()
    if len(raw) > _MAX_BYTES:
        raise HTTPException(413, "That file is larger than 4MB.")
    text = raw.decode("utf-8-sig", errors="replace")
    try:
        parsed = brokerage_import.parse(text, source)
    except ValueError as e:
        raise HTTPException(400, str(e)) from e
    kinds: dict[str, int] = {}
    for t in parsed.txns:
        kinds[t.kind] = kinds.get(t.kind, 0) + 1
    return {
        "source": parsed.source,
        "accounts": parsed.accounts,
        "transactions": len(parsed.txns),
        "kinds": kinds,
        "firstDate": parsed.txns[0].date.isoformat() if parsed.txns else None,
        "lastDate": parsed.txns[-1].date.isoformat() if parsed.txns else None,
        "skippedCount": len(parsed.skipped),
        "skipped": parsed.skipped[:10],
    }
