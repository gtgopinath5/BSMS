# SYSTEM_HEALTH — Phase 9 (observability)

> Operational visibility for the people who run the platform every day: one call
> that answers "is everything healthy, and what is the backlog right now?"
>
> Two surfaces, both real and live:
> - **`GET /health`** (public, unauth) — liveness probe for the load balancer / uptime monitor.
> - **`GET /api/v1/platform/system-health`** (admin/master) — the operator dashboard payload.

## `GET /api/v1/platform/system-health`

Added in [routers/platform.py](../backend/app/routers/platform.py). Admin/master only
(a worker gets **403** — verified). Read-only; aggregates data the system already
records. Every metric the user asked for is present; here is a **live** response:

```jsonc
{
  "overall": "degraded",                       // ok | degraded | down
  "generated_at": "2026-06-12T16:54:21Z",
  "active": {                                  // what is happening right now
    "live_sessions": 0,                        //   running + paused jobs
    "active_timers": 0,                        //   Redis active timers
    "active_recordings": 0,                    //   live ffmpeg children
    "mqtt_clients": 1,                         //   backend↔broker link
    "cameras_online": 0,                       //   seen within 90s
    "esp32_online": 0
  },
  "queues": {                                  // backlogs an operator clears
    "drive_pending": 4,                        //   finished, awaiting upload
    "drive_failed": 0,                         //   upload failed (auto-retried)
    "recordings_interrupted": 0                //   DB says recording, no live ffmpeg
  },
  "subsystems": {
    "database":        { "status": "ok",  "engine": "postgresql+psycopg" },
    "timer_engine":    { "status": "ok",  "backend": "redis", "persistent": true, "active_timers": 0 },
    "mqtt":            { "status": "ok",  "connected": true, "broker": "localhost:1883" },
    "recording_engine":{ "status": "ok",  "engine": "ffmpeg", "active_recordings": 0, "interrupted": 0 },
    "drive":           { "status": "off", "configured": false, "pending_uploads": 4, "failed_uploads": 0 },
    "cameras":         { "status": "degraded", "total": 3, "online": 0, "offline": 3 },
    "esp32_timers":    { "status": "degraded", "total": 2, "online": 0, "offline": 2 },
    "scheduler":       { "status": "ok",  "running": true, "sweep_interval_hours": 6,
                         "last_archive_run": "2026-06-12T16:43:16Z",
                         "last_archive_result": { "uploaded": 0, "skipped": "drive-not-configured" },
                         "last_retention_run": "2026-06-12T16:43:16Z",
                         "last_retention_result": { "purged": 0, "freed_mb": 0.0 } }
  }
}
```

## Coverage of the Phase 9 requirements

| Requirement | Field | Source |
|---|---|---|
| Health dashboard | the whole payload + `overall` rollup | aggregator |
| Active timers | `active.active_timers` / `timer_engine.active_timers` | `timer.active_count()` (Redis) |
| Active recordings | `active.active_recordings` | `recording_service.active_count()` (live ffmpeg PIDs) |
| Active MQTT clients | `active.mqtt_clients` / `mqtt.connected` | `mqtt_service.status()` |
| Camera online count | `active.cameras_online` / `cameras.online` | `bay_cameras.last_seen` ≤ 90 s |
| ESP32 online count | `active.esp32_online` / `esp32_timers.online` | `timer_devices.last_seen` ≤ 90 s |
| Google Drive queue | `queues.drive_pending` | recordings with media, no `drive_file_id` |
| Failed uploads | `queues.drive_failed` / `drive.failed_uploads` | `upload_status = 'failed'` |
| Failed recordings | `queues.recordings_interrupted` | DB `recording` status with **no** live ffmpeg child |
| Failed timer sync | `mqtt.connected` (proxy) | broker link is the sync channel; down ⇒ ESP32s not syncing |
| Failed MQTT publish | `mqtt.status` (`degraded` if enabled-but-disconnected) | `mqtt_service.status()` |
| Last scheduler run | `scheduler.last_archive_run` / `last_retention_run` (+results) | `scheduler_service.health()` (new last-run tracking) |

## Status semantics

| Subsystem status | Meaning |
|---|---|
| `ok` | working |
| `degraded` | working but a watch item (Redis in memory-mode; broker disconnected; a paired device offline; Drive credentials present but unreachable) |
| `off` | a **dormant optional integration** (Drive without credentials) — *not* a fault, does not pull `overall` down |
| `down` | a hard dependency failed (DB unreachable; scheduler thread dead) |

`overall` = `down` if any subsystem is `down`, else `degraded` if any is `degraded`,
else `ok`. In the sample above it is `degraded` purely because the dev box has paired
cameras/ESP32s that aren't powered on (`offline`) — exactly what an operator should see.

## `GET /health` (liveness)

Unauthenticated, cheap, for the load balancer:

```json
{ "db": true, "timer_backend": "redis", "timer_persistent": true,
  "active_timers": 0, "mqtt": {"connected": true, "broker": "localhost:1883"},
  "recording_engine": "ffmpeg", "drive_configured": false, "retention_days": 14 }
```

## Wiring it to alerts (recommended)

- Uptime monitor → `GET /health` every 30 s; page if non-200 or `db:false`.
- Ops dashboard → `GET /platform/system-health` every 10 s; alert when:
  - `overall == "down"`, or
  - `timer_engine.persistent == false` (timers would not survive a restart), or
  - `queues.drive_failed > 0` sustained, or
  - `cameras.online < cameras.total` during business hours.

Verified by `.verify/bw_hardening.py` "PHASE 9" (all 8 subsystems present, live
counters, scheduler last-run fields, worker 403).
