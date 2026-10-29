# Baywatch Service OS — Architecture

How the system is actually wired: the processes, the database-backed data flow,
the job lifecycle state machine, the realtime layer, authorization, the device
integrations, and the frontend build and page map.

For *what problem it solves* and *how to run it*, see **[README.md](README.md)**.

> **The one rule that explains most of the design:** PostgreSQL is the single
> source of truth. Every screen renders what the backend says. There is no demo
> store, no localStorage business data, and no client-side re-derivation of a
> number the backend already computed. When data is missing, screens show an
> empty/error state — never a plausible-looking fake.

---

## 1. Runtime topology

| Process | Port | What it is | Required? |
|---|---|---|---|
| FastAPI backend (`backend/run.py`) | 8000 | the whole business system + WS + HLS + public customer pages | **yes** |
| PostgreSQL | 5432/5433 | system of record | **yes** |
| Frontend static server (`frontend/serve.py`) | 7890 | serves `index.html` + precompiled JS, no-cache | yes (dev) |
| Redis | 6379 | persistent bay timers (survive a backend restart) | strongly recommended |
| MQTT broker | 1883 | ESP32 bay timers, optional barricade relay | optional |
| AI barricade service (`ai_barricade_service/app.py`) | 8811 | YOLO detection + OCR + RTSP workers | optional |
| MinIO / Celery | 9000 / — | object storage + background jobs (compose stack) | optional |

**Degradation is explicit and honest.** Optional dependencies never block boot;
they are reported by `GET /health`:

| Missing | Effect |
|---|---|
| Redis | timers fall back to in-memory — **not persistent** across restart (logged as an error) |
| FFmpeg / cameras | no capture or live HLS; recording metadata still tracked, availability reported as unavailable |
| MQTT broker | physical ESP32 timers go dark; the backend timer remains the source of truth |
| Google Drive | recordings stay on local disk; archival reported inactive (never a fake "uploaded") |
| WhatsApp / MSG91 / SendGrid | send is a graceful no-op; Copy-Link still works |

`GET /ready` is the orchestrator probe and is stricter: it returns **503** unless
the DB is reachable **and** the recording media root is writable.

### 1.1 Startup sequence (`backend/app/main.py` lifespan)

```
validate_startup()      APP_ENV=production → fail-fast on real blockers
                        (weak JWT secret, SQLite, seed-on-startup, localhost
                        watch URL, wildcard CORS, unwritable media root).
                        In dev the same items are logged as "would block".
init_db()               create_all — idempotent, never drops
ensure_*_schema() ×12   additive column/table migrations added after first release
retention cleanups      approvals (14d) · intake media (14d) · barricade frames (30d)
timer.restore_all()     rebuild live bay timers from Redis
_reconcile_sessions()   cross-check DB running/paused sessions against Redis, loudly
recording_service.restore()   reap orphan ffmpeg processes
scheduler_service.start()     retention sweeper
mqtt_service.start()          connect + 1s ESP32 state publisher (resyncs on connect)
```

There are no Alembic version files in normal operation: the schema is
`create_all` plus the `ensure_*_schema()` functions. See
[DEPLOYMENT_RUNBOOK.md](DEPLOYMENT_RUNBOOK.md).

---

## 2. Backend layout

All business routes are mounted under `/api/v1`.

| Router | Owns |
|---|---|
| `auth` | login, JWT issue |
| `workers`, `leave` | crew records, HR fields, leave apply/approve |
| `bays`, `bay_dashboard` | bay registry + the live operations dashboard |
| `cameras`, `timers` | per-bay device registry (RTSP cameras, ESP32 timers) |
| `jobs`, `queue`, `parts` | job cards (incl. PDF extraction), worker queues, parts master |
| `worker` | the worker's own plane (active job, queue, history, jobcard entry) |
| `recordings`, `streaming`, `storage_admin` | playback tokens, HLS, storage/retention/Drive admin |
| `customer_watch` + `watch_public` | admin-issued live-watch links + the public token page |
| `customer_approvals` + `approval_public` | estimate approval requests + the public token form |
| `vehicle_intake` | intake evidence (worker capture, admin/master dashboards, PDF) |
| `test_drives` | GPS test-drive assign → worker approve → admin complete |
| `barricade` | AI gate: detections, decisions, exit approvals, controller + safety |
| `worker_transition` | bay-to-bay delay analytics |
| `reports`, `master`, `branches`, `platform`, `integrations` | reporting, master plane, public branch list, config |
| `ws` (`/ws`) | realtime snapshot push channels |

