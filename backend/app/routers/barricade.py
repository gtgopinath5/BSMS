"""AI Barricade Vehicle Detection — API (Phase B, simulation only).

One router mounted at ``/api/v1`` serving four planes:

  • Admin   (require_admin, branch-isolated; master sees all) — camera/controller config, events,
            allow/deny/open, link-job, simulate-detection, bill/temp approvals, test-open,
            emergency-stop.
  • Master  (require_master, global) — overview, events, detail, override.
  • Ingest  (NOT public) — POST /barricade/ingest for the future detection service; requires an
            internal shared token OR admin/master JWT. Creates an event + runs the decision.
  • Media   (token-gated, no auth dependency) — view a stored frame; bad token → 403.

SAFETY: the detection ingest only SUGGESTS — the backend decision authority (barricade_service)
decides, and the relay controller opens ONLY after authorization. Fail-safe closed.
"""
import base64
import hmac
import logging

from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from fastapi.responses import FileResponse
from jose import jwt, JWTError
from pydantic import BaseModel
from sqlalchemy import select, text
from sqlalchemy.orm import Session

from ..config import settings
from ..database import get_db, engine
from ..models.barricade import (BarricadeCameraConfig, BarricadeControllerConfig, BarricadeEvent,
                                BarricadeBillApproval, BarricadeTemporaryApproval, DIRECTIONS)
from ..models.base import naive_utcnow
from ..models.branch import Branch
from ..models.user import User
from ..schemas.common import ok
from ..services import barricade_service, barricade_controller_service as controller
from ..utils import barricade as B
from ..utils.auth import (assert_branch_access, effective_branch, is_master,
                          require_admin, require_master)

log = logging.getLogger("baywatch.barricade")
router = APIRouter()

_BARRICADE_MIGRATED = False


def ensure_barricade_schema() -> None:
    """Idempotent additive schema guard. Tables are created by ``init_db()`` (create_all); this
    only ADDs a column introduced after a table already exists (PG + SQLite). Never drops."""
    global _BARRICADE_MIGRATED
    if _BARRICADE_MIGRATED:
        return
    dialect = engine.dialect.name
    later: dict[str, list[tuple[str, str]]] = {
        "barricade_camera_configs": [
            ("last_seen_at", "TIMESTAMP"), ("last_error", "TEXT"), ("updated_at", "TIMESTAMP"),
            ("roi_json", "TEXT"), ("require_admin_unknown", "BOOLEAN"),
        ],
        "barricade_controller_configs": [
            ("last_command_at", "TIMESTAMP"), ("last_status", "VARCHAR"),
            ("last_error", "TEXT"), ("updated_at", "TIMESTAMP"), ("http_method", "VARCHAR(8)"),
            # hardware safety telemetry (additive; all default unknown/off)
            ("controller_online", "BOOLEAN"), ("barrier_state", "VARCHAR(12)"),
            ("beam_status", "VARCHAR(12)"), ("loop_status", "VARCHAR(12)"),
            ("manual_override_active", "BOOLEAN"), ("power_status", "VARCHAR(12)"),
            ("network_status", "VARCHAR(12)"), ("fault_reason", "TEXT"),
            ("require_safety_status_for_open", "BOOLEAN"),
            ("last_safety_at", "TIMESTAMP"), ("last_safety_error", "TEXT"),
            ("safety_status_json", "TEXT"),
        ],
        "barricade_events": [
            ("linked_job_card_id", "VARCHAR(36)"), ("linked_intake_id", "VARCHAR(36)"),
            ("linked_test_drive_id", "VARCHAR(36)"), ("linked_bill_id", "VARCHAR(36)"),
            ("approved_by_admin_id", "VARCHAR"), ("approved_by_admin_name", "VARCHAR"),
            ("approved_at", "TIMESTAMP"), ("authorization_source", "VARCHAR(20)"),
            ("barrier_opened_at", "TIMESTAMP"),
            ("relay_result_json", "TEXT"), ("updated_at", "TIMESTAMP"),
        ],
        "barricade_media": [("deleted_at", "TIMESTAMP"), ("expires_at", "TIMESTAMP")],
        "barricade_bill_approvals": [("used_event_id", "VARCHAR(36)"), ("updated_at", "TIMESTAMP"),
                                     ("notes", "TEXT"), ("used_at", "TIMESTAMP")],
        "barricade_temporary_approvals": [("used_event_id", "VARCHAR(36)"), ("updated_at", "TIMESTAMP"),
                                          ("notes", "TEXT"), ("used_at", "TIMESTAMP")],
    }
    with engine.begin() as conn:
        for tbl, cols in later.items():
            try:
                if dialect == "postgresql":
                    existing = {r[0] for r in conn.execute(text(
                        "SELECT column_name FROM information_schema.columns WHERE table_name=:t"), {"t": tbl})}
                else:
                    existing = {r[1] for r in conn.execute(text(f"PRAGMA table_info({tbl})"))}
            except Exception:
                existing = set()
            for name, ddl in cols:
                if name not in existing:
                    try:
                        conn.execute(text(f"ALTER TABLE {tbl} ADD COLUMN {name} {ddl}"))
                    except Exception:
                        pass
    _BARRICADE_MIGRATED = True


