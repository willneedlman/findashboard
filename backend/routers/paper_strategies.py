"""
/api/paper-strategies — strategy registration, management, and replay engine.

Endpoints
─────────
  POST   /upload              Upload a .py file; validates + registers the strategy.
  GET    /                    List all registered strategies and their on/off state.
  POST   /{name}/toggle       Enable or disable a strategy by name.
  DELETE /{name}              Unload a strategy from the registry.
  POST   /replay              Run a historical tick-by-tick replay for all active strategies.
  POST   /tick                Feed a single live MarketDataPoint to all active strategies.
  GET    /builtin             List names of pre-shipped builtin strategies.
  POST   /builtin/{name}/load Load a builtin strategy by name.
"""

from __future__ import annotations

import os
import sys
import hmac
import logging
from typing import Any

sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))
from cache import get_history

from fastapi import APIRouter, File, Header, HTTPException, UploadFile
from pydantic import BaseModel

from core.loader import LoadError, SandboxViolation, StrategyLoader
from strategies.base import MarketDataPoint, Signal, Strategy

_log = logging.getLogger(__name__)
router = APIRouter()

# ── Singleton loader (shared across requests) ──────────────────────────────────
_loader = StrategyLoader()

# ── Active strategy registry ──────────────────────────────────────────────────
# { strategy_name: { "cls": Type[Strategy], "params": dict, "enabled": bool } }
_active: dict[str, dict] = {}

# ── Builtin map ────────────────────────────────────────────────────────────────
def _register_builtins() -> None:
    from strategies.builtin.rsi_strategy       import RSIMeanReversionStrategy
    from strategies.builtin.sma_trend          import SMATrendStrategy
    from strategies.builtin.bollinger_breakout import BollingerBreakoutStrategy
    from strategies.builtin.momentum           import MomentumStrategy
    from strategies.builtin.macd_crossover     import MACDCrossoverStrategy
    from strategies.builtin.value_pe           import ValuePEStrategy
    from strategies.builtin.earnings_growth    import EarningsGrowthStrategy
    from strategies.builtin.gamma_scalping     import GammaScalpingStrategy
    from strategies.builtin.micro_scalp        import MicroScalpStrategy
    for cls in [
        RSIMeanReversionStrategy,
        SMATrendStrategy,
        BollingerBreakoutStrategy,
        MomentumStrategy,
        MACDCrossoverStrategy,
        ValuePEStrategy,
        EarningsGrowthStrategy,
        GammaScalpingStrategy,
        MicroScalpStrategy,
    ]:
        inst = cls()
        meta = inst.metadata()
        _active[meta.name] = {"cls": cls, "params": {}, "enabled": False}
        _loader._registry[meta.name] = cls
    # No strategy is enabled by default — the user opts in explicitly.

_register_builtins()

_BUILTIN_NAMES = list(_active.keys())


# ── Request / Response models ──────────────────────────────────────────────────

class StrategyEntry(BaseModel):
    name:        str
    version:     str
    author:      str
    description: str
    parameters:  dict[str, Any]
    enabled:     bool

class ToggleRequest(BaseModel):
    enabled: bool
    params:  dict[str, Any] = {}

class CustomStrategyCreate(BaseModel):
    name:       str
    rules:      dict
    bull_drift: float = 5.0
    bear_drift: float = -3.0
    instrument: dict | None = None   # {kind:"option", type, moneyness, dte} → scheduler trades real live options
    side:       str = "long"          # long|short — drives direction for shares AND options

class TickRequest(BaseModel):
    timestamp: float
    symbol:    str
    price:     float
    size:      float = 0.0
    side:      str   = ""

class ReplayRequest(BaseModel):
    ticker:      str
    start:       str              = "2023-01-01"
    end:         str | None       = None
    params_map:  dict[str, dict]  = {}   # { strategy_name: params_override }
    sample_rate: int              = 1    # take every Nth bar (1 = all bars)

class SignalEventOut(BaseModel):
    strategy_name: str
    timestamp:     float
    symbol:        str
    signal:        str
    price:         float
    notes:         str

class ReplayResult(BaseModel):
    ticker:        str
    bars_processed: int
    events:        list[SignalEventOut]
    summary:       dict[str, dict]   # { strategy_name: { BUY: N, SELL: N, HOLD: N } }


# ── Helpers ────────────────────────────────────────────────────────────────────

def _build_entry(name: str) -> StrategyEntry:
    rec  = _active[name]
    inst = rec["cls"]()
    meta = inst.metadata()
    return StrategyEntry(
        name        = name,
        version     = meta.version,
        author      = meta.author,
        description = meta.description,
        parameters  = meta.parameters,
        enabled     = rec["enabled"],
    )

