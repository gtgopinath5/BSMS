"""Timer Connection — admin registry for the physical ESP32 bay timers (MQTT).

Each bay can have ONE timer device. The admin "Timer Connection" page pairs a
timer to a bay, sees its online/offline status (from MQTT telemetry heartbeat) and
its reported IP / firmware, and can Reconnect (resync state), Restart, Test the
display, or push a Firmware (OTA) command — all delivered over MQTT.

The countdown the device shows is produced entirely by the backend timer and
published every second by mqtt_service; the ESP32 only renders it. This router is
the device control-plane; mqtt_service is the data-plane.
"""
import logging
from datetime import datetime, timezone
from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel
from sqlalchemy import select, text
from sqlalchemy.orm import Session

from ..database import get_db, engine
from ..models.bay import Bay
from ..models.timer_device import TimerDevice
from ..models.user import User
from ..schemas.common import ok
from ..services import mqtt_service
from ..utils.auth import require_admin, assert_branch_access
from ..utils.audit import log_action

log = logging.getLogger("baywatch.timers")
router = APIRouter()

ONLINE_WINDOW = 90  # seconds since last telemetry within which a timer is ONLINE

_TIMER_MIGRATED = False


def ensure_timer_schema() -> None:
    """Add timer_devices columns introduced after first release (admin-command
    telemetry). Idempotent + additive — never drops. PostgreSQL + SQLite."""
    global _TIMER_MIGRATED
    if _TIMER_MIGRATED:
        return
    dialect = engine.dialect.name
    ts = "TIMESTAMP" if dialect == "postgresql" else "DATETIME"
    cols = [("last_command", "VARCHAR"), ("last_command_at", ts), ("last_error", "VARCHAR")]
    with engine.begin() as conn:
        try:
            if dialect == "postgresql":
                existing = {r[0] for r in conn.execute(text(
                    "SELECT column_name FROM information_schema.columns WHERE table_name='timer_devices'"))}
            else:
                existing = {r[1] for r in conn.execute(text("PRAGMA table_info(timer_devices)"))}
        except Exception:
            existing = set()
        for name, ddl in cols:
            if name not in existing:
                try:
                    conn.execute(text(f"ALTER TABLE timer_devices ADD COLUMN {name} {ddl}"))
                except Exception:
                    pass
    _TIMER_MIGRATED = True


def _stamp_command(dev: TimerDevice, command: str) -> None:
    """Record the last admin command on a timer device. Honest: when the broker is
    not connected the command can't reach the ESP32, so we store that as the error
    (no fake green). Caller commits."""
    dev.last_command = command
    dev.last_command_at = _now()
    try:
        connected = bool(mqtt_service.status().get("connected"))
    except Exception:
        connected = False
    dev.last_error = None if connected else "MQTT broker not connected"


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _age(dt: datetime | None) -> float | None:
    if not dt:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return (_now() - dt).total_seconds()


def _status(dev: TimerDevice | None) -> str:
    if not dev:
        return "unpaired"
    if not dev.enabled:
        return "disabled"
    age = _age(dev.last_seen)
    return "online" if (age is not None and age <= ONLINE_WINDOW) else "offline"


def _last_seen_label(dev: TimerDevice | None) -> str:
    age = _age(dev.last_seen) if dev else None
    if age is None:
        return "—"
    if age < 10:
        return "Now"
    if age < 60:
        return f"{int(age)}s ago"
    if age < 3600:
        return f"{int(age // 60)} min ago"
    if age < 86400:
        return f"{int(age // 3600)} h ago"
    return dev.last_seen.strftime("%d %b %H:%M")


def _row(bay: Bay, dev: TimerDevice | None, conflict: bool = False) -> dict:
    return {
        "bay_id": bay.id,
        "bay_number": bay.bay_number,
        "bay_name": bay.name or f"Bay {bay.bay_number:02d}",
        "timer": None if not dev else {
            "id": dev.id, "timer_id": dev.timer_id, "name": dev.name,
            "ip_address": dev.ip_address, "firmware_version": dev.firmware_version,
            "enabled": dev.enabled,
            "last_command": dev.last_command,
            "last_command_at": dev.last_command_at.isoformat() if dev.last_command_at else None,
            "last_error": dev.last_error,
        },
        "status": _status(dev),
        "conflict": bool(conflict),                       # same timer_id label on >1 bay
        "ip_address": dev.ip_address if dev else None,
        "firmware_version": dev.firmware_version if dev else None,
        "last_seen": _last_seen_label(dev),
        "state_topic": mqtt_service.state_topic(bay.bay_number),
        "command_topic": mqtt_service.command_topic(bay.bay_number),
    }


class TimerIn(BaseModel):
    bay_id: str
    timer_id: str | None = None
    name: str | None = None


class TimerEdit(BaseModel):
    timer_id: str | None = None
    name: str | None = None
    enabled: bool | None = None


def _devs_by_bay(db: Session) -> dict:
    return {d.bay_id: d for d in db.scalars(select(TimerDevice)).all()}


@router.get("")
def list_timers(db: Session = Depends(get_db), admin: User = Depends(require_admin)):
    """Every (active) bay + its timer connection status, for the table."""
    bays = db.scalars(
        select(Bay).where(Bay.is_active.isnot(False)).order_by(Bay.bay_number)
    ).all()
    devs = _devs_by_bay(db)
    # Warn-only conflict: the same timer_id LABEL paired to more than one bay. Routing
    # is keyed on the globally-unique bay_number, so this never misroutes — it's a
    # data-hygiene warning surfaced as a red badge on every affected card.
    counts: dict[str, int] = {}
    for d in devs.values():
        if d.timer_id:
            counts[d.timer_id] = counts.get(d.timer_id, 0) + 1
    rows = []
    for b in bays:
        d = devs.get(b.id)
        rows.append(_row(b, d, conflict=bool(d and counts.get(d.timer_id, 0) > 1)))
    summary = {
        "total": len(rows),
        "online": sum(1 for r in rows if r["status"] == "online"),
        "offline": sum(1 for r in rows if r["status"] == "offline"),
        "unpaired": sum(1 for r in rows if r["status"] == "unpaired"),
        "conflicts": sum(1 for r in rows if r["conflict"]),
        "mqtt": mqtt_service.status(),
    }
    return ok({"summary": summary, "timers": rows})


