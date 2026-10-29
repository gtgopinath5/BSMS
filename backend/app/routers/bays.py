import logging
from datetime import date, datetime, timezone
from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel
from sqlalchemy import select, func, text, update, delete as sa_delete
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from ..database import get_db, engine
from ..models.bay import Bay, BayTempAssignment
from ..models.user import User
from ..models.session import ServiceSession, RecordingSession, SessionStatus
from ..models.camera_device import BayCamera
from ..models.timer_device import TimerDevice
from ..models.job import JobCard, JobQueue, QueueStatus
from ..models.audit import AuditLog
from ..schemas.common import ok
from ..services import workflow_engine, mqtt_service
from ..utils import timer as timer_engine, recordings as rec_utils
from ..utils.auth import require_admin, is_master, assert_branch_access, effective_branch
from ..utils.audit import log_action

log = logging.getLogger("baywatch.bays")

router = APIRouter()

# A device (camera/ESP32 timer) is ONLINE if its heartbeat is within this window.
DEVICE_ONLINE_WINDOW = 90  # seconds


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


def _age_s(dt: datetime | None) -> float | None:
    if not dt:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return (_utcnow() - dt).total_seconds()


def _device_online(last_seen: datetime | None) -> bool:
    age = _age_s(last_seen)
    return age is not None and age <= DEVICE_ONLINE_WINDOW


def _require_worker_role(db: Session, user_id: str, what: str) -> User:
    """A bay's primary or temporary worker must be an actual WORKER user —
    blocks API bypass (e.g. binding an admin/customer id to a bay)."""
    from ..models.user import UserRole
    u = db.get(User, user_id)
    if not u:
        raise HTTPException(status.HTTP_404_NOT_FOUND, f"{what}: user not found")
    if u.role != UserRole.worker:
        raise HTTPException(status.HTTP_400_BAD_REQUEST,
                            f"{what}: user is a {u.role.value}, not a worker.")
    return u

# bays that are not soft-deleted (is_active True or legacy NULL)
_NOT_ARCHIVED = Bay.is_active.isnot(False)

_BAY_MIGRATED = False


def ensure_bay_schema() -> None:
    """Add Bay columns introduced after first release. Idempotent."""
    global _BAY_MIGRATED
    if _BAY_MIGRATED:
        return
    dialect = engine.dialect.name
    cols = [("name", "VARCHAR"), ("description", "VARCHAR"), ("camera_channel", "VARCHAR"),
            ("is_active", "BOOLEAN DEFAULT TRUE" if dialect == "postgresql" else "BOOLEAN DEFAULT 1")]
    with engine.begin() as conn:
        try:
            if dialect == "postgresql":
                existing = {r[0] for r in conn.execute(text(
                    "SELECT column_name FROM information_schema.columns WHERE table_name='bays'"))}
            else:
                existing = {r[1] for r in conn.execute(text("PRAGMA table_info(bays)"))}
        except Exception:
            existing = set()
        for name, ddl in cols:
            if name not in existing:
                try:
                    conn.execute(text(f"ALTER TABLE bays ADD COLUMN {name} {ddl}"))
                except Exception:
                    pass
    _BAY_MIGRATED = True


class TempAssign(BaseModel):
    replacement_worker_id: str
    start_date: date
    end_date: date
    reason: str = ""


class BayCreate(BaseModel):
    bay_number: int | None = None        # auto = max+1 when omitted
    name: str | None = None
    description: str | None = None
    camera_channel: str | None = None
    branch_id: str | None = None
    primary_worker_id: str | None = None
    status: str = "available"


class BayUpdate(BaseModel):
    name: str | None = None
    description: str | None = None
    camera_channel: str | None = None
    primary_worker_id: str | None = None
    status: str | None = None


class BayStatus(BaseModel):
    status: str   # available | maintenance | disabled


