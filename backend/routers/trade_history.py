"""Upload a brokerage transaction export and get its performance back.

Nothing is stored. The CSV is parsed, analysed and discarded inside the request:
these files carry account numbers, and the tool has no reason to keep one.
"""
from __future__ import annotations

import json
import logging

from fastapi import APIRouter, Body, File, Form, HTTPException, UploadFile

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
            "skippedKinds": parsed.skipped_kinds()[:8],
        },
        "transactions": [t.as_dict() for t in txns[-200:]],
    }


# The label and the traits are deliberately withheld from the model. Given them,
# it wrote "you made a dip buy, averaged in, held through earnings and beat the
# index", which is the row read aloud. Working from figures alone it has to say
# something the row does not already say.
_EXPLAIN_SYSTEM = (
    "You are given measurements of trades somebody already made. Write one "
    "sentence per trade saying what the figures imply about how that trade was "
    "run.\n"
    "Rules you must not break:\n"
    "- Use only the figures given. You know nothing about these companies, "
    "these dates or this market. Never name a product, a catalyst, an earnings "
    "result or any news.\n"
    "- Do not read the figures back. The reader can see them. Say what they "
    "mean about the decision.\n"
    "- One sentence, at most 20 words, plain and direct, addressed as 'you'.\n"
    "- No semicolons, no em dashes, no praise, no blame, no advice.\n"
    "How to read the fields: drawdownAtEntryPct is how far the stock had fallen "
    "from its high when you first bought. exitPlaceInRange is where you sold "
    "inside the price range you held through, 1 is the top and 0 is the bottom. "
    "biggestDayShareOfMove near 1 means a single session produced the gain. "
    "fills is how many separate orders built and unwound the position. "
    "pointsVsIndex is how far ahead of the index you finished, and a negative "
    "number means the money was made but the index made more.\n"
    "Good: \"Patience did the work here, since one session produced most of the "
    "move and you were early to it.\"\n"
    "Bad: \"You made a dip buy, averaged in and beat the index.\" That is the "
    "row read back.\n"
    'Return JSON only: {"notes": [{"i": 0, "note": "..."}]}'
)
_EXPLAIN_MAX_TRADES = 8


@router.post("/explain")
async def explain_trades(trades: list[dict] = Body(..., embed=True)):
    """One grounded sentence per trade, from facts that were already computed.

    Its own endpoint rather than part of the upload: the tile is complete
    without it, so the page should not wait on a model to render, and a
    provider outage should cost a sentence rather than the analysis.
    """
    if not trades:
        return {"notes": {}, "available": False}
    import ai_client

    payload = []
    for i, t in enumerate(trades[:_EXPLAIN_MAX_TRADES]):
        s = t.get("signals") or {}
        payload.append({
            "i": i,
            "heldDays": t.get("heldDays"),
            "fills": t.get("fills"),
            "returnPct": t.get("returnPct"),
            "benchmarkPct": t.get("benchmarkPct"),
            "pointsVsIndex": s.get("edgePts"),
            "shareOfWinningsPct": t.get("shareOfGainsPct"),
            "biggestDayShareOfMove": s.get("bestDayShare"),
            "drawdownAtEntryPct": s.get("entryDrawdownPct"),
            "exitPlaceInRange": s.get("exitPlacement"),
            "stillOpen": t.get("open"),
        })
    try:
        raw = ai_client.groq_complete(
            json.dumps(payload, separators=(",", ":")),
            system=_EXPLAIN_SYSTEM, max_tokens=700,
        )
        parsed = ai_client.parse_json(raw) or {}
    except Exception as e:                          # noqa: BLE001 — a sentence is not worth a 500
        logger.info("trade explain unavailable (%s)", e)
        return {"notes": {}, "available": False, "reason": "The model did not answer."}

    notes = {}
    for row in (parsed.get("notes") or []):
        try:
            idx = int(row["i"])
        except (KeyError, TypeError, ValueError):
            continue
        text = str(row.get("note") or "").strip()
        if text and 0 <= idx < len(payload):
            notes[str(idx)] = text[:240]
    return {"notes": notes, "available": bool(notes)}


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
