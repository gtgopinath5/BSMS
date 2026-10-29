"""Customer Estimate Approval — ADMIN / MASTER plane (/api/v1/customer-approvals).

Create an approval DRAFT from a queued job (original items seeded from the job card's
extracted ``services``), edit items, add admin SUGGESTIONS, generate a secure temporary
link, send it via WhatsApp (real or honest no-op), and track the customer's response.

require_admin on every route (worker→403, anon→401); branch isolation enforced. The raw
token is returned ONCE by /generate-link and never stored (only sha256 is) — mirrors
Customer Live Watch.
"""
import json
import secrets
from datetime import datetime, timedelta

from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel
from sqlalchemy import select, text, func
from sqlalchemy.orm import Session

from ..config import settings
from ..database import get_db, engine
from ..models.branch import Branch
from ..models.job import JobCard, JobQueue
from ..models.user import User, UserRole
from ..models.customer_approval import (
    CustomerApprovalRequest, CustomerApprovalItem, CustomerApprovalVersion,
    CustomerApprovalLink, LOCKED_STATUSES,
    SOURCE_ORIGINAL, SOURCE_SUGGESTION, REASON_TYPES,
)
from ..schemas.common import ok
from ..services import whatsapp_service
from ..utils import ids, approval as A
from ..utils.audit import log_action
from ..utils.auth import require_admin, assert_branch_access, is_master

router = APIRouter()

# Link TTL + date-wise retention window are unified at settings.customer_approval_retention_days
# (default 14 days). An unsubmitted link auto-expires after that; a customer SUBMIT expires it
# immediately (see approval_public.submit).

_CA_MIGRATED = False


def ensure_customer_approval_schema() -> None:
    """Add columns introduced after first release to the customer-approval tables if missing
    (idempotent, additive — never drops). PG + SQLite. Mirrors ensure_test_drive_schema.
    The Phase-2 ``customer_approval_versions`` / ``customer_approval_links`` TABLES are created
    by ``init_db()`` (create_all) — only the additive COLUMNS below need ALTER."""
    global _CA_MIGRATED
    if _CA_MIGRATED:
        return
    dialect = engine.dialect.name
    f = "false" if dialect == "postgresql" else "0"
    later: dict[str, list[tuple[str, str]]] = {
        "customer_approval_items": [
            # Phase 1 — dealership cost detail
            ("unit_value", "FLOAT"), ("service_cost", "FLOAT"),
            ("labour_cost", "FLOAT"), ("total_cost", "FLOAT"),
            ("has_missing_cost", f"BOOLEAN DEFAULT {f}"),
        ],
        "customer_approval_requests": [
            # Phase 1 — cost totals + preview gate
            ("estimated_service_cost_total", "FLOAT DEFAULT 0"),
            ("estimated_labour_cost_total", "FLOAT DEFAULT 0"),
            ("preview_confirmed", f"BOOLEAN DEFAULT {f}"),
            ("previewed_at", "TIMESTAMP"),
            # Phase 2 — versioning + links + date-wise retention
            ("current_version_no", "INTEGER DEFAULT 1"),
            ("active_link_id", "VARCHAR(36)"),
            ("editing", f"BOOLEAN DEFAULT {f}"),
            ("last_sent_at", "TIMESTAMP"),
            ("last_viewed_at", "TIMESTAMP"),
            ("last_submitted_at", "TIMESTAMP"),
            ("retention_expires_at", "TIMESTAMP"),
            ("deleted_at", "TIMESTAMP"),
            ("superseded_count", "INTEGER DEFAULT 0"),
        ],
        "customer_approval_audit_events": [
            # Phase 2 — richer audit timeline
            ("actor_name", "VARCHAR(120)"),
            ("version_no", "INTEGER"),
        ],
    }
    with engine.begin() as conn:
        for tbl, cols in later.items():
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
    _CA_MIGRATED = True


def _actor(admin: User) -> str:
    return "master_admin" if is_master(admin) else "admin"


def _approval_url(raw: str) -> str:
    return f"{settings.customer_watch_base_url.rstrip('/')}/customer-approval/{raw}"


def _get(db: Session, admin: User, approval_id: str, action: str) -> CustomerApprovalRequest:
    req = db.get(CustomerApprovalRequest, approval_id)
    if not req:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Approval not found")
    assert_branch_access(admin, req.branch_id, action)
    return req


