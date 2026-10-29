from datetime import datetime
from sqlalchemy import String, Integer, Float, ForeignKey, DateTime, JSON
from sqlalchemy.orm import Mapped, mapped_column
from ..database import Base
from .base import TimestampMixin, utcnow
from .ids_default import uuid_pk


class ImportedFile(Base, TimestampMixin):
    __tablename__ = "imported_files"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uuid_pk)
    file_name: Mapped[str] = mapped_column()
    file_type: Mapped[str] = mapped_column()                 # pdf | excel
    uploaded_by: Mapped[str | None] = mapped_column(ForeignKey("users.id"), default=None)
    uploaded_by_name: Mapped[str | None] = mapped_column(default=None)   # denormalized for display
    status: Mapped[str] = mapped_column(default="active")     # active | replaced
    total_records: Mapped[int] = mapped_column(Integer, default=0)       # parts created
    total_rows: Mapped[int] = mapped_column(Integer, default=0)          # rows scanned
    total_codes: Mapped[int] = mapped_column(Integer, default=0)         # distinct product codes
    dup_skipped: Mapped[int] = mapped_column(Integer, default=0)         # duplicate part numbers skipped
    size_bytes: Mapped[int] = mapped_column(Integer, default=0)
    version: Mapped[int] = mapped_column(Integer, default=1)
    history: Mapped[list | None] = mapped_column(JSON, default=None)     # [{version,date,total_parts,name}]


class PartsMaster(Base):
    __tablename__ = "parts_master"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uuid_pk)
    product_code: Mapped[str | None] = mapped_column(default=None)
    part_number: Mapped[str | None] = mapped_column(default=None)
    part_name: Mapped[str] = mapped_column()
    model: Mapped[str | None] = mapped_column(default=None)
    unit_value: Mapped[float] = mapped_column(Float, default=0)
    unit_time: Mapped[float] = mapped_column(Float, default=0)
    estimated_time: Mapped[float] = mapped_column(Float, default=0)   # minutes
    # ON DELETE CASCADE: deleting the source file removes its parts
    source_file_id: Mapped[str | None] = mapped_column(
        ForeignKey("imported_files.id", ondelete="CASCADE"), default=None
    )
    source_file_name: Mapped[str | None] = mapped_column(default=None)  # denormalized for traceability
    imported_by: Mapped[str | None] = mapped_column(default=None)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, onupdate=utcnow)


class UnitConversionSetting(Base):
    __tablename__ = "unit_conversion_settings"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uuid_pk)
    value_minutes: Mapped[float] = mapped_column(Float, default=1.0)
    previous_value: Mapped[float | None] = mapped_column(Float, default=None)
    changed_by: Mapped[str | None] = mapped_column(ForeignKey("users.id"), default=None)
    changed_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)
    records_affected: Mapped[int] = mapped_column(Integer, default=0)
