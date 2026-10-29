# Baywatch Service OS — Backend (FastAPI)

REST + workflow API for the Baywatch bike-service-center system. Runs the full
job lifecycle (create → queue → assign → start/pause/resume/complete), the
drift-free bay timer, the 14-day recording subsystem with signed URLs, and
role-scoped data access for Master Admin / Admin / Worker / Customer.

It boots with **zero external services** (SQLite + in-memory timer) for local
dev, and scales to Postgres + Redis + MinIO + Celery via Docker Compose.

---

## Quick start (local, no Docker)

```bash
cd backend
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt          # or just the core deps for a fast start
cp .env.example .env
python run.py                            # → http://localhost:8000
```

Open **http://localhost:8000/docs** for interactive Swagger.

> Minimal core deps to just boot the API:
> `pip install fastapi uvicorn "sqlalchemy>=2" pydantic pydantic-settings "python-jose[cryptography]" passlib python-multipart`

### Seeded demo logins (`POST /api/v1/auth/login`)

| Role | username | password |
|---|---|---|
| Master Admin | `master` | `master123` |
| Admin (Chennai) | `admin` | `admin123` |
| Worker (EMP-802) | `worker` | `worker123` |
| Customer (CUST-001) | `customer` | `customer123` |

---

## Full stack (Docker Compose)

```bash
cd backend
cp .env.example .env
docker compose up --build
```

Brings up: FastAPI (`:8000`), Postgres (`:5432`), Redis (`:6379`),
MinIO (`:9000`, console `:9001`), a Celery worker, and Celery Beat.

With Postgres, generate the schema with Alembic instead of auto-create:

```bash
docker compose exec fastapi alembic revision --autogenerate -m "initial_schema"
docker compose exec fastapi alembic upgrade head
```

---

## What runs without extra services

| Feature | No services (dev) | Full stack |
|---|---|---|
| Auth, CRUD, queue, lifecycle | ✅ SQLite | ✅ Postgres |
| Bay timer — **persistent, survives restart** | ✅ **Redis (required)** | ✅ Redis |
| Recording metadata + **signed URLs** + status/expiry | ✅ | ✅ |
| Actual video capture (RTSP→MP4) | ⛔ needs FFmpeg + cameras | ✅ Celery + FFmpeg |
| File upload / signed download | ⛔ no-op | ✅ MinIO |
| Completion PDF render | ⛔ no-op | ✅ WeasyPrint |
| SMS / Email notifications | in-app only | ✅ MSG91 (India) / SendGrid |

The heavy libraries are imported lazily, so a missing system dependency never
prevents the API from booting — those endpoints simply degrade gracefully.

### Persistent bay timers (Redis)

The bay timer is the single source of truth for the whole job lifecycle, so its
state is **persisted to Redis** and survives a backend restart / crash / redeploy:

```bash
brew install redis && brew services start redis     # local (or use docker compose)
```

- State per bay (`service_session_id`, `job_card_id`, `worker_id`, `bay_id`,
  `estimated_duration`, `start_time`, `pause_time`, `accumulated_pause_duration`,
  `current_status`) is written on **every** START/PAUSE/RESUME/COMPLETE.
- On startup `timer.restore_all()` reloads active timers, **recalculates
  remaining + overtime** from the stored timestamps, and logs recovery
  (`Timer restored`, `Session restored`, `Remaining recalculated`,
  `Overtime recalculated`); `_reconcile_sessions()` re-syncs DB sessions +
  recordings.
- Redis holds **active** timers only — COMPLETE removes the key and the session
  is written permanently to Postgres.
- `GET /health` reports `timer_persistent` and `active_timers`.
- If Redis is unreachable the API still boots but logs a loud warning that timers
  are non-persistent (dev only) — start Redis for production.

---

## API surface (prefix `/api/v1`)

| Group | Routes | Guard |
|---|---|---|
| `auth` | `POST /login`, `POST /logout`, `GET /me` | public / any |
| `workers` | list · create · get · update · delete · `POST /{id}/photo` | Admin |
| `bays` | list · `POST /{id}/temp-assign` · `GET /{id}/current-worker` | Admin |
| `parts` | `POST /import-file` · files CRUD · parts CRUD/search · unit-conversion | Admin |
| `jobs` | `POST /manual` · `POST /extract-pdf` · `POST /save-to-queue` | Admin |
| `queue` | list(grouped) · get · delete · move · reassign · **assign** | Admin |
| `bay-dashboard` | live state · **start / pause / resume / complete** | Admin |
| `customer` | active-service · service-history · history/{id} · notifications | Customer (own only) |
| `reports` | worker-performance · work-completion · branch-summary | Admin / Master |
| `master` | branches · live-monitoring · global-analytics | Master |
| `system` | `GET /health`, `GET /` | public |

Every response uses the envelope `{ success, data, message }`.

---

## How the lifecycle is wired

```
POST /jobs/manual            → JobCard + JobQueue (queued)
POST /queue/{id}/assign      → workflow_engine.create_from_assign()
                                 → ServiceSession (SS-…), CameraSession, RecordingSession
POST /bay-dashboard/{bay}/start
        → workflow_engine.emit("JOB_STARTED")
            → timer.start()  (Redis or memory)
            → camera on · recording recording
            → customer notification (in-app + SMS/Email if configured)
…/pause …/resume             → emit JOB_PAUSED / JOB_RESUMED
…/complete
        → emit("JOB_COMPLETED")
            → timer.stop() · recording active (expiry = +14d, signed URL)
            → bay released · next queued job promoted
            → completion PDF (Celery) · final notification
```

`app/services/workflow_engine.py` is the single dispatcher — the server-side
mirror of the frontend `WorkflowEngine`.

---

## Project layout

```
backend/
├── app/
│   ├── main.py                # FastAPI app, routers, CORS, /health
│   ├── config.py              # env settings (pydantic-settings)
│   ├── database.py            # engine + session + Base
│   ├── seed.py                # demo data on first boot
│   ├── models/                # SQLAlchemy 2 ORM (one file per domain)
│   ├── schemas/               # Pydantic v2 request/response
│   ├── routers/               # one file per module (see table above)
│   ├── services/
│   │   └── workflow_engine.py # event-driven lifecycle
│   ├── utils/                 # auth, security, timer, recordings, storage,
│   │                          # ids, audit, file_parser, job_extractor,
│   │                          # pdf_generator, camera
│   └── tasks/                 # celery_app + recording/notification tasks
├── alembic/                   # migrations (env wired to models)
├── docker-compose.yml         # full stack
├── Dockerfile
├── requirements.txt
├── run.py                     # uvicorn launcher
└── .env.example
```

---

## Notes / next steps

- **Async**: the project uses sync SQLAlchemy for a zero-config run. To go
  async, swap `create_engine` → `create_async_engine` (asyncpg) and make the
  routers `async def`.
- **WebSockets**: the lifecycle already centralizes through the workflow
  engine; add `GET /ws/bay-dashboard|worker|customer` and broadcast on each
  `emit()` to push live timer ticks (replacing the frontend's `setInterval`).
- **Connecting the existing frontend**: replace the `localStorage` stores
  (`BayTimer`, `QueueStore`, `WorkflowEngine`) with `fetch()` calls to these
  endpoints, starting with the bay-dashboard timer.
