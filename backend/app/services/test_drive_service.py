"""Bike Test Drive Tracking — service layer (Phase 1).

Backend is the source of truth: workers submit raw GPS points; the backend stores
every point (valid + invalid for audit) and recomputes the authoritative metrics on
completion via ``utils.geo``. Nothing here touches the service lifecycle / workflow
engine — test-drive sessions are standalone, linked to a COMPLETED ServiceSession.
"""
import logging
from datetime import datetime, timezone

from fastapi import HTTPException, status as http
from sqlalchemy import select, func
from sqlalchemy.orm import Session

from ..models.job import JobCard
from ..models.session import ServiceSession, SessionStatus
from ..models.test_drive import (
    TestDriveSession, TestDrivePoint, TestDriveStopEvent, TestDriveStatus,
)
from ..models.user import User
from ..models.base import naive_utcnow
from ..utils import geo

log = logging.getLogger("baywatch.test_drives")

ACTIVE_STATES = (TestDriveStatus.assigned, TestDriveStatus.running)

# A device counts as "connected" only while a recent GPS heartbeat exists; past this
# the admin/worker UI shows it as "stale" (no fake GPS — honest connection state).
HEARTBEAT_STALE_SECONDS = 120


# ── helpers ────────────────────────────────────────────────────────
def _parse_ts(value) -> datetime:
    """ISO 8601 (device clock, possibly with Z/offset) → naive UTC. Falls back to
    server time so a missing/garbled device clock never blocks ingestion."""
    if isinstance(value, datetime):
        dt = value
    elif isinstance(value, str) and value.strip():
        try:
            dt = datetime.fromisoformat(value.strip().replace("Z", "+00:00"))
        except ValueError:
            return naive_utcnow()
    else:
        return naive_utcnow()
    if dt.tzinfo is not None:
        dt = dt.astimezone(timezone.utc).replace(tzinfo=None)
    return dt


def _resolve_completed_session(db: Session, req) -> ServiceSession:
    sess = None
    if req.service_session_id:
        sess = db.get(ServiceSession, req.service_session_id)
    elif req.job_card_id:
        sess = db.scalar(
            select(ServiceSession).where(ServiceSession.job_card_id == req.job_card_id)
            .order_by(ServiceSession.end_time.desc().nullslast(), ServiceSession.created_at.desc())
        )
    else:
        raise HTTPException(http.HTTP_400_BAD_REQUEST, "service_session_id or job_card_id is required")
    if not sess:
        raise HTTPException(http.HTTP_404_NOT_FOUND, "Service session not found")
    # LOCKED RULE: assign only after the service job is completed
    if sess.status != SessionStatus.completed:
        raise HTTPException(http.HTTP_409_CONFLICT,
                            f"Test drive can be assigned only after the service is completed (current: {sess.status.value})")
    return sess


def _owned_running_or_assigned(db: Session, session_id: str, worker: User, want_running: bool) -> TestDriveSession:
    s = db.get(TestDriveSession, session_id)
    if not s:
        raise HTTPException(http.HTTP_404_NOT_FOUND, "Test drive session not found")
    if s.worker_id != worker.id:
        raise HTTPException(http.HTTP_403_FORBIDDEN, "This test drive belongs to another worker")
    if want_running and s.status != TestDriveStatus.running:
        raise HTTPException(http.HTTP_409_CONFLICT, f"Test drive is not running (status: {s.status.value})")
    return s


