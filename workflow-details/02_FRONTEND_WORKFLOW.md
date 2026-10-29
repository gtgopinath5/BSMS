# 02 — Frontend Workflow (every page, every role)

> Written in simple language. If you can use a phone app, you can understand this.
> Everything here describes the **actual code** — file names and API paths are real.
> Architecture context: [01_SYSTEM_ARCHITECTURE.md](01_SYSTEM_ARCHITECTURE.md) ·
> APIs: [08_API_DOCUMENTATION.md](08_API_DOCUMENTATION.md)

---

## How the app starts

1. You open `http://localhost:7890` (served by [frontend/serve.py](../frontend/serve.py)).
2. [index.html](../frontend/index.html) loads React + Babel from CDNs, then every `.jsx` file.
3. [app.jsx](../frontend/app.jsx) shows the flow: **Landing (pick branch) → Role select → Login → Portal**.
4. On login, [js/api.js](../frontend/js/api.js) calls `POST /api/v1/auth/login` and saves the
   JWT in **sessionStorage** (`bw_token`). From then on every page shows **live data**.
5. If you are not logged in, the same pages render their built-in **demo data** instead
   (hash links `#admin`, `#worker`, `#master`, `#customer` open demo previews).

**Rule that protects everything:** the portal you see is decided by the **role inside
your JWT** (`BW_API.roleOf()` decodes the token). A worker token can never open the
admin portal — app.jsx logs you out if portal and token role disagree.

Two data "pipes" keep live pages fresh:

| Pipe | Hook | Used for |
|---|---|---|
| Polling (every 2–6 s) | `useBWPoll` | lists, tables, dashboards |
| WebSocket (push every 1 s) | `useBWSocket` | bay dashboard, worker active job, customer live service |

---

## ADMIN PORTAL (desktop console)

File: [pages/admin.jsx](../frontend/pages/admin.jsx) (shell + demo pages) +
[live/live.jsx](../frontend/live/live.jsx) (live pages). Sidebar = `ADMIN_NAV`
(admin.jsx:4). The header includes **global search (Ctrl+K)** (`BWCommandPalette` →
`GET /api/v1/platform/search`) and a **notification bell** (`BWNotifications` →
`GET /api/v1/platform/activity`).

> Note: the admin sidebar has exactly these 11 items in the code. There is no separate
> "Dashboard" or "Customer Management" page — the Live Bay Dashboard *is* the dashboard,
> and customers are reached through jobs/completions.

### 1. Live Bay Dashboard (`bays`) — `LiveBayDashboard` (live.jsx:318)

* **Purpose:** the control room. One tile per bay with worker, vehicle, live countdown,
  camera/REC status.
* **Data:** WebSocket `/ws/bay-dashboard` (1 s push) + fallback poll `GET /api/v1/bay-dashboard`
  (3 s) + `GET /api/v1/bays`, `GET /api/v1/queue`, `GET /api/v1/reports/work-completion`
  for the header counters.
* **Database behind it:** `bays`, `service_sessions`, `job_cards`, `users` + the Redis timer.
* **Buttons & what each one starts:**
  * **START JOB** → `POST /api/v1/bay-dashboard/{bay_id}/start` → backend
    `workflow_engine.emit(JOB_STARTED)` → timer starts in Redis, FFmpeg starts
    recording, ESP32 beeps, customer gets "service started".
  * **PAUSE / RESUME** → same pattern (`JOB_PAUSED` / `JOB_RESUMED`).
  * **COMPLETE** → confirmation → `POST .../complete` → video finalised, PDF task,
    bay freed, next job flagged.
  * Bay detail drawer → set status / duplicate / delete
    (`POST /bays/{id}/status`, `POST /bays/{id}/duplicate`, `DELETE /bays/{id}`).

### 2. Bay Management (`baymgmt`) — `LiveBayManagement` (live.jsx:3400)

* CRUD on bays: create (auto bay number = max+1), edit name/description/camera
  channel/primary worker, status (available/maintenance/disabled), delete.
* APIs: `GET/POST /api/v1/bays`, `PUT /bays/{id}`, `POST /bays/{id}/status`, `DELETE /bays/{id}`.
* Delete is **safe by design** (backend `routers/bays.py`): a bay with job history is
  *archived* (`is_active=false`) instead of hard-deleted, so reports never break.

### 3. Camera Connection (`cameras`) — `LiveCameraConnection` (live.jsx:776)

* Table of every bay + its paired IP camera: status (online/offline/unpaired),
  IP, RTSP URL, last-seen.
* **Pair Camera** → `POST /api/v1/cameras` (bay_id, ip, rtsp_url, onvif port, user/pass).
* **Run Connection Test / Reconnect / Restart** → `POST /cameras/{id}/test|reconnect|restart`
  (dev build stamps `last_seen`; production would probe RTSP/ONVIF).
