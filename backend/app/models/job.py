import enum
from sqlalchemy import String, Integer, Float, ForeignKey, Enum as SQLEnum, JSON
from sqlalchemy.orm import Mapped, mapped_column
from ..database import Base
from .base import TimestampMixin
from .ids_default import uuid_pk


class QueueStatus(str, enum.Enum):
    queued = "queued"
    assigned = "assigned"
    active = "active"
    completed = "completed"


class Priority(str, enum.Enum):
    high = "high"
    medium = "medium"
    low = "low"


class JobCard(Base, TimestampMixin):
    __tablename__ = "job_cards"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uuid_pk)
    job_card_number: Mapped[str] = mapped_column(unique=True)   # JC-1072
    vehicle_number: Mapped[str | None] = mapped_column(default=None)
    vehicle_model: Mapped[str | None] = mapped_column(default=None)
    chassis_number: Mapped[str | None] = mapped_column(default=None)
    engine_number: Mapped[str | None] = mapped_column(default=None)
    km_reading: Mapped[str | None] = mapped_column(default=None)

    customer_name: Mapped[str | None] = mapped_column(default=None)
    customer_mobile: Mapped[str | None] = mapped_column(default=None)
    customer_email: Mapped[str | None] = mapped_column(default=None)
    customer_id: Mapped[str | None] = mapped_column(ForeignKey("users.id"), default=None)

    customer_address: Mapped[str | None] = mapped_column(default=None)

    service_type: Mapped[str | None] = mapped_column(default=None)
    repair_type: Mapped[str | None] = mapped_column(default=None)
    estimated_cost: Mapped[float | None] = mapped_column(Float, default=None)
    estimated_minutes: Mapped[int] = mapped_column(Integer, default=45)

    # Customer Voice
    complaint: Mapped[str | None] = mapped_column(default=None)
    notes: Mapped[str | None] = mapped_column(default=None)
    # Parsed service / parts-time analysis (from PDF extraction)
    services: Mapped[list | None] = mapped_column(JSON, default=None)
    # PDF extraction → Parts Time matching (additive): extracted+matched parts,
    # estimate status, and parser confidence. estimated_minutes stays the authority.
    parts: Mapped[list | None] = mapped_column(JSON, default=None)
    estimate_status: Mapped[str | None] = mapped_column(default=None)   # complete|partial|no_match|extraction_failed
    extraction_confidence: Mapped[float | None] = mapped_column(Float, default=None)

    source_type: Mapped[str] = mapped_column(default="manual")   # manual | pdf
    original_pdf_url: Mapped[str | None] = mapped_column(default=None)
    branch_id: Mapped[str | None] = mapped_column(ForeignKey("branches.id"), default=None)
    created_by: Mapped[str | None] = mapped_column(ForeignKey("users.id"), default=None)


class JobQueue(Base, TimestampMixin):
    __tablename__ = "job_queue"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uuid_pk)
    job_card_id: Mapped[str] = mapped_column(ForeignKey("job_cards.id"))
    worker_id: Mapped[str] = mapped_column(ForeignKey("users.id"))
    bay_id: Mapped[str | None] = mapped_column(ForeignKey("bays.id"), default=None)
    queue_position: Mapped[int] = mapped_column(Integer, default=0)
    status: Mapped[QueueStatus] = mapped_column(SQLEnum(QueueStatus), default=QueueStatus.queued)
    priority: Mapped[Priority] = mapped_column(SQLEnum(Priority), default=Priority.medium)