| Service | Responsibility |
|---|---|
| `workflow_engine` | **the** job lifecycle — transitions, side effects, audit |
| `recording_service` | FFmpeg RTSP capture, live HLS, orphan recovery |
| `camera_service` | real `ffprobe` camera tests (no simulated results) |
| `mqtt_service` | shared MQTT client; per-bay timer topics; barricade relay topic |
| `drive_service` | Google Drive archival (service account, dated/bay subfolders) |
| `estimate_service` | the one parts-based time estimator |
| `snapshots` | the payload builders shared by REST and WebSocket |
| `barricade_service`, `barricade_controller_service` | gate decisions; relay adapters + safety interlock |
| `test_drive_service`, `test_drive_image_service` | Haversine metrics, stop detection, route images |
| `worker_transition_analysis_service` | transition gaps, delays, utilization |
| `whatsapp_service`, `scheduler_service` | outbound messaging; retention sweeps |

| Utility | Why it matters |
|---|---|
| `utils/auth.py` | `get_current_user`, `require_roles`, branch scoping |
| `utils/timer.py` | timestamp-anchored bay timers on Redis (memory fallback) |
| `utils/completion.py` | `derive_pause()` — **the one** pause truth for every completion surface |
| `utils/recordings.py` | retention, playback tokens, signed URLs, `archive_state()` |
| `utils/integration_config.py` | DB config overrides, Fernet-encrypted secrets, masked reads |
| `utils/jobcard_parser.py`, `job_extractor.py`, `triumph_parser.py` | PDF job-card extraction |
| `utils/audit.py` | append-only action log behind every lifecycle event |

---

## 3. Data model

Roles are **`master_admin` · `admin` · `worker`** (there is no customer user
account — customers are reached by signed token links, §7.3).

```
Branch ──┬── Bay ──┬── camera device (RTSP)      Bay owns its worker/camera/timer
         │         └── timer device (ESP32)      ← "bay-first": jobs carry bay_id only
         ├── User (master_admin | admin | worker)
         └── JobCard ──► JobQueue ──assign──► ServiceSession  ← the master link
                                                 ├── CameraSession
                                                 ├── RecordingSession (14-day retention)
                                                 └── Notification[]
```

`ServiceSession` is the identifier everything else hangs off; the customer is
bound to the *session*, never to a bay or worker (both can change mid-service).

| Enum | Values |
|---|---|
| `SessionStatus` | `assigned → running ⇄ paused → completed` |
| `QueueStatus` | `queued → assigned → active → completed` |
| `RecordingStatus` | `idle → recording → active → expiring → expired` |

Independent modules with their own tables: vehicle intake, customer approvals,
customer watch links, test drives, barricade (events, approvals, controller),
integration settings, worker-transition reasons, audit log.

`ServiceSession` timestamps double as the analytics spine:
`created_at` = assigned, `start_time` = started, `end_time` = completed.

---

## 4. The job lifecycle

One engine, one chokepoint: `services/workflow_engine.py`.

### 4.1 State machine

```python
_TRANSITIONS = {
    "JOB_STARTED":   {assigned},
    "JOB_PAUSED":    {running},
    "JOB_RESUMED":   {paused},
    "JOB_COMPLETED": {running, paused},
}
```

`assert_transition()` runs **before any side effect**, so an illegal event is a
**409** with a human message ("This bay's job is already running"). A
double-clicked Start can never reset the countdown or relaunch FFmpeg.

### 4.2 End-to-end

```
CREATE    Admin · Job Assignment → manual form or PDF upload
          → JobCard + JobQueue row                                  status: queued
          → estimate_service computes Σ qty × PartsMaster.estimated_time (matched parts only)

APPROVE   (optional) Admin sends a token link → customer reviews/removes items → submits
          → a SUBMITTED approval becomes the estimate authority

ASSIGN    Admin picks a BAY (never a worker — the bay owns the worker)
          → workflow_engine.create_from_assign() → ServiceSession SS-YYYY-NNNNNN
                                                                     status: assigned

START     emit("JOB_STARTED")
          ├ re-resolves the worker from the bay (honours a temp replacement)
          ├ re-resolves the estimate (a late customer approval wins)
          ├ computes truthful handoff warnings → warn, never block
          ├ timer.start(bay, estimate, meta)      Redis-anchored, drift-free
          ├ camera on · recording → recording · bay → running
          ├ FFmpeg capture + live HLS start
          └ notify customer (SMS + Email + In-App)                    status: running

PAUSE/    emit("JOB_PAUSED"/"JOB_RESUMED") → timer, camera, capture and bay
RESUME    status follow; customer gets an In-App note               status: paused/running

COMPLETE  emit("JOB_COMPLETED")
          ├ actual = timer.stop(bay); overtime = max(0, actual − estimate)
          ├ recording finalized → status active, expiry = completed + retention_days
          ├ bay released → available; next queued job promoted
          ├ completion PDF generated
          └ notify customer "report & recording ready"               status: completed
```

