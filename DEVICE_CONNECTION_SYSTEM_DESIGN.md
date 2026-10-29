# Device Connection System Design — Bay-wise Timers & Cameras

Baywatch Service OS pairs **one physical timer and one IP camera to each bay**. The
backend is the single source of truth: when an admin starts a job on a bay, only that
bay's timer receives MQTT commands and only that bay's camera records. This document
explains the architecture, the hardware, the setup, and the safety rules.

---

## 1. Bay-wise architecture

```
Admin Live Dashboard has N bays
  → Bay Timers & MQTT page  shows N timer cards  (one per bay)
  → Bay Cameras & RTSP page shows N camera cards (one per bay)

Bay 01 → Timer Device 01 → MQTT topic bay/1/*    → Camera 01 → RTSP stream for Bay 01
Bay 02 → Timer Device 02 → MQTT topic bay/2/*    → Camera 02 → RTSP stream for Bay 02
Bay 03 → Timer Device 03 → MQTT topic bay/3/*    → Camera 03 → RTSP stream for Bay 03
```

- One bay never controls another bay's timer or camera.
- Pairing is **one device per bay** (DB-enforced unique `bay_id`).
- The ESP32 only **displays** what the backend publishes; it never computes official time.
- The camera only **streams/records**; it never drives the job workflow.

## 2. Timer hardware components (recommended)

- ESP32-WROOM / ESP32 DevKit
- RGB LED matrix or large 7-segment display
- Industrial power supply + enclosure
- Optional DFPlayer Mini + speaker/buzzer (start/done sounds) — *future optional*
- Dedicated workshop WiFi / router
- MQTT broker (e.g. Mosquitto) reachable from the backend and the ESP32

## 3. ESP32 timer fields (DB: `timer_devices`)

`bay_id` (unique) · `timer_id` (label, e.g. TMR-01) · `name` · `ip_address` ·
`firmware_version` · `enabled` · `last_seen` (heartbeat) · `last_command` ·
`last_command_at` · `last_error`. Topics are derived from the bay number, not stored.

## 4. MQTT topic structure (unchanged — do not rewrite)

```
bay/{n}/start | pause | resume | complete   backend → ESP32  (lifecycle commands)
bay/{n}/test | restart | ota                 backend → ESP32  (admin commands)
bay/{n}/timer                                backend → ESP32  (retained state, ~1s)
bay/{n}/telemetry | hello                    ESP32 → backend  (heartbeat / boot)
```

`{n}` = the globally-unique bay number. Commands are published **only** to the target
bay's topic — never broadcast.

## 5. Timer setup guide

1. Power ON the ESP32 timer.
2. Connect it to the workshop WiFi.
3. Configure the MQTT broker (Bay Timers & MQTT → Broker settings).
4. ESP32 subscribes to `bay/{n}/start|pause|resume|complete|test`.
5. ESP32 publishes heartbeat/state to `bay/{n}/timer`.
6. Open the bay's timer card → enter the Timer ID → Save Pairing.
7. Click Test Timer.
8. If the test succeeds, the timer is ready.
9. Admin Live Dashboard Start now controls only this bay's timer.

## 6. Timer verification checklist

- [ ] MQTT broker shows **Connected**.
- [ ] Bay card shows the correct `command_topic` (`bay/{n}/{event}`) and `state_topic` (`bay/{n}/timer`).
- [ ] Test Timer reaches only `bay/{n}/test`.
- [ ] Status shows **Connected** only after a recent heartbeat (else Offline — honest).
- [ ] Starting one bay does not change another bay's timer.

## 7. Camera hardware recommendation

- CP Plus 4MP PoE IP **bullet** camera (RTSP + ONVIF, H.265/H.264)
- PoE switch + LAN cabling, **static IP** per camera
- Local server (Mini-PC/NVR) recording via **FFmpeg**
- Google Drive archival after job completion (optional)
- Avoid consumer cloud cameras — use PoE/RTSP/ONVIF for local recording.

## 8. CP Plus camera fields (DB: `bay_cameras`)

`bay_id` (unique) · `camera_id` (label) · `name` · `brand` · `ip_address` ·
`rtsp_url` (optional, overrides) · `rtsp_port` (default 554) · `rtsp_path` ·
`onvif_port` · `username` · `password` *(stored server-side, never returned to UI/API)* ·
`enabled` · `last_seen` (last successful probe) · `last_error` (honest probe failure).
**Future optional (not stored yet):** stream_type, transport, codec, resolution, fps, audio.

## 9. RTSP / ONVIF setup guide

1. Use a PoE IP camera (not a cloud camera).
2. Connect it to the PoE switch via LAN.
3. Set a static IP.
4. Enable RTSP (and ONVIF if available) in the camera settings.
5. Create a camera username/password.
6. Open the bay's camera card → enter IP, RTSP port, RTSP path, username, password.
7. Click Test RTSP, then (optionally) Test Recording.
8. If the test passes, the camera is ready.
9. Admin Live Dashboard Start now records only this bay's camera.

Example RTSP (password always masked in the UI):
```
rtsp://USERNAME:****@CAMERA_IP:554/cam/realmonitor?channel=1&subtype=0
```