# ── request bodies ──────────────────────────────────────────────────
class CameraConfigBody(BaseModel):
    direction: str
    camera_name: str | None = None
    brand: str | None = None
    ip_address: str | None = None
    rtsp_port: int | None = None
    rtsp_path: str | None = None
    username: str | None = None
    password: str | None = None
    enabled: bool | None = None
    detection_enabled: bool | None = None
    roi_json: str | None = None
    detection_threshold: float | None = None
    ocr_threshold: float | None = None
    frame_sample_fps: float | None = None
    cooldown_seconds: int | None = None
    auto_open_known_vehicle: bool | None = None
    auto_open_person: bool | None = None
    require_admin_unknown: bool | None = None


class ControllerConfigBody(BaseModel):
    controller_type: str | None = None
    entrance_open_command: str | None = None
    exit_open_command: str | None = None
    http_method: str | None = None
    status_endpoint: str | None = None
    mqtt_topic: str | None = None
    cooldown_seconds: int | None = None
    max_open_seconds: int | None = None
    enabled: bool | None = None
    require_safety_status_for_open: bool | None = None


class SafetyStatusBody(BaseModel):
    """A controller/gateway safety heartbeat. All optional; unknown/omitted values are treated as
    'unknown'. NEVER carries URLs or secrets."""
    branch_id: str | None = None
    controller_online: bool | None = None
    barrier_state: str | None = None            # unknown|closed|opening|open|closing|fault
    beam_status: str | None = None              # unknown|clear|blocked
    loop_status: str | None = None              # unknown|clear|vehicle_present
    manual_override_active: bool | None = None
    power_status: str | None = None             # unknown|mains|ups|low_battery
    network_status: str | None = None           # unknown|online|offline|unstable
    fault_reason: str | None = None
    emergency: bool | None = None


class SimulateDetectionBody(BaseModel):
    direction: str = "entrance"
    object_type: str = "unknown"
    detection_confidence: float | None = None
    vehicle_number_raw: str | None = None
    ocr_confidence: float | None = None
    camera_config_id: str | None = None
    frame_base64: str | None = None
    source: str | None = None            # e.g. "rtsp_worker" / "simulate" (audit only; no schema change)


class IngestBody(SimulateDetectionBody):
    branch_id: str | None = None


class LinkJobBody(BaseModel):
    job_card_id: str


class OverrideBody(BaseModel):
    action: str | None = "allow"          # allow | deny | open


class BillBody(BaseModel):
    bill_no: str | None = None
    vehicle_number: str
    customer_name: str | None = None
    job_card_id: str | None = None
    amount: float | None = None
    payment_status: str | None = "unknown"
    status: str | None = "approved"
    notes: str | None = None


class TempApprovalBody(BaseModel):
    approval_type: str = "manual_once"
    vehicle_number: str | None = None
    object_type: str | None = None
    valid_minutes: int | None = 120
    linked_test_drive_id: str | None = None
    linked_job_card_id: str | None = None
    linked_worker_id: str | None = None
    notes: str | None = None


# ── helpers ─────────────────────────────────────────────────────────
def _now():
    return naive_utcnow()


def _decode_frame(b64: str | None) -> bytes | None:
    if not b64:
        return None
    try:
        return base64.b64decode(b64.split(",")[-1])
    except Exception:
        return None


def _valid_direction(d: str) -> str:
    if d not in DIRECTIONS:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "direction must be 'entrance' or 'exit'")
    return d


def _branch_events(stmt, me: User):
    return stmt if is_master(me) else stmt.where(BarricadeEvent.branch_id == me.branch_id)


def _admin_event(db: Session, me: User, event_id: str) -> BarricadeEvent:
    e = db.get(BarricadeEvent, event_id)
    if not e:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Barricade event not found")
    assert_branch_access(me, e.branch_id, "barricade-event")
    return e


def _any_event(db: Session, event_id: str) -> BarricadeEvent:
    e = db.get(BarricadeEvent, event_id)
    if not e:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Barricade event not found")
    return e


def _actor(me: User) -> tuple[str, str, str]:
    return ("master" if is_master(me) else "admin"), me.id, me.name


