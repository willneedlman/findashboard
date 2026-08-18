"""Parse a brokerage transaction export into one normalized ledger.

Two formats, both awkward in their own way.

Fidelity puts a byte-order mark and blank lines before the header, free-text
verbs in an Action column ("YOU BOUGHT", "REINVESTMENT"), several accounts in
one file, and a legal disclaimer in the rows after the data. Option symbols
arrive as " -NVDA260807C200", leading space and dash included.

Robinhood quotes everything, embeds newlines inside the Description field
(CUSIP on its own line), writes money as "$714.48" and negatives as "($1.28)",
and uses four-letter codes for everything that is not a trade: CDIV a cash
dividend, SLIP stock-lending income, CFIR and PFIR retirement contributions,
MTCH an IRA match.

The distinction that matters most downstream is EXTERNAL versus INTERNAL. A
deposit is not a gain. Counting a contribution as return is the single easiest
way to report a fund manager's performance as spectacular, so flows are
classified here, once, and the analytics never sees an unlabelled amount.
"""
from __future__ import annotations

import csv
import io
import logging
import re
from dataclasses import dataclass, field
from datetime import date, datetime

logger = logging.getLogger(__name__)

# What a row does to the account. `kind` drives every downstream decision.
#   buy / sell        a trade in a security
#   dividend          cash income from a holding
#   interest          cash income not tied to a holding (lending, sweep)
#   deposit / withdrawal   money the owner moved in or out: NEVER a return
#   fee               a charge
#   other             recognised but not modelled
KINDS = ("buy", "sell", "dividend", "interest", "deposit", "withdrawal", "fee", "other")
EXTERNAL_KINDS = ("deposit", "withdrawal")


@dataclass
class Txn:
    date: date
    kind: str
    symbol: str = ""
    quantity: float = 0.0
    price: float = 0.0
    amount: float = 0.0          # signed cash effect on the account
    fees: float = 0.0
    account: str = ""
    description: str = ""
    is_option: bool = False

    def as_dict(self) -> dict:
        return {
            "date": self.date.isoformat(), "kind": self.kind, "symbol": self.symbol,
            "quantity": round(self.quantity, 6), "price": round(self.price, 6),
            "amount": round(self.amount, 2), "fees": round(self.fees, 2),
            "account": self.account, "isOption": self.is_option,
            "description": self.description[:120],
        }


@dataclass
class ParseResult:
    txns: list[Txn] = field(default_factory=list)
    accounts: list[str] = field(default_factory=list)
    skipped: list[str] = field(default_factory=list)   # rows we did not understand
    source: str = ""

    def as_dict(self) -> dict:
        return {
            "source": self.source,
            "accounts": self.accounts,
            "transactions": [t.as_dict() for t in self.txns],
            "skipped": self.skipped[:20],
            "skippedCount": len(self.skipped),
        }


def _money(raw) -> float:
    """"$1,027.99" -> 1027.99 and "($1.28)" -> -1.28. Blank -> 0."""
    s = str(raw or "").strip()
    if not s:
        return 0.0
    negative = s.startswith("(") and s.endswith(")")
    s = s.strip("()").replace("$", "").replace(",", "").replace("−", "-")
    try:
        value = float(s)
    except ValueError:
        return 0.0
    return -value if negative else value


def _date(raw: str) -> date | None:
    s = str(raw or "").strip().strip('"')
    if not s:
        return None
    # Robinhood writes 7/7/2026; Fidelity writes 08/10/2026. Both are US order.
    for fmt in ("%m/%d/%Y", "%m/%d/%y", "%Y-%m-%d"):
        try:
            return datetime.strptime(s, fmt).date()
        except ValueError:
            continue
    return None


# An option symbol carries an expiry and a strike; an equity ticker does not.
_OPTION_RE = re.compile(r"^-?\s*([A-Z.]{1,6})\s*(\d{6})([CP])(\d+(?:\.\d+)?)$")


def _clean_symbol(raw: str) -> tuple[str, bool]:
    """(symbol, is_option). Fidelity option symbols arrive as ' -NVDA260807C200'."""
    s = str(raw or "").strip().lstrip("-").strip()
    if not s:
        return "", False
    if _OPTION_RE.match(s):
        return s, True
    # A plain ticker: letters, maybe a dot class (BRK.B).
    return (s.upper(), False) if re.fullmatch(r"[A-Za-z.]{1,6}", s) else (s.upper(), False)


