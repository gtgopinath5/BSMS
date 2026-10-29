"""AI Barricade Vehicle Detection / Entrance-Exit Automation (Phase B — backend foundation).

Cameras at the entrance/exit watch the gate; an EXTERNAL detection service (YOLO + OCR, added
in later phases) only ever SUGGESTS — it posts a detection event. The BACKEND is the single
decision authority: it applies the branch's rules (known vehicle / approved bill / temporary
approval / admin override) and only then asks the relay controller to open. The relay can never
be opened directly by the detection service. Fail-safe is CLOSED: anything uncertain (low
confidence, unknown vehicle, missing/low-confidence plate, disabled config) becomes
``pending_admin`` and waits for a human.

Phase B is SIMULATION ONLY — no YOLO, no RTSP, no OCR engine, no real relay hardware. The tables,
APIs, decision rules, realtime and safety logs are all real; the "open" is a logged simulation.

All tables are ADDITIVE and auto-created by ``init_db()`` ``create_all`` (idempotent, never drops).
Barricade cameras + relay live in their OWN tables — the bay camera / bay timer / MQTT-timer core
is never touched. Camera credentials are Fernet-encrypted at rest and never returned in the clear.
"""
from datetime import datetime

from sqlalchemy import String, Text, Integer, Float, Boolean, DateTime, ForeignKey
from sqlalchemy.orm import Mapped, mapped_column

from ..database import Base
from .base import TimestampMixin, naive_utcnow
from .ids_default import uuid_pk

# ── vocabularies (adding a value needs no migration) ────────────────────────
DIRECTIONS = ("entrance", "exit")
CONTROLLER_TYPES = ("disabled", "simulation", "http_relay", "mqtt_relay", "gpio_gateway")
OBJECT_TYPES = ("person", "bike", "car", "unknown")
#   detected       — just ingested, before a decision is written
#   pending_admin  — fail-safe: a human must allow/deny (DEFAULT for anything uncertain)
#   auto_allowed   — backend rules authorized it automatically
#   admin_allowed  — a human authorized it
#   denied         — a human refused it (never opens)
#   opened         — the (simulated) barrier was actually opened
#   failed         — authorized but the open command failed
#   expired        — aged out without resolution
EVENT_STATUSES = ("detected", "pending_admin", "auto_allowed", "admin_allowed",
                  "denied", "opened", "failed", "expired")
MEDIA_TYPES = ("frame", "vehicle_crop", "plate_crop")
MEDIA_STATUSES = ("active", "deleted", "expired")
BILL_STATUSES = ("pending", "approved", "rejected", "used", "expired")
PAYMENT_STATUSES = ("unpaid", "paid", "unknown")
TEMP_APPROVAL_TYPES = ("test_drive", "visitor", "manual_once")
TEMP_STATUSES = ("active", "used", "revoked", "expired")
ACTOR_TYPES = ("system", "admin", "master", "worker")


class BarricadeCameraConfig(Base, TimestampMixin):
    """One entrance/exit camera per branch+direction. SEPARATE from the bay camera registry.
    Credentials are stored ENCRYPTED and never serialised back in the clear."""
    __tablename__ = "barricade_camera_configs"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uuid_pk)
    branch_id: Mapped[str | None] = mapped_column(ForeignKey("branches.id"), default=None, index=True)
    direction: Mapped[str] = mapped_column(String(8), index=True)              # entrance | exit
    camera_name: Mapped[str | None] = mapped_column(default=None)
    brand: Mapped[str | None] = mapped_column(default=None)
    ip_address: Mapped[str | None] = mapped_column(default=None)
    rtsp_port: Mapped[int | None] = mapped_column(Integer, default=554)
    rtsp_path: Mapped[str | None] = mapped_column(default=None)
    # Fernet ciphertext only — the raw login is NEVER persisted or returned.
    username_encrypted: Mapped[str | None] = mapped_column(Text, default=None)
    password_encrypted: Mapped[str | None] = mapped_column(Text, default=None)

    enabled: Mapped[bool] = mapped_column(Boolean, default=True)
    detection_enabled: Mapped[bool] = mapped_column(Boolean, default=True)
    roi_json: Mapped[str | None] = mapped_column(Text, default=None)           # region-of-interest (later phases)
    detection_threshold: Mapped[float] = mapped_column(Float, default=0.45)
    ocr_threshold: Mapped[float] = mapped_column(Float, default=0.60)
    frame_sample_fps: Mapped[float] = mapped_column(Float, default=2.0)
    cooldown_seconds: Mapped[int] = mapped_column(Integer, default=10)

    # safety-relevant auto-open switches (default OFF / require-admin — fail-safe closed)
    auto_open_known_vehicle: Mapped[bool] = mapped_column(Boolean, default=False)
    auto_open_person: Mapped[bool] = mapped_column(Boolean, default=False)
    require_admin_unknown: Mapped[bool] = mapped_column(Boolean, default=True)

    last_seen_at: Mapped[datetime | None] = mapped_column(DateTime, default=None)
    last_error: Mapped[str | None] = mapped_column(Text, default=None)
    updated_at: Mapped[datetime | None] = mapped_column(DateTime, default=None, onupdate=naive_utcnow)


