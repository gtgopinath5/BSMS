"""Unified Job Lifecycle — event-driven engine (server side).

Mirrors the frontend WorkflowEngine. One admin action fires one event that
cascades to: the Service Session, the camera, the recording, the bay timer,
the queue (auto-promote), and customer notifications.

    JOB_ASSIGNED  -> create session (assigned) + camera (off) + recording (idle)
    JOB_STARTED   -> session running, camera on, recording recording, notify
    JOB_PAUSED    -> session paused, camera off, recording paused, notify
    JOB_RESUMED   -> session running, camera on, recording recording, notify
    JOB_COMPLETED -> session completed, recording available (14d signed URL),
                     bay released, next queued job promoted, notify
"""
import logging
import uuid
from datetime import datetime, timezone

from fastapi import HTTPException, status as http_status
from sqlalchemy import select
from sqlalchemy.orm import Session

log = logging.getLogger("baywatch.workflow")

from ..models.job import JobQueue, JobCard, QueueStatus
from ..models.bay import Bay, BayTempAssignment
from ..models.customer_approval import CustomerApprovalRequest
from ..models.session import (
    ServiceSession, CameraSession, RecordingSession, Notification,
    SessionStatus, RecordingStatus,
)
from ..models.user import User
from ..utils import ids, timer, recordings, storage
from ..utils.audit import log_action


def _now() -> datetime:
    return datetime.now(timezone.utc)


# ── Lifecycle state machine (hardening) ────────────────────────────
# The ONLY legal precondition status for each lifecycle event. A second Start on
# a running session, a Resume on a non-paused one, or a Complete before Start are
# rejected with 409 — so double-clicks never reset the countdown or relaunch FFmpeg.
_TRANSITIONS = {
    "JOB_STARTED":   {SessionStatus.assigned},
    "JOB_PAUSED":    {SessionStatus.running},
    "JOB_RESUMED":   {SessionStatus.paused},
    "JOB_COMPLETED": {SessionStatus.running, SessionStatus.paused},
}
_TRANSITION_MSG = {
    "JOB_STARTED":   "This bay's job is already running.",
    "JOB_PAUSED":    "Can't pause — the job isn't running.",
    "JOB_RESUMED":   "Can't resume — the job isn't paused.",
    "JOB_COMPLETED": "Can't complete — the job hasn't started.",
}


def assert_transition(session: ServiceSession, event: str) -> None:
    allowed = _TRANSITIONS.get(event)
    if allowed is not None and session.status not in allowed:
        raise HTTPException(http_status.HTTP_409_CONFLICT, _TRANSITION_MSG.get(
            event, f"Illegal {event} from {session.status.value}."))


# ── Estimate authority: a SUBMITTED customer approval wins ──────────
def _latest_approval(db: Session, job: JobCard | None, queue_item: JobQueue | None) -> CustomerApprovalRequest | None:
    appr = None
    if queue_item is not None:
        appr = db.scalar(select(CustomerApprovalRequest).where(
            CustomerApprovalRequest.queue_job_id == queue_item.id
        ).order_by(CustomerApprovalRequest.created_at.desc()))
    if appr is None and job is not None:
        appr = db.scalar(select(CustomerApprovalRequest).where(
            CustomerApprovalRequest.job_card_id == job.id
        ).order_by(CustomerApprovalRequest.created_at.desc()))
    return appr


def resolve_estimate(db: Session, job: JobCard | None, queue_item: JobQueue | None) -> tuple[int, str, float | None]:
    """Authoritative live estimate. A SUBMITTED approval's approved_total_minutes
    drives the session; otherwise the original job-card estimate (never mutated).
    Returns (minutes, source, approved_cost). source = 'approved' | 'job_card'."""
    appr = _latest_approval(db, job, queue_item)
    if appr and appr.status == "submitted" and (appr.approved_total_minutes or 0) > 0:
        return int(appr.approved_total_minutes), "approved", appr.approved_total_cost
    return (int(job.estimated_minutes) if job and job.estimated_minutes else 45), "job_card", None


