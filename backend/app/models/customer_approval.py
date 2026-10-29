"""Customer Estimate Approval — a temporary, login-less customer form for reviewing the
estimate (parts + labour + admin suggestions) before work starts.

Flow: a queued job → an admin approval DRAFT (original items seeded from the job card's
extracted `services`, admin may add SUGGESTED items) → a secure temporary link → the
customer approves/removes originals + accepts/rejects suggestions → SUBMIT locks it →
the admin sees the revised approved estimate; the queue shows the approval status.

Security mirrors Customer Live Watch: the raw token is shown ONCE in the generate
response and never stored — only sha256(token) is kept, so a DB leak never exposes a
live link. The customer only ever sees /customer-approval/{token}.

Auto-created by ``init_db()`` ``create_all`` (idempotent) — no migration needed.
"""
from datetime import datetime
from sqlalchemy import String, Text, Float, Integer, Boolean, DateTime, ForeignKey
from sqlalchemy.orm import Mapped, mapped_column
from ..database import Base
from .base import TimestampMixin
from .ids_default import uuid_pk


# Request lifecycle (plain strings — adding one needs no migration).
#   draft     — created from a queue job; admin editing, no link sent yet
#   sent      — link issued + shared (WhatsApp/copy)
#   viewed    — customer opened the link
#   submitted — customer submitted; LOCKED (terminal for editing)
#   approved | rejected | changes_requested — customer's submit response (Phase 2)
#   expired   — past TTL / retention (terminal)
#   cancelled — admin cancelled (terminal)
REQUEST_STATUSES = ("draft", "sent", "viewed", "submitted", "approved", "rejected",
                    "changes_requested", "expired", "cancelled")
# An estimate the customer has already responded to / that is terminal for the CURRENT link.
# Edit & Resend (Phase 2) re-opens it as a NEW version, so it is NOT the same as "uneditable".
LOCKED_STATUSES = ("submitted", "approved", "rejected", "changes_requested", "expired", "cancelled")
RESPONSE_STATUSES = ("approved", "rejected", "changes_requested")

# Phase-2 version statuses (immutable snapshot lifecycle).
VERSION_STATUSES = ("draft", "sent", "viewed", "submitted", "approved", "rejected",
                    "changes_requested", "superseded", "expired", "revoked")
# Phase-2 link statuses (one active link per request at a time).
LINK_STATUSES = ("active", "viewed", "submitted", "used", "superseded", "revoked", "expired")
LINK_DEAD = ("submitted", "used", "superseded", "revoked", "expired")

# Item source + customer action states.
SOURCE_ORIGINAL = "original"
SOURCE_SUGGESTION = "admin_suggestion"
# reason_type for suggestions: mandatory(red) | suggested(green) | upcoming(yellow); originals = none
REASON_TYPES = ("mandatory", "suggested", "upcoming", "none")
# customer_status: original → approved|removed ; suggestion → pending|added|rejected
CUSTOMER_STATUSES = ("approved", "removed", "pending", "added", "rejected")


