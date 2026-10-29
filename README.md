# Baywatch Service OS

An operations system for running a **two-wheeler service center** — the shop
floor, not the accounting. It replaces the whiteboard, the phone calls and the
paper job card with one backend that every role reads from.

Four role-scoped surfaces (**Master Admin · Admin · Worker · Customer**) sit on
a FastAPI + PostgreSQL backend. **PostgreSQL is the single source of truth** —
there is no demo data path and no offline/localStorage store. If the backend is
unreachable the UI shows empty/error states rather than fabricated numbers.

---

## The problem it solves

| Pain on the shop floor | What the system does |
|---|---|
| Nobody knows which bay is free, who's on what, or how long it's taken | **Bay-first** dashboard — the *bay* owns its worker, camera and timer; live per-bay countdown driven by the backend, mirrored to physical ESP32 timers over MQTT |
| Job cards arrive as PDFs; time estimates are guesses | **PDF job-card extraction** + a parts-based estimate (Σ qty × `PartsMaster.estimated_time`) |
| The customer calls "is it ready?" every hour, and distrusts the bill | **Passwordless customer links** (WhatsApp) for a **live camera watch** of their own bike, and a token-gated **estimate approval** page before work starts |
| "You said 2 hours, it took 5" — no evidence of what was done | Per-session **camera recording**, 14-day retention, Google Drive archival, work-completion PDF reports |
| Damage disputes at handover | **Vehicle intake evidence** — photos + voice note + complaint captured at drop-off, keyed to the bike number |
| No idea where worker hours actually go | **Bay-to-bay time analysis** — assignment delay, start delay, idle gaps, shift utilization |
| Unmanned gate; who is entering/leaving with which vehicle | **AI barricade** — YOLO/OCR only *suggests*; the backend authorizes, and the relay opens only against an approved-and-paid bill or a temporary pass |

---

## Shape of the system

```
 Worker tablet ─┐
 Admin console ─┼─► frontend (React 18, precompiled JSX, static)  ──HTTP + WebSocket──┐
 Master console ┘                                                                      │
                                                                                       ▼
 Customer phone ──(token link, no login)──► FastAPI backend  ──►  PostgreSQL (single source of truth)
                                                │  ├─ Redis        persistent bay timers
                                                │  ├─ local disk   recordings / intake media / frames
                                                │  ├─ MQTT         ESP32 bay timers, barricade relay
                                                │  ├─ FFmpeg       RTSP capture + live HLS
                                                │  └─ Google Drive recording archival
                                                └─► AI barricade service (separate process, :8811)
```

---

## Hardware architecture

How the software maps onto the physical shop floor. Each diagram is the
deployment target for one subsystem; the implementation status note under each
says what is live in the code today versus what still needs hardware on site.

### Camera monitoring and timer-linked recording

![Camera monitoring and timer-linked recording architecture](docs/architecture/diagrams/01-camera-recording-architecture.png)

Admin starts a bay timer, the backend validates the lifecycle transition, and
the recording pipeline captures that bay's RTSP stream for the duration of the
job. Video lives on disk or NVR; PostgreSQL stores only metadata and the audit
trail.

> **Status:** camera registry, real `ffprobe` connection tests, FFmpeg capture
> and the timer-driven start/stop are implemented and exercised locally.
> End-to-end recording against a specific camera or NVR model has **not** been
> validated on site — availability is presence-gated, so an unverified camera
> reports unavailable rather than showing a false green.

### Wireless bay timers (ESP32 over MQTT)

![16-bay wireless timer system architecture](docs/architecture/diagrams/02-bay-timer-mqtt-architecture.png)

One timer per bay. The backend publishes each bay's countdown over MQTT and
republishes on reconnect, so a display that outlived a backend restart resyncs
without drift. The ESP32 only renders what it receives — the backend timer is
always the source of truth.

> **Status:** backend MQTT publishing, per-bay topic routing and the admin
> pairing UI are implemented; firmware is in [firmware/esp32_bay_timer](firmware/esp32_bay_timer).
> The topic scheme in this diagram is illustrative — the authoritative contract
> is `{prefix}/{bay_number}/{event}` (default prefix `bay`), documented in
> [docs/MQTT_CONTRACT.md](docs/MQTT_CONTRACT.md).