def handoff_signals(db: Session, bay_id: str, job: JobCard | None = None,
                    queue_item: JobQueue | None = None) -> dict:
    """Truthful device + approval readiness at the bay handoff (no fake green).
    Reused by Start (warnings), Assign (readiness preview) and the dashboard."""
    from . import camera_service, mqtt_service           # lazy: avoid import cycles
    from ..models.timer_device import TimerDevice
    camera_paired = camera_service.get_camera(db, bay_id) is not None
    timer_paired = db.scalar(select(TimerDevice).where(TimerDevice.bay_id == bay_id)) is not None
    try:
        mqtt_ok = bool(mqtt_service.status().get("connected"))
    except Exception:
        mqtt_ok = False
    appr = _latest_approval(db, job, queue_item)
    appr_status = appr.status if appr else None
    appr_pending = bool(appr and appr.status not in ("submitted", "cancelled", "expired"))
    warnings = []
    if not camera_paired:
        warnings.append("Started — no camera paired; recording unavailable.")
    if not timer_paired or not mqtt_ok:
        warnings.append("Started — physical timer not updated.")
    if appr_pending:
        warnings.append("Customer approval still pending — using the current job-card estimate.")
    return {
        "warnings": warnings,
        "readiness": {"camera_paired": camera_paired, "timer_paired": timer_paired, "mqtt_ok": mqtt_ok},
        "approval": {
            "status": appr_status, "pending": appr_pending,
            "approved_cost": (appr.approved_total_cost if appr and appr.status == "submitted" else None),
            "approved_minutes": (appr.approved_total_minutes if appr and appr.status == "submitted" else None),
        },
    }


# ── Bay-first worker resolution (single source of truth) ───────────
def resolve_bay_worker(db: Session, bay_id: str) -> str | None:
    """The worker that currently OWNS a bay: an active temporary replacement
    (start_date ≤ today ≤ end_date) wins over the bay's permanent primary worker.
    Returns None for an *unstaffed* bay (no primary, no active temp) — such a bay
    is not operational and cannot take a job. This is THE one place worker
    selection is derived; the UI never picks a worker for a job."""
    from datetime import date
    today = date.today()
    temp = db.scalar(
        select(BayTempAssignment).where(
            BayTempAssignment.bay_id == bay_id,
            BayTempAssignment.start_date <= today,
            BayTempAssignment.end_date >= today,
        )
    )
    if temp:
        return temp.replacement_worker_id
    bay = db.get(Bay, bay_id)
    return bay.primary_worker_id if bay else None


# ── (1) ASSIGN: queue item -> live bay + Service Session ────────────
def create_from_assign(db: Session, queue_item: JobQueue, bay: Bay, by: str) -> ServiceSession:
    job = db.get(JobCard, queue_item.job_card_id)
    # Bay is the source of truth: resolve the worker FROM the target bay at
    # assignment (so a temp replacement made after queueing is respected).
    worker_id = resolve_bay_worker(db, bay.id) or queue_item.worker_id
    ss_id = ids.next_service_session_id(db, ServiceSession)
    # unique per session (a bay is reused across sessions, so a deterministic
    # CAM-{bay} id collides on the camera_sessions PK). Keep the bay number for readability.
    cam_id = f"CAM-{bay.bay_number:02d}-{ss_id.rsplit('-', 1)[-1]}"
    rec_id = ids.next_recording_id(db, RecordingSession)

    # Estimate authority: a SUBMITTED customer approval drives the timer; else the
    # original job-card estimate (which is never overwritten — only read here).
    est_minutes, _est_source, _approved_cost = resolve_estimate(db, job, queue_item)

    session = ServiceSession(
        id=ss_id,
        job_card_id=queue_item.job_card_id,
        worker_id=worker_id,
        bay_id=bay.id,
        customer_id=job.customer_id if job else None,
        status=SessionStatus.assigned,
        estimated_duration=est_minutes * 60,
    )
    db.add(session)
    db.flush()   # insert the ServiceSession first so the FK targets below resolve
    db.add(CameraSession(id=cam_id, service_session_id=ss_id, bay_id=bay.id, status="off"))
    db.add(RecordingSession(
        id=rec_id, service_session_id=ss_id, worker_id=worker_id,
        customer_id=session.customer_id, job_card_id=queue_item.job_card_id,
        status=RecordingStatus.idle,
    ))

    # surface on the bay; keep the queue row's worker aligned with the bay owner
    queue_item.worker_id = worker_id
    queue_item.status = QueueStatus.assigned
    queue_item.bay_id = bay.id
    bay.status = "running"
    log_action(db, "JOB_ASSIGNED", "service_session", ss_id, by)
    db.commit()
    db.refresh(session)
    return session


