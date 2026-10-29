import enum
from datetime import datetime, date
from sqlalchemy import String, ForeignKey, Enum as SQLEnum, DateTime, Date
from sqlalchemy.orm import Mapped, mapped_column
from ..database import Base
from .base import TimestampMixin
from .ids_default import uuid_pk


class UserRole(str, enum.Enum):
    master_admin = "master_admin"
    admin = "admin"
    worker = "worker"


class User(Base, TimestampMixin):
    __tablename__ = "users"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uuid_pk)
    name: Mapped[str] = mapped_column()
    email: Mapped[str | None] = mapped_column(default=None)
    mobile: Mapped[str | None] = mapped_column(default=None)
    role: Mapped[UserRole] = mapped_column(SQLEnum(UserRole))
    branch_id: Mapped[str | None] = mapped_column(ForeignKey("branches.id"), default=None)

    # staff identity
    employee_id: Mapped[str | None] = mapped_column(default=None)   # EMP-802 / ADMIN-014
    company_id: Mapped[str | None] = mapped_column(default=None)
    pf_number: Mapped[str | None] = mapped_column(default=None)
    aadhaar: Mapped[str | None] = mapped_column(default=None)
    department: Mapped[str | None] = mapped_column(default=None)
    designation: Mapped[str | None] = mapped_column(default=None)

    # personal (worker HR record)
    address: Mapped[str | None] = mapped_column(default=None)
    emergency_contact: Mapped[str | None] = mapped_column(default=None)
    dob: Mapped[date | None] = mapped_column(Date, default=None)
    joining_date: Mapped[date | None] = mapped_column(Date, default=None)

    # credentials
    username: Mapped[str | None] = mapped_column(unique=True, default=None)
    hashed_password: Mapped[str | None] = mapped_column(default=None)
    last_login: Mapped[datetime | None] = mapped_column(DateTime, default=None)

    profile_photo_url: Mapped[str | None] = mapped_column(default=None)
    # active · inactive · suspended · locked  (active is the only one that can log in)
    status: Mapped[str] = mapped_column(default="active")

    @property
    def join_date(self):
        """Explicit joining date if set, else the day the record was created."""
        return self.joining_date or (self.created_at.date() if self.created_at else None)
