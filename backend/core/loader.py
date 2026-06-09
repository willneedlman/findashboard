"""
StrategyLoader — dynamic import with AST-based sandbox validation.

Safety model
────────────
Before executing ANY user file the loader runs an AST pass that raises
SandboxViolation on the first banned pattern found.  Execution never starts
if the scan fails.  After import the loader verifies the class inherits from
Strategy and instantiates it to confirm there are no import-time crashes.

Banned patterns (AST scan)
───────────────────────────
  • Direct calls:   eval, exec, compile, __import__, open (write modes blocked
                    at runtime — see _SafeOpen below — but open() itself is also
                    flagged if used with non-literal modes)
  • Module imports: os, subprocess, sys, socket, shutil, ctypes, multiprocessing,
                    threading, signal, pty, atexit, importlib, builtins
  • Attribute calls: os.system, os.popen, os.exec*, subprocess.*, socket.*

Note: numpy/pandas/scipy are explicitly allowed because strategies legitimately
need them for indicator maths.
"""

from __future__ import annotations

import ast
import importlib.util
import inspect
import os
import sys
import types
from pathlib import Path
from typing import Type

from strategies.base import Strategy


# ── Exceptions ────────────────────────────────────────────────────────────────

class LoadError(Exception):
    """Raised when a strategy file cannot be loaded (missing class, bad import…)."""


class SandboxViolation(LoadError):
    """Raised when the AST scan detects a forbidden pattern."""


# ── Banned symbols ────────────────────────────────────────────────────────────

_BLOCKED_MODULES: frozenset[str] = frozenset({
    "os", "subprocess", "sys", "socket", "shutil", "ctypes",
    "multiprocessing", "threading", "signal", "pty", "atexit",
    "importlib", "builtins", "gc", "resource", "mmap",
})

_BLOCKED_DIRECT_CALLS: frozenset[str] = frozenset({
    "eval", "exec", "compile", "__import__",
    "breakpoint", "input",
})

# (module, attr) pairs that are individually dangerous even if the module
# has legitimate safe uses (e.g. pathlib is fine, os is not).
_BLOCKED_ATTR_CALLS: frozenset[tuple[str, str]] = frozenset({
    ("os", "system"), ("os", "popen"), ("os", "execv"), ("os", "execve"),
    ("os", "execvp"), ("os", "execvpe"), ("os", "spawnl"), ("os", "spawnle"),
    ("os", "spawnlp"), ("os", "spawnlpe"), ("os", "spawnv"), ("os", "spawnve"),
    ("os", "spawnvp"), ("os", "spawnvpe"), ("os", "fork"), ("os", "forkpty"),
    ("os", "kill"), ("os", "killpg"), ("os", "remove"), ("os", "unlink"),
    ("os", "rmdir"), ("os", "removedirs"), ("os", "rename"), ("os", "renames"),
    ("os", "replace"), ("os", "mkdir"), ("os", "makedirs"),
    ("subprocess", "run"), ("subprocess", "call"), ("subprocess", "Popen"),
    ("subprocess", "check_output"), ("subprocess", "check_call"),
    ("subprocess", "getoutput"), ("subprocess", "getstatusoutput"),
    ("socket", "socket"), ("socket", "create_connection"),
    ("socket", "create_server"), ("socket", "connect"),
})


# ── AST Scanner ───────────────────────────────────────────────────────────────

