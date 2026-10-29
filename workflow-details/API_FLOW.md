# API_FLOW — Bay-First Endpoint Map (post-hardening)

> Delta document on top of [08_API_DOCUMENTATION.md](08_API_DOCUMENTATION.md):
> what changed for bay-first, and the exact request flows the UI uses now.
> All admin-guarded (`require_admin`) unless noted.

## New endpoints

| Method/URL | Purpose |
|---|---|
| `GET /api/v1/bays/operations` | Fleet View in ONE batched call: per-bay worker (temp>primary), camera/timer/ESP32/MQTT status, current job + live timer, today count, `attention` flag; summary `{total, available, running, maintenance, no_worker, attention}`; attention-sorted. Scales 50–100+ bays (verified at 52). |
| `GET /api/v1/bays/{id}/detail` | Drawer payload: bay info, worker (+perf %, temp details, primary-under-temp), camera/timer device cards (ids, IP, fw, topic), `esp32`, `mqtt`, current job, today, recent history, audit timeline. |
| `POST /api/v1/bays/{id}/revert-worker` | End temp cover early → primary restored (409 if none). Audited. |

## Changed endpoints (the hardening)

| Endpoint | Before | Now |
|---|---|---|
| `POST /jobs/manual` · `/jobs/save-to-queue` | required `worker_id`; later optional with legacy fallback | **`bay_id` required; `worker_id` ignored.** 400 unstaffed (exact message) · 409 maintenance/disabled. |
| `POST /queue/{id}/reassign` | moved a job to a chosen worker | **REMOVED (404).** |
| `POST /queue/{id}/change-bay` | stored a "preferred bay", null allowed | bay required; validates operational; **re-resolves and moves the job to the new bay's worker queue.** |
| `POST /queue/{id}/assign` | only "busy unless force" | + disabled→409, maintenance→409, unstaffed→400 — **`force` cannot bypass any of these.** |
| `PUT /bays/{id}` · `POST /bays` | accepted any user as `primary_worker_id`; bay_number unique per branch | **worker-role validated (400)**; **bay_number globally unique (409)** — MQTT topics key on it. |
| `POST /bays/{id}/temp-assign` | no validation | dates ordered, worker-role only, ≠ primary, **no overlapping cover (409)**, audited `BAY_TEMP_ASSIGN`. |
| `emit(JOB_STARTED)` (internal) | used assign-time worker | **re-resolves from the bay** and syncs session + recording + queue row, then freezes. |

## The three UI flows, end-to-end

**Create job (manual or PDF)**
```
GET /bays/operations ──(picker options: 🔒 non-operational disabled)
POST /jobs/save-to-queue {…, bay_id, priority}      ← NO worker_id
   → resolve_bay_worker → job_cards + job_queue(worker = bay's worker)
```

**Go live**
```
POST /queue/{id}/assign {bay_id, force?}
   → guards (disabled/maintenance/unstaffed/busy) → create_from_assign
   → SS-… + CAM-… + REC-… rows · bay → running
POST /bay-dashboard/{bay_id}/start
   → re-resolve worker (freeze) · Redis timer · FFmpeg · MQTT · notify
```

**Staff a bay (the only worker-selection flow)**
```
PUT  /bays/{id} {primary_worker_id}            (Assign Primary — unstaffed bay)
POST /bays/{id}/temp-assign {replacement_worker_id, start_date, end_date, reason}
POST /bays/{id}/revert-worker                  (Revert Now; auto at end_date)
```

## Error contract (uniform envelope `{success:false, message}`)

| Code | Meaning here |
|---|---|
| 400 | Bay-first rule violated: no bay on a job · unstaffed bay · non-worker user as primary/replacement · bad temp dates · replacement = primary · null change-bay |
| 404 | Unknown bay/queue/timer/camera · removed `reassign` |
| 409 | maintenance/disabled bay · busy without force · duplicate global bay number · overlapping temp cover · revert with no cover |