# ── admin: assign / cancel ─────────────────────────────────────────
def assign(db: Session, admin: User, req) -> TestDriveSession:
    sess = _resolve_completed_session(db, req)

    # one active test drive per job/session
    dup = db.scalar(select(TestDriveSession).where(
        TestDriveSession.service_session_id == sess.id,
        TestDriveSession.status.in_(ACTIVE_STATES),
    ))
    if dup:
        raise HTTPException(http.HTTP_409_CONFLICT, "This job already has an active test drive")

    worker_id = req.worker_id or sess.worker_id
    worker = db.get(User, worker_id)
    if not worker:
        raise HTTPException(http.HTTP_404_NOT_FOUND, "Worker not found")
    jc = db.get(JobCard, sess.job_card_id) if sess.job_card_id else None
    # snapshot the SERVICE worker (who did the bay job) — may differ from the test-drive
    # worker; both are shown separately everywhere (report image / drawer / modal / PDF).
    service_worker = db.get(User, sess.worker_id) if sess.worker_id else None

    s = TestDriveSession(
        service_session_id=sess.id, job_card_id=sess.job_card_id,
        job_card_number=(jc.job_card_number if jc else None),
        worker_id=worker_id, branch_id=(jc.branch_id if jc else None),
        worker_name=worker.name,
        service_worker_name=(service_worker.name if service_worker else None),
        customer_name=(jc.customer_name if jc else None),
        bike_model=(jc.vehicle_model if jc else None),
        bike_registration=(jc.vehicle_number if jc else None),
        assigned_by_admin_id=admin.id, assigned_at=naive_utcnow(),
        status=TestDriveStatus.assigned, notes=req.notes,
        approval_status="pending_approval", device_status="not_connected",
    )
    db.add(s)
    db.commit()
    db.refresh(s)
    return s


def cancel(db: Session, session_id: str) -> TestDriveSession:
    s = db.get(TestDriveSession, session_id)
    if not s:
        raise HTTPException(http.HTTP_404_NOT_FOUND, "Test drive session not found")
    if s.status in (TestDriveStatus.completed, TestDriveStatus.cancelled):
        raise HTTPException(http.HTTP_409_CONFLICT, f"Cannot cancel a {s.status.value} test drive")
    s.status = TestDriveStatus.cancelled
    db.commit()
    db.refresh(s)
    return s


# ── worker: approve / start / points ───────────────────────────────
def _begin_tracking(db: Session, s: TestDriveSession, worker: User, req) -> None:
    """Shared core for approve()/start(): a drive can begin only from ``assigned``,
    the worker must hold no other running drive, and an initial GPS fix is required.
    Flips the session to running + stores the seq-0 point. Caller marks approval/device
    fields and commits."""
    if s.status != TestDriveStatus.assigned:
        raise HTTPException(http.HTTP_409_CONFLICT, f"Test drive cannot begin (status: {s.status.value})")
    other = db.scalar(select(TestDriveSession).where(
        TestDriveSession.worker_id == worker.id,
        TestDriveSession.status == TestDriveStatus.running,
        TestDriveSession.id != s.id,
    ))
    if other:
        raise HTTPException(http.HTTP_409_CONFLICT, "You already have a running test drive")
    err = geo.validate_range_time(req.latitude, req.longitude, req.timestamp or "now")
    if err and err != "missing_timestamp":
        raise HTTPException(http.HTTP_400_BAD_REQUEST, f"Invalid start location: {err}")

    ts = _parse_ts(req.timestamp)
    s.status = TestDriveStatus.running
    s.started_at = naive_utcnow()
    s.start_latitude, s.start_longitude = req.latitude, req.longitude
    db.add(TestDrivePoint(
        session_id=s.id, sequence_no=0, latitude=req.latitude, longitude=req.longitude,
        timestamp=ts, speed_kmh=req.speed_kmh, accuracy_meters=req.accuracy_meters,
        heading=getattr(req, "heading", None), altitude=getattr(req, "altitude", None),
        source=(req.source or "browser_gps"), is_valid=True,
        validation_error=("low_accuracy" if (req.accuracy_meters or 0) > geo.LOW_ACCURACY_THRESHOLD_METERS else None),
    ))


