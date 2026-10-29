from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select, func
from sqlalchemy.orm import Session

from ..database import get_db
from ..models.job import JobCard, JobQueue, QueueStatus
from ..models.bay import Bay
from ..models.user import User
from ..models.customer_approval import CustomerApprovalRequest
from ..models.vehicle_intake import VehicleIntakeEntry
from ..schemas.job import AssignRequest, MoveRequest, ChangeBayRequest
from ..schemas.common import ok
from ..utils.auth import require_admin, assert_branch_access, is_master
from ..utils.audit import log_action
from ..utils import intake as intake_utils
from ..services import workflow_engine

router = APIRouter()


def _appr_summary(r: CustomerApprovalRequest | None) -> dict | None:
    """Customer-approval status + revised estimate for a queue row (read-only)."""
    if not r:
        return None
    return {
        "id": r.id, "status": r.status,
        "submitted": r.status == "submitted",
        "approved_cost": r.approved_total_cost, "approved_minutes": r.approved_total_minutes,
    }


def _intake_summary(db: Session, vehicle_number: str | None, branch_id: str | None) -> dict | None:
    """Latest Vehicle Intake Evidence for this bike (chip data on a queue row). Read-only,
    additive — mirrors `_appr_summary`. Matches by NORMALIZED bike number within the job's
    branch; only submitted/linked entries count as evidence (drafts are excluded)."""
    norm = intake_utils.normalize_bike_number(vehicle_number)
    if not norm:
        return None
    stmt = select(VehicleIntakeEntry).where(
        VehicleIntakeEntry.bike_number_normalized == norm,
        VehicleIntakeEntry.deleted_at.is_(None),
        VehicleIntakeEntry.status.in_(("submitted", "linked", "archived")),
    )
    if branch_id:
        stmt = stmt.where(VehicleIntakeEntry.branch_id == branch_id)
    e = db.scalar(stmt.order_by(VehicleIntakeEntry.created_at.desc()))
    if not e:
        return None
    img, aud = intake_utils.media_counts(db, e.id)
    return {
        "id": e.id, "intake_no": e.intake_no, "status": e.status,
        "image_count": img, "voice_count": aud,
        "worker_name": e.worker_name,
        "submitted_at": e.submitted_at.isoformat() if e.submitted_at else None,
        "linked": bool(e.linked_job_card_id or e.linked_job_id or e.linked_assignment_id),
    }


def _row(db: Session, item: JobQueue, wnames: dict | None = None, bnames: dict | None = None,
         apprs: dict | None = None) -> dict:
    job = db.get(JobCard, item.job_card_id)
    worker = (wnames or {}).get(item.worker_id) if wnames else None
    if worker is None:
        u = db.get(User, item.worker_id)
        worker = u.name if u else None
    bay_no = (bnames or {}).get(item.bay_id) if bnames else None
    if bay_no is None and item.bay_id:
        b = db.get(Bay, item.bay_id)
        bay_no = b.bay_number if b else None
    return {
        "id": item.id, "job_card_id": item.job_card_id,
        "status": item.status.value, "priority": item.priority.value,
        "queue_position": item.queue_position, "worker_id": item.worker_id, "worker_name": worker,
        "bay_id": item.bay_id, "bay_number": bay_no,
        "created_at": item.created_at.isoformat() if item.created_at else None,
        # job card detail (for the drawer)
        "job_card_number": job.job_card_number if job else None,
        "customer_name": job.customer_name if job else None,
        "customer_mobile": job.customer_mobile if job else None,
        "customer_email": job.customer_email if job else None,
        "customer_address": getattr(job, "customer_address", None) if job else None,
        "vehicle_number": job.vehicle_number if job else None,
        "vehicle_model": job.vehicle_model if job else None,
        "chassis_number": job.chassis_number if job else None,
        "engine_number": job.engine_number if job else None,
        "km_reading": job.km_reading if job else None,
        "service_type": job.service_type if job else None,
        "repair_type": job.repair_type if job else None,
        "estimated_cost": job.estimated_cost if job else None,
        "estimated_minutes": job.estimated_minutes if job else None,
        "complaint": getattr(job, "complaint", None) if job else None,
        "notes": getattr(job, "notes", None) if job else None,
        "services": getattr(job, "services", None) if job else None,
        "estimate_status": getattr(job, "estimate_status", None) if job else None,
        "source_type": job.source_type if job else None,
        "original_pdf_url": job.original_pdf_url if job else None,
        # Customer Estimate Approval status (None until an approval exists)
        "approval": _appr_summary(
            (apprs.get(item.id) if apprs is not None
             else db.scalar(select(CustomerApprovalRequest).where(
                 CustomerApprovalRequest.queue_job_id == item.id)
                 .order_by(CustomerApprovalRequest.created_at.desc())))),
        # Vehicle Intake Evidence for this bike (None until an intake exists) — additive chip
        "intake": _intake_summary(db, job.vehicle_number if job else None,
                                  job.branch_id if job else None),
    }


