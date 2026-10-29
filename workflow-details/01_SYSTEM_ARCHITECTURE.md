# 01 — System Architecture

> Baywatch Service OS — a service-center operating system for two-wheeler workshops.
> Generated **from the actual implementation** in this repository (every file, table and
> API named below exists in the code). Companion documents:
> [02 Frontend Workflow](02_FRONTEND_WORKFLOW.md) ·
> [03 Workflow Engine](03_COMPLETE_WORKFLOW_ENGINE.md) ·
> [04 Storage & Data Flow](04_STORAGE_AND_DATA_FLOW.md) ·
> [05 Database](05_DATABASE_DOCUMENTATION.md) ·
> [06 Frameworks](06_PROJECT_FRAMEWORKS.md) ·
> [07 Folder Structure](07_FOLDER_STRUCTURE.md) ·
> [08 API](08_API_DOCUMENTATION.md) ·
> [09 External Devices](09_EXTERNAL_DEVICE_INTEGRATION.md) ·
> [10 Developer Guide](10_DEVELOPER_GUIDE.md) ·
> [11 Beginner Overview](11_PROJECT_OVERVIEW_FOR_BEGINNERS.md)

---

## Big picture

```mermaid
flowchart TD
    subgraph Browser["Browser (4 portals: Master Admin / Admin / Worker / Customer)"]
        FE["React 18 UMD + Babel Standalone\nfrontend/index.html → app.jsx"]
    end

    subgraph Backend["FastAPI backend  (backend/app/main.py · port 8000)"]
        API["Routers  /api/v1/*"]
        WS["WebSocket push  /ws/*"]
        WE["Workflow Engine\nservices/workflow_engine.py"]
        RECS["Recording Service\nservices/recording_service.py"]
        CAMS["Camera Service\nservices/camera_service.py"]
        STRS["Streaming Service\nservices/streaming_service.py"]
        SCHED["Scheduler Service\nservices/scheduler_service.py"]
        MQTTS["MQTT Service\nservices/mqtt_service.py"]
        DRIVE["Drive Service\nservices/drive_service.py"]
        TIMER["Timer engine\nutils/timer.py"]
    end

    PG[("PostgreSQL 16\n(17 tables)")]
    REDIS[("Redis\nactive bay timers")]
    SSD[("Local SSD\nbackend/media/")]
    GD[("Google Drive\nDrive API v3")]
    BROKER(("Mosquitto\nMQTT broker :1883"))
    ESP["ESP32 physical bay timer\nfirmware/esp32_bay_timer/"]
    CAM["CP Plus IP camera\nRTSP"]
    FF["FFmpeg subprocess"]

    FE -- "fetch JSON + JWT" --> API
    FE -- "WS ?token=JWT (1s push)" --> WS
    API --> WE
    WE --> TIMER --> REDIS
    WE --> PG
    WE --> RECS
    WE --> MQTTS --> BROKER --> ESP
    CAMS --> RECS
    CAM -- "RTSP" --> FF
    RECS --> FF --> SSD
    STRS -. "signed HLS URL" .-> FE
    SCHED --> DRIVE --> GD
    SCHED --> SSD
    API --> PG
```

One sentence per layer: the **frontend** is a single HTML page that renders four
role-based portals; the **backend** is one FastAPI app that owns all business logic;
**PostgreSQL** stores permanent records; **Redis** holds only the live countdown
timers; **FFmpeg** records each bay's camera onto the **local SSD**; the
**scheduler** archives finished videos to **Google Drive** and enforces 14-day
expiry; and **MQTT** mirrors every timer to a physical **ESP32 display** on the bay.

---

## 1. Frontend Architecture

| | |
|---|---|
| **Purpose** | Four role-based portals (Master Admin, Admin, Worker, Customer) in a single static page. |
| **Folder** | [frontend/](../frontend/) |
| **Main files** | [index.html](../frontend/index.html), [app.jsx](../frontend/app.jsx), [js/api.js](../frontend/js/api.js), [pages/](../frontend/pages/), [features/](../frontend/features/), [live/live.jsx](../frontend/live/live.jsx) |
| **Served by** | [frontend/serve.py](../frontend/serve.py) — plain Python `http.server` on **port 7890** with no-cache headers. No build step. |