### GPS test-drive tracking

![GPS test drive tracking architecture](docs/architecture/diagrams/03-gps-test-drive-architecture.png)

A test drive is assigned by an admin, approved by the worker, tracked as a
route, and completed by the admin. The backend computes every metric — distance
by Haversine, stop detection, duration — so no client can report its own numbers.

> **Status:** the implemented path uses the **worker's device GPS through the
> browser** (`navigator.geolocation`); the data model records this as
> `browser_gps`. The SIM-based tracker and third-party GPS platform shown here
> are a future hardware option, not what runs today — the schema already
> accommodates it via the `device_gps` point source.

---

## Repository layout

```
bsms/
├── backend/               FastAPI API — the whole business system
│   ├── app/routers/       28 routers — /api/v1 business API + /ws, /hls, public planes
│   ├── app/services/      workflow engine, recording, MQTT, Drive, estimates, barricade…
│   ├── app/models/        SQLAlchemy 2 models (PostgreSQL)
│   ├── app/utils/         auth/RBAC, timers, PDFs, parsers, retention
│   ├── docker-compose.yml         dev stack (Postgres, Redis, MinIO, Celery)
│   ├── docker-compose.prod.yml    production stack (single web worker — see runbook)
│   └── scripts/           backup.sh · restore.sh · schema_verify.sh
├── frontend/              static app — no bundler, JSX precompiled with Babel CLI
│   ├── index.html         entry point + fixed script load order
│   ├── js/api.js          BW_API client + realtime hooks (useBWPoll/Socket/Snapshot)
│   ├── components/ pages/ features/ live/     see ARCHITECTURE.md §6
│   ├── watch/ customer-approval/              customer pages, served BY the backend
│   └── serve.py           no-cache dev server (:7890)
├── ai_barricade_service/  separate YOLO + OCR + RTSP worker process (:8811)
├── firmware/esp32_bay_timer/   physical bay-timer firmware
├── .verify/               startup check, portal/UI verifiers, Playwright screenshots
├── docs/ workflow-details/     deep-dive references
└── ARCHITECTURE.md        how it all fits together
```

---

## Run it locally

**1 — PostgreSQL** (required; SQLite is dev-only fallback and is a production blocker)

```bash
bash backend/setup_postgres.sh        # macOS/Homebrew helper: installs PG 16, creates
                                      # role+db `baywatch` on :5432
```

Any PostgreSQL instance works — just point `DATABASE_URL` at it
(`postgresql+psycopg://user:pass@host:port/db`).

**2 — Backend**

```bash
cd backend
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env                  # set DATABASE_URL, JWT_SECRET
python run.py                         # → http://localhost:8000/docs
```

Schema is created on boot (`create_all` + additive `ensure_*_schema()` migrations —
never drops). Optional services (Redis, MQTT, Drive, WhatsApp, FFmpeg) degrade
gracefully and are reported by `/health`, never blocking startup.

**3 — Frontend**

```bash
cd frontend
npm install
npm run build                         # JSX → .compiled/*.js (Babel CLI)
python3 serve.py                      # → http://localhost:7890/
```

`npm run watch:*` rebuilds on save. **Never edit `.compiled/` by hand** — the
`.jsx` files are the source of truth.

**4 — (optional) AI barricade service**

```bash
cd ai_barricade_service && pip install -r requirements.txt && python app.py   # :8811
```

Log in at http://localhost:7890/ — landing → branch → role → credentials. Every
portal requires a real backend JWT; your **token's role decides the portal**, so
a worker token can never render the admin console. Seeded dev logins are in the
git-ignored `LOCAL_TEST_CREDENTIALS.md`.

---

## Deploy it

The app needs **persistent processes** — WebSocket channels, the MQTT publisher,
the retention scheduler and FFmpeg capture are all long-running. That rules out
serverless hosts (Vercel/Netlify functions); use a container platform.

**One-command demo stack** (app + PostgreSQL + Redis, single origin):

```bash
docker compose -f docker-compose.demo.yml up -d --build
open http://localhost:8090
```

