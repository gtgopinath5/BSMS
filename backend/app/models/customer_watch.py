"""Customer Live Watch — one temporary, passwordless watch link per service session.

A row is created when an admin decides, at START, whether to send the customer a live
video link (SENT) or to skip it with a mandatory reason (NOT_SENT). The link's lifecycle
mirrors the underlying ServiceSession (CREATED→LIVE→PAUSED→COMPLETED) and a NOT_SENT
record can be reverted by a Master to ELIGIBLE so the branch admin may send it later.

The raw token is shown to the admin once and never stored — only sha256(token) is kept,
so a DB leak never exposes a live link. The customer only ever sees /customer-watch/{token}.
"""
import enum
from datetime import datetime
from sqlalchemy import String, Text, ForeignKey, DateTime, Enum as SQLEnum
from sqlalchemy.orm import Mapped, mapped_column
from ..database import Base
from .base import TimestampMixin


class WatchDecision(str, enum.Enum):
    sent = "SENT"
    not_sent = "NOT_SENT"


class WatchStatus(str, enum.Enum):
    # SENT lifecycle (mirrors the ServiceSession while the link is live)
    created = "CREATED"        # link issued, service not started yet
    live = "LIVE"
    paused = "PAUSED"
    completed = "COMPLETED"    # terminal — token dead, /state → 410
    expired = "EXPIRED"        # terminal — past TTL, /state → 410
    # NOT_SENT lifecycle
    not_sent = "NOT_SENT"      # admin skipped with a reason
    eligible = "ELIGIBLE"      # master reverted → branch admin may now send


# Terminal states where any incoming token must be rejected with 410 Gone.
WATCH_DEAD = {WatchStatus.completed, WatchStatus.expired}


class CustomerWatchSession(Base, TimestampMixin):
    __tablename__ = "customer_watch_sessions"

    id: Mapped[str] = mapped_column(String(20), primary_key=True)            # CW-2026-000001
    job_card_id: Mapped[str] = mapped_column(ForeignKey("job_cards.id"), index=True)
    service_session_id: Mapped[str | None] = mapped_column(
        ForeignKey("service_sessions.id"), default=None, index=True)
    branch_id: Mapped[str | None] = mapped_column(ForeignKey("branches.id"), default=None, index=True)
    bay_id: Mapped[str | None] = mapped_column(ForeignKey("bays.id"), default=None)

    # snapshot of job-card customer data at decision time (the link is per-service)
    customer_name: Mapped[str | None] = mapped_column(default=None)
    customer_mobile: Mapped[str | None] = mapped_column(default=None)   # also the WhatsApp number
    vehicle_number: Mapped[str | None] = mapped_column(default=None)

    decision: Mapped[WatchDecision] = mapped_column(SQLEnum(WatchDecision))
    status: Mapped[WatchStatus] = mapped_column(SQLEnum(WatchStatus), index=True)
    token_hash: Mapped[str | None] = mapped_column(String(64), unique=True, default=None)  # sha256(token)
    reason: Mapped[str | None] = mapped_column(Text, default=None)       # mandatory for NOT_SENT

    created_by: Mapped[str | None] = mapped_column(ForeignKey("users.id"), default=None)
    reverted_by: Mapped[str | None] = mapped_column(ForeignKey("users.id"), default=None)

    whatsapp_sent_at: Mapped[datetime | None] = mapped_column(DateTime, default=None)
    whatsapp_status: Mapped[str | None] = mapped_column(default=None)     # sent | failed | …
    whatsapp_message_id: Mapped[str | None] = mapped_column(default=None)

    expires_at: Mapped[datetime | None] = mapped_column(DateTime, default=None)
