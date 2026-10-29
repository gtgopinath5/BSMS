from datetime import datetime, timezone
from fastapi import APIRouter, Depends, HTTPException, status, UploadFile, File
from sqlalchemy import select, text
from sqlalchemy.orm import Session

from ..database import get_db, engine
from ..models.user import User, UserRole
from ..models.audit import AuditLog
from ..schemas.user import WorkerCreate, WorkerUpdate, UserOut, PasswordReset, StatusChange
from ..schemas.common import ok
from ..utils.security import hash_password
from ..utils.auth import require_admin, is_master, assert_branch_access, effective_branch
from ..utils.audit import log_action
from ..utils import storage, ids

router = APIRouter()

# the only statuses a worker account may hold (active is the only one that can log in)
WORKER_STATUSES = {"active", "inactive", "suspended", "locked"}

_USER_MIGRATED = False


def ensure_user_schema() -> None:
    """Add the worker-HR columns introduced after first release. Idempotent."""
    global _USER_MIGRATED
    if _USER_MIGRATED:
        return
    dialect = engine.dialect.name
    cols = [("address", "VARCHAR"), ("emergency_contact", "VARCHAR"), ("last_login", "TIMESTAMP"),
            ("dob", "DATE"), ("joining_date", "DATE")]
    with engine.begin() as conn:
        try:
            if dialect == "postgresql":
                existing = {r[0] for r in conn.execute(text(
                    "SELECT column_name FROM information_schema.columns WHERE table_name='users'"))}
            else:
                existing = {r[1] for r in conn.execute(text("PRAGMA table_info(users)"))}
        except Exception:
            existing = set()
        for name, ddl in cols:
            if name not in existing:
                try:
                    conn.execute(text(f"ALTER TABLE users ADD COLUMN {name} {ddl}"))
                except Exception:
                    pass
    _USER_MIGRATED = True


def _get_worker(db: Session, worker_id: str, admin: User, action: str) -> User:
    """Fetch a worker and enforce branch ownership (Master bypasses)."""
    w = db.get(User, worker_id)
    if not w:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Worker not found")
    assert_branch_access(admin, w.branch_id, action)
    return w


@router.get("")
def list_workers(db: Session = Depends(get_db), admin: User = Depends(require_admin)):
    q = select(User).where(User.role == UserRole.worker)
    if not is_master(admin):                      # Admin sees only own-branch crew
        q = q.where(User.branch_id == admin.branch_id)
    rows = db.scalars(q).all()
    return ok([UserOut.model_validate(w).model_dump() for w in rows])


@router.post("", status_code=status.HTTP_201_CREATED)
def create_worker(body: WorkerCreate, db: Session = Depends(get_db), admin: User = Depends(require_admin)):
    ensure_user_schema()
    if db.scalar(select(User).where(User.username == body.username)):
        raise HTTPException(status.HTTP_409_CONFLICT, "Username already taken")
    emp_id = body.employee_id or ids.next_employee_id(db, User)   # EMP-NNNN auto when omitted
    if db.scalar(select(User).where(User.employee_id == emp_id)):
        raise HTTPException(status.HTTP_409_CONFLICT, "Employee ID already exists")
    st = (body.status or "active")
    if st not in WORKER_STATUSES:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, f"Invalid status '{st}'")
    # Admin can only create workers for their OWN branch; Master may target any.
    branch_id = effective_branch(admin, body.branch_id)
    worker = User(
        name=body.name, role=body.role, branch_id=branch_id, status=st,
        employee_id=emp_id, company_id=body.company_id, pf_number=body.pf_number,
        aadhaar=body.aadhaar, mobile=body.mobile, email=body.email,
        address=body.address, emergency_contact=body.emergency_contact,
        dob=body.dob, joining_date=body.joining_date,
        department=body.department, designation=body.designation,
        username=body.username, hashed_password=hash_password(body.password),
    )
    db.add(worker); db.flush()
    log_action(db, "WORKER_CREATED", "user", worker.id, admin.id,
               new={"name": worker.name, "employee_id": emp_id, "username": worker.username, "branch": branch_id})
    db.commit(); db.refresh(worker)
    return ok(UserOut.model_validate(worker).model_dump(), f"Worker created · {emp_id}")


@router.get("/{worker_id}")
def get_worker(worker_id: str, db: Session = Depends(get_db), admin: User = Depends(require_admin)):
    w = _get_worker(db, worker_id, admin, "view worker")
    return ok(UserOut.model_validate(w).model_dump())


@router.put("/{worker_id}")
def update_worker(worker_id: str, body: WorkerUpdate, db: Session = Depends(get_db), admin: User = Depends(require_admin)):
    w = _get_worker(db, worker_id, admin, "update worker")
    changes = body.model_dump(exclude_unset=True)
    if "status" in changes and changes["status"] not in WORKER_STATUSES:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, f"Invalid status '{changes['status']}'")
    old, new = {}, {}
    for field, value in changes.items():
        cur = getattr(w, field)
        if cur != value:
            old[field] = str(cur) if cur is not None else None
            new[field] = str(value) if value is not None else None
            setattr(w, field, value)
    if new:
        log_action(db, "WORKER_UPDATED", "user", w.id, admin.id, old=old, new=new)
    db.commit(); db.refresh(w)
    return ok(UserOut.model_validate(w).model_dump(), "Worker updated")


