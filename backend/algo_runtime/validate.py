"""Validation layers L0-L6.

Ordered cheapest-first; the caller stops at the first failure and feeds the
diagnostic back to the model as a repair prompt.

  L0 syntax        ast.parse
  L1 static        AST allowlist — no imports, dunders, eval/exec/open
  L2 contract      signature, return type, shapes, dtype
  L3 causality     prefix invariance  <- the lookahead detector
  L4 warmup        no signal before indicators are warm
  L5 determinism   two runs agree
  L6 degeneracy    not vacuously all-True / all-False

L1 is a security boundary, not a style check. L3 is the one that earns its
keep: scanning source for `.shift(-1)` is trivially evadable, so instead the
property itself is tested — a function that uses only past data produces
identical signals on a prefix of the data, and any future peek breaks that.
"""
from __future__ import annotations

import ast
from dataclasses import dataclass, field
from typing import Any, Callable

import numpy as np

# Names generated code may reference. Anything else is a NameError at validation
# time rather than a surprise at backtest time.
ALLOWED_GLOBALS = frozenset({"c", "ind", "np", "Signals", "signal", "True", "False", "None"})

SAFE_BUILTINS: dict[str, Any] = {
    "abs": abs, "min": min, "max": max, "sum": sum, "len": len, "range": range,
    "round": round, "int": int, "float": float, "bool": bool, "enumerate": enumerate,
    "zip": zip, "sorted": sorted, "all": all, "any": any, "list": list, "tuple": tuple,
    "dict": dict, "set": set, "str": str, "print": print, "isinstance": isinstance,
    "ValueError": ValueError, "TypeError": TypeError, "ZeroDivisionError": ZeroDivisionError,
    "Exception": Exception,
}

_BANNED_CALLS = frozenset({
    "eval", "exec", "compile", "open", "__import__", "input", "globals", "locals",
    "vars", "getattr", "setattr", "delattr", "breakpoint", "memoryview", "id",
})

# Attribute names that reach the interpreter internals. `__class__` alone is
# enough to walk to `object.__subclasses__()` and out of any namespace jail.
_BANNED_ATTR_PREFIX = "__"

MAX_SOURCE_BYTES = 64_000
MAX_LOOP_DEPTH = 2


class ValidationError(Exception):
    def __init__(self, diagnostics: "list[Diagnostic]"):
        self.diagnostics = diagnostics
        super().__init__("; ".join(d.message for d in diagnostics) or "validation failed")


@dataclass
class Diagnostic:
    level: str            # 'L0'..'L6'
    severity: str         # 'error' | 'warning'
    message: str
    line: int | None = None

    def as_dict(self) -> dict:
        return {"level": self.level, "severity": self.severity,
                "message": self.message, "line": self.line}


@dataclass
class ValidationResult:
    ok: bool
    diagnostics: list[Diagnostic] = field(default_factory=list)

    @property
    def errors(self) -> list[Diagnostic]:
        return [d for d in self.diagnostics if d.severity == "error"]

    @property
    def warnings(self) -> list[Diagnostic]:
        return [d for d in self.diagnostics if d.severity == "warning"]

    def as_dict(self) -> dict:
        return {"ok": self.ok, "diagnostics": [d.as_dict() for d in self.diagnostics]}

    def repair_prompt(self) -> str:
        """What gets appended to the regeneration request. Names the failing check
        so the model fixes the cause, not the symptom."""
        if self.ok:
            return ""
        lines = ["The strategy you wrote failed validation. Fix these and return the whole function again:"]
        for d in self.diagnostics:
            if d.severity != "error":
                continue
            where = f" (line {d.line})" if d.line else ""
            lines.append(f"- [{d.level}]{where} {d.message}")
        return "\n".join(lines)


# ── L0 + L1 ──────────────────────────────────────────────────────────────────

