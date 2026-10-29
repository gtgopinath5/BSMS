"""Worker portal API — the logged-in worker's OWN data only (view-only).
Workers never control timers; they read their assigned job, queue and history.
"""
from fastapi import APIRouter, Depends
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..database import get_db
from ..models.job import JobCard, JobQueue, QueueStatus
from ..models.bay import Bay
from ..models.session import ServiceSession, RecordingSession, SessionStatus
from ..models.user import User
from ..schemas.common import ok
from ..utils.auth import require_worker
from ..utils import timer, recordings
from ..utils.completion import pause_counts_for, derive_pause
from ..services import workflow_engine, camera_service

router = APIRouter()


_PRIO = {"high": "P1", "medium": "P2", "low": "P3"}


def _initials(name):
    return "".join(p[0] for p in (name or "?").split()[:2]).upper() or "?"


def _parts_from_services(services, sess_status) -> list:
    """Normalise the job's parsed `services` JSON into a parts table the worker
    can read: code · name · estimated minutes · status. Tolerates the various
    key shapes the extraction engine has emitted over time."""
    out = []
    for sv in (services or []):
        if not isinstance(sv, dict):
            continue
        code = sv.get("product_code") or sv.get("code") or sv.get("part_code") or "—"
        name = (sv.get("part_name") or sv.get("service") or sv.get("name")
                or sv.get("matched_phrase") or "Service item")
        mins = (sv.get("time_minutes") or sv.get("default_minutes") or sv.get("minutes")
                or sv.get("estimated_minutes") or 0)
        st = ("in_progress" if sess_status in ("running", "paused")
              else "done" if sess_status == "completed" else "pending")
        out.append({"code": code, "name": name, "minutes": mins, "status": st})
    return out


