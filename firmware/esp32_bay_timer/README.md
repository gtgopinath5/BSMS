# Baywatch ESP32 Bay Timer — Firmware

A physical countdown timer for one service bay. It subscribes to the Baywatch
backend over MQTT and **only displays** what the backend sends — it never
computes time itself, so it can never drift from the backend clock.

## What it does

| Backend event (MQTT)        | Device reaction                                  |
|-----------------------------|--------------------------------------------------|
| `bay/<n>/timer` (1 / sec)   | Show `MM:SS`, set RGB colour (green/orange/red)  |
| `bay/<n>/start`             | 1 beep                                           |
| `bay/<n>/pause`             | Display freezes (PAUSED state holds the value)   |
| `bay/<n>/resume`            | Resume                                           |
| `bay/<n>/complete`          | Completion melody → `dOnE` screen                |
| `bay/<n>/restart`           | Reboot                                           |
| `bay/<n>/test`              | LED + segment + buzzer self-test                 |
| `bay/<n>/ota`               | OTA firmware update (`{"url": "..."}`)           |

Colour stages (computed by the backend, just rendered here):
**green** 100→60 % · **orange** 60→20 % · **red** 20→0 % and all overtime.
Transition beeps: → orange = 2 beeps, → red = 3 beeps.

On boot / reconnect the device publishes `bay/<n>/hello`; the backend replies by
re-publishing the **retained** `bay/<n>/timer` state, so the display resyncs
instantly with zero drift. It also publishes `bay/<n>/telemetry` every 15 s, which
populates the IP / firmware / "last seen" columns in the admin **Timer Connection**
page.

## Hardware

| Part                              | Default pin            |
|-----------------------------------|------------------------|
| ESP32 dev board                   | —                      |
| WS2812 RGB LED / ring (colour)    | `GPIO5` (data)         |
| TM1637 4-digit 7-seg (countdown)  | `CLK GPIO18`, `DIO GPIO19` |
| Passive piezo buzzer (beeps)      | `GPIO23`               |

Power the WS2812 + TM1637 from 5 V (VIN) and share ground with the ESP32.
Pins are configurable at the top of [`include/config.h`](include/config.h).

## Flashing (PlatformIO)

1. Edit [`include/config.h`](include/config.h):
   - `BAY_NUMBER` — the **globally-unique** bay number from the Timer Connection page.
   - `WIFI_SSID` / `WIFI_PASS`.
   - `MQTT_HOST` — the LAN IP of the machine running the backend/Mosquitto
     (the broker listens on all interfaces; **not** `localhost`).
   - `MQTT_PREFIX` — must equal the backend `MQTT_TOPIC_PREFIX` (default `bay`).
2. Build & flash:
   ```bash
   pio run -t upload
   pio device monitor -b 115200
   ```
3. In the admin **Timer Connection** page, **Pair Timer** on the matching bay.
   Within ~15 s the row flips to **Online** with the device IP + firmware.

## Verify without hardware

You can watch exactly what the device would receive:

```bash
mosquitto_sub -h <broker> -t 'bay/#' -v
```

Then START/PAUSE/RESUME/COMPLETE a job for that bay in the admin Live Bay
Dashboard and watch the `bay/<n>/timer` state stream + events.

See [`docs/MQTT_CONTRACT.md`](../../docs/MQTT_CONTRACT.md) for the full payload spec.
