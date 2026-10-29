"""Customer Estimate Approval — PUBLIC plane (no auth, token-gated).

Mounted at /customer-approval (NOT under /api/v1). The customer only ever sees
/customer-approval/{token}; the opaque token resolves to ONE link → ONE immutable version
server-side, so no internal ids (branch/queue/job-card/admin) are ever exposed.

Phase 2 lifecycle (the locked rule):
  • the page always serves the IMMUTABLE version snapshot (never mutable live data);
  • a customer SUBMIT immediately marks the link submitted/used — no second submit;
  • a superseded / revoked / expired link is rejected with a clear message;
  • the customer's response is frozen onto the version (version-safe history).
"""
import json
from datetime import timedelta
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException, status
from fastapi.responses import FileResponse, HTMLResponse
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..database import get_db
from ..models.customer_approval import (
    CustomerApprovalRequest, CustomerApprovalLink, SOURCE_ORIGINAL,
)
from ..utils import approval as A
from ..utils.audit import log_action

router = APIRouter()

_PAGE = Path(__file__).resolve().parents[3] / "frontend" / "customer-approval" / "index.html"
_FALLBACK = ("<!doctype html><meta charset=utf-8><title>Customer Approval</title>"
             "<body style='font:16px system-ui;display:grid;place-items:center;height:100vh;margin:0'>"
             "<p>Loading your approval form…</p></body>")


# ── token → (link, request, version) ─────────────────────────────────────────
def _backfill_legacy(db: Session, req: CustomerApprovalRequest, token: str):
    """Lazily migrate an in-flight Phase-1 link (request.token_hash, no link row) into a
    Phase-2 version+link the first time it is opened — so there is a single code path."""
    v = A.create_version(db, req, None, 1,
                         status="viewed" if req.status == "viewed" else "sent")
    now = A._now()
    lk = CustomerApprovalLink(
        approval_request_id=req.id, version_no=1, token_hash=A.hash_token(token),
        token_last4=token[-4:], status=("viewed" if req.status == "viewed" else "active"),
        whatsapp_recipient=req.customer_mobile, sent_at=req.sent_at or now,
        expires_at=req.expires_at or (now + timedelta(days=A.retention_days())),
    )
    db.add(lk)
    db.flush()
    req.current_version_no = 1
    req.active_link_id = lk.id
    db.commit()
    return lk, v


def _resolve(db: Session, token: str):
    """Resolve a raw token to (link, request, version). Raises 404 if unknown. Applies lazy
    TTL expiry to an active link."""
    lk = A.link_by_token(db, token)
    if not lk:
        req = db.scalar(select(CustomerApprovalRequest).where(
            CustomerApprovalRequest.token_hash == A.hash_token(token)))
        if not req:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Invalid or unknown link")
        lk, v = _backfill_legacy(db, req, token)
        return lk, req, v
    req = db.get(CustomerApprovalRequest, lk.approval_request_id)
    v = A.version_by_no(db, lk.approval_request_id, lk.version_no)
    if lk.status in ("active", "viewed") and lk.expires_at and A._now() > lk.expires_at:
        now = A._now()
        lk.status = "expired"
        lk.expired_at = now
        if v and v.status in ("sent", "viewed"):
            v.status = "expired"
            v.expired_at = now
        if req and req.status in ("sent", "viewed"):
            req.status = "expired"
        A.event(db, req.id, "system", "token_expired", "Link expired (TTL)", version_no=lk.version_no)
        db.commit()
    return lk, req, v


# clear, customer-safe rejection messages by link state
_LINK_REJECT = {
    "superseded": (409, "This estimate was replaced by a newer estimate. Please open the latest link."),
    "revoked": (409, "This link was revoked by the service centre. Please contact us for a new link."),
    "expired": (409, "This approval link has expired. Please contact your service centre for a new link."),
}


def _reject_if_dead(lk: CustomerApprovalLink) -> None:
    if lk and lk.status in _LINK_REJECT:
        code, msg = _LINK_REJECT[lk.status]
        raise HTTPException(code, msg)


def _assert_actionable(lk, req, v) -> None:
    """The customer may act/submit only on an ACTIVE current-version link, and not while the
    admin is updating the estimate."""
    if getattr(req, "editing", False):
        raise HTTPException(status.HTTP_409_CONFLICT,
                            "The service centre is updating this estimate. Please wait for the new link.")
    _reject_if_dead(lk)
    if not lk or lk.status not in ("active", "viewed"):
        raise HTTPException(status.HTTP_409_CONFLICT,
                            "This estimate has already been submitted and can no longer be changed.")
    if not v or v.status not in ("sent", "viewed"):
        raise HTTPException(status.HTTP_409_CONFLICT, "This estimate is no longer active.")


def _decisions_of(v) -> dict:
    resp = json.loads(v.customer_response_json or "{}")
    return resp.get("decisions") or A._default_decisions(json.loads(v.item_snapshot_json or "[]"))