**How it works.** There is **no bundler**. [index.html](../frontend/index.html) loads
React 18.3.1 UMD, ReactDOM, and **Babel Standalone** from CDNs, then loads every
`.jsx` file as `<script type="text/babel">` in a fixed order. Each file attaches its
components to `window` (e.g. `window.LiveBayDashboard`), which is how files "import"
each other.

**Live vs demo dual mode.** Every portal tab renders one of two implementations:

```jsx
// frontend/pages/admin.jsx:785
{tab==='bays' && (live ? <window.LiveBayDashboard/> : <BayDashboard tick={tick}/>)}
```

* `live` = `window.BW_API.isLive()` = a JWT exists in `sessionStorage`. The `Live*`
  components in [live/live.jsx](../frontend/live/live.jsx) render **only real backend
  data** (polling via `useBWPoll` + WebSocket via `useBWSocket`).
* With no backend session, the original demo components (local hard-coded data in
  [pages/](../frontend/pages/) and [features/](../frontend/features/)) render so the
  UI still works offline (`#admin`, `#worker`, … hash deep-links).

**API client.** [js/api.js](../frontend/js/api.js) exposes `window.BW_API`
(~80 typed wrappers over `fetch`), `window.useBWPoll` (interval polling hook that
**stops on 401/403** to avoid request floods) and `window.useBWSocket`
(auto-reconnecting WebSocket hook with backoff that gives up on auth-close codes
4401/4403).

**Auth storage.** The JWT (`bw_token`) and user blob (`bw_user`) live in
**`sessionStorage`** — isolated per tab, so three tabs can hold three different role
sessions simultaneously. Only the non-sensitive `bw_api_base` stays in
`localStorage`. The role used for routing is **decoded from the JWT itself**
(`roleOf()`), so a stale stored user can never spoof a portal.

**Data flow (frontend):**

```
User action (click)
    ↓
window.BW_API.<call>()              js/api.js — adds Authorization: Bearer <jwt>
    ↓
http://localhost:8000/api/v1/...    backend router
    ↓
{success, data, message} envelope   unwrap() → .data
    ↓
React state → re-render             plus 1s WS pushes / 2–6s polls for live data
```

---

## 2. Backend Architecture

| | |
|---|---|
| **Purpose** | All business logic: auth, jobs, queue, bays, timers, cameras, recordings, reports, devices. |
| **Folder** | [backend/app/](../backend/app/) |
| **Entry point** | [main.py](../backend/app/main.py) — `uvicorn app.main:app` on **port 8000** (started via [run.py](../backend/run.py)) |
| **Layers** | `routers/` (HTTP/WS surface) → `services/` (engines) → `models/` (SQLAlchemy ORM) → `utils/` (helpers) |

**Startup sequence** ([main.py](../backend/app/main.py) `lifespan`):

1. `init_db()` — `Base.metadata.create_all` (dev path; Alembic config exists for Postgres migrations).
2. `ensure_parts_schema() / ensure_job_schema() / ensure_bay_schema() / ensure_recording_schema()` — idempotent `ALTER TABLE ADD COLUMN` for columns added after first release.
3. `storage.ensure_buckets()` — MinIO buckets (no-op when MinIO is absent).
4. `seed()` — minimal bootstrap (branches, master/admin/worker logins, 8 Chennai bays) **only if the users table is empty** ([seed.py](../backend/app/seed.py)).
5. `timer.restore_all()` — reload active bay timers from Redis, recompute remaining/overtime.
6. `_reconcile_sessions()` — cross-check DB running/paused sessions against Redis; logs loudly if a timer was lost.
7. `recording_service.restore()` — kill orphan FFmpeg processes from a previous run, mark their sessions `interrupted`.
8. `scheduler_service.start_scheduler()` — background archive + retention sweeps (every 6 h).
9. `mqtt_service.start()` — connect to Mosquitto + start the 1 s ESP32 state publisher.

