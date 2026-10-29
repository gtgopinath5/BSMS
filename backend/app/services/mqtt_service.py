"""MQTT Service — drives the physical ESP32 bay timers.

THE BACKEND IS THE SINGLE SOURCE OF TRUTH. The ESP32 never computes time; it only
renders what the backend publishes. This service:

  • publishes a per-bay timer STATE every second (retained), so a freshly-booted or
    reconnected ESP32 instantly receives the current countdown — no drift, nothing
    to recompute on the device.
  • publishes lifecycle EVENTS (start/pause/resume/complete) the moment the admin
    acts, which the ESP32 uses to trigger its beeps / DONE screen.
  • subscribes to device telemetry + 'hello' so the Timer Connection registry shows
    each ESP32's IP / firmware / last-seen, and so a rebooting ESP32 gets an
    immediate state resync.

Topics (prefix defaults to "bay", bay number is globally unique):
    bay/{n}/timer     ← retained JSON state  (backend → ESP32, every 1s)
    bay/{n}/start|pause|resume|complete   ← events (backend → ESP32)
    bay/{n}/restart|test|ota              ← admin commands (backend → ESP32)
    bay/{n}/telemetry ← {ip, firmware, rssi}  (ESP32 → backend, ~15s)
    bay/{n}/hello     ← {firmware, ip}        (ESP32 → backend, on boot)

If MQTT is disabled or the broker is unreachable, this degrades silently — the
backend timer, dashboards and recordings all keep working (mirrors how the Redis
timer / Drive archival stay dormant when their dependency is absent).
"""
import json
import logging
import socket
import threading
import time

from ..utils import integration_config

log = logging.getLogger("baywatch.mqtt")

try:
    import paho.mqtt.client as mqtt  # type: ignore
    _HAS_PAHO = True
except Exception:  # pragma: no cover
    _HAS_PAHO = False

_client = None
_connected = False
_started = False                # publish-loop thread started (once)
_bay_map: dict[str, int] = {}   # bay_id -> bay_number (cache for the 1s publisher)
_last_message: dict | None = None   # last frame received from a device (status panel)

# Publish options snapshot, refreshed from config on each (re)connect so the hot
# publish path never re-reads/copies the config dict per bay per second.
_opts = {"prefix": "bay", "retain": True, "qos": 1}


def _cfg() -> dict:
    return integration_config.get_config("mqtt_timer")


def is_configured() -> bool:
    return integration_config.is_configured("mqtt_timer")


def _enabled() -> bool:
    return bool(_cfg().get("enabled") and _HAS_PAHO)


def _refresh_opts(cfg: dict) -> None:
    _opts["prefix"] = cfg.get("topic_prefix") or "bay"
    _opts["retain"] = cfg.get("retain_state", True)
    try:
        _opts["qos"] = int(cfg.get("qos", 1))
    except Exception:
        _opts["qos"] = 1


def _prefix() -> str:
    return _opts.get("prefix") or "bay"


# ── topic helpers ──────────────────────────────────────────────────
def _state_topic(n) -> str:
    return f"{_prefix()}/{n}/timer"


def _event_topic(n, event) -> str:
    return f"{_prefix()}/{n}/{event}"


# ── public topic accessors (used by routers for display; never publish here) ──
def prefix() -> str:
    """The live topic prefix actually used by the publisher (config-driven)."""
    return _prefix()


def state_topic(n) -> str:
    """Retained per-bay state topic, e.g. 'bay/1/timer'."""
    return _state_topic(n)


def command_topic(n, event: str = "{event}") -> str:
    """Per-bay command/event topic. Default returns the resolved pattern
    'bay/1/{event}'; pass a concrete event for an exact topic ('bay/1/start')."""
    return _event_topic(n, event)


# ── colour stages (backend computes; ESP32 only displays) ──────────
def timer_color(remaining: int, estimated: int) -> str:
    """Green 100%→60% · Orange 60%→20% · Red 20%→0% and all of overtime."""
    if not estimated or estimated <= 0:
        return "green"
    ratio = remaining / estimated
    if ratio >= 0.6:
        return "green"
    if ratio >= 0.2:
        return "orange"
    return "red"


def _display(remaining: int) -> str:
    neg = remaining < 0
    s = abs(int(remaining))
    return f"{'-' if neg else ''}{s // 60:02d}:{s % 60:02d}"