def _static_check(source: str) -> list[Diagnostic]:
    out: list[Diagnostic] = []
    if len(source.encode()) > MAX_SOURCE_BYTES:
        return [Diagnostic("L1", "error", f"source exceeds {MAX_SOURCE_BYTES} bytes")]

    try:
        tree = ast.parse(source)
    except SyntaxError as e:
        return [Diagnostic("L0", "error", f"syntax error: {e.msg}", e.lineno)]

    assigned: set[str] = set()
    loop_depth = 0

    for node in ast.walk(tree):
        # Imports are banned outright: a pure array->array function has no
        # legitimate need for one, and banning them means no socket, no os, no
        # subprocess can exist in the namespace at all.
        if isinstance(node, (ast.Import, ast.ImportFrom)):
            out.append(Diagnostic("L1", "error",
                                  "imports are not allowed; np and ind are already available", node.lineno))
        elif isinstance(node, ast.Attribute) and node.attr.startswith(_BANNED_ATTR_PREFIX):
            out.append(Diagnostic("L1", "error",
                                  f"dunder attribute {node.attr!r} is not allowed", node.lineno))
        elif isinstance(node, ast.Name) and isinstance(node.ctx, ast.Load) and node.id in _BANNED_CALLS:
            out.append(Diagnostic("L1", "error", f"{node.id!r} is not allowed", node.lineno))
        elif isinstance(node, (ast.Global, ast.Nonlocal)):
            out.append(Diagnostic("L1", "error", "global/nonlocal are not allowed", node.lineno))
        elif isinstance(node, (ast.AsyncFunctionDef, ast.Await, ast.AsyncFor, ast.AsyncWith)):
            out.append(Diagnostic("L1", "error", "async code is not allowed", node.lineno))
        elif isinstance(node, ast.ClassDef):
            out.append(Diagnostic("L1", "error", "class definitions are not allowed", node.lineno))
        elif isinstance(node, (ast.Try, ast.Raise)):
            # A bare `except: pass` around a broken indicator hides the bug and
            # produces a silently empty strategy.
            out.append(Diagnostic("L1", "warning",
                                  "try/except hides indicator errors; prefer letting them surface", node.lineno))

        if isinstance(node, (ast.Assign, ast.AugAssign, ast.AnnAssign)):
            tgts = node.targets if isinstance(node, ast.Assign) else [node.target]
            for t in tgts:
                for sub in ast.walk(t):
                    if isinstance(sub, ast.Name):
                        assigned.add(sub.id)
        elif isinstance(node, (ast.FunctionDef, ast.Lambda)):
            args = node.args
            for a in list(args.args) + list(args.kwonlyargs) + list(args.posonlyargs):
                assigned.add(a.arg)
            if args.vararg:
                assigned.add(args.vararg.arg)
            if args.kwarg:
                assigned.add(args.kwarg.arg)
            if isinstance(node, ast.FunctionDef):
                assigned.add(node.name)
        elif isinstance(node, ast.comprehension):
            for sub in ast.walk(node.target):
                if isinstance(sub, ast.Name):
                    assigned.add(sub.id)
        elif isinstance(node, ast.For):
            for sub in ast.walk(node.target):
                if isinstance(sub, ast.Name):
                    assigned.add(sub.id)
        elif isinstance(node, ast.ExceptHandler) and node.name:
            assigned.add(node.name)

    # while-loops can spin forever; the CPU rlimit catches it but a clear message
    # beats an opaque timeout.
    for node in ast.walk(tree):
        if isinstance(node, ast.While):
            out.append(Diagnostic("L1", "warning",
                                  "while loops risk hitting the CPU limit; prefer vectorized numpy", node.lineno))
        if isinstance(node, ast.For):
            depth = 0
            for parent in ast.walk(tree):
                if isinstance(parent, (ast.For, ast.While)):
                    depth += 1
            loop_depth = max(loop_depth, depth)

    known = ALLOWED_GLOBALS | assigned | set(SAFE_BUILTINS)
    for node in ast.walk(tree):
        if isinstance(node, ast.Name) and isinstance(node.ctx, ast.Load) and node.id not in known:
            out.append(Diagnostic("L1", "error", f"unknown name {node.id!r}", node.lineno))

    return out


# ── L2 ───────────────────────────────────────────────────────────────────────

def _contract_check(tree_source: str) -> list[Diagnostic]:
    tree = ast.parse(tree_source)
    fns = [n for n in tree.body if isinstance(n, ast.FunctionDef)]
    sig = [f for f in fns if f.name == "signal"]
    if not sig:
        return [Diagnostic("L2", "error", "no function named `signal` was defined")]
    fn = sig[0]
    args = fn.args
    positional = list(args.posonlyargs) + list(args.args)
    if len(positional) != 1:
        return [Diagnostic("L2", "error",
                           f"`signal` must take exactly one argument (the Ctx); got {len(positional)}", fn.lineno)]
    returns = [n for n in ast.walk(fn) if isinstance(n, ast.Return) and n.value is not None]
    if not returns:
        return [Diagnostic("L2", "error", "`signal` never returns Signals(entries, exits)", fn.lineno)]
    return []