**Middleware ordering (important):** a catch-all error middleware is registered
**before** `CORSMiddleware`, which makes CORS the *outermost* layer — so even an
unhandled 500 carries `Access-Control-Allow-Origin` and the browser sees the real
error instead of a misleading "CORS / Failed to fetch".

**Response contract:** every endpoint returns the envelope
`{"success": bool, "data": ..., "message": str}` ([schemas/common.py](../backend/app/schemas/common.py));
`HTTPException` and validation errors are converted to the same shape by the
exception handlers in main.py.

**Auth:** JWT (HS256, [utils/auth.py](../backend/app/utils/auth.py)) with role guards
`require_master`, `require_admin` (admin **or** master), `require_worker`,
`require_customer`. 401 = missing/expired token or user gone; 403 = valid session,
wrong role (logged with token-role vs DB-role for traceability).

---

## 3. Database Architecture

| | |
|---|---|
| **Engine** | PostgreSQL 16 via `postgresql+psycopg://baywatch:baywatch@localhost:5432/baywatch` ([backend/.env](../backend/.env)); SQLite fallback for zero-config runs. |
| **ORM** | SQLAlchemy 2.0 declarative (`Mapped` / `mapped_column`), sync engine ([database.py](../backend/app/database.py)). |
| **Models** | [backend/app/models/](../backend/app/models/) — 17 tables (full detail in [05_DATABASE_DOCUMENTATION.md](05_DATABASE_DOCUMENTATION.md)). |
| **Migrations** | `create_all` + idempotent `ensure_*_schema()` column adds; [alembic/](../backend/alembic/) scaffolding present for production migrations. |

Core relationship chain:

```
branches ─< users ─< job_cards ─< job_queue
                          │
                          └─< service_sessions ─< camera_sessions
                                      │
                                      ├─< recording_sessions
                                      └─< notifications (via customer)
bays ─── bay_cameras (1:1) · timer_devices (1:1) · bay_temp_assignments
parts: imported_files ─< parts_master · unit_conversion_settings
ops:   audit_logs · leave_requests
```

---

## 4. Service Architecture

All engines live in [backend/app/services/](../backend/app/services/). They are plain
modules (no classes/DI) called by routers and by each other:

| Service | File | Role | Called by |
|---|---|---|---|
| Workflow Engine | [workflow_engine.py](../backend/app/services/workflow_engine.py) | The **only** place job lifecycle state changes happen (`JOB_ASSIGNED/STARTED/PAUSED/RESUMED/COMPLETED`). | `routers/queue.py` (assign), `routers/bay_dashboard.py` (start/pause/resume/complete) |
| Timer engine | [utils/timer.py](../backend/app/utils/timer.py) | Redis-persisted, timestamp-anchored countdown per bay. | workflow engine, snapshots, MQTT publisher, /health |
| Camera Service | [camera_service.py](../backend/app/services/camera_service.py) | Resolves a bay → its paired camera's RTSP URL (+credentials); test-source fallback in dev. | workflow engine (START/RESUME) |
| Recording Service | [recording_service.py](../backend/app/services/recording_service.py) | Spawns/stops FFmpeg, segmented `.ts` capture, live HLS, concat → `video.mp4`, ffprobe duration. | workflow engine, streaming service, recordings router |
| Streaming Service | [streaming_service.py](../backend/app/services/streaming_service.py) | HMAC-signed, session-scoped live HLS URLs (TTL 1 h). | master router, customer router, snapshots, `/hls` router |
| Scheduler Service | [scheduler_service.py](../backend/app/services/scheduler_service.py) | 6-hour background loop: `archive_sweep()` (Drive upload) + `retention_sweep()` (14-day expiry); storage dashboard aggregation. | started in lifespan; storage_admin router (Sync Now / Retry) |
| Drive Service | [drive_service.py](../backend/app/services/drive_service.py) | Real Google Drive API v3 (service account): upload + size-verify + share-link + delete. Dormant until credentials are configured. | scheduler service |
| MQTT Service | [mqtt_service.py](../backend/app/services/mqtt_service.py) | Publishes timer state (1 s, retained) + lifecycle events to `bay/{n}/*`; consumes ESP32 telemetry/hello. | workflow engine, timers router, lifespan |
| Snapshots | [snapshots.py](../backend/app/services/snapshots.py) | Shared read-model builders so REST GET and WS push return identical shapes. | bay_dashboard router, ws router |

