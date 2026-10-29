"""Physical timer registry — the ESP32 countdown unit bound to a bay.

One device per bay (mirrors BayCamera). Holds the device's identity + heartbeat
(`last_seen`, refreshed from MQTT telemetry) + reported firmware/IP. The admin
"Timer Connection" page manages these; the actual countdown it shows is driven
entirely by the backend over MQTT (the ESP32 never computes time).
"""
from datetime import datetime
from sqlalchemy import String, ForeignKey, DateTime, Boolean
from sqlalchemy.orm import Mapped, mapped_column

from ..database import Base
from .ids_default import uuid_pk


class TimerDevice(Base):
    __tablename__ = "timer_devices"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uuid_pk)
    bay_id: Mapped[str] = mapped_column(ForeignKey("bays.id"), unique=True)   # one timer per bay
    timer_id: Mapped[str] = mapped_column(String(40))                         # human label e.g. TMR-01
    name: Mapped[str | None] = mapped_column(default=None)
    ip_address: Mapped[str | None] = mapped_column(default=None)              # reported by the device
    firmware_version: Mapped[str | None] = mapped_column(default=None)        # reported by the device
    enabled: Mapped[bool] = mapped_column(Boolean, default=True)
    last_seen: Mapped[datetime | None] = mapped_column(DateTime, default=None)  # MQTT telemetry heartbeat
    # Admin-command telemetry (pair/test/restart/reconnect/firmware). Stamped by the
    # timers router only — lifecycle start/pause/resume/complete are NOT stamped here.
    last_command: Mapped[str | None] = mapped_column(String(40), default=None)
    last_command_at: Mapped[datetime | None] = mapped_column(DateTime, default=None)
    last_error: Mapped[str | None] = mapped_column(default=None)
    created_at: Mapped[datetime | None] = mapped_column(DateTime, default=None)
