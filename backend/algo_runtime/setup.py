"""What to trade, extracted from the prompt — not just how.

`signal()` decides WHEN to enter and exit. It cannot say which ticker, whether
to trade the shares or a 30-DTE call, or that this should run as a five-name
book — that is engine configuration, and the code has no way to reach it.

The legacy AI assistant could set all of it, but only as transient page state,
so the setup was lost the moment you switched strategies. This extracts the same
things and returns them as a patch the UI saves ONTO the strategy, which is what
makes a saved strategy a complete, reproducible configuration.

Conservative by construction: only fields the user actually stated come back.
Silence means "leave whatever is on screen alone", never a guessed default —
quietly switching someone's ticker or instrument is far worse than ignoring an
ambiguous request.
"""
from __future__ import annotations

import logging
import re

logger = logging.getLogger("algo_runtime.setup")

_TICKER = re.compile(r"^[A-Z]{1,6}(?:[.-][A-Z]{1,2})?$")
# Universe labels and placeholders a model reaches for when it has no real
# symbol. Applying one of these would silently backtest nothing.
_NOT_TICKERS = {
    "ALL", "ANY", "NASDAQ", "NASDAQ100", "SP500", "SPX", "TICKER", "SYMBOL",
    "STOCK", "ETF", "NONE", "PLACEHOLDER", "SELF", "IT", "THE", "A", "AN",
    "BUY", "SELL", "LONG", "SHORT", "CALL", "PUT", "RSI", "SMA", "EMA", "ATR",
    "MACD", "USD", "AND", "OR", "NOT", "PER", "DTE", "OTM", "ITM", "ATM",
}

SYSTEM = """You extract the TRADING SETUP from a strategy request. You never write code.

Return ONLY this JSON, omitting every field the user did not actually state:
{
  "mode": "single" | "portfolio",
  "ticker": "AAPL",
  "side": "long" | "short",
  "timeframe": "1d" | "1h" | "30m" | "15m" | "5m",
  "instMode": "underlying" | "option" | "combo",
  "optType": "call" | "put",
  "otmPct": 5,
  "dte": 30,
  "comboLegs": [{"type":"call","side":"sell","moneyness":1.0,"qty":1}],
  "comboDte": 30,
  "positions": [{"ticker":"NVDA","side":"long","instMode":"underlying"}],
  "portfolioTradeSize": 20,
  "portfolioMaxOpenPositions": 5
}

RULES
- Omit anything not stated. An empty object is a correct answer. Never guess a
  ticker, an instrument or a timeframe the user did not give — changing what
  someone is trading because you inferred it is worse than changing nothing.
- "ticker" must be a real symbol. Never a universe name (SP500, NASDAQ), never a
  placeholder (TICKER, SYMBOL).
- instMode "option" is a single call/put; "combo" is a multi-leg structure
  (straddle, strangle, spread, condor). Only use "combo" with comboLegs.
- moneyness is a multiple of spot: 1.0 = at the money, 1.05 = 5% out for a call.

MONEYNESS SIGN — read this carefully, it is the field most often got wrong.
otmPct is signed distance OUT of the money, as a percentage.
  OUT of the money  -> POSITIVE   "5% OTM call"  -> otmPct 5
  AT the money      -> 0          "ATM call"     -> otmPct 0
  IN the money      -> NEGATIVE   "20% ITM call" -> otmPct -20
                                  "80% ITM call" -> otmPct -80
"Deep in the money" is a large NEGATIVE number, never a positive one. If the
user says ITM and you return a positive otmPct you have inverted their trade.
- Several named tickers means mode "portfolio" with one entry per name.

NAMED STRUCTURES
A named multi-leg structure is instMode "combo" plus its legs. Expand it — never
return a named structure as a single option, which would trade one leg of it.
  short straddle  : sell call @1.0, sell put @1.0
  long straddle   : buy call @1.0, buy put @1.0
  short strangle  : sell call @1.05, sell put @0.95
  long strangle   : buy call @1.05, buy put @0.95
  bull call spread: buy call @1.0, sell call @1.05
  bear put spread : buy put @1.0, sell put @0.95
  iron condor     : sell call @1.05, buy call @1.10, sell put @0.95, buy put @0.90
  call/put butterfly: buy @0.95, sell 2x @1.0, buy @1.05 (all the same type)
Use comboDte for a combo's expiry, not dte. Widen the wings if the user asks for
wider strikes; keep them at these defaults otherwise.
"""

_TF = {"1d", "1h", "30m", "15m", "5m"}
_INST = {"underlying", "option", "combo"}