def approve(db: Session, worker: User, session_id: str, req) -> TestDriveSession:
    """NEW workflow: the worker approves tracking on their own device. No silent
    tracking — GPS only flows after this. Records approval + device-connection state."""
    s = _owned_running_or_assigned(db, session_id, worker, want_running=False)
    _begin_tracking(db, s, worker, req)
    now = naive_utcnow()
    s.approval_status = "approved"
    s.device_status = "connected"
    s.worker_approved_at = now
    s.device_connected_at = now
    s.last_device_heartbeat_at = now
    s.worker_approved_device_id = getattr(req, "device_id", None)
    s.worker_approved_user_agent = getattr(req, "user_agent", None)
    db.commit()
    db.refresh(s)
    return s


def start(db: Session, worker: User, session_id: str, start_req) -> TestDriveSession:
    """Backward-compatible direct start. Marks the same approval/device state as
    approve() so a row begun via either path stays consistent."""
    s = _owned_running_or_assigned(db, session_id, worker, want_running=False)
    _begin_tracking(db, s, worker, start_req)
    now = naive_utcnow()
    s.approval_status = "approved"
    s.device_status = "connected"
    s.worker_approved_at = now
    s.device_connected_at = now
    s.last_device_heartbeat_at = now
    db.commit()
    db.refresh(s)
    return s


def add_points(db: Session, worker: User, session_id: str, points: list) -> dict:
    s = _owned_running_or_assigned(db, session_id, worker, want_running=True)

    next_seq = (db.scalar(select(func.max(TestDrivePoint.sequence_no)).where(
        TestDrivePoint.session_id == s.id)) or 0) + 1
    last = db.scalar(select(TestDrivePoint).where(
        TestDrivePoint.session_id == s.id, TestDrivePoint.is_valid == True)  # noqa: E712
        .order_by(TestDrivePoint.sequence_no.desc()))

    stored = accepted = invalid = 0
    for raw in points:
        ts = _parse_ts(raw.timestamp)
        err = geo.validate_range_time(raw.latitude, raw.longitude, raw.timestamp)
        is_valid = err is None
        computed = None
        if is_valid and last is not None and last.timestamp is not None:
            computed = geo.segment_speed_kmh(last.latitude, last.longitude, last.timestamp,
                                             raw.latitude, raw.longitude, ts)
            if computed is not None and computed > geo.MAX_PLAUSIBLE_SPEED_KMH:
                is_valid, err = False, "implausible_speed_jump"
        if is_valid and (raw.accuracy_meters or 0) > geo.LOW_ACCURACY_THRESHOLD_METERS:
            err = "low_accuracy"   # flagged but still counts toward metrics

        pt = TestDrivePoint(
            session_id=s.id, sequence_no=next_seq, latitude=raw.latitude, longitude=raw.longitude,
            timestamp=ts, speed_kmh=raw.speed_kmh, computed_speed_kmh=computed,
            accuracy_meters=raw.accuracy_meters, heading=raw.heading, altitude=raw.altitude,
            source=(raw.source or "browser_gps"), is_valid=is_valid, validation_error=err,
        )
        db.add(pt)
        next_seq += 1
        stored += 1
        if is_valid:
            accepted += 1
            last = pt
        else:
            invalid += 1
    # every successful batch is a device heartbeat → keep the connection live
    s.last_device_heartbeat_at = naive_utcnow()
    s.device_status = "connected"
    db.commit()
    return {"stored": stored, "accepted": accepted, "invalid": invalid, "session_id": s.id}