def _bay_out(db: Session, b: Bay, wnames: dict | None = None) -> dict:
    wn = (wnames or {}).get(b.primary_worker_id) if wnames else (
        (db.get(User, b.primary_worker_id).name if b.primary_worker_id and db.get(User, b.primary_worker_id) else None))
    return {
        "id": b.id, "bay_number": b.bay_number,
        "name": getattr(b, "name", None), "description": getattr(b, "description", None),
        "camera_channel": getattr(b, "camera_channel", None),
        "branch_id": b.branch_id, "primary_worker_id": b.primary_worker_id,
        "primary_worker_name": wn, "status": b.status,
        "is_active": getattr(b, "is_active", True),
    }


def _has_active_session(db: Session, bay_id: str) -> bool:
    s = db.scalar(select(ServiceSession).where(
        ServiceSession.bay_id == bay_id,
        ServiceSession.status.in_([SessionStatus.assigned, SessionStatus.running, SessionStatus.paused])))
    return s is not None


@router.get("")
def list_bays(db: Session = Depends(get_db), admin: User = Depends(require_admin)):
    ensure_bay_schema()
    q = select(Bay).where(_NOT_ARCHIVED)
    if not is_master(admin):                      # Admin sees only own-branch bays
        q = q.where(Bay.branch_id == admin.branch_id)
    bays = db.scalars(q.order_by(Bay.bay_number)).all()
    wnames = {u.id: u.name for u in db.scalars(select(User)).all()}
    return ok([_bay_out(db, b, wnames) for b in bays])


@router.post("")
def create_bay(body: BayCreate, db: Session = Depends(get_db), admin: User = Depends(require_admin)):
    ensure_bay_schema()
    num = body.bay_number
    if not num:
        num = (db.scalar(select(func.max(Bay.bay_number))) or 0) + 1
    # GLOBAL uniqueness (not per-branch): MQTT topics + the physical ESP32 key
    # on bay_number, so a duplicate across branches would collide on bay/{n}/*.
    elif db.scalar(select(Bay).where(Bay.bay_number == num, _NOT_ARCHIVED)):
        raise HTTPException(status.HTTP_409_CONFLICT, f"Bay {num} already exists")
    if body.primary_worker_id:
        _require_worker_role(db, body.primary_worker_id, "Primary worker")
    bay = Bay(bay_number=num, name=body.name, description=body.description,
              camera_channel=body.camera_channel or f"CH-{num:02d}",
              branch_id=effective_branch(admin, body.branch_id),
              primary_worker_id=body.primary_worker_id or None,
              status=body.status or "available", is_active=True)
    db.add(bay)
    log_action(db, "BAY_CREATE", "bay", None, admin.id, new={"bay_number": num, "name": body.name})
    db.commit(); db.refresh(bay)
    return ok(_bay_out(db, bay), f"Bay {num:02d} created")


@router.put("/{bay_id}")
def update_bay(bay_id: str, body: BayUpdate, db: Session = Depends(get_db), admin: User = Depends(require_admin)):
    ensure_bay_schema()
    bay = db.get(Bay, bay_id)
    if not bay:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Bay not found")
    assert_branch_access(admin, bay.branch_id, "update bay")
    changes = body.model_dump(exclude_unset=True)
    if changes.get("primary_worker_id"):
        _require_worker_role(db, changes["primary_worker_id"], "Primary worker")
    for field, value in changes.items():
        setattr(bay, field, value)
    log_action(db, "BAY_UPDATE", "bay", bay_id, admin.id, new={"bay_number": bay.bay_number})
    db.commit(); db.refresh(bay)
    return ok(_bay_out(db, bay), "Bay updated")