def _renumber(db: Session, worker_id: str) -> None:
    """Re-pack queued positions 1..N for a worker (keeps ordering stable)."""
    items = db.scalars(
        select(JobQueue).where(JobQueue.worker_id == worker_id, JobQueue.status == QueueStatus.queued)
        .order_by(JobQueue.queue_position)
    ).all()
    for i, it in enumerate(items, start=1):
        it.queue_position = i


def queue_grouped(db: Session, branch_id: str | None = None) -> dict:
    """All queued/assigned/active jobs grouped by worker. The ONE serializer shared by the REST
    GET and the WebSocket /ws/queue snapshot, so HTTP and WS always return the same shape.

    Branch isolation (Phase D): when ``branch_id`` is given (an admin), only jobs belonging to that
    branch are returned; ``None`` (a master) sees every branch. The scope is the JOB's own
    ``branch_id`` (set at creation = the admin's branch), so REST and WS stay identical and the
    single-branch deployment is unaffected (every current job is in the admin's branch)."""
    stmt = select(JobQueue).where(JobQueue.status != QueueStatus.completed)
    if branch_id:
        stmt = stmt.where(JobQueue.job_card_id.in_(
            select(JobCard.id).where(JobCard.branch_id == branch_id)))
    items = db.scalars(stmt.order_by(JobQueue.queue_position)).all()
    wnames = {u.id: u.name for u in db.scalars(select(User)).all()}
    bnames = {b.id: b.bay_number for b in db.scalars(select(Bay)).all()}
    apprs: dict = {}
    for r in db.scalars(select(CustomerApprovalRequest).order_by(CustomerApprovalRequest.created_at)).all():
        if r.queue_job_id:
            apprs[r.queue_job_id] = r          # latest wins (ordered ascending)
    grouped: dict[str, list] = {}
    for it in items:
        grouped.setdefault(it.worker_id, []).append(_row(db, it, wnames, bnames, apprs))
    return grouped


@router.get("")
def list_queue(db: Session = Depends(get_db), me: User = Depends(require_admin)):
    """All queued/assigned/active jobs grouped by worker (own branch; master sees all)."""
    return ok(queue_grouped(db, None if is_master(me) else me.branch_id))


@router.get("/{queue_id}")
def get_item(queue_id: str, db: Session = Depends(get_db), _: User = Depends(require_admin)):
    it = db.get(JobQueue, queue_id)
    if not it:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Queue item not found")
    return ok(_row(db, it))


def _assert_item_branch(db: Session, admin: User, it: JobQueue, action: str = "queue op") -> None:
    """Branch ownership for a queue item, resolved from its job card's branch."""
    job = db.get(JobCard, it.job_card_id)
    assert_branch_access(admin, job.branch_id if job else None, action)


@router.delete("/{queue_id}")
def remove_item(queue_id: str, db: Session = Depends(get_db), admin: User = Depends(require_admin)):
    it = db.get(JobQueue, queue_id)
    if not it:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Queue item not found")
    _assert_item_branch(db, admin, it, "remove from queue")
    worker_id = it.worker_id
    job = db.get(JobCard, it.job_card_id)
    db.delete(it); db.flush()
    _renumber(db, worker_id)
    log_action(db, "JOB_QUEUE_REMOVE", "job_queue", queue_id, admin.id,
               old={"jc": job.job_card_number if job else None})
    db.commit()
    return ok(message="Removed from queue")


@router.post("/{queue_id}/move")
def move_item(queue_id: str, body: MoveRequest, db: Session = Depends(get_db), admin: User = Depends(require_admin)):
    it = db.get(JobQueue, queue_id)
    if not it:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Queue item not found")
    _assert_item_branch(db, admin, it, "reorder queue")
    delta = -1 if body.direction == "up" else 1
    neighbour = db.scalar(
        select(JobQueue).where(
            JobQueue.worker_id == it.worker_id,
            JobQueue.queue_position == it.queue_position + delta,
            JobQueue.status == QueueStatus.queued,
        )
    )
    if neighbour:
        it.queue_position, neighbour.queue_position = neighbour.queue_position, it.queue_position
        db.commit()
    return ok(message="Reordered")


