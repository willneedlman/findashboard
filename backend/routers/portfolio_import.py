"""Parse a screenshot of a brokerage/portfolio holdings table into structured
rows the frontend can review and merge into Portfolio Manager. Vision-only —
see ai_client.vision_complete (Claude; Groq/Cerebras have no vision model in
our tier).
"""
import base64
import re
from pydantic import BaseModel, Field

from fastapi import APIRouter, HTTPException

from ai_client import vision_complete, parse_json

router = APIRouter()

_MAX_IMAGE_BYTES = 8 * 1024 * 1024  # Claude's own cap is ~5MB post-decode per image; stay well under it.

_SYSTEM = """You extract holdings from a screenshot of a brokerage or portfolio-tracking app.
Respond ONLY with a JSON array (no prose, no markdown fences). Each element:
{"ticker": string, "shares": number, "avgCost": number|null}

Rules:
- ticker: the exchange ticker symbol only (e.g. "AAPL", "BRK.B"), not the company name.
- shares: the share/unit count as a plain number, no commas or currency symbols.
- avgCost: the average cost / cost basis per share if visible, else null. Never
  invent a number — if only market value or current price is shown, use null.
- Skip rows that aren't equity/ETF/fund holdings (cash balances, headers, totals,
  options contracts, footnotes).
- If the screenshot shows no readable holdings table at all, return [].
"""

_PROMPT = "Extract every holding row from this portfolio screenshot as the JSON array described."


class ScreenshotImportRequest(BaseModel):
    image_base64: str = Field(..., description="Data URL or raw base64-encoded image")


class ParsedHolding(BaseModel):
    ticker: str
    shares: float
    avgCost: float | None = None


class ScreenshotImportResponse(BaseModel):
    holdings: list[ParsedHolding]
    warning: str | None = None


_DATA_URL_RE = re.compile(r"^data:(image/[a-zA-Z+.-]+);base64,(.+)$", re.DOTALL)


def _decode_image(image_base64: str) -> tuple[str, str]:
    """Returns (media_type, raw_base64). Accepts either a data URL or bare base64
    (assumed PNG in the latter case, matching what a clipboard-paste flow sends)."""
    m = _DATA_URL_RE.match(image_base64.strip())
    media_type, raw = (m.group(1), m.group(2)) if m else ("image/png", image_base64.strip())
    if media_type not in ("image/png", "image/jpeg", "image/webp", "image/gif"):
        raise HTTPException(400, f"Unsupported image type: {media_type}")
    try:
        decoded = base64.b64decode(raw, validate=True)
    except Exception:
        raise HTTPException(400, "Invalid base64 image data")
    if len(decoded) > _MAX_IMAGE_BYTES:
        raise HTTPException(400, "Image too large (max 8MB)")
    if not decoded:
        raise HTTPException(400, "Empty image")
    return media_type, raw


@router.post("/screenshot", response_model=ScreenshotImportResponse)
def parse_screenshot(req: ScreenshotImportRequest):
    media_type, raw = _decode_image(req.image_base64)

    raw_text = vision_complete(raw, media_type, _PROMPT, system=_SYSTEM, max_tokens=2048)
    parsed = parse_json(raw_text)
    if not isinstance(parsed, list):
        raise HTTPException(500, "AI did not return a holdings array")

    holdings: list[ParsedHolding] = []
    skipped = 0
    for row in parsed:
        if not isinstance(row, dict):
            skipped += 1
            continue
        ticker = str(row.get("ticker") or "").strip().upper()
        shares = row.get("shares")
        try:
            shares_f = float(shares)
        except (TypeError, ValueError):
            skipped += 1
            continue
        if not ticker or shares_f <= 0:
            skipped += 1
            continue
        avg_cost = row.get("avgCost")
        try:
            avg_cost_f = float(avg_cost) if avg_cost is not None else None
        except (TypeError, ValueError):
            avg_cost_f = None
        holdings.append(ParsedHolding(ticker=ticker, shares=shares_f, avgCost=avg_cost_f))

    warning = None
    if not holdings:
        warning = "No readable holdings found in that screenshot."
    elif skipped:
        warning = f"Skipped {skipped} row(s) that didn't look like holdings."

    return ScreenshotImportResponse(holdings=holdings, warning=warning)
