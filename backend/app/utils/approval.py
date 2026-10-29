"""Customer Estimate Approval — shared helpers (totals, seeding, serialization, audit).

Totals are ALWAYS recomputed here from the stored items (never trusted from the client),
and the public serializer deliberately omits internal ids (branch/queue/job-card/users) so
a token holder only ever sees their own estimate.
"""
import hashlib
import json
from datetime import datetime, timezone, timedelta

from sqlalchemy import select

from ..config import settings
from ..models.customer_approval import (
    CustomerApprovalItem, CustomerApprovalEvent, CustomerApprovalRequest,
    CustomerApprovalVersion, CustomerApprovalLink,
    SOURCE_ORIGINAL, SOURCE_SUGGESTION, LINK_DEAD, RESPONSE_STATUSES,
)


def hash_token(raw: str) -> str:
    return hashlib.sha256(raw.encode()).hexdigest()


def _now() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)


# ── item math ───────────────────────────────────────────────────────────────
def item_amount(it: CustomerApprovalItem) -> float:
    """Final authoritative row total: dealership total_cost if present, else
    service_cost + labour_cost, else the legacy quantity × unit_price."""
    if getattr(it, "total_cost", None) is not None:
        return round(it.total_cost, 2)
    sc, lc = getattr(it, "service_cost", None), getattr(it, "labour_cost", None)
    if sc is not None or lc is not None:
        return round((sc or 0) + (lc or 0), 2)
    return round((it.quantity or 0) * (it.unit_price or 0), 2)


def item_missing_cost(it: CustomerApprovalItem) -> bool:
    """An item whose cost cannot be determined — no total/service/labour AND no legacy
    unit price. While it's included in the estimate, sending is blocked until filled."""
    return (getattr(it, "total_cost", None) is None
            and getattr(it, "service_cost", None) is None
            and getattr(it, "labour_cost", None) is None
            and (it.unit_price or 0) <= 0)


def included_for(source: str, customer_status: str) -> bool:
    """Whether an item counts in the FINAL approved estimate, from its action state."""
    if source == SOURCE_ORIGINAL:
        return customer_status != "removed"
    return customer_status == "added"          # a suggestion only counts once accepted


def items_for(db, request_id: str) -> list[CustomerApprovalItem]:
    return db.scalars(
        select(CustomerApprovalItem)
        .where(CustomerApprovalItem.approval_request_id == request_id)
        .order_by(CustomerApprovalItem.source, CustomerApprovalItem.sort_order)
    ).all()


def recalc(db, req: CustomerApprovalRequest) -> dict:
    """Recompute every item amount, cost flags, and the request totals from the DB rows.
    Backend-authoritative — never trust client-sent totals."""
    items = items_for(db, req.id)
    removed_cost = added_cost = 0.0
    for it in items:
        it.amount = item_amount(it)
        it.has_missing_cost = item_missing_cost(it)
        it.final_included = included_for(it.source, it.customer_status)
        if it.source == SOURCE_ORIGINAL and it.customer_status == "removed":
            removed_cost += it.amount
        if it.source == SOURCE_SUGGESTION and it.customer_status == "added":
            added_cost += it.amount
    orig = [i for i in items if i.source == SOURCE_ORIGINAL]
    incl = [i for i in items if i.final_included]
    req.original_total_cost = round(sum(i.amount for i in orig), 2)
    req.original_total_minutes = int(sum(i.estimated_minutes or 0 for i in orig))
    req.approved_total_cost = round(sum(i.amount for i in incl), 2)
    req.approved_total_minutes = int(sum(i.estimated_minutes or 0 for i in incl))
    # dealership cost-detail totals (included items only)
    req.estimated_service_cost_total = round(sum((i.service_cost or 0) for i in incl), 2)
    req.estimated_labour_cost_total = round(sum((i.labour_cost or 0) for i in incl), 2)
    missing = [i for i in incl if i.has_missing_cost]
    return {
        "original_cost": req.original_total_cost, "original_minutes": req.original_total_minutes,
        "approved_cost": req.approved_total_cost, "approved_minutes": req.approved_total_minutes,
        "service_cost_total": req.estimated_service_cost_total,
        "labour_cost_total": req.estimated_labour_cost_total,
        "final_estimated_cost": req.approved_total_cost,
        "removed_cost": round(removed_cost, 2), "suggested_added_cost": round(added_cost, 2),
        "approved_count": len(incl), "missing_cost_count": len(missing),
        "removed_count": len([i for i in orig if i.customer_status == "removed"]),
        "rejected_count": len([i for i in items if i.source == SOURCE_SUGGESTION and i.customer_status == "rejected"]),
    }