def _active_payload(db: Session, s: ServiceSession) -> dict:
    """Full job-card payload for the worker's active-job view: live timer, the
    rich job-card sections, parts table, camera/recording status and the
    assignment → started → completed timeline timestamps. View-only."""
    job = db.get(JobCard, s.job_card_id)
    bay = db.get(Bay, s.bay_id)
    worker = db.get(User, s.worker_id)
    q = db.scalar(select(JobQueue).where(JobQueue.job_card_id == s.job_card_id))
    logged = None
    if job and getattr(job, "created_at", None):
        logged = job.created_at.strftime("%d %b %Y · %H:%M")

    status = s.status.value
    is_running = s.status == SessionStatus.running
    is_paused = s.status == SessionStatus.paused
    rec = db.scalar(select(RecordingSession).where(RecordingSession.service_session_id == s.id))
    camera_status = "on" if is_running else ("paused" if is_paused else "off")
    if is_running:
        recording_status = "recording"
    elif is_paused:
        recording_status = "paused"
    elif status == "completed" and rec:
        recording_status = recordings.status(rec.expiry_date, rec.status.value)
    else:
        recording_status = "idle"
    recording_cell = None
    if status == "completed" and rec:
        from ..services import recording_service
        st = recordings.status(rec.expiry_date, rec.status.value)
        # presence-aware: a real copy must exist (Drive or local), not just "not expired"
        _local_present = recording_service.local_path(rec.video_path) is not None
        _avail = recordings.is_available(rec, _local_present)
        recording_cell = {
            "recording_id": rec.id, "status": st, "available": _avail,
            "session_id": rec.service_session_id,
            "recording_date": recordings.fmt_date(rec.created_at or rec.recording_end),
            "duration": recordings.duration_full(rec.duration_seconds),
            "expiry_date": recordings.fmt_date(rec.expiry_date),
            "days_left": recordings.days_left(rec.expiry_date),
            "file_size_mb": round((rec.file_size or 0) / 1e6, 1),
            "drive_url": rec.drive_url,
            "url": recordings.signed_url(rec.id, rec.expiry_date) if _avail else None,
        }

    def _hm(dt):
        return dt.strftime("%H:%M") if dt else None

    # live timer while active; for a completed job synthesise the FINAL state
    # from the persisted actual/estimated durations (the Redis key is gone).
    t = timer.get_state(s.bay_id)
    if status == "completed":
        est_s = s.estimated_duration or 0
        act = s.actual_duration if s.actual_duration is not None else est_s
        t = {
            "status": "COMPLETED", "current_status": "COMPLETED",
            "estimated_seconds": est_s, "elapsed": act,
            "remaining": est_s - act, "overtime": max(0, act - est_s),
            "overtime_status": act > est_s,
        }

    # Authoritative estimate source (submitted approval vs job-card) + truthful
    # handoff warnings — surfaced TOP-LEVEL so they show in every state, not just
    # while the live timer is running. Backend stays the source of truth.
    est_minutes, estimate_source, approved_cost = workflow_engine.resolve_estimate(db, job, q)
    start_warnings = (t.get("warnings") or []) if isinstance(t, dict) else []
    # Truthful: a recording only exists when the bay has a paired camera (a missing
    # camera yields a synthetic test source, never the customer's actual service).
    has_camera = camera_service.get_camera(db, s.bay_id) is not None
    recording_available = has_camera and (is_running or bool(recording_cell and recording_cell.get("available")))

    return {
        "session_id": s.id, "status": status,
        "bay_number": bay.bay_number if bay else None,
        "camera_channel": getattr(bay, "camera_channel", None) or (f"CH-{bay.bay_number:02d}" if bay else None),
        "priority": _PRIO.get(q.priority.value if q else "", "P2"),
        "estimated_minutes": (s.estimated_duration or 0) // 60,
        "estimate_source": estimate_source,        # 'approved' | 'job_card'
        "approved_cost": approved_cost,            # set only when a submitted approval drives it
        "start_warnings": start_warnings,          # truthful gaps (no camera / timer / approval pending)
        "recording_available": recording_available,
        "timer": t,   # live while active; final actual/overtime when completed
        # vehicle
        "job_card_number": job.job_card_number if job else None,
        "vehicle": job.vehicle_model if job else None,
        "registration": job.vehicle_number if job else None,
        "chassis_number": job.chassis_number if job else None,
        "engine_number": job.engine_number if job else None,
        "km_reading": job.km_reading if job else None,
        # customer
        "customer_name": job.customer_name if job else None,
        "customer_mobile": job.customer_mobile if job else None,
        "customer_email": job.customer_email if job else None,
        "customer_address": getattr(job, "customer_address", None) if job else None,
        # service
        "service_type": job.service_type if job else None,
        "repair_type": job.repair_type if job else None,
        "estimated_cost": job.estimated_cost if job else None,
        "logged": logged,
        # staff & voice
        "technician": worker.name if worker else None,
        "employee_id": worker.employee_id if worker else None,
        "avatar": _initials(worker.name if worker else None),
        "complaint": getattr(job, "complaint", None) if job else None,
        "notes": getattr(job, "notes", None) if job else None,
        "special_instructions": getattr(job, "special_instructions", None) if job else None,
        "qc_notes": getattr(job, "qc_notes", None) if job else None,
        "services": getattr(job, "services", None) if job else None,
        # parts table
        "parts": _parts_from_services(getattr(job, "services", None) if job else None, status),
        # camera + recording
        "camera_status": camera_status,
        "recording_status": recording_status,
        "recording": recording_cell,
        # timeline timestamps (assignment → started → ended)
        "assigned_at": _hm(getattr(s, "created_at", None)),
        "started_at": _hm(s.start_time),
        "ended_at": _hm(s.end_time),
    }


