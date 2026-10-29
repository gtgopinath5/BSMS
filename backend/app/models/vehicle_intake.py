"""Worker Jobcard Entry / Vehicle Intake Evidence (Phase B — backend foundation).

Before a service starts the worker records the bike's arrival condition and the customer's
complaint as PROOF: customer + vehicle details, bike-condition photos, a complaint
description, and complaint voice notes. The whole app then follows the same NORMALIZED
bike registration number (the matching key) everywhere.

Photos/voice are TEMPORARY evidence (PII + media): the binaries live on disk, only metadata
lives here, and media auto-expires after 14 days. Tables are auto-created by ``init_db()``
``create_all`` (idempotent). ADDITIVE ONLY — no existing schema is rewritten; an intake links
to a JobCard / queue / assignment via nullable columns, never breaking ``job_id`` workflows.
"""
from datetime import datetime

from sqlalchemy import String, Text, Integer, DateTime, ForeignKey
from sqlalchemy.orm import Mapped, mapped_column

from ..database import Base
from .base import TimestampMixin, naive_utcnow
from .ids_default import uuid_pk

# Lifecycle strings (adding one needs no migration).
#   draft     — worker is still filling it in (media editable/deletable)
#   submitted — finalised by the worker; LOCKED (media frozen, expiry counting)
#   linked    — an admin linked it to a job/job-card/assignment
#   archived  — all of its temporary media has expired/been purged
#   revoked   — withdrawn
ENTRY_STATUSES = ("draft", "submitted", "linked", "archived", "revoked")
MEDIA_TYPES = ("image", "audio")
MEDIA_STATUSES = ("active", "revoked", "deleted", "expired")
ACTOR_TYPES = ("worker", "admin", "master", "system")


class VehicleIntakeEntry(Base, TimestampMixin):
    __tablename__ = "vehicle_intake_entries"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uuid_pk)
    intake_no: Mapped[str] = mapped_column(String(24), unique=True)              # VIE-2026-000001
    branch_id: Mapped[str | None] = mapped_column(ForeignKey("branches.id"), default=None, index=True)
    worker_id: Mapped[str | None] = mapped_column(ForeignKey("users.id"), default=None, index=True)
    worker_name: Mapped[str | None] = mapped_column(default=None)

    # The matching key. ``raw`` is what the worker typed; ``normalized`` is the
    # uppercase, alphanumeric-only form used for ALL matching (PY 05 XX-0000 → PY05XX0000).
    bike_number_raw: Mapped[str | None] = mapped_column(default=None)
    bike_number_normalized: Mapped[str | None] = mapped_column(String(32), default=None, index=True)

    # customer
    customer_name: Mapped[str | None] = mapped_column(default=None)
    phone_number: Mapped[str | None] = mapped_column(default=None)
    whatsapp_number: Mapped[str | None] = mapped_column(default=None)
    email: Mapped[str | None] = mapped_column(default=None)
    address: Mapped[str | None] = mapped_column(Text, default=None)
    # vehicle
    engine_number: Mapped[str | None] = mapped_column(default=None)
    chassis_number: Mapped[str | None] = mapped_column(default=None)
    # complaint
    complaint_description: Mapped[str | None] = mapped_column(Text, default=None)

    status: Mapped[str] = mapped_column(String(16), default="draft", index=True)

    # additive links (plain strings, NOT FKs — never constrains/breaks core deletes)
    linked_job_id: Mapped[str | None] = mapped_column(String(36), default=None, index=True)
    linked_job_card_id: Mapped[str | None] = mapped_column(String(36), default=None, index=True)
    linked_assignment_id: Mapped[str | None] = mapped_column(String(36), default=None)
    linked_by_admin_id: Mapped[str | None] = mapped_column(default=None)
    linked_by_admin_name: Mapped[str | None] = mapped_column(default=None)
    linked_at: Mapped[datetime | None] = mapped_column(DateTime, default=None)

    submitted_at: Mapped[datetime | None] = mapped_column(DateTime, default=None, index=True)
    updated_at: Mapped[datetime | None] = mapped_column(DateTime, default=None, onupdate=naive_utcnow)
    expires_at: Mapped[datetime | None] = mapped_column(DateTime, default=None)
    deleted_at: Mapped[datetime | None] = mapped_column(DateTime, default=None)


class VehicleIntakeMedia(Base, TimestampMixin):
    __tablename__ = "vehicle_intake_media"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uuid_pk)
    intake_entry_id: Mapped[str] = mapped_column(ForeignKey("vehicle_intake_entries.id"), index=True)
    branch_id: Mapped[str | None] = mapped_column(default=None, index=True)
    bike_number_normalized: Mapped[str | None] = mapped_column(String(32), default=None, index=True)

    media_type: Mapped[str] = mapped_column(String(8))                          # image | audio
    # STORAGE KEY only (relative to the media root) — a raw absolute path is NEVER stored here
    # and NEVER returned by any API; access is exclusively through token-gated routes.
    file_path: Mapped[str | None] = mapped_column(String(512), default=None)
    thumbnail_path: Mapped[str | None] = mapped_column(String(512), default=None)
    mime_type: Mapped[str | None] = mapped_column(default=None)
    original_filename: Mapped[str | None] = mapped_column(default=None)
    size_bytes: Mapped[int | None] = mapped_column(Integer, default=None)
    duration_seconds: Mapped[int | None] = mapped_column(Integer, default=None)
    caption: Mapped[str | None] = mapped_column(Text, default=None)

    uploaded_by_worker_id: Mapped[str | None] = mapped_column(default=None)
    uploaded_by_worker_name: Mapped[str | None] = mapped_column(default=None)

    status: Mapped[str] = mapped_column(String(16), default="active", index=True)
    revoked_at: Mapped[datetime | None] = mapped_column(DateTime, default=None)
    revoked_by_id: Mapped[str | None] = mapped_column(default=None)
    revoked_by_name: Mapped[str | None] = mapped_column(default=None)
    deleted_at: Mapped[datetime | None] = mapped_column(DateTime, default=None)
    expires_at: Mapped[datetime | None] = mapped_column(DateTime, default=None, index=True)


class VehicleIntakeEvent(Base, TimestampMixin):
    __tablename__ = "vehicle_intake_events"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uuid_pk)
    intake_entry_id: Mapped[str | None] = mapped_column(
        ForeignKey("vehicle_intake_entries.id"), default=None, index=True)
    actor_type: Mapped[str | None] = mapped_column(String(12), default=None)    # worker|admin|master|system
    actor_id: Mapped[str | None] = mapped_column(default=None)
    actor_name: Mapped[str | None] = mapped_column(default=None)
    event_type: Mapped[str | None] = mapped_column(String(40), default=None)
    message: Mapped[str | None] = mapped_column(Text, default=None)
    metadata_json: Mapped[str | None] = mapped_column(Text, default=None)