class BarricadeControllerConfig(Base, TimestampMixin):
    """The relay controller for a branch. Phase B supports ``disabled`` and ``simulation`` only;
    the hardware transports (http_relay/mqtt_relay/gpio_gateway) are stored but never actuated."""
    __tablename__ = "barricade_controller_configs"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uuid_pk)
    branch_id: Mapped[str | None] = mapped_column(ForeignKey("branches.id"), default=None, index=True)
    controller_type: Mapped[str] = mapped_column(String(16), default="simulation")
    entrance_open_command: Mapped[str | None] = mapped_column(Text, default=None)
    exit_open_command: Mapped[str | None] = mapped_column(Text, default=None)
    http_method: Mapped[str | None] = mapped_column(String(8), default="GET")   # http_relay: GET|POST
    status_endpoint: Mapped[str | None] = mapped_column(default=None)
    mqtt_topic: Mapped[str | None] = mapped_column(default=None)
    cooldown_seconds: Mapped[int] = mapped_column(Integer, default=8)
    max_open_seconds: Mapped[int] = mapped_column(Integer, default=15)
    enabled: Mapped[bool] = mapped_column(Boolean, default=True)
    last_command_at: Mapped[datetime | None] = mapped_column(DateTime, default=None)
    last_status: Mapped[str | None] = mapped_column(default=None)
    last_error: Mapped[str | None] = mapped_column(Text, default=None)
    updated_at: Mapped[datetime | None] = mapped_column(DateTime, default=None, onupdate=naive_utcnow)

    # ── hardware safety telemetry (reported by a REAL controller/gateway, never driven here) ──
    # All default 'unknown'/off so simulation and every existing flow are unaffected. The backend
    # only DISPLAYS these and may GATE an open on them (see require_safety_status_for_open); it never
    # drives the barrier motor or the sensors. barrier_state = the physical gate feedback, distinct
    # from last_status (the last relay-command outcome).
    controller_online: Mapped[bool] = mapped_column(Boolean, default=False)
    barrier_state: Mapped[str | None] = mapped_column(String(12), default="unknown")      # unknown|closed|opening|open|closing|fault
    beam_status: Mapped[str | None] = mapped_column(String(12), default="unknown")        # unknown|clear|blocked
    loop_status: Mapped[str | None] = mapped_column(String(12), default="unknown")        # unknown|clear|vehicle_present
    manual_override_active: Mapped[bool] = mapped_column(Boolean, default=False)
    power_status: Mapped[str | None] = mapped_column(String(12), default="unknown")       # unknown|mains|ups|low_battery
    network_status: Mapped[str | None] = mapped_column(String(12), default="unknown")     # unknown|online|offline|unstable
    fault_reason: Mapped[str | None] = mapped_column(Text, default=None)
    require_safety_status_for_open: Mapped[bool] = mapped_column(Boolean, default=False)
    last_safety_at: Mapped[datetime | None] = mapped_column(DateTime, default=None)
    last_safety_error: Mapped[str | None] = mapped_column(Text, default=None)
    safety_status_json: Mapped[str | None] = mapped_column(Text, default=None)