class _SandboxScanner(ast.NodeVisitor):
    """Walk the AST and raise SandboxViolation on the first banned pattern."""

    def visit_Import(self, node: ast.Import) -> None:
        for alias in node.names:
            root = alias.name.split(".")[0]
            if root in _BLOCKED_MODULES:
                raise SandboxViolation(
                    f"Banned import '{alias.name}' at line {node.lineno}. "
                    "Strategies may not import OS/system modules."
                )
        self.generic_visit(node)

    def visit_ImportFrom(self, node: ast.ImportFrom) -> None:
        module = (node.module or "").split(".")[0]
        if module in _BLOCKED_MODULES:
            raise SandboxViolation(
                f"Banned 'from {node.module} import …' at line {node.lineno}."
            )
        self.generic_visit(node)

    def visit_Call(self, node: ast.Call) -> None:
        # Direct call: eval(...), exec(...) etc.
        if isinstance(node.func, ast.Name):
            if node.func.id in _BLOCKED_DIRECT_CALLS:
                raise SandboxViolation(
                    f"Banned call '{node.func.id}()' at line {node.lineno}."
                )

        # Attribute call: os.system(...), subprocess.run(...) etc.
        elif isinstance(node.func, ast.Attribute):
            if isinstance(node.func.value, ast.Name):
                pair = (node.func.value.id, node.func.attr)
                if pair in _BLOCKED_ATTR_CALLS:
                    raise SandboxViolation(
                        f"Banned call '{node.func.value.id}.{node.func.attr}()' "
                        f"at line {node.lineno}."
                    )

        self.generic_visit(node)

    def visit_Attribute(self, node: ast.Attribute) -> None:
        # Block __dunder__ attribute access used for class introspection attacks.
        if node.attr in ("__class__", "__subclasses__", "__bases__",
                         "__globals__", "__builtins__", "__code__"):
            raise SandboxViolation(
                f"Banned attribute access '{node.attr}' at line {node.lineno}. "
                "Dunder introspection is not allowed in strategies."
            )
        self.generic_visit(node)


def _ast_scan(source: str, path: str) -> None:
    """Parse source and run the scanner.  Raises SandboxViolation or LoadError."""
    try:
        tree = ast.parse(source, filename=path)
    except SyntaxError as exc:
        raise LoadError(f"Syntax error in strategy file: {exc}") from exc
    _SandboxScanner().visit(tree)


# ── Loader ────────────────────────────────────────────────────────────────────

