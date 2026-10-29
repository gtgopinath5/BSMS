# 08 — API Documentation (every endpoint)

> Base URL: `http://localhost:8000`. All REST routes are mounted under `/api/v1`
> ([backend/app/main.py](../backend/app/main.py)); WebSockets under `/ws`; live HLS under `/hls`.
> **Every response uses the envelope** `{"success": bool, "data": …, "message": str}`
> ([schemas/common.py](../backend/app/schemas/common.py)) — including errors
> (404/409/422/500 are converted by the exception handlers).
>
> **Auth legend** — 🔓 none · 👤 any logged-in user (`get_current_user`) ·
> 🛠 admin or master (`require_admin`) · 👑 master only (`require_master`) ·
> 🔧 worker (`require_worker`) · 🙋 customer (`require_customer`) ·
> 🎫 HMAC token in query string (no JWT).
> 401 = missing/expired token; 403 = valid token, wrong role/ownership.

---

## System — [main.py](../backend/app/main.py)

| Method | URL | Auth | Purpose |
|---|---|---|---|
| GET | `/` | 🔓 | Service banner `{docs:"/docs"}`. |
| GET | `/health` | 🔓 | Liveness + subsystem status: `db`, `timer_backend` (redis/memory), `timer_persistent`, `active_timers`, `mqtt {enabled,connected,broker,prefix}`, `recording_engine` (ffmpeg/unavailable), `drive_configured`, `retention_days`. Used by the frontend `ping()` and Master → System Settings. |

## Auth — [routers/auth.py](../backend/app/routers/auth.py) · `/api/v1/auth`

| Method | URL | Auth | In → Out |
|---|---|---|---|
| POST | `/auth/login` | 🔓 | `{username, password}` (username **or** employee_id **or** email) → `{access_token, token_type, role, branch_id, user_id, name}`. Workflow: frontend stores token in sessionStorage and routes to the role's portal. |
| POST | `/auth/logout` | 👤 | Stateless acknowledgement (client drops the token). |
| GET | `/auth/me` | 👤 | Current identity `{id, name, role, branch_id, employee_id}`. |

## Workers — [routers/workers.py](../backend/app/routers/workers.py) · `/api/v1/workers` · tables: `users`

| Method | URL | Auth | Purpose |
|---|---|---|---|
| GET | `/workers` | 🛠 | All worker users. |
| POST | `/workers` | 🛠 | Create worker (`WorkerCreate`: name, employee_id, username/password, branch…). 409 on duplicate username/employee_id. |
| GET | `/workers/{id}` | 🛠 | One worker. |
| PUT | `/workers/{id}` | 🛠 | Partial update (`WorkerUpdate`). |
| DELETE | `/workers/{id}` | 🛠 | Delete worker. |
| POST | `/workers/{id}/photo` | 🛠 | Multipart photo → MinIO `profile-photos` → signed URL on `profile_photo_url`. |

## Bays — [routers/bays.py](../backend/app/routers/bays.py) · `/api/v1/bays` · tables: `bays`, `bay_temp_assignments`

| Method | URL | Auth | Purpose |
|---|---|---|---|
| GET | `/bays` | 🛠 | Active (non-archived) bays + primary worker name. |
| POST | `/bays` | 🛠 | Create (bay_number auto = max+1 when omitted; 409 if taken). |
| PUT | `/bays/{id}` | 🛠 | Edit name/description/camera_channel/primary worker/status. |
| POST | `/bays/{id}/duplicate` | 🛠 | Copy a bay onto the next number. |
| POST | `/bays/{id}/status` | 🛠 | `{status: available|maintenance|disabled}`; 409 if the bay has an active session. |
| DELETE | `/bays/{id}` | 🛠 | **Safe delete**: detaches pending queue items, removes temp assignments; with history → *archive* (`is_active=false`), empty → hard delete. 409 if active. Never a raw 500. |
| POST | `/bays/{id}/temp-assign` | 🛠 | Temporary replacement worker `{replacement_worker_id, start_date, end_date, reason}`. |
| GET | `/bays/{id}/current-worker` | 🛠 | Who runs the bay today (temp overrides primary). |