def missing_cost_items(db, req: CustomerApprovalRequest) -> list[CustomerApprovalItem]:
    """Included items whose cost can't be determined — sending is blocked until filled."""
    return [it for it in items_for(db, req.id)
            if included_for(it.source, it.customer_status) and item_missing_cost(it)]


def _f(v):
    try:
        return float(v) if v is not None and str(v) != "" else None
    except (TypeError, ValueError):
        return None


def seed_items_from_job(db, req: CustomerApprovalRequest, job) -> int:
    """Create ORIGINAL items from a job card. Prefer the Parts Detail rows (``job.parts``,
    which carry the dealership cost columns); fall back to the legacy ``job.services``.
    Idempotent-ish: only seeds when the request has no items yet."""
    if items_for(db, req.id):
        return 0
    rows = getattr(job, "parts", None) or getattr(job, "services", None) or []
    n = 0
    for i, s in enumerate(rows):
        if not isinstance(s, dict):
            continue
        name = s.get("part_name") or s.get("service") or s.get("name") or "Service item"
        sc, lc, tc = _f(s.get("service_cost")), _f(s.get("labour_cost")), _f(s.get("total_cost"))
        db.add(CustomerApprovalItem(
            approval_request_id=req.id, source=SOURCE_ORIGINAL, reason_type="none",
            item_name=str(name)[:200],
            product_code=s.get("part_number") or s.get("part_code") or s.get("product_code"),
            quantity=float(s.get("qty") or s.get("quantity") or 1),
            unit_value=_f(s.get("unit_value")),
            unit_price=float(s.get("unit_price") or 0),
            service_cost=sc, labour_cost=lc, total_cost=tc,
            estimated_minutes=int(round(s.get("minutes") or s.get("estimated_minutes") or 0)),
            customer_status="approved", final_included=True, sort_order=i,
        ))
        n += 1
    db.flush()
    recalc(db, req)        # sets amount + has_missing_cost + totals
    return n


def event(db, request_id: str, actor_type: str, event_type: str,
          message: str | None = None, meta: dict | None = None,
          actor_name: str | None = None, version_no: int | None = None) -> None:
    db.add(CustomerApprovalEvent(
        approval_request_id=request_id, actor_type=actor_type, event_type=event_type,
        message=message, metadata_json=json.dumps(meta) if meta else None,
        actor_name=actor_name, version_no=version_no,
    ))


# ── serialization ─────────────────────────────────────────────────────────--
def _item_dict(it: CustomerApprovalItem) -> dict:
    return {
        "id": it.id, "source": it.source, "reason_type": it.reason_type,
        "item_name": it.item_name, "product_code": it.product_code,
        "quantity": it.quantity, "unit_price": it.unit_price,
        # dealership cost detail
        "unit_value": getattr(it, "unit_value", None),
        "service_cost": getattr(it, "service_cost", None),
        "labour_cost": getattr(it, "labour_cost", None),
        "total_cost": getattr(it, "total_cost", None),
        "has_missing_cost": bool(getattr(it, "has_missing_cost", False)),
        "estimated_minutes": it.estimated_minutes, "amount": it.amount,
        "description": it.description, "admin_note": getattr(it, "admin_note", None),
        "customer_status": it.customer_status,
        "final_included": it.final_included, "sort_order": it.sort_order,
    }


def _iso(dt) -> str | None:
    return dt.isoformat() if dt else None


