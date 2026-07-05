---
name: deploy
description: Ship finance_dashboard to production on Fly.io the project's way — rebuild the frontend dist, commit, deploy from the repo root, and verify prod. Invoke only when the user explicitly asks to deploy/ship/release.
disable-model-invocation: true
---

# Deploy to production (Fly.io)

Run this only when the user asks to deploy. It encodes the project's shipping ritual and its known footguns. Do each step in order and stop if a step fails.

## 0. Pre-flight
- Confirm the working tree is what the user wants shipped (`git status`). If there are unrelated changes, ask before bundling them.
- If any `frontend/src` files changed since the last `dist` build, the dist is stale — always rebuild in step 1.

## 1. Rebuild the frontend bundle
`frontend/dist` is committed and served by the backend, so it must be rebuilt before deploy or prod serves stale JS.
```bash
cd /Users/willneedlman/finance_dashboard/frontend && npm run build
```
This runs `tsc && vite build`; if typecheck or build fails, fix before continuing.

## 2. Commit
- Use the `/caveman-commit` skill for the message (Conventional Commits, terse).
- Two commits is the house pattern: one for the source change, then a separate `chore: rebuild dist` for the regenerated `frontend/dist`.
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
- Backend-only changes still need no dist rebuild, but running step 1 is harmless and keeps the two-commit pattern uniform. Skip step 1 only if you are certain no frontend source changed.
