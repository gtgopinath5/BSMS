"""Master Admin API — global oversight, view-only live monitoring,
branch + admin provisioning."""
from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel
from sqlalchemy import select, func
from sqlalchemy.orm import Session

from ..database import get_db
from ..models.branch import Branch
from ..models.bay import Bay
from ..models.user import User, UserRole
from ..models.job import JobCard, JobQueue
from ..models.session import ServiceSession, SessionStatus
from ..schemas.common import ok
from ..utils.auth import require_master
from ..utils.security import hash_password
from ..utils.audit import log_action
from ..services import streaming_service as _stream

router = APIRouter()


class BranchCreate(BaseModel):
    id: str
    name: str
    location: str = ""


class AdminCreate(BaseModel):
    name: str
    employee_id: str
    branch_id: str
    username: str
    password: str
    email: str | None = None
    mobile: str | None = None


@router.get("/branches")
def branches(db: Session = Depends(get_db), _: User = Depends(require_master)):
    rows = db.scalars(select(Branch)).all()
    out = []
    for b in rows:
        bays = db.scalar(select(func.count()).select_from(Bay).where(Bay.branch_id == b.id, Bay.is_active.isnot(False))) or 0
        crew = db.scalar(select(func.count()).select_from(User).where(
            User.branch_id == b.id, User.role == UserRole.worker)) or 0
        live = db.scalar(select(func.count()).select_from(ServiceSession).where(
            ServiceSession.status == SessionStatus.running)) or 0
        out.append({"id": b.id, "name": b.name, "bays": bays, "crew": crew, "live_feeds": live, "status": b.status})
    return ok(out)


@router.get("/live-monitoring")
def live_monitoring(db: Session = Depends(get_db), _: User = Depends(require_master)):
    """All running sessions across branches — view only."""
    rows = db.scalars(select(ServiceSession).where(ServiceSession.status == SessionStatus.running)).all()
    out = []
    for s in rows:
        job = db.get(JobCard, s.job_card_id)
        bay = db.get(Bay, s.bay_id)
        out.append({
            "session_id": s.id, "bay_number": bay.bay_number if bay else None,
            "worker_id": s.worker_id, "vehicle": job.vehicle_model if job else None,
            "service_type": job.service_type if job else None,
            "live_feed_url": _stream.signed_url(s.id),
        })
    return ok(out)


@router.get("/bay-monitoring")
def bay_monitoring(db: Session = Depends(get_db), _: User = Depends(require_master)):
    """Per-branch bays with live camera / session / timer status for the Master
    Bay Monitoring page. View-only. Live feed is exposed only while RUNNING and a
    camera is actually paired — a no-camera bay never fakes a green live feed."""
    from ..models.session import RecordingSession
    from ..utils import timer, recordings
    from ..services import camera_service
    from ..services.workflow_engine import resolve_estimate

    out = []
    for br in db.scalars(select(Branch).order_by(Branch.name)).all():
        bays = db.scalars(select(Bay).where(Bay.branch_id == br.id, Bay.is_active.isnot(False)).order_by(Bay.bay_number)).all()
        cards, running = [], 0
        for bay in bays:
            card = {
                "bay_id": bay.id, "bay_number": bay.bay_number,
                "camera_channel": getattr(bay, "camera_channel", None) or f"CH-{bay.bay_number:02d}",
                "bay_name": getattr(bay, "name", None), "bay_status": bay.status,
                "session_status": None, "live": False,
            }
            s = db.scalar(select(ServiceSession).where(
                ServiceSession.bay_id == bay.id,
                ServiceSession.status.in_([SessionStatus.assigned, SessionStatus.running, SessionStatus.paused])
            ))
            if s:
                job = db.get(JobCard, s.job_card_id)
                worker = db.get(User, s.worker_id)
                t = timer.get_state(bay.id)
                rec = db.scalar(select(RecordingSession).where(RecordingSession.service_session_id == s.id))
                is_running = s.status == SessionStatus.running
                is_paused = s.status == SessionStatus.paused
                if is_running:
                    running += 1
                # Estimate authority + truthful camera/handoff state (no fake green).
                q = db.scalar(select(JobQueue).where(JobQueue.job_card_id == s.job_card_id)
                              .order_by(JobQueue.created_at.desc()))
                _m, est_source, approved_cost = resolve_estimate(db, job, q)
                camera_paired = camera_service.get_camera(db, bay.id) is not None
                # a running bay with no camera is honestly "unavailable", never live
                live = is_running and camera_paired
                card.update({
                    "session_id": s.id, "session_status": s.status.value, "live": live,
                    "worker_id": s.worker_id, "worker_name": worker.name if worker else None,
                    "employee_id": worker.employee_id if worker else None,
                    "job_card_number": job.job_card_number if job else None,
                    "customer_name": job.customer_name if job else None,
                    "vehicle": job.vehicle_model if job else None,
                    "registration": job.vehicle_number if job else None,
                    "service_type": job.service_type if job else None,
                    "estimated_minutes": (s.estimated_duration or 0) // 60,
                    "estimate_source": est_source, "approved_cost": approved_cost,
                    "start_warnings": t.get("warnings") or [],
                    "camera_paired": camera_paired,
                    "timer": t,
                    # camera ON only while running with a paired camera; paused → paused; else off
                    "camera_status": ("on" if camera_paired else "unavailable") if is_running
                                     else ("paused" if is_paused else "off"),
                    "recording_status": (("recording" if camera_paired else "unavailable") if is_running
                                         else (recordings.status(rec.expiry_date, rec.status.value) if rec else "idle")),
                    # secure signed stream — only while RUNNING *and* a camera is paired
                    "live_feed_url": _stream.signed_url(s.id) if live else None,
                })
            cards.append(card)
        out.append({
            "branch_id": br.id, "branch_name": br.name, "status": br.status,
            "total_bays": len(bays), "running": running,
            "occupied": sum(1 for c in cards if c.get("session_id")),
            "bays": cards,
        })
    return ok(out)