def admin_serialize(db, req: CustomerApprovalRequest, with_items: bool = True) -> dict:
    out = {
        "id": req.id, "status": req.status, "branch_id": req.branch_id,
        "queue_job_id": req.queue_job_id, "job_card_id": req.job_card_id,
        "job_card_number": req.job_card_number,
        "customer_name": req.customer_name, "customer_mobile": req.customer_mobile,
        "customer_email": req.customer_email, "vehicle_number": req.vehicle_number,
        "vehicle_model": req.vehicle_model, "service_type": req.service_type,
        "complaint": req.complaint,
        "showroom": json.loads(req.showroom_json) if req.showroom_json else None,
        "customer_note": req.customer_note,
        "has_link": bool(req.token_hash),
        "preview_confirmed": bool(getattr(req, "preview_confirmed", False)),
        "previewed_at": _iso(getattr(req, "previewed_at", None)),
        "whatsapp_status": req.whatsapp_status, "whatsapp_error": req.whatsapp_error,
        "totals": {
            "original_cost": req.original_total_cost, "original_minutes": req.original_total_minutes,
            "approved_cost": req.approved_total_cost, "approved_minutes": req.approved_total_minutes,
            "service_cost_total": getattr(req, "estimated_service_cost_total", 0.0),
            "labour_cost_total": getattr(req, "estimated_labour_cost_total", 0.0),
            "final_estimated_cost": req.approved_total_cost,
        },
        "missing_cost_count": len(missing_cost_items(db, req)),
        "created_at": _iso(req.created_at), "sent_at": _iso(req.sent_at),
        "viewed_at": _iso(req.viewed_at), "submitted_at": _iso(req.submitted_at),
        "cancelled_at": _iso(req.cancelled_at), "expires_at": _iso(req.expires_at),
        # ── Phase 2: versioning + link + retention (date-wise dashboard) ──
        "current_version_no": getattr(req, "current_version_no", 1),
        "version_count": _version_count(db, req.id),
        "editing": bool(getattr(req, "editing", False)),
        "superseded_count": getattr(req, "superseded_count", 0),
        "last_sent_at": _iso(getattr(req, "last_sent_at", None)),
        "last_viewed_at": _iso(getattr(req, "last_viewed_at", None)),
        "last_submitted_at": _iso(getattr(req, "last_submitted_at", None)),
        "retention_expires_at": _iso(getattr(req, "retention_expires_at", None)),
        "deleted_at": _iso(getattr(req, "deleted_at", None)),
        "active_link": _active_link_brief(db, req),
        "customer_response_status": _latest_response_status(db, req),
    }
    if with_items:
        out["items"] = [_item_dict(i) for i in items_for(db, req.id)]
    return out


# ════════════════════════════════════════════════════════════════════════════
#  Phase 2 — version snapshots, links, diff, history, retention
#  The public page serves the IMMUTABLE version snapshot; the customer's response
#  is frozen onto the version (version-safe history). Live items stay the admin
#  working set. At most ONE link per request is active at a time.
# ════════════════════════════════════════════════════════════════════════════
def retention_days() -> int:
    return int(getattr(settings, "customer_approval_retention_days", 14) or 14)


def _version_count(db, request_id: str) -> int:
    return len(db.scalars(select(CustomerApprovalVersion).where(
        CustomerApprovalVersion.approval_request_id == request_id)).all())


def versions_for(db, request_id: str) -> list[CustomerApprovalVersion]:
    return db.scalars(select(CustomerApprovalVersion).where(
        CustomerApprovalVersion.approval_request_id == request_id
    ).order_by(CustomerApprovalVersion.version_no.asc())).all()


def links_for(db, request_id: str) -> list[CustomerApprovalLink]:
    return db.scalars(select(CustomerApprovalLink).where(
        CustomerApprovalLink.approval_request_id == request_id
    ).order_by(CustomerApprovalLink.version_no.asc())).all()


def active_link(db, req: CustomerApprovalRequest) -> CustomerApprovalLink | None:
    return db.scalar(select(CustomerApprovalLink).where(
        CustomerApprovalLink.approval_request_id == req.id,
        CustomerApprovalLink.status.in_(("active", "viewed")),
    ).order_by(CustomerApprovalLink.version_no.desc()))


def current_version(db, req: CustomerApprovalRequest) -> CustomerApprovalVersion | None:
    return db.scalar(select(CustomerApprovalVersion).where(
        CustomerApprovalVersion.approval_request_id == req.id,
        CustomerApprovalVersion.version_no == getattr(req, "current_version_no", 1),
    ))


def link_by_token(db, raw: str) -> CustomerApprovalLink | None:
    return db.scalar(select(CustomerApprovalLink).where(
        CustomerApprovalLink.token_hash == hash_token(raw)))


def version_by_no(db, request_id: str, version_no: int) -> CustomerApprovalVersion | None:
    return db.scalar(select(CustomerApprovalVersion).where(
        CustomerApprovalVersion.approval_request_id == request_id,
        CustomerApprovalVersion.version_no == version_no))


