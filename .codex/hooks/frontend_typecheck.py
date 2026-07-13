#!/usr/bin/env python3
"""
Stop hook: after a turn that touched frontend TypeScript, run `tsc --noEmit` and
surface any type errors so they are caught before commit/deploy. Advisory only
(never blocks); no-ops when the working tree has no frontend/src TS changes, so
backend-only turns pay nothing.
"""
import os, sys, json, subprocess

ROOT = os.environ.get("CLAUDE_PROJECT_DIR") or os.path.dirname(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
)


def frontend_ts_changed() -> bool:
    try:
        r = subprocess.run(
            ["git", "-C", ROOT, "diff", "--name-only", "HEAD"],
            capture_output=True, text=True, timeout=8,
        )
        files = r.stdout.splitlines()
        return any(f.startswith("frontend/src/") and f.endswith((".ts", ".tsx")) for f in files)
    except Exception:
        return False


def main():
    try:
        json.load(sys.stdin)  # drain hook payload; content unused
    except Exception:
        pass

    if not frontend_ts_changed():
        return

    try:
        r = subprocess.run(
            ["npm", "run", "typecheck", "--silent"],
            cwd=os.path.join(ROOT, "frontend"),
            capture_output=True, text=True, timeout=120,
        )
    except Exception:
        return

    if r.returncode != 0:
        errs = [l for l in (r.stdout + r.stderr).splitlines() if "error TS" in l]
        head = "; ".join(errs[:3]) if errs else "tsc reported errors"
        more = f" (+{len(errs) - 3} more)" if len(errs) > 3 else ""
        print(f"[typecheck] frontend tsc failed: {head}{more} — run `npm run typecheck` in frontend/")


if __name__ == "__main__":
    main()
