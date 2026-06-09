import logging
import sys, os
sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))
import tradier as _tradier
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

logger = logging.getLogger(__name__)
router = APIRouter()


@router.get("/account")
def get_account():
    try:
        balances  = _tradier.get_balances()
        positions = _tradier.get_positions()
        orders    = _tradier.get_orders()
        return {"balances": balances, "positions": positions, "orders": orders}
    except Exception as e:
        logger.exception("account fetch error")
        raise HTTPException(500, "Internal server error")


@router.get("/positions")
def get_positions():
    try:
        return {"positions": _tradier.get_positions()}
    except Exception as e:
        logger.exception("positions fetch error")
        raise HTTPException(500, "Internal server error")


@router.get("/orders")
def get_orders():
    try:
        return {"orders": _tradier.get_orders()}
    except Exception as e:
        logger.exception("orders fetch error")
        raise HTTPException(500, "Internal server error")


class EquityOrderRequest(BaseModel):
    symbol:     str
    side:       str       # "buy" | "sell"
    quantity:   int
    order_type: str = "market"
    price:      float | None = None
    duration:   str = "day"


@router.post("/order/equity")
def place_equity_order(req: EquityOrderRequest):
    try:
        result = _tradier.place_equity_order(
            symbol=req.symbol.upper(),
            side=req.side,
            quantity=req.quantity,
            order_type=req.order_type,
            price=req.price,
            duration=req.duration,
        )
        return result
    except Exception as e:
        logger.exception("equity order error")
        raise HTTPException(500, "Internal server error")


class OptionOrderRequest(BaseModel):
    symbol:        str
    option_symbol: str   # OCC symbol e.g. "SPY250117C00580000"
    side:          str   # "buy_to_open" | "sell_to_open" | "buy_to_close" | "sell_to_close"
    quantity:      int
    order_type:    str = "market"
    price:         float | None = None
    duration:      str = "day"


@router.post("/order/option")
def place_option_order(req: OptionOrderRequest):
    try:
        result = _tradier.place_option_order(
            symbol=req.symbol.upper(),
            option_symbol=req.option_symbol,
            side=req.side,
            quantity=req.quantity,
            order_type=req.order_type,
            price=req.price,
            duration=req.duration,
        )
        return result
    except Exception as e:
        logger.exception("option order error")
        raise HTTPException(500, "Internal server error")


class MultilegLeg(BaseModel):
    option_symbol: str
    side:          str   # "buy_to_open" | "sell_to_open" | "buy_to_close" | "sell_to_close"
    quantity:      int = 1


class MultilegOrderRequest(BaseModel):
    symbol:     str
    legs:       list[MultilegLeg]
    order_type: str = "debit"    # "debit" | "credit" | "even" | "market"
    price:      float | None = None
    duration:   str = "day"


@router.post("/order/multileg")
def place_multileg_order(req: MultilegOrderRequest):
    if len(req.legs) < 2 or len(req.legs) > 4:
        raise HTTPException(400, "Multi-leg orders require 2–4 legs")
    try:
        result = _tradier.place_multileg_order(
            symbol=req.symbol.upper(),
            legs=[{"option_symbol": l.option_symbol, "side": l.side, "quantity": l.quantity}
                  for l in req.legs],
            order_type=req.order_type,
            price=req.price,
            duration=req.duration,
        )
        return result
    except Exception as e:
        logger.exception("multileg order error")
        raise HTTPException(500, str(e))


@router.delete("/order/{order_id}")
def cancel_order(order_id: str):
    try:
        return _tradier.cancel_order(order_id)
    except Exception as e:
        logger.exception("cancel order error")
        raise HTTPException(500, "Internal server error")
