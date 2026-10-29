"""Reports (Admin + Master Admin). Includes the recording column (signed URL +
status) on worker performance and work-completion."""
from fastapi import APIRouter, Depends, Query
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..database import get_db
from ..models.job import JobCard
from ..models.session import ServiceSession, RecordingSession, SessionStatus
from ..models.user import User
from ..schemas.common import ok
from ..utils.auth import require_admin, is_master
from ..utils import recordings
from ..services import camera_service

router = APIRouter()


def _recording_available(db: Session, bay_id: str, rec_cell: dict) -> bool:
    """Truthful, camera-gated availability — matches the worker/customer model: a
    bay with no paired camera only ever produced a synthetic source, never the
    customer's real recording, so it is honestly 'not available'."""
    return bool(rec_cell.get("available")) and camera_service.get_camera(db, bay_id) is not None


def _recording_cell(db: Session, session_id: str) -> dict:
    rec = db.scalar(select(RecordingSession).where(RecordingSession.service_session_id == session_id))
    if not rec:
        return {"status": "expired", "available": False, "url": None}
    from ..services import recording_service
    st = recordings.status(rec.expiry_date, rec.status.value)
    # Truthful: a recording is 'available' only when a real copy exists (archived on
    # Drive or the local file is present) AND it isn't expired — so the completion
    # report/PDF link is live only for a recording that can actually be played.
    local_present = recording_service.local_path(rec.video_path) is not None
    available = recordings.is_available(rec, local_present)
    return {
        "recording_id": rec.id, "status": st, "available": available,
        "session_id": session_id,
        "recording_date": recordings.fmt_date(rec.created_at or rec.recording_end),
        "duration": recordings.duration_full(rec.duration_seconds),
        "expiry_date": recordings.fmt_date(rec.expiry_date),
        "days_left": recordings.days_left(rec.expiry_date),
        "file_size_mb": round((rec.file_size or 0) / 1e6, 1),
        "drive_url": rec.drive_url,
        "url": recordings.signed_url(rec.id, rec.expiry_date) if available else None,
    }


