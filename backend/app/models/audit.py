from datetime import datetime
from sqlalchemy import String, ForeignKey, DateTime, JSON
from sqlalchemy.orm import Mapped, mapped_column
from ..database import Base
from .base import utcnow
from .ids_default import uuid_pk


class AuditLog(Base):
    __tablename__ = "audit_logs"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uuid_pk)
    action: Mapped[str] = mapped_column()
    entity_type: Mapped[str | None] = mapped_column(default=None)
    entity_id: Mapped[str | None] = mapped_column(default=None)
    changed_by: Mapped[str | None] = mapped_column(ForeignKey("users.id"), default=None)
    old_value: Mapped[dict | None] = mapped_column(JSON, default=None)
    new_value: Mapped[dict | None] = mapped_column(JSON, default=None)
    timestamp: Mapped[datetime] = mapped_column(DateTime, default=utcnow)