@router.post("/{bay_id}/duplicate")
def duplicate_bay(bay_id: str, db: Session = Depends(get_db), admin: User = Depends(require_admin)):
    ensure_bay_schema()
    src = db.get(Bay, bay_id)
    if not src:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Bay not found")
    assert_branch_access(admin, src.branch_id, "duplicate bay")
    num = (db.scalar(select(func.max(Bay.bay_number))) or 0) + 1
    bay = Bay(bay_number=num, name=(src.name or f"Bay {src.bay_number}") + " (copy)",
              description=src.description, camera_channel=f"CH-{num:02d}",
              branch_id=src.branch_id, primary_worker_id=src.primary_worker_id,
              status="available", is_active=True)
    db.add(bay)
    log_action(db, "BAY_DUPLICATE", "bay", None, admin.id, new={"from": src.bay_number, "bay_number": num})
    db.commit(); db.refresh(bay)
    return ok(_bay_out(db, bay), f"Bay duplicated → Bay {num:02d}")


@router.post("/{bay_id}/status")
def set_status(bay_id: str, body: BayStatus, db: Session = Depends(get_db), admin: User = Depends(require_admin)):
    bay = db.get(Bay, bay_id)
    if not bay:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Bay not found")
    assert_branch_access(admin, bay.branch_id, "set bay status")
    if body.status in ("maintenance", "disabled") and _has_active_session(db, bay_id):
        raise HTTPException(status.HTTP_409_CONFLICT,
                            "Cannot change an active bay. Complete or stop the current service first.")
    bay.status = body.status
    bay.is_active = body.status != "disabled"
    log_action(db, "BAY_STATUS", "bay", bay_id, admin.id, new={"status": body.status})
    db.commit()
    return ok(message=f"Bay set to {body.status}")


@router.delete("/{bay_id}")
def delete_bay(bay_id: str, db: Session = Depends(get_db), admin: User = Depends(require_admin)):
    """Delete a bay.

    A bay is referenced by job_queue, service_sessions and camera_sessions via
    FK. Hard-deleting one that has *history* (completed sessions / recordings)
    would either violate those FKs (→ the IntegrityError that produced the 500)
    or destroy the audit trail. So:
      • pending queue items are detached (bay_id → NULL, back to the unassigned
        pool — that FK is nullable);
      • transient temp-assignments are removed;
      • a bay with history is ARCHIVED (soft delete: is_active=False) so it
        vanishes from every list yet keeps its records and FK integrity;
      • a truly empty bay is hard-deleted to keep the table tidy.
    Everything runs in one transaction with rollback on error, and any failure
    returns a clean HTTPException (which carries CORS headers) — never a raw 500.
    """
    bay = db.get(Bay, bay_id)
    if not bay:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Bay not found")
    assert_branch_access(admin, bay.branch_id, "delete bay")
    if bay.status in ("running", "paused") or _has_active_session(db, bay_id):
        raise HTTPException(status.HTTP_409_CONFLICT,
                            "Cannot delete an active bay. Complete or stop the current service first.")
    num = bay.bay_number
    try:
        # detach pending (not-yet-completed) queue items → unassigned pool
        db.execute(
            update(JobQueue)
            .where(JobQueue.bay_id == bay_id,
                   JobQueue.status.in_([QueueStatus.queued, QueueStatus.assigned]))
            .values(bay_id=None)
        )
        # remove transient temp assignments
        db.execute(sa_delete(BayTempAssignment).where(BayTempAssignment.bay_id == bay_id))
        # any remaining references (history) → archive; else hard delete
        refs = (db.scalar(select(func.count()).select_from(ServiceSession).where(ServiceSession.bay_id == bay_id)) or 0) \
             + (db.scalar(select(func.count()).select_from(JobQueue).where(JobQueue.bay_id == bay_id)) or 0)
        if refs:
            bay.is_active = False
            bay.status = "deleted"
            mode = "archived"
        else:
            db.delete(bay)
            mode = "removed"
        log_action(db, "BAY_DELETE", "bay", bay_id, admin.id, old={"bay_number": num, "mode": mode})
        db.commit()
        log.info("BAY_DELETE ok · bay=%s num=%s mode=%s by=%s", bay_id, num, mode, admin.id)
    except IntegrityError:
        # last-resort: still referenced by something we didn't detach → archive
        db.rollback()
        b = db.get(Bay, bay_id)
        if b:
            b.is_active = False
            b.status = "deleted"
            db.commit()
            log.warning("BAY_DELETE archived after FK conflict · bay=%s", bay_id)
        return ok(message=f"Bay {num:02d} archived")
    except Exception:
        db.rollback()
        log.exception("BAY_DELETE failed · bay=%s", bay_id)
        raise HTTPException(status.HTTP_500_INTERNAL_SERVER_ERROR, "Could not delete bay — no changes were made.")
    return ok(message=f"Bay {num:02d} deleted")