def _filtered_events(stmt, *, direction=None, status_f=None, vehicle=None):
    if direction:
        stmt = stmt.where(BarricadeEvent.direction == direction)
    if status_f:
        stmt = stmt.where(BarricadeEvent.status == status_f)
    if vehicle:
        norm = B.normalize_plate(vehicle)
        if norm:
            stmt = stmt.where(BarricadeEvent.vehicle_number_normalized.contains(norm))
    return stmt.order_by(BarricadeEvent.event_time.desc())


# ════════════════════════════════════════════════════════════════════
#  ADMIN (branch-isolated; master sees all)
# ════════════════════════════════════════════════════════════════════
@router.get("/admin/barricade/config")
def admin_get_config(db: Session = Depends(get_db), me: User = Depends(require_admin)):
    branch = me.branch_id if not is_master(me) else None
    cstmt = select(BarricadeCameraConfig)
    if branch:
        cstmt = cstmt.where(BarricadeCameraConfig.branch_id == branch)
    cams = db.scalars(cstmt.order_by(BarricadeCameraConfig.direction)).all()
    ctrl = controller.get_controller(db, branch)
    return ok({
        "cameras": [B.camera_out(c) for c in cams],
        "controller": B.controller_out(ctrl),
        "controller_status": controller.status(db, branch),
        "simulation_enabled": bool(getattr(settings, "barricade_simulation_enabled", True)),
        "retention_days": B.retention_days(),
    })


@router.post("/admin/barricade/config/camera")
def admin_save_camera(body: CameraConfigBody, db: Session = Depends(get_db),
                      me: User = Depends(require_admin)):
    direction = _valid_direction(body.direction)
    branch = effective_branch(me, None)
    c = db.scalar(select(BarricadeCameraConfig).where(
        BarricadeCameraConfig.branch_id == branch, BarricadeCameraConfig.direction == direction))
    if not c:
        c = BarricadeCameraConfig(branch_id=branch, direction=direction)
        db.add(c)
    for f in ("camera_name", "brand", "ip_address", "rtsp_port", "rtsp_path", "roi_json",
              "detection_threshold", "ocr_threshold", "frame_sample_fps", "cooldown_seconds",
              "enabled", "detection_enabled", "auto_open_known_vehicle", "auto_open_person",
              "require_admin_unknown"):
        v = getattr(body, f)
        if v is not None:
            setattr(c, f, v)
    if body.username:                                # non-blank → (re)encrypt; blank → keep existing
        c.username_encrypted = B.encrypt_secret(body.username)
    if body.password:
        c.password_encrypted = B.encrypt_secret(body.password)
    B.log_decision(db, None, *_actor(me), "save_camera_config",
                   f"Saved {direction} camera config", {"branch_id": branch})
    db.commit()
    db.refresh(c)
    return ok(B.camera_out(c), "Camera configuration saved")


@router.post("/admin/barricade/config/controller")
def admin_save_controller(body: ControllerConfigBody, db: Session = Depends(get_db),
                          me: User = Depends(require_admin)):
    from ..models.barricade import CONTROLLER_TYPES
    branch = effective_branch(me, None)
    c = controller.get_controller(db, branch)
    if not c:
        c = BarricadeControllerConfig(branch_id=branch)
        db.add(c)
    if body.controller_type is not None:
        if body.controller_type not in CONTROLLER_TYPES:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "Invalid controller_type")
        c.controller_type = body.controller_type
    if body.http_method is not None:
        c.http_method = (body.http_method or "GET").upper()
    # text URL/topic fields: a BLANK value means "keep existing" (so a masked GET round-trip from the
    # config form never wipes a stored relay URL/token — mirrors the camera-credential UX).
    for f in ("entrance_open_command", "exit_open_command", "status_endpoint", "mqtt_topic"):
        v = getattr(body, f)
        if v:
            setattr(c, f, v)
    for f in ("cooldown_seconds", "max_open_seconds", "enabled", "require_safety_status_for_open"):
        v = getattr(body, f)
        if v is not None:
            setattr(c, f, v)
    # re-saving an enabled, non-disabled controller CLEARS an emergency-stop hold (admin action).
    if c.enabled and c.controller_type != "disabled":
        controller.clear_emergency(db, branch, me.id, me.name)
    B.log_decision(db, None, *_actor(me), "save_controller_config",
                   f"Saved controller ({c.controller_type})", {"branch_id": branch})
    db.commit()
    db.refresh(c)
    return ok(B.controller_out(c), "Controller configuration saved")


@router.post("/admin/barricade/test-open/{direction}")
def admin_test_open(direction: str, db: Session = Depends(get_db), me: User = Depends(require_admin)):
    direction = _valid_direction(direction)
    branch = effective_branch(me, None)
    result = barricade_service.test_open(db, branch, direction, *_actor(me))
    return ok(result, "Test open executed" if result.get("opened") else result.get("detail"))


