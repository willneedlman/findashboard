# ── Stage 1: Build React frontend ───────────────────────────────────────────
FROM node:20-alpine AS frontend-build
WORKDIR /frontend
COPY frontend/package*.json ./
RUN npm ci --legacy-peer-deps
COPY frontend/ .
RUN npm run build

# ── Stage 2: Python backend ──────────────────────────────────────────────────
FROM python:3.11-slim
WORKDIR /app

# Install system deps
RUN apt-get update && apt-get install -y --no-install-recommends \
    gcc g++ curl \
    && rm -rf /var/lib/apt/lists/*

# Set Python environment to find modules in /app/backend
ENV PYTHONPATH=/app/backend

# Python dependencies
COPY backend/requirements_api.txt .
RUN pip install --no-cache-dir -r requirements_api.txt

# Copy backend files specifically into the backend directory
COPY backend/ /app/backend/

# Bundled read-only logistics datasets. Keep the local full-build backup and
# caches out of the image, but include the compact serving stores.
COPY data/veridion_nodes.db /app/data/veridion_nodes.db
COPY data/port_performance.db /app/data/port_performance.db
COPY data/renthub_snapshot.db /app/data/renthub_snapshot.db
COPY data/consumer_spend.db /app/data/consumer_spend.db

# Built React app
COPY --from=frontend-build /frontend/dist /app/frontend/dist

# Create cache dir
RUN mkdir -p /app/backend/.cache

ENV FRONTEND_DIST=/app/frontend/dist
ENV PORT=8080

EXPOSE 8080

# Run uvicorn from the root, pointing to the app in backend/main
CMD ["uvicorn", "backend.main:app", "--host", "0.0.0.0", "--port", "8080"]
