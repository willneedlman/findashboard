#!/usr/bin/env python3
"""
PreToolUse hook: fires before Edit/Write on frontend files.
Injects a compact ui-ux-pro-max reminder into context.
"""
import sys, json, subprocess

SEARCH_SCRIPT = "/Users/willneedlman/finance_dashboard/ui-ux-pro-max-skill/src/ui-ux-pro-max/scripts/search.py"


def is_frontend_file(path: str) -> bool:
    return "/frontend/src/" in path and path.endswith((".tsx", ".ts", ".css"))


def run_ux_check() -> str:
    try:
        r = subprocess.run(
            ["python3", SEARCH_SCRIPT, "spacing contrast readability accessibility", "--domain", "ux", "-n", "1"],
            capture_output=True, text=True, timeout=6,
        )
        lines = [l for l in r.stdout.strip().splitlines() if l.strip()]
        return " | ".join(lines[2:5]) if len(lines) >= 3 else (lines[0] if lines else "")
    except Exception:
        return ""


def main():
    try:
        inp = json.load(sys.stdin)
    except Exception:
        return

    path = inp.get("file_path", inp.get("path", ""))
    if not is_frontend_file(path):
        return

    hint = run_ux_check()
    print(f"[ui-ux] {hint}" if hint else "[ui-ux] frontend edit — consider /impeccable before finalizing")


if __name__ == "__main__":
    main()
