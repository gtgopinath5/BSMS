"""Barricade relay controller — the ONLY component that issues a physical "open" command.

SAFETY CONTRACT
  • This module is purely MECHANICAL: given a direction it executes the configured relay command
    and returns a truthful result. It performs NO authorization. The single caller is
    ``barricade_service`` and it calls here ONLY after the backend decision authority has
    authorized the open. The detection ingest path can never reach this module.
  • FAIL-SAFE CLOSED: with no controller, a disabled controller, or an unknown type, ``open`` does
    nothing and reports it honestly. It never "opens" on uncertainty.
  • ``simulation`` is the DEFAULT and sends no hardware command. Real transports are OPT-IN per
    controller config: ``http_relay`` sends a low-voltage HTTP open command (GET/POST, with a
    timeout); ``mqtt_relay`` publishes a small JSON open command to a BARRICADE-SPECIFIC topic
    (never a bay-timer topic). ``gpio_gateway`` stays a safe ``not_implemented`` (no direct GPIO in
    the backend — a future local gateway service handles pins). Every transport FAILS SAFE: a
    timeout / error / missing config / unreachable broker → barrier stays closed, truthfully logged.
  • EMERGENCY STOP holds the barrier closed: once engaged, every open is refused until an admin
    clears it (by re-saving the controller config). Implemented WITHOUT new schema via ``last_status``.
  • This module drives only a low-voltage dry-contact controller/relay/gateway — NEVER a barrier
    motor directly. Motor/high-voltage wiring is a qualified electrician's job.

The result dict is stored verbatim on ``BarricadeEvent.relay_result_json``.
"""
import json
import logging
import time
import urllib.error
import urllib.request
import uuid

from sqlalchemy import select
from sqlalchemy.orm import Session

from ..config import settings
from ..models.barricade import BarricadeControllerConfig
from ..models.base import naive_utcnow
from ..utils import barricade as B

log = logging.getLogger("baywatch.barricade")


def get_controller(db: Session, branch_id: str | None) -> BarricadeControllerConfig | None:
    stmt = select(BarricadeControllerConfig)
    if branch_id:
        stmt = stmt.where(BarricadeControllerConfig.branch_id == branch_id)
    return db.scalars(stmt.order_by(BarricadeControllerConfig.created_at.desc())).first()


def _stamp(db: Session, ctrl: BarricadeControllerConfig | None, status: str,
           error: str | None = None) -> None:
    if not ctrl:
        return
    ctrl.last_command_at = naive_utcnow()
    ctrl.last_status = status
    ctrl.last_error = error


