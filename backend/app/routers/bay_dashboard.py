from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..database import get_db
from ..models.bay import Bay
from ..models.job import JobCard
from ..models.session import ServiceSession, SessionStatus
from ..models.user import User
from ..schemas.common import ok
from ..utils.auth import require_admin, assert_branch_access
from ..utils import timer
from ..services import workflow_engine, snapshots

router = APIRouter()


class CompleteBody(BaseModel):
    actual_duration: int | None = None      # seconds; defaults to timer elapsed
    notes: str = ""


def _live_session(db: Session, bay_id: str, admin: User) -> ServiceSession:
    # Branch ownership: a crafted bay_id cannot reach another branch's session.
    bay = db.get(Bay, bay_id)
    assert_branch_access(admin, bay.branch_id if bay else None, "bay session op")
    s = db.scalar(
        select(ServiceSession).where(
            ServiceSession.bay_id == bay_id,
            ServiceSession.status != SessionStatus.completed,
        ).order_by(ServiceSession.created_at.desc())
    )
    if not s:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "No active session on this bay")
    return s


@router.get("")
def dashboard(db: Session = Depends(get_db), _: User = Depends(require_admin)):
    return ok(snapshots.dashboard(db))


@router.post("/{bay_id}/start")
def start(bay_id: str, db: Session = Depends(get_db), admin: User = Depends(require_admin)):
    s = _live_session(db, bay_id, admin)
    # Warn-never-block: emit() runs the start (recording/MQTT best-effort) and the
    # JOB_STARTED audit captures the truthful warnings + authoritative estimate.
    workflow_engine.emit(db, "JOB_STARTED", s, admin.id)
    state = timer.get_state(bay_id)
    return ok({**state,
               "warnings": state.get("warnings") or [],
               "estimate": {"minutes": (state.get("estimated_seconds") or 0) // 60,
                            "source": state.get("estimate_source"),
                            "approved_cost": state.get("approved_cost")}},
              "Started")


@router.post("/{bay_id}/pause")
def pause(bay_id: str, db: Session = Depends(get_db), admin: User = Depends(require_admin)):
    s = _live_session(db, bay_id, admin)
    workflow_engine.emit(db, "JOB_PAUSED", s, admin.id)
    return ok(timer.get_state(bay_id), "Paused")


@router.post("/{bay_id}/resume")
def resume(bay_id: str, db: Session = Depends(get_db), admin: User = Depends(require_admin)):
    s = _live_session(db, bay_id, admin)
    workflow_engine.emit(db, "JOB_RESUMED", s, admin.id)
    return ok(timer.get_state(bay_id), "Resumed")


@router.post("/{bay_id}/complete")
def complete(bay_id: str, body: CompleteBody, db: Session = Depends(get_db), admin: User = Depends(require_admin)):
    s = _live_session(db, bay_id, admin)
    workflow_engine.emit(db, "JOB_COMPLETED", s, admin.id,
                         {"actual_duration": body.actual_duration, "notes": body.notes})
    return ok({"session_id": s.id}, "Completed")