# ── (3-5) lifecycle events ─────────────────────────────────────────
def emit(db: Session, event: str, session: ServiceSession, by: str, extra: dict | None = None) -> ServiceSession:
    extra = extra or {}
    # Hardening: reject illegal lifecycle transitions (409) BEFORE any side effect,
    # so a double Start never resets the timer / relaunches recording, etc.
    assert_transition(session, event)
    cam = db.scalar(select(CameraSession).where(CameraSession.service_session_id == session.id))
    rec = db.scalar(select(RecordingSession).where(RecordingSession.service_session_id == session.id))
    bay = db.get(Bay, session.bay_id)
    t = _now()
    audit_meta: dict | None = None

    if event == "JOB_STARTED":
        # Bay-first: work BEGINS now — re-resolve the worker from the bay so a
        # temporary replacement made after assignment is honoured. The queue row
        # must follow too (it is matched by worker_id at completion).
        if session.status == SessionStatus.assigned:
            w = resolve_bay_worker(db, session.bay_id)
            if w and w != session.worker_id:
                log.info("bay-first: %s worker re-resolved %s → %s at START",
                         session.id, session.worker_id, w)
                session.worker_id = w
                if rec:
                    rec.worker_id = w
                q = db.scalar(select(JobQueue).where(
                    JobQueue.job_card_id == session.job_card_id,
                    JobQueue.status == QueueStatus.assigned))
                if q:
                    q.worker_id = w
        # Estimate authority (re-resolved at START — a customer may have submitted the
        # approval between assign and start). A SUBMITTED approval drives the countdown.
        _job = db.get(JobCard, session.job_card_id)
        _q = db.scalar(select(JobQueue).where(
            JobQueue.job_card_id == session.job_card_id,
            JobQueue.status == QueueStatus.assigned))
        est_minutes, est_source, approved_cost = resolve_estimate(db, _job, _q)
        session.estimated_duration = est_minutes * 60
        # Truthful handoff warnings (no fake green): surfaced + stored for review.
        signals = handoff_signals(db, session.bay_id, _job, _q)
        warns = signals["warnings"]
        session.status = SessionStatus.running
        session.start_time = session.start_time or t
        if cam:
            cam.status = "on"; cam.started_at = cam.started_at or t
        if rec:
            rec.status = RecordingStatus.recording
            rec.recording_start = rec.recording_start or t
        if bay:
            bay.status = "running"
        timer.start(session.bay_id, session.estimated_duration, session.id,
                    {"job_card_id": session.job_card_id, "worker_id": session.worker_id,
                     "warnings": warns, "estimate_source": est_source, "approved_cost": approved_cost})
        _start_recording_capture(db, session, bay)
        _notify(db, session, "SERVICE_STARTED", "Your vehicle service has started.",
                channels=["SMS", "Email", "In-App"])
        audit_meta = {"warnings": warns, "estimate_source": est_source,
                      "approved_cost": approved_cost, "estimated_minutes": est_minutes}

    elif event == "JOB_PAUSED":
        session.status = SessionStatus.paused
        if cam:
            cam.status = "off"
        if rec:
            rec.status = RecordingStatus.idle
        if bay:
            bay.status = "paused"
        timer.pause(session.bay_id)
        _pause_recording_capture(session)
        _notify(db, session, "SERVICE_PAUSED", "Your service is temporarily paused.", channels=["In-App"])

    elif event == "JOB_RESUMED":
        session.status = SessionStatus.running
        if cam:
            cam.status = "on"
        if rec:
            rec.status = RecordingStatus.recording
        if bay:
            bay.status = "running"
        timer.resume(session.bay_id)
        _resume_recording_capture(db, session)
        _notify(db, session, "SERVICE_RESUMED", "Your service has resumed.", channels=["In-App"])

    elif event == "JOB_COMPLETED":
        elapsed = timer.stop(session.bay_id)
        actual = extra.get("actual_duration") or elapsed
        session.status = SessionStatus.completed
        session.end_time = t
        session.actual_duration = actual
        session.overtime_duration = max(0, actual - session.estimated_duration)
        if cam:
            cam.status = "off"; cam.stopped_at = t
        if rec:
            video_url = _stop_recording_capture(db, session, bay, actual)
            rec.recording_end = t
            rec.duration_seconds = actual
            rec.created_at = t
            rec.expiry_date = recordings.expiry_from(t)
            rec.status = RecordingStatus.active
            rec.video_url = video_url or rec.video_url
        if bay:
            bay.status = "available"
        _promote_next(db, session)
        _generate_completion_pdf(session)
        _notify(db, session, "SERVICE_COMPLETED",
                "Your service is complete. Report & recording are available.",
                channels=["SMS", "Email", "In-App"])

    # mirror the event to the physical ESP32 timer (backend stays source of truth)
    _publish_timer_mqtt(event, session, bay)
    # mirror the lifecycle onto a SENT Customer Live Watch link, if one exists
    _mirror_customer_watch(db, session, event, by)

    log_action(db, event, "service_session", session.id, by, new=audit_meta)
    db.commit()
    db.refresh(session)
    return session


