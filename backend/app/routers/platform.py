"""Platform layer — global search, notification feed, job timeline, audit logs.

READ-ONLY, additive endpoints over data the system already records (no existing
API or model is modified):

    GET /api/v1/platform/search?q=          → one search across customers, workers,
                                              jobs/vehicles, bays, cameras, timers,
                                              recordings (Ctrl+K command palette)
    GET /api/v1/platform/activity?q=&limit= → recent audit events (notification
                                              center + searchable audit-log page)
    GET /api/v1/platform/timeline/{ss_id}   → complete event timeline for one job
                                              (audit trail + recording milestones)

Access: admin & master (the operations roles). Customers/workers keep their own
scoped endpoints — progressive disclosure is preserved.
"""
import logging
from datetime import datetime, timezone, timedelta

from fastapi import APIRouter, Depends, Query
from sqlalchemy import select, or_, desc, func
from sqlalchemy.orm import Session

from ..database import get_db
from ..models.audit import AuditLog
from ..models.bay import Bay
from ..models.camera_device import BayCamera
from ..models.timer_device import TimerDevice
from ..models.job import JobCard
from ..models.session import ServiceSession, RecordingSession, SessionStatus, RecordingStatus
from ..models.user import User, UserRole
from ..schemas.common import ok
from ..utils.auth import require_admin

log = logging.getLogger("baywatch.platform")
router = APIRouter()

MAX_PER_GROUP = 5
DEVICE_ONLINE_WINDOW = 90   # a device seen within 90s is "online" (matches bays.py)


@router.get("/search")
def global_search(q: str = Query(..., min_length=1), db: Session = Depends(get_db),
                  admin: User = Depends(require_admin)):
    """One search across every operational entity. Each hit carries a `nav` target
    (the portal tab that owns it) so the palette can jump straight there."""
    like = f"%{q}%"
    out = {}

    jobs = db.scalars(select(JobCard).where(or_(
        JobCard.job_card_number.ilike(like), JobCard.vehicle_number.ilike(like),
        JobCard.vehicle_model.ilike(like), JobCard.customer_name.ilike(like),
        JobCard.customer_mobile.ilike(like),
    )).order_by(desc(JobCard.created_at)).limit(MAX_PER_GROUP)).all()
    out["jobs"] = [{
        "id": j.id, "title": f"{j.job_card_number} · {j.vehicle_model or j.vehicle_number or '—'}",
        "sub": f"{j.customer_name or '—'} · {j.vehicle_number or ''}", "nav": "assign",
    } for j in jobs]

    workers = db.scalars(select(User).where(
        User.role == UserRole.worker,
        or_(User.name.ilike(like), User.employee_id.ilike(like)),
    ).limit(MAX_PER_GROUP)).all()
    out["workers"] = [{
        "id": w.id, "title": w.name, "sub": f"{w.employee_id or ''} · worker", "nav": "workers",
    } for w in workers]

    bays = db.scalars(select(Bay).where(or_(
        Bay.name.ilike(like), Bay.camera_channel.ilike(like),
    )).limit(MAX_PER_GROUP)).all()
    # also match "bay 3" / plain numbers against bay_number
    digits = "".join(ch for ch in q if ch.isdigit())
    if digits:
        more = db.scalars(select(Bay).where(Bay.bay_number == int(digits)).limit(2)).all()
        seen = {b.id for b in bays}
        bays += [b for b in more if b.id not in seen]
    out["bays"] = [{
        "id": b.id, "title": b.name or f"Bay {b.bay_number:02d}",
        "sub": f"BAY {b.bay_number:02d} · {b.status}", "nav": "bays",
    } for b in bays[:MAX_PER_GROUP]]

    cams = db.scalars(select(BayCamera).where(or_(
        BayCamera.camera_id.ilike(like), BayCamera.name.ilike(like), BayCamera.ip_address.ilike(like),
    )).limit(MAX_PER_GROUP)).all()
    out["cameras"] = [{
        "id": c.id, "title": c.name or c.camera_id, "sub": f"{c.camera_id} · {c.ip_address or 'no ip'}",
        "nav": "cameras",
    } for c in cams]

    tmrs = db.scalars(select(TimerDevice).where(or_(
        TimerDevice.timer_id.ilike(like), TimerDevice.name.ilike(like), TimerDevice.ip_address.ilike(like),
    )).limit(MAX_PER_GROUP)).all()
    out["timers"] = [{
        "id": t.id, "title": t.name or t.timer_id, "sub": f"{t.timer_id} · fw {t.firmware_version or '—'}",
        "nav": "timers",
    } for t in tmrs]

    recs = db.scalars(select(RecordingSession).where(or_(
        RecordingSession.id.ilike(like), RecordingSession.service_session_id.ilike(like),
    )).order_by(desc(RecordingSession.created_at)).limit(MAX_PER_GROUP)).all()
    out["recordings"] = [{
        "id": r.id, "title": r.id, "sub": f"{r.service_session_id} · {r.status.value if r.status else '—'}",
        "nav": "storage",
    } for r in recs]

    total = sum(len(v) for v in out.values())
    return ok({"q": q, "total": total, "groups": out})


