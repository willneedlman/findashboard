#!/bin/bash
# Alphatape Terminal — Full Reboot (kill, reinstall deps, restart)

set -e

ROOT="$(cd "$(dirname "$0")" && pwd)"

echo "Killing existing processes on ports 8000 and 5173..."
lsof -ti:8000 | xargs kill -9 2>/dev/null || true
lsof -ti:5173 | xargs kill -9 2>/dev/null || true
pkill -f "uvicorn main:app" 2>/dev/null || true
pkill -f "vite" 2>/dev/null || true

echo "Updating backend dependencies..."
cd "$ROOT/backend"
source "$ROOT/venv/bin/activate"
pip install -q -r requirements_api.txt

echo "Updating frontend dependencies..."
cd "$ROOT/frontend"
npm ci --silent

echo "Starting FastAPI backend on :8000"
cd "$ROOT/backend"
source "$ROOT/venv/bin/activate"
uvicorn main:app --reload --port 8000 &
BACKEND_PID=$!

echo "Waiting for backend to be ready..."
for i in {1..30}; do
    if curl -sf http://localhost:8000/api/health >/dev/null 2>&1; then
        echo "Backend ready"
        break
    fi
    sleep 1
done
if ! curl -sf http://localhost:8000/api/health >/dev/null 2>&1; then
    echo "Backend failed to start"
    kill $BACKEND_PID 2>/dev/null
    exit 1
fi

echo "Starting React frontend on :5173"
cd "$ROOT/frontend"
npm run dev &
FRONTEND_PID=$!

echo ""
echo "Alphatape Terminal rebooted:"
echo "  Frontend → http://localhost:5173"
echo "  API Docs → http://localhost:8000/docs"
echo ""
echo "Press Ctrl+C to stop both servers."

trap "kill $BACKEND_PID $FRONTEND_PID 2>/dev/null; exit 0" INT
wait