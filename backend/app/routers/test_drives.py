"""Bike Test Drive Tracking — API (Phase 1, backend only).

Admin assigns a test drive on a COMPLETED service job; the worker starts it, streams
real GPS points, then completes it. The backend stores every raw point and recomputes
the authoritative metrics (distance, durations, avg/max speed, stops) on completion.

Additive module — it never touches the service lifecycle / workflow engine. Route
order is deliberate: the static ``/mine/active`` is declared BEFORE the dynamic
``/{session_id}`` routes so "mine" is never captured as a session id.
"""
import logging
import os

from fastapi import APIRouter, Depends, HTTPException, Query, status as http
from fastapi.responses import FileResponse
from sqlalchemy import select, text
from sqlalchemy.orm import Session

from ..database import get_db, engine, Base
from ..models.test_drive import TestDriveSession, TestDrivePoint, TestDriveStopEvent
from ..models.user import User
from ..schemas.common import ok
from ..schemas.test_drive import (
    AssignTestDriveRequest, StartTestDriveRequest, ApproveTestDriveRequest, PointsBatchIn,
)
from ..services import test_drive_service as svc
from ..services import test_drive_image_service as img_svc
from ..utils.auth import require_admin, require_worker

log = logging.getLogger("baywatch.test_drives")
router = APIRouter()

_TD_MIGRATED = False


def ensure_test_drive_schema() -> None:
    """Create the test-drive tables if missing (idempotent) and add any columns
    introduced after first release. Additive only — never drops. PG + SQLite."""
    global _TD_MIGRATED
    if _TD_MIGRATED:
        return
    # create_all is idempotent; restrict to our tables so nothing else is touched
    Base.metadata.create_all(bind=engine, tables=[
        TestDriveSession.__table__, TestDrivePoint.__table__, TestDriveStopEvent.__table__,
    ])
    # additive columns introduced after first release, mirroring ensure_camera_schema().
    # Approval + worker device connection workflow (separate string/timestamp columns —
    # the TestDriveStatus enum is never altered).
    _later: dict[str, list[tuple[str, str]]] = {
        "test_drive_sessions": [
            ("service_worker_name", "VARCHAR"),
            ("approval_status", "VARCHAR DEFAULT 'pending_approval'"),
            ("worker_approved_at", "TIMESTAMP"),
            ("worker_approved_device_id", "VARCHAR"),
            ("worker_approved_user_agent", "VARCHAR"),
            ("device_connected_at", "TIMESTAMP"),
            ("last_device_heartbeat_at", "TIMESTAMP"),
            ("device_status", "VARCHAR DEFAULT 'not_connected'"),
            ("admin_completed_by", "VARCHAR"),
            ("admin_completed_at", "TIMESTAMP"),
        ],
    }
    dialect = engine.dialect.name
    with engine.begin() as conn:
        for tbl, cols in _later.items():
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
    _TD_MIGRATED = True


# ════════════════════════════════════════════════════════════════
#  Admin — assign / list
# ════════════════════════════════════════════════════════════════
@router.post("/assign")
def assign(body: AssignTestDriveRequest, db: Session = Depends(get_db), admin: User = Depends(require_admin)):
    s = svc.assign(db, admin, body)
    return ok(svc.serialize_session(s), "Test drive assigned")


@router.get("")
def list_sessions(
    status: str | None = Query(None),
    worker_id: str | None = Query(None),
    job_id: str | None = Query(None),
    date_from: str | None = Query(None),
    date_to: str | None = Query(None),
    db: Session = Depends(get_db), _: User = Depends(require_admin),
):
    stmt = select(TestDriveSession)
    if status:
        stmt = stmt.where(TestDriveSession.status == status)
    if worker_id:
        stmt = stmt.where(TestDriveSession.worker_id == worker_id)
    if job_id:
        stmt = stmt.where((TestDriveSession.job_card_id == job_id) |
                          (TestDriveSession.service_session_id == job_id))
    if date_from:
        stmt = stmt.where(TestDriveSession.assigned_at >= date_from)
    if date_to:
        stmt = stmt.where(TestDriveSession.assigned_at <= date_to)
    stmt = stmt.order_by(TestDriveSession.assigned_at.desc())
    rows = db.scalars(stmt).all()
    return ok({"items": [svc.serialize_session(s) for s in rows], "total": len(rows)})


# ════════════════════════════════════════════════════════════════
#  Worker — STATIC route declared BEFORE the dynamic /{session_id}
# ════════════════════════════════════════════════════════════════
@router.get("/mine/active")
def my_active(db: Session = Depends(get_db), me: User = Depends(require_worker)):
    s = svc.active_for_worker(db, me)
    if not s:
        return ok(None, "No active test drive")
    return ok(svc.serialize_session(s))


