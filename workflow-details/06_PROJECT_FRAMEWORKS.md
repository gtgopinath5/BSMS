# 06 — Project Frameworks & Libraries (complete inventory)

> Every framework/library **actually used** in this repository, with where and why.
> Sources: [backend/requirements.txt](../backend/requirements.txt),
> [frontend/index.html](../frontend/index.html) (CDN scripts),
> [firmware/esp32_bay_timer/platformio.ini](../firmware/esp32_bay_timer/platformio.ini),
> [backend/docker-compose.yml](../backend/docker-compose.yml).
> ⚠️ Honesty note: this project does **not** use Vite, Tailwind, OpenCV (declared but
> unused), APScheduler, or a server-side ONVIF library — see "Explicitly NOT used" at
> the end so nobody hunts for things that aren't there.

---

## Frontend

| Framework | Version / source | Why · where · how |
|---|---|---|
| **React 18** | 18.3.1 UMD from unpkg ([index.html:11](../frontend/index.html)) | The whole UI. Components live on `window` (no modules). Triggered by every page render; state holds API data. Connects to PostgreSQL **only through the backend API**. |
| **ReactDOM 18** | UMD | `ReactDOM.createRoot(...).render(<App/>)` in [app.jsx](../frontend/app.jsx). |
| **Babel Standalone** | 7.29.0 | Compiles `<script type="text/babel">` JSX **in the browser** — that's why there is no build step. |
| **jsPDF** | 2.5.1 (cdnjs) | Client-side PDF generation — the Completion PDF (`wapCompletionPdf` in [live/live.jsx](../frontend/live/live.jsx)) with the Service Recording section. |
| **pdf.js** | 3.11.174 (cdnjs) | In-browser PDF text extraction for the demo job-intake flow ([features/jobintake.jsx](../frontend/features/jobintake.jsx)) and client-side parts-file parsing. |
| **tesseract.js** | 5.1.0 (jsdelivr) | In-browser OCR fallback for scanned job-card PDFs (demo intake path). |
| **SheetJS (xlsx)** | 0.20.3 (sheetjs CDN) | Client-side Excel parsing for Parts Time imports → rows sent to `POST /api/v1/parts/import-rows` (large-file safe). |
| **WebSocket API + fetch** | browser built-ins | `useBWSocket` / `BW_API` in [js/api.js](../frontend/js/api.js) — real-time push + REST. |
| **Plain CSS** | [frontend/css/](../frontend/css/) (styles/admin/responsive) | All styling; no CSS framework. |
| **Python http.server** | stdlib | [frontend/serve.py](../frontend/serve.py) — static dev server, port 7890, no-cache headers. |

## Backend (core)

| Framework | Version | Why · where · how |
|---|---|---|
| **FastAPI** | 0.115.6 | The API framework — every router in [backend/app/routers/](../backend/app/routers/); dependency-injected auth guards; WebSocket endpoints; lifespan startup. |
| **Uvicorn** | 0.34.0 (`[standard]`) | ASGI server, port 8000 ([run.py](../backend/run.py)). |
| **SQLAlchemy** | 2.0.36 | ORM for all 17 tables ([models/](../backend/app/models/)); sync engine works with Postgres or SQLite unchanged ([database.py](../backend/app/database.py)). |
| **Pydantic** | 2.10.4 | Request/response schemas ([schemas/](../backend/app/schemas/)) + validation (422 envelope). |
| **pydantic-settings** | 2.7.1 | [config.py](../backend/app/config.py) — typed settings from `.env`. |
| **python-jose** | 3.3.0 | JWT encode/decode (HS256) in [utils/auth.py](../backend/app/utils/auth.py) and WS auth ([routers/ws.py](../backend/app/routers/ws.py)). |
| **passlib** | 1.7.4 | Password hashing, `pbkdf2_sha256` ([utils/security.py](../backend/app/utils/security.py)). |
| **python-multipart** | 0.0.20 | File uploads (job-card PDF, parts files, worker photo). |

## Database / cache

