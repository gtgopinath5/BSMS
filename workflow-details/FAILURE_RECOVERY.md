# FAILURE_RECOVERY — Phase 7

> How Baywatch Service OS behaves when a dependency dies and comes back. Each row
> below is mapped to the **actual recovery code** that runs, plus what is verified
> by automated test vs. what is design-bounded (needs real hardware to exercise).
>
> Design principle: **every external dependency degrades, never crashes the app.**
> The backend timer (Redis) is the single source of truth; MQTT, FFmpeg, Drive and
> the cameras are all *consumers* that reconcile back to it on reconnect.

Recovery entrypoints all run inside the FastAPI **lifespan** on every boot
([app/main.py](../backend/app/main.py)):

```
init_db → ensure_*_schema → storage.ensure_buckets → seed?
  → timer.restore_all()          # Redis → in-memory recompute
  → _reconcile_sessions()        # DB running/paused ↔ Redis ↔ recordings
  → recording_service.restore()  # reap orphan ffmpeg children
  → scheduler_service.start()    # archive + retention sweeps
  → mqtt_service.start()         # connect; on_connect republishes all timers
```

---

## The 10 scenarios

| # | Failure | What survives & how it recovers | Code | Verified |
|---|---|---|---|---|
| 1 | **Backend restart during an active job** | Timer, session, worker, bay state and recording all recover (details below) | `timer.restore_all`, `_reconcile_sessions`, `recording_service.restore` | ✅ automated |
| 2 | **Browser refresh** (worker / admin / master) | No client state is authoritative — every page re-polls (`useBWPoll`) or reconnects its socket; auth is per-tab `sessionStorage` | frontend `useBWPoll`/`useBWSocket` | ✅ by design |
| 3 | **Mini-PC / host restart** | = ordered restart of Postgres + Redis + backend; scenario 1 runs once the backend boots; ESP32s re-`hello` and resync | systemd ordering (DEPLOYMENT_GUIDE) | ⚠️ design |
| 4 | **MQTT broker drop / reconnect** | paho auto-reconnects (1–30 s backoff); `_on_connect` re-subscribes + `_publish_all_active()` repaints every ESP32 from the current backend clock | `mqtt_service._on_connect`, `reconnect_delay_set` | ⚠️ design |
| 5 | **Camera disconnect** | RTSP open failure is caught by a 2 s watchdog; capture falls back to a real (synthetic) source so the segment is never empty; reconnect re-probes on next START/RESUME | `recording_service._guard_rtsp` | ⚠️ design |
| 6 | **Google Drive upload failure** | Local file is **kept**, row marked `failed`, retried next sweep; nothing is deleted until a size-verified upload commits | `scheduler_service._upload_one` | ✅ logic |
| 7 | **FFmpeg crash** | Segmented `.ts` means a killed segment is still playable; orphan PIDs are SIGKILL-reaped on boot and the session marked `interrupted`; RESUME spawns a fresh segment | `recording_service.restore`, `_terminate`, segment model | ✅ logic |
| 8 | **Redis reconnect** | Timers are written on **every** state change and timestamp-anchored, so remaining/overtime recompute exactly after reconnect — no drift | `utils/timer.py` (`_write` on each op, `_elapsed`) | ✅ automated |
| 9 | **PostgreSQL reconnect** | SQLAlchemy pool re-establishes connections; an unhandled error returns the standard JSON envelope (CORS-safe) instead of a bare 500 | `catch_all_errors` middleware, engine pool | ⚠️ design |
| 10 | **Network interruption** | Each subsystem is independent and self-healing: timer (local Redis), MQTT (backoff), Drive (retry), camera (watchdog) — a partition degrades features, never corrupts state | all of the above | ⚠️ design |

`✅ automated` = exercised by `.verify/bw_hardening.py`. `✅ logic` = the recovery
code path is unit-reachable and reviewed. `⚠️ design` = correct by construction but
needs the real device/host to exercise end-to-end (documented honestly, not claimed).

---

## Scenario 1 in detail — backend restart during an active job (the hard one)

This is the scenario operators fear, so it has the most machinery and a real test.

**What is persisted while a job runs**
- **Redis** holds the timer: `service_session_id, job_card_id, worker_id, bay_id,
  estimated_duration, start_time, pause_time, accumulated_pause_duration,
  current_status`. Written on **every** start/pause/resume. (`utils/timer.py`)
- **Postgres** holds the `ServiceSession` (`running`/`paused`), its `RecordingSession`,
  `CameraSession`, and the `JobQueue` row — all with the frozen `worker_id`.
- **Disk** holds `media/recordings/{session}/state.json` (`status`, `pid`, segments).

**On boot (lifespan order matters):**
1. `timer.restore_all()` reads `bay_timer:active`, reloads each timer, and
   recomputes elapsed/remaining/overtime from the **absolute** `start_time`
   (so a 10-minute outage doesn't lose 10 minutes — the clock is wall-anchored).
2. `_reconcile_sessions()` selects every `running`/`paused` `ServiceSession` and
   cross-checks it against Redis + its `RecordingSession`. If Redis still has the
   timer → logged as re-synced. If Redis lost it (e.g. flushed) → logged
   **`ERROR … admin must re-Start the bay`** (surfaced loudly, never silently wrong).
3. `recording_service.restore()` walks `media/recordings/*`, SIGKILLs any orphan
   FFmpeg PID from the dead process, and marks that session `interrupted` (you
   can't reattach a subprocess handle across a restart — honest about it).
4. `mqtt_service` connects and `_publish_all_active()` repaints every ESP32.

**Proven by test** (`.verify/bw_hardening.py`, “PHASE 7”): a job is started so a
live timer exists in Redis, then a **brand-new OS process** (zero shared memory —
a true cold boot) calls `timer.restore_all()` and reads the state back:

```
restored: 1 · status: RUNNING · elapsed: 2s · remaining: 1798s · worker: 84d1…
DB session still 'running' after the (simulated) restart
```

The timer survived the process boundary, stayed RUNNING, recomputed remaining with
no drift, and carried its frozen worker — and the DB row is still `running`, ready
for reconcile.

---

## Honest limits (what is *not* end-to-end tested here)

| Limit | Why | Mitigation |
|---|---|---|
| Recording **cannot resume the exact frame** after a backend crash | a dead FFmpeg child can't be reattached | prior segments are kept + playable; session marked `interrupted`; next START/RESUME records cleanly |
| Mini-PC restart, MQTT/PG/network reconnect are **design-verified, not hardware-tested** | needs the real broker/host/network to pull the cable | each path is small, isolated, and degrades-not-crashes; covered in [DISASTER_RECOVERY.md](DISASTER_RECOVERY.md) runbook |
| Redis running in **non-persistent** mode loses timers on its own restart | dev convenience; `appendonly no` | production must enable Redis AOF (see [BACKUP_STRATEGY.md](BACKUP_STRATEGY.md)); `/health` reports `timer_persistent` |

See also: [SYSTEM_HEALTH.md](SYSTEM_HEALTH.md) (how to watch these live),
[DISASTER_RECOVERY.md](DISASTER_RECOVERY.md) (operator runbook).