@router.post("/{bay_id}/temp-assign")
def temp_assign(bay_id: str, body: TempAssign, db: Session = Depends(get_db), admin: User = Depends(require_admin)):
    bay = db.get(Bay, bay_id)
    if not bay:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Bay not found")
    assert_branch_access(admin, bay.branch_id, "temp-assign worker")
    if body.end_date < body.start_date:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "End date must be on/after start date.")
    _require_worker_role(db, body.replacement_worker_id, "Replacement worker")
    if body.replacement_worker_id == bay.primary_worker_id:
        raise HTTPException(status.HTTP_400_BAD_REQUEST,
                            "This worker is already the bay's primary worker.")
    # one active/future cover at a time — overlaps would make resolution ambiguous
    overlap = db.scalar(select(BayTempAssignment).where(
        BayTempAssignment.bay_id == bay_id,
        BayTempAssignment.end_date >= body.start_date,
        BayTempAssignment.start_date <= body.end_date))
    if overlap:
        raise HTTPException(status.HTTP_409_CONFLICT,
                            "Bay already has a temporary worker for that period. Revert it first.")
    ta = BayTempAssignment(bay_id=bay_id, replacement_worker_id=body.replacement_worker_id,
                           start_date=body.start_date, end_date=body.end_date, reason=body.reason)
    db.add(ta)
    log_action(db, "BAY_TEMP_ASSIGN", "bay", bay_id, admin.id,
               new={"replacement": body.replacement_worker_id, "until": body.end_date.isoformat(),
                    "reason": body.reason})
    db.commit()
    return ok(message="Temporary worker assigned")


# ══════════════════════════════════════════════════════════════════
#  Bay-first OPERATIONS — the Fleet View + details drawer (one source
#  of truth: each bay resolves its own worker / camera / timer / ESP32).
# ══════════════════════════════════════════════════════════════════
def _worker_card(u: User | None, *, is_temp: bool = False, temp_until: date | None = None) -> dict | None:
    if not u:
        return None
    return {"id": u.id, "name": u.name, "employee_id": u.employee_id,
            "is_temp": is_temp,
            "temp_until": temp_until.isoformat() if temp_until else None}


def _bay_op_status(bay: Bay, staffed: bool, sess: ServiceSession | None) -> str:
    """Operational status for the Fleet View row."""
    if getattr(bay, "is_active", True) is False or bay.status == "disabled":
        return "disabled"
    if bay.status == "maintenance":
        return "maintenance"
    if not staffed:
        return "no_worker"          # 🔴 needs staffing — not operational
    if sess and sess.status == SessionStatus.running:
        return "running"
    if sess and sess.status == SessionStatus.paused:
        return "paused"
    return "available"


