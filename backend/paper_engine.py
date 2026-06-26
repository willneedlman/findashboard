"""Per-user simulated paper-trading engine.

Each user gets an isolated account (starting cash, positions, orders) stored in
the shared users.db. Orders fill against live quotes; resting limit/stop orders
are evaluated lazily whenever the account is read or a new order is placed, so no
background scheduler is needed. This replaces the single shared Tradier sandbox
account for the dashboard so every user trades their own book.
"""
import json
import os
import sqlite3
import time
import uuid
from pathlib import Path
from threading import Lock

from cache import get_history

_DEFAULT_DB = Path(__file__).resolve().parent.parent / "users.db"
_DB_PATH = Path(os.getenv("USERS_DB_PATH", str(_DEFAULT_DB)))
_lock = Lock()

STARTING_CASH = 100_000.0


def _conn():
    c = sqlite3.connect(str(_DB_PATH))
    c.row_factory = sqlite3.Row
    return c


with _conn() as _c:
    _c.execute("""
        CREATE TABLE IF NOT EXISTS paper_accounts (
            user_id    TEXT PRIMARY KEY,
            data_json  TEXT NOT NULL,
            updated_at REAL
        )
    """)


def _new_account() -> dict:
    return {"cash": STARTING_CASH, "positions": {}, "options": {}, "orders": [], "realized_pnl": 0.0}


def _load(user_id: str) -> dict:
    with _conn() as c:
        row = c.execute("SELECT data_json FROM paper_accounts WHERE user_id = ?", (user_id,)).fetchone()
    if row:
        try:
            acct = json.loads(row["data_json"])
            acct.setdefault("options", {})   # accounts created before options support
            return acct
        except Exception:
            pass
    return _new_account()


import re

# OCC option symbol, e.g. SPY250620C00580000 -> SPY / 2025-06-20 / call / 580.0
def _parse_occ(option_symbol: str) -> dict | None:
    m = re.match(r"^([A-Z]+)(\d{6})([CP])(\d{8})$", (option_symbol or "").strip().upper())
    if not m:
        return None
    und, ymd, cp, strike8 = m.groups()
    return {
        "underlying": und,
        "expiry": f"20{ymd[0:2]}-{ymd[2:4]}-{ymd[4:6]}",
        "type": "call" if cp == "C" else "put",
        "strike": int(strike8) / 1000.0,
    }


def _option_price(option_symbol: str) -> float | None:
    info = _parse_occ(option_symbol)
    if not info:
        return None
    try:
        import options_data
        chain = options_data.get_chain(info["underlying"], info["expiry"])
        df = chain.calls if info["type"] == "call" else chain.puts
        row = df[abs(df["strike"] - info["strike"]) < 1e-6]
        if row.empty:
            return None
        r = row.iloc[0]
        bid, ask, last = float(r.get("bid") or 0), float(r.get("ask") or 0), float(r.get("lastPrice") or 0)
        mid = (bid + ask) / 2 if bid > 0 and ask > 0 else last
        return round(mid, 4) if mid > 0 else (round(last, 4) if last > 0 else None)
    except Exception:
        return None


def _save(user_id: str, acct: dict) -> None:
    with _conn() as c:
        c.execute(
            "INSERT INTO paper_accounts (user_id, data_json, updated_at) VALUES (?,?,?) "
            "ON CONFLICT(user_id) DO UPDATE SET data_json = excluded.data_json, updated_at = excluded.updated_at",
            (user_id, json.dumps(acct), time.time()),
        )


def _price(symbol: str) -> float | None:
    # Live last price first (real-time, 4s-cached) so intraday position marks and
    # fills track the market across all asset classes; daily close is the fallback.
    try:
        import quotes
        p = quotes.live_price(symbol)
        if p:
            return p
    except Exception:
        pass
    try:
        h = get_history(symbol, period="5d")
        closes = h["Close"].dropna()
        return float(closes.iloc[-1]) if len(closes) else None
    except Exception:
        return None


