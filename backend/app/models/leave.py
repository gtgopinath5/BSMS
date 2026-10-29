import enum
from datetime import date, datetime
from sqlalchemy import String, Integer, Date, DateTime, ForeignKey, Enum as SQLEnum
from sqlalchemy.orm import Mapped, mapped_column
from ..database import Base
from .base import TimestampMixin
from .ids_default import uuid_pk


class LeaveStatus(str, enum.Enum):
    pending = "pending"
    approved = "approved"
    rejected = "rejected"


class LeaveRequest(Base, TimestampMixin):
    __tablename__ = "leave_requests"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uuid_pk)
    worker_id: Mapped[str] = mapped_column(ForeignKey("users.id"))
    from_date: Mapped[date] = mapped_column(Date)
    to_date: Mapped[date] = mapped_column(Date)
    days: Mapped[int] = mapped_column(Integer, default=1)
    leave_type: Mapped[str] = mapped_column(default="Personal")
    reason: Mapped[str] = mapped_column(default="")
    status: Mapped[LeaveStatus] = mapped_column(SQLEnum(LeaveStatus), default=LeaveStatus.pending)
    decided_by: Mapped[str | None] = mapped_column(ForeignKey("users.id"), default=None)
    decided_at: Mapped[datetime | None] = mapped_column(DateTime, default=None)