| Framework | Version | Why · where |
|---|---|---|
| **PostgreSQL** | 16 (Homebrew / docker `postgres:16-alpine`) | The permanent store. Setup: [setup_postgres.sh](../backend/setup_postgres.sh). |
| **psycopg** | 3.2.3 `[binary]` | Postgres driver (`postgresql+psycopg://`). |
| **redis (client)** | 5.2.1 → Redis 7 server | Persistent bay timers ([utils/timer.py](../backend/app/utils/timer.py)) — keys `bay_timer:*`. Memory fallback when down. |
| **Alembic** | 1.14.0 | Migration scaffolding ([alembic/](../backend/alembic/), [alembic.ini](../backend/alembic.ini)); dev currently uses `create_all` + `ensure_*_schema()` column adds. |

## Recording / streaming / video

| Framework | Where | Why · how |
|---|---|---|
| **FFmpeg** (system binary) | [services/recording_service.py](../backend/app/services/recording_service.py) (`shutil.which("ffmpeg")`) | The entire capture pipeline: RTSP → segmented MPEG-TS (`-c:v copy`) + live HLS; concat → `video.mp4 +faststart`; `ffprobe` for duration. Triggered by workflow START/PAUSE/RESUME/COMPLETE. Output → local SSD → metadata in `recording_sessions`. |
| **RTSP** (protocol) | camera_service → FFmpeg `-rtsp_transport tcp` | How CP Plus cameras are consumed. URL + credentials from `bay_cameras`; never exposed to browsers. |
| **HLS** (protocol) | recording_service (writer) · [streaming_service.py](../backend/app/services/streaming_service.py) + [routers/streaming.py](../backend/app/routers/streaming.py) (server) | Live in-browser viewing behind HMAC-signed, session-scoped URLs (`/hls/secure/{SS}/stream.m3u8`). |
| **HTTP Range / `<video>`** | [routers/recordings.py](../backend/app/routers/recordings.py) `_range_response` | Seekable MP4 playback (206 Partial Content) for recorded videos. |
| **opencv-python-headless** | 4.10.0.84 — in requirements only | Declared for future frame work; **no `cv2` import in current code** (capture is pure FFmpeg). |

## Google Drive / object storage

| Framework | Where | Why · how |
|---|---|---|
| **google-api-python-client + google-auth** (imported lazily) | [services/drive_service.py](../backend/app/services/drive_service.py) | Real Drive API v3 via a **service account**: resumable `files().create`, size verification, `permissions().create(anyone,reader)`, `files().delete`, `about().get` health probe. Activated by `GOOGLE_DRIVE_CREDENTIALS` + `GOOGLE_DRIVE_FOLDER_ID`. |
| **boto3** | 1.35.92 — [utils/storage.py](../backend/app/utils/storage.py) | MinIO/S3 wrapper (profile photos, completion PDFs, legacy recording path). Optional; no-ops without a server. |
| **MinIO** | docker-compose service (:9000/:9001) | S3-compatible dev object store. |

## MQTT / devices

| Framework | Where | Why · how |
|---|---|---|
| **paho-mqtt** | 2.1.0 — [services/mqtt_service.py](../backend/app/services/mqtt_service.py) | Backend MQTT client: 1 s retained state publisher + lifecycle events to `bay/{n}/*`; subscribes to `telemetry`/`hello`. |
| **Mosquitto** | external broker (`MQTT_BROKER_HOST:1883`) | The message bus between backend and ESP32 timers. |
| **ESP32 + Arduino (PlatformIO)** | [firmware/esp32_bay_timer/](../firmware/esp32_bay_timer/) | The physical timer. Libs: **PubSubClient** (MQTT), **ArduinoJson** (state payload), **Adafruit NeoPixel** (WS2812 colour ring), **TM1637** (4-digit display). |

## PDF / OCR / data extraction (backend)