def _mirror_customer_watch(db: Session, session: ServiceSession, event: str, by: str) -> None:
    """Keep a SENT customer watch link's status in lock-step with the service session, so
    the customer page flips to live / paused / ended automatically. No-op when no link was
    sent. Never lets a watch error break the job."""
    try:
        from ..models.customer_watch import CustomerWatchSession, WatchDecision, WatchStatus
        mapping = {
            "JOB_STARTED":  (WatchStatus.live,      "SESSION_STARTED"),
            "JOB_PAUSED":   (WatchStatus.paused,    "SESSION_PAUSED"),
            "JOB_RESUMED":  (WatchStatus.live,      "SESSION_RESUMED"),
            "JOB_COMPLETED": (WatchStatus.completed, "SESSION_COMPLETED"),
        }
        target = mapping.get(event)
        if not target:
            return
        cw = db.scalar(select(CustomerWatchSession).where(
            CustomerWatchSession.service_session_id == session.id,
            CustomerWatchSession.decision == WatchDecision.sent,
        ).order_by(CustomerWatchSession.created_at.desc()))
        if not cw or cw.status in (WatchStatus.completed, WatchStatus.expired):
            return
        cw.status, action = target
        log_action(db, action, "customer_watch", cw.id, by)   # committed by emit()
    except Exception:
        log.exception("customer-watch: mirror failed for %s on %s", event, session.id)


def _promote_next(db: Session, session: ServiceSession) -> None:
    """Mark the active queue item completed; promote the worker's next queued job."""
    active = db.scalar(
        select(JobQueue).where(
            JobQueue.job_card_id == session.job_card_id,
            JobQueue.worker_id == session.worker_id,
        )
    )
    if active:
        active.status = QueueStatus.completed
    nxt = db.scalars(
        select(JobQueue)
        .where(JobQueue.worker_id == session.worker_id, JobQueue.status == QueueStatus.queued)
        .order_by(JobQueue.queue_position)
    ).first()
    if nxt:
        # remains queued until an admin assigns a bay; this just flags it "up next"
        nxt.queue_position = 0