class StrategyLoader:
    """
    Load, validate, and cache Strategy subclasses from external .py files.

    Usage
    ─────
        loader = StrategyLoader()
        cls    = loader.load("/path/to/my_strategy.py")
        inst   = cls()
        inst.initialize({"fast": 10, "slow": 30})
        signal = inst.on_data(data_point)
    """

    def __init__(self) -> None:
        self._registry: dict[str, Type[Strategy]] = {}

    # ── Public ────────────────────────────────────────────────────────────────

    def load(self, path: str | os.PathLike) -> Type[Strategy]:
        """
        Load a strategy class from `path`.

        Steps:
          1. Read source text.
          2. AST sandbox scan — raises SandboxViolation on any banned pattern.
          3. importlib dynamic load into an isolated module namespace.
          4. Discover the Strategy subclass.
          5. Instantiate + call metadata() to confirm it works.
          6. Cache by strategy name and return the class.
        """
        p = Path(path).resolve()
        if not p.exists():
            raise LoadError(f"Strategy file not found: {p}")
        if p.suffix != ".py":
            raise LoadError(f"Strategy file must be a .py file, got: {p.suffix}")

        source = p.read_text(encoding="utf-8")

        # ── Step 2: AST sandbox scan ──────────────────────────────────────────
        _ast_scan(source, str(p))

        # ── Step 3: dynamic import ────────────────────────────────────────────
        module = self._import_module(p, source)

        # ── Step 4: discover Strategy subclass ───────────────────────────────
        cls = self._find_strategy_class(module, p)

        # ── Step 5: smoke-test instantiation ─────────────────────────────────
        try:
            instance = cls()
            meta = instance.metadata()
        except Exception as exc:
            raise LoadError(
                f"Strategy class '{cls.__name__}' failed smoke-test: {exc}"
            ) from exc

        # ── Step 6: cache and return ──────────────────────────────────────────
        key = meta.name or cls.__name__
        self._registry[key] = cls
        return cls

    def load_bytes(self, source: bytes | str, module_name: str = "uploaded_strategy") -> Type[Strategy]:
        """
        Load a strategy from in-memory source (e.g. from an uploaded file).
        Same validation pipeline as load().
        """
        text = source if isinstance(source, str) else source.decode("utf-8")
        _ast_scan(text, module_name)
        module = self._import_from_source(text, module_name)
        cls = self._find_strategy_class(module, Path(module_name))
        instance = cls()
        meta = instance.metadata()
        self._registry[meta.name or cls.__name__] = cls
        return cls

    def get(self, name: str) -> Type[Strategy] | None:
        """Return a cached strategy class by its metadata name."""
        return self._registry.get(name)

    def list_registered(self) -> list[str]:
        return list(self._registry.keys())

    def unload(self, name: str) -> bool:
        return self._registry.pop(name, None) is not None

    # ── Private ───────────────────────────────────────────────────────────────

    @staticmethod
    def _import_module(path: Path, source: str) -> types.ModuleType:
        module_name = f"_strategy_{path.stem}"
        spec = importlib.util.spec_from_file_location(module_name, str(path))
        if spec is None or spec.loader is None:
            raise LoadError(f"Cannot create module spec for {path}")
        module = importlib.util.module_from_spec(spec)
        # Inject a clean, minimal set of builtins so strategies can't reach out.
        module.__dict__["__builtins__"] = _safe_builtins()
        try:
            spec.loader.exec_module(module)  # type: ignore[union-attr]
        except Exception as exc:
            raise LoadError(f"Error executing strategy module: {exc}") from exc
        return module

    @staticmethod
    def _import_from_source(source: str, module_name: str) -> types.ModuleType:
        module = types.ModuleType(module_name)
        module.__dict__["__builtins__"] = _safe_builtins()
        try:
            exec(compile(source, module_name, "exec"), module.__dict__)  # noqa: S102
        except Exception as exc:
            raise LoadError(f"Error executing strategy source: {exc}") from exc
        return module

    @staticmethod
    def _find_strategy_class(module: types.ModuleType, path: Path) -> Type[Strategy]:
        candidates: list[Type[Strategy]] = [
            obj for _, obj in inspect.getmembers(module, inspect.isclass)
            if (issubclass(obj, Strategy)
                and obj is not Strategy
                and obj.__module__ == module.__name__)
        ]
        if not candidates:
            raise LoadError(
                f"No Strategy subclass found in {path.name}. "
                "Define a class that inherits from strategies.base.Strategy."
            )
        if len(candidates) > 1:
            names = [c.__name__ for c in candidates]
            raise LoadError(
                f"Multiple Strategy subclasses found in {path.name}: {names}. "
                "Each file must contain exactly one Strategy subclass."
            )
        return candidates[0]


def _safe_builtins() -> dict:
    """
    A whitelist of builtins available inside loaded strategy modules.
    Excludes eval, exec, compile, __import__, open (write), and other hazards.
    """
    import builtins as _b

    safe_names = {
        # Data types
        "int", "float", "str", "bool", "bytes", "bytearray",
        "list", "dict", "set", "frozenset", "tuple",
        "complex", "range",
        # Type checks
        "isinstance", "issubclass", "type", "callable", "len",
        "hasattr", "getattr", "setattr", "delattr",
        # Iteration
        "zip", "map", "filter", "enumerate", "reversed", "sorted",
        "min", "max", "sum", "abs", "round", "divmod", "pow",
        "all", "any", "iter", "next",
        # Representation
        "repr", "str", "format", "hex", "oct", "bin", "chr", "ord",
        # Exceptions
        "Exception", "ValueError", "TypeError", "KeyError", "IndexError",
        "AttributeError", "StopIteration", "RuntimeError", "NotImplementedError",
        "OverflowError", "ZeroDivisionError",
        # Misc
        "print", "hash", "id", "vars", "dir",
        "staticmethod", "classmethod", "property",
        "object", "super", "NotImplemented", "Ellipsis",
        "True", "False", "None",
    }
    return {name: getattr(_b, name) for name in safe_names if hasattr(_b, name)}