@router.get("/operations")
def operations(db: Session = Depends(get_db), admin: User = Depends(require_admin)):
    """Fleet View: every active bay as a complete operational unit — current
    worker (primary or active temp), camera status, timer/ESP32+MQTT status,
    current job + live timer, and today's job count. Batched so it scales to
    50–100+ bays in a few queries. Attention bays are flagged for top-sorting."""
    ensure_bay_schema()
    bq = select(Bay).where(_NOT_ARCHIVED)
    if not is_master(admin):                      # Admin's dashboard = own branch only
        bq = bq.where(Bay.branch_id == admin.branch_id)
    bays = db.scalars(bq.order_by(Bay.bay_number)).all()
    cams = {c.bay_id: c for c in db.scalars(select(BayCamera)).all()}
    tmrs = {t.bay_id: t for t in db.scalars(select(TimerDevice)).all()}
    users = {u.id: u for u in db.scalars(select(User)).all()}

    today = date.today()
    temps = {t.bay_id: t for t in db.scalars(select(BayTempAssignment).where(
        BayTempAssignment.start_date <= today, BayTempAssignment.end_date >= today)).all()}

    live = db.scalars(select(ServiceSession).where(
        ServiceSession.status.in_([SessionStatus.assigned, SessionStatus.running, SessionStatus.paused]))).all()
    sess_by_bay = {s.bay_id: s for s in live}
    jobs = {j.id: j for j in db.scalars(select(JobCard).where(
        JobCard.id.in_([s.job_card_id for s in live]))).all()} if live else {}

    today0 = datetime.utcnow().replace(hour=0, minute=0, second=0, microsecond=0)
    counts = dict(db.execute(
        select(ServiceSession.bay_id, func.count()).where(
            ServiceSession.created_at >= today0).group_by(ServiceSession.bay_id)).all())

    mqtt_up = bool(mqtt_service.status().get("connected"))
    rows, summary = [], {"total": 0, "available": 0, "running": 0, "maintenance": 0,
                         "no_worker": 0, "attention": 0}

    for bay in bays:
        temp = temps.get(bay.id)
        if temp:
            worker = _worker_card(users.get(temp.replacement_worker_id), is_temp=True, temp_until=temp.end_date)
        else:
            worker = _worker_card(users.get(bay.primary_worker_id))
        staffed = worker is not None
        sess = sess_by_bay.get(bay.id)
        op_status = _bay_op_status(bay, staffed, sess)

        cam = cams.get(bay.id)
        cam_status = "unpaired" if not cam else ("disabled" if not cam.enabled
                     else ("online" if _device_online(cam.last_seen) else "offline"))
        tmr = tmrs.get(bay.id)
        tmr_online = bool(tmr and tmr.enabled and _device_online(tmr.last_seen))
        tmr_status = "unpaired" if not tmr else ("disabled" if not tmr.enabled
                     else ("online" if tmr_online else "offline"))
        esp_status = "synced" if (tmr_online and mqtt_up) else ("offline" if tmr else "unpaired")

        job = jobs.get(sess.job_card_id) if sess else None
        if sess and sess.status == SessionStatus.running:
            rec_status = "recording"
        elif sess and sess.status == SessionStatus.paused:
            rec_status = "paused"
        else:
            rec_status = "idle"
        tstate = timer_engine.get_state(bay.id) if sess else None

        attention = (op_status in ("no_worker", "maintenance", "disabled")
                     or cam_status == "offline" or tmr_status == "offline"
                     or (worker is not None and worker["is_temp"]))

        summary["total"] += 1
        if op_status == "available":
            summary["available"] += 1
        elif op_status == "running" or op_status == "paused":
            summary["running"] += 1
        elif op_status == "maintenance":
            summary["maintenance"] += 1
        elif op_status == "no_worker":
            summary["no_worker"] += 1
        if attention:
            summary["attention"] += 1

        rows.append({
            "bay_id": bay.id, "bay_number": bay.bay_number,
            "bay_name": bay.name or f"Bay {bay.bay_number:02d}",
            "camera_channel": bay.camera_channel or f"CH-{bay.bay_number:02d}",
            "branch_id": bay.branch_id,
            "status": op_status, "operational": staffed and op_status not in ("maintenance", "disabled"),
            "attention": attention,
            "worker": worker,
            "camera": cam_status, "timer": tmr_status, "esp32": esp_status, "mqtt": mqtt_up,
            "recording": rec_status,
            "today_jobs": int(counts.get(bay.id, 0)),
            "current_job": None if not sess else {
                "session_id": sess.id, "session_status": sess.status.value,
                "job_card_number": job.job_card_number if job else None,
                "vehicle": (job.vehicle_model or job.vehicle_number) if job else None,
                "remaining": (tstate or {}).get("remaining"),
                "estimated_seconds": (tstate or {}).get("estimated_seconds"),
                "overtime": (tstate or {}).get("overtime", 0),
            },
        })

    # attention first, then by bay number
    rows.sort(key=lambda r: (not r["attention"], r["bay_number"]))
    return ok({"summary": summary, "bays": rows})