def _active_link_brief(db, req: CustomerApprovalRequest) -> dict | None:
    lk = active_link(db, req)
    if not lk:
        return None
    return {"status": lk.status, "version_no": lk.version_no,
            "token_last4": lk.token_last4, "expires_at": _iso(lk.expires_at),
            "sent_at": _iso(lk.sent_at), "viewed_at": _iso(lk.viewed_at)}


def _latest_response_status(db, req: CustomerApprovalRequest) -> str | None:
    v = db.scalar(select(CustomerApprovalVersion).where(
        CustomerApprovalVersion.approval_request_id == req.id,
        CustomerApprovalVersion.response_status.isnot(None),
    ).order_by(CustomerApprovalVersion.version_no.desc()))
    return v.response_status if v else None


# ── snapshot (the immutable offer the customer sees) ─────────────────────────
def _snapshot_items(db, req: CustomerApprovalRequest) -> list[dict]:
    """A frozen copy of the current live items, with the customer's decision reset to the
    per-source default (originals approved, suggestions pending)."""
    out = []
    for it in items_for(db, req.id):
        d = _item_dict(it)
        d["customer_status"] = "approved" if it.source == SOURCE_ORIGINAL else "pending"
        d["final_included"] = (it.source == SOURCE_ORIGINAL)
        out.append(d)
    return out


def _customer_snapshot(req: CustomerApprovalRequest) -> dict:
    return {"customer_name": req.customer_name, "customer_mobile": req.customer_mobile,
            "customer_email": req.customer_email, "complaint": req.complaint,
            "job_card_number": req.job_card_number, "service_type": req.service_type,
            "showroom": json.loads(req.showroom_json) if req.showroom_json else None}


def _vehicle_snapshot(req: CustomerApprovalRequest) -> dict:
    return {"vehicle_number": req.vehicle_number, "vehicle_model": req.vehicle_model}


def customer_form_blocks(req: CustomerApprovalRequest, job=None) -> dict:
    """The job-card-style header blocks the customer page renders. All values come from the
    request snapshot + the linked JobCard — anything not stored in the DB stays None (the UI
    shows "—", never a fabricated value). Customer-safe: no internal ids / token."""
    sr = json.loads(req.showroom_json) if req.showroom_json else {}

    def jg(attr):
        return getattr(job, attr, None) if job is not None else None

    return {
        "dealer": {
            "name": sr.get("name"), "address": sr.get("address"),
            "phone": sr.get("phone"), "email": None, "advisor": sr.get("advisor"),
        },
        "vehicle": {
            "model": req.vehicle_model or jg("vehicle_model"),
            "registration": req.vehicle_number or jg("vehicle_number"),
            "chassis_number": jg("chassis_number"), "engine_number": jg("engine_number"),
            "km_reading": jg("km_reading"), "date_of_sale": None,
        },
        "customer": {
            "name": req.customer_name, "contact": req.customer_mobile,
            "email": req.customer_email or jg("customer_email"),
            "address": jg("customer_address"), "customer_ref": None,
        },
        "service": {
            "job_card_number": req.job_card_number,
            "repair_type": jg("repair_type") or req.service_type,
            "service_type": req.service_type,
            "datetime_in": _iso(jg("created_at")) or _iso(req.created_at),
            "est_delivery": None,
            "service_advisor": sr.get("advisor"), "sa_contact": None,
            "date": _iso(jg("created_at")) or _iso(req.created_at),
        },
        "voice": req.complaint or jg("complaint"),
    }


def _snapshot_totals(snapshot_items: list[dict], decisions: dict) -> dict:
    """Mirror recalc() on the snapshot dicts (NOT live rows) — backend-authoritative."""
    def _st(it):
        return decisions.get(it["id"], it.get("customer_status"))
    incl = [it for it in snapshot_items if included_for(it["source"], _st(it))]
    service = round(sum((it.get("service_cost") or 0) for it in incl), 2)
    labour = round(sum((it.get("labour_cost") or 0) for it in incl), 2)
    final = round(sum((it.get("amount") or 0) for it in incl), 2)
    miss = [it for it in incl if it.get("has_missing_cost")]
    removed = round(sum((it.get("amount") or 0) for it in snapshot_items
                        if it["source"] == SOURCE_ORIGINAL and _st(it) == "removed"), 2)
    added = round(sum((it.get("amount") or 0) for it in snapshot_items
                      if it["source"] == SOURCE_SUGGESTION and _st(it) == "added"), 2)
    return {"service_cost_total": service, "labour_cost_total": labour,
            "approved_cost": final, "final_estimated_cost": final,
            "removed_cost": removed, "suggested_added_cost": added,
            "approved_count": len(incl), "missing_cost_count": len(miss),
            "approved_minutes": int(sum(it.get("estimated_minutes") or 0 for it in incl))}


