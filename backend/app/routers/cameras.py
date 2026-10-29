"""Camera Connection — admin registry for the physical IP cameras bound to bays.

Each bay can have ONE camera device (IP / RTSP / ONVIF + credentials). The admin
"Camera Connection" page pairs a camera to a bay, sees its online/offline status
(from a heartbeat / last successful probe) and can Test, Reconnect or Restart it.

In this dev build there is no real hardware, so Test/Reconnect/Restart simulate a
successful probe by stamping `last_seen`. In production these would open the RTSP
stream / issue an ONVIF call and only then mark the device online. A field agent
(the Mini-PC / NVR) can also POST /cameras/heartbeat to report liveness.
"""
import logging
from datetime import datetime, timezone
from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel
from sqlalchemy import select, text
from sqlalchemy.orm import Session

from ..database import get_db, engine
from ..models.bay import Bay
from ..models.camera_device import BayCamera
from ..models.session import CameraSession
from ..models.user import User
from ..schemas.common import ok
from ..services import camera_service
from ..utils.auth import require_admin, assert_branch_access
from ..utils.audit import log_action

log = logging.getLogger("baywatch.cameras")
router = APIRouter()

ONLINE_WINDOW = 90  # seconds since last_seen within which a camera counts as ONLINE

_CAMERA_MIGRATED = False


def ensure_camera_schema() -> None:
    """Add bay_cameras columns introduced after first release. Idempotent + additive
    — never drops. PostgreSQL + SQLite."""
    global _CAMERA_MIGRATED
    if _CAMERA_MIGRATED:
        return
    dialect = engine.dialect.name
    cols = [("brand", "VARCHAR"), ("rtsp_port", "INTEGER DEFAULT 554"),
            ("rtsp_path", "VARCHAR"), ("last_error", "VARCHAR")]
    with engine.begin() as conn:
        try:
            if dialect == "postgresql":
                existing = {r[0] for r in conn.execute(text(
                    "SELECT column_name FROM information_schema.columns WHERE table_name='bay_cameras'"))}
            else:
                existing = {r[1] for r in conn.execute(text("PRAGMA table_info(bay_cameras)"))}
        except Exception:
            existing = set()
        for name, ddl in cols:
            if name not in existing:
                try:
                    conn.execute(text(f"ALTER TABLE bay_cameras ADD COLUMN {name} {ddl}"))
                except Exception:
                    pass
    _CAMERA_MIGRATED = True


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _age(dt: datetime | None) -> float | None:
    if not dt:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return (_now() - dt).total_seconds()


def _status(cam: BayCamera | None) -> str:
    if not cam:
        return "unpaired"
    if not cam.enabled:
        return "disabled"
    age = _age(cam.last_seen)
    return "online" if (age is not None and age <= ONLINE_WINDOW) else "offline"


def _last_seen_label(cam: BayCamera | None) -> str:
    age = _age(cam.last_seen) if cam else None
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
    return cam.last_seen.strftime("%d %b %H:%M")


def _row(bay: Bay, cam: BayCamera | None) -> dict:
    return {
        "bay_id": bay.id,
        "bay_number": bay.bay_number,
        "bay_name": bay.name or f"Bay {bay.bay_number:02d}",
        "camera_channel": bay.camera_channel or f"CH-{bay.bay_number:02d}",
        "camera": None if not cam else {
            "id": cam.id, "camera_id": cam.camera_id, "name": cam.name,
            "brand": cam.brand,
            "ip_address": cam.ip_address, "rtsp_url": cam.rtsp_url,
            "rtsp_port": cam.rtsp_port, "rtsp_path": cam.rtsp_path,
            "onvif_port": cam.onvif_port, "username": cam.username,
            "enabled": cam.enabled, "last_error": cam.last_error,
            # NEVER expose the password — raw RTSP credentials stay server-side.
        },
        "status": _status(cam),
        "last_seen": _last_seen_label(cam),
    }


class CameraIn(BaseModel):
    bay_id: str
    camera_id: str | None = None
    name: str | None = None
    brand: str | None = None
    ip_address: str | None = None
    rtsp_url: str | None = None
    rtsp_port: int | None = None
    rtsp_path: str | None = None
    onvif_port: int = 554
    username: str | None = None
    password: str | None = None


class CameraEdit(BaseModel):
    camera_id: str | None = None
    name: str | None = None
    brand: str | None = None
    ip_address: str | None = None
    rtsp_url: str | None = None
    rtsp_port: int | None = None
    rtsp_path: str | None = None
    onvif_port: int | None = None
    username: str | None = None
    password: str | None = None
    enabled: bool | None = None


def _cams_by_bay(db: Session) -> dict:
    return {c.bay_id: c for c in db.scalars(select(BayCamera)).all()}


@router.get("")
def list_cameras(db: Session = Depends(get_db), admin: User = Depends(require_admin)):
    """Every (active) bay + its camera connection status, for the table."""
    bays = db.scalars(
        select(Bay).where(Bay.is_active.isnot(False)).order_by(Bay.bay_number)
    ).all()
    cams = _cams_by_bay(db)
    rows = [_row(b, cams.get(b.id)) for b in bays]
    # bays whose camera is actively capturing right now (live CameraSession "on")
    recording_bays = {
        cs.bay_id for cs in db.scalars(select(CameraSession).where(CameraSession.status == "on")).all()
    }
    summary = {
        "total": len(rows),
        "online": sum(1 for r in rows if r["status"] == "online"),
        "offline": sum(1 for r in rows if r["status"] == "offline"),
        "unpaired": sum(1 for r in rows if r["status"] == "unpaired"),
        "recording": sum(1 for b in bays if b.id in recording_bays),
    }
    return ok({"summary": summary, "cameras": rows})