def extract(prompt: str, history: list[dict] | None = None,
            current: dict | None = None, model: str | None = None) -> dict:
    """Prompt -> setup PATCH, in the context of the conversation so far.

    A patch, not a fresh reading. Extracting from the latest message alone made
    a follow-up destroy everything it did not restate: "sorry calls not puts,
    80% itm" carries no ticker and no expiry, so the model invented AAPL and 30
    DTE and silently moved the user off SPY/365. Passing the current setup and
    the recent turns lets an omission mean "leave it alone", which is what the
    user meant by saying nothing about it.

    Returns {} on any failure — a broken extractor must never block generation,
    and an empty patch changes nothing.
    """
    from ai_client import groq_chat, MODEL_FAST, parse_json

    msgs: list[dict] = [{"role": "system", "content": SYSTEM}]
    if current:
        import json as _json
        msgs.append({"role": "system", "content":
                     "The strategy's CURRENT setup is below. Return ONLY the fields this message "
                     "changes; every field you omit keeps its current value. Do not restate "
                     "unchanged fields, and never invent one the user has not mentioned in this "
                     "conversation.\n\n" + _json.dumps(current, indent=2)})
    for m in (history or [])[-6:]:
        role = m.get("role")
        content = str(m.get("content") or "")
        if role in ("user", "assistant") and content:
            msgs.append({"role": role, "content": content[:1500]})
    msgs.append({"role": "user", "content": prompt})

    try:
        resp = groq_chat(msgs, model=model or MODEL_FAST, max_tokens=700, temperature=0)
        raw = parse_json((resp.choices[0].message.content or "").strip())
    except Exception:
        logger.exception("setup extraction failed; continuing without one")
        return {}

    patch = clean(raw if isinstance(raw, dict) else {})

    # ── deterministic guards over the model's answer ──────────────────────────
    said = " ".join([prompt] + [str(m.get("content") or "") for m in (history or [])])
    seen = mentioned_tickers(said)

    # A symbol nobody typed is invented. Drop it rather than move the user's
    # backtest onto a different instrument.
    if patch.get("ticker") and patch["ticker"] not in seen:
        logger.info("dropping invented ticker %s (never mentioned)", patch["ticker"])
        patch.pop("ticker")
    if patch.get("positions"):
        kept = [p for p in patch["positions"] if p["ticker"] in seen]
        if len(kept) != len(patch["positions"]):
            logger.info("dropping %d invented position(s)", len(patch["positions"]) - len(kept))
        if kept:
            patch["positions"] = kept
        else:
            patch.pop("positions")
            patch.pop("mode", None)

    # One symbol is not a book. Left alone it flipped a single-name strategy into
    # portfolio mode and stranded the ticker inside a positions array.
    if patch.get("positions") and len(patch["positions"]) == 1 and "portfolio" not in (prompt or "").lower():
        only = patch.pop("positions")[0]
        patch["mode"] = "single"
        patch.setdefault("ticker", only["ticker"])
        for k in ("side", "instMode", "optType", "otmPct", "dte", "comboDte"):
            if k in only and k not in patch:
                patch[k] = only[k]
        if only.get("comboLegs") and "comboLegs" not in patch:
            patch["comboLegs"] = only["comboLegs"]

    # An explicitly stated moneyness always wins over the model's reading.
    stated = explicit_moneyness(prompt)
    if stated is not None and (v := _num(stated, -90, 500)) is not None and patch.get("otmPct") != v:
        logger.info("overriding otmPct %s with stated %s", patch.get("otmPct"), v)
        patch["otmPct"] = v
        patch.setdefault("instMode", (current or {}).get("instMode") or "option")

    # A ticker identical to the current one is not a change; dropping it keeps
    # the "what did this message alter" summary honest.
    if current and patch.get("ticker") and patch["ticker"] == current.get("ticker"):
        patch.pop("ticker")
    return patch


# "80% itm", "20 % OTM", "5% out of the money", "at the money", and the reverse
# order "in-the-money by 15%".
_MONEY_WORD = r"itm|otm|in[- ]the[- ]money|out[- ]of[- ]the[- ]money|atm|at[- ]the[- ]money"
_MONEYNESS = re.compile(
    rf"(?:(\d+(?:\.\d+)?)\s*%?\s*)?\b({_MONEY_WORD})\b(?:\s*(?:by|at)?\s*(\d+(?:\.\d+)?)\s*%)?",
    re.I)


def explicit_moneyness(text: str) -> float | None:
    """Signed otmPct stated outright in the message, or None.

    The model gets this field wrong often enough to matter, and getting it wrong
    silently changes which strike is traded — "80% itm" came back as -20 because
    an earlier turn had said 20 and the model anchored on it. When the user
    writes a number and a side, that is not a judgement call, so it is parsed
    here and overrides whatever the model returned.
    """
    last = None
    for m in _MONEYNESS.finditer(text or ""):
        before_pct, word, after_pct = m.group(1), m.group(2).lower(), m.group(3)
        if word.startswith("at"):
            last = 0.0
            continue
        pct = before_pct if before_pct is not None else after_pct
        if pct is None:
            continue
        v = float(pct)
        last = -v if word.startswith("itm") or word.startswith("in") else v
    return last


def mentioned_tickers(text: str) -> set[str]:
    """Uppercase words in the conversation that could be symbols.

    A ticker the user never typed is a hallucination, and applying one silently
    moves their backtest to a different instrument — which is exactly what
    happened when an empty setup let the model reach for AAPL.
    """
    out = set()
    for tok in re.findall(r"\b[A-Za-z][A-Za-z.\-]{0,6}\b", text or ""):
        up = tok.upper()
        if up not in _NOT_TICKERS and _TICKER.match(up):
            out.add(up)
    return out