def _fill_price(order: dict, px: float) -> float | None:
    """Return the price the order fills at given the current price, or None if it
    should rest (not yet triggered/marketable)."""
    t, side = order["order_type"], order["side"]
    if t == "market":
        return px
    if t == "limit":
        lim = order["limit_price"]
        if side == "buy" and px <= lim:
            return px
        if side == "sell" and px >= lim:
            return px
        return None
    if t == "stop":
        stp = order["stop_price"]
        if side == "buy" and px >= stp:
            return px
        if side == "sell" and px <= stp:
            return px
        return None
    return None


# Futures: USD per 1.0 of price move, per contract. Mirrors frontend/src/lib/
# futures.ts (single source of truth there for the pickers). A futures buy posts
# initial margin (collateral), not the full notional, so the position carries
# leverage — P&L moves at price-change × multiplier on the whole contract.
_FUTURES_MULT = {
    "ES=F": 50, "NQ=F": 20, "YM=F": 5, "RTY=F": 50, "MES=F": 5, "MNQ=F": 2,
    "CL=F": 1000, "NG=F": 10000, "RB=F": 42000, "HO=F": 42000,
    "GC=F": 100, "SI=F": 5000, "HG=F": 25000, "PL=F": 50,
    "ZB=F": 1000, "ZN=F": 1000, "ZF=F": 1000,
    "6E=F": 125000, "6J=F": 12500000, "6B=F": 62500,
    "ZC=F": 50, "ZS=F": 50, "ZW=F": 50,
}
_FUT_MARGIN_RATE = 0.10   # initial margin = 10% of notional → ~10x leverage


def _futures_mult(symbol: str):
    return _FUTURES_MULT.get((symbol or "").strip().upper())


def _value(acct: dict) -> tuple:
    """Mark the whole account to market. Returns (equity, futures_margin_used,
    position_rows, option_rows). Futures are leveraged: a position contributes only
    its mark-to-market P&L to equity (no cash is tied up at entry), and its margin
    requirement floats with the live contract value — so both equity and required
    margin move dynamically with price, position size, and P&L."""
    equity, margin_used, pos_rows, opt_rows = acct["cash"], 0.0, [], []
    for sym, p in acct["positions"].items():
        px = _price(sym) or p["avg_cost"]
        mult = p.get("mult")
        if mult:
            upnl = (px - p["avg_cost"]) * mult * p["qty"]
            req = px * mult * p["qty"] * _FUT_MARGIN_RATE
            equity += upnl
            margin_used += req
            pos_rows.append({
                "symbol": sym, "quantity": p["qty"], "avg_cost": round(p["avg_cost"], 4),
                "price": round(px, 4), "market_value": round(upnl, 2), "unrealized_pnl": round(upnl, 2),
                "multiplier": mult, "margin": round(req, 2), "notional": round(px * mult * p["qty"], 2),
            })
        else:
            mv = px * p["qty"]
            equity += mv
            pos_rows.append({
                "symbol": sym, "quantity": p["qty"], "avg_cost": round(p["avg_cost"], 4),
                "price": round(px, 4), "market_value": round(mv, 2),
                "unrealized_pnl": round((px - p["avg_cost"]) * p["qty"], 2),
            })
    for osym, p in acct.get("options", {}).items():
        px = _option_price(osym) or (p["avg_cost"] / _OPT_MULT if p["qty"] else 0)
        mv = px * _OPT_MULT * p["qty"]
        equity += mv
        opt_rows.append({
            "option_symbol": osym, "underlying": p.get("underlying"), "expiry": p.get("expiry"),
            "type": p.get("type"), "strike": p.get("strike"), "quantity": p["qty"],
            "avg_cost": round(p["avg_cost"], 2), "price": round(px, 4), "market_value": round(mv, 2),
            "unrealized_pnl": round(px * _OPT_MULT * p["qty"] - p["avg_cost"] * p["qty"], 2),
        })
    return equity, margin_used, pos_rows, opt_rows


def _buying_power(acct: dict) -> float:
    """Free collateral for a new futures position: total equity (incl. unrealized
    P&L) minus margin already committed. Rises with gains, falls with losses."""
    equity, margin_used, _, _ = _value(acct)
    return equity - margin_used


