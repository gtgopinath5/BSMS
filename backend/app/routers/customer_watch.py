"""Customer Live Watch — authed control plane (admin + master).

Admin (own branch): read the START popup context, decide SEND / DON'T-SEND, send the
WhatsApp link. Master (all branches): audit every record and REVERT a not-sent one to
ELIGIBLE. Branch isolation is enforced by ``assert_branch_access`` on every admin route;
the public customer plane lives in ``watch_public.py``. Backend/RBAC unchanged otherwise.
"""
import hashlib
import secrets
from datetime import timedelta

from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..config import settings
from ..database import get_db
from ..models.base import utcnow, naive_utcnow
from ..models.bay import Bay
from ..models.branch import Branch
from ..models.job import JobCard
from ..models.session import ServiceSession, SessionStatus
from ..models.user import User
from ..models.customer_watch import (
    CustomerWatchSession, WatchDecision, WatchStatus,
)
from ..schemas.common import ok
from ..utils import ids
from ..utils.audit import log_action
from ..utils.auth import require_admin, require_master, assert_branch_access
from ..services import whatsapp_service

router = APIRouter()


def token_hash(raw: str) -> str:
    return hashlib.sha256(raw.encode()).hexdigest()


def _bay_session(db: Session, bay_id: str, admin: User):
    """The bay's current (non-completed) ServiceSession + its job card, branch-guarded."""
    bay = db.get(Bay, bay_id)
    assert_branch_access(admin, bay.branch_id if bay else None, "customer-watch")
    s = db.scalar(
        select(ServiceSession).where(
            ServiceSession.bay_id == bay_id,
            ServiceSession.status != SessionStatus.completed,
        ).order_by(ServiceSession.created_at.desc())
    )
    return bay, s


def _blocking_not_sent(db: Session, job_card_id: str) -> CustomerWatchSession | None:
    """A DON'T-SEND decision that a Master has NOT yet reverted blocks sending a link."""
    return db.scalar(
        select(CustomerWatchSession).where(
            CustomerWatchSession.job_card_id == job_card_id,
            CustomerWatchSession.decision == WatchDecision.not_sent,
            CustomerWatchSession.status == WatchStatus.not_sent,
        ).order_by(CustomerWatchSession.created_at.desc())
    )


# ── Admin · START popup context ────────────────────────────────────────────
@router.get("/context")
def context(bay_id: str = Query(...), db: Session = Depends(get_db),
            admin: User = Depends(require_admin)):
    bay, s = _bay_session(db, bay_id, admin)
    if not s:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "No active session on this bay")
    job = db.get(JobCard, s.job_card_id)
    worker = db.get(User, s.worker_id) if s.worker_id else None
    blocked = _blocking_not_sent(db, s.job_card_id)
    return ok({
        "service_session_id": s.id,
        "customer_name": job.customer_name if job else None,
        "customer_mobile": job.customer_mobile if job else None,   # also the WhatsApp number
        "vehicle_number": job.vehicle_number if job else None,
        "bay_name": f"Bay {bay.bay_number:02d}" if bay else None,
        "worker_name": worker.name if worker else None,
        "whatsapp_configured": whatsapp_service.is_configured(),
        "blocked": bool(blocked),       # marked DON'T-SEND, awaiting master approval
        "blocked_reason": blocked.reason if blocked else None,
    })


# ── Admin · SEND / DON'T-SEND decision ─────────────────────────────────────
class Decision(BaseModel):
    service_session_id: str
    action: str                 # 'send' | 'not_send'
    reason: str | None = None