# ── Fidelity ────────────────────────────────────────────────────────────────
# Ordered: the first match wins, so the specific sits above the general.
_FIDELITY_ACTIONS: tuple[tuple[re.Pattern, str], ...] = (
    (re.compile(r"^YOU BOUGHT", re.I), "buy"),
    (re.compile(r"^YOU SOLD", re.I), "sell"),
    (re.compile(r"^REINVESTMENT", re.I), "buy"),
    (re.compile(r"^DIVIDEND RECEIVED", re.I), "dividend"),
    (re.compile(r"^(?:INTEREST|CREDIT INTEREST)", re.I), "interest"),
    (re.compile(r"ELECTRONIC FUNDS TRANSFER", re.I), "deposit"),
    (re.compile(r"^TRANSFER OF ASSETS", re.I), "deposit"),
    (re.compile(r"COMMISSION CREDIT", re.I), "other"),
    (re.compile(r"^(?:FEE|SERVICE CHARGE)", re.I), "fee"),
    (re.compile(r"^(?:EXPIRED|ASSIGNED|EXERCISED)", re.I), "other"),
)


def parse_fidelity(text: str) -> ParseResult:
    out = ParseResult(source="fidelity")
    lines = text.splitlines()
    try:
        start = next(i for i, l in enumerate(lines) if l.lstrip("﻿").startswith("Run Date"))
    except StopIteration:
        return out
    body = "\n".join(lines[start:])
    for row in csv.DictReader(io.StringIO(body)):
        when = _date(row.get("Run Date", ""))
        if when is None:
            # The rows after the data are a legal disclaimer, not transactions.
            continue
        action = (row.get("Action") or "").strip()
        kind = next((k for pattern, k in _FIDELITY_ACTIONS if pattern.search(action)), None)
        if kind is None:
            out.skipped.append(action[:90] or "(blank action)")
            continue
        symbol, is_option = _clean_symbol(row.get("Symbol", ""))
        amount = _money(row.get("Amount ($)"))
        # A negative amount on a transfer is money leaving.
        if kind == "deposit" and amount < 0:
            kind = "withdrawal"
        out.txns.append(Txn(
            date=when, kind=kind, symbol=symbol,
            quantity=abs(_money(row.get("Quantity"))),
            price=_money(row.get("Price ($)")),
            amount=amount,
            fees=_money(row.get("Commission ($)")) + _money(row.get("Fees ($)")),
            account=(row.get("Account") or "").strip(),
            description=(row.get("Description") or "").strip(),
            is_option=is_option,
        ))
    out.accounts = sorted({t.account for t in out.txns if t.account})
    return out


# ── Robinhood ───────────────────────────────────────────────────────────────
_ROBINHOOD_CODES = {
    "Buy": "buy", "BUY": "buy",
    "Sell": "sell", "SELL": "sell",
    "CDIV": "dividend",          # cash dividend
    "SLIP": "interest",          # stock lending income payment
    "INT": "interest",
    "CFIR": "deposit",           # current year contribution
    "PFIR": "deposit",           # prior year contribution
    "MTCH": "deposit",           # IRA match, money the broker adds
    "ACH": "deposit",
    "RTP": "withdrawal",
    "DTAX": "fee",
    "AFEE": "fee", "GOLD": "fee",
}


def parse_robinhood(text: str) -> ParseResult:
    out = ParseResult(source="robinhood")
    # csv handles the newlines inside the quoted Description field.
    for row in csv.DictReader(io.StringIO(text)):
        when = _date(row.get("Activity Date", ""))
        if when is None:
            continue
        code = (row.get("Trans Code") or "").strip()
        kind = _ROBINHOOD_CODES.get(code)
        if kind is None:
            out.skipped.append(f"{code or '(blank)'}: {(row.get('Description') or '')[:60]}")
            continue
        symbol, is_option = _clean_symbol(row.get("Instrument", ""))
        amount = _money(row.get("Amount"))
        if kind == "deposit" and amount < 0:
            kind = "withdrawal"
        out.txns.append(Txn(
            date=when, kind=kind, symbol=symbol,
            quantity=abs(_money(row.get("Quantity"))),
            price=_money(row.get("Price")),
            amount=amount,
            account="",                       # the export names no account
            description=" ".join((row.get("Description") or "").split())[:120],
            is_option=is_option,
        ))
    out.accounts = []
    return out


_PARSERS = {"fidelity": parse_fidelity, "robinhood": parse_robinhood}


def detect_source(text: str) -> str:
    """Which broker wrote this file, from its header alone."""
    head = text[:4000]
    if "Run Date" in head and "Account Number" in head:
        return "fidelity"
    if "Activity Date" in head and "Trans Code" in head:
        return "robinhood"
    return ""


def parse(text: str, source: str = "") -> ParseResult:
    """Parse an export. `source` may be empty to detect it from the header."""
    chosen = (source or "").strip().lower() or detect_source(text)
    parser = _PARSERS.get(chosen)
    if parser is None:
        raise ValueError(
            "Unrecognised file. Export transaction history from Fidelity "
            "(Accounts > History > Download) or Robinhood (Account > Statements "
            "> Reports), and upload that CSV unchanged."
        )
    result = parser(text)
    result.txns.sort(key=lambda t: t.date)
    return result
