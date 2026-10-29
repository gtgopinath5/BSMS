# 05 — Database Documentation (PostgreSQL)

> Engine: **PostgreSQL 16** — `postgresql+psycopg://baywatch:baywatch@localhost:5432/baywatch`
> ([backend/.env](../backend/.env); SQLite fallback supported). ORM: **SQLAlchemy 2.0**
> declarative, sync engine ([backend/app/database.py](../backend/app/database.py)).
> All models: [backend/app/models/](../backend/app/models/).
> Schema: the default `public` schema, 17 tables.

**Database → schema → tables → columns → relationships:** one database (`baywatch`),
one schema (`public`), tables created by `Base.metadata.create_all` at startup
(`init_db()` in database.py), plus **idempotent column adds** for post-release columns:
`ensure_parts_schema()` ([routers/parts.py](../backend/app/routers/parts.py)),
`ensure_job_schema()` ([routers/jobs.py](../backend/app/routers/jobs.py)),
`ensure_bay_schema()` ([routers/bays.py](../backend/app/routers/bays.py)),
`ensure_recording_schema()` ([routers/recordings.py](../backend/app/routers/recordings.py)).
[Alembic](../backend/alembic.ini) scaffolding exists for production migrations.
Primary keys are UUID strings (`String(36)`, default `uuid_pk()` in
[models/ids_default.py](../backend/app/models/ids_default.py)) except the
human-readable IDs noted below. Indexes: PKs + unique constraints
(`users.username`, `job_cards.job_card_number`, `bay_cameras.bay_id`,
`timer_devices.bay_id`); no additional secondary indexes are declared in the models.

## ER diagram

```mermaid
erDiagram
    branches ||--o{ users : "branch_id"
    branches ||--o{ bays : "branch_id"
    branches ||--o{ job_cards : "branch_id"

    users ||--o{ job_cards : "customer_id / created_by"
    users ||--o{ job_queue : "worker_id"
    users ||--o{ service_sessions : "worker_id / customer_id"
    users ||--o{ recording_sessions : "worker_id / customer_id"
    users ||--o{ notifications : "customer_id"
    users ||--o{ leave_requests : "worker_id / decided_by"
    users ||--o{ audit_logs : "changed_by"
    users ||--o{ bay_temp_assignments : "replacement_worker_id"
    users ||--o{ imported_files : "uploaded_by"
    users ||--o{ unit_conversion_settings : "changed_by"

    bays ||--o| bay_cameras : "1 camera per bay (unique)"
    bays ||--o| timer_devices : "1 timer per bay (unique)"
    bays ||--o{ bay_temp_assignments : "bay_id"
    bays ||--o{ job_queue : "bay_id (nullable)"
    bays ||--o{ service_sessions : "bay_id"
    bays ||--o{ camera_sessions : "bay_id"
    users ||--o{ bays : "primary_worker_id"

    job_cards ||--o{ job_queue : "job_card_id"
    job_cards ||--o{ service_sessions : "job_card_id"
    job_cards ||--o{ recording_sessions : "job_card_id"

    service_sessions ||--o{ camera_sessions : "CASCADE"
    service_sessions ||--o{ recording_sessions : "CASCADE"

    imported_files ||--o{ parts_master : "source_file_id CASCADE"
```

---

## Identity & organisation

### `branches` — [models/branch.py](../backend/app/models/branch.py)
Service-center locations. **PK:** `id` (human, e.g. `LOC_CHN_01`).
Columns: `name`, `location`, `status` (default `operational`).
APIs: `GET/POST /api/v1/master/branches`. Pages: Master → Branch Management;
branch names enrich Work Completion. Inserted by [seed.py](../backend/app/seed.py)
and the master router.

### `users` — [models/user.py](../backend/app/models/user.py)
Every account; one table, four roles (`UserRole` enum: `master_admin · admin ·
worker · customer`). **PK:** `id` UUID. **FK:** `branch_id → branches.id`.
Columns: identity (`name,email,mobile`), staff fields (`employee_id, company_id,
pf_number, aadhaar, department, designation`), credentials (`username` unique,
`hashed_password` — pbkdf2_sha256 via [utils/security.py](../backend/app/utils/security.py)),
`profile_photo_url`, `status`, `created_at`.
APIs: auth login/me, `/api/v1/workers` CRUD, `/api/v1/master/admins`.
Pages: Login, Worker Management, User Management. Services: every guard
(`utils/auth.py`) reads this table on each request.

---

## Bays & devices

### `bays` — [models/bay.py](../backend/app/models/bay.py)
Physical work bays. **PK** UUID. **FKs:** `branch_id`, `primary_worker_id → users.id`.
Columns: `bay_number` (int, globally unique in practice — MQTT topics key on it),
`name`, `description`, `camera_channel`, `status`
(`available/running/paused/maintenance/disabled/deleted`), `is_active`
(soft-delete flag; archived bays keep history).
Inserted by seed/`POST /bays`; status flipped by the **workflow engine** on every
lifecycle event; delete logic in [routers/bays.py](../backend/app/routers/bays.py)
(archive-if-history). Pages: Live Bay Dashboard, Bay Management, both device pages.