# ── customer data (the page fetches this) ──────────────────────────────────
@router.get("/{token}/data")
def data(token: str, db: Session = Depends(get_db)):
    lk, req, v = _resolve(db, token)
    _reject_if_dead(lk)
    if not v:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Invalid or unknown link")
    # submitted/used → read-only Thank-You snapshot (no second submit)
    if lk and lk.status in ("submitted", "used"):
        view = A.version_public_view(v, req)
        view["read_only"] = True
        view["submitted_at"] = A._iso(lk.submitted_at)
        return {"success": True, "data": view, "message": ""}
    # active → first open marks viewed
    now = A._now()
    if lk and lk.status == "active":
        lk.status = "viewed"
        lk.viewed_at = now
        if v.status == "sent":
            v.status = "viewed"
            v.viewed_at = now
        if req.status == "sent":
            req.status = "viewed"
            req.viewed_at = now
        req.last_viewed_at = now
        A.event(db, req.id, "customer", "customer_viewed", "Customer opened the link",
                version_no=v.version_no)
        db.commit()
    view = A.version_public_view(v, req)
    view["expires_at"] = A._iso(lk.expires_at) if lk else None
    return {"success": True, "data": view, "message": ""}


class ItemAction(BaseModel):
    item_id: str
    action: str          # remove | undo | accept | reject


@router.post("/{token}/item-action")
def item_action(token: str, body: ItemAction, db: Session = Depends(get_db)):
    lk, req, v = _resolve(db, token)
    _assert_actionable(lk, req, v)
    items = {it["id"]: it for it in json.loads(v.item_snapshot_json or "[]")}
    it = items.get(body.item_id)
    if not it:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Item not found")
    decisions = _decisions_of(v)
    act = body.action
    if it["source"] == SOURCE_ORIGINAL:
        if act == "remove":
            decisions[body.item_id] = "removed"; ev = "item_removed"
        elif act == "undo":
            decisions[body.item_id] = "approved"; ev = "item_undo"
        else:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "Use remove/undo on original items.")
    else:
        if act == "accept":
            decisions[body.item_id] = "added"; ev = "suggestion_added"
        elif act == "reject":
            decisions[body.item_id] = "rejected"; ev = "suggestion_rejected"
        elif act == "undo":
            decisions[body.item_id] = "pending"; ev = "item_undo"
        else:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "Use accept/reject/undo on suggestions.")
    v.customer_response_json = json.dumps({"decisions": decisions})
    A.event(db, req.id, "customer", ev, it["item_name"], version_no=v.version_no)
    db.commit()
    return {"success": True, "data": A.version_public_view(v, req, decisions), "message": "Updated"}


class Submit(BaseModel):
    customer_note: str | None = None
    customer_remarks: str | None = None
    response_status: str | None = None      # approved | rejected | changes_requested
    decisions: dict[str, str] | None = None  # batch item decisions from the cloned form (one shot)


@router.post("/{token}/submit")
def submit(token: str, body: Submit, db: Session = Depends(get_db)):
    lk, req, v = _resolve(db, token)
    _assert_actionable(lk, req, v)
    decisions = _decisions_of(v)
    # The cloned customer page keeps Add/Remove local and submits the final decision set once.
    # Merge it in (only for ids that exist in this version's immutable snapshot), backend-authoritative.
    if body.decisions:
        valid_ids = {it["id"] for it in json.loads(v.item_snapshot_json or "[]")}
        allowed = {"approved", "removed", "added", "rejected", "pending"}
        for iid, st in body.decisions.items():
            if iid in valid_ids and st in allowed:
                decisions[iid] = st
    remarks = (body.customer_remarks or body.customer_note or "").strip() or None
    rs = body.response_status if body.response_status in ("approved", "rejected", "changes_requested") else "approved"
    # freeze the customer's response onto the IMMUTABLE version (version-safe history)
    totals = A.freeze_response(db, v, decisions, rs, remarks)
    now = A._now()
    # SUBMIT EXPIRES THE LINK — used immediately, no second submit
    if lk:
        lk.status = "submitted"
        lk.submitted_at = now
        lk.used_at = now
    req.status = rs
    req.submitted_at = now
    req.last_submitted_at = now
    req.customer_note = remarks
    req.approved_total_cost = totals["final_estimated_cost"]
    req.approved_total_minutes = totals.get("approved_minutes", 0)
    req.editing = False
    A.touch_retention(req)
    A.event(db, req.id, "customer", "customer_submitted", "Customer submitted the approval",
            {"response": rs, "approved_cost": totals["final_estimated_cost"]}, version_no=v.version_no)
    A.event(db, req.id, "customer", rs, f"Customer {rs.replace('_', ' ')}",
            {"approved_cost": totals["final_estimated_cost"]}, version_no=v.version_no)
    log_action(db, "APPROVAL_SUBMITTED", "customer_approval", req.id, None,
               new={"response": rs, "approved_cost": totals["final_estimated_cost"],
                    "version": v.version_no})
    db.commit()
    view = A.version_public_view(v, req)
    view["read_only"] = True
    view["submitted_at"] = A._iso(now)
    return {"success": True, "data": view, "message": "Approval submitted"}


# ── admin preview: same page, fed by postMessage (NO token, NO data fetch, NO submit) ──
# Defined BEFORE /{token} so "preview" is never treated as a token.
@router.get("/preview", response_class=HTMLResponse)
def preview_page():
    if _PAGE.exists():
        return FileResponse(str(_PAGE), media_type="text/html",
                            headers={"Cache-Control": "no-store"})
    return HTMLResponse(_FALLBACK)


# ── the standalone customer page (LAST so it never shadows the routes above) ──
@router.get("/{token}", response_class=HTMLResponse)
def page(token: str):
    if _PAGE.exists():
        return FileResponse(str(_PAGE), media_type="text/html",
                            headers={"Cache-Control": "no-store"})
    return HTMLResponse(_FALLBACK)
