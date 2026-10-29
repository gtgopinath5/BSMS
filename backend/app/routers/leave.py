"""Leave: workers apply, admins approve/reject."""
from datetime import date, datetime, timezone
from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..database import get_db
from ..models.leave import LeaveRequest, LeaveStatus
from ..models.user import User
from ..schemas.common import ok
from ..utils.auth import require_admin, require_worker, get_current_user, is_master, assert_branch_access
from ..utils.audit import log_action

router = APIRouter()


class LeaveApply(BaseModel):
    from_date: date
    to_date: date
    reason: str = ""
    leave_type: str = "Personal"


def _row(db: Session, lr: LeaveRequest) -> dict:
    w = db.get(User, lr.worker_id)
    return {
        "id": lr.id, "worker_id": lr.worker_id,
        "worker_name": w.name if w else "—", "employee_id": w.employee_id if w else None,
        "department": w.department if w else None,
        "from_date": lr.from_date.isoformat(), "to_date": lr.to_date.isoformat(),
        "days": lr.days, "leave_type": lr.leave_type, "reason": lr.reason,
        "status": lr.status.value,
        "applied_at": lr.created_at.isoformat() if lr.created_at else None,
        "decided_at": lr.decided_at.isoformat() if lr.decided_at else None,
    }


@router.post("")
def apply(body: LeaveApply, db: Session = Depends(get_db), me: User = Depends(require_worker)):
    days = (body.to_date - body.from_date).days + 1
    if days < 1:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "to_date must be on/after from_date")
    lr = LeaveRequest(worker_id=me.id, from_date=body.from_date, to_date=body.to_date,
                      days=days, leave_type=body.leave_type, reason=body.reason)
    db.add(lr); db.commit(); db.refresh(lr)
    return ok(_row(db, lr), "Leave request submitted")


@router.get("/mine")
def my_leave(db: Session = Depends(get_db), me: User = Depends(require_worker)):
    rows = db.scalars(select(LeaveRequest).where(LeaveRequest.worker_id == me.id)
                      .order_by(LeaveRequest.created_at.desc())).all()
    return ok([_row(db, r) for r in rows])


@router.get("")
def list_leave(db: Session = Depends(get_db), admin: User = Depends(require_admin)):
    q = select(LeaveRequest)
    if not is_master(admin):          # Admin sees only own-branch workers' leave
        q = q.join(User, LeaveRequest.worker_id == User.id).where(User.branch_id == admin.branch_id)
    rows = db.scalars(q.order_by(LeaveRequest.created_at.desc())).all()
    return ok([_row(db, r) for r in rows])


def _decide(db: Session, lid: str, admin: User, status_val: LeaveStatus) -> dict:
    lr = db.get(LeaveRequest, lid)
    if not lr:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Leave request not found")
    worker = db.get(User, lr.worker_id)
    assert_branch_access(admin, worker.branch_id if worker else None, "decide leave")
    lr.status = status_val
    lr.decided_by = admin.id
    lr.decided_at = datetime.now(timezone.utc)
    log_action(db, f"LEAVE_{status_val.value.upper()}", "leave_request", lid, admin.id)
    db.commit(); db.refresh(lr)
    return _row(db, lr)


@router.post("/{leave_id}/approve")
def approve(leave_id: str, db: Session = Depends(get_db), admin: User = Depends(require_admin)):
    return ok(_decide(db, leave_id, admin, LeaveStatus.approved), "Approved")


@router.post("/{leave_id}/reject")
def reject(leave_id: str, db: Session = Depends(get_db), admin: User = Depends(require_admin)):
    return ok(_decide(db, leave_id, admin, LeaveStatus.rejected), "Rejected")