@router.post("/admin/barricade/emergency-stop")
def admin_emergency_stop(db: Session = Depends(get_db), me: User = Depends(require_admin)):
    branch = effective_branch(me, None)
    return ok(controller.emergency_stop(db, branch, me.id, me.name), "Emergency stop engaged")


@router.get("/admin/barricade/controller/status")
def admin_controller_status(poll: int = Query(0), db: Session = Depends(get_db),
                            me: User = Depends(require_admin)):
    """Controller status incl. hardware safety telemetry. ``?poll=1`` first polls a configured HTTP
    status endpoint (fail-safe: any error marks the controller offline)."""
    branch = me.branch_id if not is_master(me) else None
    poll_result = controller.poll_status(db, branch) if poll else None
    out = controller.status(db, branch)
    if poll_result is not None:
        out["poll"] = poll_result
    return ok(out)


@router.post("/admin/barricade/config/safety-status")
def admin_apply_safety_status(body: SafetyStatusBody, db: Session = Depends(get_db),
                              me: User = Depends(require_admin)):
    """Admin/test push of a controller safety heartbeat (a real gateway uses the internal-token route
    ``POST /barricade/safety-status``). Branch = the admin's branch (master may target one)."""
    branch = effective_branch(me, body.branch_id)
    at, aid, an = _actor(me)
    res = controller.apply_safety_status(db, branch, body.model_dump(),
                                         actor_type=at, actor_id=aid, actor_name=an)
    return ok(res, "Safety status updated" if res.get("applied") else res.get("detail"))


@router.get("/admin/barricade/pilot-checklist")
def admin_pilot_checklist(db: Session = Depends(get_db), me: User = Depends(require_admin)):
    branch = me.branch_id if not is_master(me) else None
    return ok(controller.pilot_checklist(db, branch))


@router.post("/admin/barricade/simulate-detection")
def admin_simulate(body: SimulateDetectionBody, db: Session = Depends(get_db),
                   me: User = Depends(require_admin)):
    branch = effective_branch(me, None)
    e = barricade_service.ingest(
        db, branch_id=branch, direction=body.direction, object_type=body.object_type,
        detection_confidence=body.detection_confidence, vehicle_number_raw=body.vehicle_number_raw,
        ocr_confidence=body.ocr_confidence, camera_config_id=body.camera_config_id,
        actor_type=("master" if is_master(me) else "admin"), actor_id=me.id, actor_name=me.name,
        frame=_decode_frame(body.frame_base64), source=body.source or "simulate")
    return ok(B.event_detail(db, e), f"Detection simulated · {e.status}")


@router.get("/admin/barricade/events")
def admin_events(direction: str = Query(None), status_f: str = Query(None, alias="status"),
                 vehicle: str = Query(None), limit: int = Query(100),
                 db: Session = Depends(get_db), me: User = Depends(require_admin)):
    stmt = _filtered_events(_branch_events(select(BarricadeEvent), me),
                            direction=direction, status_f=status_f, vehicle=vehicle)
    rows = db.scalars(stmt.limit(min(max(limit, 1), 500))).all()
    return ok([B.event_card(e) for e in rows])


@router.get("/admin/barricade/events/{event_id}")
def admin_event_detail(event_id: str, db: Session = Depends(get_db), me: User = Depends(require_admin)):
    return ok(B.event_detail(db, _admin_event(db, me, event_id)))


@router.post("/admin/barricade/events/{event_id}/allow")
def admin_allow(event_id: str, db: Session = Depends(get_db), me: User = Depends(require_admin)):
    e = barricade_service.admin_allow(db, _admin_event(db, me, event_id), *_actor(me))
    return ok(B.event_detail(db, e), f"Event allowed · {e.status}")


@router.post("/admin/barricade/events/{event_id}/deny")
def admin_deny(event_id: str, db: Session = Depends(get_db), me: User = Depends(require_admin)):
    e = barricade_service.admin_deny(db, _admin_event(db, me, event_id), *_actor(me))
    return ok(B.event_detail(db, e), "Event denied")


@router.post("/admin/barricade/events/{event_id}/open")
def admin_open(event_id: str, db: Session = Depends(get_db), me: User = Depends(require_admin)):
    e = barricade_service.manual_open(db, _admin_event(db, me, event_id), *_actor(me))
    return ok(B.event_detail(db, e), f"Manual open · {e.status}")


@router.post("/admin/barricade/events/{event_id}/link-job")
def admin_link_job(event_id: str, body: LinkJobBody, db: Session = Depends(get_db),
                   me: User = Depends(require_admin)):
    e = barricade_service.link_job(db, _admin_event(db, me, event_id), body.job_card_id, *_actor(me))
    return ok(B.event_detail(db, e), "Event linked to job card")