Every event also: mirrors state to the bay's **physical ESP32 timer** over MQTT,
mirrors the lifecycle onto a **sent customer watch link** (so the customer page
flips to live/paused/ended by itself), and writes an **audit row** carrying the
start-time metadata (warnings, estimate source, approved cost) that completion
screens read back later.

### 4.3 Estimate authority

`resolve_estimate()` is the single answer to "how long should this take": a
**submitted customer approval**'s `approved_total_minutes` wins; otherwise the
job card's own estimate — which is what `estimate_service` computed from the
parts list at intake, and is **never mutated** (default 45 min if absent). It
returns `(minutes, source, approved_cost)` with `source = approved | job_card`,
and that source is displayed — the frontend never recalculates the number.

---

## 5. Realtime

Two mechanisms, one payload shape.

```
services/snapshots.py     ← the ONLY builders
  dashboard() queue() intake() approvals() barricade() worker_active()
        │                                   │
   REST endpoints                    /ws/<channel> (1s push)
        │                                   │
        └──────── useBWSnapshot(path, fetcher) ────────┘
                  WS when connected · REST poll as seed + fallback
                  (last-writer-wins; identical shape by construction)
```

| Channel | Roles | Scope |
|---|---|---|
| `/ws/bay-dashboard` | admin, master_admin | live bays |
| `/ws/queue` | admin, master_admin | branch-scoped |
| `/ws/intake` | admin, master_admin | branch-scoped |
| `/ws/approvals` | admin, master_admin | branch-scoped |
| `/ws/barricade` | admin, master_admin | branch-scoped |
| `/ws/worker` | worker | the caller's own active job |

Branch scope comes from **the JWT, never a client parameter**: a master sees
global, everyone else is confined to their own `branch_id`. Close codes `4401`
(unauthorized) and `4403` (wrong role) stop the client reconnect loop instead of
storming the server.

---

## 6. Authentication & authorization

- **JWT bearer**, HS256, `jwt_expire_minutes` (default 720).
- The frontend stores the session in **`sessionStorage`**, which is per-tab, so
  three tabs can hold three different role sessions at once. Legacy
  `localStorage` auth is actively purged on load (it was the cause of
  cross-role contamination).
- The **token's role decides the portal** — the URL hash cannot override it.
- Guards: `require_master` (master only), `require_admin` (**admin *and*
  master**), `require_worker`. Every 403 logs path, user, DB role, token role
  and what was expected.
- Branch-level RBAC on top of role checks: an admin sees only their branch.

### 6.1 Public token planes (no login)

Two same-origin surfaces are served by the backend itself:

| Path | Page | Gate |
|---|---|---|
| `/customer-watch/{token}` + `/state`, `/stream.m3u8`, `/seg/{n}` | `frontend/watch/index.html` | opaque token, TTL (default 12h), revocable, mirrors session state |
| `/customer-approval/{token}` + `/data`, `/item-action`, `/submit` | `frontend/customer-approval/index.html` | opaque token, one per session, submit-locks |

Both return strict allowlisted payloads: no bay numbers, no camera details, no
file paths, no internal ids. An unknown or revoked token is **404**; a link whose
session has ended or whose window has expired is **410 Gone**; a stream requested
while nothing is live is 404. Role-gated media elsewhere (e.g. intake evidence)
answers a bad token with 403.

---

## 7. Recordings, media & retention

```
START ──► FFmpeg RTSP capture ──► local media root (BW_MEDIA_ROOT)
                │                        │
                └──► live HLS (/hls)     ├──► Google Drive archival
                                         │      YYYY-MM-DD/Bay-XX/Worker_HH-mm_Bike_JOB.mp4
                                         └──► retention sweep → expiry → verified delete
```