class CustomerApprovalRequest(Base, TimestampMixin):
    __tablename__ = "customer_approval_requests"

    id: Mapped[str] = mapped_column(String(20), primary_key=True)            # CA-2026-000001
    branch_id: Mapped[str | None] = mapped_column(ForeignKey("branches.id"), default=None, index=True)
    queue_job_id: Mapped[str | None] = mapped_column(ForeignKey("job_queue.id"), default=None, index=True)
    job_card_id: Mapped[str] = mapped_column(ForeignKey("job_cards.id"), index=True)
    job_card_number: Mapped[str | None] = mapped_column(default=None)

    # snapshot of customer/vehicle data at draft time (the link is per-estimate)
    customer_name: Mapped[str | None] = mapped_column(default=None)
    customer_mobile: Mapped[str | None] = mapped_column(default=None)        # also the WhatsApp number
    customer_email: Mapped[str | None] = mapped_column(default=None)
    vehicle_number: Mapped[str | None] = mapped_column(default=None)
    vehicle_model: Mapped[str | None] = mapped_column(default=None)
    service_type: Mapped[str | None] = mapped_column(default=None)
    complaint: Mapped[str | None] = mapped_column(Text, default=None)
    showroom_json: Mapped[str | None] = mapped_column(Text, default=None)    # branch/showroom snapshot (JSON)

    status: Mapped[str] = mapped_column(String(20), default="draft", index=True)
    token_hash: Mapped[str | None] = mapped_column(String(64), unique=True, default=None)  # sha256(token) — legacy (Phase 1); links table is authoritative in Phase 2
    expires_at: Mapped[datetime | None] = mapped_column(DateTime, default=None)

    # ── Phase 2: versioning + links + date-wise retention ──
    current_version_no: Mapped[int] = mapped_column(Integer, default=1)
    active_link_id: Mapped[str | None] = mapped_column(default=None)         # id of the one active link (if any)
    editing: Mapped[bool] = mapped_column(Boolean, default=False)            # admin is in an Edit & Resend session
    last_sent_at: Mapped[datetime | None] = mapped_column(DateTime, default=None)
    last_viewed_at: Mapped[datetime | None] = mapped_column(DateTime, default=None)
    last_submitted_at: Mapped[datetime | None] = mapped_column(DateTime, default=None)
    retention_expires_at: Mapped[datetime | None] = mapped_column(DateTime, default=None, index=True)
    deleted_at: Mapped[datetime | None] = mapped_column(DateTime, default=None)  # soft-delete (retention)
    superseded_count: Mapped[int] = mapped_column(Integer, default=0)

    customer_note: Mapped[str | None] = mapped_column(Text, default=None)

    # totals (recomputed in the backend on submit — never trust the client)
    original_total_cost: Mapped[float] = mapped_column(Float, default=0.0)
    original_total_minutes: Mapped[int] = mapped_column(Integer, default=0)
    approved_total_cost: Mapped[float] = mapped_column(Float, default=0.0)
    approved_total_minutes: Mapped[int] = mapped_column(Integer, default=0)
    # dealership cost-detail totals (Phase 1) + preview gate
    estimated_service_cost_total: Mapped[float] = mapped_column(Float, default=0.0)
    estimated_labour_cost_total: Mapped[float] = mapped_column(Float, default=0.0)
    preview_confirmed: Mapped[bool] = mapped_column(Boolean, default=False)   # must preview before send
    previewed_at: Mapped[datetime | None] = mapped_column(DateTime, default=None)

    whatsapp_status: Mapped[str | None] = mapped_column(default=None)        # sent | failed | not_configured
    whatsapp_error: Mapped[str | None] = mapped_column(Text, default=None)
    whatsapp_sent_at: Mapped[datetime | None] = mapped_column(DateTime, default=None)
    whatsapp_message_id: Mapped[str | None] = mapped_column(default=None)

    created_by: Mapped[str | None] = mapped_column(ForeignKey("users.id"), default=None)
    sent_by: Mapped[str | None] = mapped_column(ForeignKey("users.id"), default=None)
    sent_at: Mapped[datetime | None] = mapped_column(DateTime, default=None)
    viewed_at: Mapped[datetime | None] = mapped_column(DateTime, default=None)
    submitted_at: Mapped[datetime | None] = mapped_column(DateTime, default=None)
    cancelled_at: Mapped[datetime | None] = mapped_column(DateTime, default=None)
    updated_at: Mapped[datetime | None] = mapped_column(DateTime, default=None)


class CustomerApprovalItem(Base, TimestampMixin):
    __tablename__ = "customer_approval_items"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uuid_pk)
    approval_request_id: Mapped[str] = mapped_column(ForeignKey("customer_approval_requests.id"), index=True)
    source: Mapped[str] = mapped_column(String(20), default=SOURCE_ORIGINAL)  # original | admin_suggestion
    reason_type: Mapped[str] = mapped_column(String(12), default="none")      # mandatory|suggested|upcoming|none

    item_name: Mapped[str] = mapped_column(default="")
    product_code: Mapped[str | None] = mapped_column(default=None)
    quantity: Mapped[float] = mapped_column(Float, default=1.0)
    unit_price: Mapped[float] = mapped_column(Float, default=0.0)
    estimated_minutes: Mapped[int] = mapped_column(Integer, default=0)
    amount: Mapped[float] = mapped_column(Float, default=0.0)                 # final row total (mirrors total_cost)
    # ── dealership cost breakdown (Phase 1) — extracted from the job-card PDF or filled by
    #    admin; backend recalc is authoritative. has_missing_cost flags an included row whose
    #    cost can't be determined (blocks sending until the admin fills it).
    unit_value: Mapped[float | None] = mapped_column(Float, default=None)
    service_cost: Mapped[float | None] = mapped_column(Float, default=None)
    labour_cost: Mapped[float | None] = mapped_column(Float, default=None)
    total_cost: Mapped[float | None] = mapped_column(Float, default=None)
    has_missing_cost: Mapped[bool] = mapped_column(Boolean, default=False)
    description: Mapped[str | None] = mapped_column(Text, default=None)       # admin reason / note
    admin_note: Mapped[str | None] = mapped_column(Text, default=None)

    # original → approved|removed ; admin_suggestion → pending|added|rejected
    customer_status: Mapped[str] = mapped_column(String(12), default="approved")
    final_included: Mapped[bool] = mapped_column(Boolean, default=True)       # counted in the final estimate
    sort_order: Mapped[int] = mapped_column(Integer, default=0)
    updated_at: Mapped[datetime | None] = mapped_column(DateTime, default=None)


