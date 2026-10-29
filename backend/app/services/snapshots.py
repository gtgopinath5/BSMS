"""Read-only snapshot builders shared by the REST GET routes and the
WebSocket push loops, so HTTP and WS always return the same shape.
"""
from sqlalchemy import select
from sqlalchemy.orm import Session

from datetime import datetime, timezone

from ..models.job import JobCard, JobQueue
from ..models.bay import Bay
from ..models.user import User
from ..models.session import ServiceSession, SessionStatus
from ..models.timer_device import TimerDevice
from ..utils import timer

_TIMER_ONLINE_WINDOW = 90  # seconds — mirrors timers router ONLINE_WINDOW


def _timer_device(dev: TimerDevice | None, mqtt_connected: bool) -> dict:
    """Read-only physical-timer pairing summary for a bay (Live Bay Dashboard
    badge). Honest: never reports 'online' without a recent heartbeat."""
    if not dev:
        return {"paired": False, "timer_id": None, "status": "unpaired",
                "last_seen": None, "mqtt_connected": mqtt_connected}
    status = "disabled"
    if dev.enabled:
        ls = dev.last_seen
        if ls is not None and ls.tzinfo is None:
            ls = ls.replace(tzinfo=timezone.utc)
        age = (datetime.now(timezone.utc) - ls).total_seconds() if ls else None
        status = "online" if (age is not None and age <= _TIMER_ONLINE_WINDOW) else "offline"
    return {"paired": True, "timer_id": dev.timer_id, "status": status,
            "last_seen": dev.last_seen.isoformat() if dev.last_seen else None,
            "mqtt_connected": mqtt_connected}


def dashboard(db: Session) -> dict:
    """Admin live bay dashboard — all non-completed sessions + live timers."""
    from .workflow_engine import resolve_estimate           # lazy: avoid import cycle
    from . import camera_service, mqtt_service              # lazy: avoid import cycle
    try:
        mqtt_connected = bool(mqtt_service.status().get("connected"))
    except Exception:
        mqtt_connected = False
    sessions = db.scalars(
        select(ServiceSession).where(ServiceSession.status != SessionStatus.completed)
    ).all()
    out = []
    for s in sessions:
        job = db.get(JobCard, s.job_card_id)
        bay = db.get(Bay, s.bay_id)
        worker = db.get(User, s.worker_id) if s.worker_id else None
        ts = timer.get_state(s.bay_id)
        # Estimate authority + truthful handoff warnings (read-only surfacing).
        q = db.scalar(select(JobQueue).where(JobQueue.job_card_id == s.job_card_id)
                      .order_by(JobQueue.created_at.desc()))
        _m, est_source, approved_cost = resolve_estimate(db, job, q)
        # Truthful recording state — a recording only exists when the bay has a
        # paired camera (a missing camera yields a synthetic source, never a real
        # capture), so a running no-camera bay reads "unavailable", never green.
        is_running = s.status == SessionStatus.running
        is_paused = s.status == SessionStatus.paused
        camera_paired = camera_service.get_camera(db, s.bay_id) is not None
        rec_status = ("recording" if camera_paired else "unavailable") if is_running \
            else "paused" if is_paused else "idle"
        tdev = db.scalar(select(TimerDevice).where(TimerDevice.bay_id == s.bay_id))
        out.append({
            "session_id": s.id, "bay_id": s.bay_id,
            "bay_number": bay.bay_number if bay else None,
            "worker_id": s.worker_id,
            "worker_name": worker.name if worker else None,
            "employee_id": worker.employee_id if worker else None,
            "status": s.status.value,
            "job_card_number": job.job_card_number if job else None,
            "customer_name": job.customer_name if job else None,
            "vehicle": job.vehicle_model if job else None,
            "registration": job.vehicle_number if job else None,
            "service_type": job.service_type if job else None,
            "services": getattr(job, "services", None) if job else None,
            "estimated_minutes": (s.estimated_duration or 0) // 60,
            "estimate_source": est_source,
            "approved_cost": approved_cost,
            "start_warnings": ts.get("warnings") or [],
            "camera_paired": camera_paired,
            "recording_status": rec_status,
            "recording_available": camera_paired and is_running,
            "live_video_available": camera_paired and is_running,
            "timer": ts,
            "timer_device": _timer_device(tdev, mqtt_connected),
        })
    return {"bays": out, "timer_backend": timer.backend()}


def queue(db: Session, branch_id: str | None = None) -> dict:
    """Admin Job Assignment / Queue snapshot — identical shape to the REST GET /queue
    (grouped by worker, each row already carrying the intake + approval chips). Reuses the
    ONE shared serializer so HTTP and WS never drift. Branch-scoped from the JWT: an admin sees
    only their own branch's jobs; ``None`` = master/global."""
    from ..routers.queue import queue_grouped          # lazy: avoid import cycle
    return queue_grouped(db, branch_id)


