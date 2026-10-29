"""AI Barricade helpers — the ONE place for vehicle-number normalisation (shared with intake),
event numbering, Fernet-encrypted camera credentials (never returned in the clear), cooldown
checks, on-disk frame storage with token-gated access, serializers that NEVER leak a raw path or
secret, decision/audit logging, and 30-day media retention cleanup.

Storage layout (mirrors the intake/recording media root + traversal containment):

    {MEDIA_ROOT}/barricade/{branch_id}/{direction}/{YYYY-MM-DD}/{event_no}/<safe>.<ext>

A row stores the relative STORAGE KEY only; the absolute path never leaves this module and is
never serialised. Clients receive only short-lived, HMAC-signed view URLs on our own backend.
"""
import base64
import hashlib
import hmac
import json
import logging
import time
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path

from sqlalchemy import select
from sqlalchemy.orm import Session

from ..config import settings
from ..models.base import naive_utcnow
from ..models.barricade import (BarricadeCameraConfig, BarricadeControllerConfig, BarricadeEvent,
                                BarricadeMedia, BarricadeBillApproval, BarricadeTemporaryApproval,
                                BarricadeDecisionLog)
from .intake import normalize_bike_number          # ONE normalisation truth (shared key)
# Share the SAME media root as the recording/intake pipelines (honours BW_MEDIA_ROOT).
from ..services.recording_service import MEDIA_ROOT

log = logging.getLogger("baywatch.barricade")

BARRICADE_ROOT = MEDIA_ROOT / "barricade"
_VIEW_TTL = 2 * 3600
_SAFE = __import__("re").compile(r"[^A-Za-z0-9_.-]")


# ── config-derived defaults ─────────────────────────────────────────
def retention_days() -> int:
    d = getattr(settings, "barricade_media_retention_days", 30)
    return int(d) if isinstance(d, (int, float)) and int(d) >= 1 else 30


def default_detection_threshold() -> float:
    return float(getattr(settings, "barricade_default_detection_threshold", 0.45) or 0.45)


def default_ocr_threshold() -> float:
    return float(getattr(settings, "barricade_default_ocr_threshold", 0.60) or 0.60)


def realtime_interval() -> int:
    return int(getattr(settings, "barricade_realtime_interval_seconds", 1) or 1)


# ── vehicle number (shared matching key) ────────────────────────────
def normalize_plate(raw: str | None) -> str:
    return normalize_bike_number(raw)


# ── ids ─────────────────────────────────────────────────────────────
def next_event_no(db: Session) -> str:
    """BRC-YYYY-NNNNNN — derived from the MAX existing numeric suffix (collision-proof)."""
    mx = 0
    for v in db.scalars(select(BarricadeEvent.event_no)).all():
        tail = str(v).rsplit("-", 1)[-1]
        if tail.isdigit():
            mx = max(mx, int(tail))
    return f"BRC-{datetime.utcnow().year}-{mx + 1:06d}"


# ── Fernet (camera credentials at rest) — same key derivation as integration_config ─
_fernet = None


def _f():
    global _fernet
    if _fernet is None:
        from cryptography.fernet import Fernet
        raw = settings.integration_secret_key or settings.jwt_secret or "baywatch"
        try:
            candidate = raw.encode()
            Fernet(candidate)
            key = candidate
        except Exception:
            key = base64.urlsafe_b64encode(hashlib.sha256(raw.encode()).digest())
        _fernet = Fernet(key)
    return _fernet


def encrypt_secret(plain: str | None) -> str | None:
    if not plain:
        return None
    try:
        return _f().encrypt(plain.encode()).decode()
    except Exception:
        log.warning("barricade: could not encrypt a credential")
        return None


def decrypt_secret(token: str | None) -> str | None:
    if not token:
        return None
    try:
        return _f().decrypt(token.encode()).decode()
    except Exception:
        log.warning("barricade: could not decrypt a stored credential (key changed?)")
        return None


def build_rtsp_url(ip: str | None, port, path: str | None,
                   user: str | None, pwd: str | None) -> str | None:
    """Assemble an RTSP URL from components (CP Plus style). Returns None with no IP. The result
    carries credentials — it is INTERNAL-only and must never be logged or returned to a public API."""
    if not ip:
        return None
    p = path or "/"
    if not str(p).startswith("/"):
        p = "/" + str(p)
    auth = f"{user}:{pwd or ''}@" if user else ""
    return f"rtsp://{auth}{ip}:{port or 554}{p}"


