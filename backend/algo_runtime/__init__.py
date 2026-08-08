"""Code-first strategy runtime.

The AI writes ONE pure function — `signal(c) -> Signals` — and nothing else.
Data loading, P&L, multi-lot tracking, risk controls and option pricing stay in
routers/algo.py, which is validated and must not be regenerated per strategy.

The seam this plugs into already exists: routers/strategy.py's
`evaluate_custom_rules(..., raw=True)` returns `(buy_signal, sell_signal)`, two
plain bool arrays, and the three P&L engines consume exactly that. A compiled or
AI-authored `signal()` returns the same pair, so it is a second implementation
behind an existing interface rather than a rewrite.

Security follows from the contract: a pure array->array function has no
legitimate need for imports, filesystem or network, so the validator bans
imports outright and the sandbox injects `np` / `ind` into the namespace.
"""
from .contract import Ctx, Signals, ctx_from_frames        # noqa: F401
from .compiler import compile_rules, UnsupportedRule       # noqa: F401
from .validate import validate_source, ValidationError, Diagnostic   # noqa: F401
from .sandbox import run_signal, SandboxError              # noqa: F401