def build_state(bay_number: int, st: dict) -> dict:
    """Translate a timer.get_state() dict into the ESP32 wire payload."""
    status = st.get("current_status") or "READY"
    remaining = int(st.get("remaining", 0) or 0)
    estimated = int(st.get("estimated_seconds", 0) or 0)
    counting = status in ("RUNNING", "PAUSED")
    return {
        "bay": bay_number,
        "session_id": st.get("service_session_id"),
        "status": status,                                   # RUNNING/PAUSED/READY/DONE
        "remaining": remaining,                             # negative => overtime
        "elapsed": int(st.get("elapsed", 0) or 0),
        "estimated": estimated,
        "overtime": int(st.get("overtime", 0) or 0),
        "color": timer_color(remaining, estimated) if counting else "green",
        "display": _display(remaining),
        "ts": int(time.time()),
    }


# ── DB bay-number lookups (topics key on the globally-unique bay_number) ──
def _refresh_bay_map() -> None:
    global _bay_map
    try:
        from ..database import SessionLocal
        from ..models.bay import Bay
        from sqlalchemy import select
        db = SessionLocal()
        try:
            _bay_map = {b.id: b.bay_number for b in db.scalars(select(Bay)).all()}
        finally:
            db.close()
    except Exception:
        log.exception("[mqtt] bay-map refresh failed")


def _bay_number(bay_id: str):
    n = _bay_map.get(bay_id)
    if n is None:
        _refresh_bay_map()
        n = _bay_map.get(bay_id)
    return n


# ── publish (backend → ESP32) ──────────────────────────────────────
def publish_state(bay_number: int, state: dict) -> None:
    if not _enabled() or not _client:
        return
    try:
        # retained → a reconnecting ESP32 immediately gets the latest countdown
        _client.publish(_state_topic(bay_number), json.dumps(state), qos=0, retain=bool(_opts["retain"]))
    except Exception:
        log.exception("[mqtt] publish_state failed bay=%s", bay_number)


def publish_event(bay_number: int, event: str, payload: dict | None = None) -> None:
    """Lifecycle event or admin command (start/pause/resume/complete/restart/test/ota)."""
    if not _enabled() or not _client:
        return
    body = {"event": event, "bay": bay_number, "ts": int(time.time())}
    if payload:
        body.update(payload)
    try:
        _client.publish(_event_topic(bay_number, event), json.dumps(body), qos=int(_opts["qos"]))
        log.info("[mqtt] → %s", _event_topic(bay_number, event))
    except Exception:
        log.exception("[mqtt] publish_event failed bay=%s event=%s", bay_number, event)


def publish_current_state(bay_id: str, bay_number: int | None = None) -> None:
    """Build + publish the current timer state for one bay (used on START/PAUSE/…,
    on ESP32 'hello' resync, and on backend-restart recovery)."""
    from ..utils import timer
    if bay_number is None:
        bay_number = _bay_number(bay_id)
    if bay_number is None:
        return
    publish_state(bay_number, build_state(bay_number, timer.get_state(bay_id)))


def publish_done(bay_id: str, bay_number: int | None = None) -> None:
    """On COMPLETE the timer is removed from Redis, so publish a final DONE state
    (retained) — the ESP32 shows DONE/READY until the next job starts."""
    if bay_number is None:
        bay_number = _bay_number(bay_id)
    if bay_number is None:
        return
    publish_state(bay_number, {
        "bay": bay_number, "status": "DONE", "remaining": 0, "elapsed": 0,
        "estimated": 0, "overtime": 0, "color": "green", "display": "DONE",
        "ts": int(time.time()),
    })


def _publish_all_active() -> None:
    from ..utils import timer
    for bay_id in timer.active_ids():
        n = _bay_number(bay_id)
        if n is None:
            continue
        publish_state(n, build_state(n, timer.get_state(bay_id)))


# ── subscribe (ESP32 → backend) ────────────────────────────────────
def _stamp_device(bay_number: int, ip: str | None, firmware: str | None) -> None:
    """Update the Timer Connection registry from a device message."""
    try:
        from datetime import datetime, timezone
        from sqlalchemy import select
        from ..database import SessionLocal
        from ..models.bay import Bay
        from ..models.timer_device import TimerDevice
        db = SessionLocal()
        try:
            bay = db.scalar(select(Bay).where(Bay.bay_number == bay_number))
            if not bay:
                return
            dev = db.scalar(select(TimerDevice).where(TimerDevice.bay_id == bay.id))
            if not dev:
                return  # device not paired in the registry yet — ignore telemetry
            dev.last_seen = datetime.now(timezone.utc)
            if ip:
                dev.ip_address = ip
            if firmware:
                dev.firmware_version = firmware
            db.commit()
        finally:
            db.close()
    except Exception:
        log.exception("[mqtt] device stamp failed bay=%s", bay_number)