## Cameras — [routers/cameras.py](../backend/app/routers/cameras.py) · `/api/v1/cameras` · tables: `bay_cameras`, `camera_sessions`

| Method | URL | Auth | Purpose |
|---|---|---|---|
| GET | `/cameras` | 🛠 | All bays + camera status (`online` ≤90 s heartbeat / `offline` / `unpaired` / `disabled`) + summary incl. live "recording" count. |
| POST | `/cameras` | 🛠 | Pair camera to a bay (one per bay, 409 otherwise): camera_id, ip, rtsp_url, onvif_port, username/password. |
| PUT | `/cameras/{id}` | 🛠 | Edit registry fields / enable-disable. |
| DELETE | `/cameras/{id}` | 🛠 | Unpair. |
| POST | `/cameras/{id}/test` | 🛠 | Connection test (dev: simulated probe stamps `last_seen`; returns latency/resolution/fps). |
| POST | `/cameras/{id}/reconnect` | 🛠 | Re-probe → online. |
| POST | `/cameras/{id}/restart` | 🛠 | Restart command (simulated probe in dev). |
| POST | `/cameras/heartbeat` | 🔓 (device) | `{camera_id}` liveness ping from field agent/NVR; matched on camera_id. |

## Timers (ESP32) — [routers/timers.py](../backend/app/routers/timers.py) · `/api/v1/timers` · tables: `timer_devices` (+MQTT)

| Method | URL | Auth | Purpose |
|---|---|---|---|
| GET | `/timers` | 🛠 | All bays + timer status (MQTT telemetry heartbeat ≤90 s), device IP/firmware, MQTT broker summary. |
| POST | `/timers` | 🛠 | Pair an ESP32 to a bay (one per bay) → returns its topic `bay/{n}/timer`; pushes current state immediately. |
| PUT | `/timers/{id}` | 🛠 | Edit label/name/enabled. |
| DELETE | `/timers/{id}` | 🛠 | Unpair. |
| POST | `/timers/{id}/reconnect` | 🛠 | Force state resync (republish authoritative countdown). |
| POST | `/timers/{id}/restart` | 🛠 | MQTT `bay/{n}/restart` → device reboots. |
| POST | `/timers/{id}/test` | 🛠 | MQTT `bay/{n}/test` → LED/segment/buzzer self-test. |
| POST | `/timers/{id}/firmware` | 🛠 | MQTT `bay/{n}/ota` → OTA update (audited). |

## Parts — [routers/parts.py](../backend/app/routers/parts.py) · `/api/v1/parts` · tables: `parts_master`, `imported_files`, `unit_conversion_settings`, `audit_logs`

