# AUDIT_MATRIX — Phase 10 (audit trail)

> Every critical action is traceable. Two complementary trails, both queryable:
>
> 1. **Append-only audit log** (`audit_logs`, [models/audit.py](../backend/app/models/audit.py)) —
>    *who* did *what*, *when*, with old/new values. Written by `log_action()`.
>    Read via `GET /api/v1/platform/activity?q=&limit=` (notification center + Audit Logs page).
> 2. **Derived event timeline** (`GET /api/v1/platform/timeline/{session_id}`) —
>    per-job milestones synthesised from entity timestamps (recording start/end,
>    Drive upload, PDF availability), interleaved with that job's audit rows.
>
> Anything system-initiated (no admin actor) is recorded with `changed_by = NULL`
> and renders as **"system"** in the feed.

## The required actions → where they are traceable

| Required action | Trail | Action / event | Where logged | New? |
|---|---|---|---|---|
| **Worker replaced** | audit log | `BAY_TEMP_ASSIGN`, `BAY_WORKER_REVERT`, `BAY_UPDATE` (primary) | `routers/bays.py` | — |
| **Bay changed** | audit log | `JOB_CHANGE_BAY` (old→new bay) | `routers/queue.py` | — |
| **Camera paired** | audit log | `CAMERA_PAIR` (+`CAMERA_UPDATE`/`CAMERA_UNPAIR`) | `routers/cameras.py` | — |
| **Timer paired** | audit log | `TIMER_PAIR` (+`TIMER_UPDATE`/`TIMER_UNPAIR`) | `routers/timers.py` | — |
| **ESP32 restarted** | audit log | `ESP32_RESTART` (timer_id, actor) | `routers/timers.py` | ✅ **added** |
| **Job assigned** | audit log | `JOB_ASSIGNED` | `workflow_engine.create_from_assign` | — |
| **Job started** | audit log | `JOB_STARTED` | `workflow_engine.emit` | — |
| **Job paused** | audit log | `JOB_PAUSED` | `workflow_engine.emit` | — |
| **Job resumed** | audit log | `JOB_RESUMED` | `workflow_engine.emit` | — |
| **Job completed** | audit log | `JOB_COMPLETED` | `workflow_engine.emit` | — |
| **Recording started** | timeline | `RECORDING_STARTED` (from `recording_start`) ↔ `JOB_STARTED` | `platform.py` timeline | — |
| **Recording stopped** | timeline | `RECORDING_FINALIZED` (from `recording_end`) ↔ `JOB_COMPLETED` | `platform.py` timeline | — |
| **Drive uploaded** | audit log **+** timeline | `DRIVE_UPLOAD` (file_id, size) **+** `DRIVE_UPLOAD_COMPLETE` (from `uploaded_at`) | `scheduler_service._upload_one` | ✅ **added** |
| **Drive deleted** | audit log | `DRIVE_DELETE` (file_id) | `scheduler_service.retention_sweep` | ✅ **added** |
| **PDF generated** | timeline | `PDF_AVAILABLE` (from session `end_time`) ↔ `JOB_COMPLETED` | `platform.py` timeline | — |
| **Retention cleanup** | audit log | `RETENTION_CLEANUP` (expiry) | `scheduler_service.retention_sweep` | ✅ **added** |

All four ✅ rows are the Phase-10 gap closures. The rest already existed; this phase
**confirmed** them by inventory (a grep of every `log_action` call site) rather than
assuming.

## Why some actions live in the timeline, not the audit log

`Recording started/stopped` and `PDF generated` are **not admin actions** — they are
deterministic consequences of `JOB_STARTED` / `JOB_COMPLETED`, which *are* in the
append-only log. Rather than write a redundant audit row at the same instant, they are
reconstructed exactly from the recording/session timestamps in the job timeline. This
keeps the audit log a clean record of *human + system decisions*, while the timeline
gives the full play-by-play for one job. Both are queryable; nothing is lost.

`Drive uploaded/deleted` and `Retention cleanup` got **real audit rows** (not just
timeline) because they mutate/destroy stored media — a destructive, system-initiated
action deserves a permanent, searchable "system did X to recording Y at time Z" record
independent of the recording row itself (which retention then tombstones).

## The audit record shape

```python
log_action(db, action, entity_type, entity_id, by, old=None, new=None)
# → audit_logs(id, action, entity_type, entity_id, changed_by, old_value, new_value, timestamp)
```

`changed_by` is the admin's user id (rendered as their name) or `NULL` → "system".
`old_value`/`new_value` capture the before/after (e.g. `BAY_DELETE` stores
`{bay_number, mode}`; `DRIVE_UPLOAD` stores `{file_id, size_mb}`).

## Verified

`.verify/bw_hardening.py` "PHASE 10":
- `POST /timers/{id}/restart` → **200**, and `ESP32_RESTART` appears in
  `GET /platform/activity` attributed to the admin (**"A. Krishnan"**) — proven live.
- `DRIVE_UPLOAD`, `DRIVE_DELETE`, `RETENTION_CLEANUP` are asserted present in the
  scheduler source (they fire when Drive is configured; the dev box has no creds,
  so they are wired-and-reviewed rather than live-fired — stated honestly).

## Complete action inventory (33 distinct actions in code today)

```
ADMIN_CREATE · BRANCH_CREATE
BAY_CREATE · BAY_UPDATE · BAY_DUPLICATE · BAY_STATUS · BAY_DELETE
BAY_TEMP_ASSIGN · BAY_WORKER_REVERT
CAMERA_PAIR · CAMERA_UPDATE · CAMERA_UNPAIR
TIMER_PAIR · TIMER_UPDATE · TIMER_UNPAIR · TIMER_FIRMWARE_UPDATE · ESP32_RESTART*
JOB_CREATED · JOB_UPDATED · JOB_ASSIGNED · JOB_STARTED · JOB_PAUSED · JOB_RESUMED · JOB_COMPLETED
JOB_CHANGE_BAY · JOB_QUEUE_REMOVE
PARTS_IMPORT · PARTS_REPLACE · PARTS_CREATE · PARTS_UPDATE · PARTS_DELETE · PARTS_FILE_DELETE · UNIT_CONVERSION_CHANGE
LEAVE_APPROVED / LEAVE_REJECTED (dynamic)
STORAGE_SYNC_NOW · STORAGE_RETRY_UPLOAD · DRIVE_UPLOAD* · DRIVE_DELETE* · RETENTION_CLEANUP*
        (* = added in Phase 10)
```
