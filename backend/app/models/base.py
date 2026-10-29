"""Shared model helpers."""
from datetime import datetime, timezone
from sqlalchemy import DateTime
from sqlalchemy.orm import Mapped, mapped_column


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


def naive_utcnow() -> datetime:
    """Naive UTC — for the project's ``TIMESTAMP WITHOUT TIME ZONE`` columns, so stored
    values and comparisons stay consistent regardless of the DB session timezone."""
    return datetime.now(timezone.utc).replace(tzinfo=None)


class TimestampMixin:
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)