| Method | URL | Auth | Purpose |
|---|---|---|---|
| GET | `/parts` | 🛠 | Search/filter/paginate parts (`q`, `source_file_id` incl. `manual`, `model`, `page`, `size`); returns `{total, page, size, mpu, items}`. |
| POST | `/parts` | 🛠 | Add part manually (409 duplicate part_number); `estimated_time = unit_value × mpu`. |
| PUT | `/parts/{id}` | 🛠 | Edit part (recalculates estimated_time). |
| DELETE | `/parts/{id}` | 🛠 | Delete part. |
| GET | `/parts/models` | 🛠 | Distinct model names. |
| POST | `/parts/import-rows` | 🛠 | **Main import path** — client-extracted rows (`{file_name, file_type, size_bytes, rows:[{pn,name,code,model,units}]}`); global case-insensitive dedupe by part_number; → `{file_id, added, dup_skipped, codes…}`. |
| POST | `/parts/files/{id}/replace` | 🛠 | Replace a file's parts with a new version (history archived, version+1). |
| POST | `/parts/import-file` | 🛠 | Legacy server-side parse (multipart Excel/PDF, small files). |
| GET | `/parts/files` | 🛠 | Imported files with counters/version/history. |
| GET | `/parts/files/{id}` | 🛠 | File detail + its parts + total estimate. |
| GET | `/parts/files/{id}/dependencies` | 🛠 | Active-usage check (currently always `{hasActive:false}` — job cards don't persist part links; kept honest for the cascade-delete UI). |
| DELETE | `/parts/files/{id}` | 🛠 | Delete file → **CASCADE deletes its parts**. |
| GET | `/parts/audit` | 🛠 | Friendly parts audit feed (IMPORT/REPLACE/CREATE/UPDATE/DELETE/CONFIG). |
| POST | `/parts/estimate-from-job-card` | 🛠 | Upload job-card PDF/Excel → extract part numbers → match → `{total_estimated_minutes, matched, unmatched}`. |
| GET | `/parts/unit-conversion` | 🛠 | Current minutes-per-unit. |
| POST | `/parts/unit-conversion` | 🛠 | `{value_minutes, confirm:true}` → recalculates **every** part; history row + audit. 400 without confirm. |

## Jobs — [routers/jobs.py](../backend/app/routers/jobs.py) · `/api/v1/jobs` · tables: `job_cards`, `job_queue`

| Method | URL | Auth | Purpose |
|---|---|---|---|
| POST | `/jobs/manual` | 🛠 | Create job card + queue it (`JobCardCreate`, requires `worker_id`) → `{job_card_id, job_card_number, queue_id}`. Triggers: queue insert + audit. |
| PUT | `/jobs/{job_card_id}` | 🛠 | Edit job card fields. |
| POST | `/jobs/extract-pdf` | 🛠 | Multipart PDF → Triumph/Bajaj template extraction + Customer-Voice service mapping + Parts-Time matching → `{valid, score, fields, services, analysis, total_estimated_minutes}` (or `valid:false` + missing keywords). |
| POST | `/jobs/save-to-queue` | 🛠 | Same as `/manual` (used after the extract-review screen). |

## Queue — [routers/queue.py](../backend/app/routers/queue.py) · `/api/v1/queue` · tables: `job_queue` (+ session creation)

| Method | URL | Auth | Purpose |
|---|---|---|---|
| GET | `/queue` | 🛠 | All non-completed queue items **grouped by worker**, each with full job-card detail. |
| GET | `/queue/{id}` | 🛠 | One item (drawer). |
| DELETE | `/queue/{id}` | 🛠 | Remove + renumber that worker's queue. |
| POST | `/queue/{id}/move` | 🛠 | `{direction:"up"|"down"}` swap with neighbour. |
| POST | `/queue/{id}/reassign` | 🛠 | `{worker_id}` → end of new worker's queue. |
| POST | `/queue/{id}/change-bay` | 🛠 | `{bay_id|null}` preferred bay. |
| POST | `/queue/{id}/assign` | 🛠 | `{bay_id, force}` → **workflow `create_from_assign`**: creates `service_sessions` (assigned) + `camera_sessions` + `recording_sessions`, bay→running. 409 if bay busy and not forced. |

## Bay Dashboard — [routers/bay_dashboard.py](../backend/app/routers/bay_dashboard.py) · `/api/v1/bay-dashboard`

| Method | URL | Auth | Purpose → workflow event |
|---|---|---|---|
| GET | `/bay-dashboard` | 🛠 | Live snapshot (`snapshots.dashboard`): every non-completed session + bay + worker + live timer. |
| POST | `/bay-dashboard/{bay_id}/start` | 🛠 | `emit(JOB_STARTED)` → timer+camera+recording+MQTT+notify. Returns the timer state. |
| POST | `/bay-dashboard/{bay_id}/pause` | 🛠 | `emit(JOB_PAUSED)`. |
| POST | `/bay-dashboard/{bay_id}/resume` | 🛠 | `emit(JOB_RESUMED)`. |
| POST | `/bay-dashboard/{bay_id}/complete` | 🛠 | `{actual_duration?, notes}` → `emit(JOB_COMPLETED)` → finalise video, expiry +14 d, release bay, promote next, PDF, notify. |

## Worker portal — [routers/worker.py](../backend/app/routers/worker.py) · `/api/v1/worker` (view-only)

| Method | URL | Auth | Purpose |
|---|---|---|---|
| GET | `/worker/active` | 🔧 | The worker's live job (assigned/running/paused) — or the most recent **completed** one (so the result + recording stay visible). Full payload: timer, job card sections, parts table, camera/recording status, timeline. |
| GET | `/worker/queue` | 🔧 | Own queued/assigned jobs in order. |
| GET | `/worker/history` | 🔧 | Own completed sessions: est/actual/overtime, score, recording cell (signed URL or expired). |

## Customer portal — [routers/customer.py](../backend/app/routers/customer.py) · `/api/v1/customer` (own data only)

| Method | URL | Auth | Purpose |
|---|---|---|---|
| GET | `/customer/active-service` | 🙋 | Own active service: vehicle, status, remaining seconds, `live_feed_url` (signed HLS, **only while running**). No bay/camera internals ever. |
| GET | `/customer/service-history` | 🙋 | Own completed services + recording block (status/duration/days-left/signed URL/Drive link/expired message). |
| GET | `/customer/history/{session_id}` | 🙋 | One service detail (404 if not theirs). |
| GET | `/customer/notifications` | 🙋 | In-app feed (type, message, channels, read, time). |

## Leave — [routers/leave.py](../backend/app/routers/leave.py) · `/api/v1/leave` · tables: `leave_requests`

| Method | URL | Auth | Purpose |
|---|---|---|---|
| POST | `/leave` | 🔧 | Apply `{from_date, to_date, reason, leave_type}` (days computed; 400 if range invalid). |
| GET | `/leave/mine` | 🔧 | Own requests. |
| GET | `/leave` | 🛠 | All requests. |
| POST | `/leave/{id}/approve` · `/reject` | 🛠 | Decide (records decided_by/at, audited). |

## Reports — [routers/reports.py](../backend/app/routers/reports.py) · `/api/v1/reports`

| Method | URL | Auth | Purpose |
|---|---|---|---|
| GET | `/reports/worker-performance?worker_id=` | 🛠 | Completed sessions: est/actual/overtime min, `score = 100 or max(70, 100−ot//3)`, recording cell. |
| GET | `/reports/work-completion` | 🛠 | Enriched completion log (worker/bay/branch names, times, score, recording cell). **Branch admins see only their branch; master sees all** (filtered server-side). |
| GET | `/reports/branch-summary` | 🛠 | `{completed, on_time, on_time_rate}`. |

## Recordings — [routers/recordings.py](../backend/app/routers/recordings.py) · `/api/v1/recordings` · tables: `recording_sessions`

| Method | URL | Auth | Purpose |
|---|---|---|---|
| GET | `/recordings/{recording_id}` | 👤 + ownership | Role/ownership-checked metadata (admin/master: all · worker: own jobs · customer: own services; otherwise **403**). Active → `{…, available:true, playback_url:"/api/v1/recordings/{id}/stream?token=…&exp=…"}`. Expired → `{available:false, message:"This service recording has expired and is no longer available."}`. |
| GET | `/recordings/{recording_id}/stream?token=&exp=` | 🎫 HMAC (TTL 2 h, capped at expiry) | Plays the video: expired → **410** with the friendly message · bad token → 403 · archived → **302 redirect to Google Drive** · else serves the local MP4 with **HTTP Range (206)** for seeking. Raw SSD paths never exposed. |

## Storage — [routers/storage_admin.py](../backend/app/routers/storage_admin.py) · `/api/v1/storage`

| Method | URL | Auth | Purpose |
|---|---|---|---|
| GET | `/storage` | 🛠 | Full overview: Drive health (configured/reachable/account), local SSD bytes, counts + lists (pending/failed/archived/expired), retention days, sweep interval. |
| POST | `/storage/sync-now` | 🛠 | Run the Drive archive sweep now (background thread); honest message when Drive unconfigured. Audited. |
| POST | `/storage/retry/{recording_id}` | 🛠 | Retry one failed upload end-to-end. 404 unknown. Audited. |

## Platform — [routers/platform.py](../backend/app/routers/platform.py) · `/api/v1/platform` (read-only)

| Method | URL | Auth | Purpose |
|---|---|---|---|
| GET | `/platform/search?q=` | 🛠 | Global search (Ctrl+K) across jobs, workers, customers, bays, cameras, timers, recordings — ≤5 per group, each hit carries a `nav` target tab. |
| GET | `/platform/activity?q=&limit=` | 🛠 | Newest-first audit events (notification bell + Audit Logs page). |
| GET | `/platform/timeline/{session_id}` | 🛠 | One job's full event timeline: audit trail + RECORDING_STARTED/FINALIZED + DRIVE_UPLOAD_COMPLETE + PDF_AVAILABLE. |

## Master — [routers/master.py](../backend/app/routers/master.py) · `/api/v1/master`

| Method | URL | Auth | Purpose |
|---|---|---|---|
| GET | `/master/branches` | 👑 | Branches + bay/crew/live counts. |
| POST | `/master/branches` | 👑 | Create branch `{id, name, location}` (409 duplicate). |
| GET | `/master/admins` | 👑 | Branch admins. |
| POST | `/master/admins` | 👑 | Create admin bound to a branch (409 duplicate username, 400 unknown branch). |
| GET | `/master/live-monitoring` | 👑 | All running sessions + signed live-feed URLs (view-only). |
| GET | `/master/bay-monitoring` | 👑 | Per-branch bay cards: session/worker/timer/camera/recording status + live feed **only while RUNNING**. |
| GET | `/master/global-analytics` | 👑 | `{branches, completed_jobs, on_time_rate}`. |

## WebSockets — [routers/ws.py](../backend/app/routers/ws.py) · `/ws` (JWT via `?token=`, push every 1 s)

| URL | Roles | Pushes |
|---|---|---|
| `/ws/bay-dashboard` | admin, master_admin | `snapshots.dashboard` (same shape as the REST GET). |
| `/ws/worker` | worker | `snapshots.worker_active` — own active job payload. |
| `/ws/customer` | customer | `snapshots.customer_active` — own active service. |

Close codes: `4401` unauthorized (frontend logs out) · `4403` wrong role (frontend
stops reconnecting). Frame shape: `{"data": …}`.

## Live HLS — [routers/streaming.py](../backend/app/routers/streaming.py) · `/hls` 🎫 (HMAC, TTL 1 h)

| Method | URL | Purpose |
|---|---|---|
| GET | `/hls/secure/{session_id}/stream.m3u8?token=&exp=` | Token-verified live playlist; segment URIs rewritten to carry the token. 404 when the session isn't live (not started / paused / completed). |
| GET | `/hls/secure/{session_id}/{segment}?token=&exp=` | Token-verified `.ts` segment (traversal-guarded, no-store). |

---

## Cross-cutting behaviour

* **CORS:** origins from `CORS_ORIGINS`; the catch-all error middleware sits *inside*
  CORS so even unhandled 500s return the JSON envelope **with** CORS headers.
* **Auditing:** every mutating admin/master action and every workflow event writes
  `audit_logs` via `log_action()`.
* **ID formats:** job `JC-{n}` · session `SS-YYYY-NNNNNN` · recording `REC-YYYY-NNNNNN`
  ([utils/ids.py](../backend/app/utils/ids.py) — derived from max existing suffix,
  never row count).
* **Frontend client:** every endpoint above has a 1-line wrapper in
  [frontend/js/api.js](../frontend/js/api.js) (`window.BW_API.*`).
