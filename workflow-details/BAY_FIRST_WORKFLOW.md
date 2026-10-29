# BAY_FIRST_WORKFLOW — The Permanent Architecture

> The user-mandated permanent model: **Bay owns Worker · Bay owns Camera · Bay owns
> Timer · Worker never owns Bay · Jobs never own worker-assignment logic.**
> Worker selection exists in exactly ONE place: **Bay Management**.

## Bay commissioning (a bay becomes operational)

```
Create Bay (number auto = max+1, GLOBALLY unique — MQTT topics key on it)
   ↓
Assign Permanent Worker      ← Bay Management drawer · "Assign Primary Worker"
   ↓                            (worker-role validated; admins/customers rejected 400)
Pair Camera                  ← Camera Connection (bay_cameras 1:1)
   ↓
Pair Timer (ESP32)           ← Timer Connection (timer_devices 1:1, topic bay/{n}/timer)
   ↓
BAY IS OPERATIONAL — it can now accept jobs
```

An unstaffed bay is **inactive**: red `NO WORKER` badge in Fleet View, 🔒 disabled in
every bay picker, and the API rejects it everywhere with
`400 "Bay is not operational. Assign a primary worker first."` — including
`force=true` attempts (verified).

## The job flow (admin thinks "which BAY?", never "which worker?")

```
Admin creates Job (manual or PDF)
   ↓  payload contains ONLY bay_id (a client-sent worker_id is IGNORED)
Backend resolves: bay → current worker → queue row in that worker's queue
   ↓
Admin assigns the queue item to the bay (busy bays may be force-overridden;
   unstaffed/maintenance/disabled may NOT)
   ↓  service_session + camera_session + recording_session created
Admin presses START
   ↓  worker re-resolved one final time (temp cover honored) → frozen
   ↓  timer (Redis) + camera (FFmpeg) + ESP32 (MQTT) + customer notify — all
      resolved FROM the bay, automatically
…PAUSE/RESUME…
COMPLETE → durations persisted, video finalised, bay released, next job flagged
```

## Worker replacement (the only worker-selection UI in the product)

```
Worker absent
   ↓  Fleet View drawer → "Replace Worker"
Pick replacement (same branch · worker-role only · not the primary)
   + reason + start/end dates        → bay_temp_assignments
   ↓  one active cover per bay (overlap → 409) · audited (BAY_TEMP_ASSIGN)
While active: resolution priority TEMP > PRIMARY — new jobs/starts go to the temp
   ↓
End date passes  → automatic restore (resolution simply stops matching)
or "Revert Now"  → POST /bays/{id}/revert-worker (audited BAY_WORKER_REVERT)
   ↓
Primary worker restored — bay, camera, timer, ESP32 unchanged throughout
```

## What was removed to make this airtight (Phase 1 hardening)

| Removed/changed | Why |
|---|---|
| Worker dropdown in manual + PDF job forms | Worker is the bay's property. |
| `worker_id` legacy fallback in `POST /jobs/*` | Was an API bypass; now only `bay_id` is honored. |
| `POST /queue/{id}/reassign` endpoint + UI | "Move to another worker" contradicted the model. Moving a job = **Change Bay** (worker follows). |
| `change-bay` with `null` | A queued job must always target a bay. |
| `force` overriding non-operational bays | `force` now only overrides *busy*. |
| Cross-branch duplicate `bay_number` | Globally unique — protects `bay/{n}/*` MQTT topics. |

## Invariants (enforced, tested)

1. No endpoint accepts a worker for a job — anywhere.
2. `resolve_bay_worker()` is the only resolution function; UI never reimplements it.
3. A non-operational bay (unstaffed/maintenance/disabled) cannot receive or start work.
4. Temp covers: validated dates, worker-role only, ≠ primary, no overlap, audited, auto-restoring.
5. Snapshots (`service_sessions.worker_id`) freeze at START and are never rewritten after.

Verified end-to-end by `.verify/bw_verify.py` (37/37) and `.verify/verify_ui.js` (34/34).