- Playback is **token-gated** (`utils/recordings.playback_token` / `signed_url`);
  raw paths are never exposed to a browser.
- `archive_state()` is the one truthful state: availability is **presence-gated**
  — a missing file is never reported as available, and "none" (never recorded) is
  distinguished from "expired".
- Local files are never deleted before a **verified** Drive upload; a failed
  upload keeps the local copy, and un-archived locals are held at expiry.
- Retention windows: recordings 14 days (`recording_retention_days`), approval
  history 14, intake media 14, barricade frames 30. Business records themselves
  are never deleted — only temporary evidence expires.

---

## 8. Devices

**Bay timers (ESP32 over MQTT).** One bay → one timer. Topics are strictly
per-bay: `{prefix}/{bay_number}/{event}` — **never** a broadcast. The backend
publishes state every second and republishes on reconnect, so a device that
survived a backend restart resyncs without drift. The ESP32 only *displays*; the
backend timer is the source of truth. See [docs/MQTT_CONTRACT.md](docs/MQTT_CONTRACT.md).

**Cameras (RTSP).** Registered per bay inside the Integrations → camera tab.
"Test" runs a real `ffprobe` against the stream. Passwords are never returned by
the API; the UI shows a masked RTSP preview.

**AI barricade.** The detection service (separate process) runs YOLO and OCR and
**only suggests**. The backend decides, and the relay opens only against an
approved *and paid* bill or an active temporary pass. Simulation is the default
adapter; `http_relay` / `mqtt_relay` are opt-in, time-bounded and **fail safe
closed**. Emergency stop hard-blocks opens. An optional safety interlock
(photo-beam, loop, barrier state, controller heartbeat) can gate every open.

---

## 9. Frontend architecture

### 9.1 Build model

No bundler, no framework CLI: the `.jsx` files are compiled **ahead of time** by
Babel CLI into `.compiled/*.js` classic scripts (`npm run build` / `watch:*`),
and `index.html` loads them in a fixed order. React/ReactDOM, jsPDF, pdf.js,
Tesseract, XLSX and Leaflet come from CDNs.

```
css/styles.css · admin.css · responsive.css
js/api.js                       BW_API + realtime hooks (plain JS, loads first)
.compiled/components/icons · primitives
.compiled/features/profiles → js/parts_data.js → partsstore → partstime
                              → completion → integrations → customer_approvals
.compiled/pages/screens · worker · admin · master
.compiled/live/live            ← every backend-connected page (window.Live*)
.compiled/app                  ← router; ReactDOM.createRoot(...).render(<App/>)
```

Because these are classic scripts they share one global scope: top-level
declarations are visible to later files, and cross-file components are published
on `window` and referenced **at render time** (`<window.LiveBayDashboard/>`), so
load order only matters for parse-time use.

**Never edit `.compiled/` by hand.**

### 9.2 Where the code lives

| Path | Holds |
|---|---|
| `js/api.js` | `BW_API` (every endpoint), `useBWPoll`, `useBWSocket`, `useBWSnapshot`, per-tab session, JWT decode, auth-expiry broadcast |
| `components/` | `Icon`, `Avatar`, `Sparkline`, `useNow`, `LogoutButton`, shared primitives |
| `features/` | profiles, parts store/time, work-completion PDF builder, integrations, customer approvals |
| `pages/` | the four shells: `screens` (landing/role/login), `worker`, `admin`, `master` |
| `live/live.jsx` | **the bulk of the product** — ~30 `window.Live*` page components that talk to the backend, plus `BWCommandPalette` and `BWNotifications` |
| `watch/`, `customer-approval/` | standalone customer pages, served by the backend |

### 9.3 Client conventions

- **`useBWPoll`** stops polling on 401/403 (no request floods) and keeps retrying
  on network errors.
- **`useBWSnapshot`** is the default for live screens: WS push with REST fallback.
- **Cross-page command bus**: `bw:navigate` (palette → tab), `bw:palette-open`,
  `bw:integrations-open`, `bw:auth-expired` (one-shot "session expired" toast).
- **The frontend displays; it does not derive.** Estimates, pause minutes,
  overtime, warnings, recording availability all come from the backend as-is.
- The single PDF builder `lwcBuildCompletionReport` renders every completion
  report, so preview and download are identical by construction.

### 9.4 Adaptive framing