def internal_camera_out(c: BarricadeCameraConfig) -> dict:
    """INTERNAL serializer for the AI stream worker — returns DECRYPTED credentials + a ready RTSP
    URL so the worker can connect. NEVER call this from a public/admin/frontend path (use
    ``camera_out`` there, which masks secrets). Guarded by the internal-token / admin-JWT route."""
    user = decrypt_secret(c.username_encrypted)
    pwd = decrypt_secret(c.password_encrypted)
    return {
        "camera_config_id": c.id, "branch_id": c.branch_id, "direction": c.direction,
        "camera_name": c.camera_name, "brand": c.brand,
        "enabled": bool(c.enabled), "detection_enabled": bool(c.detection_enabled),
        "ip_address": c.ip_address, "rtsp_port": c.rtsp_port, "rtsp_path": c.rtsp_path,
        "username": user, "password": pwd,
        "rtsp_url": build_rtsp_url(c.ip_address, c.rtsp_port, c.rtsp_path, user, pwd),
        "detection_threshold": c.detection_threshold, "ocr_threshold": c.ocr_threshold,
        "frame_sample_fps": c.frame_sample_fps, "cooldown_seconds": c.cooldown_seconds,
        "roi_json": c.roi_json,
    }


def mask_secret(token: str | None) -> dict:
    """Frontend-safe shape for a stored credential: whether it is set + a masked tail. The raw
    value (and even its decrypted form) never crosses this boundary."""
    plain = decrypt_secret(token)
    if not plain:
        return {"set": False, "masked": None}
    tail = plain[-2:] if len(plain) > 2 else plain
    return {"set": True, "masked": "••••" + tail}


def mask_url(url: str | None) -> str | None:
    """Mask any credentials in a relay URL for logs/results: drop userinfo (user:pass@) and redact
    every query-string VALUE (tokens/keys). Keeps scheme + host + path + param names for debugging.
    Anything unparseable → the host only (never the raw string)."""
    if not url:
        return url
    try:
        from urllib.parse import urlsplit, urlunsplit, parse_qsl
        p = urlsplit(url.strip())
        netloc = p.hostname or ""
        if p.port:
            netloc += f":{p.port}"
        if p.username:
            netloc = "***@" + netloc
        # readable redaction (no url-encoding of the '***' marker): token=***&dir=***
        q = "&".join(f"{k}=***" for k, _ in parse_qsl(p.query, keep_blank_values=True))
        return urlunsplit((p.scheme, netloc, p.path, q, ""))
    except Exception:
        try:
            from urllib.parse import urlsplit
            return (urlsplit(url).hostname or "relay") + "/…"
        except Exception:
            return "relay/…"


# ── filesystem (safe names + traversal containment) ─────────────────
def _san(value, fallback: str) -> str:
    s = (value or "").strip().replace(" ", "_")
    s = _SAFE.sub("", s)
    return s or fallback


def store_key(abs_path: Path) -> str:
    return str(abs_path.resolve().relative_to(MEDIA_ROOT.resolve()))


def local_path(key: str | None):
    """Resolve a stored key to an absolute Path under MEDIA_ROOT, with traversal containment.
    Returns None if the key escapes the root or the file is missing."""
    if not key:
        return None
    p = (MEDIA_ROOT / key).resolve()
    root = MEDIA_ROOT.resolve()
    if root not in p.parents and p != root:
        return None
    return p if p.exists() else None


def save_frame(event: BarricadeEvent, data: bytes, ext: str = "jpg",
               media_type: str = "frame") -> dict:
    """Write an (optional) detection frame to disk under the event's media dir with a safe
    generated name. Returns metadata to persist (storage KEY only — never an absolute path)."""
    d = (BARRICADE_ROOT / _san(event.branch_id, "nobranch") / _san(event.direction, "dir")
         / (event.event_time or naive_utcnow()).strftime("%Y-%m-%d") / _san(event.event_no, event.id))
    d.mkdir(parents=True, exist_ok=True)
    abs_path = d / f"{media_type}_{uuid.uuid4().hex}.{_san(ext, 'jpg')}"
    abs_path.write_bytes(data)
    return {"file_key": store_key(abs_path), "size_bytes": len(data)}