def _shape_check(sig, n: int) -> list[Diagnostic]:
    out: list[Diagnostic] = []
    for name, arr in (("entries", getattr(sig, "entries", None)), ("exits", getattr(sig, "exits", None))):
        if arr is None:
            out.append(Diagnostic("L2", "error", f"Signals.{name} is missing"))
            continue
        arr = np.asarray(arr)
        if arr.shape != (n,):
            out.append(Diagnostic("L2", "error", f"Signals.{name} has shape {arr.shape}, expected ({n},)"))
        elif arr.dtype != np.bool_:
            out.append(Diagnostic("L2", "error", f"Signals.{name} has dtype {arr.dtype}, expected bool"))

    size = getattr(sig, "size", None)
    if size is not None:
        arr = np.asarray(size, dtype=float)
        if arr.shape != (n,):
            out.append(Diagnostic("L2", "error", f"Signals.size has shape {arr.shape}, expected ({n},)"))
        elif np.nanmin(arr) < 0:
            out.append(Diagnostic("L2", "error",
                                  "Signals.size has negative values; it is a 0..1 fraction of the "
                                  "configured position size, not a share count"))
        elif np.all(np.isnan(arr)):
            out.append(Diagnostic("L2", "error",
                                  "Signals.size is entirely NaN, so no entry would ever be funded"))
    return out


# ── L3-L6 ────────────────────────────────────────────────────────────────────

def _perturb_future(ctx, k: int, factor: float):
    """Same length, same first k bars, wildly different tail."""
    close = np.array(ctx.close, dtype=float)
    close[k:] *= factor
    frames = {}
    for t, a in (ctx.frames or {}).items():
        a2 = np.array(a, dtype=float)
        if len(a2) == len(close):
            a2[k:] *= factor
        frames[t] = a2
    cx = {}
    for t, metrics in (ctx.ctx or {}).items():
        row = {}
        for m, v in (metrics or {}).items():
            if isinstance(v, np.ndarray) and len(v) == len(close):
                v2 = np.array(v, dtype=float)
                v2[k:] *= factor
                row[m] = v2
            else:
                row[m] = v
        cx[t] = row
    from dataclasses import replace
    return replace(ctx, close=close, frames=frames, ctx=cx)


def _causality_check(run: Callable, ctx, cuts=(0.3, 0.45, 0.6, 0.75)) -> list[Diagnostic]:
    """Does any bar read data from after it?

    Primary test is FUTURE PERTURBATION: rewrite the data after bar k, leaving
    bars 0..k-1 byte-identical, and re-run. Causal code cannot observe the change
    (bar i reads only data[:i+1], which is untouched), so its signals over the
    first k bars must be identical. Anything that peeks forward sees a different
    world and flips.

    Perturbation beats plain truncation here, and the difference is not
    academic: a one-bar lookahead like `np.roll(close, -1)` only diverges at the
    single boundary index under truncation, where it has a ~50% chance of
    producing the same boolean by luck. Scaling the tail both up (100x) and down
    (0.01x) forces any real dependence to show. Keeping the array length fixed
    also removes length-related artifacts.

    Truncation is kept as a secondary pass because it additionally catches code
    whose behaviour depends on the series length itself.
    """
    n = ctx.n
    if n < 60:
        return [Diagnostic("L3", "warning", "too few bars to test causality reliably")]

    base = run(ctx)
    for frac in cuts:
        k = int(n * frac)
        if k < 30 or k >= n:
            continue
        for factor, label in ((0.01, "collapsed"), (100.0, "inflated")):
            try:
                alt = run(_perturb_future(ctx, k, factor))
            except Exception as e:      # noqa: BLE001
                return [Diagnostic("L3", "error",
                                   f"{type(e).__name__} when data after bar {k} was {label}: {e}. "
                                   f"The strategy behaves differently depending on future values.")]
            for name in ("entries", "exits"):
                a = np.asarray(getattr(base, name))[:k]
                b = np.asarray(getattr(alt, name))[:k]
                if a.shape != b.shape or not np.array_equal(a, b):
                    bad = int(np.argmax(a != b)) if a.shape == b.shape else k - 1
                    return [Diagnostic("L3", "error",
                                       f"lookahead bias: {name}[{bad}] changes when data AFTER bar {k} is "
                                       f"{label}. Bar {bad} is reading the future — check for negative shifts "
                                       f"(np.roll(x, -1), shift(-1)), whole-series max/min/mean/percentile, "
                                       f"reversed cumulative fills, or centered windows.")]

    # Secondary: does the answer depend on how much history exists at all?
    for frac in cuts:
        k = int(n * frac)
        if k < 30:
            continue
        try:
            pre = run(ctx.truncate(k))
        except Exception as e:          # noqa: BLE001
            return [Diagnostic("L3", "error",
                               f"{type(e).__name__} when run on the first {k} bars: {e}. The strategy "
                               f"depends on the series length — a hard-coded bar index, or an assumption "
                               f"about how much history exists.")]
        for name in ("entries", "exits"):
            a = np.asarray(getattr(base, name))[:k]
            b = np.asarray(getattr(pre, name))[:k]
            if a.shape != b.shape:
                return [Diagnostic("L3", "error", f"{name} changed length when run on the first {k} bars")]
            if not np.array_equal(a, b):
                bad = int(np.argmax(a != b))
                return [Diagnostic("L3", "error",
                                   f"lookahead bias: {name}[{bad}] changes when the strategy is only shown "
                                   f"the first {k} bars — it depends on data that had not happened yet.")]
    return []