`app.jsx` scales two fixed shells — a **tablet stage** (worker + entry flow) and
a **desktop console** (admin + master). Under 1024px both drop the scale
transform and go fluid: sidebars become drawers, the bay grid collapses
4→2→1 column, modals become bottom sheets, and worker screens get a bottom nav.

---

## 10. Page map

**Worker** (`pages/worker.jsx` → `LiveWorker*`): Active Job (view-only live
timer — control belongs to the admin) · My Job Queue · Jobcard Entry (intake
evidence capture) · Test Drive Approval · Profile · Attendance & Leave · Work
History.

**Admin** (`pages/admin.jsx`, branch-scoped console): Live Bay Dashboard ·
Bay Management · Job Assignment & Queue · Intake Evidence · Customer Approvals ·
Parts Time · Worker Management · Leave Approvals · Branch Reports · Worker Time
Analysis · Bike Test Drive Tracking · AI Barricade · Work Completion · Storage
Management · Integrations & Configuration.

**Master** (`pages/master.jsx`, global): Dashboard · Bay Monitoring (view-only) ·
Barricade Monitoring · Customer Live Watch audit · Storage Management ·
Integrations · System Settings · Branch Management · User Management · Work
Completion · Intake Evidence · Customer Approvals · Reports · Worker Time
Analysis · Audit Logs.

**Customer**: no portal and no account — the token pages in §6.1.

Device registries (cameras, timers) deliberately live **inside their
Integrations provider tabs**, one card per bay, rather than in a standalone tab.

---

## 11. Invariants

Changes are expected to respect these; several were hard-won fixes.

1. **PostgreSQL is the only source of truth** — no demo data, no localStorage
   business state, no client-side recomputation of backend values.
2. **Bay-first** — a job is assigned to a *bay*; the bay owns the worker, camera
   and timer. There is no worker dropdown on assignment.
3. **The lifecycle has one chokepoint** (`workflow_engine.emit`) with a guarded
   transition table; illegal transitions are 409s, not silent no-ops.
4. **`derive_pause()` is the only pause calculation** on every completion surface.
5. **MQTT bay topics are per-bay**, never broadcast.
6. **AI suggests, the backend decides** — and the relay fails safe closed.
7. **Warn, never block**: handoff problems are surfaced truthfully instead of
   preventing work.
8. **Honest states** — presence-gated availability, "not configured" instead of a
   fake green, no path or secret ever leaked to a client.
9. Schema changes are **additive** (`ensure_*_schema()`); nothing drops.

---

## 12. Verification

| Command | Checks |
|---|---|
| `bash .verify/startup_check.sh` | servers, auth, PostgreSQL-backed data, device subsystems |
| `node .verify/verify_portals.js` | every portal renders against the live stack |
| `node .verify/verify_ui.js` | Playwright UI/state screenshot galleries |
| `python .verify/bw_verify.py` / `bw_hardening.py` / `bw_breakit.py` | API contract, hardening, abuse cases |
| `bash backend/scripts/schema_verify.sh` | schema matches the models |
| `curl :8000/health` · `curl :8000/ready` | dependency truth · orchestrator probe |

Major UI changes are expected to ship with a state-screenshot gallery — see
[.verify/PLAYWRIGHT_WORKFLOW.md](.verify/PLAYWRIGHT_WORKFLOW.md).

---

## 13. Further reading

| Doc | Topic |
|---|---|
| [DEVICE_CONNECTION_SYSTEM_DESIGN.md](DEVICE_CONNECTION_SYSTEM_DESIGN.md) | camera + timer pairing model |
| [docs/MQTT_CONTRACT.md](docs/MQTT_CONTRACT.md) | MQTT topics and payloads |
| [PRODUCTION_READINESS.md](PRODUCTION_READINESS.md) · [DEPLOYMENT_RUNBOOK.md](DEPLOYMENT_RUNBOOK.md) | production config, backup/restore |
| [SINGLE_SOURCE_OF_TRUTH.md](SINGLE_SOURCE_OF_TRUTH.md) · [PAGE_DATABASE_MAPPING.md](PAGE_DATABASE_MAPPING.md) | screen → table mapping |
| [TEST_DRIVE_TRACKING.md](TEST_DRIVE_TRACKING.md) · [WORKER_CRUD_WORKFLOW.md](WORKER_CRUD_WORKFLOW.md) | module deep dives |
| [workflow-details/](workflow-details/) | long-form per-topic references |