@router.post("", status_code=status.HTTP_201_CREATED)
def pair_timer(body: TimerIn, db: Session = Depends(get_db), admin: User = Depends(require_admin)):
    """Pair (bind) an ESP32 timer to a bay. One timer per bay."""
    bay = db.get(Bay, body.bay_id)
    if not bay:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Bay not found")
    assert_branch_access(admin, bay.branch_id, "pair timer")
    if db.scalar(select(TimerDevice).where(TimerDevice.bay_id == body.bay_id)):
        raise HTTPException(status.HTTP_409_CONFLICT, "This bay already has a paired timer. Edit it instead.")
    dev = TimerDevice(
        bay_id=body.bay_id,
        timer_id=body.timer_id or f"TMR-{bay.bay_number:02d}",
        name=body.name or f"Bay {bay.bay_number:02d} Timer",
        enabled=True, created_at=_now(),
    )
    db.add(dev)
    _stamp_command(dev, "pair")
    log_action(db, "TIMER_PAIR", "timer_device", body.bay_id, admin.id,
               new={"timer_id": dev.timer_id})
    db.commit(); db.refresh(dev)
    # push the current timer state so a connected device adopts it right away
    mqtt_service.publish_current_state(bay.id, bay.bay_number)
    return ok({"id": dev.id, "timer_id": dev.timer_id, "bay_number": bay.bay_number,
               "topic": mqtt_service.state_topic(bay.bay_number)},
              f"Timer paired to Bay {bay.bay_number:02d}")


def _get_dev(db: Session, device_id: str, admin: User) -> TimerDevice:
    """Fetch a timer device and enforce branch ownership (Master bypasses). Used
    by every timer write so a crafted device_id cannot reach another branch."""
    dev = db.get(TimerDevice, device_id)
    if not dev:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Timer not found")
    bay = db.get(Bay, dev.bay_id)
    assert_branch_access(admin, bay.branch_id if bay else None, "timer op")
    return dev


@router.put("/{device_id}")
def update_timer(device_id: str, body: TimerEdit, db: Session = Depends(get_db), admin: User = Depends(require_admin)):
    dev = _get_dev(db, device_id, admin)
    for field, value in body.model_dump(exclude_unset=True).items():
        setattr(dev, field, value)
    log_action(db, "TIMER_UPDATE", "timer_device", dev.bay_id, admin.id)
    db.commit()
    return ok(message="Timer updated")


@router.delete("/{device_id}")
def unpair_timer(device_id: str, db: Session = Depends(get_db), admin: User = Depends(require_admin)):
    dev = _get_dev(db, device_id, admin)
    bay_id = dev.bay_id
    db.delete(dev)
    log_action(db, "TIMER_UNPAIR", "timer_device", bay_id, admin.id)
    db.commit()
    return ok(message="Timer unpaired")


def _bay_number_for(db: Session, dev: TimerDevice) -> int:
    bay = db.get(Bay, dev.bay_id)
    if not bay:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Bay not found for this timer")
    return bay.bay_number


@router.post("/{device_id}/reconnect")
def reconnect_timer(device_id: str, db: Session = Depends(get_db), admin: User = Depends(require_admin)):
    """Force a state resync — republishes the current backend timer state so the
    device adopts the authoritative countdown immediately (no drift)."""
    dev = _get_dev(db, device_id, admin)
    mqtt_service.publish_current_state(dev.bay_id, _bay_number_for(db, dev))
    _stamp_command(dev, "reconnect"); db.commit()
    return ok(mqtt_service.status(), "Resync state published to timer")


@router.post("/{device_id}/restart")
def restart_timer(device_id: str, db: Session = Depends(get_db), admin: User = Depends(require_admin)):
    dev = _get_dev(db, device_id, admin)
    mqtt_service.publish_event(_bay_number_for(db, dev), "restart")
    _stamp_command(dev, "restart")
    log_action(db, "ESP32_RESTART", "timer_device", dev.bay_id, admin.id,
               new={"timer_id": dev.timer_id})
    db.commit()
    return ok(mqtt_service.status(), "Restart command sent to timer")


@router.post("/{device_id}/test")
def test_timer(device_id: str, db: Session = Depends(get_db), admin: User = Depends(require_admin)):
    """Test Display — the ESP32 runs an LED/segment/buzzer self-test pattern."""
    dev = _get_dev(db, device_id, admin)
    mqtt_service.publish_event(_bay_number_for(db, dev), "test")
    _stamp_command(dev, "test"); db.commit()
    return ok(mqtt_service.status(), "Display test command sent to timer")


@router.post("/{device_id}/firmware")
def firmware_update(device_id: str, db: Session = Depends(get_db), admin: User = Depends(require_admin)):
    """Trigger an OTA firmware update on the device (the ESP32 pulls + flashes)."""
    dev = _get_dev(db, device_id, admin)
    mqtt_service.publish_event(_bay_number_for(db, dev), "ota")
    _stamp_command(dev, "firmware")
    log_action(db, "TIMER_FIRMWARE_UPDATE", "timer_device", dev.bay_id, admin.id)
    db.commit()
    return ok(mqtt_service.status(), "Firmware update (OTA) command sent to timer")