class CustomerApprovalEvent(Base, TimestampMixin):
    __tablename__ = "customer_approval_audit_events"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uuid_pk)
    approval_request_id: Mapped[str] = mapped_column(ForeignKey("customer_approval_requests.id"), index=True)
    actor_type: Mapped[str] = mapped_column(String(16), default="system")     # admin|master_admin|customer|system
    actor_name: Mapped[str | None] = mapped_column(default=None)              # Phase 2: who (display)
    version_no: Mapped[int | None] = mapped_column(Integer, default=None)     # Phase 2: which version
    event_type: Mapped[str] = mapped_column(String(32))                       # created|link_generated|sent_whatsapp|version_created|…
    message: Mapped[str | None] = mapped_column(Text, default=None)
    metadata_json: Mapped[str | None] = mapped_column(Text, default=None)


class CustomerApprovalVersion(Base, TimestampMixin):
    """Phase 2 — an IMMUTABLE snapshot of the estimate as it was sent to the customer.
    The item/cost snapshot never changes after send; only the lifecycle status, timestamps,
    and the customer's response fields are filled in later. The public page always serves
    this snapshot, so a token never points at mutable live data."""
    __tablename__ = "customer_approval_versions"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uuid_pk)
    approval_request_id: Mapped[str] = mapped_column(ForeignKey("customer_approval_requests.id"), index=True)
    version_no: Mapped[int] = mapped_column(Integer, default=1, index=True)
    status: Mapped[str] = mapped_column(String(20), default="sent", index=True)  # VERSION_STATUSES

    # immutable snapshot of exactly what the customer saw
    snapshot_json: Mapped[str | None] = mapped_column(Text, default=None)        # full combined snapshot
    item_snapshot_json: Mapped[str | None] = mapped_column(Text, default=None)   # the offered items (name/qty/costs)
    customer_snapshot_json: Mapped[str | None] = mapped_column(Text, default=None)
    vehicle_snapshot_json: Mapped[str | None] = mapped_column(Text, default=None)

    estimated_service_cost_total: Mapped[float] = mapped_column(Float, default=0.0)
    estimated_labour_cost_total: Mapped[float] = mapped_column(Float, default=0.0)
    estimated_total_cost: Mapped[float] = mapped_column(Float, default=0.0)
    item_count: Mapped[int] = mapped_column(Integer, default=0)
    missing_cost_count: Mapped[int] = mapped_column(Integer, default=0)

    # the customer's response, frozen onto the version at submit (version-safe history)
    customer_response_json: Mapped[str | None] = mapped_column(Text, default=None)  # per-item decisions + totals
    customer_remarks: Mapped[str | None] = mapped_column(Text, default=None)
    response_status: Mapped[str | None] = mapped_column(String(20), default=None)   # approved|rejected|changes_requested
    response_payload_json: Mapped[str | None] = mapped_column(Text, default=None)

    created_by_admin_id: Mapped[str | None] = mapped_column(default=None)
    created_by_admin_name: Mapped[str | None] = mapped_column(default=None)
    previewed_at: Mapped[datetime | None] = mapped_column(DateTime, default=None)
    sent_at: Mapped[datetime | None] = mapped_column(DateTime, default=None)
    viewed_at: Mapped[datetime | None] = mapped_column(DateTime, default=None)
    submitted_at: Mapped[datetime | None] = mapped_column(DateTime, default=None)
    superseded_at: Mapped[datetime | None] = mapped_column(DateTime, default=None)
    expired_at: Mapped[datetime | None] = mapped_column(DateTime, default=None)
    revoked_at: Mapped[datetime | None] = mapped_column(DateTime, default=None)


class CustomerApprovalLink(Base, TimestampMixin):
    """Phase 2 — one secure public token per version. At most ONE link per request is
    ``active`` at a time; a customer SUBMIT immediately marks it submitted/used, a resend
    supersedes it, and an admin revoke kills it. Only sha256(token) is stored."""
    __tablename__ = "customer_approval_links"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uuid_pk)
    approval_request_id: Mapped[str] = mapped_column(ForeignKey("customer_approval_requests.id"), index=True)
    version_no: Mapped[int] = mapped_column(Integer, default=1)
    token_hash: Mapped[str | None] = mapped_column(String(64), unique=True, default=None, index=True)
    token_last4: Mapped[str | None] = mapped_column(String(8), default=None)
    status: Mapped[str] = mapped_column(String(16), default="active", index=True)  # LINK_STATUSES
    public_url: Mapped[str | None] = mapped_column(Text, default=None)             # never the raw token
    whatsapp_recipient: Mapped[str | None] = mapped_column(default=None)

    sent_at: Mapped[datetime | None] = mapped_column(DateTime, default=None)
    viewed_at: Mapped[datetime | None] = mapped_column(DateTime, default=None)
    submitted_at: Mapped[datetime | None] = mapped_column(DateTime, default=None)
    expires_at: Mapped[datetime | None] = mapped_column(DateTime, default=None, index=True)
    used_at: Mapped[datetime | None] = mapped_column(DateTime, default=None)
    revoked_at: Mapped[datetime | None] = mapped_column(DateTime, default=None)
    superseded_at: Mapped[datetime | None] = mapped_column(DateTime, default=None)
    expired_at: Mapped[datetime | None] = mapped_column(DateTime, default=None)
