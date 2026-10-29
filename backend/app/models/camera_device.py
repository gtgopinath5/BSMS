"""Physical camera registry — the IP camera hardware bound to a bay.

This is the *device* (one per bay): its IP / RTSP URL / ONVIF port / credentials
and a heartbeat (`last_seen`). It is distinct from `CameraSession` (which is the
per-job recording lifecycle). The admin "Camera Connection" page manages these.
"""
from datetime import datetime
from sqlalchemy import String, Integer, ForeignKey, DateTime, Boolean
from sqlalchemy.orm import Mapped, mapped_column

from ..database import Base
from .ids_default import uuid_pk


class BayCamera(Base):
    __tablename__ = "bay_cameras"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uuid_pk)
    bay_id: Mapped[str] = mapped_column(ForeignKey("bays.id"), unique=True)   # one camera per bay
    camera_id: Mapped[str] = mapped_column(String(40))                        # human label e.g. CAM-CHN-01
    name: Mapped[str | None] = mapped_column(default=None)
    brand: Mapped[str | None] = mapped_column(default=None)                   # CP Plus / Hikvision / Dahua / Other
    ip_address: Mapped[str | None] = mapped_column(default=None)
    rtsp_url: Mapped[str | None] = mapped_column(default=None)
    rtsp_port: Mapped[int] = mapped_column(Integer, default=554)
    rtsp_path: Mapped[str | None] = mapped_column(default=None)               # e.g. /cam/realmonitor?channel=1&subtype=0
    onvif_port: Mapped[int] = mapped_column(Integer, default=80)
    username: Mapped[str | None] = mapped_column(default=None)
    password: Mapped[str | None] = mapped_column(default=None)                # NOTE: encrypt at rest in production
    enabled: Mapped[bool] = mapped_column(Boolean, default=True)
    last_seen: Mapped[datetime | None] = mapped_column(DateTime, default=None)  # last SUCCESSFUL probe
    last_error: Mapped[str | None] = mapped_column(default=None)              # honest last probe failure (creds redacted)
    created_at: Mapped[datetime | None] = mapped_column(DateTime, default=None)