@router.post("/{session_id}/approve")
def approve(session_id: str, body: ApproveTestDriveRequest, db: Session = Depends(get_db), me: User = Depends(require_worker)):
    """Worker approves tracking on their own device (no silent tracking). Requires the
    first GPS fix; flips the drive to running + connected and stores the seq-0 point."""
    s = svc.approve(db, me, session_id, body)
    return ok(svc.serialize_session(s), "Device connected — test drive tracking started")


@router.post("/{session_id}/start")
def start(session_id: str, body: StartTestDriveRequest, db: Session = Depends(get_db), me: User = Depends(require_worker)):
    s = svc.start(db, me, session_id, body)
    return ok(svc.serialize_session(s), "Test drive started")


@router.post("/{session_id}/points")
def post_points(session_id: str, body: PointsBatchIn, db: Session = Depends(get_db), me: User = Depends(require_worker)):
    res = svc.add_points(db, me, session_id, body.points)
    return ok(res, f"{res['accepted']} accepted · {res['invalid']} invalid")


@router.get("/{session_id}/mine")
def my_session(session_id: str, db: Session = Depends(get_db), me: User = Depends(require_worker)):
    """Worker self-read of their own session (any status) — the device page polls this
    to detect the admin completing the drive, then stops tracking + shows the summary."""
    s = svc.owned_session(db, me, session_id)
    return ok({**svc.serialize_session(s),
               "stops": [svc.serialize_stop(st) for st in svc.stops_of(db, session_id)]})


@router.post("/{session_id}/complete")
def complete(session_id: str, db: Session = Depends(get_db), me: User = Depends(require_worker)):
    """Disabled in the approval workflow: only an administrator completes a test drive."""
    raise HTTPException(http.HTTP_403_FORBIDDEN, "Only an administrator can complete a test drive")


# ════════════════════════════════════════════════════════════════
#  Admin — per-session reads / cancel
# ════════════════════════════════════════════════════════════════
@router.post("/{session_id}/cancel")
def cancel(session_id: str, db: Session = Depends(get_db), _: User = Depends(require_admin)):
    s = svc.cancel(db, session_id)
    return ok(svc.serialize_session(s), "Test drive cancelled")


@router.post("/{session_id}/admin-complete")
def admin_complete(session_id: str, db: Session = Depends(get_db), admin: User = Depends(require_admin)):
    """Admin alone completes a test drive: finalizes the authoritative metrics, records
    who/when, and releases the device."""
    s = svc.admin_complete(db, admin, session_id)
    return ok(svc.serialize_session(s), "Test drive completed")


@router.get("/{session_id}/points")
def get_points(session_id: str, db: Session = Depends(get_db), _: User = Depends(require_admin)):
    if not db.get(TestDriveSession, session_id):
        raise HTTPException(http.HTTP_404_NOT_FOUND, "Test drive session not found")
    pts = svc.points_of(db, session_id)
    return ok({"items": [svc.serialize_point(p) for p in pts], "total": len(pts)})


@router.get("/{session_id}/summary")
def get_summary(session_id: str, db: Session = Depends(get_db), _: User = Depends(require_admin)):
    s = db.get(TestDriveSession, session_id)
    if not s:
        raise HTTPException(http.HTTP_404_NOT_FOUND, "Test drive session not found")
    return ok({**svc.serialize_session(s),
               "stops": [svc.serialize_stop(st) for st in svc.stops_of(db, session_id)]})


@router.get("/{session_id}/route-image")
def route_image(session_id: str, db: Session = Depends(get_db), _: User = Depends(require_admin)):
    # Phase 4: generate the dark-nav route PNG on first request (cached thereafter).
    # Blocking conditions surface as clean errors: 409 (not completed), 400 (<2
    # valid points), 404 (missing), 500 (generation failure) — never a traceback.
    path = img_svc.get_or_generate_route_image(db, session_id)
    if not os.path.exists(path):
        raise HTTPException(http.HTTP_404_NOT_FOUND, "Route image not available")
    return FileResponse(path, media_type="image/png", filename=f"test-drive-{session_id}.png",
                        headers={"Cache-Control": "no-store"})


@router.post("/{session_id}/route-image/regenerate")
def route_image_regenerate(session_id: str, db: Session = Depends(get_db), _: User = Depends(require_admin)):
    info = img_svc.generate_test_drive_route_image(db, session_id, force=True)
    return ok({"route_image_url": f"/api/v1/test-drives/{session_id}/route-image", "fallback": info.get("fallback")},
              "Route image regenerated")


@router.get("/{session_id}")
def get_session(session_id: str, db: Session = Depends(get_db), _: User = Depends(require_admin)):
    s = db.get(TestDriveSession, session_id)
    if not s:
        raise HTTPException(http.HTTP_404_NOT_FOUND, "Test drive session not found")
    return ok({**svc.serialize_session(s),
               "stops": [svc.serialize_stop(st) for st in svc.stops_of(db, session_id)],
               "point_count": len(svc.points_of(db, session_id))})