@router.get("/global-analytics")
def global_analytics(db: Session = Depends(get_db), _: User = Depends(require_master)):
    completed = db.scalars(select(ServiceSession).where(ServiceSession.status == SessionStatus.completed)).all()
    total = len(completed)
    on_time = sum(1 for s in completed if (s.overtime_duration or 0) == 0)
    return ok({
        "branches": db.scalar(select(func.count()).select_from(Branch)) or 0,
        "completed_jobs": total,
        "on_time_rate": round(on_time / total * 100, 1) if total else 0,
    })


# ── Branch + admin provisioning ────────────────────────────────────
@router.post("/branches", status_code=status.HTTP_201_CREATED)
def create_branch(body: BranchCreate, db: Session = Depends(get_db), me: User = Depends(require_master)):
    if db.get(Branch, body.id):
        raise HTTPException(status.HTTP_409_CONFLICT, "Branch id already exists")
    db.add(Branch(id=body.id, name=body.name, location=body.location))
    log_action(db, "BRANCH_CREATE", "branch", body.id, me.id)
    db.commit()
    return ok({"id": body.id, "name": body.name}, "Branch created")


@router.get("/admins")
def list_admins(db: Session = Depends(get_db), _: User = Depends(require_master)):
    rows = db.scalars(select(User).where(User.role == UserRole.admin)).all()
    return ok([{
        "id": a.id, "name": a.name, "employee_id": a.employee_id,
        "branch_id": a.branch_id, "email": a.email, "status": a.status,
    } for a in rows])


@router.post("/admins", status_code=status.HTTP_201_CREATED)
def create_admin(body: AdminCreate, db: Session = Depends(get_db), me: User = Depends(require_master)):
    if db.scalar(select(User).where(User.username == body.username)):
        raise HTTPException(status.HTTP_409_CONFLICT, "Username already taken")
    if not db.get(Branch, body.branch_id):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Unknown branch")
    admin = User(name=body.name, role=UserRole.admin, branch_id=body.branch_id,
                 employee_id=body.employee_id, email=body.email, mobile=body.mobile,
                 username=body.username, hashed_password=hash_password(body.password))
    db.add(admin)
    log_action(db, "ADMIN_CREATE", "user", body.employee_id, me.id)
    db.commit(); db.refresh(admin)
    return ok({"id": admin.id, "name": admin.name, "branch_id": admin.branch_id}, "Admin created & bound to branch")