def open_barricade(db: Session, branch_id: str | None, direction: str, *,
                   controller: BarricadeControllerConfig | None = None,
                   reason: str | None = None) -> dict:
    """Execute the relay open for ``direction``. MECHANICAL ONLY — assumes the caller already
    authorized it. Returns a truthful result; never raises into the request path."""
    ctrl = controller or get_controller(db, branch_id)
    now = naive_utcnow()

    # FAIL-SAFE: nothing configured / disabled → do not open.
    if ctrl is None:
        return {"opened": False, "status": "disabled", "mode": "none",
                "detail": "No barricade controller configured — fail-safe closed.",
                "direction": direction, "at": now.isoformat()}
    if not ctrl.enabled or ctrl.controller_type == "disabled":
        _stamp(db, ctrl, "disabled")
        return {"opened": False, "status": "disabled", "mode": ctrl.controller_type,
                "detail": "Barricade controller is disabled — fail-safe closed.",
                "direction": direction, "at": now.isoformat()}

    # EMERGENCY STOP is a hard hold — refuse EVERY open (incl. simulation) until an admin clears it.
    if (ctrl.last_status or "") == "emergency_stop":
        log.warning("barricade: open REFUSED — emergency stop active (branch=%s dir=%s)", branch_id, direction)
        return {"opened": False, "status": "emergency_stop", "mode": ctrl.controller_type,
                "detail": "Emergency stop is active — open blocked until cleared (fail-safe closed).",
                "direction": direction, "at": now.isoformat()}

    # SAFETY INTERLOCK (opt-in): when this controller requires live safety telemetry, refuse to open
    # on any unsafe condition (offline / fault / photo-beam blocked). Default OFF → simulation and
    # every existing flow are unaffected; it engages only for a configured hardware lane.
    blocked, why = _safety_interlock(ctrl)
    if blocked:
        _stamp(db, ctrl, "safety_blocked", why)
        log.warning("barricade: open REFUSED — safety interlock (branch=%s dir=%s): %s", branch_id, direction, why)
        return {"opened": False, "status": "safety_blocked", "mode": ctrl.controller_type,
                "detail": f"Safety interlock: {why} — open blocked (fail-safe closed).",
                "direction": direction, "at": now.isoformat()}

    ct = ctrl.controller_type
    if ct == "simulation":
        cmd = ctrl.entrance_open_command if direction == "entrance" else ctrl.exit_open_command
        _stamp(db, ctrl, "opened")
        log.info("barricade[sim]: OPEN %s (branch=%s) reason=%s", direction, branch_id, reason)
        return {"opened": True, "status": "opened", "mode": "simulation",
                "direction": direction, "command": cmd or f"SIMULATE_OPEN_{direction.upper()}",
                "auto_close_after_seconds": ctrl.max_open_seconds,
                "detail": "Simulated open (no hardware actuated).",
                "reason": reason, "at": now.isoformat()}
    if ct == "http_relay":
        return _open_http(db, ctrl, branch_id, direction, reason, now)
    if ct == "mqtt_relay":
        return _open_mqtt(db, ctrl, branch_id, direction, reason, now)

    # gpio_gateway (and any unknown type) stay a safe no-op — never actuate, never fake success.
    _stamp(db, ctrl, "not_implemented",
           f"{ct} relay has no backend adapter (use a local gateway service)")
    return {"opened": False, "status": "not_implemented", "mode": ct,
            "detail": f"{ct} has no backend adapter — no command was sent (fail-safe closed). "
                      "GPIO must go through a separate local gateway service, never the backend.",
            "direction": direction, "at": now.isoformat()}


def _relay_timeout() -> float:
    try:
        return float(getattr(settings, "barricade_relay_timeout_seconds", 3) or 3)
    except (TypeError, ValueError):
        return 3.0


def _open_http(db: Session, ctrl: BarricadeControllerConfig, branch_id: str | None,
               direction: str, reason: str | None, now) -> dict:
    """HTTP relay adapter — a low-voltage LAN relay / ESP32 gateway. Sends the configured open
    command with a timeout and returns a truthful, credential-masked result. Never raises."""
    url = ((ctrl.entrance_open_command if direction == "entrance" else ctrl.exit_open_command) or "").strip()
    masked = B.mask_url(url)
    if not url:
        _stamp(db, ctrl, "failed", "no open command URL configured")
        return {"adapter": "http_relay", "opened": False, "status": "failed", "mode": "http_relay",
                "direction": direction, "detail": "No open command URL configured — fail-safe closed.",
                "at": now.isoformat()}
    method = (getattr(ctrl, "http_method", None) or "GET").upper()
    if method not in ("GET", "POST"):
        method = "GET"
    timeout = _relay_timeout()
    t0 = time.monotonic()
    try:
        body = None
        headers = {}
        if method == "POST":
            body = json.dumps({"direction": direction, "branch_id": branch_id,
                               "max_open_seconds": ctrl.max_open_seconds}).encode()
            headers["Content-Type"] = "application/json"
        req = urllib.request.Request(url, data=body, method=method, headers=headers)
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            code = resp.getcode()
            resp.read()                                   # drain the body (do not store/log it)
        dur = int((time.monotonic() - t0) * 1000)
        opened = 200 <= (code or 0) < 300
        _stamp(db, ctrl, "opened" if opened else "failed", None if opened else f"relay HTTP {code}")
        log.info("barricade[http]: %s %s branch=%s → HTTP %s (%dms) url=%s",
                 method, direction, branch_id, code, dur, masked)
        return {"adapter": "http_relay", "opened": opened, "status": "opened" if opened else "failed",
                "mode": "http_relay", "direction": direction, "status_code": code, "duration_ms": dur,
                "auto_close_after_seconds": ctrl.max_open_seconds, "command": masked, "reason": reason,
                "detail": "Relay open command acknowledged." if opened
                          else f"Relay returned HTTP {code} — fail-safe closed (barrier not opened).",
                "at": now.isoformat()}
    except Exception as e:                                # timeout / connection error / bad URL
        dur = int((time.monotonic() - t0) * 1000)
        msg = str(e).lower()
        err = "timeout" if ("timed out" in msg or isinstance(e, TimeoutError)) else e.__class__.__name__
        _stamp(db, ctrl, "failed", f"relay {err}")
        log.warning("barricade[http]: relay FAILED %s branch=%s url=%s · %s", direction, branch_id, masked, err)
        return {"adapter": "http_relay", "opened": False, "status": "failed", "mode": "http_relay",
                "direction": direction, "duration_ms": dur, "error": err, "command": masked,
                "detail": f"Relay {err} — fail-safe closed (barrier not opened).", "at": now.isoformat()}