# ── friendly labels for the notification center / audit log ────────
def _row(a: AuditLog, names: dict) -> dict:
    return {
        "id": a.id,
        "action": a.action,
        "entity_type": a.entity_type,
        "entity_id": a.entity_id,
        "by": names.get(a.changed_by) or ("system" if not a.changed_by else a.changed_by[:8]),
        "at": a.timestamp.isoformat() if a.timestamp else None,
        "new": a.new_value,
    }


@router.get("/activity")
def activity(q: str = Query("", description="filter by action/entity/user"),
             limit: int = Query(50, le=200),
             db: Session = Depends(get_db), admin: User = Depends(require_admin)):
    """Newest-first audit events. Powers the notification center (recent slice)
    and the searchable Audit Logs page (with ?q=)."""
    stmt = select(AuditLog).order_by(desc(AuditLog.timestamp)).limit(limit)
    if q:
        like = f"%{q}%"
        stmt = select(AuditLog).where(or_(
            AuditLog.action.ilike(like), AuditLog.entity_type.ilike(like),
            AuditLog.entity_id.ilike(like),
        )).order_by(desc(AuditLog.timestamp)).limit(limit)
    rows = db.scalars(stmt).all()
    ids = {a.changed_by for a in rows if a.changed_by}
    names = {u.id: u.name for u in db.scalars(select(User).where(User.id.in_(ids))).all()} if ids else {}
    return ok({"events": [_row(a, names) for a in rows]})


# ── Phase 9: operational health dashboard ──────────────────────────
def _count_online(db: Session, model) -> tuple[int, int]:
    """(total enabled devices, online-within-window) for a device registry."""
    cutoff = datetime.now(timezone.utc) - timedelta(seconds=DEVICE_ONLINE_WINDOW)
    total = db.scalar(select(func.count()).select_from(model).where(model.enabled.is_(True))) or 0
    online = db.scalar(select(func.count()).select_from(model).where(
        model.enabled.is_(True), model.last_seen.is_not(None), model.last_seen >= cutoff)) or 0
    return int(total), int(online)