def _fetch_bars(ticker: str, start: str, end: str | None) -> list[dict]:
    hist = get_history(ticker, start=start, end=end)
    if hist.empty:
        raise HTTPException(404, f"No price data for {ticker}")
    bars = []
    for ts, row in hist.iterrows():
        bars.append({
            "timestamp": ts.timestamp(),
            "price":     float(row["Close"]),
            "size":      float(row.get("Volume", 0)),
            "side":      "trade",
        })
    return bars


# ── Endpoints ──────────────────────────────────────────────────────────────────

_ADMIN_SECRET = os.getenv("ADMIN_SECRET", "")


@router.post("/upload", response_model=StrategyEntry)
async def upload_strategy(file: UploadFile = File(...), x_admin_secret: str = Header(default="")):
    """
    Upload a .py file containing a single Strategy subclass.

    SECURITY: uploaded code is executed server-side. The AST sandbox in
    core.loader is a denylist and NOT a hard security boundary, so this endpoint
    is gated behind ADMIN_SECRET. Normal users should use the parameterized
    /custom rule builder, which executes no arbitrary code. For untrusted upload
    at scale, run strategies in an isolated process/container instead.
    """
    if not _ADMIN_SECRET or not hmac.compare_digest(x_admin_secret, _ADMIN_SECRET):
        raise HTTPException(403, "Strategy upload requires admin authorization.")
    if not (file.filename or "").endswith(".py"):
        raise HTTPException(400, "File must be a .py file.")

    source = await file.read()
    try:
        cls = _loader.load_bytes(source, module_name=file.filename or "upload")
    except SandboxViolation as exc:
        raise HTTPException(422, f"Sandbox violation: {exc}") from exc
    except LoadError as exc:
        raise HTTPException(422, f"Load error: {exc}") from exc

    inst = cls()
    meta = inst.metadata()
    _active[meta.name] = {"cls": cls, "params": {}, "enabled": True}
    _log.info("Loaded external strategy '%s' from upload", meta.name)
    return _build_entry(meta.name)


@router.get("/", response_model=list[StrategyEntry])
def list_strategies():
    return [_build_entry(n) for n in _active]


@router.post("/{name}/toggle", response_model=StrategyEntry)
def toggle_strategy(name: str, body: ToggleRequest):
    if name not in _active:
        raise HTTPException(404, f"Strategy '{name}' not registered.")
    _active[name]["enabled"] = body.enabled
    if body.params:
        _active[name]["params"] = body.params
    return _build_entry(name)


@router.delete("/{name}")
def delete_strategy(name: str):
    if name in _BUILTIN_NAMES:
        raise HTTPException(403, "Builtin strategies cannot be unloaded.")
    if name not in _active:
        raise HTTPException(404, f"Strategy '{name}' not registered.")
    _active.pop(name)
    _loader.unload(name)
    return {"deleted": name}


@router.get("/builtin", response_model=list[str])
def list_builtins():
    return _BUILTIN_NAMES


@router.post("/builtin/{name}/load", response_model=StrategyEntry)
def load_builtin(name: str):
    if name not in _BUILTIN_NAMES:
        raise HTTPException(404, f"No builtin strategy named '{name}'.")
    _active[name]["enabled"] = True
    return _build_entry(name)


@router.post("/custom", response_model=StrategyEntry)
def create_custom_strategy(body: CustomStrategyCreate):
    """Register a user-defined rule strategy in the active registry."""
    from strategies.builtin.custom_rule_strategy import CustomRuleStrategy

    safe_name = body.name.strip().lower().replace(" ", "_")[:40]
    if not safe_name:
        raise HTTPException(400, "Strategy name must not be empty.")

    params = {
        "name":       safe_name,
        "rules":      body.rules,
        "bull_drift": body.bull_drift,
        "bear_drift": body.bear_drift,
        "side":       body.side,
    }
    if body.instrument:
        params["instrument"] = body.instrument
    inst = CustomRuleStrategy()
    inst.initialize(params)

    _active[safe_name] = {"cls": CustomRuleStrategy, "params": params, "enabled": True}
    _loader._registry[safe_name] = CustomRuleStrategy
    _log.info("Registered custom rule strategy '%s'", safe_name)
    return _build_entry(safe_name)


class PortfolioPaperPosition(BaseModel):
    ticker:        str
    rules:         dict
    instrument:    dict | None = None
    side:          str = "long"
    weight:        float = 0.0           # direct % of the whole portfolio
    position_size: float | None = None   # optional per-position trade-size override


class PortfolioPaperCreate(BaseModel):
    user_id:   str
    name:      str = "portfolio"
    positions: list[PortfolioPaperPosition]
    position_size: float = 10


