#!/usr/bin/env bash
# Gated deploy — runs the same checks as the CI gate, then ships to Fly.
# Use this instead of a bare `flyctl deploy` so a manual deploy from any branch
# can't bypass the test/typecheck/build gate. Run: bash deploy.sh
set -euo pipefail
cd "$(dirname "$0")"

echo "==> backend tests"
python3 -m pytest backend -q

echo "==> frontend typecheck"
npm --prefix frontend run typecheck

echo "==> frontend tests"
npm --prefix frontend run test

echo "==> frontend build"
npm --prefix frontend run build

echo "==> deploy to Fly"
fly deploy --config fly.toml --remote-only "$@"

echo "==> done"