@router.post("/{worker_id}/reset-password")
def reset_password(worker_id: str, body: PasswordReset, db: Session = Depends(get_db), admin: User = Depends(require_admin)):
    w = _get_worker(db, worker_id, admin, "reset worker password")
    if len(body.new_password or "") < 6:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Password must be at least 6 characters")
    w.hashed_password = hash_password(body.new_password)   # the password itself is NEVER logged
    log_action(db, "WORKER_PASSWORD_RESET", "user", w.id, admin.id)
    db.commit()
    return ok({"id": w.id}, "Password reset — the worker can log in with the new password")


@router.post("/{worker_id}/status")
def change_status(worker_id: str, body: StatusChange, db: Session = Depends(get_db), admin: User = Depends(require_admin)):
    """Lock / unlock / suspend / activate / deactivate — one append-only status switch."""
    w = _get_worker(db, worker_id, admin, "change worker status")
    if body.status not in WORKER_STATUSES:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, f"Invalid status '{body.status}'")
    old = w.status
    if old != body.status:
        w.status = body.status
        log_action(db, "WORKER_STATUS_CHANGED", "user", w.id, admin.id,
                   old={"status": old}, new={"status": body.status})
        db.commit()
    return ok({"id": w.id, "status": w.status}, f"Account {body.status}")


@router.get("/{worker_id}/audit")
def worker_audit(worker_id: str, db: Session = Depends(get_db), admin: User = Depends(require_admin)):
    """Full history for one worker: every mutation on the record PLUS the worker's
    own login events — newest first. Powers the drawer Activity + Audit Timeline tabs."""
    _get_worker(db, worker_id, admin, "view worker history")
    rows = db.scalars(
        select(AuditLog).where(
            ((AuditLog.entity_type == "user") & (AuditLog.entity_id == worker_id))
            | ((AuditLog.action == "LOGIN") & (AuditLog.changed_by == worker_id))
        ).order_by(AuditLog.timestamp.desc())
    ).all()
    names = {u.id: u.name for u in db.scalars(select(User)).all()}
    return ok([{
        "action": r.action,
        "at": r.timestamp.isoformat() if r.timestamp else None,
        "by_id": r.changed_by, "by_name": names.get(r.changed_by) or "—",
        "old": r.old_value, "new": r.new_value,
    } for r in rows])


@router.delete("/{worker_id}")
def delete_worker(worker_id: str, db: Session = Depends(get_db), admin: User = Depends(require_admin)):
    """Permanent delete — MASTER ADMIN only. Admins must deactivate instead.

    A worker with real service/leave history is NOT hard-deleted (that would orphan
    reports and break the not-null worker_id foreign keys) — the caller is told to
    deactivate instead. A clean identity record (no operational rows) is removed
    after its safe, nullable references (audit actor, bay assignment) are cleared."""
    from sqlalchemy import func, update
    from ..models.session import ServiceSession, RecordingSession
    from ..models.job import JobQueue
    from ..models.bay import Bay, BayTempAssignment
    from ..models.leave import LeaveRequest

    if not is_master(admin):
        raise HTTPException(status.HTTP_403_FORBIDDEN,
                            "Only a Master Admin can permanently delete a worker. Deactivate the account instead.")
    w = db.get(User, worker_id)
    if not w:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Worker not found")

    def _count(model, col):
        return db.scalar(select(func.count()).select_from(model).where(col == w.id)) or 0
    if (_count(ServiceSession, ServiceSession.worker_id) or _count(JobQueue, JobQueue.worker_id)
            or _count(BayTempAssignment, BayTempAssignment.replacement_worker_id)
            or _count(LeaveRequest, LeaveRequest.worker_id)):
        raise HTTPException(status.HTTP_409_CONFLICT,
                            "This worker has service/leave history and cannot be permanently deleted. "
                            "Deactivate the account instead.")

    log_action(db, "WORKER_DELETED", "user", w.id, admin.id,
               old={"name": w.name, "employee_id": w.employee_id, "username": w.username})
    db.flush()
    # clear the worker's own nullable references so the FK delete is clean
    db.execute(update(AuditLog).where(AuditLog.changed_by == w.id).values(changed_by=None))
    db.execute(update(Bay).where(Bay.primary_worker_id == w.id).values(primary_worker_id=None))
    db.execute(update(RecordingSession).where(RecordingSession.worker_id == w.id).values(worker_id=None))
    db.delete(w); db.commit()
    return ok(message="Worker permanently deleted")


@router.post("/{worker_id}/photo")
async def upload_photo(worker_id: str, file: UploadFile = File(...),
                       db: Session = Depends(get_db), admin: User = Depends(require_admin)):
    w = _get_worker(db, worker_id, admin, "upload worker photo")
    data = await file.read()
    key = f"{worker_id}/{file.filename}"
    storage.upload_file("profile-photos", key, data, file.content_type or "image/jpeg")
    w.profile_photo_url = storage.generate_signed_url("profile-photos", key) or f"profile-photos/{key}"
    db.commit()
    return ok({"profile_photo_url": w.profile_photo_url}, "Photo uploaded")
