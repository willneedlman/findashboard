"""Parse a screenshot of a brokerage/portfolio holdings table into structured
rows the frontend can review and merge into Portfolio Manager. Vision-only —
see ai_client.vision_complete, which tries Groq's free vision model first and
falls back to Claude.
"""
import base64
import re
from pydantic import BaseModel, Field

from fastapi import APIRouter, HTTPException

from ai_client import vision_complete, parse_json

router = APIRouter()

_MAX_IMAGE_BYTES = 8 * 1024 * 1024  # Claude's own cap is ~5MB post-decode per image; stay well under it.

_SYSTEM = """You extract positions from a screenshot of a brokerage or portfolio-tracking app.
Respond ONLY with a JSON object (no prose, no markdown fences):
{"holdings": [ {"ticker": string, "shares": number, "avgCost": number|null} ],
 "options":  [ {"underlying": string, "type": "call"|"put", "strike": number, "expiry": "YYYY-MM-DD", "side": "long"|"short", "contracts": number, "avgPremium": number|null} ]}

EQUITY / ETF / fund rows go in "holdings":
- ticker: the exchange ticker symbol only (e.g. "AAPL", "BRK.B"), not the company name.
- shares: the share/unit count as a plain number, no commas or currency symbols.
- avgCost: average cost / cost basis per share if visible, else null. Never invent
  one — if only market value or current price is shown, use null.

OPTION contracts go in "options" (parse each option row/line):
- underlying: the underlying ticker (e.g. "AAPL"), NOT the full OCC symbol or company name.
- type: "call" or "put" (C / Call -> call, P / Put -> put).
- strike: the strike price as a plain number.
- expiry: expiration as YYYY-MM-DD. Convert whatever is shown ("Aug 15 '26",
  "8/15/2026", "15 AUG 26", or the YYMMDD inside an OCC symbol) to that format.
- side: "long" if the contract is owned/bought (positive quantity), "short" if it
  is written/sold (negative quantity, a leading minus, or "Short"/"Sell to Open").
- contracts: number of contracts as a POSITIVE number (drop any minus sign; the
  direction is carried by "side").
- avgPremium: cost basis PER SHARE if visible. If the app shows cost per contract,
  divide by 100. Else null. Never invent one.
- An OCC symbol like "AAPL 260815C00195000" decodes to underlying AAPL, expiry
  2026-08-15, C = call, strike 195.000 (the final 8 digits divided by 1000).

Rules:
- Put every equity row in "holdings" and every option contract in "options".
- Skip cash balances, headers, totals, and footnotes.
- If a section is absent return [] for it. If nothing is readable return
  {"holdings": [], "options": []}.
"""

_PROMPT = "Extract every equity holding and option contract from this portfolio screenshot as the JSON object described."


class ScreenshotImportRequest(BaseModel):
    image_base64: str = Field(..., description="Data URL or raw base64-encoded image")


class ParsedHolding(BaseModel):
    ticker: str
    shares: float
    avgCost: float | None = None


class ParsedOption(BaseModel):
    underlying: str
    type: str                      # 'call' | 'put'
    strike: float
    expiry: str                    # YYYY-MM-DD
    side: str                      # 'long' | 'short'
    contracts: float
    avgPremium: float | None = None


class ScreenshotImportResponse(BaseModel):
    holdings: list[ParsedHolding]
    options: list[ParsedOption] = []
    warning: str | None = None


_ISO_DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")


def _num(v) -> float | None:
    try:
        f = float(str(v).replace(",", "").replace("$", "").strip())
        return f if f == f and f not in (float("inf"), float("-inf")) else None
    except (TypeError, ValueError):
        return None


def _parse_options(rows) -> tuple[list[ParsedOption], int]:
    """Validate the AI's option rows. Anything missing the fields needed to place
    a real contract (type, strike, a YYYY-MM-DD expiry, a positive count) is
    dropped rather than guessed at."""
    out: list[ParsedOption] = []
    skipped = 0
    for row in rows if isinstance(rows, list) else []:
        if not isinstance(row, dict):
            skipped += 1
            continue
        underlying = str(row.get("underlying") or row.get("ticker") or "").strip().upper()
        otype = str(row.get("type") or "").strip().lower()
        otype = "put" if otype.startswith("p") else ("call" if otype.startswith("c") else "")
        strike = _num(row.get("strike"))
        expiry = str(row.get("expiry") or "").strip()
        side_raw = str(row.get("side") or "").strip().lower()
        contracts = _num(row.get("contracts"))
        side = "short" if (side_raw.startswith("s") or (contracts is not None and contracts < 0)) else "long"
        contracts = abs(contracts) if contracts is not None else None
        premium = _num(row.get("avgPremium"))
        if not underlying or not otype or strike is None or strike <= 0 \
                or not _ISO_DATE_RE.match(expiry) or contracts is None or contracts <= 0:
            skipped += 1
            continue
        out.append(ParsedOption(underlying=underlying, type=otype, strike=strike, expiry=expiry,
                                side=side, contracts=contracts, avgPremium=premium))
    return out, skipped


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
    # New shape is {"holdings": [...], "options": [...]}; tolerate a bare array
    # (older prompt shape) as holdings-only.
    if isinstance(parsed, list):
        holding_rows, option_rows = parsed, []
    elif isinstance(parsed, dict):
        holding_rows = parsed.get("holdings") if isinstance(parsed.get("holdings"), list) else []
        option_rows = parsed.get("options") if isinstance(parsed.get("options"), list) else []
    else:
        raise HTTPException(500, "AI did not return a positions object")

    holdings: list[ParsedHolding] = []
    skipped = 0
    for row in holding_rows:
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

    options, opt_skipped = _parse_options(option_rows)
    skipped += opt_skipped

    warning = None
    if not holdings and not options:
        warning = "No readable holdings or option positions found in that screenshot."
    elif skipped:
        warning = f"Skipped {skipped} row(s) that didn't look like a position."

    return ScreenshotImportResponse(holdings=holdings, options=options, warning=warning)