def _assert_editable(req: CustomerApprovalRequest) -> None:
    # An Edit & Resend session re-opens a responded/sent estimate for a NEW version, so a
    # terminal status is fine while ``editing`` is set; it just produces version N+1.
    if getattr(req, "editing", False):
        return
    if req.status in LOCKED_STATUSES:
        raise HTTPException(status.HTTP_409_CONFLICT,
                            f"This approval is {req.status} and can no longer be edited.")


def _reset_preview(req: CustomerApprovalRequest) -> None:
    """Any item/cost change invalidates a prior preview — the admin must preview again."""
    req.preview_confirmed = False
    req.previewed_at = None


def _assert_sendable(db: Session, req: CustomerApprovalRequest) -> None:
    """Both Phase-1 send gates: the estimate must have been PREVIEWED, and no included
    item may have a missing cost. Cost is backend-authoritative."""
    if not getattr(req, "preview_confirmed", False):
        raise HTTPException(status.HTTP_409_CONFLICT,
                            "Preview the estimate before sending it to the customer.")
    miss = A.missing_cost_items(db, req)
    if miss:
        raise HTTPException(status.HTTP_409_CONFLICT,
                            f"Fill the missing cost for {len(miss)} part(s) before sending.")


def _assert_item_editable(db: Session, req: CustomerApprovalRequest) -> None:
    """Phase 2 freeze: once a link is active, items may only change inside an Edit & Resend
    session (so the live items can't drift away from what the customer was sent)."""
    _assert_editable(req)
    if A.active_link(db, req) and not getattr(req, "editing", False):
        raise HTTPException(status.HTTP_409_CONFLICT,
                            "This estimate has already been sent. Use “Edit & Resend” to change it.")


def _next_version_no(db: Session, req: CustomerApprovalRequest) -> int:
    last = db.scalar(select(func.max(CustomerApprovalVersion.version_no)).where(
        CustomerApprovalVersion.approval_request_id == req.id))
    return int(last or 0) + 1


def _send_version(db: Session, req: CustomerApprovalRequest, admin: User) -> str:
    """Shared send/resend core (backend-authoritative). Snapshots the current items into a new
    IMMUTABLE version, supersedes the prior active link/version, issues ONE new active link,
    updates the request, and writes the audit timeline. Returns the raw token (shown ONCE)."""
    A.recalc(db, req)
    _assert_sendable(db, req)
    prev = A.supersede_active(db, req)                 # no-op for the very first version
    version_no = _next_version_no(db, req)
    is_resend = version_no > 1
    raw = secrets.token_urlsafe(32)
    version = A.create_version(db, req, admin, version_no, status="sent")
    A.issue_link(db, req, version_no, raw, public_url=None)
    # refresh the active-link pointer
    link = A.active_link(db, req)
    now = A._now()
    req.current_version_no = version_no
    req.active_link_id = link.id if link else None
    req.token_hash = A.hash_token(raw)                 # legacy back-compat pointer
    req.expires_at = link.expires_at if link else None
    req.status = "sent"
    req.editing = False
    req.sent_at = req.sent_at or now
    req.sent_by = admin.id
    req.last_sent_at = now
    A.touch_retention(req)
    actor, name = _actor(admin), admin.name
    if prev and prev.status == "superseded":
        A.event(db, req.id, actor, "token_superseded",
                f"Version {prev.version_no} link superseded", actor_name=name,
                version_no=prev.version_no)
    A.event(db, req.id, actor, "version_created",
            f"Version {version_no} created", actor_name=name, version_no=version_no)
    A.event(db, req.id, actor, "link_generated", "Temporary link issued",
            actor_name=name, version_no=version_no)
    if is_resend:
        diff = A.diff_versions(db, prev, version)
        A.event(db, req.id, actor, "resent",
                f"Resent as version {version_no} (Δ ₹{diff['difference']:.0f})",
                meta=diff, actor_name=name, version_no=version_no)
    log_action(db, "APPROVAL_LINK", "customer_approval", req.id, admin.id,
               new={"version": version_no, "resend": is_resend})
    return raw