## 10. Camera verification checklist

- [ ] RTSP URL preview is correct and the password shows as `****`.
- [ ] Test RTSP runs a **real ffprobe** — reachable shows real resolution/codec; unreachable shows honest offline + `last_error`.
- [ ] No `2560x1440@25fps` placeholder, no fake "online".
- [ ] `last_seen` updates only on a successful probe.
- [ ] Recording starts only when a service starts on that bay.

## 11. Admin Start workflow (backend = controller)

When Admin clicks **Start** on Bay XX, the backend:

1. Validates the bay session (lifecycle guard; illegal transition → 409).
2. Starts the backend timer (single source of truth).
3. Publishes the MQTT command to `bay/XX/start` (only that bay).
4. Resolves the camera paired to Bay XX, opens RTSP, starts FFmpeg recording.
5. Updates the Admin Live Dashboard, Worker Portal, and Customer Live Watch (if a link was sent).
6. Pause/Resume/Complete mirror the same bay-scoped path; Complete stops recording and saves the file.
7. Google Drive archival uploads after completion if configured.

Other bays are unaffected. The ESP32 and camera never store business state.

## 12. Database mapping

| Bay | Timer (`timer_devices`) | Camera (`bay_cameras`) |
|-----|--------------------------|-------------------------|
| `bays.id` / `bay_number` | `timer_devices.bay_id` (unique) | `bay_cameras.bay_id` (unique) |
| Live session | `service_sessions` (per job) | `camera_sessions` + `recording_sessions` |

Pairings are additive and persistent. Schema upgrades use idempotent
`ensure_timer_schema()` / `ensure_camera_schema()` (additive `ALTER TABLE … ADD COLUMN`,
PostgreSQL + SQLite, no DROP/DELETE).

## 13. Frontend page structure

- **Bay Timers & MQTT** (`mqtt_timer` tab): collapsible Broker settings → setup guide → one timer card per bay (paired or "Pair this bay") → config drawer (ESP32 details, topics, heartbeat, last command, Start-workflow box, Test/Reconnect/Unpair).
- **Bay Cameras & RTSP** (`camera` tab): collapsible capture defaults → setup guide → one camera card per bay → config drawer (connection, brand, RTSP port/path, masked RTSP preview, credentials, real Connection Test, Start-workflow box, Future-optional, Unpair).
- **Live Bay Dashboard**: each bay card shows a compact **timer badge** and **camera badge** (Paired/Unpaired · id/IP · Connected/Offline/Recording). Start behavior unchanged.

## 14. Backend API flow

- `GET /api/v1/timers` → per-bay rows (status, topics, last_command, conflict).
- `POST /api/v1/timers` pair · `PUT`/`DELETE` edit/unpair · `/test|/reconnect|/restart` publish to the bay topic.
- `GET /api/v1/cameras` → per-bay rows (status, brand, rtsp_port/path, last_error — **never password**).
- `POST /api/v1/cameras` pair · `PUT`/`DELETE` · `/test|/reconnect` run a **real per-bay ffprobe** (`camera_service.probe_camera`).
- `GET /api/v1/bay-dashboard` → live snapshot (per-bay timer/camera/recording state).
- All device routes are `require_admin` + branch-ownership enforced.

## 15. Safety rules

- **Backend is the source of truth** — the ESP32 never computes official time; the camera never drives workflow.
- **No fake green** — timer offline/broker-down and camera unreachable are shown honestly.
- **No broadcast** — timer commands go only to the target bay topic.
- **No raw RTSP password** in the UI, API responses, DOM, or logs (credentials redacted in every probe result).
- **No local recording deletion before a verified Drive upload**; failed/unarchived recordings are kept.
- **No lifecycle rewrite** — Start/Pause/Resume/Complete transition guards (409) are unchanged.
- **No MQTT topic rewrite**, **no recording capture/playback path rewrite**.

## 16. Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| Timer card "Offline" | ESP32 not sending telemetry / WiFi down | Power-cycle ESP32, check WiFi, confirm broker connected |
| "MQTT broker not connected" | Broker unreachable / disabled | Open Broker settings, fix host/port/creds, Reconnect |
| Two bays show "Duplicate timer ID" | Same `timer_id` label on two bays | Rename one label (routing is still correct — keyed on bay number) |
| Camera Test "Unreachable" | Wrong IP/port/path/creds, camera off, RTSP disabled, ffprobe missing | Verify RTSP URL preview, enable RTSP on the camera, install ffmpeg |
| Camera Test "ffprobe/ffmpeg not installed" | No ffmpeg on the server | Install ffmpeg / set FFmpeg path in capture defaults |
| Recording "unavailable" on a running bay | No camera paired for that bay | Pair a camera on the Bay Cameras page |

### Known future hardening

- Camera password is stored server-side but **not yet encrypted at rest** (it is never exposed to UI/API/logs). Encrypting it at rest is a future hardening step and would be wired through the recording source resolver.
- DFPlayer sound, ONVIF reboot, and the extended capture fields (codec/resolution/fps/audio/stream_type/transport) are shown as **Future optional** and are not wired into the recording path yet.