def _notify(db: Session, session: ServiceSession, ntype: str, message: str, channels: list[str]) -> None:
    if not session.customer_id:
        return
    db.add(Notification(
        id=str(uuid.uuid4()), customer_id=session.customer_id,
        service_session_id=session.id, type=ntype, message=message,
        channels=",".join(channels),
    ))
    # External delivery (SMS/Email) is dispatched via Celery when configured;
    # falls back to a no-op so the API runs without MSG91/SendGrid.
    try:
        from ..tasks import notification_tasks
        notification_tasks.dispatch(session.customer_id, ntype, message, channels)
    except Exception:
        pass


# ── Recording capture hooks (Celery/FFmpeg when available) ─────────
def _start_recording_capture(db: Session, session: ServiceSession, bay: Bay | None) -> None:
    """START: resolve the bay's paired camera (Camera Registry) and launch FFmpeg
    capture via the Recording Service. Never lets a recording error break the job."""
    try:
        from . import camera_service, recording_service
        job = db.get(JobCard, session.job_card_id)
        worker = db.get(User, session.worker_id) if session.worker_id else None
        rec = db.scalar(select(RecordingSession).where(RecordingSession.service_session_id == session.id))
        source = camera_service.resolve_source(db, session.bay_id)
        recording_service.start({
            "session_id": session.id, "bay_id": session.bay_id, "source": source,
            "recording_id": rec.id if rec else None,
            "job_card_number": job.job_card_number if job else None,
            "worker_name": worker.name if worker else None,
            "customer_name": job.customer_name if job else None,
            "vehicle_number": job.vehicle_number if job else None,
        })
    except Exception:
        log.exception("recording: start failed for %s", session.id)


def _pause_recording_capture(session: ServiceSession) -> None:
    try:
        from . import recording_service
        recording_service.pause(session.id)
    except Exception:
        log.exception("recording: pause failed for %s", session.id)


def _resume_recording_capture(db: Session, session: ServiceSession) -> None:
    try:
        from . import camera_service, recording_service
        recording_service.resume(session.id, camera_service.resolve_source(db, session.bay_id))
    except Exception:
        log.exception("recording: resume failed for %s", session.id)


def _stop_recording_capture(db: Session, session: ServiceSession, bay: Bay | None, duration: int) -> str | None:
    """COMPLETE: stop FFmpeg, concat segments → video.mp4. Records the LOCAL path +
    size on the RecordingSession (Drive upload happens later in the scheduler).
    The customer-facing playback URL is the authorized backend endpoint."""
    try:
        from . import recording_service
        res = recording_service.stop(session.id)
        rec = db.scalar(select(RecordingSession).where(RecordingSession.service_session_id == session.id))
        if rec:
            rec.video_path = res.get("video_path")
            rec.file_size = res.get("file_size") or 0
        return res.get("video_key")
    except Exception:
        log.exception("recording: stop failed for %s", session.id)
        return None


def _publish_timer_mqtt(event: str, session: ServiceSession, bay: Bay | None) -> None:
    """Mirror a lifecycle event to the physical ESP32 timer over MQTT. The ESP32
    only displays what the backend sends — backend is the single source of truth.
    Never lets an MQTT error (broker down / dormant) break the job."""
    if not bay:
        return
    try:
        from . import mqtt_service
        n = bay.bay_number
        if event == "JOB_COMPLETED":
            mqtt_service.publish_event(n, "complete")     # → unique completion sound
            mqtt_service.publish_done(session.bay_id, n)  # → ESP32 shows DONE/READY
            return
        ev = {"JOB_STARTED": "start", "JOB_PAUSED": "pause", "JOB_RESUMED": "resume"}.get(event)
        if ev:
            mqtt_service.publish_event(n, ev)                          # → start/pause/resume beep
            mqtt_service.publish_current_state(session.bay_id, n)      # → immediate state sync
    except Exception:
        log.exception("mqtt: publish failed for %s on bay %s", event, getattr(bay, "bay_number", "?"))


def _generate_completion_pdf(session: ServiceSession) -> None:
    try:
        from ..tasks import recording_tasks  # pdf generation lives alongside tasks
        recording_tasks.generate_completion_pdf.delay(session.id)
    except Exception:
        pass