def intake(db: Session, branch_id: str | None) -> list:
    """Admin Intake Evidence snapshot — worker-wise grouping. Branch-scoped: ``branch_id`` is
    taken from the authenticated JWT for an admin (own branch only); ``None`` = master/global.
    Carries only entry cards (counts, names, dates, linked status) — NO media bytes, NO file
    paths, NO token URLs."""
    from ..models.vehicle_intake import VehicleIntakeEntry
    from ..utils import intake as I
    stmt = select(VehicleIntakeEntry).where(VehicleIntakeEntry.deleted_at.is_(None))
    if branch_id:
        stmt = stmt.where(VehicleIntakeEntry.branch_id == branch_id)
    entries = db.scalars(stmt.order_by(VehicleIntakeEntry.created_at.desc())).all()
    return I.group_by_worker(db, entries)


def approvals(db: Session, branch_id: str | None) -> list:
    """Customer Approvals snapshot — a LIGHTWEIGHT change-signal list (id + status + version
    only). The admin list itself is server-filtered, so the client reloads its filtered view
    via the authenticated REST route when this signature changes. Branch-scoped from the JWT;
    NEVER carries the public token, customer PII items, or any link URL."""
    from ..models.customer_approval import CustomerApprovalRequest
    stmt = select(CustomerApprovalRequest).where(CustomerApprovalRequest.deleted_at.is_(None))
    if branch_id:
        stmt = stmt.where(CustomerApprovalRequest.branch_id == branch_id)
    rows = db.scalars(stmt.order_by(CustomerApprovalRequest.created_at.desc())).all()
    return [{"id": r.id, "status": r.status, "v": getattr(r, "current_version_no", 1)} for r in rows]


def barricade(db: Session, branch_id: str | None) -> dict:
    """AI Barricade live snapshot — SUMMARY only. Branch-scoped from the JWT: an admin sees only
    their own branch; ``None`` = master/global. Carries recent event cards (object/status/plate/
    decision), the pending-admin count, controller status, and today's entry/exit counts — NO image
    bytes, NO file paths, NO camera credentials."""
    from ..models.barricade import BarricadeEvent
    from ..utils import barricade as Bar
    stmt = select(BarricadeEvent)
    if branch_id:
        stmt = stmt.where(BarricadeEvent.branch_id == branch_id)
    rows = db.scalars(stmt.order_by(BarricadeEvent.event_time.desc()).limit(40)).all()
    today = datetime.now(timezone.utc).date().isoformat()
    pending = sum(1 for e in rows if e.status == "pending_admin")
    entry_today = sum(1 for e in rows if e.direction == "entrance" and str(e.event_time)[:10] == today)
    exit_today = sum(1 for e in rows if e.direction == "exit" and str(e.event_time)[:10] == today)
    # ── exit-approval counts (Phase G) — SUMMARY ints only, no PII/paths ──
    from ..models.barricade import BarricadeBillApproval as _Bill, BarricadeTemporaryApproval as _Temp
    from sqlalchemy import func as _f
    from ..services import barricade_service as _svc
    _svc.expire_stale_temps(db, branch_id)                       # keep temp statuses honest
    def _count(model, *conds):
        q = select(_f.count()).select_from(model)
        if branch_id:
            q = q.where(model.branch_id == branch_id)
        for c in conds:
            q = q.where(c)
        return int(db.scalar(q) or 0)
    approvals = {
        "active_bill": _count(_Bill, _Bill.status == "approved", _Bill.payment_status == "paid"),
        "active_temp": _count(_Temp, _Temp.status == "active"),
        "pending_exit": sum(1 for e in rows if e.status == "pending_admin" and e.direction == "exit"),
        "used_today": sum(1 for e in rows if e.authorization_source in ("bill", "temporary")
                          and str(e.event_time)[:10] == today),
    }
    from ..services import barricade_controller_service as ctrl
    return {
        "events": [Bar.event_card(e) for e in rows[:20]],
        "pending_count": pending,
        "today": {"entrance": entry_today, "exit": exit_today},
        "approvals": approvals,
        "controller": ctrl.status(db, branch_id),
    }


def worker_active(db: Session, worker_id: str) -> dict | None:
    # MUST mirror the REST GET /worker/active selection exactly, or the two feeds
    # disagree and the worker Active Job page blinks: prefer a live (assigned/running/
    # paused) job, else fall back to the most-recently COMPLETED one so the worker keeps
    # seeing the completion summary + recording after admin clicks COMPLETE.
    s = db.scalar(
        select(ServiceSession).where(
            ServiceSession.worker_id == worker_id,
            ServiceSession.status != SessionStatus.completed,
        ).order_by(ServiceSession.created_at.desc())
    )
    if not s:
        s = db.scalar(
            select(ServiceSession).where(
                ServiceSession.worker_id == worker_id,
                ServiceSession.status == SessionStatus.completed,
            ).order_by(ServiceSession.end_time.desc())
        )
    if not s:
        return None
    # same full job-card payload the REST /worker/active returns
    from ..routers.worker import _active_payload
    return _active_payload(db, s)