class BarricadeEvent(Base, TimestampMixin):
    """One detection → decision → (simulated) open lifecycle record. The audit detail of who
    decided and what the relay returned lives here + in BarricadeDecisionLog."""
    __tablename__ = "barricade_events"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uuid_pk)
    event_no: Mapped[str] = mapped_column(String(24), unique=True, index=True)   # BRC-YYYY-NNNNNN
    branch_id: Mapped[str | None] = mapped_column(ForeignKey("branches.id"), default=None, index=True)
    direction: Mapped[str] = mapped_column(String(8), index=True)
    # plain string (NOT an FK) so deleting/replacing a camera config never cascades into history
    camera_config_id: Mapped[str | None] = mapped_column(String(36), default=None, index=True)

    object_type: Mapped[str] = mapped_column(String(12), default="unknown")
    detection_confidence: Mapped[float | None] = mapped_column(Float, default=None)
    vehicle_number_raw: Mapped[str | None] = mapped_column(default=None)
    vehicle_number_normalized: Mapped[str | None] = mapped_column(String(32), default=None, index=True)
    ocr_confidence: Mapped[float | None] = mapped_column(Float, default=None)

    event_time: Mapped[datetime] = mapped_column(DateTime, default=naive_utcnow, index=True)
    entry_time: Mapped[datetime | None] = mapped_column(DateTime, default=None)
    exit_time: Mapped[datetime | None] = mapped_column(DateTime, default=None)

    status: Mapped[str] = mapped_column(String(16), default="detected", index=True)
    decision_reason: Mapped[str | None] = mapped_column(Text, default=None)

    # additive links (plain strings — never constrains/breaks a core delete)
    linked_job_card_id: Mapped[str | None] = mapped_column(String(36), default=None, index=True)
    linked_intake_id: Mapped[str | None] = mapped_column(String(36), default=None)
    linked_test_drive_id: Mapped[str | None] = mapped_column(String(36), default=None)
    linked_bill_id: Mapped[str | None] = mapped_column(String(36), default=None)

    approved_by_admin_id: Mapped[str | None] = mapped_column(default=None)
    approved_by_admin_name: Mapped[str | None] = mapped_column(default=None)
    approved_at: Mapped[datetime | None] = mapped_column(DateTime, default=None)
    authorization_source: Mapped[str | None] = mapped_column(String(20), default=None)  # bill|temporary|admin_manual|master_override|known_vehicle|auto_person
    barrier_opened_at: Mapped[datetime | None] = mapped_column(DateTime, default=None)
    relay_result_json: Mapped[str | None] = mapped_column(Text, default=None)
    updated_at: Mapped[datetime | None] = mapped_column(DateTime, default=None, onupdate=naive_utcnow)


class BarricadeMedia(Base, TimestampMixin):
    """Detection frame / crop metadata. The binary lives on disk (storage KEY only here); access
    is exclusively via a token-gated route. Phase B can attach an optional frame; real per-frame
    capture is a later phase."""
    __tablename__ = "barricade_media"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uuid_pk)
    event_id: Mapped[str] = mapped_column(ForeignKey("barricade_events.id"), index=True)
    branch_id: Mapped[str | None] = mapped_column(default=None, index=True)
    media_type: Mapped[str] = mapped_column(String(16), default="frame")
    # STORAGE KEY only (relative to the media root) — never a raw absolute path, never serialised.
    file_path: Mapped[str | None] = mapped_column(String(512), default=None)
    mime_type: Mapped[str | None] = mapped_column(default=None)
    size_bytes: Mapped[int | None] = mapped_column(Integer, default=None)
    status: Mapped[str] = mapped_column(String(16), default="active", index=True)
    expires_at: Mapped[datetime | None] = mapped_column(DateTime, default=None, index=True)
    deleted_at: Mapped[datetime | None] = mapped_column(DateTime, default=None)