The app container serves the frontend *and* the API on one origin, so there is
no CORS to configure and the customer watch/approval pages stay same-origin.
To expose it publicly, pass the public URL so customer links resolve:

```bash
PUBLIC_URL=https://your-host docker compose -f docker-compose.demo.yml up -d
```

**Hosted** — [fly.toml](fly.toml) deploys the same image to Fly.io (persistent
VM, volume-backed media, `/ready` health gate); the launch steps are in its
header comment. Render and Railway take the same `Dockerfile` directly.

> The demo stack runs `APP_ENV=development` **on purpose**: production mode
> treats `SEED_ON_STARTUP=true` as a hard startup blocker, which would leave a
> fresh deployment with no accounts to log in with. For a real production
> rollout seed once, then set `APP_ENV=production` with
> `SEED_ON_STARTUP=false` — see [DEPLOYMENT_RUNBOOK.md](DEPLOYMENT_RUNBOOK.md)
> and [backend/docker-compose.prod.yml](backend/docker-compose.prod.yml).

Cameras, ESP32 timers and the barricade relay are shop-floor hardware: a cloud
deployment reports them unavailable via `/health` and the UI stays camera-gated,
so nothing shows a false green.

---

## Health & verification

```bash
curl localhost:8000/health    # db, timer backend, MQTT, recording engine, Drive, retention
curl localhost:8000/ready     # 503 unless DB + writable media root are both good
bash .verify/startup_check.sh # end-to-end: servers, auth, PostgreSQL-backed data, devices
node .verify/verify_portals.js
```

---

## Modules at a glance

| Module | Backend | Surfaces |
|---|---|---|
| Job lifecycle (create → queue → assign → start/pause/resume/complete) | `services/workflow_engine.py` | Admin bay dashboard, Worker active job |
| Bay & device registry (cameras, ESP32 timers) | `routers/bays,cameras,timers` | Admin Integrations tabs |
| Recording + HLS + retention + Drive archival | `services/recording_service,drive_service` | Storage Management, Work Completion |
| Customer live watch (token link) | `routers/customer_watch,watch_public` | Customer phone, Master audit |
| Customer estimate approval (token link) | `routers/customer_approvals,approval_public` | Customer phone, Admin approvals |
| Vehicle intake evidence | `routers/vehicle_intake` | Worker wizard, Admin/Master dashboards |
| Bike test-drive tracking (GPS) | `routers/test_drives` | Worker approval, Admin map |
| AI barricade (entrance/exit) | `routers/barricade` + `ai_barricade_service/` | Admin AI/Approvals/Safety, Master monitoring |
| Worker bay-to-bay time analysis | `services/worker_transition_analysis_service.py` | Admin/Master analytics |
| Integrations & configuration | `utils/integration_config.py` | Admin Integrations (Fernet-encrypted secrets) |

---

## Documentation map

| Doc | Read it for |
|---|---|
| **[ARCHITECTURE.md](ARCHITECTURE.md)** | how the whole system is wired — lifecycle, realtime, RBAC, frontend build, page maps |
| [backend/README.md](backend/README.md) | API-level backend notes |
| [PRODUCTION_READINESS.md](PRODUCTION_READINESS.md) · [DEPLOYMENT_RUNBOOK.md](DEPLOYMENT_RUNBOOK.md) | going to production, backups, restore |
| [DEVICE_CONNECTION_SYSTEM_DESIGN.md](DEVICE_CONNECTION_SYSTEM_DESIGN.md) · [docs/MQTT_CONTRACT.md](docs/MQTT_CONTRACT.md) | cameras, ESP32 timers, MQTT topics |
| [SINGLE_SOURCE_OF_TRUTH.md](SINGLE_SOURCE_OF_TRUTH.md) · [PAGE_DATABASE_MAPPING.md](PAGE_DATABASE_MAPPING.md) | which screen reads which table |
| [workflow-details/](workflow-details/) | long-form per-topic references |
| [.verify/PLAYWRIGHT_WORKFLOW.md](.verify/PLAYWRIGHT_WORKFLOW.md) | UI verification conventions |
