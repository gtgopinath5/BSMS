# CAMERA_TIMER_MAPPING — How a Bay Resolves Its Devices

> One bay → one camera (`bay_cameras.bay_id UNIQUE`) → one ESP32 timer
> (`timer_devices.bay_id UNIQUE`). The job never references a device — it
> references the **bay**, and the bay resolves everything at the moment of use.

## Camera chain

```
Pair (admin, Camera Connection)        bay_cameras: ip, rtsp_url, onvif_port,
   ↓                                   user/pass, enabled, last_seen
JOB_STARTED / JOB_RESUMED
   ↓
camera_service.resolve_source(db, bay_id)
   ├─ paired + rtsp_url → {kind:"rtsp", input:"rtsp://user:pass@…"}  (creds injected
   │                       SERVER-side only; never sent to a browser)
   └─ none/un-paired    → {kind:"test"} synthetic source (dev keeps working;
                           RTSP watchdog falls back within ~2 s if unreachable)
   ↓
recording_service: FFmpeg → media/recordings/{SS}/seg_*.ts + live HLS
   ↓
COMPLETE → concat video.mp4 → recording_sessions (expiry +14 d → Drive archival)
```

Status model: `online` = `last_seen` within 90 s (probe buttons or
`POST /cameras/heartbeat` from the field agent) · `offline` · `unpaired` · `disabled`.
Surfaced per-bay in `GET /bays/operations` (Fleet dot) and `GET /bays/{id}/detail`
(drawer card with id + IP + actions Test/Reconnect/Restart).

## Timer / ESP32 chain

```
Pair (admin, Timer Connection)         timer_devices: timer_id, enabled, last_seen,
   ↓                                   ip + firmware (reported by the device)
topic derived from the bay:  bay/{bay_number}/timer    (never stored — computed;
                                                        bay_number is GLOBALLY unique)
   ↓
backend publishes (mqtt_service):
   every 1 s   retained state  {status, remaining, color, display…}
   on events   bay/{n}/start|pause|resume|complete
   on admin    bay/{n}/restart|test|ota
   ↓
ESP32 renders only — it never computes time (zero drift by construction)
   ↑
device telemetry (~15 s) → timer_devices.last_seen/ip/firmware
device hello (boot)      → backend republishes current state (instant resync)
```

Status model surfaced to the UI (`/bays/operations`, `/bays/{id}/detail`):

| Field | Meaning |
|---|---|
| `timer` | the device row: `online` (telemetry ≤ 90 s) / `offline` / `unpaired` / `disabled` |
| `esp32` | the *working display*: `synced` = device online **and** MQTT broker connected; `offline` = paired but not synced; `unpaired` |
| `mqtt` | broker connectivity (drawer shows it as its own row) |

## Verified (suite, 12 Jun 2026)

- Bay 03 detail resolves `CAM-03 · 192.168.1.103` purely from `bay_id`.
- Pairing `TMR-VERIFY` to Bay 02 → detail immediately shows the device with topic
  `bay/2/timer`, `esp32: offline` (no telemetry yet); unpair → `unpaired`.
- Duplicate `bay_number` creation is rejected globally (409) so topics can't collide.
- Full lifecycle START→COMPLETE drove FFmpeg capture + MQTT events with **zero
  device identifiers supplied by the client** — everything came from the bay.
