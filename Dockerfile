# ── Stage 1: Build React frontend ───────────────────────────────────────────
FROM node:20-alpine AS frontend-build
WORKDIR /frontend
COPY frontend/package*.json ./
RUN npm ci --legacy-peer-deps
COPY frontend/ .
RUN npm run build

# ── Stage 2: Python backend ──────────────────────────────────────────────────
FROM python:3.11-slim
WORKDIR /app/backend

# Install system deps (needed by some yfinance/scipy transitive deps)
RUN apt-get update && apt-get install -y --no-install-recommends \
    gcc g++ curl \
    && rm -rf /var/lib/apt/lists/*

# Python dependencies
COPY backend/requirements_api.txt .
RUN pip install --no-cache-dir -r requirements_api.txt

# Application code
COPY backend/ .

# Built React app
COPY --from=frontend-build /frontend/dist /app/frontend/dist

# Create cache dir
RUN mkdir -p /app/backend/.cache

ENV FRONTEND_DIST=/app/frontend/dist
ENV PORT=8080

EXPOSE 8080

CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8080"]
