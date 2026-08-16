---
name: deploy
description: Ship finance_dashboard to production on Fly.io the project's way — verify the build, commit, deploy from the repo root, and verify prod. Invoke only when the user explicitly asks to deploy/ship/release.
---

# Deploy to production (Fly.io)

Run this only when the user asks to deploy. It encodes the project's shipping ritual and its known footguns. Do each step in order and stop if a step fails.

## 0. Pre-flight
- Confirm the working tree is what the user wants shipped (`git status`). If there are unrelated changes, ask before bundling them.
- If any `frontend/src` files changed since the last `dist` build, the dist is stale — always rebuild in step 1.

### 0b. Compile the backend on PRODUCTION's Python — not the local one
The image is `python:3.11-slim`. The local venv is 3.13, and newer syntax it
accepts is a `SyntaxError` under 3.11: on 2026-08-16 a PEP 701 f-string (a call
spanning newlines inside an `f"..."` expression) passed every one of 1185 tests,
built clean, and then made `main.py` unable to import `routers.ai` at all —
uvicorn exited, the machine hit its restart limit, and the site went down.

`ast.parse(..., feature_version=(3, 11))` does NOT catch this; it was tried and
it accepted the broken code, because `feature_version` does not downgrade the
tokenizer. Compile with a real 3.11 interpreter:

```bash
cd /Users/willneedlman/finance_dashboard/backend && uv run --python 3.11 --no-project python - <<'PY'
import pathlib, py_compile, tempfile
bad = []
for p in sorted(pathlib.Path('.').rglob('*.py')):
    if any(x in p.parts for x in ('venv', '__pycache__', 'node_modules')):
        continue
    try:
        py_compile.compile(str(p), cfile=tempfile.mktemp(), doraise=True)
    except py_compile.PyCompileError as e:
        bad.append(str(e).strip().splitlines()[-1])
print("\n".join(bad) if bad else "every file compiles on Python 3.11")
PY
```

Stop if anything fails. `uv python install 3.11` if the interpreter is missing.

## 1. Verify the frontend builds
The Dockerfile builds the bundle inside the image (`RUN npm run build`, then
`COPY --from=frontend-build /frontend/dist`), and `frontend/dist/` is gitignored
and untracked. So there is no dist to commit and no stale-JS risk from skipping
it — but a build that fails here fails the deploy several minutes later, so
prove it locally first.
```bash
cd /Users/willneedlman/finance_dashboard/frontend && npm run build
```
This runs `tsc && vite build`; if typecheck or build fails, fix before continuing.

## 2. Commit
- Use the `/caveman-commit` skill for the message (Conventional Commits, terse).
- One commit per change. The old two-commit pattern existed for a committed
  `frontend/dist` that no longer exists.
- Only branch off `main` if currently on it; normal work lands on the active feature branch (e.g. `all-features`). End commit bodies with the `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>` trailer.

## 3. Deploy
CRITICAL: `flyctl deploy` must run from the repo root — absolute `--config` / `--dockerfile` flags do NOT fix a broken build context.
```bash
cd /Users/willneedlman/finance_dashboard && flyctl deploy
```
Run it in the background and wait for completion. Expect a transient `408` that Fly retries and a brief "not listening on 8080" warning while uvicorn boots — both are benign if health checks pass. The VM is pinned to 1GB (`fly.toml`); a build/boot OOM points at a memory regression, not a deploy flake.

## 4. Verify prod
Confirm the release actually serves before calling it done:
```bash
curl -s -o /dev/null -w "root: %{http_code}\n" --max-time 15 https://finance-terminal.fly.dev/
```
Then curl one or two endpoints relevant to what shipped (e.g. a changed `/api/...` route) and confirm real data, not the SPA `index.html` fallback. Report the deploy result and the verified status codes.

## Notes
- `gh` is not installed; open PRs via the web compare URL if needed. This skill deploys the current branch's build directly to Fly and does not require a PR.
- Backend-only changes can skip step 1 entirely: nothing about the frontend
  bundle is committed, and the image rebuilds it either way.