@router.post("/portfolio")
def create_portfolio_paper(body: PortfolioPaperCreate, authorization: str = Header(default=""), x_session_token: str = Header(default="")):
    """Fan a portfolio out into the paper trader: register each position as its own
    rule strategy (rules + instrument + side) and schedule one live job per
    position. Long/short shares and long/short options all trade at live prices
    (a short option writes the contract sell-to-open and buys it back on exit)."""
    from routers.users import _require_owner
    from routers.paper_scheduler import _insert_job
    from strategies.builtin.custom_rule_strategy import CustomRuleStrategy
    _require_owner(body.user_id, authorization, x_session_token)
    if not body.positions:
        raise HTTPException(400, "A portfolio needs at least one position")
    if not 1 <= body.position_size <= 100:
        raise HTTPException(400, "Trade size must be between 1% and 100% of the portfolio")

    base = (body.name or "portfolio").strip().lower().replace(" ", "_")[:24] or "portfolio"
    created = 0
    for i, p in enumerate(body.positions):
        tk = p.ticker.strip().upper()
        if not tk:
            continue
        name = f"{base}_{tk}_{i}"[:40]
        if p.position_size is not None and not 1 <= p.position_size <= 100:
            raise HTTPException(400, f"Trade size override for {tk} must be between 1% and 100% of the portfolio")
        params = {"name": name, "rules": p.rules, "bull_drift": 0.0, "bear_drift": 0.0, "side": p.side,
                  "portfolio_trade_size_pct": p.position_size if p.position_size is not None else body.position_size}
        if p.instrument:
            params["instrument"] = p.instrument
        CustomRuleStrategy().initialize(params)   # validate rules parse
        _active[name] = {"cls": CustomRuleStrategy, "params": params, "enabled": True}
        _loader._registry[name] = CustomRuleStrategy
        _insert_job(body.user_id, tk, name, params, 1)
        created += 1

    if created == 0:
        raise HTTPException(400, "No valid positions to schedule")
    _log.info("Scheduled portfolio '%s' as %d paper jobs", base, created)
    return {"created": created}


@router.post("/tick", response_model=list[SignalEventOut])
def single_tick(body: TickRequest):
    """Feed one live data point to all enabled strategies and return signals."""
    try:
        point = MarketDataPoint(
            timestamp = body.timestamp,
            symbol    = body.symbol.upper(),
            price     = body.price,
            size      = body.size,
            side      = body.side,
        )
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc

    results: list[SignalEventOut] = []
    for name, rec in _active.items():
        if not rec["enabled"]:
            continue
        inst: Strategy = rec["cls"]()
        inst.initialize(rec["params"])
        try:
            sig = inst.on_data(point)
        except Exception as exc:
            _log.warning("Strategy '%s' raised on tick: %s", name, exc)
            sig = Signal.HOLD
        results.append(SignalEventOut(
            strategy_name = name,
            timestamp     = point.timestamp,
            symbol        = point.symbol,
            signal        = sig.value,
            price         = point.price,
            notes         = "",
        ))
    return results


@router.post("/replay", response_model=ReplayResult)
def replay(req: ReplayRequest):
    """
    Run a full historical replay.

    For each bar, all enabled strategies receive a MarketDataPoint.
    Signals are logged per strategy and a summary count is returned.
    """
    ticker = req.ticker.strip().upper()
    bars   = _fetch_bars(ticker, req.start, req.end)

    if req.sample_rate > 1:
        bars = bars[::req.sample_rate]

    # Instantiate + initialize fresh copies of all enabled strategies
    instances: dict[str, Strategy] = {}
    for name, rec in _active.items():
        if not rec["enabled"]:
            continue
        params = {**rec["params"], **req.params_map.get(name, {})}
        inst = rec["cls"]()
        inst.initialize(params)
        instances[name] = inst

    events: list[SignalEventOut] = []
    summary: dict[str, dict] = {
        n: {"BUY": 0, "SELL": 0, "HOLD": 0} for n in instances
    }

    for bar in bars:
        try:
            point = MarketDataPoint(
                timestamp = bar["timestamp"],
                symbol    = ticker,
                price     = bar["price"],
                size      = bar["size"],
                side      = bar["side"],
            )
        except ValueError:
            continue

        for name, inst in instances.items():
            try:
                sig = inst.on_data(point)
            except Exception as exc:
                _log.warning("Strategy '%s' raised during replay bar: %s", name, exc)
                sig = Signal.HOLD

            summary[name][sig.value] += 1

            # Only log non-HOLD events to keep response size manageable.
            # Change this to `if True:` to log every tick.
            if sig != Signal.HOLD:
                events.append(SignalEventOut(
                    strategy_name = name,
                    timestamp     = point.timestamp,
                    symbol        = ticker,
                    signal        = sig.value,
                    price         = point.price,
                    notes         = "",
                ))

    return ReplayResult(
        ticker          = ticker,
        bars_processed  = len(bars),
        events          = events,
        summary         = summary,
    )