# NOTE: POST /{queue_id}/reassign was REMOVED (bay-first). Manually picking a
# worker for a job contradicts "bay owns worker". To move a job, change its BAY
# (below) — the worker follows the bay automatically.


@router.post("/{queue_id}/change-bay")
def change_bay(queue_id: str, body: ChangeBayRequest, db: Session = Depends(get_db), admin: User = Depends(require_admin)):
    """Bay-first: moving a job to another bay also moves it to that bay's
    worker queue (the worker always follows the bay — never picked directly)."""
    it = db.get(JobQueue, queue_id)
    if not it:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Queue item not found")
    _assert_item_branch(db, admin, it, "change bay (source)")
    if not body.bay_id:
        raise HTTPException(status.HTTP_400_BAD_REQUEST,
                            "Bay-first: a queued job must always target a bay.")
    bay = db.get(Bay, body.bay_id)
    if not bay:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Bay not found")
    assert_branch_access(admin, bay.branch_id, "change bay (target)")
    if bay.status in ("maintenance", "disabled") or getattr(bay, "is_active", True) is False:
        raise HTTPException(status.HTTP_409_CONFLICT,
                            f"Bay {bay.bay_number:02d} is not operational ({bay.status}).")
    new_worker = workflow_engine.resolve_bay_worker(db, body.bay_id)
    if not new_worker:
        raise HTTPException(status.HTTP_400_BAD_REQUEST,
                            "Bay is not operational. Assign a primary worker first.")
    old_worker = it.worker_id
    it.bay_id = body.bay_id
    if new_worker != old_worker:
        pos = db.scalar(select(func.count()).select_from(JobQueue).where(
            JobQueue.worker_id == new_worker, JobQueue.status == QueueStatus.queued)) or 0
        it.worker_id = new_worker
        it.queue_position = pos + 1
        db.flush()
        _renumber(db, old_worker)
    log_action(db, "JOB_CHANGE_BAY", "job_queue", queue_id, admin.id,
               new={"bay": body.bay_id, "worker": new_worker})
    db.commit()
    return ok({"worker_id": new_worker}, "Bay updated — job moved to the bay's worker")


@router.post("/{queue_id}/assign")
def assign_item(queue_id: str, body: AssignRequest, db: Session = Depends(get_db), admin: User = Depends(require_admin)):
    # Row-lock the queue item so two admins assigning the SAME job at the same
    # instant are serialised: the second blocks here, then sees status=assigned
    # and gets a clean 409 instead of colliding on the session PK (raw 500).
    # (FOR UPDATE is a no-op on SQLite/dev; the status re-check still guards it.)
    it = db.get(JobQueue, queue_id, with_for_update=True)
    if not it:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Queue item not found")
    if it.status != QueueStatus.queued:
        raise HTTPException(status.HTTP_409_CONFLICT, "This job is already assigned.")
    _assert_item_branch(db, admin, it, "assign job (source)")
    bay = db.get(Bay, body.bay_id)
    if not bay:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Bay not found")
    assert_branch_access(admin, bay.branch_id, "assign job (target bay)")
    # `force` may only override a BUSY bay — never a non-operational one.
    if getattr(bay, "is_active", True) is False or bay.status == "disabled":
        raise HTTPException(status.HTTP_409_CONFLICT, "Bay is disabled.")
    if bay.status == "maintenance":
        raise HTTPException(status.HTTP_409_CONFLICT, "Bay is under maintenance.")
    if not workflow_engine.resolve_bay_worker(db, bay.id):
        raise HTTPException(status.HTTP_400_BAD_REQUEST,
                            "Bay is not operational. Assign a primary worker first.")
    if bay.status != "available" and not body.force:
        raise HTTPException(status.HTTP_409_CONFLICT, "Bay is busy (use force to override)")

    worker_id = it.worker_id
    session = workflow_engine.create_from_assign(db, it, bay, admin.id)
    _renumber(db, worker_id)
    db.commit()
    # Honest handoff preview (read-only): authoritative estimate + device/approval
    # readiness so the admin sees what the bay will (and won't) do on Start.
    job = db.get(JobCard, it.job_card_id)
    minutes, est_source, approved_cost = workflow_engine.resolve_estimate(db, job, it)
    signals = workflow_engine.handoff_signals(db, bay.id, job, it)
    return ok({"service_session_id": session.id, "bay_id": bay.id,
               "estimate": {"minutes": minutes, "source": est_source, "approved_cost": approved_cost},
               "readiness": signals["readiness"], "approval": signals["approval"],
               "warnings": signals["warnings"]},
              "Assigned to bay; service session created (NOT STARTED)")