def _apply_futures_fill(acct: dict, order: dict, fill_px: float, mult: int) -> None:
    """Leveraged futures fill (long-only: buy to open, sell to close). Margin is a
    floating requirement, not a cash debit, so available buying power tracks
    unrealized P&L and position size live; only realized P&L settles to cash."""
    sym, qty, side = order["symbol"], order["quantity"], order["side"]
    pos = acct["positions"].get(sym, {"qty": 0, "avg_cost": 0.0, "mult": mult})
    if side == "buy":
        added_margin = qty * fill_px * mult * _FUT_MARGIN_RATE
        if added_margin > _buying_power(acct) + 1e-6:
            order["status"], order["reason"] = "rejected", "Insufficient margin"
            return
        new_qty = pos["qty"] + qty
        pos["avg_cost"] = (pos["qty"] * pos["avg_cost"] + qty * fill_px) / new_qty if new_qty else 0.0
        pos["qty"] = new_qty
        pos["mult"] = mult
        acct["positions"][sym] = pos
    else:  # sell to close (long-only)
        if qty > pos["qty"]:
            order["status"], order["reason"] = "rejected", "No contracts to sell"
            return
        realized = (fill_px - pos["avg_cost"]) * mult * qty
        acct["cash"] += realized                      # only realized P&L settles to cash
        acct["realized_pnl"] += realized
        pos["qty"] -= qty
        if pos["qty"] <= 0:
            acct["positions"].pop(sym, None)
        else:
            acct["positions"][sym] = pos
    order["status"], order["fill_price"], order["filled_at"] = "filled", round(fill_px, 4), time.time()


def _apply_fill(acct: dict, order: dict, fill_px: float) -> None:
    sym, qty, side = order["symbol"], order["quantity"], order["side"]
    mult = _futures_mult(sym)
    if mult:
        _apply_futures_fill(acct, order, fill_px, mult)
        return
    pos = acct["positions"].get(sym, {"qty": 0, "avg_cost": 0.0})
    if side == "buy":
        cost = qty * fill_px
        if cost > acct["cash"] + 1e-6:
            order["status"], order["reason"] = "rejected", "Insufficient buying power"
            return
        acct["cash"] -= cost
        new_qty = pos["qty"] + qty
        pos["avg_cost"] = (pos["qty"] * pos["avg_cost"] + cost) / new_qty if new_qty else 0.0
        pos["qty"] = new_qty
        acct["positions"][sym] = pos
    else:  # sell — long-only, no shorting
        if qty > pos["qty"]:
            order["status"], order["reason"] = "rejected", "Insufficient shares to sell"
            return
        acct["cash"] += qty * fill_px
        acct["realized_pnl"] += (fill_px - pos["avg_cost"]) * qty
        pos["qty"] -= qty
        if pos["qty"] <= 0:
            acct["positions"].pop(sym, None)
        else:
            acct["positions"][sym] = pos
    order["status"], order["fill_price"], order["filled_at"] = "filled", round(fill_px, 4), time.time()


_OPT_MULT = 100


def _option_fillable(order: dict, px: float) -> float | None:
    if order["order_type"] == "market":
        return px
    lim = order["limit_price"]            # option orders rest as limits only
    if order["side"].startswith("buy") and px <= lim:
        return px
    if order["side"].startswith("sell") and px >= lim:
        return px
    return None


def _apply_option_fill(acct: dict, order: dict, fill_px: float, info: dict) -> None:
    osym, qty, side = order["option_symbol"], order["quantity"], order["side"]
    cost = fill_px * _OPT_MULT * qty
    pos = acct["options"].get(osym, {"qty": 0, "avg_cost": 0.0, "underlying": info["underlying"],
                                     "expiry": info["expiry"], "type": info["type"], "strike": info["strike"]})
    if side.startswith("buy"):
        if cost > acct["cash"] + 1e-6:
            order["status"], order["reason"] = "rejected", "Insufficient buying power"
            return
        acct["cash"] -= cost
        new_qty = pos["qty"] + qty
        if pos["qty"] >= 0 and new_qty:
            pos["avg_cost"] = (pos["qty"] * pos["avg_cost"] + qty * fill_px * _OPT_MULT) / new_qty
        pos["qty"] = new_qty
    else:  # sell
        acct["cash"] += cost
        if pos["qty"] > 0:
            closed = min(qty, pos["qty"])
            acct["realized_pnl"] += (fill_px * _OPT_MULT - pos["avg_cost"]) * closed
        pos["qty"] -= qty
    if pos["qty"] == 0:
        acct["options"].pop(osym, None)
    else:
        acct["options"][osym] = pos
    order["status"], order["fill_price"], order["filled_at"] = "filled", round(fill_px, 4), time.time()