# ── token-gated media access (HMAC, capped at the media's expiry) ──
def _secret() -> bytes:
    return (settings.jwt_secret or "baywatch").encode()


def _sign(media_id: str, exp: int) -> str:
    return hmac.new(_secret(), f"barricade:{media_id}:{exp}".encode(), hashlib.sha256).hexdigest()[:32]


def view_token(media_id: str, expires_at: datetime | None = None) -> tuple[str, int]:
    exp = int(time.time()) + _VIEW_TTL
    if expires_at:
        if expires_at.tzinfo is None:
            expires_at = expires_at.replace(tzinfo=timezone.utc)
        exp = min(exp, int(expires_at.timestamp()))
    return _sign(media_id, exp), exp


def verify_view(media_id: str, token: str | None, exp) -> bool:
    try:
        exp = int(exp)
    except (TypeError, ValueError):
        return False
    if not token or exp < int(time.time()):
        return False
    return hmac.compare_digest(token, _sign(media_id, exp))


def view_url(media_id: str, expires_at: datetime | None) -> str:
    tok, exp = view_token(media_id, expires_at)
    return f"/api/v1/barricade/media/{media_id}/view?token={tok}&exp={exp}"


# ── cooldown ─────────────────────────────────────────────────────────
def _now() -> datetime:
    return naive_utcnow()


def cooldown_active(db: Session, branch_id: str | None, direction: str,
                    cooldown_seconds: int, now: datetime | None = None) -> bool:
    """True if a barrier already opened at this branch+direction within the cooldown window —
    so a burst of detections of the same vehicle never re-fires the relay."""
    if not cooldown_seconds or cooldown_seconds <= 0:
        return False
    now = now or _now()
    stmt = select(BarricadeEvent).where(
        BarricadeEvent.direction == direction,
        BarricadeEvent.barrier_opened_at.is_not(None),
    )
    if branch_id:
        stmt = stmt.where(BarricadeEvent.branch_id == branch_id)
    last = db.scalars(stmt.order_by(BarricadeEvent.barrier_opened_at.desc())).first()
    if not last or not last.barrier_opened_at:
        return False
    opened = last.barrier_opened_at
    if opened.tzinfo is not None:
        opened = opened.replace(tzinfo=None)
    return (now - opened).total_seconds() < cooldown_seconds


# ── audit / decision log ────────────────────────────────────────────
def log_decision(db: Session, event_id: str | None, actor_type: str, actor_id: str | None,
                 actor_name: str | None, action: str, reason: str | None = None,
                 meta: dict | None = None) -> None:
    db.add(BarricadeDecisionLog(
        event_id=event_id, actor_type=actor_type, actor_id=actor_id, actor_name=actor_name,
        action=action, reason=reason,
        metadata_json=json.dumps(meta, default=str) if meta else None,
    ))


# ── serialization (NEVER leaks file_path / credentials) ─────────────
def _iso(dt: datetime | None) -> str | None:
    return dt.isoformat() if dt else None


def _short(text: str | None, n: int = 180) -> str | None:
    if not text:
        return None
    t = " ".join(str(text).split())
    return t if len(t) <= n else t[: n - 1] + "…"


def camera_out(c: BarricadeCameraConfig) -> dict:
    """Camera config for the admin UI — credentials reduced to {set, masked}; ciphertext never
    crosses the boundary. ip_address is operational config (admin-only), not a media path."""
    return {
        "id": c.id, "branch_id": c.branch_id, "direction": c.direction,
        "camera_name": c.camera_name, "brand": c.brand,
        "ip_address": c.ip_address, "rtsp_port": c.rtsp_port, "rtsp_path": c.rtsp_path,
        "username": mask_secret(c.username_encrypted),
        "password": mask_secret(c.password_encrypted),
        "enabled": bool(c.enabled), "detection_enabled": bool(c.detection_enabled),
        "detection_threshold": c.detection_threshold, "ocr_threshold": c.ocr_threshold,
        "frame_sample_fps": c.frame_sample_fps, "cooldown_seconds": c.cooldown_seconds,
        "auto_open_known_vehicle": bool(c.auto_open_known_vehicle),
        "auto_open_person": bool(c.auto_open_person),
        "require_admin_unknown": bool(c.require_admin_unknown),
        "last_seen_at": _iso(c.last_seen_at), "last_error": c.last_error,
        "updated_at": _iso(c.updated_at),
    }