# ── create / open from a queued job ────────────────────────────────────────
@router.post("/from-queue/{queue_job_id}")
def from_queue(queue_job_id: str, admin: User = Depends(require_admin), db: Session = Depends(get_db)):
    item = db.get(JobQueue, queue_job_id)
    if not item:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Queue item not found")
    job = db.get(JobCard, item.job_card_id)
    if not job:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Job card not found")
    assert_branch_access(admin, job.branch_id, "create customer approval")

    # reuse an existing OPEN (non-terminal) approval for this queue job
    existing = db.scalar(select(CustomerApprovalRequest).where(
        CustomerApprovalRequest.queue_job_id == queue_job_id,
        CustomerApprovalRequest.status.notin_(LOCKED_STATUSES),
    ))
    if existing:
        return ok(A.admin_serialize(db, existing), "Opened existing approval draft")

    branch = db.get(Branch, job.branch_id) if job.branch_id else None
    showroom = {"name": getattr(branch, "name", None),
                "address": getattr(branch, "address", None),
                "phone": getattr(branch, "phone", None) or getattr(branch, "contact", None),
                "advisor": admin.name}
    req = CustomerApprovalRequest(
        id=ids.next_customer_approval_id(db, CustomerApprovalRequest),
        branch_id=job.branch_id, queue_job_id=queue_job_id, job_card_id=job.id,
        job_card_number=job.job_card_number,
        customer_name=job.customer_name, customer_mobile=job.customer_mobile,
        customer_email=job.customer_email, vehicle_number=job.vehicle_number,
        vehicle_model=job.vehicle_model, service_type=job.service_type,
        complaint=getattr(job, "complaint", None),
        showroom_json=json.dumps(showroom), status="draft", created_by=admin.id,
    )
    db.add(req)
    db.flush()
    seeded = A.seed_items_from_job(db, req, job)
    A.event(db, req.id, _actor(admin), "created", f"Draft from queue ({seeded} items)",
            actor_name=admin.name, version_no=1)
    log_action(db, "APPROVAL_CREATED", "customer_approval", req.id, admin.id,
               new={"job_card": job.job_card_number, "items": seeded})
    db.commit()
    return ok(A.admin_serialize(db, req), "Approval draft created")


# ── list (date-wise dashboard with filters + retention visibility) ───────────
def _parse_date(s: str | None) -> datetime | None:
    if not s or not isinstance(s, str):
        return None
    for fmt in ("%Y-%m-%d", "%Y-%m-%dT%H:%M:%S", "%Y-%m-%dT%H:%M"):
        try:
            return datetime.strptime(s[:19] if "T" in s else s[:10], fmt)
        except ValueError:
            continue
    return None


@router.get("")
def list_approvals(status_filter: str | None = Query(None, alias="status"),
                   q: str | None = Query(None),
                   date_from: str | None = Query(None),
                   date_to: str | None = Query(None),
                   include_expired: bool = Query(False),
                   include_deleted: bool = Query(False),
                   admin: User = Depends(require_admin), db: Session = Depends(get_db)):
    stmt = select(CustomerApprovalRequest).order_by(CustomerApprovalRequest.created_at.desc())
    if not is_master(admin):
        stmt = stmt.where(CustomerApprovalRequest.branch_id == admin.branch_id)
    if status_filter:
        stmt = stmt.where(CustomerApprovalRequest.status == status_filter)
    # retention: hide soft-deleted records by default (date-wise 14-day window)
    if not include_deleted:
        stmt = stmt.where(CustomerApprovalRequest.deleted_at.is_(None))
    if not include_expired and not status_filter:
        stmt = stmt.where(CustomerApprovalRequest.status != "expired")
    df, dt = _parse_date(date_from), _parse_date(date_to)
    if df:
        stmt = stmt.where(CustomerApprovalRequest.created_at >= df)
    if dt:
        stmt = stmt.where(CustomerApprovalRequest.created_at < dt + timedelta(days=1))
    rows = db.scalars(stmt).all()
    if q:
        ql = q.lower()
        rows = [r for r in rows if any(ql in str(v or "").lower() for v in
                (r.customer_name, r.vehicle_number, r.job_card_number, r.id, r.customer_mobile))]
    return ok([A.admin_serialize(db, r, with_items=False) for r in rows])


# ── retention cleanup (date-wise temporary history) ─────────────────────────
@router.post("/cleanup")
def cleanup(admin: User = Depends(require_admin), db: Session = Depends(get_db)):
    """Soft-expire links/versions/requests past the 14-day window. Idempotent. NEVER touches
    core business data (job cards, sessions, work completion, invoices)."""
    res = A.cleanup_expired(db)
    log_action(db, "APPROVAL_CLEANUP", "customer_approval", "*", admin.id, new=res)
    return ok(res, f"Cleanup done — {res['expired_links']} link(s), "
                   f"{res['expired_requests']} record(s) expired")


