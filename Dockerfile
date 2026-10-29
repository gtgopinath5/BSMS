# ============================================================
#  Baywatch Service OS — single-service image.
#
#  Serves the frontend AND the API from ONE origin, so a deployment needs no
#  CORS configuration and the customer watch/approval pages stay same-origin
#  (exactly as they are in dev).
#
#  The image mirrors the repo layout — /app/backend + /app/frontend — because
#  the backend resolves the frontend and the customer pages by relative path.
#
#  Build:  docker build -t baywatch .
#  Run:    see docker-compose.demo.yml (app + postgres + redis)
#
#  backend/Dockerfile remains the API-only image for a split deployment.
# ============================================================

# ── Stage 1: compile the JSX (Babel CLI → frontend/.compiled) ──
FROM node:22-slim AS web
WORKDIR /build
COPY frontend/package.json frontend/package-lock.json frontend/.babelrc.json ./
RUN npm ci --no-audit --no-fund
COPY frontend/ ./
RUN npm run build && test -f .compiled/app.js

# ── Stage 2: the runtime ──
FROM python:3.12-slim

# System deps: ffmpeg (RTSP capture + live HLS), tesseract (OCR fallback),
# cairo/pango (WeasyPrint HTML→PDF). Same set as backend/Dockerfile.
RUN apt-get update && apt-get install -y --no-install-recommends \
      ffmpeg tesseract-ocr libcairo2 libpango-1.0-0 libpangocairo-1.0-0 \
      libgdk-pixbuf-2.0-0 libffi-dev curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app/backend
COPY backend/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY backend/ /app/backend/
COPY frontend/ /app/frontend/
# the compiled bundle from stage 1 (frontend/.compiled is gitignored, so it is
# always built here rather than copied from the host)
COPY --from=web /build/.compiled /app/frontend/.compiled

# Recording / intake / barricade media. Mount a volume here to persist it;
# the path is honoured by every media pipeline via BW_MEDIA_ROOT.
ENV BW_MEDIA_ROOT=/app/media
RUN mkdir -p /app/media

EXPOSE 8000

# /ready (not /health) is the gate: it 503s unless the DB is reachable AND the
# media root is writable, which is exactly what "can serve traffic" means here.
HEALTHCHECK --interval=15s --timeout=5s --start-period=40s --retries=5 \
  CMD curl -fsS http://localhost:8000/ready >/dev/null || exit 1

# Single web worker: bay timers, the MQTT publisher and the retention scheduler
# are per-process. Multiple workers would duplicate them — see DEPLOYMENT_RUNBOOK.md.
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000", "--workers", "1"]
