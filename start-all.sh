#!/bin/bash
# start-all.sh - Start both frontend and backend services for the finance dashboard

set -e

BACKEND_PID=0
FRONTEND_PID=0

cleanup() {
  echo "Stopping services..."
  kill $BACKEND_PID 2>/dev/null
  kill $FRONTEND_PID 2>/dev/null
  wait $BACKEND_PID 2>/dev/null
  wait $FRONTEND_PID 2>/dev/null
}

trap cleanup EXIT INT TERM

# Start backend
echo "Starting backend on http://localhost:8000"
(cd /Users/willneedlman/finance_dashboard && source venv/bin/activate && PYTHONPATH=/Users/willneedlman/finance_dashboard/backend python -m uvicorn backend.main:app --host 0.0.0.0 --port 8000 --reload) &
BACKEND_PID=$!
echo "Backend started with PID $BACKEND_PID"

# Start frontend
echo "Starting frontend on http://localhost:5173"
(cd /Users/willneedlman/finance_dashboard/frontend && npm run dev) &
FRONTEND_PID=$!
echo "Frontend started with PID $FRONTEND_PID"

# Wait for either process to finish
wait -n