def _ticker(v) -> str | None:
    t = str(v or "").strip().upper()
    if not t or t in _NOT_TICKERS or not _TICKER.match(t):
        return None
    return t


def _num(v, lo: float, hi: float, integer: bool = False):
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    if not (lo <= f <= hi):
        return None
    return int(round(f)) if integer else f


def _legs(rows) -> list[dict]:
    out = []
    for r in (rows or [])[:8]:
        if not isinstance(r, dict):
            continue
        t = str(r.get("type") or "").lower()
        side = str(r.get("side") or "").lower()
        if t not in ("call", "put") or side not in ("buy", "sell"):
            continue
        money = _num(r.get("moneyness"), 0.2, 5.0) or 1.0
        qty = _num(r.get("qty"), 0.01, 100) or 1.0
        out.append({"type": t, "side": side, "moneyness": money, "qty": qty})
    return out


def clean(raw: dict) -> dict:
    """Keep only well-formed, in-range fields. Anything questionable is dropped
    rather than corrected, so a bad extraction degrades to 'change nothing'."""
    out: dict = {}

    if str(raw.get("mode") or "").lower() in ("single", "portfolio"):
        out["mode"] = raw["mode"].lower()
    if (t := _ticker(raw.get("ticker"))):
        out["ticker"] = t
    if str(raw.get("side") or "").lower() in ("long", "short"):
        out["side"] = raw["side"].lower()
    if str(raw.get("timeframe") or "").lower() in _TF:
        out["timeframe"] = raw["timeframe"].lower()
    if str(raw.get("instMode") or "").lower() in _INST:
        out["instMode"] = raw["instMode"].lower()
    if str(raw.get("optType") or "").lower() in ("call", "put"):
        out["optType"] = raw["optType"].lower()
    if (v := _num(raw.get("otmPct"), -90, 500)) is not None:
        out["otmPct"] = v
    if (v := _num(raw.get("dte"), 0, 1000, integer=True)) is not None:
        out["dte"] = v
    if (v := _num(raw.get("comboDte"), 0, 1000, integer=True)) is not None:
        out["comboDte"] = v
    if (legs := _legs(raw.get("comboLegs"))):
        out["comboLegs"] = legs
    if (v := _num(raw.get("portfolioTradeSize"), 0.1, 100)) is not None:
        out["portfolioTradeSize"] = v
    if (v := _num(raw.get("portfolioMaxOpenPositions"), 1, 1000, integer=True)) is not None:
        out["portfolioMaxOpenPositions"] = v

    positions = []
    for p in (raw.get("positions") or [])[:60]:
        if not isinstance(p, dict):
            continue
        tk = _ticker(p.get("ticker"))
        if not tk:
            continue                      # a position with no real symbol is unusable
        pos = {
            "ticker": tk,
            "side": p["side"].lower() if str(p.get("side") or "").lower() in ("long", "short") else "long",
            "instMode": p["instMode"].lower() if str(p.get("instMode") or "").lower() in _INST else "underlying",
            "optType": p["optType"].lower() if str(p.get("optType") or "").lower() in ("call", "put") else "call",
            "otmPct": _num(p.get("otmPct"), -90, 500) or 0,
            "dte": _num(p.get("dte"), 0, 1000, integer=True) or 30,
            "comboLegs": _legs(p.get("comboLegs")),
            "comboDte": _num(p.get("comboDte"), 0, 1000, integer=True) or 30,
        }
        if (v := _num(p.get("tradeSize"), 0.1, 100)) is not None:
            pos["tradeSize"] = v
        positions.append(pos)
    if positions:
        out["positions"] = positions
        out.setdefault("mode", "portfolio")   # several named symbols IS a book

    # A combo needs its legs; an instMode with nothing to price is worse than
    # leaving the instrument alone.
    if out.get("instMode") == "combo" and not out.get("comboLegs"):
        out.pop("instMode", None)

    # Coherence. Models set the option PARAMETERS correctly and then leave
    # instMode at its habitual "underlying" — "a 30 day 5% OTM call" came back
    # with optType/otmPct/dte all right and instMode "underlying", which would
    # have traded shares. Option parameters on an underlying trade are
    # meaningless, so the more specific signal wins. This resolves a
    # contradiction inside the response; it never invents an instrument from
    # silence, which is why the check is on explicit keys in `raw`.
    if out.get("comboLegs") and out.get("instMode") != "combo":
        out["instMode"] = "combo"
    elif "optType" in raw and out.get("instMode", "underlying") == "underlying":
        out["instMode"] = "option"

    # Same fix inside a book's positions.
    for pos in out.get("positions", []):
        if pos.get("comboLegs"):
            pos["instMode"] = "combo"
    for pos, src in zip(out.get("positions", []), (raw.get("positions") or [])):
        if isinstance(src, dict) and "optType" in src and pos.get("instMode") == "underlying":
            pos["instMode"] = "option"
    return out