@router.get("/worker-performance")
def worker_performance(
    worker_id: str | None = Query(None), branch_id: str | None = None,
    db: Session = Depends(get_db), user: User = Depends(require_admin),
):
    stmt = select(ServiceSession).where(ServiceSession.status == SessionStatus.completed)
    if worker_id:
        stmt = stmt.where(ServiceSession.worker_id == worker_id)
    if not is_master(user):           # Admin reports are confined to own-branch workers
        stmt = stmt.join(User, ServiceSession.worker_id == User.id).where(User.branch_id == user.branch_id)
    rows = db.scalars(stmt.order_by(ServiceSession.end_time.desc())).all()
    from ..utils.completion import started_meta_for
    started_meta = started_meta_for(db, [s.id for s in rows])
    out = []
    for s in rows:
        job = db.get(JobCard, s.job_card_id)
        est = (s.estimated_duration or 0) // 60
        act = (s.actual_duration or 0) // 60
        ot = (s.overtime_duration or 0) // 60
        score = 100 if ot == 0 else max(70, 100 - ot // 3)
        meta = started_meta.get(s.id) or {}
        rec_cell = _recording_cell(db, s.id)
        out.append({
            "session_id": s.id, "date": s.end_time.isoformat() if s.end_time else None,
            "worker_id": s.worker_id, "bay_id": s.bay_id,
            "vehicle": job.vehicle_model if job else None,
            "service_type": job.service_type if job else None,
            "estimated": est, "actual": act, "overtime": ot, "score": score,
            "estimate_source": meta.get("estimate_source") or "job_card",
            "approved_cost": meta.get("approved_cost"),
            "recording_available": _recording_available(db, s.bay_id, rec_cell),
            "recording": rec_cell,
        })
    return ok(out)


def _initials(name: str | None) -> str:
    return "".join(p[0] for p in (name or "?").split()[:2]).upper() or "?"


@router.get("/work-completion")
def work_completion(
    branch_id: str | None = None, date_from: str | None = None, date_to: str | None = None,
    db: Session = Depends(get_db), user: User = Depends(require_admin),
):
    """Completed sessions enriched for the Work Completion log: worker/bay/branch
    names, estimated vs actual minutes, overtime, score, and the recording cell.
    Admins see only their branch; master admins see every branch."""
    from datetime import timezone
    from ..models.bay import Bay
    from ..models.branch import Branch
    from ..models.user import UserRole

    from ..utils.completion import pause_counts_for, derive_pause, started_meta_for

    is_master = user.role == UserRole.master_admin
    rows = db.scalars(
        select(ServiceSession).where(ServiceSession.status == SessionStatus.completed)
        .order_by(ServiceSession.end_time.desc())
    ).all()

    # Pause count + duration come from the shared completion helper — the single
    # source of truth used by every Work Completion surface (see utils/completion).
    pause_counts = pause_counts_for(db, [s.id for s in rows])
    # Authoritative estimate source / approved cost / warning summary as captured
    # on the JOB_STARTED audit row (truthful "what was used at start"; never recomputed).
    started_meta = started_meta_for(db, [s.id for s in rows])

    ucache, bcache, brcache = {}, {}, {}

    def _u(uid):
        if uid not in ucache:
            ucache[uid] = db.get(User, uid) if uid else None
        return ucache[uid]

    def _bay(bid):
        if bid not in bcache:
            bcache[bid] = db.get(Bay, bid) if bid else None
        return bcache[bid]

    def _branch(brid):
        if brid not in brcache:
            brcache[brid] = db.get(Branch, brid) if brid else None
        return brcache[brid]

    out = []
    for s in rows:
        job = db.get(JobCard, s.job_card_id)
        brid = job.branch_id if job else None
        if not is_master and user.branch_id and brid and brid != user.branch_id:
            continue
        worker = _u(s.worker_id)
        bay = _bay(s.bay_id)
        branch = _branch(brid)

        est_min = round((s.estimated_duration or 0) / 60)
        if s.actual_duration is not None:
            actual_min = round(s.actual_duration / 60)
        elif s.start_time and s.end_time:
            actual_min = round((s.end_time - s.start_time).total_seconds() / 60)
        else:
            actual_min = est_min
        ot_min = round((s.overtime_duration or 0) / 60) if s.overtime_duration is not None else max(0, actual_min - est_min)
        score = 100 if ot_min == 0 else max(70, 100 - ot_min // 3)
        end = s.end_time

        # Timer analysis — truthful pause derivation (shared helper, no faked events).
        pc = pause_counts.get(s.id, 0)
        paused_min, paused_known, clock_min = derive_pause(s.start_time, s.end_time, s.actual_duration, pc)

        # Estimate authority + warnings as recorded at START (safe {} for legacy jobs).
        meta = started_meta.get(s.id) or {}
        rec_cell = _recording_cell(db, s.id)

        out.append({
            "estimate_source": meta.get("estimate_source") or "job_card",
            "approved_cost": meta.get("approved_cost"),
            "warning_summary": meta.get("warnings") or [],
            "recording_available": _recording_available(db, s.bay_id, rec_cell),
            "recording_status": rec_cell.get("status"),
            "recording_expiry": rec_cell.get("expiry_date"),
            "session_id": s.id, "job_card_number": job.job_card_number if job else None,
            "worker_id": s.worker_id, "worker_name": worker.name if worker else None,
            "employee_id": worker.employee_id if worker else None, "avatar": _initials(worker.name if worker else None),
            "bay_number": bay.bay_number if bay else None,
            "bay_name": bay.name if bay else None,
            "worker_role": (worker.role.value if worker and worker.role else None),
            "worker_department": worker.department if worker else None,
            "branch_id": brid, "branch_name": (branch.name if branch else None) or brid or "—",
            "vehicle": job.vehicle_model if job else None,
            "registration": job.vehicle_number if job else None,
            "service_type": job.service_type if job else None,
            "customer_name": job.customer_name if job else None,
            "est_min": est_min, "actual_min": actual_min, "overtime_min": ot_min, "score": score,
            "clock_min": clock_min, "paused_min": paused_min, "pause_count": pc, "paused_known": paused_known,
            "completed_at": end.isoformat() if end else None,
            "started_at": s.start_time.isoformat() if s.start_time else None,
            "date": end.strftime("%Y-%m-%d") if end else None,
            "start_time": s.start_time.strftime("%H:%M") if s.start_time else "—",
            "end_time": end.strftime("%H:%M") if end else "—",
            "recording": rec_cell,
        })
    return ok(out)


@router.get("/branch-summary")
def branch_summary(branch_id: str | None = None, period: str = "month",
                   db: Session = Depends(get_db), user: User = Depends(require_admin)):
    stmt = select(ServiceSession).where(ServiceSession.status == SessionStatus.completed)
    if not is_master(user):           # Admin summary = own branch only
        stmt = stmt.join(User, ServiceSession.worker_id == User.id).where(User.branch_id == user.branch_id)
    completed = db.scalars(stmt).all()
    total = len(completed)
    on_time = sum(1 for s in completed if (s.overtime_duration or 0) == 0)
    return ok({
        "completed": total,
        "on_time": on_time,
        "on_time_rate": round(on_time / total * 100, 1) if total else 0,
    })