@router.post("/admin/barricade/bill-approval")
def admin_bill_approval(body: BillBody, db: Session = Depends(get_db), me: User = Depends(require_admin)):
    branch = effective_branch(me, None)
    b = BarricadeBillApproval(
        branch_id=branch, bill_no=body.bill_no, job_card_id=body.job_card_id,
        vehicle_number_raw=body.vehicle_number,
        vehicle_number_normalized=B.normalize_plate(body.vehicle_number) or None,
        customer_name=body.customer_name, amount=body.amount,
        payment_status=(body.payment_status or "unknown"),
        status=(body.status or "approved"), notes=body.notes,
        uploaded_by_admin_id=me.id, uploaded_by_admin_name=me.name, uploaded_at=_now())
    db.add(b)
    B.log_decision(db, None, *_actor(me), "bill_approval",
                   f"Bill approval {b.bill_no or ''} for {body.vehicle_number}",
                   {"status": b.status})
    db.commit()
    db.refresh(b)
    return ok(B.bill_out(b), "Bill approval saved")


@router.post("/admin/barricade/temp-approval")
def admin_temp_approval(body: TempApprovalBody, db: Session = Depends(get_db),
                        me: User = Depends(require_admin)):
    from datetime import timedelta
    branch = effective_branch(me, None)
    now = _now()
    t = BarricadeTemporaryApproval(
        branch_id=branch, approval_type=body.approval_type,
        vehicle_number_normalized=B.normalize_plate(body.vehicle_number) or None,
        object_type=body.object_type, linked_test_drive_id=body.linked_test_drive_id,
        linked_job_card_id=body.linked_job_card_id, linked_worker_id=body.linked_worker_id,
        valid_from=now, valid_until=now + timedelta(minutes=int(body.valid_minutes or 120)),
        status="active", notes=body.notes, created_by_admin_id=me.id, created_by_admin_name=me.name)
    db.add(t)
    B.log_decision(db, None, *_actor(me), "temp_approval",
                   f"Temporary {body.approval_type} approval for {body.vehicle_number}", None)
    db.commit()
    db.refresh(t)
    return ok(B.temp_out(t), "Temporary approval created")


# ── approval lists + lifecycle (Phase G) ────────────────────────────
def _event_no_map(db: Session, ids: list[str | None]) -> dict:
    ids = [i for i in ids if i]
    if not ids:
        return {}
    rows = db.execute(select(BarricadeEvent.id, BarricadeEvent.event_no)
                      .where(BarricadeEvent.id.in_(ids))).all()
    return {r[0]: r[1] for r in rows}


def _bills_out(db: Session, rows) -> list:
    m = _event_no_map(db, [b.used_event_id for b in rows])
    return [B.bill_out(b, used_event_no=m.get(b.used_event_id)) for b in rows]


def _temps_out(db: Session, rows) -> list:
    m = _event_no_map(db, [t.used_event_id for t in rows])
    return [B.temp_out(t, used_event_no=m.get(t.used_event_id)) for t in rows]


def _like_plate(col, vehicle):
    return col.like(f"%{B.normalize_plate(vehicle)}%")


@router.get("/admin/barricade/bill-approvals")
def admin_bill_approvals(status_f: str = Query(None, alias="status"), payment_status: str = Query(None),
                         vehicle: str = Query(None), limit: int = Query(200),
                         db: Session = Depends(get_db), me: User = Depends(require_admin)):
    stmt = select(BarricadeBillApproval).where(BarricadeBillApproval.branch_id == effective_branch(me, None))
    if status_f:
        stmt = stmt.where(BarricadeBillApproval.status == status_f)
    if payment_status:
        stmt = stmt.where(BarricadeBillApproval.payment_status == payment_status)
    if vehicle:
        stmt = stmt.where(_like_plate(BarricadeBillApproval.vehicle_number_normalized, vehicle))
    rows = db.scalars(stmt.order_by(BarricadeBillApproval.created_at.desc()).limit(min(max(limit, 1), 500))).all()
    return ok(_bills_out(db, rows))


@router.get("/admin/barricade/temp-approvals")
def admin_temp_approvals(status_f: str = Query(None, alias="status"),
                         approval_type: str = Query(None, alias="type"), vehicle: str = Query(None),
                         limit: int = Query(200), db: Session = Depends(get_db),
                         me: User = Depends(require_admin)):
    branch = effective_branch(me, None)
    barricade_service.expire_stale_temps(db, branch)
    stmt = select(BarricadeTemporaryApproval).where(BarricadeTemporaryApproval.branch_id == branch)
    if status_f:
        stmt = stmt.where(BarricadeTemporaryApproval.status == status_f)
    if approval_type:
        stmt = stmt.where(BarricadeTemporaryApproval.approval_type == approval_type)
    if vehicle:
        stmt = stmt.where(_like_plate(BarricadeTemporaryApproval.vehicle_number_normalized, vehicle))
    rows = db.scalars(stmt.order_by(BarricadeTemporaryApproval.created_at.desc()).limit(min(max(limit, 1), 500))).all()
    return ok(_temps_out(db, rows))


