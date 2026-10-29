"""Worker Bay-to-Bay Time Analysis — the ONE additive table for this feature.

The analytics themselves are DERIVED live from ``ServiceSession`` rows (assigned/started/completed
timestamps, bay, estimate/actual, and the pinned pause truth in ``utils/completion.py``) — this table
stores ONLY the admin/master-entered **delay reason** for a specific bay-to-bay transition, so the
job lifecycle is never duplicated or modified. A transition is identified by the two sessions it
bridges: ``prev_session_id`` (the job that finished) → ``next_session_id`` (the job that started).
"""
from datetime import datetime

from sqlalchemy import String, Text, Integer, DateTime, ForeignKey, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from ..database import Base
from .base import TimestampMixin, naive_utcnow
from .ids_default import uuid_pk

THRESHOLD_STATUSES = ("good", "warning", "late", "critical")
REASON_CATEGORIES = (
    "waiting_for_next_job_assignment", "worker_delay", "bay_cleaning", "vehicle_movement",
    "parts_waiting", "customer_approval_waiting", "tool_or_equipment_delay",
    "test_drive_or_quality_check", "supervisor_delay", "break_or_lunch",
    "absent_or_unavailable", "system_timer_issue", "other",
)
RESPONSIBLE_TYPES = ("worker", "admin", "customer", "parts", "system", "unavoidable")


class WorkerTransitionDelayReason(Base, TimestampMixin):
    """Admin/master-entered reason for a high bay-to-bay transition gap. Keyed by the bridged
    session pair; the gap/delay snapshot is copied in so the reason stays meaningful in reports
    even if the analytics window changes. This is analysis, not punishment."""
    __tablename__ = "worker_transition_delay_reasons"
    __table_args__ = (
        UniqueConstraint("branch_id", "worker_id", "prev_session_id", "next_session_id",
                         name="uq_worker_transition_pair"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uuid_pk)
    branch_id: Mapped[str | None] = mapped_column(ForeignKey("branches.id"), default=None, index=True)
    worker_id: Mapped[str | None] = mapped_column(String(36), default=None, index=True)
    worker_name: Mapped[str | None] = mapped_column(default=None)
    date: Mapped[str | None] = mapped_column(String(10), default=None, index=True)   # YYYY-MM-DD

    # the two sessions this transition bridges (plain strings — never cascade a session delete)
    prev_session_id: Mapped[str | None] = mapped_column(String(36), default=None, index=True)
    prev_job_card_id: Mapped[str | None] = mapped_column(String(36), default=None)
    prev_job_no: Mapped[str | None] = mapped_column(default=None)
    prev_bay_number: Mapped[int | None] = mapped_column(Integer, default=None)
    next_session_id: Mapped[str | None] = mapped_column(String(36), default=None, index=True)
    next_job_card_id: Mapped[str | None] = mapped_column(String(36), default=None)
    next_job_no: Mapped[str | None] = mapped_column(default=None)
    next_bay_number: Mapped[int | None] = mapped_column(Integer, default=None)

    prev_completed_at: Mapped[datetime | None] = mapped_column(DateTime, default=None)
    next_assigned_at: Mapped[datetime | None] = mapped_column(DateTime, default=None)
    next_started_at: Mapped[datetime | None] = mapped_column(DateTime, default=None)
    assignment_delay_minutes: Mapped[int | None] = mapped_column(Integer, default=None)
    start_delay_minutes: Mapped[int | None] = mapped_column(Integer, default=None)
    transition_gap_minutes: Mapped[int | None] = mapped_column(Integer, default=None)
    threshold_status: Mapped[str | None] = mapped_column(String(12), default=None)

    reason_category: Mapped[str | None] = mapped_column(String(40), default=None)
    reason_note: Mapped[str | None] = mapped_column(Text, default=None)
    responsible_type: Mapped[str | None] = mapped_column(String(16), default=None)
    marked_by_admin_id: Mapped[str | None] = mapped_column(default=None)
    marked_by_admin_name: Mapped[str | None] = mapped_column(default=None)
    marked_by_role: Mapped[str | None] = mapped_column(String(12), default=None)      # admin | master
    marked_at: Mapped[datetime | None] = mapped_column(DateTime, default=None)
    updated_at: Mapped[datetime | None] = mapped_column(DateTime, default=None, onupdate=naive_utcnow)