### `bay_temp_assignments` — same file
Temporary replacement worker for a bay. **PK** UUID; **FKs** `bay_id`,
`replacement_worker_id`. Columns: `start_date`, `end_date`, `reason`.
API: `POST /bays/{id}/temp-assign`, read by `GET /bays/{id}/current-worker`
(temp wins over primary while today is in range).

### `bay_cameras` — [models/camera_device.py](../backend/app/models/camera_device.py)
IP-camera registry, **one per bay** (`bay_id` unique). **PK** UUID.
Columns: `camera_id` (label e.g. `CAM-01`), `name`, `ip_address`, `rtsp_url`,
`onvif_port` (default 80; router pairs with 554), `username`, `password`
(plain — code notes: encrypt at rest in production), `enabled`, `last_seen`
(heartbeat), `created_at`.
APIs: `/api/v1/cameras` CRUD + test/reconnect/restart/heartbeat. Consumed by
`camera_service.resolve_source()` when a recording starts. Page: Camera Connection.

### `timer_devices` — [models/timer_device.py](../backend/app/models/timer_device.py)
ESP32 physical-timer registry, **one per bay** (`bay_id` unique). **PK** UUID.
Columns: `timer_id` (e.g. `TMR-01`), `name`, `ip_address` + `firmware_version`
(reported by the device over MQTT), `enabled`, `last_seen` (MQTT telemetry),
`created_at`.
APIs: `/api/v1/timers` CRUD + reconnect/restart/test/firmware. Updated by
`mqtt_service._stamp_device()` on telemetry/hello. Page: Timer Connection.

---

## Parts catalog

### `imported_files` — [models/part.py](../backend/app/models/part.py)
One row per imported parts file, with versioning. **PK** UUID; **FK** `uploaded_by`.
Columns: `file_name`, `file_type` (pdf/excel), `uploaded_by_name`, `status`
(active/replaced), counters (`total_records,total_rows,total_codes,dup_skipped,
size_bytes`), `version`, `history` (JSON list of previous versions), `created_at`.
APIs: `/parts/import-rows`, `/parts/import-file`, `/parts/files…`. Page: Parts Time.

### `parts_master`
The part/labour-time catalog. **PK** UUID;
**FK** `source_file_id → imported_files.id ON DELETE CASCADE`
(deleting a file removes its parts). Columns: `product_code`, `part_number`,
`part_name`, `model`, `unit_value`, `unit_time`,
`estimated_time` (**minutes** = `unit_value × conversion`), provenance
(`source_file_name`, `imported_by`), `created_at/updated_at`.
APIs: `/api/v1/parts` CRUD/search, `/parts/estimate-from-job-card`. Consumed by
`_match_service_time()` in [routers/jobs.py](../backend/app/routers/jobs.py) during
PDF extraction.

### `unit_conversion_settings`
Append-only history of the minutes-per-unit factor. **PK** UUID;
**FK** `changed_by`. Columns: `value_minutes`, `previous_value`, `changed_at`,
`records_affected`. Latest row wins (`_conversion()` orders by `changed_at desc`).

---

## Jobs & queue

### `job_cards` — [models/job.py](../backend/app/models/job.py)
The job (vehicle + customer + requested work). **PK** UUID;
`job_card_number` unique (e.g. `JC-1073`). **FKs:** `customer_id → users.id`,
`branch_id`, `created_by → users.id`.
Columns: vehicle (`vehicle_number, vehicle_model, chassis_number, engine_number,
km_reading`), customer contact (`customer_name/mobile/email/address`),
service (`service_type, repair_type, estimated_cost, estimated_minutes` default 45),
Customer Voice (`complaint`, `notes`), `services` **JSON** (the parsed
service/parts-time analysis from PDF extraction), `source_type` (manual/pdf),
`original_pdf_url`, `created_at`.
APIs: `/jobs/manual`, `/jobs/{id}`, `/jobs/extract-pdf`, `/jobs/save-to-queue`.
Read by queue/dashboard/worker/customer/reports for display.

### `job_queue`
Per-worker ordered to-do list. **PK** UUID; **FKs** `job_card_id`, `worker_id`,
`bay_id` (nullable — preferred bay). Columns: `queue_position`,
`status` (`QueueStatus`: queued/assigned/active/completed),
`priority` (`Priority`: high/medium/low), `created_at`.
Created with the job; mutated by every `/api/v1/queue/*` action; marked completed
and "next promoted" (`queue_position=0`) by `workflow_engine._promote_next()`.

---

## Sessions (the live work)