@router.get("/{bay_id}/detail")
def bay_detail(bay_id: str, db: Session = Depends(get_db), _: User = Depends(require_admin)):
    """Drawer: full operational detail for one bay — worker (+performance),
    camera/timer/ESP32 device info, current service, today's count + recent
    history, and the bay's audit timeline."""
    bay = db.get(Bay, bay_id)
    if not bay:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Bay not found")

    today = date.today()
    temp = db.scalar(select(BayTempAssignment).where(
        BayTempAssignment.bay_id == bay_id,
        BayTempAssignment.start_date <= today, BayTempAssignment.end_date >= today))
    primary = db.get(User, bay.primary_worker_id) if bay.primary_worker_id else None
    cur_worker_id = temp.replacement_worker_id if temp else bay.primary_worker_id
    cur_worker = db.get(User, cur_worker_id) if cur_worker_id else None

    # worker performance: avg score over the worker's completed sessions
    perf = None
    if cur_worker:
        done = db.scalars(select(ServiceSession).where(
            ServiceSession.worker_id == cur_worker.id,
            ServiceSession.status == SessionStatus.completed)).all()
        if done:
            scores = []
            for s in done:
                ot = (s.overtime_duration or 0) // 60
                scores.append(100 if ot == 0 else max(70, 100 - ot // 3))
            perf = round(sum(scores) / len(scores))

    cam = db.scalar(select(BayCamera).where(BayCamera.bay_id == bay_id))
    tmr = db.scalar(select(TimerDevice).where(TimerDevice.bay_id == bay_id))
    tmr_online = bool(tmr and tmr.enabled and _device_online(tmr.last_seen))
    mqtt_up = bool(mqtt_service.status().get("connected"))

    sess = db.scalar(select(ServiceSession).where(
        ServiceSession.bay_id == bay_id,
        ServiceSession.status.in_([SessionStatus.assigned, SessionStatus.running, SessionStatus.paused])))
    cur_job = None
    if sess:
        job = db.get(JobCard, sess.job_card_id)
        t = timer_engine.get_state(bay_id)
        cur_job = {"session_id": sess.id, "session_status": sess.status.value,
                   "job_card_number": job.job_card_number if job else None,
                   "vehicle": (job.vehicle_model or job.vehicle_number) if job else None,
                   "service_type": job.service_type if job else None,
                   "remaining": t.get("remaining"), "overtime": t.get("overtime", 0)}

    today0 = datetime.utcnow().replace(hour=0, minute=0, second=0, microsecond=0)
    today_count = db.scalar(select(func.count()).select_from(ServiceSession).where(
        ServiceSession.bay_id == bay_id, ServiceSession.created_at >= today0)) or 0

    history = []
    recents = db.scalars(select(ServiceSession).where(
        ServiceSession.bay_id == bay_id, ServiceSession.status == SessionStatus.completed)
        .order_by(ServiceSession.end_time.desc()).limit(8)).all()
    for s in recents:
        j = db.get(JobCard, s.job_card_id)
        ot = (s.overtime_duration or 0) // 60
        history.append({"session_id": s.id, "job_card_number": j.job_card_number if j else None,
                        "vehicle": (j.vehicle_model or j.vehicle_number) if j else None,
                        "date": s.end_time.strftime("%d %b %H:%M") if s.end_time else None,
                        "overtime_min": ot})

    audits = db.scalars(select(AuditLog).where(AuditLog.entity_id == bay_id)
                        .order_by(AuditLog.timestamp.desc()).limit(12)).all()
    timeline = [{"action": a.action, "at": a.timestamp.isoformat() if a.timestamp else None,
                 "new": a.new_value} for a in audits]

    return ok({
        "bay_id": bay.id, "bay_number": bay.bay_number,
        "bay_name": bay.name or f"Bay {bay.bay_number:02d}",
        "camera_channel": bay.camera_channel or f"CH-{bay.bay_number:02d}",
        "branch_id": bay.branch_id,
        "status": _bay_op_status(bay, cur_worker is not None, sess),
        "worker": _worker_card(cur_worker, is_temp=bool(temp),
                               temp_until=temp.end_date if temp else None),
        "primary_worker": _worker_card(primary),
        "temp": None if not temp else {"reason": temp.reason,
                "from": temp.start_date.isoformat(), "until": temp.end_date.isoformat()},
        "performance": perf,
        "camera": None if not cam else {
            "id": cam.id, "camera_id": cam.camera_id, "name": cam.name, "ip_address": cam.ip_address,
            "status": ("disabled" if not cam.enabled else
                       "online" if _device_online(cam.last_seen) else "offline"),
            "last_seen": cam.last_seen.isoformat() if cam.last_seen else None},
        "timer": None if not tmr else {
            "id": tmr.id, "timer_id": tmr.timer_id, "name": tmr.name, "ip_address": tmr.ip_address,
            "firmware_version": tmr.firmware_version,
            "status": ("disabled" if not tmr.enabled else "online" if tmr_online else "offline"),
            "last_seen": tmr.last_seen.isoformat() if tmr.last_seen else None,
            "topic": mqtt_service.state_topic(bay.bay_number)},
        "esp32": "synced" if (tmr_online and mqtt_up) else ("offline" if tmr else "unpaired"),
        "mqtt": mqtt_up,
        "current_job": cur_job, "today_jobs": int(today_count),
        "history": history, "audit": timeline,
    })


@router.post("/{bay_id}/revert-worker")
def revert_worker(bay_id: str, db: Session = Depends(get_db), admin: User = Depends(require_admin)):
    """Revert Now — end an active temporary replacement early and restore the
    bay's permanent primary worker (auto-restore also happens when the temp
    assignment's end_date passes). Audited."""
    bay = db.get(Bay, bay_id)
    if not bay:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Bay not found")
    assert_branch_access(admin, bay.branch_id, "revert bay worker")
    today = date.today()
    active = db.scalars(select(BayTempAssignment).where(
        BayTempAssignment.bay_id == bay_id, BayTempAssignment.end_date >= today)).all()
    if not active:
        raise HTTPException(status.HTTP_409_CONFLICT, "No active temporary worker to revert.")
    primary = db.get(User, bay.primary_worker_id) if bay.primary_worker_id else None
    for ta in active:
        db.delete(ta)
    log_action(db, "BAY_WORKER_REVERT", "bay", bay_id, admin.id,
               new={"restored_to": primary.name if primary else None})
    db.commit()
    return ok({"bay_id": bay_id, "primary_worker": _worker_card(primary)},
              f"Reverted to {primary.name if primary else 'primary worker'}")


@router.get("/{bay_id}/current-worker")
def current_worker(bay_id: str, db: Session = Depends(get_db), _: User = Depends(require_admin)):
    bay = db.get(Bay, bay_id)
    if not bay:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Bay not found")
    today = date.today()
    temp = db.scalar(
        select(BayTempAssignment).where(
            BayTempAssignment.bay_id == bay_id,
            BayTempAssignment.start_date <= today,
            BayTempAssignment.end_date >= today,
        )
    )
    worker_id = temp.replacement_worker_id if temp else bay.primary_worker_id
    worker = db.get(User, worker_id) if worker_id else None
    return ok({
        "bay_id": bay_id,
        "worker_id": worker_id,
        "worker_name": worker.name if worker else None,
        "is_temp": bool(temp),
    })