def _mqtt_publish(topic: str, payload: dict) -> tuple[bool, str | None]:
    """Publish via the SHARED mqtt client (read-only reuse of the connection — the bay-timer core is
    never modified). Returns (ok, error). The verifier patches this to capture calls / simulate down."""
    try:
        from ..services import mqtt_service as mq
        client = getattr(mq, "_client", None)
        if not (mq.is_configured() and getattr(mq, "_connected", False) and client):
            return False, "broker not connected"
        info = client.publish(topic, json.dumps(payload), qos=1)
        try:
            info.wait_for_publish(timeout=_relay_timeout())
        except Exception:
            pass
        rc = getattr(info, "rc", 0)
        return (rc == 0), (None if rc == 0 else f"publish rc={rc}")
    except Exception as e:
        return False, e.__class__.__name__


def _open_mqtt(db: Session, ctrl: BarricadeControllerConfig, branch_id: str | None,
               direction: str, reason: str | None, now) -> dict:
    """MQTT relay adapter — publishes a small JSON open command to a BARRICADE-SPECIFIC topic only.
    Refuses any topic under the bay-timer prefix. Fails safe if the broker is unavailable."""
    topic = (ctrl.mqtt_topic or "").strip() or f"barricade/{branch_id or 'global'}/open"
    bay_prefix = None
    try:
        from ..services import mqtt_service as mq
        bay_prefix = mq.prefix()
    except Exception:
        bay_prefix = None
    # SAFETY (rule 6): never reuse the bay-timer topic namespace.
    if bay_prefix and topic.split("/", 1)[0] == bay_prefix:
        _stamp(db, ctrl, "failed", "topic collides with bay-timer prefix")
        log.warning("barricade[mqtt]: REFUSED topic '%s' (collides with bay prefix '%s')", topic, bay_prefix)
        return {"adapter": "mqtt_relay", "opened": False, "status": "failed", "mode": "mqtt_relay",
                "direction": direction, "error": "topic_conflict", "topic": topic,
                "detail": f"MQTT topic collides with the bay-timer prefix '{bay_prefix}' — refused (fail-safe closed).",
                "at": now.isoformat()}
    command_id = uuid.uuid4().hex[:12]
    cmd = (ctrl.entrance_open_command if direction == "entrance" else ctrl.exit_open_command) or f"OPEN_{direction.upper()}"
    payload = {"type": "barricade.open", "direction": direction, "branch_id": branch_id,
               "command": cmd, "command_id": command_id, "max_open_seconds": ctrl.max_open_seconds,
               "timestamp": now.isoformat()}
    ok, err = _mqtt_publish(topic, payload)
    _stamp(db, ctrl, "opened" if ok else "failed", None if ok else f"mqtt {err}")
    log.info("barricade[mqtt]: OPEN %s branch=%s topic=%s cmd_id=%s ok=%s", direction, branch_id, topic, command_id, ok)
    return {"adapter": "mqtt_relay", "opened": bool(ok), "status": "opened" if ok else "failed",
            "mode": "mqtt_relay", "direction": direction, "topic": topic, "command_id": command_id,
            "auto_close_after_seconds": ctrl.max_open_seconds, "reason": reason,
            "error": (None if ok else (err or "mqtt_unavailable")),
            "detail": "Open command published." if ok else f"MQTT unavailable ({err}) — fail-safe closed.",
            "at": now.isoformat()}