def _default_decisions(snapshot_items: list[dict]) -> dict:
    return {it["id"]: ("approved" if it["source"] == SOURCE_ORIGINAL else "pending")
            for it in snapshot_items}


def create_version(db, req: CustomerApprovalRequest, admin, version_no: int,
                   status: str = "sent") -> CustomerApprovalVersion:
    """Snapshot the current live items into a new IMMUTABLE version."""
    items = _snapshot_items(db, req)
    decisions = _default_decisions(items)
    totals = _snapshot_totals(items, decisions)
    cust, veh = _customer_snapshot(req), _vehicle_snapshot(req)
    from ..models.job import JobCard
    job = db.get(JobCard, req.job_card_id) if req.job_card_id else None
    form = customer_form_blocks(req, job)        # job-card header blocks for the cloned UI
    now = _now()
    v = CustomerApprovalVersion(
        approval_request_id=req.id, version_no=version_no, status=status,
        item_snapshot_json=json.dumps(items),
        customer_snapshot_json=json.dumps(cust), vehicle_snapshot_json=json.dumps(veh),
        snapshot_json=json.dumps({"customer": cust, "vehicle": veh, "items": items, "totals": totals, "form": form}),
        customer_response_json=json.dumps({"decisions": decisions}),
        estimated_service_cost_total=totals["service_cost_total"],
        estimated_labour_cost_total=totals["labour_cost_total"],
        estimated_total_cost=totals["final_estimated_cost"],
        item_count=len(items), missing_cost_count=totals["missing_cost_count"],
        created_by_admin_id=getattr(admin, "id", None),
        created_by_admin_name=getattr(admin, "name", None),
        previewed_at=getattr(req, "previewed_at", None), sent_at=now,
    )
    db.add(v)
    db.flush()
    return v


def supersede_active(db, req: CustomerApprovalRequest) -> CustomerApprovalVersion | None:
    """Mark the current active link + its version superseded (used on resend). Returns the
    previous version (for the change diff). A SUBMITTED link is left as-is (already terminal)."""
    now = _now()
    prev = current_version(db, req)
    lk = active_link(db, req)
    if lk:
        lk.status = "superseded"
        lk.superseded_at = now
    if prev and prev.status in ("sent", "viewed", "draft"):
        prev.status = "superseded"
        prev.superseded_at = now
    if lk or (prev and prev.status == "superseded"):
        req.superseded_count = (getattr(req, "superseded_count", 0) or 0) + (1 if lk else 0)
    return prev


def issue_link(db, req: CustomerApprovalRequest, version_no: int, raw: str,
               public_url: str | None = None) -> CustomerApprovalLink:
    now = _now()
    lk = CustomerApprovalLink(
        approval_request_id=req.id, version_no=version_no,
        token_hash=hash_token(raw), token_last4=raw[-4:], status="active",
        public_url=public_url, whatsapp_recipient=req.customer_mobile,
        sent_at=now, expires_at=now + timedelta(days=retention_days()),
    )
    db.add(lk)
    db.flush()
    return lk


def touch_retention(req: CustomerApprovalRequest) -> None:
    """(Re)set the 14-day date-wise dashboard horizon from the latest activity."""
    base = max([d for d in (req.created_at, getattr(req, "last_sent_at", None),
                            getattr(req, "last_submitted_at", None)) if d] or [_now()])
    req.retention_expires_at = base + timedelta(days=retention_days())