def _finalize(db: Session, s: TestDriveSession) -> None:
    """Recompute the authoritative metrics from stored points and write them + the
    detected stops onto the session. Shared by complete()/admin_complete(); the caller
    sets the terminal status. Does NOT commit."""
    rows = db.scalars(select(TestDrivePoint).where(
        TestDrivePoint.session_id == s.id).order_by(TestDrivePoint.sequence_no)).all()
    valid = [{"lat": r.latitude, "lon": r.longitude, "ts": r.timestamp, "speed_kmh": r.speed_kmh}
             for r in rows if r.is_valid and r.timestamp is not None]

    m = geo.summarize(valid)
    s.ended_at = naive_utcnow()
    s.total_distance_km = m["total_distance_km"]
    s.total_duration_seconds = m["total_duration_seconds"]
    s.moving_duration_seconds = m["moving_duration_seconds"]
    s.stop_duration_seconds = m["stop_duration_seconds"]
    s.average_speed_kmh = m["average_speed_kmh"]
    s.max_speed_kmh = m["max_speed_kmh"]
    s.stop_count = m["stop_count"]
    s.point_count = len(rows)
    if m["sorted_points"]:
        s.end_latitude = m["sorted_points"][-1]["lat"]
        s.end_longitude = m["sorted_points"][-1]["lon"]
        if s.start_latitude is None:
            s.start_latitude = m["sorted_points"][0]["lat"]
            s.start_longitude = m["sorted_points"][0]["lon"]
    for st in m["stops"]:
        db.add(TestDriveStopEvent(session_id=s.id, **st))


def complete(db: Session, worker: User, session_id: str) -> TestDriveSession:
    """Legacy worker completion — RETAINED for internal use only. The worker route now
    returns 403 (admin alone completes); kept so the finalize path has one definition."""
    s = _owned_running_or_assigned(db, session_id, worker, want_running=True)
    _finalize(db, s)
    s.status = TestDriveStatus.completed
    s.approval_status = "completed"
    s.device_status = "disconnected"
    db.commit()
    db.refresh(s)
    return s


def admin_complete(db: Session, admin: User, session_id: str) -> TestDriveSession:
    """NEW workflow: only an administrator completes a test drive. Finalizes metrics
    (shared logic), records who/when, and releases the device."""
    s = db.get(TestDriveSession, session_id)
    if not s:
        raise HTTPException(http.HTTP_404_NOT_FOUND, "Test drive session not found")
    if s.status != TestDriveStatus.running:
        raise HTTPException(http.HTTP_409_CONFLICT,
                            f"Test drive is not ongoing (status: {s.status.value})")
    _finalize(db, s)
    s.status = TestDriveStatus.completed
    s.approval_status = "completed"
    s.device_status = "disconnected"
    s.admin_completed_by = admin.id
    s.admin_completed_at = naive_utcnow()
    db.commit()
    db.refresh(s)
    # eager route-report image generation — finalize and render in the same flow so the
    # drawer / completion modal / PDF have it immediately. NEVER fail completion on a
    # render error (too-few-points, tiles offline, etc.) — the lazy route stays a fallback.
    try:
        from . import test_drive_image_service as _img
        _img.generate_test_drive_route_image(db, s.id, force=False)
        db.refresh(s)
    except Exception:
        log.warning("admin_complete: route image deferred for %s (will generate on first view)", s.id, exc_info=True)
    return s


# ── reads / serializers ────────────────────────────────────────────
def _iso(dt):
    return dt.isoformat() if dt else None


def _device_view(s: TestDriveSession) -> tuple[str, int | None]:
    """Derive the honest, display-time device-connection state from the stored value
    and the heartbeat age. No fake GPS: a running drive whose heartbeat went silent for
    >2 min reads as 'stale'; a completed/cancelled drive reads as 'disconnected'."""
    stored = getattr(s, "device_status", None) or "not_connected"
    hb = getattr(s, "last_device_heartbeat_at", None)
    age = int((naive_utcnow() - hb).total_seconds()) if hb else None
    status_val = s.status.value
    if status_val in ("completed", "cancelled", "failed"):
        return "disconnected", age
    if status_val == "running" and stored == "connected" and age is not None and age > HEARTBEAT_STALE_SECONDS:
        return "stale", age
    return stored, age