def _on_message(client, userdata, msg) -> None:
    global _last_message
    _last_message = {"topic": msg.topic, "ts": int(time.time())}
    try:
        parts = msg.topic.split("/")
        if len(parts) < 3:
            return
        bay_number = int(parts[1])
        leaf = parts[2]
        payload = {}
        try:
            payload = json.loads(msg.payload.decode() or "{}")
        except Exception:
            pass
        if leaf in ("telemetry", "hello"):
            _stamp_device(bay_number, payload.get("ip"), payload.get("firmware"))
            if leaf == "hello":
                # ESP32 just booted → resync it immediately from the backend state
                from ..database import SessionLocal
                from ..models.bay import Bay
                from sqlalchemy import select
                db = SessionLocal()
                try:
                    bay = db.scalar(select(Bay).where(Bay.bay_number == bay_number))
                finally:
                    db.close()
                if bay:
                    publish_current_state(bay.id, bay_number)
                log.info("[mqtt] ESP32 hello bay=%s fw=%s — resynced", bay_number, payload.get("firmware"))
    except Exception:
        log.exception("[mqtt] on_message error topic=%s", getattr(msg, "topic", "?"))


# ── connection lifecycle ───────────────────────────────────────────
def _rc_ok(reason_code) -> bool:
    try:
        return int(getattr(reason_code, "value", reason_code)) == 0
    except Exception:
        return str(reason_code).lower() in ("success", "0")


def _on_connect(client, userdata, flags, reason_code, properties=None) -> None:
    global _connected
    _connected = _rc_ok(reason_code)
    if _connected:
        log.warning("[mqtt] connected — ESP32 timers LIVE (prefix=%s)", _prefix())
        client.subscribe(f"{_prefix()}/+/telemetry", qos=0)
        client.subscribe(f"{_prefix()}/+/hello", qos=1)
        _refresh_bay_map()
        _publish_all_active()   # resync every connected ESP32 to current state
    else:
        log.error("[mqtt] connect failed rc=%s", reason_code)


def _on_disconnect(client, userdata, *args) -> None:
    global _connected
    _connected = False
    log.error("[mqtt] disconnected — auto-reconnecting")


def _publish_loop() -> None:
    """Every second, push current state for all active timers so the physical
    displays stay locked to the backend clock (drift-free, recovery-safe)."""
    ticks = 0
    while True:
        try:
            if _connected:
                if ticks % 30 == 0:
                    _refresh_bay_map()
                _publish_all_active()
        except Exception:
            log.exception("[mqtt] publish loop error")
        ticks += 1
        time.sleep(1)


def _teardown() -> None:
    """Disconnect + drop the current client (no-op if none)."""
    global _client, _connected
    if _client is not None:
        try:
            _client.loop_stop()
        except Exception:
            pass
        try:
            _client.disconnect()
        except Exception:
            pass
    _client = None
    _connected = False


def _connect_from_config() -> None:
    """(Re)build the broker client from the CURRENT config. Tears down any existing
    client first, so this is the single path used by both boot and live-reconnect.
    Safe when the broker is down — paho keeps retrying."""
    global _client
    _teardown()
    cfg = _cfg()
    _refresh_opts(cfg)
    if not _enabled() or not cfg.get("broker_host"):
        log.warning("[mqtt] disabled/unconfigured (enabled=%s paho=%s broker=%s) — physical "
                    "timers dormant; backend timer remains source of truth",
                    cfg.get("enabled"), _HAS_PAHO, cfg.get("broker_host") or None)
        return
    try:
        protocol = (cfg.get("protocol") or "mqtt").lower()
        transport = "websockets" if protocol in ("ws", "wss") else "tcp"
        use_tls = bool(cfg.get("tls_enabled")) or protocol in ("mqtts", "wss")
        client = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2,
                             client_id=cfg.get("client_id") or "baywatch-backend",
                             clean_session=True, transport=transport)
        if cfg.get("username"):
            client.username_pw_set(cfg["username"], cfg.get("password") or None)
        if use_tls:
            client.tls_set(ca_certs=cfg.get("ca_cert") or None)
        client.on_connect = _on_connect
        client.on_disconnect = _on_disconnect
        client.on_message = _on_message
        backoff = max(1, int(cfg.get("reconnect_backoff") or 30))
        client.reconnect_delay_set(min_delay=1, max_delay=backoff)
        client.connect_async(cfg["broker_host"], int(cfg.get("broker_port") or 1883),
                             keepalive=int(cfg.get("keepalive") or 30))
        client.loop_start()
        _client = client
        log.warning("[mqtt] client started → %s:%s prefix=%s tls=%s transport=%s",
                    cfg["broker_host"], cfg.get("broker_port"), _prefix(), use_tls, transport)
    except Exception:
        log.exception("[mqtt] failed to start client")


