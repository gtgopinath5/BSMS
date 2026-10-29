# Baywatch MQTT Contract — Backend ↔ ESP32 Bay Timers

This is the authoritative wire contract between the Baywatch backend
(`app/services/mqtt_service.py`) and the physical ESP32 bay timers
(`firmware/esp32_bay_timer/`).

**Golden rule:** the **backend is the single source of truth**. It computes every
value (elapsed, remaining, overtime, colour) and publishes it. The ESP32 **only
renders** what it receives and **never computes time** — so it can never drift.

- Broker: Mosquitto (`MQTT_BROKER_HOST:MQTT_BROKER_PORT`, default `:1883`).
- Topic prefix: `MQTT_TOPIC_PREFIX` (default `bay`), must match the firmware.
- `<n>` is the **globally-unique bay number** (same value shown in the admin
  Timer Connection page; topics key on it).

---

## Backend → ESP32

### `bay/<n>/timer` — timer state  *(retained, QoS 0, published every 1 s)*

The continuous countdown feed. Published once per second for every active timer,
and **retained** so a freshly-booted/reconnected device receives the latest value
immediately.

```json
{
  "bay": 1,
  "session_id": "SS-2026-000123",
  "status": "RUNNING",        // RUNNING | PAUSED | READY | DONE
  "remaining": 1730,          // seconds; NEGATIVE = overtime
  "elapsed": 970,
  "estimated": 2700,
  "overtime": 0,              // seconds past estimate (0 while within estimate)
  "color": "green",           // green | orange | red  (computed by backend)
  "display": "28:50",         // pre-formatted MM:SS (or -MM:SS in overtime)
  "ts": 1781175928
}
```

Colour stages (`mqtt_service.timer_color`): `green` ratio ≥ 0.60 · `orange`
0.20 ≤ ratio < 0.60 · `red` ratio < 0.20 **and all of overtime** (stays red, keeps
counting negative until the admin completes the job).

`status` semantics for the device:
- `RUNNING` → show `display`, apply `color`, beep on colour transition.
- `PAUSED`  → same value held (backend keeps sending the frozen value → display freezes).
- `READY`   → idle (`----`), no colour.
- `DONE`    → show `dOnE`; the bay's job is complete until the next START.

### `bay/<n>/{start|pause|resume|complete}` — lifecycle events  *(QoS 1)*

Fired the instant an admin acts (from `workflow_engine.emit`). Drive the sounds:

```json
{ "event": "start", "bay": 1, "ts": 1781175928 }
```

| Topic     | Device sound / action            |
|-----------|----------------------------------|
| `start`   | 1 beep                           |
| `pause`   | (none — display freezes)         |
| `resume`  | short beep                       |
| `complete`| unique completion melody → `dOnE`|

### `bay/<n>/{restart|test|ota}` — admin commands  *(QoS 1)*

From the Timer Connection action buttons.

- `restart` → `ESP.restart()`.
- `test`    → LED + segment + buzzer self-test (the "Test Display" button).
- `ota`     → OTA firmware update; payload may carry `{"url": "https://…/firmware.bin"}`.

> The **Reconnect** button does not publish a command topic — it re-publishes the
> retained `bay/<n>/timer` state so the device adopts the authoritative value
> immediately (forced resync).

---

## ESP32 → Backend

### `bay/<n>/hello` — boot / reconnect announcement  *(QoS 1)*

Published every time the device connects. The backend responds by re-publishing
the current `bay/<n>/timer` state (resync, no drift).

```json
{ "firmware": "1.0.0", "ip": "192.168.1.77" }
```

### `bay/<n>/telemetry` — heartbeat  *(every ~15 s)*

Populates the registry: `last_seen` (→ online/offline), `ip_address`,
`firmware_version` in the admin Timer Connection page.

```json
{ "firmware": "1.0.0", "ip": "192.168.1.77", "rssi": -58 }
```

A timer counts as **online** if telemetry arrived within the last 90 s.

---

## Recovery guarantees

| Failure                | Recovery                                                                 |
|------------------------|--------------------------------------------------------------------------|
| Backend restarts       | Timers restored from Redis; on MQTT connect the backend re-publishes every active state → devices resync. |
| ESP32 restarts         | On boot it gets the **retained** `timer` message instantly + sends `hello` → backend resyncs. |
| Broker / WiFi drops    | paho (backend) and PubSubClient (device) both auto-reconnect; retained state means no missed final value. |
| MQTT entirely down     | Backend timer + dashboards keep working; physical timers are simply dormant (the backend stays authoritative). |

No timer drift is possible: the device displays only backend-published values and
never runs its own clock.