### `service_sessions` — [models/session.py](../backend/app/models/session.py)
One bay visit. **PK:** human ID `SS-YYYY-NNNNNN`
(generated by [utils/ids.py](../backend/app/utils/ids.py) — max-suffix+1,
collision-proof across deletions). **FKs:** `job_card_id`, `worker_id`, `bay_id`,
`customer_id`.
Columns: `status` (`SessionStatus`: assigned/running/paused/completed),
`start_time`, `end_time`, `estimated_duration` (seconds), `actual_duration`,
`overtime_duration`, `created_at`.
**Insert:** `workflow_engine.create_from_assign`. **Update:** `workflow_engine.emit`
only. Read by: bay dashboard, worker/customer portals, reports, master monitoring —
this is the row the whole UI orbits.

### `camera_sessions`
Per-job camera on/off record. **PK:** `CAM-{bay}-{seq}`.
**FK:** `service_session_id ON DELETE CASCADE`, `bay_id`.
Columns: `started_at`, `stopped_at`, `status` (on/off).
Used by Camera Connection's "recording now" count and the workflow engine.

### `recording_sessions`
Video metadata + the whole archival lifecycle. **PK:** `REC-YYYY-NNNNNN`.
**FKs:** `service_session_id CASCADE`, `worker_id`, `customer_id`, `job_card_id`
(denormalised so **ownership checks never need joins** — see `_can_access` in
[routers/recordings.py](../backend/app/routers/recordings.py)).
Columns:

| Group | Columns |
|---|---|
| Playback | `video_url` (Drive URL once archived), `video_path` (local key `recordings/SS-…/video.mp4`), `file_size` (bytes) |
| Drive archival | `drive_file_id`, `drive_url`, `upload_status` (local/pending/uploading/uploaded/failed), `upload_attempts`, `upload_error`, `uploaded_at` |
| Timing | `recording_start`, `recording_end`, `duration_seconds`, `created_at`, `expiry_date` (= completion + 14 d) |
| State | `status` (`RecordingStatus`: idle/recording/active/expiring/expired), `is_deleted` |

**Insert:** create_from_assign. **Update:** workflow engine (capture lifecycle),
`scheduler_service` (upload + retention). **Never deleted** — expiry flags
`is_deleted=true` and the row remains for history.
APIs: `/api/v1/recordings/{id}` + `/stream`, `/api/v1/storage`, recording cells in
worker/customer/reports responses.

### `notifications`
Customer in-app feed. **PK** UUID; **FK** `customer_id`. Columns:
`service_session_id`, `type` (SERVICE_STARTED/PAUSED/RESUMED/COMPLETED),
`message`, `channels` (comma list e.g. `SMS,Email,In-App`), `read`, `created_at`.
Written only by `workflow_engine._notify()`; read by `GET /customer/notifications`.

---

## Operations

### `audit_logs` — [models/audit.py](../backend/app/models/audit.py)
Append-only audit trail. **PK** UUID; **FK** `changed_by → users.id`.
Columns: `action` (e.g. `JOB_STARTED`, `BAY_DELETE`, `PARTS_IMPORT`,
`CAMERA_PAIR`, `STORAGE_SYNC_NOW`), `entity_type`, `entity_id`,
`old_value`/`new_value` (JSON), `timestamp`.
Written via [utils/audit.log_action()](../backend/app/utils/audit.py) from every
router and the workflow engine. Read by: Master → Audit Logs
(`GET /platform/activity`), the notification bell, the per-job timeline
(`GET /platform/timeline/{SS}`), and Parts Time's audit drawer (`GET /parts/audit`).

### `leave_requests` — [models/leave.py](../backend/app/models/leave.py)
**PK** UUID; **FKs** `worker_id`, `decided_by`. Columns: `from_date`, `to_date`,
`days`, `leave_type`, `reason`, `status` (`LeaveStatus`: pending/approved/rejected),
`decided_at`, `created_at`.
APIs: `/api/v1/leave` (worker apply / admin decide). Pages: Worker → Attendance &
Leave; Admin → Leave Approvals.

---

## Who touches what (service ↔ table matrix)

| Backend module | Inserts | Updates | Deletes |
|---|---|---|---|
| [workflow_engine.py](../backend/app/services/workflow_engine.py) | service_sessions, camera_sessions, recording_sessions, notifications, audit_logs | service_sessions, camera_sessions, recording_sessions, bays, job_queue | — |
| [scheduler_service.py](../backend/app/services/scheduler_service.py) | — | recording_sessions (upload + retention fields) | local files + Drive files (never DB rows) |
| [mqtt_service.py](../backend/app/services/mqtt_service.py) | — | timer_devices (last_seen, ip, firmware) | — |
| [routers/*](../backend/app/routers/) | their own entities + audit_logs | their own entities | bays (guarded), cameras, timers, parts, files, queue items, workers |
| [utils/timer.py](../backend/app/utils/timer.py) | — (Redis only) | — | — |