class BarricadeBillApproval(Base, TimestampMixin):
    """An admin-approved bill that authorises ONE matching vehicle to EXIT (e.g. customer paid).
    Matching is by normalized vehicle number; ``used_event_id`` records the exit it released."""
    __tablename__ = "barricade_bill_approvals"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uuid_pk)
    branch_id: Mapped[str | None] = mapped_column(ForeignKey("branches.id"), default=None, index=True)
    bill_no: Mapped[str | None] = mapped_column(String(40), default=None, index=True)
    job_card_id: Mapped[str | None] = mapped_column(String(36), default=None)
    vehicle_number_raw: Mapped[str | None] = mapped_column(default=None)
    vehicle_number_normalized: Mapped[str | None] = mapped_column(String(32), default=None, index=True)
    customer_name: Mapped[str | None] = mapped_column(default=None)
    amount: Mapped[float | None] = mapped_column(Float, default=None)
    payment_status: Mapped[str] = mapped_column(String(12), default="unknown")
    bill_pdf_path: Mapped[str | None] = mapped_column(String(512), default=None)   # storage key only
    extracted_json: Mapped[str | None] = mapped_column(Text, default=None)
    uploaded_by_admin_id: Mapped[str | None] = mapped_column(default=None)
    uploaded_by_admin_name: Mapped[str | None] = mapped_column(default=None)
    uploaded_at: Mapped[datetime | None] = mapped_column(DateTime, default=None)
    status: Mapped[str] = mapped_column(String(12), default="pending")
    notes: Mapped[str | None] = mapped_column(Text, default=None)
    used_event_id: Mapped[str | None] = mapped_column(String(36), default=None)
    used_at: Mapped[datetime | None] = mapped_column(DateTime, default=None)
    updated_at: Mapped[datetime | None] = mapped_column(DateTime, default=None, onupdate=naive_utcnow)


class BarricadeTemporaryApproval(Base, TimestampMixin):
    """A time-boxed pass: a test-drive bike, a visitor, or a one-shot manual allowance. Authorises
    a matching vehicle within ``valid_from``..``valid_until`` while ``status == active``."""
    __tablename__ = "barricade_temporary_approvals"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uuid_pk)
    branch_id: Mapped[str | None] = mapped_column(ForeignKey("branches.id"), default=None, index=True)
    approval_type: Mapped[str] = mapped_column(String(16), default="manual_once")
    vehicle_number_normalized: Mapped[str | None] = mapped_column(String(32), default=None, index=True)
    object_type: Mapped[str | None] = mapped_column(String(12), default=None)
    linked_test_drive_id: Mapped[str | None] = mapped_column(String(36), default=None)
    linked_worker_id: Mapped[str | None] = mapped_column(String(36), default=None)
    linked_job_card_id: Mapped[str | None] = mapped_column(String(36), default=None)
    valid_from: Mapped[datetime | None] = mapped_column(DateTime, default=naive_utcnow)
    valid_until: Mapped[datetime | None] = mapped_column(DateTime, default=None)
    status: Mapped[str] = mapped_column(String(12), default="active", index=True)
    notes: Mapped[str | None] = mapped_column(Text, default=None)
    created_by_admin_id: Mapped[str | None] = mapped_column(default=None)
    created_by_admin_name: Mapped[str | None] = mapped_column(default=None)
    used_event_id: Mapped[str | None] = mapped_column(String(36), default=None)
    used_at: Mapped[datetime | None] = mapped_column(DateTime, default=None)
    updated_at: Mapped[datetime | None] = mapped_column(DateTime, default=None, onupdate=naive_utcnow)


class BarricadeDecisionLog(Base, TimestampMixin):
    """Append-only safety/audit trail: every decision, allow, deny, open, override and cooldown
    skip — who/what did it, why, and any structured context. Never deleted by retention."""
    __tablename__ = "barricade_decision_logs"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uuid_pk)
    event_id: Mapped[str | None] = mapped_column(String(36), default=None, index=True)
    actor_type: Mapped[str | None] = mapped_column(String(12), default=None)   # system|admin|master|worker
    actor_id: Mapped[str | None] = mapped_column(default=None)
    actor_name: Mapped[str | None] = mapped_column(default=None)
    action: Mapped[str | None] = mapped_column(String(40), default=None)
    reason: Mapped[str | None] = mapped_column(Text, default=None)
    metadata_json: Mapped[str | None] = mapped_column(Text, default=None)