def _evaluate_open(acct: dict) -> None:
    """Fill any resting orders (equity or option) the price has now triggered."""
    for o in acct["orders"]:
        if o["status"] != "open":
            continue
        if o.get("option_symbol"):
            px = _option_price(o["option_symbol"])
            if px is None:
                continue
            fp = _option_fillable(o, px)
            if fp is not None:
                _apply_option_fill(acct, o, fp, _parse_occ(o["option_symbol"]))
        else:
            px = _price(o["symbol"])
            if px is None:
                continue
            fp = _fill_price(o, px)
            if fp is not None:
                _apply_fill(acct, o, fp)


def place_order(user_id: str, symbol: str, side: str, quantity: int,
                order_type: str = "market", limit_price=None, stop_price=None) -> dict:
    symbol = (symbol or "").strip().upper()
    if not symbol:
        raise ValueError("Symbol required")
    if quantity is None or quantity <= 0:
        raise ValueError("Quantity must be positive")
    if side not in ("buy", "sell"):
        raise ValueError("Side must be buy or sell")
    if order_type not in ("market", "limit", "stop"):
        raise ValueError("Order type must be market, limit, or stop")
    if order_type == "limit" and not limit_price:
        raise ValueError("Limit price required")
    if order_type == "stop" and not stop_price:
        raise ValueError("Stop price required")

    with _lock:
        acct = _load(user_id)
        _evaluate_open(acct)
        px = _price(symbol)
        if px is None:
            raise ValueError(f"No live price for {symbol}")
        order = {
            "id": uuid.uuid4().hex[:10], "symbol": symbol, "side": side, "quantity": int(quantity),
            "order_type": order_type, "limit_price": limit_price, "stop_price": stop_price,
            "status": "open", "reason": None, "fill_price": None,
            "created_at": time.time(), "filled_at": None,
        }
        fp = _fill_price(order, px)
        if fp is not None:
            _apply_fill(acct, order, fp)
        acct["orders"].insert(0, order)
        acct["orders"] = acct["orders"][:100]
        _save(user_id, acct)
        return order


def place_option_order(user_id: str, option_symbol: str, side: str, quantity: int,
                       order_type: str = "market", price=None) -> dict:
    option_symbol = (option_symbol or "").strip().upper()
    info = _parse_occ(option_symbol)
    if not info:
        raise ValueError("Invalid option symbol")
    if quantity is None or quantity <= 0:
        raise ValueError("Quantity must be positive")
    if side not in ("buy_to_open", "sell_to_open", "buy_to_close", "sell_to_close"):
        raise ValueError("Invalid option side")
    if order_type not in ("market", "limit"):
        raise ValueError("Option orders are market or limit")
    if order_type == "limit" and not price:
        raise ValueError("Limit price required")

    with _lock:
        acct = _load(user_id)
        _evaluate_open(acct)
        mkt = _option_price(option_symbol)
        if mkt is None:
            raise ValueError("No live price for this option contract")
        order = {
            "id": uuid.uuid4().hex[:10], "option_symbol": option_symbol, "symbol": info["underlying"],
            "side": side, "quantity": int(quantity), "order_type": order_type,
            "limit_price": price, "stop_price": None, "status": "open", "reason": None,
            "fill_price": None, "created_at": time.time(), "filled_at": None,
        }
        fp = _option_fillable(order, mkt)
        if fp is not None:
            _apply_option_fill(acct, order, fp, info)
        acct["orders"].insert(0, order)
        acct["orders"] = acct["orders"][:100]
        _save(user_id, acct)
        return order