* **Unpair** → `DELETE /cameras/{id}`. Data lives in the `bay_cameras` table.
* Why it matters: when a job starts, the recording pipeline looks up **this registry**
  to find what to record (`camera_service.resolve_source`).

### 4. Timer Connection (`timers`) — `LiveTimerConnection` (live.jsx:1165)

* Same idea as cameras but for the **physical ESP32 countdown displays**.
* Shows MQTT broker status + per-bay timer: online/offline (MQTT telemetry heartbeat),
  device IP, firmware version, last seen.
* **Pair Timer** → `POST /api/v1/timers` (returns the MQTT topic `bay/{n}/timer`).
* **Force state resync** → `POST /timers/{id}/reconnect` (republishes current countdown).
* **Restart / Test Display / Update Firmware (OTA)** →
  `POST /timers/{id}/restart|test|firmware` → MQTT commands `bay/{n}/restart|test|ota`.
* Table: `timer_devices`.

### 5. Job Assignment & Queue (`assign`) — `LiveJobAssignment` (live.jsx:1974)

* **The intake + dispatch center.** Polls `GET /api/v1/queue` + `/workers` + `/bays`.
* **New Job (manual form)** → `POST /api/v1/jobs/manual` → creates `job_cards` row +
  `job_queue` row in the chosen worker's queue.
* **Upload Job Card PDF** → `POST /api/v1/jobs/extract-pdf` — backend reads the
  Triumph/Bajaj PDF (pdfplumber + regex template), maps "Customer Voice" phrases to
  services, matches each service against the Parts Time DB, and returns fields +
  total estimated minutes. Review screen → **Save to queue** → `POST /api/v1/jobs/save-to-queue`.
* Per-job drawer actions: move up/down (`POST /queue/{id}/move`), reassign worker
  (`/reassign`), change preferred bay (`/change-bay`), remove (`DELETE /queue/{id}`),
  and **Assign to bay** (`POST /queue/{id}/assign`) — this is the moment a
  `service_sessions` row is born (status `assigned`, NOT started).

### 6. Parts Time (`partstime`) — `LivePartsTime` (live.jsx:3717)

* The parts/labour-time master used for estimating job duration.
* Import Excel/PDF price-time files: parsed **in the browser** (SheetJS/pdf.js) and sent as
  rows → `POST /api/v1/parts/import-rows` (large-file safe); replace file versions →
  `POST /parts/files/{id}/replace`; per-file preview/delete.
* Search/paged list `GET /api/v1/parts`, model filter `GET /parts/models`,
  add/edit/delete part, **unit conversion** (`POST /parts/unit-conversion`) which
  recalculates every part's estimated minutes (confirmation required).
* Audit drawer → `GET /api/v1/parts/audit`. Tables: `imported_files`, `parts_master`,
  `unit_conversion_settings`, `audit_logs`.

### 7. Worker Management (`workers`) — `LiveWorkerManagement` (live.jsx:3048)

* Staff list (`GET /api/v1/workers`) + **Create Worker** (`POST /api/v1/workers`):
  name, employee ID, department, designation, username/password, branch.
* Table: `users` (role=worker).

### 8. Leave Approvals (`leave`) — `LiveLeaveApprovals` (live.jsx:4039)

* Pending leave requests from workers → **Approve / Reject**
  (`GET /api/v1/leave`, `POST /leave/{id}/approve|reject`). Table: `leave_requests`.

### 9. Branch Reports (`reports`) — `LiveBranchReports` (live.jsx:4072)

* Worker performance table → `GET /api/v1/reports/worker-performance`
  (estimated vs actual vs overtime minutes + score per completed session) and
  branch summary → `GET /api/v1/reports/branch-summary`.

### 10. Work Completion (`completion`) — `LiveWorkCompletion` (live.jsx:3256)

* Every **completed** job grouped per worker: vehicle, customer, est/actual/overtime,
  score, **VIDEO column** and **REC STATUS badge** (Available / Expiring Soon / Expired).
* Poll: `GET /api/v1/reports/work-completion` (6 s).
* **Video actions** (components from [features/completion.jsx](../frontend/features/completion.jsx)):
  * **Preview** → `RecordingPreviewModal` with a real `<video>` tag playing the
    authorized stream URL (`/api/v1/recordings/{REC}/stream?token=…` made absolute
    by `recAbsUrl`).
  * **View Recording** → opens the same signed URL in a new tab.
  * **Copy Link** → copies the signed URL.
* **Completion PDF download** — generated client-side with jsPDF (`wapCompletionPdf`
  in live.jsx) including the Service Recording section (date, duration, expiry,
  session ID, link, Google Drive link, and the 14-day expiry notice).

### 11. Storage Management (`storage`) — `LiveStorageManagement` (live.jsx:888)

