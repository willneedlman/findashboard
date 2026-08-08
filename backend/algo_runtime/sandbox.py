"""Execution engine: run one `signal()` under hard limits.

Prod is a shared-cpu-1x:1024MB Fly VM with a ~390MB baseline, so exec()ing
generated code in the API process is both an OOM risk and a security hole in the
process holding the DB handles. Code runs in a forked child with rlimits and a
wall-clock backstop instead.

Threat model note: the real boundary is the AST allowlist in validate.py, not
this file. With imports banned and a namespace of {np, ind, Signals} there is no
`os`, no `socket`, no `subprocess` to reach — a pure array->array contract makes
exfiltration structurally impossible rather than blocklist-dependent. The rlimits
here bound *accidents* (a runaway loop, a 10GB allocation) and add a second
layer against a validator bypass.

A container per run (Fly Machines) is the next rung, and is worth it only if
imports or user-supplied data are ever allowed. It is not worth ~2s of spin-up
per backtest today.
"""
from __future__ import annotations

import multiprocessing as mp
import os
import resource
import sys
import traceback

import numpy as np

from .contract import Ctx, Signals
from .validate import SAFE_BUILTINS

MEM_LIMIT_BYTES = 384 << 20      # child dies before the 1GB VM does
CPU_LIMIT_SECONDS = 10           # SIGXCPU
WALL_TIMEOUT_SECONDS = 20        # parent-side backstop for a blocked child
_LINUX = sys.platform.startswith("linux")


class SandboxError(Exception):
    pass


def _context():
    """forkserver first.

    Plain fork() copies only the calling thread, so forking from a
    multi-threaded process (uvicorn holds a thread pool) can leave the child
    holding a lock no surviving thread will release — a deadlock that shows up
    as a mysterious timeout under load and never in a single-threaded test.
    forkserver forks from a clean single-threaded helper instead. Ctx is
    pickled rather than inherited, which costs nothing: a few hundred KB of
    float arrays.
    """
    for method in ("forkserver", "fork"):
        try:
            return mp.get_context(method)
        except ValueError:
            continue
    raise SandboxError("sandbox requires a POSIX platform (fork or forkserver)")


def _namespace() -> dict:
    from . import indicators as ind
    return {"np": np, "ind": ind, "Signals": Signals, "__builtins__": SAFE_BUILTINS}


def _apply_limits() -> None:
    # RLIMIT_AS is unreliable on macOS: numpy reserves large virtual address
    # ranges up front, so an address-space cap kills honest code. Enforced on
    # Linux (prod); on dev the wall-clock timeout is the backstop.
    if _LINUX:
        try:
            resource.setrlimit(resource.RLIMIT_AS, (MEM_LIMIT_BYTES, MEM_LIMIT_BYTES))
        except (ValueError, OSError):
            pass
    for res, val in ((resource.RLIMIT_CPU, CPU_LIMIT_SECONDS),
                     (resource.RLIMIT_CORE, 0),
                     (resource.RLIMIT_NPROC, 0)):
        try:
            resource.setrlimit(res, (val, val))
        except (ValueError, OSError):
            pass
    try:
        os.setsid()      # detach so a stray child cannot signal the API process
    except OSError:
        pass


def _child(source: str, ctx: Ctx, conn) -> None:
    _apply_limits()
    try:
        ns = _namespace()
        exec(compile(source, "<strategy>", "exec"), ns)
        fn = ns.get("signal")
        if fn is None:
            raise SandboxError("no `signal` function defined")
        sig = fn(ctx)
        # Sent WITHOUT dtype coercion. Casting a float return to bool here would
        # launder a contract violation into an all-True signal that trades every
        # bar, and validate._shape_check would never see it.
        size = getattr(sig, "size", None)
        conn.send(("ok", np.asarray(sig.entries), np.asarray(sig.exits),
                   None if size is None else np.asarray(size, dtype=float)))
    except BaseException as e:                      # noqa: BLE001 — reported, not raised
        tb = traceback.format_exc(limit=3)
        conn.send(("err", f"{type(e).__name__}: {e}", tb))
    finally:
        conn.close()


def run_signal(source: str, ctx: Ctx, timeout: float = WALL_TIMEOUT_SECONDS,
               in_process: bool = False) -> Signals:
    """Execute `source` against `ctx` and return its Signals.

    in_process=True skips the fork. It exists ONLY for trusted, already-validated
    compiler output inside the test suite — never for model-authored code.
    """
    if in_process:
        ns = _namespace()
        exec(compile(source, "<strategy>", "exec"), ns)
        fn = ns.get("signal")
        if fn is None:
            raise SandboxError("no `signal` function defined")
        sig = fn(ctx)
        size = getattr(sig, "size", None)
        return Signals(np.asarray(sig.entries), np.asarray(sig.exits),
                       None if size is None else np.asarray(size, dtype=float))

    mpc = _context()

    parent_conn, child_conn = mpc.Pipe(duplex=False)
    proc = mpc.Process(target=_child, args=(source, ctx, child_conn), daemon=True)
    proc.start()
    child_conn.close()

    payload = None
    try:
        if parent_conn.poll(timeout):
            payload = parent_conn.recv()
    except EOFError:
        payload = None
    finally:
        proc.join(timeout=0.5)
        if proc.is_alive():
            proc.terminate()
            proc.join(timeout=0.5)
            if proc.is_alive():
                proc.kill()
        parent_conn.close()

    if payload is None:
        code = proc.exitcode
        if code is not None and code < 0:
            raise SandboxError(
                f"strategy killed by signal {-code} — likely the {CPU_LIMIT_SECONDS}s CPU "
                f"or {MEM_LIMIT_BYTES >> 20}MB memory limit")
        raise SandboxError(f"strategy timed out after {timeout}s")

    if payload[0] == "err":
        raise SandboxError(payload[1])
    return Signals(payload[1], payload[2], payload[3] if len(payload) > 3 else None)


def make_runner(in_process: bool = False):
    """A `runner(source, ctx) -> Signals` for validate.validate_source."""
    def _runner(source: str, ctx: Ctx) -> Signals:
        return run_signal(source, ctx, in_process=in_process)
    return _runner
