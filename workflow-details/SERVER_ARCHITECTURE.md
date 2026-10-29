# SERVER_ARCHITECTURE — Phase 12

> The runtime topology of a Baywatch Service OS deployment: every process, port,
> and dependency, and how they sit on the service-center **mini-PC**.

## Physical topology (one service center)

```
                          ┌────────────────────────── Mini-PC (Linux) ──────────────────────────┐
  Bay cameras (RTSP) ───► │  ffmpeg (per active job)  ──► local SSD /media  ──► Google Drive (opt) │
                          │                                                                        │
  ESP32 bay timers ◄────► │  Mosquitto (MQTT :1883)  ◄──►  FastAPI backend (uvicorn :8000)         │
        (Wi-Fi)           │                                   │   ▲        │                        │
                          │                          Redis :6379   │   PostgreSQL :5432             │
                          │                          (timers)      │   (system of record)           │
  Admin / Worker / ─────► │  Static frontend (serve.py :7890, React UMD — no build)                 │
  Master / Customer       └────────────────────────────────────────────────────────────────────────┘
        (LAN browsers)                         optional WAN → customer recording links
```

## Processes & ports

| Process | Port | Role | Start |
|---|---|---|---|
| **FastAPI backend** (uvicorn) | 8000 | API, workflow engine, timer/MQTT/recording/scheduler services | `python run.py` (dev, reload) → gunicorn/uvicorn workers (prod) |
| **Frontend static server** | 7890 | serves `frontend/` (React 18 UMD + Babel-standalone — zero build step) | `python frontend/serve.py` |
| **PostgreSQL 16** | 5432 | system of record (all tables) | systemd `postgresql` |
| **Redis** | 6379 | persistent bay timers (db 0) + Celery broker (db 1) | systemd `redis` (**AOF on**) |
| **Mosquitto (MQTT)** | 1883 | ESP32 timer transport | systemd `mosquitto` |
| **FFmpeg** | — | invoked as child processes by the recording service | host binary (`ffmpeg`, `ffprobe`) |
| **Celery worker** (optional) | — | async PDF/notification dispatch; app degrades to inline no-op without it | systemd `celery` |

## Process model inside the backend (one uvicorn worker)

The FastAPI lifespan starts three daemon threads + one MQTT loop (see
[FAILURE_RECOVERY.md](FAILURE_RECOVERY.md)):
- **scheduler thread** — archive + retention sweeps every 6 h.
- **MQTT state-publisher thread** — pushes every active timer state once per second.
- **MQTT network loop** (paho `loop_start`) — connection + telemetry callbacks.
- recording **FFmpeg children** — one per *running* job (not per bay).

> **Multi-worker note:** the in-process timer/MQTT/scheduler threads assume **one
> backend worker** owns the device side. Run uvicorn/gunicorn with **`--workers 1`**
> for the timer/MQTT/scheduler-owning process. If you need more HTTP throughput,
> scale read traffic behind it or split the device services into their own single
> process — do **not** run N workers each publishing MQTT and sweeping Drive.
> (Recorded in [FINAL_PRODUCTION_CHECKLIST.md](FINAL_PRODUCTION_CHECKLIST.md).)

## Data stores & what each owns

| Store | Owns | Persistence |
|---|---|---|
| **PostgreSQL** | system of record: bays, workers, jobs, sessions, recordings (metadata), audit log | nightly dump + WAL (see [BACKUP_STRATEGY.md](BACKUP_STRATEGY.md)) |
| **Redis** | the live countdown for every active bay (timestamp-anchored) | **AOF** so timers survive its own restart |
| **Local SSD `/media`** | recording `.ts` segments → `video.mp4` + live HLS | archived to Drive then pruned; 14-day retention |
| **Google Drive** (optional) | long-term recording archive | Google-side |
| **`.env`** | secrets (jwt_secret, DB URL, MQTT/Drive/SMS creds) | backed up out-of-band, never in git |

## Trust & network boundaries

- Cameras and ESP32s live on the **bay LAN/VLAN**; only the mini-PC talks to them.
- Raw RTSP is **never** exposed to browsers — playback is HLS behind signed/authorized
  URLs (`streaming_service`).
- CORS is locked to the frontend origin(s) (`settings.cors_origins`); the catch-all
  error middleware sits **outside** CORS so even a 500 is browser-readable.
- JWT (`jwt_secret`, 12 h default) gates the API; roles: master / admin / worker /
  customer with scoped endpoints.

## Config surface (`.env`)

`database_url` · `redis_url` · `jwt_secret` · `mqtt_broker_host/port/enabled` ·
`google_drive_credentials/folder_id` · `recording_retention_days` ·
`cors_origins` · `msg91_*` / `sendgrid_api_key` · `seed_on_startup`.
All have safe local defaults; production overrides the secrets + DB URL + CORS.
See [DEPLOYMENT_GUIDE.md](DEPLOYMENT_GUIDE.md) for the production values.