def clear_emergency(db: Session, branch_id: str | None, actor_id: str | None = None,
                    actor_name: str | None = None) -> None:
    """Clear an emergency-stop hold so opens are allowed again (admin action; via config re-save)."""
    ctrl = get_controller(db, branch_id)
    if ctrl and (ctrl.last_status or "") == "emergency_stop":
        ctrl.last_status = None
        ctrl.last_error = None
        B.log_decision(db, None, "admin" if actor_id else "system", actor_id, actor_name,
                       "emergency_stop", "Emergency stop cleared — opens re-enabled", {"branch_id": branch_id})


def emergency_stop(db: Session, branch_id: str | None, actor_id: str | None = None,
                   actor_name: str | None = None) -> dict:
    """Force the controller into a stopped state and record it. Always available."""
    ctrl = get_controller(db, branch_id)
    now = naive_utcnow()
    if ctrl:
        _stamp(db, ctrl, "emergency_stop")
    B.log_decision(db, None, "admin" if actor_id else "system", actor_id, actor_name,
                   "emergency_stop", "Emergency stop engaged — barricade held closed",
                   {"branch_id": branch_id})
    db.commit()
    log.warning("barricade: EMERGENCY STOP engaged (branch=%s) by %s", branch_id, actor_name)
    return {"stopped": True, "status": "emergency_stop", "branch_id": branch_id,
            "at": now.isoformat()}


# ── hardware safety telemetry (reported by a real controller/gateway; DISPLAY + optional gate) ──
_BARRIER_STATES = ("unknown", "closed", "opening", "open", "closing", "fault")
_BEAM = ("unknown", "clear", "blocked")
_LOOP = ("unknown", "clear", "vehicle_present")
_POWER = ("unknown", "mains", "ups", "low_battery")
_NETWORK = ("unknown", "online", "offline", "unstable")


def _one_of(v, allowed: tuple, default: str = "unknown") -> str:
    s = str(v).strip().lower() if v is not None else ""
    return s if s in allowed else default


def _require_safety(ctrl: BarricadeControllerConfig) -> bool:
    return (bool(getattr(ctrl, "require_safety_status_for_open", False))
            or bool(getattr(settings, "barricade_require_safety_status_for_open", False)))


def _safety_interlock(ctrl: BarricadeControllerConfig) -> tuple[bool, str | None]:
    """Return (block, reason). Only engages when the controller is configured to require live safety
    telemetry. A loop 'vehicle_present' never blocks an OPEN (that's normal at the gate; the physical
    controller prevents an unsafe CLOSE); offline / fault / photo-beam-blocked DO block."""
    if not _require_safety(ctrl):
        return False, None
    if not bool(getattr(ctrl, "controller_online", False)):
        return True, "controller offline / no safety heartbeat"
    if (getattr(ctrl, "barrier_state", None) or "") == "fault":
        return True, f"controller fault ({getattr(ctrl, 'fault_reason', None) or 'unspecified'})"
    if (getattr(ctrl, "beam_status", None) or "") == "blocked":
        return True, "photo-beam blocked (obstacle in the gate)"
    return False, None


def _safety_view(ctrl: BarricadeControllerConfig) -> dict:
    return {
        "controller_online": bool(getattr(ctrl, "controller_online", False)),
        "barrier_state": getattr(ctrl, "barrier_state", None) or "unknown",
        "beam_status": getattr(ctrl, "beam_status", None) or "unknown",
        "loop_status": getattr(ctrl, "loop_status", None) or "unknown",
        "manual_override_active": bool(getattr(ctrl, "manual_override_active", False)),
        "power_status": getattr(ctrl, "power_status", None) or "unknown",
        "network_status": getattr(ctrl, "network_status", None) or "unknown",
        "fault_reason": getattr(ctrl, "fault_reason", None),
        "require_safety_status_for_open": _require_safety(ctrl),
        "interlock_ok": not _safety_interlock(ctrl)[0],
        "last_safety_at": ctrl.last_safety_at.isoformat() if getattr(ctrl, "last_safety_at", None) else None,
        "last_safety_error": getattr(ctrl, "last_safety_error", None),
    }