@router.post("/decision")
def decision(body: Decision, db: Session = Depends(get_db), admin: User = Depends(require_admin)):
    s = db.get(ServiceSession, body.service_session_id)
    if not s:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Session not found")
    bay = db.get(Bay, s.bay_id)
    assert_branch_access(admin, bay.branch_id if bay else None, "customer-watch decision")
    job = db.get(JobCard, s.job_card_id)
    cw_id = ids.next_customer_watch_id(db, CustomerWatchSession)
    common = dict(
        id=cw_id, job_card_id=s.job_card_id, service_session_id=s.id,
        branch_id=bay.branch_id if bay else None, bay_id=s.bay_id,
        customer_name=job.customer_name if job else None,
        customer_mobile=job.customer_mobile if job else None,
        vehicle_number=job.vehicle_number if job else None,
        created_by=admin.id,
    )

    if body.action == "send":
        if _blocking_not_sent(db, s.job_card_id):
            raise HTTPException(status.HTTP_403_FORBIDDEN,
                                "This job was marked Do-Not-Send. Master Admin approval required.")
        raw = secrets.token_urlsafe(32)
        row = CustomerWatchSession(
            **common, decision=WatchDecision.sent, status=WatchStatus.created,
            token_hash=token_hash(raw),
            # naive-UTC to match the naive TIMESTAMP column + the /state expiry compare
            expires_at=naive_utcnow() + timedelta(hours=settings.customer_watch_ttl_hours),
        )
        db.add(row)
        log_action(db, "LINK_CREATED", "customer_watch", cw_id, admin.id,
                   new={"job_card_id": s.job_card_id, "session": s.id})
        db.commit()
        watch_url = f"{settings.customer_watch_base_url.rstrip('/')}/customer-watch/{raw}"
        return ok({"id": cw_id, "session_display_id": cw_id, "watch_url": watch_url,
                   "whatsapp_configured": whatsapp_service.is_configured()},
                  "Live link created")

    if body.action == "not_send":
        if not (body.reason or "").strip():
            raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "A reason is required")
        row = CustomerWatchSession(
            **common, decision=WatchDecision.not_sent, status=WatchStatus.not_sent,
            reason=body.reason.strip(),
        )
        db.add(row)
        log_action(db, "VIDEO_NOT_SENT", "customer_watch", cw_id, admin.id,
                   new={"reason": body.reason.strip()})
        db.commit()
        return ok({"id": cw_id}, "Recorded — no link sent")

    raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "action must be 'send' or 'not_send'")


# ── Admin · send the WhatsApp link ─────────────────────────────────────────
class SendWA(BaseModel):
    token: str                  # the raw token the admin received from /decision (capability)


@router.post("/{cw_id}/whatsapp")
def send_whatsapp(cw_id: str, body: SendWA, db: Session = Depends(get_db),
                  admin: User = Depends(require_admin)):
    row = db.get(CustomerWatchSession, cw_id)
    if not row:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Not found")
    assert_branch_access(admin, row.branch_id, "customer-watch whatsapp")
    if row.decision != WatchDecision.sent or not row.token_hash:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "No live link to send")
    if token_hash(body.token) != row.token_hash:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Token does not match this link")

    res = whatsapp_service.send_watch_link(row.customer_mobile, row.customer_name, body.token)
    row.whatsapp_sent_at = utcnow()
    row.whatsapp_status = res.get("status")
    row.whatsapp_message_id = res.get("message_id")
    log_action(db, "WHATSAPP_SENT", "customer_watch", cw_id, admin.id,
               new={"status": res.get("status"), "message_id": res.get("message_id")})
    db.commit()
    return ok(res, res.get("message") or ("Sent" if res.get("ok") else "Not sent"))


# ── Master · audit + revert ────────────────────────────────────────────────
def _serialize(db: Session, row: CustomerWatchSession, names: dict, branches: dict) -> dict:
    return {
        "id": row.id,
        "customer_name": row.customer_name,
        "customer_mobile": row.customer_mobile,
        "vehicle_number": row.vehicle_number,
        "branch_id": row.branch_id,
        "branch_name": branches.get(row.branch_id) or row.branch_id,
        "admin_name": names.get(row.created_by) or row.created_by,
        "reverted_by": names.get(row.reverted_by) if row.reverted_by else None,
        "decision": row.decision.value,
        "status": row.status.value,
        "reason": row.reason,
        "whatsapp_status": row.whatsapp_status,
        "created_at": row.created_at.isoformat() if row.created_at else None,
    }


@router.get("/audit")
def audit(db: Session = Depends(get_db), _: User = Depends(require_master)):
    rows = db.scalars(
        select(CustomerWatchSession).order_by(CustomerWatchSession.created_at.desc())
    ).all()
    names = {u.id: u.name for u in db.scalars(select(User)).all()}
    branches = {b.id: b.name for b in db.scalars(select(Branch)).all()}
    sent, not_sent = [], []
    for r in rows:
        (sent if r.decision == WatchDecision.sent else not_sent).append(
            _serialize(db, r, names, branches))
    return ok({"sent": sent, "not_sent": not_sent,
               "counts": {"sent": len(sent), "not_sent": len(not_sent)}})


@router.post("/{cw_id}/revert")
def revert(cw_id: str, db: Session = Depends(get_db), master: User = Depends(require_master)):
    row = db.get(CustomerWatchSession, cw_id)
    if not row:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Not found")
    if not (row.decision == WatchDecision.not_sent and row.status == WatchStatus.not_sent):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Only a not-sent record can be reverted")
    row.status = WatchStatus.eligible
    row.reverted_by = master.id
    log_action(db, "VIDEO_REVERTED", "customer_watch", cw_id, master.id)
    db.commit()
    return ok({"id": cw_id, "status": row.status.value}, "Reverted — branch admin may send the link")
