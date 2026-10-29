# 09 — External Device & Service Integration

> Every external device and third-party service this system talks to, how it
> connects, how the backend and frontend use it, and where the data lands.
> Authoritative wire contract for the timer: [docs/MQTT_CONTRACT.md](../docs/MQTT_CONTRACT.md).
> Each integration is built to **degrade gracefully** — if the device/service is
> absent, the rest of the system keeps running.

```mermaid
flowchart TB
    subgraph Shop floor
        CAM["CP Plus IP Camera (RTSP)"]
        ESP["ESP32 Bay Timer (per bay)"]
        NVR["Mini-PC / NVR (field agent)"]
    end
    subgraph Backend host
        FF["FFmpeg"]
        BE["FastAPI backend"]
        MQ(("Mosquitto broker"))
        SSD[("Local SSD media/")]
    end
    GD[("Google Drive")]
    SMS[["MSG91 SMS"]]
    CAM -- RTSP/TCP --> FF --> SSD
    BE <-- "MQTT bay/#" --> MQ <-- WiFi --> ESP
    NVR -- "POST /cameras/heartbeat" --> BE
    BE -- "Drive API v3" --> GD
    BE -- "HTTPS" --> SMS
    BE --> SSD
```

---

## 1. CP Plus IP Camera (RTSP)

| | |
|---|---|
| **How it connects** | The camera exposes an **RTSP** stream on the LAN. The admin registers it on the **Camera Connection** page: IP, full `rtsp_url`, ONVIF port, username/password → stored in the `bay_cameras` table (one camera per bay). |
| **How the backend talks to it** | When a job starts, [camera_service.resolve_source()](../backend/app/services/camera_service.py) reads the bay's camera, injects credentials into the URL (`rtsp://user:pass@host/path`) **inside the backend only**, and hands it to [recording_service](../backend/app/services/recording_service.py), which runs `ffmpeg -rtsp_transport tcp -i <url> -c:v copy …`. |
| **How the frontend uses it** | Never directly. The browser sees only (a) the camera's online/offline status on the Camera Connection page and (b) a **signed HLS URL** for the live feed — raw RTSP is never sent to a browser. |
| **How data is stored** | Registry → `bay_cameras`; per-job on/off → `camera_sessions`; the captured video → `backend/media/recordings/{SS}/` → `recording_sessions`. |
| **Status / health** | `online` if `last_seen` ≤ 90 s (`ONLINE_WINDOW`), via the Test/Reconnect/Restart buttons (dev simulates the probe) or `POST /api/v1/cameras/heartbeat` from a field agent. Production note in the code: replace the simulated probe with a real RTSP open / ONVIF `GetSystemDateAndTime`. |
| **Dev fallback** | No camera paired or RTSP unreachable → a synthetic `testsrc` source so the pipeline still produces real files; an RTSP watchdog (`_guard_rtsp`) switches to it within ~2 s and logs a WARNING. |

```
Pair (admin) → bay_cameras row
START job → camera_service.resolve_source → FFmpeg(RTSP) → media/recordings/{SS}/seg_*.ts
                                                        → media/hls/{SS}/ (live, signed HLS)
COMPLETE → concat → video.mp4 → recording_sessions.video_path
```

## 2. ESP32 Bay Timer (MQTT)

| | |
|---|---|
| **What it is** | A per-bay physical countdown display — ESP32 + WS2812 RGB ring (colour) + TM1637 4-digit display + piezo buzzer ([firmware/esp32_bay_timer/](../firmware/esp32_bay_timer/)). One firmware per bay (`BAY_NUMBER` set in `include/config.h`). |
| **Golden rule** | **The backend is the single source of truth.** The ESP32 never computes time — it only renders what the backend publishes, so it can never drift. |
| **How it connects** | WiFi → **Mosquitto** broker (`MQTT_BROKER_HOST:1883`), topic prefix `bay`. Pair it on the admin **Timer Connection** page (table `timer_devices`). |
| **How the backend talks to it** | [mqtt_service.py](../backend/app/services/mqtt_service.py) publishes the timer state **every second, retained** to `bay/{n}/timer`, lifecycle events to `bay/{n}/{start,pause,resume,complete}`, and admin commands to `bay/{n}/{restart,test,ota}`. The workflow engine fires the events; the 1 s daemon thread drives the countdown. |
| **How it talks back** | `bay/{n}/hello` on boot (→ backend instantly republishes state) and `bay/{n}/telemetry` every ~15 s (→ stamps `timer_devices.last_seen`, `ip_address`, `firmware_version`). |
| **How the frontend uses it** | The Timer Connection page shows online/offline (telemetry ≤ 90 s), IP, firmware, and the broker status; its buttons publish reconnect/restart/test/firmware commands. |
| **Colour stages** (computed by backend, rendered by device) | green ≥ 60 % remaining · orange 20–60 % · red < 20 % and all overtime; transition beeps 2 (→orange) / 3 (→red). |

```mermaid
sequenceDiagram
    participant ESP
    participant MQ as Mosquitto
    participant BE as Backend
    ESP->>MQ: bay/3/hello {fw, ip}
    MQ->>BE: hello
    BE->>MQ: bay/3/timer (retained current state)
    MQ->>ESP: state → render immediately
    loop every 1 s while active
        BE->>MQ: bay/3/timer (retained)
        MQ->>ESP: MM:SS + colour
    end
    ESP-->>MQ: bay/3/telemetry {fw, ip, rssi}  (~15 s)
    MQ-->>BE: telemetry → timer_devices.last_seen
```