@router.get("/{approval_id}")
def get_approval(approval_id: str, admin: User = Depends(require_admin), db: Session = Depends(get_db)):
    req = _get(db, admin, approval_id, "view customer approval")
    return ok(A.admin_serialize(db, req))


# ── edit request details ──────────────────────────────────────────────────--
class UpdateReq(BaseModel):
    customer_name: str | None = None
    customer_mobile: str | None = None
    customer_email: str | None = None
    vehicle_number: str | None = None
    vehicle_model: str | None = None
    service_type: str | None = None
    complaint: str | None = None


@router.put("/{approval_id}")
def update_approval(approval_id: str, body: UpdateReq,
                    admin: User = Depends(require_admin), db: Session = Depends(get_db)):
    req = _get(db, admin, approval_id, "edit customer approval")
    _assert_editable(req)
    for k, v in body.model_dump(exclude_unset=True).items():
        setattr(req, k, v)
    req.updated_at = A._now()
    A.event(db, req.id, _actor(admin), "updated", "Details edited")
    db.commit()
    return ok(A.admin_serialize(db, req), "Saved")


# ── items: add / edit / delete ─────────────────────────────────────────────
class ItemBody(BaseModel):
    source: str | None = None              # original | admin_suggestion (add only)
    reason_type: str | None = None         # mandatory | suggested | upcoming | none
    item_name: str | None = None
    product_code: str | None = None
    quantity: float | None = None
    unit_price: float | None = None
    unit_value: float | None = None
    service_cost: float | None = None
    labour_cost: float | None = None
    total_cost: float | None = None
    estimated_minutes: int | None = None
    description: str | None = None        # admin reason (internal)
    admin_note: str | None = None         # customer-facing "how it helps" note


@router.post("/{approval_id}/items")
def add_item(approval_id: str, body: ItemBody,
             admin: User = Depends(require_admin), db: Session = Depends(get_db)):
    req = _get(db, admin, approval_id, "add approval item")
    _assert_item_editable(db, req)
    if not (body.item_name or "").strip():
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "Item name is required")
    src = SOURCE_SUGGESTION if body.source == SOURCE_SUGGESTION else SOURCE_ORIGINAL
    reason = body.reason_type if body.reason_type in REASON_TYPES else ("suggested" if src == SOURCE_SUGGESTION else "none")
    nxt = (db.scalar(select(CustomerApprovalItem).where(
        CustomerApprovalItem.approval_request_id == req.id).order_by(
        CustomerApprovalItem.sort_order.desc())))
    sort_order = (nxt.sort_order + 1) if nxt else 0
    it = CustomerApprovalItem(
        approval_request_id=req.id, source=src, reason_type=reason,
        item_name=body.item_name.strip()[:200], product_code=body.product_code,
        quantity=float(body.quantity or 1), unit_price=float(body.unit_price or 0),
        unit_value=body.unit_value, service_cost=body.service_cost,
        labour_cost=body.labour_cost, total_cost=body.total_cost,
        estimated_minutes=int(body.estimated_minutes or 0), description=body.description,
        admin_note=body.admin_note,
        customer_status=("pending" if src == SOURCE_SUGGESTION else "approved"),
        final_included=(src == SOURCE_ORIGINAL), sort_order=sort_order,
    )
    db.add(it)
    db.flush()
    A.recalc(db, req)
    _reset_preview(req)
    A.event(db, req.id, _actor(admin), "suggestion_added" if src == SOURCE_SUGGESTION else "item_added",
            f"{it.item_name}")
    db.commit()
    return ok(A.admin_serialize(db, req), "Item added")


@router.put("/{approval_id}/items/{item_id}")
def edit_item(approval_id: str, item_id: str, body: ItemBody,
              admin: User = Depends(require_admin), db: Session = Depends(get_db)):
    req = _get(db, admin, approval_id, "edit approval item")
    _assert_item_editable(db, req)
    it = db.get(CustomerApprovalItem, item_id)
    if not it or it.approval_request_id != req.id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Item not found")
    data = body.model_dump(exclude_unset=True)
    for k in ("item_name", "product_code", "description", "admin_note"):
        if k in data:
            setattr(it, k, data[k])
    if "reason_type" in data and data["reason_type"] in REASON_TYPES:
        it.reason_type = data["reason_type"]
    if "quantity" in data:
        it.quantity = float(data["quantity"] or 0)
    if "unit_price" in data:
        it.unit_price = float(data["unit_price"] or 0)
    for ck in ("unit_value", "service_cost", "labour_cost", "total_cost"):
        if ck in data:
            v = data[ck]
            setattr(it, ck, float(v) if v not in (None, "") else None)
    if "estimated_minutes" in data:
        it.estimated_minutes = int(data["estimated_minutes"] or 0)
    it.updated_at = A._now()
    db.flush()
    A.recalc(db, req)
    _reset_preview(req)
    db.commit()
    return ok(A.admin_serialize(db, req), "Item updated")