def serialize_session(s: TestDriveSession) -> dict:
    device_status, hb_age = _device_view(s)
    return {
        "id": s.id, "status": s.status.value,
        "service_session_id": s.service_session_id, "job_card_id": s.job_card_id,
        "job_card_number": s.job_card_number, "queue_id": s.queue_id,
        "worker_id": s.worker_id, "worker_name": s.worker_name,
        "service_worker_name": getattr(s, "service_worker_name", None),
        "customer_name": s.customer_name, "bike_model": s.bike_model,
        "bike_registration": s.bike_registration, "branch_id": s.branch_id,
        "assigned_by_admin_id": s.assigned_by_admin_id,
        "assigned_at": _iso(s.assigned_at), "started_at": _iso(s.started_at), "ended_at": _iso(s.ended_at),
        "start_latitude": s.start_latitude, "start_longitude": s.start_longitude,
        "end_latitude": s.end_latitude, "end_longitude": s.end_longitude,
        "total_distance_km": s.total_distance_km,
        "total_duration_seconds": s.total_duration_seconds,
        "moving_duration_seconds": s.moving_duration_seconds,
        "stop_duration_seconds": s.stop_duration_seconds,
        "average_speed_kmh": s.average_speed_kmh, "max_speed_kmh": s.max_speed_kmh,
        "stop_count": s.stop_count, "point_count": s.point_count,
        "route_image_url": s.route_image_url, "notes": s.notes,
        # ── approval + worker device connection ──
        "approval_status": getattr(s, "approval_status", None) or "pending_approval",
        "device_status": device_status,
        "device_heartbeat_age_seconds": hb_age,
        "worker_approved_at": _iso(getattr(s, "worker_approved_at", None)),
        "device_connected_at": _iso(getattr(s, "device_connected_at", None)),
        "last_device_heartbeat_at": _iso(getattr(s, "last_device_heartbeat_at", None)),
        "admin_completed_by": getattr(s, "admin_completed_by", None),
        "admin_completed_at": _iso(getattr(s, "admin_completed_at", None)),
    }


def serialize_point(p: TestDrivePoint) -> dict:
    return {
        "id": p.id, "sequence_no": p.sequence_no, "latitude": p.latitude, "longitude": p.longitude,
        "timestamp": _iso(p.timestamp), "speed_kmh": p.speed_kmh, "computed_speed_kmh": p.computed_speed_kmh,
        "accuracy_meters": p.accuracy_meters, "heading": p.heading, "altitude": p.altitude,
        "source": p.source, "is_valid": p.is_valid, "validation_error": p.validation_error,
    }


def serialize_stop(st: TestDriveStopEvent) -> dict:
    return {
        "id": st.id, "start_time": _iso(st.start_time), "end_time": _iso(st.end_time),
        "duration_seconds": st.duration_seconds, "latitude": st.latitude, "longitude": st.longitude,
        "point_count": st.point_count, "radius_meters": st.radius_meters, "address": st.address,
    }


def points_of(db: Session, session_id: str) -> list[TestDrivePoint]:
    return db.scalars(select(TestDrivePoint).where(
        TestDrivePoint.session_id == session_id).order_by(TestDrivePoint.sequence_no)).all()


def stops_of(db: Session, session_id: str) -> list[TestDriveStopEvent]:
    return db.scalars(select(TestDriveStopEvent).where(
        TestDriveStopEvent.session_id == session_id).order_by(TestDriveStopEvent.start_time)).all()


def active_for_worker(db: Session, worker: User) -> TestDriveSession | None:
    return db.scalar(select(TestDriveSession).where(
        TestDriveSession.worker_id == worker.id,
        TestDriveSession.status.in_(ACTIVE_STATES),
    ).order_by(TestDriveSession.assigned_at.desc()))


def owned_session(db: Session, worker: User, session_id: str) -> TestDriveSession:
    """Worker self-read: the assigned worker may read their own session (any status) so
    the device page can poll for the admin completing the drive."""
    s = db.get(TestDriveSession, session_id)
    if not s:
        raise HTTPException(http.HTTP_404_NOT_FOUND, "Test drive session not found")
    if s.worker_id != worker.id:
        raise HTTPException(http.HTTP_403_FORBIDDEN, "This test drive belongs to another worker")
    return s
