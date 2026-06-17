import sys, os
sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))

from fastapi import APIRouter, Header, HTTPException
from pydantic import BaseModel

import paper_engine
from routers.users import _require_owner

router = APIRouter()


@router.get("/account")
def account(user_id: str, authorization: str = Header(default=""), x_session_token: str = Header(default="")):
    _require_owner(user_id, authorization, x_session_token)
    return paper_engine.get_account(user_id)


class OrderRequest(BaseModel):
    user_id:     str
    symbol:      str
    side:        str       # "buy" | "sell"
    quantity:    int
    order_type:  str = "market"   # "market" | "limit" | "stop"
    limit_price: float | None = None
    stop_price:  float | None = None


@router.post("/order")
def place_order(req: OrderRequest, authorization: str = Header(default=""), x_session_token: str = Header(default="")):
    _require_owner(req.user_id, authorization, x_session_token)
    try:
        return paper_engine.place_order(
            req.user_id, req.symbol, req.side, req.quantity,
            req.order_type, req.limit_price, req.stop_price,
        )
    except ValueError as e:
        raise HTTPException(400, str(e))


class OptionOrderRequest(BaseModel):
    user_id:       str
    option_symbol: str       # OCC, e.g. SPY250620C00580000
    side:          str       # buy_to_open | sell_to_open | buy_to_close | sell_to_close
    quantity:      int
    order_type:    str = "market"
    price:         float | None = None


@router.post("/order/option")
def place_option_order(req: OptionOrderRequest, authorization: str = Header(default=""), x_session_token: str = Header(default="")):
    _require_owner(req.user_id, authorization, x_session_token)
    try:
        return paper_engine.place_option_order(req.user_id, req.option_symbol, req.side, req.quantity, req.order_type, req.price)
    except ValueError as e:
        raise HTTPException(400, str(e))


class MultilegLeg(BaseModel):
    option_symbol: str
    side:          str
    quantity:      int = 1


class MultilegRequest(BaseModel):
    user_id:    str
    legs:       list[MultilegLeg]
    order_type: str = "market"
    net_price:  float | None = None


@router.post("/order/multileg")
def place_multileg_order(req: MultilegRequest, authorization: str = Header(default=""), x_session_token: str = Header(default="")):
    _require_owner(req.user_id, authorization, x_session_token)
    try:
        return paper_engine.place_multileg_order(
            req.user_id, [{"option_symbol": l.option_symbol, "side": l.side, "quantity": l.quantity} for l in req.legs],
            req.order_type, req.net_price,
        )
    except ValueError as e:
        raise HTTPException(400, str(e))


class IdRequest(BaseModel):
    user_id: str


@router.post("/reset")
def reset(req: IdRequest, authorization: str = Header(default=""), x_session_token: str = Header(default="")):
    _require_owner(req.user_id, authorization, x_session_token)
    return paper_engine.reset_account(req.user_id)


class SeedHolding(BaseModel):
    ticker:   str
    shares:   float
    avg_cost: float = 0.0


class SeedRequest(BaseModel):
    user_id:  str
    holdings: list[SeedHolding]


@router.post("/seed")
def seed(req: SeedRequest, authorization: str = Header(default=""), x_session_token: str = Header(default="")):
    _require_owner(req.user_id, authorization, x_session_token)
    return paper_engine.seed_from_holdings(
        req.user_id, [{"ticker": h.ticker, "shares": h.shares, "avg_cost": h.avg_cost} for h in req.holdings],
    )


@router.delete("/order/{order_id}")
def cancel(order_id: str, user_id: str, authorization: str = Header(default=""), x_session_token: str = Header(default="")):
    _require_owner(user_id, authorization, x_session_token)
    return paper_engine.cancel_order(user_id, order_id)