def _admin_bill(db: Session, bill_id: str, me: User) -> BarricadeBillApproval:
    b = db.get(BarricadeBillApproval, bill_id)
    if not b:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Bill approval not found")
    assert_branch_access(me, b.branch_id, "barricade-bill")
    return b


@router.post("/admin/barricade/bill-approvals/{bill_id}/approve")
def admin_bill_approve(bill_id: str, db: Session = Depends(get_db), me: User = Depends(require_admin)):
    return ok(B.bill_out(barricade_service.approve_bill(db, _admin_bill(db, bill_id, me), *_actor(me))), "Bill approved")


@router.post("/admin/barricade/bill-approvals/{bill_id}/reject")
def admin_bill_reject(bill_id: str, db: Session = Depends(get_db), me: User = Depends(require_admin)):
    return ok(B.bill_out(barricade_service.reject_bill(db, _admin_bill(db, bill_id, me), *_actor(me))), "Bill rejected")


@router.post("/admin/barricade/temp-approvals/{temp_id}/revoke")
def admin_temp_revoke(temp_id: str, db: Session = Depends(get_db), me: User = Depends(require_admin)):
    t = db.get(BarricadeTemporaryApproval, temp_id)
    if not t:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Temporary approval not found")
    assert_branch_access(me, t.branch_id, "barricade-temp")
    return ok(B.temp_out(barricade_service.revoke_temp(db, t, *_actor(me))), "Temporary approval revoked")


@router.get("/master/barricade/bill-approvals")
def master_bill_approvals(branch_id: str = Query(None), status_f: str = Query(None, alias="status"),
                          vehicle: str = Query(None), limit: int = Query(300),
                          db: Session = Depends(get_db), me: User = Depends(require_master)):
    stmt = select(BarricadeBillApproval)
    if branch_id:
        stmt = stmt.where(BarricadeBillApproval.branch_id == branch_id)
    if status_f:
        stmt = stmt.where(BarricadeBillApproval.status == status_f)
    if vehicle:
        stmt = stmt.where(_like_plate(BarricadeBillApproval.vehicle_number_normalized, vehicle))
    rows = db.scalars(stmt.order_by(BarricadeBillApproval.created_at.desc()).limit(min(max(limit, 1), 1000))).all()
    return ok(_bills_out(db, rows))


@router.get("/master/barricade/temp-approvals")
def master_temp_approvals(branch_id: str = Query(None), status_f: str = Query(None, alias="status"),
                          vehicle: str = Query(None), limit: int = Query(300),
                          db: Session = Depends(get_db), me: User = Depends(require_master)):
    barricade_service.expire_stale_temps(db, branch_id)
    stmt = select(BarricadeTemporaryApproval)
    if branch_id:
        stmt = stmt.where(BarricadeTemporaryApproval.branch_id == branch_id)
    if status_f:
        stmt = stmt.where(BarricadeTemporaryApproval.status == status_f)
    if vehicle:
        stmt = stmt.where(_like_plate(BarricadeTemporaryApproval.vehicle_number_normalized, vehicle))
    rows = db.scalars(stmt.order_by(BarricadeTemporaryApproval.created_at.desc()).limit(min(max(limit, 1), 1000))).all()
    return ok(_temps_out(db, rows))