---

## 5. Camera Architecture

```mermaid
flowchart LR
    A["Admin · Camera Connection page\n(LiveCameraConnection, live.jsx)"] -- "pair/test/edit\n/api/v1/cameras" --> R["routers/cameras.py"]
    R --> T[("bay_cameras table\n1 camera per bay")]
    W["Workflow Engine\nJOB_STARTED"] --> CS["camera_service.resolve_source(bay_id)"]
    CS --> T
    CS -- "{kind:'rtsp', input: rtsp://user:pass@ip/...}" --> RS["recording_service.start()"]
    CS -- "no camera paired → {kind:'test'}" --> RS
```

* **Registry** ([models/camera_device.py](../backend/app/models/camera_device.py) →
  table `bay_cameras`): one device per bay — `camera_id`, `ip_address`, `rtsp_url`,
  `onvif_port`, `username`/`password`, `enabled`, `last_seen` heartbeat.
* **Status** is computed, not stored: `online` if `last_seen` ≤ 90 s old
  (`ONLINE_WINDOW` in [routers/cameras.py](../backend/app/routers/cameras.py)),
  else `offline`; `unpaired` / `disabled` otherwise.
* **Test / Reconnect / Restart** buttons call `_probe()`, which in this dev build
  *simulates* a successful probe by stamping `last_seen` (the production note in the
  code says: open RTSP / ONVIF call first). `POST /cameras/heartbeat` is an
  unauthenticated device-to-server liveness ping matched on `camera_id`.
* The camera's RTSP credentials are injected into the URL **only inside the backend**
  (`_inject_credentials`); raw RTSP is never sent to a browser.
* `camera_sessions` (table) is the *per-job* on/off record, distinct from the
  hardware registry.

---

## 6. Timer Architecture

```mermaid
flowchart LR
    AD["Admin clicks START/PAUSE/RESUME/COMPLETE\nLive Bay Dashboard"] --> BD["routers/bay_dashboard.py"]
    BD --> WE["workflow_engine.emit()"]
    WE --> TM["utils/timer.py\nstart/pause/resume/stop"]
    TM --> RD[("Redis  bay_timer:{bay_id}\n+ set bay_timer:active")]
    TM -- "get_state()" --> SN["snapshots / WS / REST"]
    WE --> MQ["mqtt_service"] --> ESP["ESP32 display"]
```

* **Redis is the single source of truth for active timers**
  ([utils/timer.py](../backend/app/utils/timer.py)). State per bay:
  `current_status (READY/RUNNING/PAUSED)`, `service_session_id`, `estimated_duration`,
  `start_time`, `pause_time`, `accumulated_pause_duration`.
* The maths is **timestamp-anchored**: `elapsed = now − start_time − accumulated_pause`,
  so a backend restart loses nothing — `restore_all()` simply recomputes from the
  stored absolute times. If Redis is unreachable the engine falls back to in-process
  memory (non-persistent, logged as an error).
* `remaining` can go **negative = overtime**; `overtime = max(0, elapsed − estimated)`.
* On COMPLETE the timer is **deleted from Redis** and the final
  `actual_duration` / `overtime_duration` are persisted to PostgreSQL on the
  `service_sessions` row.
* The **physical timer** is a one-way mirror: [mqtt_service.py](../backend/app/services/mqtt_service.py)
  publishes the computed state every second; the ESP32 never computes time
  (see [09_EXTERNAL_DEVICE_INTEGRATION.md](09_EXTERNAL_DEVICE_INTEGRATION.md)).

