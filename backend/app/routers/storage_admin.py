"""Storage Management (admin) — operational view of the recording storage tier.

Surfaces the whole archival pipeline so an operator can SEE where every recording
lives and act on it:

    GET  /api/v1/storage              → overview: local footprint, Drive status,
                                        per-state counts + lists (pending/failed/
                                        archived/expired)
    POST /api/v1/storage/sync-now     → run the Drive archive sweep now (background)
    POST /api/v1/storage/retry/{id}   → retry a single failed upload

The actual upload/verify/share/delete-local logic lives in scheduler_service; this
router is the thin admin control surface over it.
"""
import logging
from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session

from ..database import get_db
from ..models.bay import Bay
from ..models.session import RecordingSession
from ..models.user import User
from ..schemas.common import ok
from ..services import scheduler_service
from ..utils.auth import require_admin, assert_branch_access
from ..utils.audit import log_action

log = logging.getLogger("baywatch.storage")
router = APIRouter()


@router.get("")
def overview(_: User = Depends(require_admin)):
    """Total Local Storage · Google Drive Status · Pending · Failed · Archived ·
    Expired — everything the dashboard renders."""
    return ok(scheduler_service.storage_overview())


@router.post("/sync-now")
def sync_now(admin: User = Depends(require_admin), db: Session = Depends(get_db)):
    res = scheduler_service.sync_now()
    log_action(db, "STORAGE_SYNC_NOW", "storage", "drive", admin.id)
    db.commit()
    return ok(res, res.get("message", "Sync started"))


def _guard(db: Session, recording_id: str, admin: User, action: str) -> RecordingSession:
    """Resolve the recording and enforce branch ownership (master = all, admin = own
    branch). A RecordingSession has no bay_id of its own — its branch is resolved via
    the service session's bay, so a crafted id cannot reach another branch's recording."""
    from ..models.session import ServiceSession
    rec = db.get(RecordingSession, recording_id)
    if not rec:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Recording not found")
    sess = db.get(ServiceSession, rec.service_session_id) if rec.service_session_id else None
    bay = db.get(Bay, sess.bay_id) if sess and sess.bay_id else None
    assert_branch_access(admin, bay.branch_id if bay else None, action)
    return rec


@router.post("/retry/{recording_id}")
def retry_upload(recording_id: str, admin: User = Depends(require_admin), db: Session = Depends(get_db)):
    _guard(db, recording_id, admin, "retry recording upload")
    res = scheduler_service.retry_one(recording_id)
    if res.get("status") == "missing":
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Recording not found")
    log_action(db, "STORAGE_RETRY_UPLOAD", "recording", recording_id, admin.id,
               new={"result": res.get("status")})
    db.commit()
    return ok(res, res.get("message", "Retry triggered"))


@router.post("/recordings/{recording_id}/verify")
def verify(recording_id: str, admin: User = Depends(require_admin), db: Session = Depends(get_db)):
    _guard(db, recording_id, admin, "verify recording")
    res = scheduler_service.verify_one(recording_id)
    log_action(db, "STORAGE_VERIFY", "recording", recording_id, admin.id, new={"state": res.get("state")})
    db.commit()
    return ok(res, res.get("message", "Verified"))


@router.post("/recordings/{recording_id}/expire")
def expire(recording_id: str, admin: User = Depends(require_admin), db: Session = Depends(get_db)):
    _guard(db, recording_id, admin, "mark recording expired")
    res = scheduler_service.expire_one(recording_id)
    log_action(db, "STORAGE_EXPIRE", "recording", recording_id, admin.id, new={"result": res.get("status")})
    db.commit()
    return ok(res, res.get("message", "Marked expired"))


@router.post("/recordings/{recording_id}/delete")
def delete_expired(recording_id: str, admin: User = Depends(require_admin), db: Session = Depends(get_db)):
    _guard(db, recording_id, admin, "delete recording")
    res = scheduler_service.delete_one(recording_id)
    log_action(db, "STORAGE_DELETE_ACTION", "recording", recording_id, admin.id, new={"result": res.get("status")})
    db.commit()
    return ok(res, res.get("message", "Delete processed"))