def start() -> None:
    """Boot: launch the 1s publisher thread (once) + connect from current config."""
    global _started
    if not _started:
        _started = True
        threading.Thread(target=_publish_loop, name="bw-mqtt-state", daemon=True).start()
    _connect_from_config()


def reconnect() -> dict:
    """Apply the CURRENT DB config live (called after a save) — disconnect, re-read
    config, and reconnect/disconnect accordingly. No backend restart needed."""
    integration_config.invalidate("mqtt_timer")
    _connect_from_config()
    return status()


def health() -> dict:
    """Real one-shot broker connection test. Returns {configured, reachable, broker,
    detail}. Honest: a fast TCP pre-check then a CONNACK wait; missing paho or an
    unreachable broker reports reachable:false — never a fake success."""
    cfg = _cfg()
    host = (cfg.get("broker_host") or "").strip()
    port = int(cfg.get("broker_port") or 1883)
    broker = f"{host}:{port}" if host else None
    if not _HAS_PAHO:
        return {"configured": bool(host), "reachable": False, "broker": broker,
                "detail": "paho-mqtt is not installed — cannot connect to a broker."}
    if not host:
        return {"configured": False, "reachable": False, "broker": None,
                "detail": "No broker host configured."}
    timeout = int(cfg.get("connection_timeout") or 6) or 6
    # fast, honest TCP pre-check so an unreachable host fails quickly
    try:
        socket.create_connection((host, port), timeout=timeout).close()
    except Exception as e:
        return {"configured": True, "reachable": False, "broker": broker,
                "detail": f"Broker unreachable ({e.__class__.__name__})."}
    try:
        protocol = (cfg.get("protocol") or "mqtt").lower()
        transport = "websockets" if protocol in ("ws", "wss") else "tcp"
        use_tls = bool(cfg.get("tls_enabled")) or protocol in ("mqtts", "wss")
        c = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2,
                        client_id=(cfg.get("client_id") or "baywatch") + "-test",
                        transport=transport)
        if cfg.get("username"):
            c.username_pw_set(cfg["username"], cfg.get("password") or None)
        if use_tls:
            c.tls_set(ca_certs=cfg.get("ca_cert") or None)
        res = {"rc": None}
        ev = threading.Event()

        def _oc(client, ud, flags, rc, props=None):
            res["rc"] = int(getattr(rc, "value", rc)) if not isinstance(rc, int) else rc
            ev.set()

        c.on_connect = _oc
        c.connect(host, port, keepalive=timeout)
        c.loop_start()
        got = ev.wait(timeout=timeout)
        if got and res["rc"] == 0 and cfg.get("test_topic"):
            try:
                c.publish(cfg["test_topic"], cfg.get("test_payload") or "baywatch-ping", qos=0)
            except Exception:
                pass
        try:
            c.loop_stop(); c.disconnect()
        except Exception:
            pass
        if not got:
            return {"configured": True, "reachable": False, "broker": broker,
                    "detail": "TCP open but no MQTT CONNACK within timeout."}
        rc = res["rc"]
        if rc == 0:
            return {"configured": True, "reachable": True, "broker": broker,
                    "detail": f"Connected to {broker}"
                    + (f" · published test to {cfg['test_topic']}" if cfg.get("test_topic") else "")}
        return {"configured": True, "reachable": False, "broker": broker,
                "detail": f"Broker refused the connection (rc={rc})."}
    except Exception as e:
        return {"configured": True, "reachable": False, "broker": broker,
                "detail": f"MQTT connect failed: {e.__class__.__name__}"}


def status() -> dict:
    cfg = _cfg()
    return {
        "enabled": _enabled(),
        "connected": _connected,
        "configured": is_configured(),
        "broker": (f"{cfg.get('broker_host')}:{cfg.get('broker_port')}"
                   if cfg.get("broker_host") else None),
        "prefix": _prefix(),
        "last_message": _last_message,
    }