def apply_safety_status(db: Session, branch_id: str | None, payload: dict, *,
                        actor_type: str = "system", actor_id: str | None = None,
                        actor_name: str | None = None) -> dict:
    """Ingest a controller/gateway safety heartbeat: normalize + store the known scalar fields + log
    a ``safety_status`` audit entry. A reported ``emergency`` engages the software hold (blocks every
    open until cleared). NEVER stores raw URLs/secrets. The controller is the reporter; the backend
    only records + optionally gates on it."""
    ctrl = get_controller(db, branch_id)
    if not ctrl:
        return {"applied": False, "detail": "No barricade controller configured for this branch."}
    now = naive_utcnow()
    p = payload or {}
    ctrl.controller_online = bool(p.get("controller_online", True)) if "controller_online" in p else True
    ctrl.barrier_state = _one_of(p.get("barrier_state"), _BARRIER_STATES)
    ctrl.beam_status = _one_of(p.get("beam_status"), _BEAM)
    ctrl.loop_status = _one_of(p.get("loop_status"), _LOOP)
    ctrl.power_status = _one_of(p.get("power_status"), _POWER)
    ctrl.network_status = _one_of(p.get("network_status"), _NETWORK)
    ctrl.manual_override_active = bool(p.get("manual_override_active", False))
    fr = p.get("fault_reason")
    ctrl.fault_reason = (str(fr)[:200] if fr else None)
    ctrl.last_safety_at = now
    ctrl.last_safety_error = None
    snap = _safety_view(ctrl)
    ctrl.safety_status_json = json.dumps(snap, default=str)
    if bool(p.get("emergency")):
        ctrl.last_status = "emergency_stop"
    B.log_decision(db, None, actor_type, actor_id, actor_name, "safety_status",
                   "Controller safety status updated", snap)
    db.commit()
    return {"applied": True, **snap,
            "emergency_stopped": (ctrl.last_status or "") == "emergency_stop"}


def poll_status(db: Session, branch_id: str | None) -> dict:
    """Optionally poll a configured HTTP status endpoint for a safety heartbeat and apply it. FAILS
    SAFE: any error marks the controller OFFLINE (so the interlock, if required, blocks opens). No
    secret/URL leak (the endpoint is masked in results/logs)."""
    ctrl = get_controller(db, branch_id)
    if not ctrl:
        return {"polled": False, "detail": "No barricade controller configured."}
    ep = (getattr(ctrl, "status_endpoint", None) or "").strip()
    if not ep:
        return {"polled": False, "detail": "No status endpoint configured (push via /barricade/safety-status)."}
    masked = B.mask_url(ep)
    try:
        req = urllib.request.Request(ep, method="GET")
        with urllib.request.urlopen(req, timeout=_relay_timeout()) as resp:
            raw = (resp.read().decode() or "{}")
        data = json.loads(raw)
        res = apply_safety_status(db, branch_id, data, actor_type="system",
                                  actor_name="controller-status-poll")
        return {"polled": True, "endpoint": masked, **res}
    except Exception as e:                                 # timeout / connection / bad JSON
        err = "timeout" if ("timed out" in str(e).lower() or isinstance(e, TimeoutError)) else e.__class__.__name__
        ctrl.controller_online = False
        ctrl.last_safety_at = naive_utcnow()
        ctrl.last_safety_error = err
        B.log_decision(db, None, "system", None, "controller-status-poll", "safety_status",
                       f"Status poll failed ({err}) — controller marked offline (fail-safe)",
                       {"endpoint": masked})
        db.commit()
        return {"polled": False, "endpoint": masked, "error": err, "controller_online": False}


