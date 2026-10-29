"""Recording lifecycle helpers — the server-side mirror of the frontend
`RecordingUtil`. Single source of truth for status, day-counts, signed URLs
and HH:MM:SS formatting.
"""
import hashlib
import hmac
import time
from datetime import datetime, timedelta, timezone

from ..config import settings

EXPIRING_DAYS = 3
PLAYBACK_TTL = 2 * 3600   # signed playback URL lifetime (seconds)


def effective_retention_days() -> int:
    """Retention window (days) for a NEW recording's expiry. Prefer the admin's
    Google Drive 'Retention (days)' setting when present, else the global env
    default. Read here (not in the workflow engine) so the lifecycle code stays
    untouched. Lazy import avoids any circular dependency."""
    try:
        from . import integration_config
        rd = integration_config.get_config("google_drive").get("retention_days")
        if isinstance(rd, (int, float)) and int(rd) >= 1:
            return int(rd)
    except Exception:
        pass
    return settings.recording_retention_days


def expiry_from(completed_at: datetime) -> datetime:
    return completed_at + timedelta(days=effective_retention_days())


def days_left(expires_at: datetime | None, now: datetime | None = None) -> int:
    if not expires_at:
        return 0
    now = now or datetime.now(timezone.utc)
    if expires_at.tzinfo is None:
        expires_at = expires_at.replace(tzinfo=timezone.utc)
    delta = (expires_at - now).total_seconds()
    return max(0, -(-int(delta) // 86400)) if delta > 0 else 0


def status(expires_at: datetime | None, raw: str | None = None, now: datetime | None = None) -> str:
    """'active' | 'expiring' | 'expired' (<=3 days left -> expiring)."""
    if raw in ("expired", "deleted"):
        return "expired"
    if not expires_at:
        return "expired"
    now = now or datetime.now(timezone.utc)
    if expires_at.tzinfo is None:
        expires_at = expires_at.replace(tzinfo=timezone.utc)
    if expires_at <= now:
        return "expired"
    return "expiring" if days_left(expires_at, now) <= EXPIRING_DAYS else "active"


def _secret() -> bytes:
    return (settings.jwt_secret or "baywatch").encode()


def _sign(recording_id: str, exp: int) -> str:
    return hmac.new(_secret(), f"{recording_id}:{exp}".encode(), hashlib.sha256).hexdigest()[:32]


def playback_token(recording_id: str, expires_at: datetime | None = None) -> tuple[str, int]:
    """Short-lived HMAC token for streaming a recording, capped at its retention
    expiry so an expired recording can never be played even with an old link."""
    exp = int(time.time()) + PLAYBACK_TTL
    if expires_at:
        if expires_at.tzinfo is None:
            expires_at = expires_at.replace(tzinfo=timezone.utc)
        exp = min(exp, int(expires_at.timestamp()))
    return _sign(recording_id, exp), exp


def verify_playback(recording_id: str, token: str | None, exp) -> bool:
    try:
        exp = int(exp)
    except (TypeError, ValueError):
        return False
    if not token or exp < int(time.time()):
        return False
    return hmac.compare_digest(token, _sign(recording_id, exp))


def signed_url(recording_id: str, expires_at: datetime | None) -> str | None:
    """Authorized playback URL on OUR backend — raw filesystem / SSD / RTSP paths
    are never exposed. Points at the streaming endpoint with a short-lived signed
    token (which serves the local MP4, or redirects to Google Drive once archived)."""
    if not recording_id:
        return None
    tok, exp = playback_token(recording_id, expires_at)
    return f"/api/v1/recordings/{recording_id}/stream?token={tok}&exp={exp}"


def archive_state(rec, local_present: bool, now: datetime | None = None) -> dict:
    """The ONE truthful storage state for a recording, derived from real stored
    fields + the caller's filesystem check (`local_present`). No fakery: a missing
    local file reads 'local_missing'; a never-archived recording kept past expiry
    reads 'expired_unarchived' (held for admin, not silently lost); a delete that
    failed reads 'deletion_failed'. Returns {state, local, drive, customer_available}.

    The caller supplies `local_present` (= recording_service.local_path(...) is not
    None) so this helper stays pure — no filesystem / service import here.
    """
    st = status(rec.expiry_date, rec.status.value if rec.status else None, now)
    expired = st == "expired" or bool(getattr(rec, "is_deleted", False))
    has_drive = bool(getattr(rec, "drive_file_id", None))
    has_local_key = bool(getattr(rec, "video_path", None))
    up = getattr(rec, "upload_status", None)

    local = "saved" if local_present else ("missing" if has_local_key else "none")
    drive = "uploaded" if has_drive else (up if up in ("pending", "uploading", "failed") else "none")
    customer_available = (not expired) and (has_drive or local_present)

    if getattr(rec, "is_deleted", False):
        state = "deleted"
    elif getattr(rec, "delete_error", None):
        state = "deletion_failed"
    elif expired:
        # past retention: customer access has stopped. If it was never safely
        # archived but a local copy survives, it is HELD (not lost) for admin.
        state = "expired_unarchived" if (not has_drive and local_present) else "expired"
    elif has_drive:
        state = "drive_uploaded"
    elif up == "failed":
        state = "upload_failed"
    elif up == "uploading":
        state = "upload_in_progress"
    elif up == "pending":
        state = "upload_pending"
    elif has_local_key:
        state = "local_saved" if local_present else "local_missing"
    elif rec.status and rec.status.value == "recording":
        state = "recording"
    else:
        state = "none"
    return {"state": state, "local": local, "drive": drive, "customer_available": customer_available}


def is_available(rec, local_present: bool, now: datetime | None = None) -> bool:
    """Truthful playback availability: not expired/deleted AND a real copy exists
    (archived on Drive or the local file is actually present)."""
    return archive_state(rec, local_present, now)["customer_available"]


def duration_full(seconds: int | None) -> str:
    s = max(0, int(seconds or 0))
    return f"{s // 3600:02d}:{(s % 3600) // 60:02d}:{s % 60:02d}"


def fmt_date(dt: datetime | None) -> str:
    if not dt:
        return "-"
    return dt.strftime("%d-%m-%Y")