@router.get("/active")
def active(db: Session = Depends(get_db), me: User = Depends(require_worker)):
    # Prefer a live (assigned/running/paused) job…
    s = db.scalar(
        select(ServiceSession).where(
            ServiceSession.worker_id == me.id,
            ServiceSession.status != SessionStatus.completed,
        ).order_by(ServiceSession.created_at.desc())
    )
    # …otherwise show the most recently COMPLETED one so the worker still sees the
    # completed state (completion PDF + recording) after the admin clicks COMPLETE,
    # per the spec. A new assignment takes over automatically (it wins above).
    if not s:
        s = db.scalar(
            select(ServiceSession).where(
                ServiceSession.worker_id == me.id,
                ServiceSession.status == SessionStatus.completed,
            ).order_by(ServiceSession.end_time.desc())
        )
    if not s:
        return ok(None, "No active job")
    return ok(_active_payload(db, s))


@router.get("/queue")
def queue(db: Session = Depends(get_db), me: User = Depends(require_worker)):
    items = db.scalars(
        select(JobQueue).where(
            JobQueue.worker_id == me.id,
            JobQueue.status.in_([QueueStatus.queued, QueueStatus.assigned]),
        ).order_by(JobQueue.queue_position)
    ).all()
    out = []
    for it in items:
        job = db.get(JobCard, it.job_card_id)
        out.append({
            "id": it.id, "status": it.status.value, "priority": it.priority.value,
            "job_card_number": job.job_card_number if job else None,
            "vehicle": job.vehicle_model if job else None,
            "registration": job.vehicle_number if job else None,
            "service_type": job.service_type if job else None,
            "estimated_minutes": job.estimated_minutes if job else None,
        })
    return ok(out)


@router.get("/history")
def history(db: Session = Depends(get_db), me: User = Depends(require_worker)):
    rows = db.scalars(
        select(ServiceSession).where(
            ServiceSession.worker_id == me.id,
            ServiceSession.status == SessionStatus.completed,
        ).order_by(ServiceSession.end_time.desc())
    ).all()
    # Same pause source as Admin Work Completion — one truth across all screens.
    pause_counts = pause_counts_for(db, [s.id for s in rows])
    out = []
    for s in rows:
        job = db.get(JobCard, s.job_card_id)
        bay = db.get(Bay, s.bay_id)
        rec = db.scalar(select(RecordingSession).where(RecordingSession.service_session_id == s.id))
        est = (s.estimated_duration or 0) // 60
        act = (s.actual_duration or 0) // 60
        ot = (s.overtime_duration or 0) // 60
        rec_cell = {"status": "expired", "available": False, "url": None}
        if rec:
            st = recordings.status(rec.expiry_date, rec.status.value)
            rec_cell = {
                "recording_id": rec.id, "status": st, "available": st != "expired",
                "session_id": rec.service_session_id,
                "recording_date": recordings.fmt_date(rec.created_at or rec.recording_end),
                "duration": recordings.duration_full(rec.duration_seconds),
                "expiry_date": recordings.fmt_date(rec.expiry_date),
                "days_left": recordings.days_left(rec.expiry_date),
                "file_size_mb": round((rec.file_size or 0) / 1e6, 1),
                "drive_url": rec.drive_url,
                "url": recordings.signed_url(rec.id, rec.expiry_date) if st != "expired" else None,
            }
        # paused (reference) — shared helper, identical to Admin Work Completion.
        pc = pause_counts.get(s.id, 0)
        paused_min, paused_known, _clock_min = derive_pause(s.start_time, s.end_time, s.actual_duration, pc)
        out.append({
            "session_id": s.id, "date": s.end_time.isoformat() if s.end_time else None,
            "bay_number": bay.bay_number if bay else None,
            "vehicle": job.vehicle_model if job else None,
            "registration": job.vehicle_number if job else None,
            "service_type": job.service_type if job else None,
            "start_time": s.start_time.strftime("%H:%M") if s.start_time else None,
            "end_time": s.end_time.strftime("%H:%M") if s.end_time else None,
            "estimated": est, "actual": act, "overtime": ot,
            "paused_min": paused_min, "paused_known": paused_known, "pause_count": pc,
            "score": 100 if ot == 0 else max(70, 100 - ot // 3),
            "recording": rec_cell,
        })
    return ok(out)