---

## 7. Recording Architecture

```mermaid
flowchart TD
    ST["JOB_STARTED"] --> RS["recording_service.start"]
    RS --> F0["FFmpeg → seg_000.ts  (MPEG-TS)"]
    RS --> H0["FFmpeg same process → live HLS\nmedia/hls/{SS}/index.m3u8"]
    P["JOB_PAUSED"] --> KILL["stop segment process"]
    R["JOB_RESUMED"] --> F1["FFmpeg → seg_001.ts …"]
    C["JOB_COMPLETED"] --> CAT["concat seg_*.ts → video.mp4\n(+faststart, ffprobe duration)"]
    CAT --> META["RecordingSession: video_path,\nfile_size, duration, expiry (+14d)"]
    META --> PLAY["GET /api/v1/recordings/{id}\nJWT + role + ownership\n→ signed playback URL"]
    PLAY --> STREAM["GET /{id}/stream?token=…\nHTTP Range MP4 · or 302 → Drive"]
```

Why segmented MPEG-TS: a job can pause/resume many times and `.ts` can be cut at any
byte (no MP4 moov atom to corrupt), so a killed segment is always playable. Segments
are concatenated **once**, at COMPLETE.

* RTSP sources are `-c:v copy` (no transcode, low CPU). Dev fallback (no/unreachable
  camera) is a **real** synthetic source `testsrc=960x540:rate=15` paced with `-re`
  so the recording duration matches wall-clock; an RTSP watchdog (`_guard_rtsp`)
  falls back to it within ~2 s if the camera is unreachable (logged WARNING).
* Per-session state is persisted to `media/recordings/{SS}/state.json` (+
  `metadata.json`, `ffmpeg.log`), so `restore()` can reap orphans after a crash.