@router.get("/system-health")
def system_health(db: Session = Depends(get_db), admin: User = Depends(require_admin)):
    """One operational snapshot for the health dashboard (Phase 9): every
    dependency's live state + the counts an operator watches each morning.
    Read-only; aggregates data the system already records. `status` per subsystem
    is ok | degraded | down; `overall` is the worst non-ok subsystem that matters."""
    from ..utils import timer
    from ..services import mqtt_service, recording_service, drive_service, scheduler_service

    # ── core dependencies ──
    db_ok = True
    try:
        db.execute(select(func.count()).select_from(Bay))
    except Exception:
        db_ok = False

    timer_persistent = timer.persistent()
    mqtt = mqtt_service.status()
    drive = drive_service.health()

    # ── device registries ──
    cam_total, cam_online = _count_online(db, BayCamera)
    tmr_total, tmr_online = _count_online(db, TimerDevice)

    # ── recordings / drive queue ──
    live_sessions = db.scalar(select(func.count()).select_from(ServiceSession).where(
        ServiceSession.status.in_([SessionStatus.running, SessionStatus.paused]))) or 0
    failed_uploads = db.scalar(select(func.count()).select_from(RecordingSession).where(
        RecordingSession.upload_status == "failed")) or 0
    pending_uploads = db.scalar(select(func.count()).select_from(RecordingSession).where(
        RecordingSession.is_deleted.is_(False),
        RecordingSession.drive_file_id.is_(None),
        RecordingSession.video_path.is_not(None))) or 0
    # DB says recording but no live ffmpeg child = interrupted by a crash (until re-Start)
    db_recording = db.scalar(select(func.count()).select_from(RecordingSession).where(
        RecordingSession.status == RecordingStatus.recording)) or 0
    rec_live = recording_service.active_count()
    interrupted_recordings = max(0, int(db_recording) - int(rec_live))

    def subsys(status: str, **extra) -> dict:
        return {"status": status, **extra}

    timers_status = ("ok" if timer_persistent else "degraded")   # memory fallback = not persistent
    mqtt_status = ("ok" if mqtt.get("connected") else ("degraded" if mqtt.get("enabled") else "off"))
    drive_status = ("ok" if drive.get("reachable") else ("degraded" if drive.get("configured") else "off"))
    rec_status = ("ok" if recording_service.status_label() == "ffmpeg" else "degraded")

    subsystems = {
        "database": subsys("ok" if db_ok else "down", engine=str(db.bind.url).split("://")[0]),
        "timer_engine": subsys(timers_status, backend=timer.backend(),
                               persistent=timer_persistent, active_timers=timer.active_count()),
        "mqtt": subsys(mqtt_status, **mqtt),
        "recording_engine": subsys(rec_status, engine=recording_service.status_label(),
                                   active_recordings=rec_live, interrupted=interrupted_recordings),
        "drive": subsys(drive_status, **drive,
                        pending_uploads=int(pending_uploads), failed_uploads=int(failed_uploads)),
        "cameras": subsys("ok" if cam_total == 0 or cam_online else "degraded",
                          total=cam_total, online=cam_online, offline=cam_total - cam_online),
        "esp32_timers": subsys("ok" if tmr_total == 0 or tmr_online else "degraded",
                               total=tmr_total, online=tmr_online, offline=tmr_total - tmr_online),
        "scheduler": subsys("ok" if scheduler_service.health()["running"] else "down",
                            **scheduler_service.health()),
    }

    # overall: 'down' if any hard dependency is down, else 'degraded' if any
    # subsystem is degraded, else 'ok'. 'off' (a dormant optional integration) is not a fault.
    states = [s["status"] for s in subsystems.values()]
    overall = "down" if "down" in states else ("degraded" if "degraded" in states else "ok")

    return ok({
        "overall": overall,
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "active": {
            "live_sessions": int(live_sessions),
            "active_timers": timer.active_count(),
            "active_recordings": rec_live,
            "mqtt_clients": 1 if mqtt.get("connected") else 0,
            "cameras_online": cam_online,
            "esp32_online": tmr_online,
        },
        "queues": {
            "drive_pending": int(pending_uploads),
            "drive_failed": int(failed_uploads),
            "recordings_interrupted": interrupted_recordings,
        },
        "subsystems": subsystems,
    })


@router.get("/timeline/{session_id}")
def job_timeline(session_id: str, db: Session = Depends(get_db), admin: User = Depends(require_admin)):
    """Complete event timeline for one service session: the audit trail for the
    job + recording/archive milestones, oldest-first."""
    s = db.get(ServiceSession, session_id)
    events = []
    audits = db.scalars(select(AuditLog).where(
        AuditLog.entity_type == "service_session", AuditLog.entity_id == session_id,
    ).order_by(AuditLog.timestamp)).all()
    ids = {a.changed_by for a in audits if a.changed_by}
    names = {u.id: u.name for u in db.scalars(select(User).where(User.id.in_(ids))).all()} if ids else {}
    for a in audits:
        events.append({"at": a.timestamp.isoformat() if a.timestamp else None,
                       "event": a.action, "by": names.get(a.changed_by)})
    rec = db.scalar(select(RecordingSession).where(RecordingSession.service_session_id == session_id))
    if rec:
        if rec.recording_start:
            events.append({"at": rec.recording_start.isoformat(), "event": "RECORDING_STARTED", "by": None})
        if rec.recording_end:
            events.append({"at": rec.recording_end.isoformat(), "event": "RECORDING_FINALIZED", "by": None})
        if rec.uploaded_at:
            events.append({"at": rec.uploaded_at.isoformat(), "event": "DRIVE_UPLOAD_COMPLETE", "by": None})
    if s and s.end_time:   # completion PDF becomes available at completion
        events.append({"at": s.end_time.isoformat(), "event": "PDF_AVAILABLE", "by": None})
    events.sort(key=lambda e: e["at"] or "")
    return ok({"session_id": session_id, "events": events})