* The recording-storage operations page. Poll: `GET /api/v1/storage` (5 s).
* Shows: total local SSD usage, **Google Drive status** (configured/reachable/account),
  counts and lists for *pending / failed / archived / expired* recordings,
  retention days, sweep interval.
* **Sync Now** → `POST /api/v1/storage/sync-now` (runs the Drive archive sweep in the
  background). **Retry** on a failed row → `POST /api/v1/storage/retry/{recording_id}`.

---

## WORKER PORTAL (tablet)

File: [pages/worker.jsx](../frontend/pages/worker.jsx). Sidebar = `SIDE_NAV`
(worker.jsx:4): **Active Job · My Job Queue · Profile · Attendance & Leave · Work
History**. Workers are **view-only** — they never control timers (the admin does).

> The job spec sometimes calls the history page "Performance" — in the code it is the
> **Work History** tab, and it carries the performance data (score per job).

### Active Job (`active`) — `LiveWorkerActive` (live.jsx:2597)

* **Data:** WebSocket `/ws/worker` (1 s) + poll `GET /api/v1/worker/active` (3 s).
  The backend returns the worker's live job — or, if nothing is live, the most
  recently **completed** one so the worker still sees the result + recording.
* What the worker sees (all read-only):
  * Big circular countdown timer (server-computed remaining; green→orange→red at
    100–60–20 %, negative = overtime).
  * Full professional job card (`LiveJobCardPanel`): vehicle / customer / service /
    cost / complaint ("Customer Voice") / notes / special instructions.
  * Parts & services table with per-item estimated minutes and status.
  * Camera + recording status chips (on/recording/paused/off).
  * Timeline: assigned → started → ended times.
  * After completion: the **recording card** (View Recording / Copy Link) and the
    **Completion PDF** download.

### My Job Queue (`queue`) — `LiveWorkerQueue` (live.jsx:2637)

* The worker's own upcoming jobs in order → `GET /api/v1/worker/queue` (2 s poll).

### Profile (`profile`) — `ProfilePage` ([features/profiles.jsx](../frontend/features/profiles.jsx))

* Static identity card from login data (name, employee ID, branch).

### Attendance & Leave (`attendance`) — `LiveWorkerLeave` (live.jsx:4224)

* Apply for leave (`POST /api/v1/leave` with dates/type/reason) and see own requests
  + status (`GET /api/v1/leave/mine`).

### Work History (`history`) — `LiveWorkerHistory` (live.jsx:2661)

* All completed jobs → `GET /api/v1/worker/history`: date, bay, vehicle, service,
  estimated/actual/overtime minutes, **score**, and the **recording cell**
  (status badge + Preview / View / Copy Link, same components as admin).

### What happens when the admin presses START (worker's view)

```
Admin START
   ↓
Workflow Engine (backend)
   ↓
Timer starts (Redis)         Camera ON          Recording starts (FFmpeg)
   ↓                            ↓                      ↓
/ws/worker push (1 s) ───────────────────────────────→ Worker's Active Job page
   ↓                                                   updates live: RUNNING badge,
Database (service_sessions → running)                  countdown ticking, REC chip on
   ↓
Customer portal also flips to "In Service" + live feed
```

---

## MASTER ADMIN PORTAL (desktop)

File: [pages/master.jsx](../frontend/pages/master.jsx). Sidebar = `MASTER_NAV`
(master.jsx:4): **Dashboard · Bay Monitoring · Camera Configuration · Timer
Configuration · Storage Management · System Settings · Branch Management · User
Management · Work Completion · Reports · Audit Logs**.

| Tab | Live component (live.jsx) | API | What it shows / does |
|---|---|---|---|
| Dashboard (`overview`) | `LiveMasterOverview` :2788 | `GET /master/branches`, `GET /master/global-analytics` | All branches with bays/crew/live-feed counts + global completed/on-time numbers. |
| Bay Monitoring (`monitoring`) | `LiveMasterMonitoring` :2968 | `GET /master/bay-monitoring` (2 s) | Every bay in every branch: session status, worker, vehicle, live timer, camera/REC state, and a **live video feed** (signed HLS URL, only while RUNNING). View-only. |
| Camera Configuration (`cameras`) | `LiveCameraConnection` (shared with admin) | `/api/v1/cameras…` | Same camera registry, global view. |
| Timer Configuration (`timers`) | `LiveTimerConnection` (shared) | `/api/v1/timers…` | Same ESP32 registry, global view. |
| Storage Management (`storage`) | `LiveStorageManagement` (shared) | `/api/v1/storage…` | Same Drive/SSD dashboard. |
| System Settings (`settings`) | `LiveSystemSettings` :1258 | `GET /health` + `GET /api/v1/storage` | System health: DB ok, timer backend (redis/memory) & persistence, active timers, MQTT status, recording engine (ffmpeg/unavailable), Drive configured, retention days. |
| Branch Management (`branches`) | `LiveMasterBranchManagement` :4109 | `GET /master/branches`, `POST /master/branches` | List + create branches. |
| User Management (`admins`) | `LiveMasterUserManagement` :4156 | `GET/POST /master/admins` | List branch admins + create an admin bound to a branch. |
| Work Completion (`completion`) | `LiveWorkCompletion` (shared) | `GET /reports/work-completion` | Global completion log (master sees **every branch**; a branch admin only their own — enforced server-side). |
| Reports (`analytics`) | `LiveMasterAnalytics` :3031 | `GET /master/global-analytics` | Branch count, completed jobs, on-time rate. |
| Audit Logs (`audit`) | `LiveAuditLogs` :4492 | `GET /platform/activity?q=` | Searchable, newest-first audit trail of every action in the system. |