def _warmup_check(sig, warmup) -> list[Diagnostic]:
    """No signal may fire before its indicators are warm — a 200-day SMA cannot
    legitimately trigger on bar 3.

    `warmup` is per-signal: {"entries": n, "exits": n}, or one int for both. The
    entry and exit blocks routinely use different indicators, and holding the
    exit block to the entry block's slowest warmup produces false failures.

    N bars of history means index N-1 is the first that can legitimately fire,
    so only indices 0..N-2 are checked.
    """
    if isinstance(warmup, dict):
        need = {"entries": int(warmup.get("entries", 0)), "exits": int(warmup.get("exits", 0))}
    else:
        need = {"entries": int(warmup or 0), "exits": int(warmup or 0)}
    out = []
    for name in ("entries", "exits"):
        w = need[name]
        if w <= 1:
            continue
        arr = np.asarray(getattr(sig, name), dtype=bool)
        head = arr[:max(0, min(w - 1, len(arr)))]
        if head.any():
            first = int(np.argmax(head))
            out.append(Diagnostic("L4", "error",
                                  f"{name} fires at bar {first}, before its {w}-bar indicator warmup "
                                  f"completes. The indicator is still NaN or seeded there."))
    return out


def _determinism_check(run: Callable, ctx) -> list[Diagnostic]:
    a, b = run(ctx), run(ctx)
    for name in ("entries", "exits"):
        if not np.array_equal(np.asarray(getattr(a, name)), np.asarray(getattr(b, name))):
            return [Diagnostic("L5", "error",
                               f"{name} differs between two identical runs — unseeded randomness makes "
                               f"backtests unreproducible")]
    return []


def _degeneracy_check(sig) -> list[Diagnostic]:
    out = []
    e = np.asarray(sig.entries, dtype=bool)
    x = np.asarray(sig.exits, dtype=bool)
    if not e.any():
        out.append(Diagnostic("L6", "warning", "entries never fire — this strategy never trades"))
    elif e.all():
        out.append(Diagnostic("L6", "warning", "entries fire on every bar — the entry rule is vacuous"))
    if e.any() and not x.any():
        out.append(Diagnostic("L6", "warning", "exits never fire — positions are never closed by signal"))
    return out


# ── entry point ──────────────────────────────────────────────────────────────

def validate_source(source: str, ctx=None, runner: Callable | None = None,
                    warmup=0, deep: bool = True) -> ValidationResult:
    """Run the layers in order, stopping at the first failing level.

    `runner(source, ctx) -> Signals` executes the code; injecting it keeps this
    module free of any opinion about *where* code runs, so the same validator
    covers the in-process fast path and the subprocess sandbox.
    """
    diags = _static_check(source)
    if any(d.severity == "error" for d in diags):
        return ValidationResult(False, diags)

    diags += _contract_check(source)
    if any(d.severity == "error" for d in diags):
        return ValidationResult(False, diags)

    if not deep or ctx is None or runner is None:
        return ValidationResult(True, diags)

    def run(c):
        return runner(source, c)

    try:
        sig = run(ctx)
    except Exception as e:                      # noqa: BLE001 — surfaced as a diagnostic
        diags.append(Diagnostic("L2", "error", f"{type(e).__name__} while running: {e}"))
        return ValidationResult(False, diags)

    shape = _shape_check(sig, ctx.n)
    if shape:
        return ValidationResult(False, diags + shape)

    # Determinism first: an unseeded strategy also fails the causality
    # comparison, and "lookahead bias" is the wrong thing to tell the user.
    for check in (lambda: _determinism_check(run, ctx),
                  lambda: _causality_check(run, ctx),
                  lambda: _warmup_check(sig, warmup)):
        found = check()
        diags += found
        if any(d.severity == "error" for d in found):
            return ValidationResult(False, diags)

    diags += _degeneracy_check(sig)
    return ValidationResult(True, diags)
