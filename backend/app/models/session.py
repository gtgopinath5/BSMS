import enum
from datetime import datetime
from sqlalchemy import String, Integer, ForeignKey, DateTime, Boolean, Enum as SQLEnum
from sqlalchemy.orm import Mapped, mapped_column
from ..database import Base
from .base import TimestampMixin


class SessionStatus(str, enum.Enum):
    assigned = "assigned"
    running = "running"
    paused = "paused"
    completed = "completed"


class RecordingStatus(str, enum.Enum):
    idle = "idle"
    recording = "recording"
    active = "active"
    expiring = "expiring"
    expired = "expired"


class ServiceSession(Base, TimestampMixin):
    __tablename__ = "service_sessions"

    id: Mapped[str] = mapped_column(String(20), primary_key=True)          # SS-2026-000001
    job_card_id: Mapped[str] = mapped_column(ForeignKey("job_cards.id"))
    worker_id: Mapped[str] = mapped_column(ForeignKey("users.id"))
    bay_id: Mapped[str] = mapped_column(ForeignKey("bays.id"))
    customer_id: Mapped[str | None] = mapped_column(ForeignKey("users.id"), default=None)
    status: Mapped[SessionStatus] = mapped_column(SQLEnum(SessionStatus), default=SessionStatus.assigned)

    start_time: Mapped[datetime | None] = mapped_column(DateTime, default=None)
    end_time: Mapped[datetime | None] = mapped_column(DateTime, default=None)
    estimated_duration: Mapped[int] = mapped_column(Integer, default=0)    # seconds
    actual_duration: Mapped[int | None] = mapped_column(Integer, default=None)
    overtime_duration: Mapped[int | None] = mapped_column(Integer, default=None)


class CameraSession(Base):
    __tablename__ = "camera_sessions"

    id: Mapped[str] = mapped_column(String(20), primary_key=True)          # CAM-01 etc.
    service_session_id: Mapped[str] = mapped_column(
        ForeignKey("service_sessions.id", ondelete="CASCADE")
    )
    bay_id: Mapped[str] = mapped_column(ForeignKey("bays.id"))
    started_at: Mapped[datetime | None] = mapped_column(DateTime, default=None)
    stopped_at: Mapped[datetime | None] = mapped_column(DateTime, default=None)
    status: Mapped[str] = mapped_column(default="off")


class RecordingSession(Base):
    __tablename__ = "recording_sessions"

    id: Mapped[str] = mapped_column(String(20), primary_key=True)          # REC-2026-000001
    service_session_id: Mapped[str] = mapped_column(
        ForeignKey("service_sessions.id", ondelete="CASCADE")
    )
    worker_id: Mapped[str | None] = mapped_column(ForeignKey("users.id"), default=None)
    customer_id: Mapped[str | None] = mapped_column(ForeignKey("users.id"), default=None)
    job_card_id: Mapped[str | None] = mapped_column(ForeignKey("job_cards.id"), default=None)

    video_url: Mapped[str | None] = mapped_column(default=None)            # external URL (Drive) once archived
    video_path: Mapped[str | None] = mapped_column(default=None)           # local SSD key e.g. recordings/SS-…/video.mp4
    file_size: Mapped[int | None] = mapped_column(Integer, default=None)   # bytes
    drive_file_id: Mapped[str | None] = mapped_column(default=None)        # Google Drive file id
    drive_url: Mapped[str | None] = mapped_column(default=None)            # Google Drive share link

    # ── Drive archival lifecycle (Storage Management) ──────────────────
    # upload_status: local | pending | uploading | uploaded | failed
    #   local     — finished recording held on SSD (Drive off, or not yet swept)
    #   pending   — eligible for upload, queued for the next sweep
    #   uploading — an upload attempt is in flight
    #   uploaded  — verified on Drive, local SSD copy deleted (never lost)
    #   failed    — last attempt failed; local copy KEPT and retried automatically
    upload_status: Mapped[str | None] = mapped_column(String(20), default=None)
    upload_attempts: Mapped[int] = mapped_column(Integer, default=0)
    upload_error: Mapped[str | None] = mapped_column(default=None)         # last failure reason
    uploaded_at: Mapped[datetime | None] = mapped_column(DateTime, default=None)
    # ── Retention / deletion truthfulness (Storage Management) ─────────
    delete_error: Mapped[str | None] = mapped_column(default=None)         # why a Drive/local delete failed
    last_verified_at: Mapped[datetime | None] = mapped_column(DateTime, default=None)  # last file/Drive verify
    recording_start: Mapped[datetime | None] = mapped_column(DateTime, default=None)
    recording_end: Mapped[datetime | None] = mapped_column(DateTime, default=None)
    duration_seconds: Mapped[int] = mapped_column(Integer, default=0)
    created_at: Mapped[datetime | None] = mapped_column(DateTime, default=None)
    expiry_date: Mapped[datetime | None] = mapped_column(DateTime, default=None)
    status: Mapped[RecordingStatus] = mapped_column(SQLEnum(RecordingStatus), default=RecordingStatus.idle)
    is_deleted: Mapped[bool] = mapped_column(Boolean, default=False)


class Notification(Base, TimestampMixin):
    __tablename__ = "notifications"

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    customer_id: Mapped[str] = mapped_column(ForeignKey("users.id"))
    service_session_id: Mapped[str | None] = mapped_column(default=None)
    type: Mapped[str] = mapped_column()                                   # SERVICE_STARTED ...
    message: Mapped[str] = mapped_column()
    channels: Mapped[str] = mapped_column(default="In-App")              # comma list
    read: Mapped[bool] = mapped_column(Boolean, default=False)