@router.delete("/{approval_id}/items/{item_id}")
def delete_item(approval_id: str, item_id: str,
                admin: User = Depends(require_admin), db: Session = Depends(get_db)):
    req = _get(db, admin, approval_id, "delete approval item")
    _assert_item_editable(db, req)
    it = db.get(CustomerApprovalItem, item_id)
    if not it or it.approval_request_id != req.id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Item not found")
    db.delete(it)
    db.flush()
    A.recalc(db, req)
    _reset_preview(req)
    db.commit()
    return ok(A.admin_serialize(db, req), "Item removed")


# ── preview (required before send) ──────────────────────────────────────────
@router.post("/{approval_id}/preview")
def preview(approval_id: str, admin: User = Depends(require_admin), db: Session = Depends(get_db)):
    """Recompute (backend-authoritative) and return the exact customer-form snapshot.
    Marks the request previewed so a link can be generated/sent. Editing any item
    invalidates this again."""
    req = _get(db, admin, approval_id, "preview approval")
    _assert_editable(req)
    A.recalc(db, req)
    miss = A.missing_cost_items(db, req)
    req.preview_confirmed = True
    req.previewed_at = A._now()
    A.event(db, req.id, _actor(admin), "previewed",
            f"Previewed estimate ({len(miss)} missing cost)",
            actor_name=admin.name, version_no=getattr(req, "current_version_no", 1))
    db.commit()
    snap = A.public_serialize(db, req)           # exactly what the customer will see
    job = db.get(JobCard, req.job_card_id) if req.job_card_id else None
    snap["form"] = A.customer_form_blocks(req, job)   # job-card header blocks (same shape as public)
    snap["version_no"] = getattr(req, "current_version_no", 1)
    snap["missing_cost_count"] = len(miss)
    snap["preview_confirmed"] = True
    snap["can_send"] = (len(miss) == 0)
    return ok(snap, "Preview ready" if not miss else "Preview ready — fill missing costs to send")


# ── link lifecycle (Phase 2: version snapshots + one active link) ────────────
@router.post("/{approval_id}/generate-link")
def generate_link(approval_id: str, admin: User = Depends(require_admin), db: Session = Depends(get_db)):
    """Issue the FIRST customer link (version 1). Subsequent sends go through Edit & Resend."""
    req = _get(db, admin, approval_id, "generate approval link")
    if req.status == "cancelled":
        raise HTTPException(status.HTTP_409_CONFLICT, "This approval is cancelled.")
    if not A.items_for(db, req.id):
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY,
                            "Add at least one item before generating a link.")
    if A.active_link(db, req):
        raise HTTPException(status.HTTP_409_CONFLICT,
                            "A link is already active. Use “Edit & Resend” to send an updated "
                            "estimate, or revoke the current link first.")
    raw = _send_version(db, req, admin)          # recalc + preview/missing-cost gates inside
    db.commit()
    data = A.admin_serialize(db, req)
    data["approval_url"] = _approval_url(raw)     # shown ONCE — not stored
    return ok(data, "Approval link generated")


@router.post("/{approval_id}/edit-resend/start")
def edit_resend_start(approval_id: str, admin: User = Depends(require_admin), db: Session = Depends(get_db)):
    """Open an Edit & Resend session: unfreeze item editing and require a fresh preview. The
    already-sent version snapshot stays immutable; only the live working set becomes editable."""
    req = _get(db, admin, approval_id, "edit & resend approval")
    if req.status == "cancelled":
        raise HTTPException(status.HTTP_409_CONFLICT, "A cancelled approval cannot be resent.")
    req.editing = True
    _reset_preview(req)
    req.updated_at = A._now()
    A.event(db, req.id, _actor(admin), "edit_resend_started", "Edit & Resend started",
            actor_name=admin.name, version_no=getattr(req, "current_version_no", 1))
    db.commit()
    return ok(A.admin_serialize(db, req), "Editing — make changes, preview, then resend")


