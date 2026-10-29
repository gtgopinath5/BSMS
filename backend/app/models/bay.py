from datetime import date
from sqlalchemy import String, Integer, ForeignKey, Date, Boolean
from sqlalchemy.orm import Mapped, mapped_column
from ..database import Base
from .ids_default import uuid_pk


class Bay(Base):
    __tablename__ = "bays"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uuid_pk)
    bay_number: Mapped[int] = mapped_column(Integer)
    name: Mapped[str | None] = mapped_column(default=None)
    description: Mapped[str | None] = mapped_column(default=None)
    camera_channel: Mapped[str | None] = mapped_column(default=None)
    branch_id: Mapped[str] = mapped_column(ForeignKey("branches.id"))
    primary_worker_id: Mapped[str | None] = mapped_column(ForeignKey("users.id"), default=None)
    status: Mapped[str] = mapped_column(default="available")  # available/running/paused/maintenance/disabled
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)


class BayTempAssignment(Base):
    __tablename__ = "bay_temp_assignments"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uuid_pk)
    bay_id: Mapped[str] = mapped_column(ForeignKey("bays.id"))
    replacement_worker_id: Mapped[str] = mapped_column(ForeignKey("users.id"))
    start_date: Mapped[date] = mapped_column(Date)
    end_date: Mapped[date] = mapped_column(Date)
    reason: Mapped[str] = mapped_column(default="")