* Playback authorization lives in [routers/recordings.py](../backend/app/routers/recordings.py):
  admin/master see all; worker only `rec.worker_id == user.id`; customer only
  `rec.customer_id == user.id`. The stream endpoint is token-authorized
  (HMAC, TTL 2 h, capped at the recording's expiry) so the browser `<video>` tag works,
  serves **HTTP Range (206)** for seeking, and **302-redirects to Google Drive** once
  archived. Expired → friendly 410, never a broken page. Raw SSD paths are never exposed.

---

## 8. Google Drive Architecture

```mermaid
flowchart LR
    SCH["scheduler_service._loop\nevery 6 h"] --> AS["archive_sweep()"]
    AS -- "completed, local-only recordings" --> UP["drive_service.upload()\nresumable, size-verified,\n'anyone' reader link"]
    UP --> DB[("recording_sessions:\ndrive_file_id, drive_url,\nupload_status=uploaded")]
    DB --> DEL["delete local SSD copy\nONLY after verified upload + commit"]
    UP -- "failure" --> KEEP["upload_status=failed\nlocal KEPT · auto-retry next sweep"]
    RET["retention_sweep()\nexpiry_date past"] --> RDEL["drive_service.delete(file_id)\n+ rm local dir\n→ status=expired, is_deleted"]
    UI["Admin · Storage Management"] -- "Sync Now / Retry" --> AS
```

* Configured by two settings ([config.py](../backend/app/config.py)):
  `GOOGLE_DRIVE_CREDENTIALS` (service-account JSON path) + `GOOGLE_DRIVE_FOLDER_ID`.
  **Unset → the service is dormant**: recordings stay on local SSD, rows are marked
  `upload_status='local'`, nothing is ever deleted. There is no placeholder upload.
* Upload lifecycle on `recording_sessions.upload_status`:
  `local → pending → uploading → uploaded` | `failed` (kept + retried).
* `health()` does a real `about.get` probe so the Storage dashboard shows
  configured/reachable/account, not just "credentials present".

---

## 9. MQTT Architecture

```mermaid
sequenceDiagram
    participant BE as Backend (mqtt_service)
    participant MQ as Mosquitto :1883
    participant ESP as ESP32 bay timer

    Note over BE: every 1 s, for each active timer
    BE->>MQ: bay/{n}/timer  (retained JSON state)
    MQ->>ESP: state → render MM:SS + colour
    Note over BE: admin clicks START
    BE->>MQ: bay/{n}/start (QoS 1)  + immediate state
    ESP-->>MQ: bay/{n}/telemetry  {ip, firmware, rssi}  (~15 s)
    MQ-->>BE: telemetry → stamp timer_devices.last_seen
    ESP-->>MQ: bay/{n}/hello  (on boot)
    MQ-->>BE: hello → republish current state (instant resync)
```

* Topic prefix `bay` (configurable, `MQTT_TOPIC_PREFIX`); `{n}` = globally-unique
  `bay_number`. Full payload spec: [docs/MQTT_CONTRACT.md](../docs/MQTT_CONTRACT.md).
* The 1 s publisher runs in a daemon thread (`_publish_loop`); state is published
  **retained** so a rebooting device instantly adopts the current countdown.
* Colour stages computed server-side (`timer_color`): green ≥ 60 % remaining,
  orange 20–60 %, red < 20 % **and all overtime**.
* Admin commands from the Timer Connection page → `bay/{n}/restart|test|ota`.
* Broker down / `MQTT_ENABLED=false` → publishing silently skipped; the backend
  timer (Redis) remains authoritative either way.

---

## 10. Workflow Engine Architecture

The heart of the system — fully documented in
[03_COMPLETE_WORKFLOW_ENGINE.md](03_COMPLETE_WORKFLOW_ENGINE.md). Summary:

```
Admin action            Event            Cascades to
─────────────────────────────────────────────────────────────────────────────
Assign (queue→bay)      JOB_ASSIGNED     ServiceSession(assigned) + CameraSession(off)
                                          + RecordingSession(idle) · bay→running
START                   JOB_STARTED      session running · camera on · recording
                                          recording · Redis timer start · FFmpeg start
                                          · MQTT start+state · notify customer (SMS/Email/In-App)
PAUSE                   JOB_PAUSED       session paused · camera off · FFmpeg segment stop
                                          · timer pause · MQTT pause · notify (In-App)
RESUME                  JOB_RESUMED      mirror of start (new .ts segment)
COMPLETE                JOB_COMPLETED    timer stop→actual/overtime · concat→video.mp4
                                          · expiry=+14d · bay released · next job promoted
                                          · completion PDF task · MQTT complete+DONE · notify
```

Every event is also written to `audit_logs` (`log_action`), and every recording /
device error is caught so **a recording or MQTT failure can never break the job**.

---

## End-to-end data flow (one complete job)

```
Admin uploads job-card PDF
    ↓  POST /api/v1/jobs/extract-pdf   (pdfplumber + triumph_parser + parts matching)
Review → Save to queue
    ↓  POST /api/v1/jobs/save-to-queue  → job_cards + job_queue rows
Admin assigns to a bay
    ↓  POST /api/v1/queue/{id}/assign   → workflow_engine.create_from_assign
    ↓  service_sessions(assigned) + camera_sessions + recording_sessions
Admin presses START
    ↓  POST /api/v1/bay-dashboard/{bay}/start → emit(JOB_STARTED)
    ↓  Redis timer · FFmpeg capture · HLS live · MQTT → ESP32 · customer SMS
Worker watches own job (WS /ws/worker) · Customer watches live (HLS signed URL)
Admin presses COMPLETE
    ↓  emit(JOB_COMPLETED) → video.mp4 + metadata + 14-day expiry
Worker/Customer/Admin view recording
    ↓  GET /api/v1/recordings/{REC} (role+ownership) → signed /stream URL
Nightly-equivalent sweeps (every 6 h)
    ↓  archive_sweep → Google Drive (verified) → local deleted
    ↓  retention_sweep → after 14 days Drive+local deleted, status=expired
```