# ════════════════════════════════════════════════════════════════════
#  MASTER (global)
# ════════════════════════════════════════════════════════════════════
@router.get("/master/barricade/overview")
def master_overview(db: Session = Depends(get_db), me: User = Depends(require_master)):
    from sqlalchemy import func
    today = _now().date().isoformat()
    rows = db.scalars(select(BarricadeEvent)).all()
    branches: dict[str, dict] = {}
    bnames = {b.id: b.name for b in db.scalars(select(Branch)).all()}
    totals = {"events": 0, "pending": 0, "opened": 0, "denied": 0,
              "entry_today": 0, "exit_today": 0}
    for e in rows:
        bkey = e.branch_id or "—"
        b = branches.setdefault(bkey, {"branch_id": e.branch_id, "branch_name": bnames.get(e.branch_id),
                                       "events": 0, "pending": 0, "opened": 0, "denied": 0,
                                       "entry_today": 0, "exit_today": 0})
        for d in (b, totals):
            d["events"] += 1
            if e.status == "pending_admin":
                d["pending"] += 1
            if e.status == "opened":
                d["opened"] += 1
            if e.status == "denied":
                d["denied"] += 1
            if str(e.event_time)[:10] == today:
                if e.direction == "entrance":
                    d["entry_today"] += 1
                else:
                    d["exit_today"] += 1
    # ── safety summary (global + per-branch) from the controllers themselves ──
    safety_totals = {"controllers": 0, "emergency_active": 0, "controller_offline": 0,
                     "real_relay_enabled": 0, "safety_unknown": 0}
    for c in db.scalars(select(BarricadeControllerConfig)).all():
        bkey = c.branch_id or "—"
        b = branches.setdefault(bkey, {"branch_id": c.branch_id, "branch_name": bnames.get(c.branch_id),
                                       "events": 0, "pending": 0, "opened": 0, "denied": 0,
                                       "entry_today": 0, "exit_today": 0})
        emergency = (c.last_status or "") == "emergency_stop"
        offline = bool(c.enabled) and not bool(getattr(c, "controller_online", False))
        real_relay = bool(c.enabled) and c.controller_type in ("http_relay", "mqtt_relay")
        unknown = (getattr(c, "barrier_state", None) or "unknown") == "unknown"
        b["safety"] = {"controller_type": c.controller_type, "enabled": bool(c.enabled),
                       "emergency_active": emergency, "controller_online": bool(getattr(c, "controller_online", False)),
                       "barrier_state": getattr(c, "barrier_state", None) or "unknown",
                       "beam_status": getattr(c, "beam_status", None) or "unknown",
                       "real_relay_enabled": real_relay}
        safety_totals["controllers"] += 1
        safety_totals["emergency_active"] += 1 if emergency else 0
        safety_totals["controller_offline"] += 1 if offline else 0
        safety_totals["real_relay_enabled"] += 1 if real_relay else 0
        safety_totals["safety_unknown"] += 1 if unknown else 0
    return ok({"totals": totals, "safety": safety_totals,
               "branches": sorted(branches.values(), key=lambda x: x["events"], reverse=True)})


@router.get("/master/barricade/events")
def master_events(branch_id: str = Query(None), direction: str = Query(None),
                  status_f: str = Query(None, alias="status"), vehicle: str = Query(None),
                  limit: int = Query(100), db: Session = Depends(get_db),
                  me: User = Depends(require_master)):
    stmt = select(BarricadeEvent)
    if branch_id:
        stmt = stmt.where(BarricadeEvent.branch_id == branch_id)
    stmt = _filtered_events(stmt, direction=direction, status_f=status_f, vehicle=vehicle)
    rows = db.scalars(stmt.limit(min(max(limit, 1), 500))).all()
    return ok([B.event_card(e) for e in rows])


@router.get("/master/barricade/events/{event_id}")
def master_event_detail(event_id: str, db: Session = Depends(get_db), me: User = Depends(require_master)):
    return ok(B.event_detail(db, _any_event(db, event_id)))


@router.post("/master/barricade/events/{event_id}/override")
def master_override(event_id: str, body: OverrideBody, db: Session = Depends(get_db),
                    me: User = Depends(require_master)):
    e = barricade_service.master_override(db, _any_event(db, event_id),
                                          body.action or "allow", me.id, me.name)
    return ok(B.event_detail(db, e), f"Override applied · {e.status}")


# ════════════════════════════════════════════════════════════════════
#  INGEST (NOT public — internal token OR admin/master JWT)
# ════════════════════════════════════════════════════════════════════
def _jwt_user(request: Request, db: Session) -> User | None:
    auth = request.headers.get("authorization") or ""
    if not auth.lower().startswith("bearer "):
        return None
    token = auth.split(" ", 1)[1].strip()
    try:
        payload = jwt.decode(token, settings.jwt_secret, algorithms=[settings.jwt_algorithm])
    except JWTError:
        return None
    return db.get(User, payload.get("sub"))


def _internal_principal(request: Request, db: Session):
    """Shared auth for the not-public service endpoints (ingest + internal config): the internal
    X-Barricade-Token (production) OR an admin/master JWT (test). Returns (actor_type, actor_id,
    actor_name, user_or_None, branch_scope) or None when unauthenticated. A worker JWT is rejected
    by the caller (it returns a user with role 'worker')."""
    shared = getattr(settings, "barricade_ingest_token", "") or ""
    header_tok = request.headers.get("x-barricade-token") or ""
    if shared and header_tok and hmac.compare_digest(header_tok, shared):
        return ("system", None, "detection-service", None, None)
    u = _jwt_user(request, db)
    if u:
        return ("master" if is_master(u) else "admin" if u.role.value == "admin" else u.role.value,
                u.id, u.name, u, (None if is_master(u) else u.branch_id))
    return None