def diff_versions(db, prev: CustomerApprovalVersion | None,
                  new: CustomerApprovalVersion) -> dict:
    """Change summary between two version snapshots: added/removed/changed parts + Δ total."""
    def _by_key(v):
        items = json.loads(v.item_snapshot_json or "[]") if v else []
        return {(it.get("product_code") or it.get("item_name")): it for it in items}
    pmap = _by_key(prev)
    nmap = _by_key(new)
    added = [nmap[k]["item_name"] for k in nmap if k not in pmap]
    removed = [pmap[k]["item_name"] for k in pmap if k not in nmap]
    changed = []
    for k in nmap:
        if k in pmap:
            o, n = pmap[k], nmap[k]
            fields = []
            for f, lbl in (("quantity", "qty"), ("service_cost", "service"),
                           ("labour_cost", "labour"), ("total_cost", "total")):
                if (o.get(f) or 0) != (n.get(f) or 0):
                    fields.append(f"{lbl} {o.get(f) or 0}→{n.get(f) or 0}")
            if fields:
                changed.append({"item_name": n["item_name"], "changes": fields})
    pt = (prev.estimated_total_cost if prev else 0.0) or 0.0
    nt = (new.estimated_total_cost or 0.0)
    return {"from_version": prev.version_no if prev else None, "to_version": new.version_no,
            "added": added, "removed": removed, "changed": changed,
            "old_total": round(pt, 2), "new_total": round(nt, 2),
            "difference": round(nt - pt, 2)}


# ── freezing the customer's response onto the version (version-safe) ─────────
def freeze_response(db, version: CustomerApprovalVersion, decisions: dict,
                    response_status: str, remarks: str | None) -> dict:
    items = json.loads(version.item_snapshot_json or "[]")
    totals = _snapshot_totals(items, decisions)
    rs = response_status if response_status in RESPONSE_STATUSES else "approved"
    payload = {"decisions": decisions, "totals": totals, "response_status": rs,
               "remarks": remarks, "frozen_at": _iso(_now())}
    version.customer_response_json = json.dumps({"decisions": decisions})
    version.response_payload_json = json.dumps(payload)
    version.response_status = rs
    version.customer_remarks = remarks
    version.status = rs
    version.submitted_at = _now()
    return totals


# ── public serialization off the version snapshot ───────────────────────────
def version_public_view(version: CustomerApprovalVersion, req: CustomerApprovalRequest,
                        decisions: dict | None = None) -> dict:
    """Customer-safe view built from the IMMUTABLE snapshot + the current decision map.
    No internal ids. This is what the public page renders for an active link, and the
    frozen record for a submitted link."""
    items = json.loads(version.item_snapshot_json or "[]")
    if decisions is None:
        resp = json.loads(version.customer_response_json or "{}")
        decisions = resp.get("decisions") or _default_decisions(items)
    for it in items:
        it["customer_status"] = decisions.get(it["id"], it.get("customer_status"))
        it["final_included"] = included_for(it["source"], it["customer_status"])
    totals = _snapshot_totals(items, decisions)
    cust = json.loads(version.customer_snapshot_json or "{}")
    veh = json.loads(version.vehicle_snapshot_json or "{}")
    snap = json.loads(version.snapshot_json or "{}")
    form = snap.get("form") or customer_form_blocks(req)   # fallback for pre-clone versions
    return {
        "approval_number": req.id, "version_no": version.version_no,
        "status": req.status, "version_status": version.status,
        "job_card_number": cust.get("job_card_number"),
        "customer_name": cust.get("customer_name"),
        "vehicle_number": veh.get("vehicle_number"), "vehicle_model": veh.get("vehicle_model"),
        "service_type": cust.get("service_type"), "complaint": cust.get("complaint"),
        "showroom": cust.get("showroom"),
        "form": form,                                       # job-card header blocks (cloned UI)
        "customer_note": version.customer_remarks, "customer_remarks": version.customer_remarks,
        "response_status": version.response_status,
        "expires_at": None, "submitted_at": _iso(version.submitted_at),
        "locked": version.status in ("submitted", "approved", "rejected",
                                     "changes_requested", "superseded", "expired", "revoked"),
        "original_items": [it for it in items if it["source"] == SOURCE_ORIGINAL],
        "suggested_items": [it for it in items if it["source"] == SOURCE_SUGGESTION],
        "totals": totals,
    }


# ── version / link / event serializers (admin history) ──────────────────────
def version_serialize(v: CustomerApprovalVersion) -> dict:
    return {
        "version_no": v.version_no, "status": v.status,
        "service_cost_total": v.estimated_service_cost_total,
        "labour_cost_total": v.estimated_labour_cost_total,
        "estimated_total_cost": v.estimated_total_cost,
        "item_count": v.item_count, "missing_cost_count": v.missing_cost_count,
        "response_status": v.response_status, "customer_remarks": v.customer_remarks,
        "created_by_admin_name": v.created_by_admin_name,
        "created_at": _iso(v.created_at), "sent_at": _iso(v.sent_at),
        "viewed_at": _iso(v.viewed_at), "submitted_at": _iso(v.submitted_at),
        "superseded_at": _iso(v.superseded_at), "expired_at": _iso(v.expired_at),
        "revoked_at": _iso(v.revoked_at),
        "items": json.loads(v.item_snapshot_json or "[]"),
    }


