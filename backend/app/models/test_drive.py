"""Bike Test Drive Tracking — additive models (Phase 1).

A test drive is assigned by an admin on a COMPLETED service job; the worker then
captures real GPS points from the mobile portal (Phase 2). The backend stores every
raw point (valid + invalid, for audit) and recomputes the authoritative metrics
(distance, durations, avg/max speed, stops) on completion. Nothing here touches the
service lifecycle — these are standalone tables linked by snapshot/FK only.
"""
import enum
from datetime import datetime

from sqlalchemy import String, Integer, Float, Boolean, ForeignKey, DateTime, Enum as SQLEnum
from sqlalchemy.orm import Mapped, mapped_column

from ..database import Base
from .base import TimestampMixin, naive_utcnow
from .ids_default import uuid_pk


class TestDriveStatus(str, enum.Enum):
    assigned = "assigned"
    running = "running"
    completed = "completed"
    cancelled = "cancelled"
    failed = "failed"


class PointSource(str, enum.Enum):
    browser_gps = "browser_gps"
    device_gps = "device_gps"
    manual_test = "manual_test"


class TestDriveSession(Base, TimestampMixin):
    __tablename__ = "test_drive_sessions"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uuid_pk)

    # links (additive — never drives the service lifecycle)
    service_session_id: Mapped[str | None] = mapped_column(ForeignKey("service_sessions.id"), default=None)
    job_card_id: Mapped[str | None] = mapped_column(ForeignKey("job_cards.id"), default=None)
    job_card_number: Mapped[str | None] = mapped_column(default=None)
    queue_id: Mapped[str | None] = mapped_column(default=None)
    worker_id: Mapped[str] = mapped_column(ForeignKey("users.id"))
    branch_id: Mapped[str | None] = mapped_column(ForeignKey("branches.id"), default=None)

    # snapshots (kept stable even if the source row later changes)
    worker_name: Mapped[str | None] = mapped_column(default=None)          # TEST-DRIVE worker
    service_worker_name: Mapped[str | None] = mapped_column(default=None)  # who did the service (may differ)
    customer_name: Mapped[str | None] = mapped_column(default=None)
    bike_model: Mapped[str | None] = mapped_column(default=None)
    bike_registration: Mapped[str | None] = mapped_column(default=None)

    assigned_by_admin_id: Mapped[str | None] = mapped_column(ForeignKey("users.id"), default=None)
    assigned_at: Mapped[datetime | None] = mapped_column(DateTime, default=naive_utcnow)
    started_at: Mapped[datetime | None] = mapped_column(DateTime, default=None)
    ended_at: Mapped[datetime | None] = mapped_column(DateTime, default=None)

    status: Mapped[TestDriveStatus] = mapped_column(SQLEnum(TestDriveStatus), default=TestDriveStatus.assigned)

    # ── approval + worker device connection (additive — separate string columns so
    #    the TestDriveStatus enum is never touched). New control flow:
    #    admin assigns (pending_approval / not_connected) → worker approves on their
    #    device (approved / connected) → admin alone completes (completed / disconnected).
    approval_status: Mapped[str] = mapped_column(default="pending_approval")  # pending_approval|approved|completed
    worker_approved_at: Mapped[datetime | None] = mapped_column(DateTime, default=None)
    worker_approved_device_id: Mapped[str | None] = mapped_column(default=None)
    worker_approved_user_agent: Mapped[str | None] = mapped_column(default=None)
    device_connected_at: Mapped[datetime | None] = mapped_column(DateTime, default=None)
    last_device_heartbeat_at: Mapped[datetime | None] = mapped_column(DateTime, default=None)
    device_status: Mapped[str] = mapped_column(default="not_connected")       # not_connected|connected|stale|disconnected
    admin_completed_by: Mapped[str | None] = mapped_column(default=None)
    admin_completed_at: Mapped[datetime | None] = mapped_column(DateTime, default=None)

    start_latitude: Mapped[float | None] = mapped_column(Float, default=None)
    start_longitude: Mapped[float | None] = mapped_column(Float, default=None)
    end_latitude: Mapped[float | None] = mapped_column(Float, default=None)
    end_longitude: Mapped[float | None] = mapped_column(Float, default=None)

    # backend-computed metrics (source of truth — set on complete)
    total_duration_seconds: Mapped[int | None] = mapped_column(Integer, default=None)
    moving_duration_seconds: Mapped[int | None] = mapped_column(Integer, default=None)
    stop_duration_seconds: Mapped[int | None] = mapped_column(Integer, default=None)
    total_distance_km: Mapped[float | None] = mapped_column(Float, default=None)
    average_speed_kmh: Mapped[float | None] = mapped_column(Float, default=None)
    max_speed_kmh: Mapped[float | None] = mapped_column(Float, default=None)
    stop_count: Mapped[int | None] = mapped_column(Integer, default=None)
    point_count: Mapped[int | None] = mapped_column(Integer, default=None)

    # final route report (Phase 4 — stays NULL in Phase 1)
    route_image_path: Mapped[str | None] = mapped_column(default=None)
    route_image_url: Mapped[str | None] = mapped_column(default=None)

    notes: Mapped[str | None] = mapped_column(default=None)
    updated_at: Mapped[datetime | None] = mapped_column(DateTime, default=naive_utcnow, onupdate=naive_utcnow)


class TestDrivePoint(Base, TimestampMixin):
    __tablename__ = "test_drive_points"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uuid_pk)
    session_id: Mapped[str] = mapped_column(ForeignKey("test_drive_sessions.id", ondelete="CASCADE"), index=True)
    sequence_no: Mapped[int] = mapped_column(Integer, default=0)

    latitude: Mapped[float | None] = mapped_column(Float, default=None)
    longitude: Mapped[float | None] = mapped_column(Float, default=None)
    timestamp: Mapped[datetime | None] = mapped_column(DateTime, default=None)   # device time (naive UTC)

    speed_kmh: Mapped[float | None] = mapped_column(Float, default=None)          # device-reported
    computed_speed_kmh: Mapped[float | None] = mapped_column(Float, default=None) # backend dist/Δt
    accuracy_meters: Mapped[float | None] = mapped_column(Float, default=None)
    heading: Mapped[float | None] = mapped_column(Float, default=None)
    altitude: Mapped[float | None] = mapped_column(Float, default=None)
    source: Mapped[str] = mapped_column(default=PointSource.browser_gps.value)

    is_valid: Mapped[bool] = mapped_column(Boolean, default=True)
    validation_error: Mapped[str | None] = mapped_column(default=None)


class TestDriveStopEvent(Base, TimestampMixin):
    __tablename__ = "test_drive_stops"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uuid_pk)
    session_id: Mapped[str] = mapped_column(ForeignKey("test_drive_sessions.id", ondelete="CASCADE"), index=True)
    start_time: Mapped[datetime | None] = mapped_column(DateTime, default=None)
    end_time: Mapped[datetime | None] = mapped_column(DateTime, default=None)
    duration_seconds: Mapped[int | None] = mapped_column(Integer, default=None)
    latitude: Mapped[float | None] = mapped_column(Float, default=None)
    longitude: Mapped[float | None] = mapped_column(Float, default=None)
    point_count: Mapped[int | None] = mapped_column(Integer, default=None)
    radius_meters: Mapped[float | None] = mapped_column(Float, default=None)
    address: Mapped[str | None] = mapped_column(default=None)   # reverse-geocode (future)
