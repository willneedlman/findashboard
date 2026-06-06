#!/bin/bash
# Finance Terminal — start backend + frontend

# Check Node
if ! command -v node &> /dev/null; then
  echo "⚠ Node.js not found. Install via: brew install node"
  echo "  or: curl -fsSL https://fnm.vercel.app/install | bash && fnm install 20"
  exit 1
fi

ROOT="$(cd "$(dirname "$0")" && pwd)"

echo "→ Starting FastAPI backend on :8000"
cd "$ROOT/backend"
source "$ROOT/venv/bin/activate"
uvicorn main:app --reload --port 8000 &
BACKEND_PID=$!

echo "→ Starting React frontend on :5173"
cd "$ROOT/frontend"
npm install --silent
npm run dev &
FRONTEND_PID=$!

echo "✓ Finance Terminal running:"
echo "  Frontend → http://localhost:5173"
echo "  API Docs → http://localhost:8000/docs"
echo ""
echo "Press Ctrl+C to stop both servers."

trap "kill $BACKEND_PID $FRONTEND_PID 2>/dev/null; exit 0" INT
wait