Full payloads, QoS levels and recovery guarantees:
[docs/MQTT_CONTRACT.md](../docs/MQTT_CONTRACT.md). Device wiring/pins and flashing:
[firmware/esp32_bay_timer/README.md](../firmware/esp32_bay_timer/README.md).

## 3. MQTT broker (Mosquitto)

| | |
|---|---|
| **Role** | The message bus between backend and every ESP32. Backend client: **paho-mqtt** (`baywatch-backend`, CallbackAPIVersion v2, auto-reconnect 1–30 s). |
| **Config** | `MQTT_BROKER_HOST/PORT/USERNAME/PASSWORD/ENABLED/TOPIC_PREFIX` in [.env](../backend/.env). |
| **Verify without hardware** | `mosquitto_sub -h <broker> -t 'bay/#' -v`, then START/PAUSE/COMPLETE a job and watch the state + events stream. |
| **Down / disabled** | Publishing is silently skipped; the backend Redis timer + dashboards keep working; physical timers go dormant. |

## 4. Google Drive (Drive API v3)

| | |
|---|---|
| **How it connects** | A **service account**: set `GOOGLE_DRIVE_CREDENTIALS` (path to the service-account JSON) and `GOOGLE_DRIVE_FOLDER_ID` in [.env](../backend/.env). Scope `drive.file`. |
| **How the backend talks to it** | [drive_service.py](../backend/app/services/drive_service.py): `files().create` (resumable) → verify remote size == local size → `permissions().create(anyone, reader)` → `webViewLink`; `files().delete` on expiry; `about().get` for the health probe. Driven by [scheduler_service.archive_sweep()](../backend/app/services/scheduler_service.py) every 6 h (or Storage Management → Sync Now / Retry). |
| **How the frontend uses it** | Storage Management shows configured/reachable/account + per-state lists; recording playback **302-redirects to the Drive link** once archived; completion PDF and history show the Drive link. |
| **How data is stored** | `recording_sessions.drive_file_id`, `drive_url`, `video_url`, `uploaded_at`, `upload_status`. |
| **Safety** | Local SSD copy is deleted **only after** a size-verified upload **and** a committed DB row. Unconfigured → dormant (no placeholder upload, nothing deleted). |

## 5. FFmpeg (capture engine)

| | |
|---|---|
| **What** | System binary, discovered via `shutil.which`. The whole recording pipeline runs as tracked FFmpeg child processes ([recording_service.py](../backend/app/services/recording_service.py)). |
| **Inputs** | RTSP (`-c:v copy`, no transcode) or dev `testsrc` (`-re`, libx264 ultrafast). |
| **Outputs** | Segmented MPEG-TS `seg_*.ts` (pause/resume-safe) + live HLS, concatenated to `video.mp4` (`+faststart`) at COMPLETE; `ffprobe` for duration. |
| **Resilience** | State persisted per session (`state.json` + pid); `restore()` reaps orphan processes after a crash. No FFmpeg installed → status `unavailable`, metadata still tracked. |

## 6. Physical Timer vs Software Timer (how they stay in sync)

The **software timer** ([utils/timer.py](../backend/app/utils/timer.py), Redis) is
authoritative and timestamp-anchored. The **physical timer** is a pure mirror over
MQTT. A backend restart restores Redis timers and re-publishes them on MQTT connect;
an ESP32 restart pulls the retained state instantly. Neither can drift because only
one clock exists (the backend's).

## 7. SD Card — honest scope

There is **no SD-card integration in this codebase**. Recording is done by pulling
the camera's RTSP stream to the backend SSD and archiving to Google Drive. A camera's
own SD card / an NVR would be an independent fallback outside this system; the only
device-side touchpoint is the unauthenticated `POST /api/v1/cameras/heartbeat`
liveness ping a Mini-PC/NVR can send.

## 8. Mini-PC / NVR (field agent)

Optional on-site machine. In this codebase its only defined role is to **report
camera liveness** via `POST /api/v1/cameras/heartbeat {camera_id}`, which stamps
`bay_cameras.last_seen` so the Camera Connection page shows the camera online without
the backend itself probing each RTSP stream. (In a larger deployment it could also
host FFmpeg/Mosquitto on the LAN.)

## 9. MSG91 (SMS) & SendGrid (Email)

| | |
|---|---|
| **MSG91** | Real SMS for India ([notification_tasks.py](../backend/app/tasks/notification_tasks.py)): v5 Flow API (DLT template) when `MSG91_FLOW_ID` is set, else legacy `sendhttp`; numbers normalised to `91XXXXXXXXXX`. Sent on SERVICE_STARTED / COMPLETED. Active only when `MSG91_AUTH_KEY` is set; a failed send never breaks the job. |
| **SendGrid** | Email hook present but the actual send call is commented out (stub). The **in-app** notification row is always written regardless. |

---

## Integration health at a glance (`GET /health`)

```json
{ "db": true, "timer_backend": "redis", "timer_persistent": true,
  "active_timers": 2, "mqtt": {"enabled": true, "connected": true, "broker": "localhost:1883"},
  "recording_engine": "ffmpeg", "drive_configured": false, "retention_days": 14 }
```

Each field tells you whether an integration is live: `timer_backend:"memory"` →
Redis down; `mqtt.connected:false` → broker unreachable; `recording_engine:"unavailable"`
→ FFmpeg not installed; `drive_configured:false` → Drive credentials not set
(recordings stay on local SSD). Master → System Settings renders exactly this.