def link_serialize(lk: CustomerApprovalLink) -> dict:
    return {
        "version_no": lk.version_no, "status": lk.status, "token_last4": lk.token_last4,
        "sent_at": _iso(lk.sent_at), "viewed_at": _iso(lk.viewed_at),
        "submitted_at": _iso(lk.submitted_at), "expires_at": _iso(lk.expires_at),
        "used_at": _iso(lk.used_at), "revoked_at": _iso(lk.revoked_at),
        "superseded_at": _iso(lk.superseded_at),
    }


def event_serialize(e: CustomerApprovalEvent) -> dict:
    return {
        "event_type": e.event_type, "actor_type": e.actor_type, "actor_name": e.actor_name,
        "version_no": e.version_no, "message": e.message,
        "meta": json.loads(e.metadata_json) if e.metadata_json else None,
        "created_at": _iso(e.created_at),
    }


def history(db, req: CustomerApprovalRequest) -> dict:
    evs = db.scalars(select(CustomerApprovalEvent).where(
        CustomerApprovalEvent.approval_request_id == req.id
    ).order_by(CustomerApprovalEvent.created_at.asc())).all()
    vers = versions_for(db, req.id)
    return {
        "approval_id": req.id, "current_version_no": getattr(req, "current_version_no", 1),
        "versions": [version_serialize(v) for v in vers],
        "links": [link_serialize(l) for l in links_for(db, req.id)],
        "events": [event_serialize(e) for e in evs],
    }


# ── retention cleanup (date-wise temporary history) ─────────────────────────
def cleanup_expired(db, now: datetime | None = None) -> dict:
    """Idempotent: soft-expire links/versions/requests past their 14-day horizon. NEVER
    deletes core business data (job cards, sessions, work completion, invoices)."""
    now = now or _now()
    expired_links = expired_reqs = 0
    # expire active links that have passed their TTL
    for lk in db.scalars(select(CustomerApprovalLink).where(
            CustomerApprovalLink.status.in_(("active", "viewed")),
            CustomerApprovalLink.expires_at.isnot(None),
            CustomerApprovalLink.expires_at < now)).all():
        lk.status = "expired"
        lk.expired_at = now
        expired_links += 1
        v = version_by_no(db, lk.approval_request_id, lk.version_no)
        if v and v.status in ("sent", "viewed", "draft"):
            v.status = "expired"
            v.expired_at = now
    # soft-hide approval requests past the retention horizon (date-wise dashboard window)
    for req in db.scalars(select(CustomerApprovalRequest).where(
            CustomerApprovalRequest.deleted_at.is_(None),
            CustomerApprovalRequest.retention_expires_at.isnot(None),
            CustomerApprovalRequest.retention_expires_at < now)).all():
        req.deleted_at = now
        if req.status in ("sent", "viewed", "draft"):
            req.status = "expired"
        event(db, req.id, "system", "retention_expired",
              "Temporary approval record hidden after retention window")
        expired_reqs += 1
    if expired_links or expired_reqs:
        db.commit()
    return {"expired_links": expired_links, "expired_requests": expired_reqs}


def public_serialize(db, req: CustomerApprovalRequest) -> dict:
    """Customer-safe view — NO internal ids (branch/queue/job-card/users), no token."""
    items = items_for(db, req.id)
    totals = recalc(db, req)
    return {
        "approval_number": req.id, "status": req.status,
        "job_card_number": req.job_card_number,
        "customer_name": req.customer_name, "vehicle_number": req.vehicle_number,
        "vehicle_model": req.vehicle_model, "service_type": req.service_type,
        "complaint": req.complaint,
        "showroom": json.loads(req.showroom_json) if req.showroom_json else None,
        "customer_note": req.customer_note,
        "expires_at": _iso(req.expires_at), "submitted_at": _iso(req.submitted_at),
        "locked": req.status in ("submitted", "expired", "cancelled"),
        "original_items": [_item_dict(i) for i in items if i.source == SOURCE_ORIGINAL],
        "suggested_items": [_item_dict(i) for i in items if i.source == SOURCE_SUGGESTION],
        "totals": totals,
    }