def controller_out(c: BarricadeControllerConfig | None) -> dict | None:
    if not c:
        return None
    is_http = c.controller_type == "http_relay"
    cmd = (lambda v: mask_url(v)) if is_http else (lambda v: v)   # http URLs may carry tokens → mask
    return {
        "id": c.id, "branch_id": c.branch_id, "controller_type": c.controller_type,
        "http_method": getattr(c, "http_method", None),
        "entrance_open_command": cmd(c.entrance_open_command), "exit_open_command": cmd(c.exit_open_command),
        "entrance_command_set": bool(c.entrance_open_command), "exit_command_set": bool(c.exit_open_command),
        "status_endpoint": mask_url(c.status_endpoint) if is_http else c.status_endpoint,
        "mqtt_topic": c.mqtt_topic,
        "cooldown_seconds": c.cooldown_seconds, "max_open_seconds": c.max_open_seconds,
        "enabled": bool(c.enabled),
        "emergency_stopped": (c.last_status or "") == "emergency_stop",
        "require_safety_status_for_open": bool(getattr(c, "require_safety_status_for_open", False)),
        "safety": _controller_safety(c),
        "last_command_at": _iso(c.last_command_at),
        "last_status": c.last_status, "last_error": c.last_error, "updated_at": _iso(c.updated_at),
    }


def _controller_safety(c: BarricadeControllerConfig) -> dict:
    """Hardware safety telemetry for the admin UI — scalar status fields only (no URLs/secrets)."""
    return {
        "controller_online": bool(getattr(c, "controller_online", False)),
        "barrier_state": getattr(c, "barrier_state", None) or "unknown",
        "beam_status": getattr(c, "beam_status", None) or "unknown",
        "loop_status": getattr(c, "loop_status", None) or "unknown",
        "manual_override_active": bool(getattr(c, "manual_override_active", False)),
        "power_status": getattr(c, "power_status", None) or "unknown",
        "network_status": getattr(c, "network_status", None) or "unknown",
        "fault_reason": getattr(c, "fault_reason", None),
        "last_safety_at": _iso(getattr(c, "last_safety_at", None)),
        "last_safety_error": getattr(c, "last_safety_error", None),
    }


def _relay_summary(e: BarricadeEvent) -> dict | None:
    try:
        return json.loads(e.relay_result_json) if e.relay_result_json else None
    except Exception:
        return None


def event_card(e: BarricadeEvent) -> dict:
    """List card — summary only. No media bytes, no file paths, no credentials."""
    return {
        "id": e.id, "event_no": e.event_no, "branch_id": e.branch_id, "direction": e.direction,
        "object_type": e.object_type, "detection_confidence": e.detection_confidence,
        "vehicle_number": e.vehicle_number_raw,
        "vehicle_number_normalized": e.vehicle_number_normalized,
        "ocr_confidence": e.ocr_confidence, "status": e.status,
        "decision_reason": _short(e.decision_reason),
        "authorization_source": getattr(e, "authorization_source", None),
        "event_time": _iso(e.event_time),
        "barrier_opened": e.barrier_opened_at is not None,
        "barrier_opened_at": _iso(e.barrier_opened_at),
        "approved_by_admin_name": e.approved_by_admin_name,
        "linked_job_card_id": e.linked_job_card_id,
        "linked": bool(e.linked_job_card_id or e.linked_intake_id
                       or e.linked_test_drive_id or e.linked_bill_id),
        "created_at": _iso(e.created_at),
    }


def event_detail(db: Session, e: BarricadeEvent) -> dict:
    media = db.scalars(select(BarricadeMedia).where(BarricadeMedia.event_id == e.id)
                       .order_by(BarricadeMedia.created_at)).all()
    logs = db.scalars(select(BarricadeDecisionLog).where(BarricadeDecisionLog.event_id == e.id)
                      .order_by(BarricadeDecisionLog.created_at)).all()
    return {
        **event_card(e),
        "camera_config_id": e.camera_config_id,
        "entry_time": _iso(e.entry_time), "exit_time": _iso(e.exit_time),
        "approved_by_admin_id": e.approved_by_admin_id, "approved_at": _iso(e.approved_at),
        "linked_intake_id": e.linked_intake_id, "linked_test_drive_id": e.linked_test_drive_id,
        "linked_bill_id": e.linked_bill_id,
        "relay_result": _relay_summary(e),
        "media": [media_out(m) for m in media],
        "decision_log": [decision_log_out(l) for l in logs],
    }