def pilot_checklist(db: Session, branch_id: str | None) -> dict:
    """Read-only hardware-pilot readiness checklist. Software prerequisites are auto-derived from the
    config; physical items are LISTED for on-site verification (never auto-satisfied). This NEVER
    enables real relay hardware — it only reports readiness."""
    from ..models.barricade import BarricadeCameraConfig
    ctrl = get_controller(db, branch_id)
    cstmt = select(BarricadeCameraConfig)
    if branch_id:
        cstmt = cstmt.where(BarricadeCameraConfig.branch_id == branch_id)
    cams = db.scalars(cstmt).all()
    cam_in = next((c for c in cams if c.direction == "entrance"), None)
    cam_out = next((c for c in cams if c.direction == "exit"), None)
    real_relay = bool(ctrl and ctrl.enabled and ctrl.controller_type in ("http_relay", "mqtt_relay"))
    require_safety = bool(ctrl and _require_safety(ctrl))

    def item(key, label, status, detail):
        return {"key": key, "label": label, "status": status, "detail": detail}

    software = [
        item("entrance_camera", "Entrance camera configured",
             "ok" if (cam_in and cam_in.ip_address) else "todo",
             "RTSP host set" if (cam_in and cam_in.ip_address) else "Set the entrance camera RTSP host"),
        item("exit_camera", "Exit camera configured",
             "ok" if (cam_out and cam_out.ip_address) else "todo",
             "RTSP host set" if (cam_out and cam_out.ip_address) else "Set the exit camera RTSP host"),
        item("controller_configured", "Barricade controller configured",
             "ok" if ctrl else "todo", (ctrl.controller_type if ctrl else "none")),
        item("simulation_default", "Simulation is the current mode (safe default)",
             "ok" if (ctrl and ctrl.controller_type == "simulation") else "warn",
             "Real relay is opt-in — keep simulation until bench-tested"
             if not real_relay else "REAL RELAY selected — enable only for a supervised lane"),
        item("emergency_reachable", "Emergency stop reachable (software)", "ok",
             "Admin Emergency-stop blocks every open until cleared"),
        item("safety_interlock", "Safety interlock required for open",
             "ok" if require_safety else "todo",
             "ON — offline/fault/beam-blocked blocks opens"
             if require_safety else "Turn ON require_safety_status_for_open before a real pilot"),
        item("safety_heartbeat", "Live safety heartbeat received",
             "ok" if (ctrl and getattr(ctrl, "last_safety_at", None)) else "todo",
             "Controller/gateway is reporting status" if (ctrl and getattr(ctrl, "last_safety_at", None))
             else "No safety heartbeat yet (push via /barricade/safety-status)"),
    ]
    physical = [item(k, l, "physical", "Verify on site before enabling a real relay") for k, l in [
        ("barrier_gate", "Barrier gate installed"),
        ("emergency_stop_hw", "Emergency-stop button installed & tested"),
        ("photo_beam_hw", "Photo-beam installed & tested"),
        ("loop_detector_hw", "Loop detector / safety edge installed & tested"),
        ("manual_key_switch", "Manual key switch available"),
        ("dry_contact_relay", "Low-voltage dry-contact relay verified"),
        ("controller_reachable", "Controller status endpoint reachable"),
        ("camera_rtsp_tested", "Camera RTSP feed tested"),
        ("ai_venv", "AI venv on Python 3.10–3.12 (real YOLO/OCR)"),
        ("staff_supervisor", "Staff supervisor assigned"),
        ("pilot_mode_manual", "Pilot mode enabled manually (single lane)"),
    ]]
    ready_bench = all(i["status"] == "ok" for i in software if i["key"] in
                      ("entrance_camera", "exit_camera", "controller_configured"))
    return {
        "ready_for_bench_test": ready_bench,
        "ready_for_unattended": False,          # never true from software
        "real_relay_enabled": real_relay,
        "require_safety_status_for_open": require_safety,
        "software": software, "physical": physical,
    }


def status(db: Session, branch_id: str | None) -> dict:
    """Read-only controller summary for dashboards (no secrets)."""
    ctrl = get_controller(db, branch_id)
    if not ctrl:
        return {"configured": False, "controller_type": "none", "enabled": False,
                "simulation": bool(getattr(B.settings, "barricade_simulation_enabled", True))}
    return {
        "configured": True, "controller_type": ctrl.controller_type,
        "enabled": bool(ctrl.enabled),
        "simulation": ctrl.controller_type == "simulation",
        "http_method": getattr(ctrl, "http_method", None),
        "emergency_stopped": (ctrl.last_status or "") == "emergency_stop",
        "max_open_seconds": ctrl.max_open_seconds, "cooldown_seconds": ctrl.cooldown_seconds,
        "last_command_at": ctrl.last_command_at.isoformat() if ctrl.last_command_at else None,
        "last_status": ctrl.last_status, "last_error": ctrl.last_error,
        "safety": _safety_view(ctrl),
    }
