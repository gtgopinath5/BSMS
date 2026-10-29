# OWNERSHIP_MAP — Phase 8 (single source of truth audit)

> The complete dependency chain, who **owns** each fact, where it is **derived**,
> and a duplicate-state audit. Companion to [STATE_FLOW.md](STATE_FLOW.md) and
> [DATABASE_MAPPING.md](DATABASE_MAPPING.md); this doc is the one-page ownership map.
>
> Rule (permanent): **Bay owns Worker · Bay owns Camera · Bay owns Timer ·
> Worker never owns Bay · Jobs never own worker-assignment logic.**

## The dependency chain

```mermaid
flowchart TD
    Bay["BAY  (the operational unit)\nbays.id · bay_number(global) · status · is_active"]
    Bay -->|primary_worker_id / temp cover| Worker["WORKER (users, role=worker)"]
    Bay -->|bay_cameras.bay_id UNIQUE| Camera["CAMERA (registry: rtsp/ip/creds)"]
    Bay -->|timer_devices.bay_id UNIQUE| Timer["TIMER/ESP32 (registry: ip/fw)"]
    Timer -->|derived topic bay/{n}/*| MQTT["MQTT (transport only — owns nothing)"]
    Camera -->|resolve_source| Recording["RECORDING (ffmpeg → .ts → mp4 → Drive)"]
    Bay -->|bay_id| Session["SERVICE SESSION (the work)"]
    Session --> Recording
    Session -->|worker_id frozen @START| History["CUSTOMER / WORK HISTORY"]
    Bay -->|bay_id| Queue["JOB QUEUE (targets a bay)"]
    Queue --> Session
    Session --> PDF["COMPLETION PDF (rendered from session+recording)"]
    Worker -.resolve_bay_worker().-> Session
```

## Ownership table — one owner per fact

| Fact | **Owner** (writes it) | Derived from owner (never stored twice) |
|---|---|---|
| Which worker runs a bay | `bays.primary_worker_id` + active `bay_temp_assignments` | `resolve_bay_worker(bay)` — the **only** resolver |
| Bay identity / MQTT key | `bays.bay_number` (globally unique) | MQTT topics `bay/{n}/timer` — **computed, never stored** |
| Bay's camera | `bay_cameras` (1:1) | recording capture source (`camera_service.resolve_source`) |
| Bay's timer/ESP32 | `timer_devices` (1:1) | device online = `last_seen` within 90 s window |
| Live countdown | **Redis** `bay_timer:{id}` | ESP32 display, dashboard remaining/overtime — all rendered from it |
| Job lifecycle state | `service_sessions.status` | camera/recording/bay status cascade in `workflow_engine.emit` |
| **Worker who did the job** | `service_sessions.worker_id` (frozen @START) | completion report, PDF, recording.worker_id, performance history |
| Queue grouping | `job_queue.worker_id` | projection of the bay's worker (written only by resolution) |
| Recording media | `recording_sessions.video_path` / `drive_file_id` | playback URL, storage dashboard, expiry |
| Who did what (admin) | `audit_logs` (append-only) | activity feed, audit page, job timeline |

## Duplicate-state audit — findings

Every place the **same fact lives in two tables** was examined for whether it is a
true duplicate (a bug — two writers can disagree) or a deliberate snapshot/projection
(history, with exactly one writer). Result:

| Apparent duplicate | Verdict | Reason |
|---|---|---|
| `service_sessions.worker_id` vs `bays.primary_worker_id` | ✅ **snapshot, not duplicate** | the session value is **frozen at START** (history); the bay value is **live** (current). They are *meant* to diverge after a worker change. One writer each. |
| `recording_sessions.worker_id` vs `service_sessions.worker_id` | ✅ snapshot | same freeze instant; written together in `create_from_assign` + re-synced once at `JOB_STARTED`, then immutable. |
| `job_queue.worker_id` vs the bay's resolved worker | ✅ **projection** | written **only** by resolution (intake, change-bay, assign, START). Never client-supplied. Kept so the worker-portal queue query is a simple index lookup. |
| Timer state in Redis vs `service_sessions.status` | ✅ reconciled | Redis = the live clock (source of truth for *time*); DB = the lifecycle status. `_reconcile_sessions()` cross-checks on boot and logs any mismatch loudly. |
| Bay's MQTT topic in code vs DB | ✅ **derived, never stored** | topics are computed from `bay_number`; there is no `topic` column to drift. |
| Device `last_seen` (camera/timer) | ✅ single owner | stamped only by MQTT telemetry / probe; read everywhere, written one place. |

**Duplicates removed / prevented during hardening** (see [PRODUCTION_AUDIT.md](PRODUCTION_AUDIT.md)):
- the legacy client `worker_id` path (a *second* writer of the worker) — **removed**;
- `POST /queue/reassign` (a second way to set the queue worker) — **removed**;
- a stored MQTT topic was never introduced — topics stay derived.

## What owns nothing (important)

- **MQTT** is pure transport. It carries the backend's computed state to the ESP32
  and carries telemetry back. It holds no authoritative state; a broker wipe loses
  nothing (republished within 1 s on reconnect).
- **The ESP32** computes nothing — it renders the retained `bay/{n}/timer` payload.
- **The browser** owns no authoritative state — every portal re-derives from the API.

## Verdict

The model has **one writer per fact**. The values that appear in two tables are
START-frozen snapshots (history) or single-writer projections (queue grouping), not
mutable duplicates — so two parts of the system cannot disagree about the present,
and historical rows never rewrite themselves. The START-freeze invariant that makes
this safe is proven end-to-end in [FINAL_PRODUCTION_CHECKLIST.md](FINAL_PRODUCTION_CHECKLIST.md).