| Framework | Version | Why · where |
|---|---|---|
| **pdfplumber** | 0.11.4 | Job-card PDF text extraction ([utils/job_extractor.py](../backend/app/utils/job_extractor.py)) feeding the template parser [utils/triumph_parser.py](../backend/app/utils/triumph_parser.py). |
| **pymupdf** | 1.25.1 | Fast PDF parsing for parts files ([utils/file_parser.py](../backend/app/utils/file_parser.py)). |
| **pytesseract** | 0.3.13 | OCR fallback for scanned documents (needs system `tesseract`). |
| **openpyxl** | 3.1.5 | Server-side Excel import (`POST /parts/import-file`, legacy/small files). |
| **WeasyPrint** | 63.1 | Server-side HTML→PDF completion report ([utils/pdf_generator.py](../backend/app/utils/pdf_generator.py)); lazy import — boots without cairo/pango. |

## Background work / scheduling

| Framework | Where | Why · honest status |
|---|---|---|
| **threading (stdlib daemon threads)** | scheduler_service (`bw-scheduler`, 6 h sweeps), mqtt_service (`bw-mqtt-state`, 1 s), recording watchdog | **The actual production scheduler in this codebase** — not APScheduler. |
| **Celery** | 5.4.0 — [tasks/](../backend/app/tasks/) ([celery_app.py](../backend/app/tasks/celery_app.py)) | Optional worker for the completion-PDF task and a legacy daily expiry beat. The API runs fine without a worker (calls are wrapped in try/except no-ops). Recording capture **no longer** depends on Celery. |
| **Redis (broker)** | db 1 (`CELERY_BROKER_URL`) | Celery transport when a worker runs. |

## Notifications

| Framework | Where | Why · honest status |
|---|---|---|
| **MSG91** (HTTP API, no SDK) | [tasks/notification_tasks.py](../backend/app/tasks/notification_tasks.py) | Real SMS for India: v5 Flow API (DLT template) or legacy sendhttp; numbers normalised to `91XXXXXXXXXX`. Active when `MSG91_AUTH_KEY` is set. |
| **SendGrid** | 6.11.0 | Email hook exists but the actual send call is **commented out** (stub). In-app notifications (DB) always work. |
| **httpx** | 0.28.1 | HTTP client dependency (available for integrations). |

## Auth / security

| Mechanism | Where |
|---|---|
| **JWT (HS256)** | login → token; REST via `Authorization: Bearer`; WS via `?token=`; role guards `require_master/admin/worker/customer`. |
| **HMAC-SHA256 signed URLs** | live HLS ([streaming_service.py](../backend/app/services/streaming_service.py), TTL 1 h) and recording playback ([utils/recordings.py](../backend/app/utils/recordings.py), TTL 2 h capped at expiry) — keyed on `JWT_SECRET`. |
| **sessionStorage per-tab auth** | [js/api.js](../frontend/js/api.js) — prevents cross-role token contamination between tabs. |
| **CORS allow-list** | `CORS_ORIGINS` in .env; CORS middleware kept outermost so even 500s carry CORS headers. |

## Infrastructure

| Tool | Where | Why |
|---|---|---|
| **Docker Compose** | [backend/docker-compose.yml](../backend/docker-compose.yml) | One-command stack: fastapi + postgres + redis + minio + celery worker + celery beat. |
| **Homebrew Postgres setup** | [setup_postgres.sh](../backend/setup_postgres.sh) | Native macOS dev path (the active one per .env). |

## Explicitly NOT used (despite appearing in specs/asks)

| Name | Reality in this repo |
|---|---|
| **Vite / Tailwind** | No bundler, no CSS framework — Babel Standalone + hand-written CSS. |
| **APScheduler** | Scheduling is stdlib daemon threads (+optional Celery beat for one legacy task). |
| **ONVIF library** | Only an `onvif_port` column is stored; no ONVIF calls are made (probe is simulated in dev). |
| **OpenCV** | In requirements, never imported — FFmpeg subprocesses do all video work. |
| **pdfjs-dist (npm)** | The CDN build of pdf.js is used instead (no npm at all — `package-lock.json` is vestigial). |
| **WebRTC** | Planned upgrade (stage 8); today's live transport is signed HLS. |