@router.post("", status_code=status.HTTP_201_CREATED)
def pair_camera(body: CameraIn, db: Session = Depends(get_db), admin: User = Depends(require_admin)):
    """Pair (bind) a camera to a bay. One camera per bay."""
    bay = db.get(Bay, body.bay_id)
    if not bay:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Bay not found")
    assert_branch_access(admin, bay.branch_id, "pair camera")
    if db.scalar(select(BayCamera).where(BayCamera.bay_id == body.bay_id)):
        raise HTTPException(status.HTTP_409_CONFLICT, "This bay already has a paired camera. Edit it instead.")
    cam = BayCamera(
        bay_id=body.bay_id,
        camera_id=body.camera_id or f"CAM-{bay.bay_number:02d}",
        name=body.name or f"Bay {bay.bay_number:02d} Camera",
        brand=body.brand,
        ip_address=body.ip_address, rtsp_url=body.rtsp_url,
        rtsp_port=body.rtsp_port or 554, rtsp_path=body.rtsp_path,
        onvif_port=body.onvif_port or 554, username=body.username, password=body.password,
        enabled=True, created_at=_now(),
    )
    db.add(cam)
    log_action(db, "CAMERA_PAIR", "bay_camera", body.bay_id, admin.id,
               new={"camera_id": cam.camera_id, "ip": cam.ip_address})
    db.commit(); db.refresh(cam)
    return ok({"id": cam.id, "camera_id": cam.camera_id}, f"Camera paired to Bay {bay.bay_number:02d}")


def _get_cam(db: Session, camera_id: str, admin: User) -> BayCamera:
    """Fetch a camera and enforce branch ownership (Master bypasses). Used by
    every camera write so a crafted camera_id cannot reach another branch."""
    cam = db.get(BayCamera, camera_id)
    if not cam:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Camera not found")
    bay = db.get(Bay, cam.bay_id)
    assert_branch_access(admin, bay.branch_id if bay else None, "camera op")
    return cam


@router.put("/{camera_id}")
def update_camera(camera_id: str, body: CameraEdit, db: Session = Depends(get_db), admin: User = Depends(require_admin)):
    cam = _get_cam(db, camera_id, admin)
    for field, value in body.model_dump(exclude_unset=True).items():
        setattr(cam, field, value)
    log_action(db, "CAMERA_UPDATE", "bay_camera", cam.bay_id, admin.id)
    db.commit()
    return ok(message="Camera updated")


@router.delete("/{camera_id}")
def unpair_camera(camera_id: str, db: Session = Depends(get_db), admin: User = Depends(require_admin)):
    cam = _get_cam(db, camera_id, admin)
    bay_id = cam.bay_id
    db.delete(cam)
    log_action(db, "CAMERA_UNPAIR", "bay_camera", bay_id, admin.id)
    db.commit()
    return ok(message="Camera unpaired")


def _probe(cam: BayCamera, db: Session, action: str) -> dict:
    """REAL per-bay RTSP probe (ffprobe/ffmpeg via camera_service). Honest: stamps
    last_seen ONLY on a successful reach; on failure records last_error (creds
    redacted) and leaves last_seen untouched (so status stays offline). Never fakes
    success and never returns the raw password."""
    res = camera_service.probe_camera(db, cam)
    if res.get("reachable"):
        cam.last_seen = _now()
        cam.last_error = None
    else:
        cam.last_error = (res.get("detail") or "Camera unreachable")[:300]
    db.commit()
    return {"status": _status(cam), "last_seen": _last_seen_label(cam),
            "reachable": bool(res.get("reachable")), "detail": res.get("detail"),
            "target": res.get("target"), "resolution": res.get("resolution"),
            "codec": res.get("codec"), "fps": res.get("fps"),
            "last_error": cam.last_error}


@router.post("/{camera_id}/test")
def test_camera(camera_id: str, db: Session = Depends(get_db), admin: User = Depends(require_admin)):
    cam = _get_cam(db, camera_id, admin)
    res = _probe(cam, db, "test")
    return ok(res, res.get("detail") or ("Camera reachable" if res.get("reachable") else "Camera unreachable"))


@router.post("/{camera_id}/reconnect")
def reconnect_camera(camera_id: str, db: Session = Depends(get_db), admin: User = Depends(require_admin)):
    cam = _get_cam(db, camera_id, admin)
    res = _probe(cam, db, "reconnect")
    return ok(res, res.get("detail") or ("Camera reconnected" if res.get("reachable") else "Camera unreachable"))


@router.post("/{camera_id}/restart")
def restart_camera(camera_id: str, db: Session = Depends(get_db), admin: User = Depends(require_admin)):
    # No real reboot capability for a generic IP camera here — re-probe + report honestly.
    cam = _get_cam(db, camera_id, admin)
    res = _probe(cam, db, "restart")
    return ok(res, res.get("detail") or ("Camera reachable" if res.get("reachable") else "Camera unreachable"))


class Heartbeat(BaseModel):
    camera_id: str


@router.post("/heartbeat")
def heartbeat(body: Heartbeat, db: Session = Depends(get_db)):
    """Liveness ping from the field agent (Mini-PC/NVR) or the camera itself.
    Unauthenticated by design (device-to-server), matched on camera_id."""
    cam = db.scalar(select(BayCamera).where(BayCamera.camera_id == body.camera_id))
    if not cam:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Unknown camera_id")
    cam.last_seen = _now()
    db.commit()
    return ok({"status": _status(cam)}, "ok")