def place_multileg_order(user_id: str, legs: list[dict], order_type: str = "market", net_price=None) -> dict:
    """legs: [{option_symbol, side, quantity}]. Market fills every leg at its mid;
    a net limit fills only if the combined debit is within net_price."""
    if not (2 <= len(legs) <= 4):
        raise ValueError("Multi-leg orders need 2-4 legs")
    parsed = []
    net_debit = 0.0
    for leg in legs:
        info = _parse_occ((leg.get("option_symbol") or "").strip().upper())
        if not info:
            raise ValueError(f"Invalid option symbol: {leg.get('option_symbol')}")
        if leg.get("side") not in ("buy_to_open", "sell_to_open", "buy_to_close", "sell_to_close"):
            raise ValueError("Invalid option side")
        qty = int(leg.get("quantity") or 0)
        if qty <= 0:
            raise ValueError("Leg quantity must be positive")
        px = _option_price(leg["option_symbol"].strip().upper())
        if px is None:
            raise ValueError(f"No price for {leg['option_symbol']}")
        sign = 1 if leg["side"].startswith("buy") else -1
        net_debit += sign * px * _OPT_MULT * qty
        parsed.append((leg["option_symbol"].strip().upper(), leg["side"], qty, px, info))

    if order_type == "limit" and net_price is not None and net_debit > net_price + 1e-6:
        return {"id": uuid.uuid4().hex[:10], "status": "rejected", "reason": "Net debit exceeds limit", "legs": len(legs)}

    with _lock:
        acct = _load(user_id)
        _evaluate_open(acct)
        # Buying-power check on the net debit (credit nets favourably).
        if net_debit > acct["cash"] + 1e-6:
            return {"id": uuid.uuid4().hex[:10], "status": "rejected", "reason": "Insufficient buying power", "legs": len(legs)}
        ml_id = uuid.uuid4().hex[:10]
        for osym, side, qty, px, info in parsed:
            leg_order = {
                "id": uuid.uuid4().hex[:10], "option_symbol": osym, "symbol": info["underlying"],
                "side": side, "quantity": qty, "order_type": "market", "limit_price": None, "stop_price": None,
                "status": "open", "reason": None, "fill_price": None, "created_at": time.time(),
                "filled_at": None, "multileg_id": ml_id,
            }
            _apply_option_fill(acct, leg_order, px, info)
            acct["orders"].insert(0, leg_order)
        acct["orders"] = acct["orders"][:120]
        _save(user_id, acct)
        return {"id": ml_id, "status": "filled", "legs": len(legs), "net_debit": round(net_debit, 2)}


def get_account(user_id: str) -> dict:
    with _lock:
        acct = _load(user_id)
        _evaluate_open(acct)
        _save(user_id, acct)
        equity, margin_used, positions, option_positions = _value(acct)
        return {
            "cash": round(acct["cash"], 2), "equity": round(equity, 2),
            "buying_power": round(equity - margin_used, 2), "margin_used": round(margin_used, 2),
            "realized_pnl": round(acct["realized_pnl"], 2),
            "positions": positions, "option_positions": option_positions, "orders": acct["orders"][:50],
        }


def cancel_order(user_id: str, order_id: str) -> dict:
    with _lock:
        acct = _load(user_id)
        for o in acct["orders"]:
            if o["id"] == order_id and o["status"] == "open":
                o["status"] = "canceled"
        _save(user_id, acct)
    return {"ok": True}


def reset_account(user_id: str) -> dict:
    with _lock:
        _save(user_id, _new_account())
    return get_account(user_id)


def seed_from_holdings(user_id: str, holdings: list[dict], cash: float = STARTING_CASH) -> dict:
    """Replace the paper account with positions imported from a Portfolio Manager
    book: each holding becomes an owned equity position at its average cost, with a
    fresh cash balance to trade alongside. Overwrites the existing account."""
    with _lock:
        acct = _new_account()
        acct["cash"] = cash
        for h in holdings:
            sym = (h.get("ticker") or "").strip().upper()
            try:
                shares = float(h.get("shares") or 0)
                avg = float(h.get("avg_cost") or 0)
            except (TypeError, ValueError):
                continue
            if not sym or shares <= 0 or avg < 0:
                continue
            acct["positions"][sym] = {"qty": shares, "avg_cost": avg}
        _save(user_id, acct)
    return get_account(user_id)