@router.post("/{approval_id}/resend")
def resend(approval_id: str, admin: User = Depends(require_admin), db: Session = Depends(get_db)):
    """Create the next IMMUTABLE version, supersede the old active link, issue a new one."""
    req = _get(db, admin, approval_id, "resend approval")
    if not getattr(req, "editing", False):
        raise HTTPException(status.HTTP_409_CONFLICT, "Start “Edit & Resend” before resending.")
    if not A.items_for(db, req.id):
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY,
                            "Add at least one item before resending.")
    raw = _send_version(db, req, admin)          # supersedes old link + version, asserts sendable
    db.commit()
    data = A.admin_serialize(db, req)
    data["approval_url"] = _approval_url(raw)
    return ok(data, f"Resent as version {req.current_version_no}")


@router.post("/{approval_id}/revoke-link")
def revoke_link(approval_id: str, admin: User = Depends(require_admin), db: Session = Depends(get_db)):
    """Kill the current active link without superseding via a resend. The approval returns to
    a draft state so it can be edited and re-sent."""
    req = _get(db, admin, approval_id, "revoke approval link")
    lk = A.active_link(db, req)
    if not lk:
        raise HTTPException(status.HTTP_409_CONFLICT, "No active link to revoke.")
    now = A._now()
    lk.status = "revoked"
    lk.revoked_at = now
    v = A.version_by_no(db, req.id, lk.version_no)
    if v and v.status in ("sent", "viewed", "draft"):
        v.status = "revoked"
        v.revoked_at = now
    req.active_link_id = None
    req.token_hash = None
    req.expires_at = None
    if req.status in ("sent", "viewed"):
        req.status = "draft"
    A.event(db, req.id, _actor(admin), "token_revoked", "Link revoked",
            actor_name=admin.name, version_no=lk.version_no)
    log_action(db, "APPROVAL_REVOKE", "customer_approval", req.id, admin.id)
    db.commit()
    return ok(A.admin_serialize(db, req), "Link revoked")


@router.get("/{approval_id}/history")
def get_history(approval_id: str, admin: User = Depends(require_admin), db: Session = Depends(get_db)):
    """Version history + audit timeline for the detail drawer (date-wise)."""
    req = _get(db, admin, approval_id, "view approval history")
    return ok(A.history(db, req))


class SendWA(BaseModel):
    token: str          # the raw token from /generate-link (capability)


@router.post("/{approval_id}/send-whatsapp")
def send_whatsapp(approval_id: str, body: SendWA,
                  admin: User = Depends(require_admin), db: Session = Depends(get_db)):
    req = _get(db, admin, approval_id, "send approval whatsapp")
    if not req.token_hash:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Generate a link first.")
    if A.hash_token(body.token) != req.token_hash:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Token does not match this approval.")
    A.recalc(db, req)
    _assert_sendable(db, req)        # preview required + no missing cost
    res = whatsapp_service.send_approval_link(req.customer_mobile, req.customer_name, body.token)
    req.whatsapp_status = res.get("status")
    req.whatsapp_error = None if res.get("ok") else (res.get("message") or res.get("detail"))
    req.whatsapp_message_id = res.get("message_id")
    if res.get("ok"):
        req.whatsapp_sent_at = A._now()
        req.sent_at = req.sent_at or A._now()
        req.sent_by = admin.id
    A.event(db, req.id, _actor(admin), "whatsapp_sent", res.get("message"),
            {"status": res.get("status")}, actor_name=admin.name,
            version_no=getattr(req, "current_version_no", 1))
    log_action(db, "APPROVAL_WHATSAPP", "customer_approval", req.id, admin.id,
               new={"status": res.get("status")})
    db.commit()
    out = {"whatsapp": res, "whatsapp_configured": whatsapp_service.is_configured(),
           "request": A.admin_serialize(db, req, with_items=False)}
    return ok(out, res.get("message") or ("Sent" if res.get("ok") else "Not sent"))


@router.post("/{approval_id}/cancel")
def cancel(approval_id: str, admin: User = Depends(require_admin), db: Session = Depends(get_db)):
    req = _get(db, admin, approval_id, "cancel approval")
    if req.status == "submitted":
        raise HTTPException(status.HTTP_409_CONFLICT, "A submitted approval cannot be cancelled.")
    req.status = "cancelled"
    req.token_hash = None             # kill the link
    req.cancelled_at = A._now()
    A.event(db, req.id, _actor(admin), "cancelled", "Approval cancelled")
    log_action(db, "APPROVAL_CANCELLED", "customer_approval", req.id, admin.id)
    db.commit()
    return ok(A.admin_serialize(db, req, with_items=False), "Approval cancelled")