---

## CUSTOMER PORTAL (tablet/phone)

File: [pages/customer.jsx](../frontend/pages/customer.jsx). Nav = `CUSTOMER_NAV`
(customer.jsx:10): **Live Service · Service History · Notifications**.
Hard privacy rule (enforced in [routers/customer.py](../backend/app/routers/customer.py)):
a customer only ever sees **their own** services, and never bay/camera internals.

### Live Service (`live`) — `LiveCustomerService` (live.jsx:2696)

* **Data:** WebSocket `/ws/customer` (1 s) + poll `GET /api/v1/customer/active-service` (3 s).
* Shows the active service: vehicle, registration, service type, status
  (Assigned / In Service / Paused), estimated minutes and remaining time.
* **Watch Live** — while the service is RUNNING the backend includes a signed
  HLS URL (`/hls/secure/{SS}/stream.m3u8?token=…`); paused or finished → no feed.

### Service History (`history`) — `LiveCustomerHistory` (live.jsx:2729)

* `GET /api/v1/customer/service-history` — each completed service with:
  vehicle, type, completed time, est/actual/overtime minutes, and the **recording
  block**: status, recording date, duration, days left, **View Recording**
  (signed URL), Google Drive link when archived, and the message
  *"This service recording has expired and is no longer available."* once expired.
* **Download Completion PDF** — client-generated report including the Service
  Recording section and the notice *"This recording will automatically expire after
  14 days."*

### Notifications (`notify`) — `LiveCustomerNotifications` (live.jsx:2765)

* `GET /api/v1/customer/notifications` — the in-app feed written by the workflow
  engine: SERVICE_STARTED / PAUSED / RESUMED / COMPLETED, with channel tags
  (SMS / Email / In-App). SMS is really sent via MSG91 when configured.

### Simple example (for a 15-year-old)

> Imagine your bike is in the shop. The moment the mechanic's manager presses START,
> your phone page flips to "In Service" with a countdown, and you can literally watch
> your bike being repaired on a live video. When it's done you get a message, a PDF
> report, and a 14-day video recording of the whole repair — like a delivery-tracking
> app, but for your bike, with video proof.

---

## Demo-mode components (offline fallback)

When no JWT is present, these render instead of the `Live*` pages (same UI, local data):

| Demo piece | File | Notes |
|---|---|---|
| `BayDashboard`, `BAYS` demo data | [pages/admin.jsx](../frontend/pages/admin.jsx) | Hard-coded 8 Chennai bays. |
| `WorkflowEngine`, `useWorkflow`, `ServiceLiveFeed`, `RecordingModal` | [features/workflow.jsx](../frontend/features/workflow.jsx) | Frontend mirror of the backend engine (drives the demo). |
| `BayTimer`, `useBayTimer` | [features/baytimer.jsx](../frontend/features/baytimer.jsx) | In-browser timer store for demo mode. |
| `QueueStore`, `UnifiedJobQueue` | [features/queue.jsx](../frontend/features/queue.jsx) | Demo queue. |
| `WorkCompletion`, `RecordingUtil`, `RecordingPreviewModal`, `VideoActions`, `RecordingStatusBadge` | [features/completion.jsx](../frontend/features/completion.jsx) | The recording UI components are **shared** — live mode reuses them with real URLs. |
| Job intake demo | [features/jobintake.jsx](../frontend/features/jobintake.jsx) | In-browser PDF/OCR extraction demo (pdf.js + tesseract.js). |
| Parts demo | [features/partstime.jsx](../frontend/features/partstime.jsx), [features/partsstore.jsx](../frontend/features/partsstore.jsx) | LocalStorage-backed parts store. |
| Entry screens | [pages/screens.jsx](../frontend/pages/screens.jsx) | Landing / RoleSelect / Login. |
| Icons & primitives | [components/icons.jsx](../frontend/components/icons.jsx), [components/primitives.jsx](../frontend/components/primitives.jsx) | Shared SVG icon set + Avatar/Chip/etc. |