def media_out(m: BarricadeMedia) -> dict:
    """Frame metadata — token-gated API URL only, never a raw filesystem path."""
    available = m.status == "active" and local_path(m.file_path) is not None
    return {
        "id": m.id, "media_type": m.media_type, "mime_type": m.mime_type,
        "size_bytes": m.size_bytes, "status": m.status, "available": available,
        "created_at": _iso(m.created_at), "expires_at": _iso(m.expires_at),
        "view_url": view_url(m.id, m.expires_at) if available else None,
    }


def decision_log_out(l: BarricadeDecisionLog) -> dict:
    meta = None
    try:
        meta = json.loads(l.metadata_json) if l.metadata_json else None
    except Exception:
        meta = None
    return {
        "actor_type": l.actor_type, "actor_name": l.actor_name, "action": l.action,
        "reason": l.reason, "metadata": meta, "created_at": _iso(l.created_at),
    }


def bill_out(b: BarricadeBillApproval, used_event_no: str | None = None) -> dict:
    return {
        "id": b.id, "branch_id": b.branch_id, "bill_no": b.bill_no, "job_card_id": b.job_card_id,
        "vehicle_number": b.vehicle_number_raw,
        "vehicle_number_normalized": b.vehicle_number_normalized,
        "customer_name": b.customer_name, "amount": b.amount,
        "payment_status": b.payment_status, "status": b.status,
        "notes": getattr(b, "notes", None),
        "uploaded_by_admin_name": b.uploaded_by_admin_name, "uploaded_at": _iso(b.uploaded_at),
        "used_event_id": b.used_event_id, "used_event_no": used_event_no,
        "used_at": _iso(getattr(b, "used_at", None)),
        "created_at": _iso(b.created_at), "updated_at": _iso(getattr(b, "updated_at", None)),
    }


def temp_out(t: BarricadeTemporaryApproval, used_event_no: str | None = None) -> dict:
    return {
        "id": t.id, "branch_id": t.branch_id, "approval_type": t.approval_type,
        "vehicle_number_normalized": t.vehicle_number_normalized, "object_type": t.object_type,
        "linked_test_drive_id": t.linked_test_drive_id, "linked_job_card_id": t.linked_job_card_id,
        "linked_worker_id": t.linked_worker_id,
        "valid_from": _iso(t.valid_from), "valid_until": _iso(t.valid_until),
        "status": t.status, "notes": getattr(t, "notes", None),
        "created_by_admin_name": t.created_by_admin_name,
        "used_event_id": t.used_event_id, "used_event_no": used_event_no,
        "used_at": _iso(getattr(t, "used_at", None)),
        "created_at": _iso(t.created_at), "updated_at": _iso(getattr(t, "updated_at", None)),
    }


# ── 30-day media retention cleanup (startup + scheduler sweep) ──────
def cleanup_expired_media(db: Session, now: datetime | None = None) -> dict:
    """Past the retention window: stop access + verified-delete the physical frame, mark the media
    deleted/expired. NEVER touches an event, decision log, bill, temp approval or any core record —
    the audit trail and event metadata are preserved forever. Idempotent."""
    now = now or _now()
    expired = deleted = 0
    rows = db.scalars(select(BarricadeMedia).where(
        BarricadeMedia.status == "active",
        BarricadeMedia.expires_at.is_not(None),
        BarricadeMedia.expires_at <= now,
    )).all()
    for m in rows:
        p = local_path(m.file_path)
        gone = True
        if p is not None:
            try:
                p.unlink()
            except Exception:
                log.warning("barricade: could not delete %s", m.file_path, exc_info=True)
            gone = local_path(m.file_path) is None
        m.deleted_at = now
        m.status = "deleted" if gone else "expired"
        expired += 1
        if gone:
            deleted += 1
    if expired:
        db.commit()
    return {"expired_media": expired, "deleted_files": deleted}
