"""Integration settings — one row per external-service provider (global scope).

Holds admin-editable configuration for Google Drive archival, the MQTT timer
broker, camera/RTSP defaults, and the WhatsApp Cloud API. Non-secret config is
stored as JSON; secrets are stored ONLY as a Fernet-encrypted blob (see
``utils/integration_config``) and never returned to the frontend in the clear.

A row OVERRIDES the matching environment-variable defaults at runtime, so saving
config takes effect immediately with no backend restart. No row → the service
falls back to its env defaults (unchanged behavior).

Auto-created by ``init_db()`` ``create_all`` (idempotent) — no migration needed.
"""
import uuid
from datetime import datetime
from sqlalchemy import String, Text, Boolean, DateTime, ForeignKey, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column
from ..database import Base
from .base import TimestampMixin, utcnow


# Known providers (kept as plain strings so adding one needs no migration).
PROVIDERS = ("google_drive", "mqtt_timer", "camera", "whatsapp")


class IntegrationSettings(Base, TimestampMixin):
    __tablename__ = "integration_settings"
    __table_args__ = (UniqueConstraint("provider", "branch_id", name="uq_integration_provider_scope"),)

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    provider: Mapped[str] = mapped_column(String(32), index=True)            # one of PROVIDERS
    branch_id: Mapped[str | None] = mapped_column(ForeignKey("branches.id"), default=None, index=True)  # null = global

    config_json: Mapped[str | None] = mapped_column(Text, default=None)      # non-secret config (JSON)
    secret_json: Mapped[str | None] = mapped_column(Text, default=None)      # Fernet-encrypted secrets blob

    enabled: Mapped[bool] = mapped_column(Boolean, default=False)
    status: Mapped[str] = mapped_column(String(20), default="not_configured")  # not_configured|active|dormant|failed

    last_tested_at: Mapped[datetime | None] = mapped_column(DateTime, default=None)
    last_success_at: Mapped[datetime | None] = mapped_column(DateTime, default=None)
    last_error: Mapped[str | None] = mapped_column(Text, default=None)

    created_by: Mapped[str | None] = mapped_column(ForeignKey("users.id"), default=None)
    updated_by: Mapped[str | None] = mapped_column(ForeignKey("users.id"), default=None)
    updated_at: Mapped[datetime | None] = mapped_column(DateTime, default=utcnow, onupdate=utcnow)