@router.get("/barricade/internal/config")
def barricade_internal_config(request: Request, db: Session = Depends(get_db)):
    """INTERNAL config for the AI stream worker — enabled barricade cameras WITH decrypted
    credentials + a ready RTSP URL. NOT public: requires the internal X-Barricade-Token OR an
    admin/master JWT (never a worker, never anonymous). This is the ONLY place credentials leave the
    backend, and only to the authenticated internal consumer — the public admin/master APIs mask
    them. The frontend never calls this."""
    p = _internal_principal(request, db)
    if not p:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED,
                            "Internal barricade config requires an internal token or admin/master auth")
    _at, _aid, _an, user, branch_scope = p
    if user is not None and user.role.value == "worker":
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Not permitted")
    stmt = select(BarricadeCameraConfig).where(BarricadeCameraConfig.enabled.is_(True))
    if branch_scope:                                  # admin → own branch; master/internal → all
        stmt = stmt.where(BarricadeCameraConfig.branch_id == branch_scope)
    cams = db.scalars(stmt.order_by(BarricadeCameraConfig.branch_id, BarricadeCameraConfig.direction)).all()
    return ok([B.internal_camera_out(c) for c in cams])


@router.post("/barricade/ingest")
def barricade_ingest(body: IngestBody, request: Request, db: Session = Depends(get_db)):
    """Detection-service ingest. NEVER public: requires the internal X-Barricade-Token (if
    configured) OR an admin/master JWT. The detection service can only SUGGEST — the decision +
    relay open happen inside the backend."""
    actor_type, actor_id, actor_name = "system", None, "detection-service"
    branch_id = body.branch_id
    authed = False

    shared = getattr(settings, "barricade_ingest_token", "") or ""
    header_tok = request.headers.get("x-barricade-token") or ""
    if shared and header_tok and hmac.compare_digest(header_tok, shared):
        authed = True
    else:
        u = _jwt_user(request, db)
        if u and u.role.value in ("admin", "master_admin"):
            authed = True
            actor_type = "master" if is_master(u) else "admin"
            actor_id, actor_name = u.id, u.name
            branch_id = effective_branch(u, body.branch_id)
        elif u:
            # an authenticated non-admin (e.g. worker) is explicitly NOT allowed to ingest
            raise HTTPException(status.HTTP_403_FORBIDDEN, "Not permitted to ingest detections")

    if not authed:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED,
                            "Barricade ingest requires an internal token or admin/master auth")
    if not branch_id or not db.get(Branch, branch_id):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "A valid branch_id is required")

    e = barricade_service.ingest(
        db, branch_id=branch_id, direction=body.direction, object_type=body.object_type,
        detection_confidence=body.detection_confidence, vehicle_number_raw=body.vehicle_number_raw,
        ocr_confidence=body.ocr_confidence, camera_config_id=body.camera_config_id,
        actor_type=actor_type, actor_id=actor_id, actor_name=actor_name,
        frame=_decode_frame(body.frame_base64), source=body.source or "ingest")
    return ok(B.event_card(e), f"Detection ingested · {e.status}")


@router.post("/barricade/safety-status")
def barricade_safety_status(body: SafetyStatusBody, request: Request, db: Session = Depends(get_db)):
    """Controller/gateway safety heartbeat. NEVER public: requires the internal X-Barricade-Token OR
    an admin/master JWT (worker 403 / anon 401) — the production path for a real controller reporting
    beam/loop/barrier/power status. Only SUGGESTS status; the backend records it and (if configured)
    gates opens on it. No relay is actuated here."""
    p = _internal_principal(request, db)
    if not p:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED,
                            "Barricade safety status requires an internal token or admin/master auth")
    actor_type, actor_id, actor_name, user, branch_scope = p
    if user is not None and user.role.value == "worker":
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Not permitted")
    branch_id = branch_scope if branch_scope else body.branch_id
    if not branch_id or not db.get(Branch, branch_id):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "A valid branch_id is required")
    res = controller.apply_safety_status(db, branch_id, body.model_dump(),
                                         actor_type=actor_type, actor_id=actor_id, actor_name=actor_name)
    return ok(res, "Safety status updated" if res.get("applied") else res.get("detail"))


# ════════════════════════════════════════════════════════════════════
#  MEDIA (token-gated; no auth dependency)
# ════════════════════════════════════════════════════════════════════
@router.get("/barricade/media/{media_id}/view")
def media_view(media_id: str, token: str = Query(""), exp: str = Query(""),
               db: Session = Depends(get_db)):
    from ..models.barricade import BarricadeMedia
    m = db.get(BarricadeMedia, media_id)
    if not m:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Media not found")
    if m.status != "active":
        raise HTTPException(status.HTTP_410_GONE, "This detection frame is no longer available.")
    if not B.verify_view(media_id, token, exp):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Invalid or expired media link")
    path = B.local_path(m.file_path)
    if not path:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Media file is not available")
    return FileResponse(str(path), media_type=m.mime_type or "image/jpeg",
                        headers={"Cache-Control": "private, no-store"})
