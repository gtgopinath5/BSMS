"""Vehicle Intake Evidence helpers — the ONE place for bike-number normalisation, on-disk
media storage (binaries on disk, metadata in PG), token-gated access, serialization that
NEVER leaks a raw path, the role-scoped grouping shapes, and 14-day retention cleanup.

Storage layout (mirrors the recording pipeline's media root + traversal containment):

    {MEDIA_ROOT}/intake/{branch_id}/{bike_normalized}/{intake_no}/images/<safe>.<ext>
    {MEDIA_ROOT}/intake/{branch_id}/{bike_normalized}/{intake_no}/audio/<safe>.<ext>

A row stores the relative STORAGE KEY only (e.g. ``intake/LOC/PY05XX0000/VIE-.../images/x.jpg``).
The absolute path never leaves this module and is never serialized; clients receive only
short-lived, HMAC-signed view URLs on our own backend.
"""
import hashlib
import hmac
import json
import logging
import re
import subprocess
import time
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path

from sqlalchemy import select, func
from sqlalchemy.orm import Session

from ..config import settings
from ..models.base import naive_utcnow
from ..models.branch import Branch
from ..models.vehicle_intake import VehicleIntakeEntry, VehicleIntakeMedia, VehicleIntakeEvent
from . import recordings as rec_utils
# Share the SAME media root + ffprobe binary as the recording pipeline (honours BW_MEDIA_ROOT).
from ..services.recording_service import MEDIA_ROOT, FFPROBE

log = logging.getLogger("baywatch.intake")

INTAKE_ROOT = MEDIA_ROOT / "intake"

# ── upload limits (server-side; mirrored client-side later) ─────────
MAX_IMAGES = 20
MAX_IMAGE_BYTES = 8 * 1024 * 1024
IMAGE_EXTS = {"jpg", "jpeg", "png", "webp"}
IMAGE_MIMES = {"image/jpeg", "image/jpg", "image/png", "image/webp"}
MAX_AUDIO = 10
MAX_AUDIO_SECONDS = 120
AUDIO_EXTS = {"webm", "wav", "mp3", "m4a"}
AUDIO_MIMES = {"audio/webm", "audio/wav", "audio/x-wav", "audio/wave", "audio/mpeg",
               "audio/mp3", "audio/mp4", "audio/x-m4a", "audio/aac", "video/webm"}

_VIEW_TTL = 2 * 3600        # signed media-view link lifetime (seconds)
_NON_ALNUM = re.compile(r"[^A-Za-z0-9]")
_SAFE = re.compile(r"[^A-Za-z0-9_.-]")


def retention_days() -> int:
    d = getattr(settings, "intake_media_retention_days", 14)
    return int(d) if isinstance(d, (int, float)) and int(d) >= 1 else 14


# ── bike number (the matching key) ──────────────────────────────────
def normalize_bike_number(raw: str | None) -> str:
    """Uppercase + strip every non-alphanumeric char. 'PY 05 XX-0000' → 'PY05XX0000'."""
    return _NON_ALNUM.sub("", raw or "").upper()


# ── ids ─────────────────────────────────────────────────────────────
def next_intake_no(db: Session) -> str:
    """VIE-YYYY-NNNNNN — derived from the MAX existing numeric suffix (collision-proof
    across deletions), mirroring utils/ids._next_seq but keyed on ``intake_no``."""
    mx = 0
    for v in db.scalars(select(VehicleIntakeEntry.intake_no)).all():
        tail = str(v).rsplit("-", 1)[-1]
        if tail.isdigit():
            mx = max(mx, int(tail))
    return f"VIE-{datetime.utcnow().year}-{mx + 1:06d}"


# ── filesystem (safe names + traversal containment) ─────────────────
def _san(value, fallback: str) -> str:
    s = (value or "").strip().replace(" ", "_")
    s = _SAFE.sub("", s)
    s = re.sub(r"[_.\-]{2,}", "_", s).strip("_.-")
    return s or fallback


def _ext(filename: str | None) -> str:
    return (filename or "").rsplit(".", 1)[-1].lower() if "." in (filename or "") else ""


def _entry_dir(entry: VehicleIntakeEntry) -> Path:
    return (INTAKE_ROOT / _san(entry.branch_id, "nobranch")
            / _san(entry.bike_number_normalized, "UNKNOWN")
            / _san(entry.intake_no, entry.id))


def _media_dir(entry: VehicleIntakeEntry, media_type: str) -> Path:
    return _entry_dir(entry) / ("images" if media_type == "image" else "audio")


def store_key(abs_path: Path) -> str:
    """Relative storage key (what we persist) for an absolute path under the media root."""
    return str(abs_path.resolve().relative_to(MEDIA_ROOT.resolve()))


def local_path(key: str | None):
    """Resolve a stored key to an absolute Path under MEDIA_ROOT, with traversal containment.
    Returns None if the key escapes the root or the file is missing (mirrors recording_service)."""
    if not key:
        return None
    p = (MEDIA_ROOT / key).resolve()
    root = MEDIA_ROOT.resolve()
    if root not in p.parents and p != root:
        return None
    return p if p.exists() else None


# ── validation ──────────────────────────────────────────────────────
class IntakeValidationError(Exception):
    def __init__(self, code: int, message: str):
        self.code = code
        self.message = message
        super().__init__(message)


def validate_image(filename: str | None, mime: str | None, size: int) -> None:
    ext = _ext(filename)
    if ext not in IMAGE_EXTS and (mime or "").lower() not in IMAGE_MIMES:
        raise IntakeValidationError(400, f"Unsupported image type (allowed: {', '.join(sorted(IMAGE_EXTS))})")
    if size > MAX_IMAGE_BYTES:
        raise IntakeValidationError(413, f"Image too large (max {MAX_IMAGE_BYTES // (1024 * 1024)} MB)")
    if size <= 0:
        raise IntakeValidationError(400, "Empty image file")


def validate_audio(filename: str | None, mime: str | None, size: int) -> None:
    ext = _ext(filename)
    if ext not in AUDIO_EXTS and (mime or "").lower() not in AUDIO_MIMES:
        raise IntakeValidationError(400, f"Unsupported audio type (allowed: {', '.join(sorted(AUDIO_EXTS))})")
    if size <= 0:
        raise IntakeValidationError(400, "Empty audio file")


# ── thumbnails + duration ───────────────────────────────────────────
def _make_thumbnail(src_abs: Path, dst_abs: Path, max_px: int = 480) -> bool:
    try:
        from PIL import Image, ImageOps
        im = Image.open(src_abs)
        im = ImageOps.exif_transpose(im).convert("RGB")
        im.thumbnail((max_px, max_px))
        dst_abs.parent.mkdir(parents=True, exist_ok=True)
        im.save(dst_abs, "JPEG", quality=80)
        return True
    except Exception:
        log.warning("intake: thumbnail generation failed for %s", src_abs, exc_info=True)
        return False


def probe_audio_seconds(abs_path: Path) -> int | None:
    if not FFPROBE or not abs_path.exists():
        return None
    try:
        out = subprocess.run(
            [FFPROBE, "-v", "error", "-show_entries", "format=duration",
             "-of", "default=nw=1:nk=1", str(abs_path)],
            capture_output=True, text=True, timeout=15,
        )
        v = out.stdout.strip()
        return int(float(v)) if v else None
    except Exception:
        return None


def save_media_file(entry: VehicleIntakeEntry, media_type: str, filename: str | None,
                    data: bytes) -> dict:
    """Write the upload to disk under the entry's media dir with a safe generated name,
    make a thumbnail (images) and probe duration (audio). Returns the metadata to persist
    (storage KEYS only — never absolute paths)."""
    ext = _ext(filename) or ("jpg" if media_type == "image" else "bin")
    safe = f"{uuid.uuid4().hex}.{ext}"
    d = _media_dir(entry, media_type)
    d.mkdir(parents=True, exist_ok=True)
    abs_path = d / safe
    abs_path.write_bytes(data)

    thumb_key = None
    duration = None
    if media_type == "image":
        thumb_abs = d / f"thumb_{uuid.uuid4().hex}.jpg"
        if _make_thumbnail(abs_path, thumb_abs):
            thumb_key = store_key(thumb_abs)
    else:
        duration = probe_audio_seconds(abs_path)
    return {
        "file_key": store_key(abs_path),
        "thumbnail_key": thumb_key,
        "size_bytes": len(data),
        "duration_seconds": duration,
    }


# ── token-gated media access (HMAC, capped at the media's expiry) ──
def _secret() -> bytes:
    return (settings.jwt_secret or "baywatch").encode()


def _sign(media_id: str, exp: int) -> str:
    return hmac.new(_secret(), f"intake:{media_id}:{exp}".encode(), hashlib.sha256).hexdigest()[:32]


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


def view_url(media_id: str, expires_at: datetime | None, kind: str = "view") -> str:
    tok, exp = view_token(media_id, expires_at)
    return f"/api/v1/intake/media/{media_id}/{kind}?token={tok}&exp={exp}"


def public_base_url() -> str:
    """The backend's own public origin (same-origin as the API). Reused for the absolute
    token-gated media links embedded in the standalone evidence PDF."""
    base = getattr(settings, "customer_watch_base_url", None) or "http://localhost:8000"
    return str(base).rstrip("/")


def view_url_abs(media_id: str, expires_at: datetime | None, kind: str = "view") -> str:
    """Absolute, token-gated, expiry-capped media URL (routes through our backend
    /intake/media/{id}/view). Never exposes a filesystem path."""
    return public_base_url() + view_url(media_id, expires_at, kind)


# ── expiry / availability ───────────────────────────────────────────
def _now() -> datetime:
    return naive_utcnow()


def media_expired(m: VehicleIntakeMedia, now: datetime | None = None) -> bool:
    now = now or _now()
    if m.status in ("expired", "deleted"):
        return True
    return bool(m.expires_at and m.expires_at <= now)


def media_dead(m: VehicleIntakeMedia, now: datetime | None = None) -> bool:
    """Access must stop: revoked, deleted, expired status, or past its expiry."""
    return m.status in ("revoked", "deleted", "expired") or media_expired(m, now)


# ── serialization (NEVER leaks file_path / absolute path) ───────────
def _iso(dt: datetime | None) -> str | None:
    return dt.isoformat() if dt else None


def _short(text: str | None, n: int = 140) -> str | None:
    if not text:
        return None
    t = " ".join(str(text).split())
    return t if len(t) <= n else t[: n - 1] + "…"


def media_out(m: VehicleIntakeMedia, now: datetime | None = None) -> dict:
    now = now or _now()
    expired = media_expired(m, now)
    available = (m.status == "active") and not expired
    shown_status = "expired" if (expired and m.status == "active") else m.status
    return {
        "id": m.id,
        "media_type": m.media_type,
        "mime_type": m.mime_type,
        "original_filename": m.original_filename,
        "size_bytes": m.size_bytes,
        "size_kb": round((m.size_bytes or 0) / 1024, 1),
        "duration_seconds": m.duration_seconds,
        "caption": m.caption,
        "status": shown_status,
        "available": available,
        "uploaded_by_worker_name": m.uploaded_by_worker_name,
        "created_at": _iso(m.created_at),
        "expires_at": _iso(m.expires_at),
        "days_left": rec_utils.days_left(m.expires_at) if m.expires_at else None,
        # token-gated API URLs (our backend) — never a raw filesystem path
        "view_url": view_url(m.id, m.expires_at, "view") if available else None,
        "thumbnail_url": (view_url(m.id, m.expires_at, "thumbnail")
                          if (available and m.thumbnail_path) else None),
    }


def media_counts(db: Session, entry_id: str) -> tuple[int, int]:
    rows = db.execute(
        select(VehicleIntakeMedia.media_type, func.count())
        .where(VehicleIntakeMedia.intake_entry_id == entry_id,
               VehicleIntakeMedia.status == "active")
        .group_by(VehicleIntakeMedia.media_type)
    ).all()
    d = {t: n for t, n in rows}
    return int(d.get("image", 0)), int(d.get("audio", 0))


def counts_map(db: Session, entry_ids: list[str]) -> dict[str, tuple[int, int]]:
    out: dict[str, dict] = {}
    if not entry_ids:
        return {}
    rows = db.execute(
        select(VehicleIntakeMedia.intake_entry_id, VehicleIntakeMedia.media_type, func.count())
        .where(VehicleIntakeMedia.intake_entry_id.in_(entry_ids),
               VehicleIntakeMedia.status == "active")
        .group_by(VehicleIntakeMedia.intake_entry_id, VehicleIntakeMedia.media_type)
    ).all()
    for eid, mtype, n in rows:
        out.setdefault(eid, {"image": 0, "audio": 0})[mtype] = int(n)
    return {eid: (v["image"], v["audio"]) for eid, v in out.items()}


def entry_card(e: VehicleIntakeEntry, counts: tuple[int, int] | None = None) -> dict:
    img, aud = counts if counts is not None else (0, 0)
    return {
        "id": e.id,
        "intake_no": e.intake_no,
        "status": e.status,
        "branch_id": e.branch_id,
        "worker_id": e.worker_id,
        "worker_name": e.worker_name,
        "bike_number": e.bike_number_raw,
        "bike_number_normalized": e.bike_number_normalized,
        "customer_name": e.customer_name,
        "phone_number": e.phone_number,
        "whatsapp_number": e.whatsapp_number,
        "complaint_short": _short(e.complaint_description),
        "image_count": img,
        "voice_count": aud,
        "linked": bool(e.linked_job_card_id or e.linked_job_id or e.linked_assignment_id),
        "linked_job_card_id": e.linked_job_card_id,
        "linked_job_id": e.linked_job_id,
        "created_at": _iso(e.created_at),
        "submitted_at": _iso(e.submitted_at),
        "expires_at": _iso(e.expires_at),
    }


def _naive(dt: datetime | None) -> datetime | None:
    return dt.replace(tzinfo=None) if (dt and dt.tzinfo) else dt


def summary(db: Session, entries: list[VehicleIntakeEntry], now: datetime | None = None,
            expiring_days: int = 3) -> dict:
    """Dashboard summary over a (branch/global-scoped) set of intake entries — SUMMARY ints + a
    small 'latest' list only. Never leaks paths/media bytes. Reuses ``counts_map`` for photo/voice
    counts. today = submitted/created today; this_week = last 7 days; pending_link = unlinked & not
    archived/revoked; incomplete = missing photos OR voice; expiring_soon = media expiry within N
    days (not yet expired)."""
    now = now or _now()
    entries = [e for e in entries if e.deleted_at is None]
    cmap = counts_map(db, [e.id for e in entries])
    today = now.date()
    week_ago = now - timedelta(days=7)
    soon = now + timedelta(days=expiring_days)
    out = {"total": 0, "today": 0, "this_week": 0, "pending_link": 0, "with_photos": 0,
           "with_voice": 0, "incomplete": 0, "expiring_soon": 0, "latest": []}
    for e in sorted(entries, key=lambda x: (x.submitted_at or x.created_at or now), reverse=True):
        img, aud = cmap.get(e.id, (0, 0))
        out["total"] += 1
        ref = _naive(e.submitted_at or e.created_at)
        if ref and ref.date() == today:
            out["today"] += 1
        if ref and ref >= week_ago:
            out["this_week"] += 1
        linked = bool(e.linked_job_card_id or e.linked_job_id or e.linked_assignment_id)
        if not linked and e.status not in ("archived", "revoked"):
            out["pending_link"] += 1
        if img > 0:
            out["with_photos"] += 1
        if aud > 0:
            out["with_voice"] += 1
        if img == 0 or aud == 0:
            out["incomplete"] += 1
        exp = _naive(e.expires_at)
        if exp and now <= exp <= soon:
            out["expiring_soon"] += 1
        if len(out["latest"]) < 6:
            out["latest"].append({
                "id": e.id, "intake_no": e.intake_no, "bike_number": e.bike_number_raw,
                "customer_name": e.customer_name, "status": e.status,
                "image_count": img, "voice_count": aud, "linked": linked,
                "submitted_at": _iso(e.submitted_at or e.created_at),
            })
    return out


def entry_detail(db: Session, e: VehicleIntakeEntry, now: datetime | None = None) -> dict:
    now = now or _now()
    media = db.scalars(
        select(VehicleIntakeMedia)
        .where(VehicleIntakeMedia.intake_entry_id == e.id)
        .order_by(VehicleIntakeMedia.created_at)
    ).all()
    images = [media_out(m, now) for m in media if m.media_type == "image"]
    voices = [media_out(m, now) for m in media if m.media_type == "audio"]
    events = db.scalars(
        select(VehicleIntakeEvent)
        .where(VehicleIntakeEvent.intake_entry_id == e.id)
        .order_by(VehicleIntakeEvent.created_at)
    ).all()
    img_n = sum(1 for m in media if m.media_type == "image" and m.status == "active")
    aud_n = sum(1 for m in media if m.media_type == "audio" and m.status == "active")
    return {
        **entry_card(e, (img_n, aud_n)),
        "address": e.address,
        "email": e.email,
        "engine_number": e.engine_number,
        "chassis_number": e.chassis_number,
        "complaint_description": e.complaint_description,
        "updated_at": _iso(e.updated_at),
        "images": images,
        "voices": voices,
        "linked": {
            "job_id": e.linked_job_id,
            "job_card_id": e.linked_job_card_id,
            "assignment_id": e.linked_assignment_id,
            "linked_by_admin_id": e.linked_by_admin_id,
            "linked_by_admin_name": e.linked_by_admin_name,
            "linked_at": _iso(e.linked_at),
            "is_linked": bool(e.linked_job_card_id or e.linked_job_id or e.linked_assignment_id),
        },
        "retention": {
            "expires_at": _iso(e.expires_at),
            "days_left": rec_utils.days_left(e.expires_at) if e.expires_at else None,
        },
        "events": [{
            "actor_type": ev.actor_type, "actor_name": ev.actor_name,
            "event_type": ev.event_type, "message": ev.message,
            "created_at": _iso(ev.created_at),
        } for ev in events],
    }


# ── role-scoped grouping shapes ─────────────────────────────────────
def group_by_worker(db: Session, entries: list[VehicleIntakeEntry]) -> list[dict]:
    """Admin worker-wise view: each worker → their bike entries (current branch)."""
    cmap = counts_map(db, [e.id for e in entries])
    buckets: dict[str, dict] = {}
    for e in entries:
        key = e.worker_id or "—"
        g = buckets.setdefault(key, {
            "worker_id": e.worker_id, "worker_name": e.worker_name,
            "entry_count": 0, "latest_submitted_at": None, "entries": [],
        })
        g["entry_count"] += 1
        g["entries"].append(entry_card(e, cmap.get(e.id, (0, 0))))
        sub = _iso(e.submitted_at)
        if sub and (g["latest_submitted_at"] is None or sub > g["latest_submitted_at"]):
            g["latest_submitted_at"] = sub
    return sorted(buckets.values(),
                  key=lambda g: (g["latest_submitted_at"] or ""), reverse=True)


def group_by_branch(db: Session, entries: list[VehicleIntakeEntry],
                    now: datetime | None = None) -> list[dict]:
    """Master view: branch → worker → bike, with per-branch summary counts."""
    now = now or _now()
    today = now.date().isoformat()
    cmap = counts_map(db, [e.id for e in entries])
    bnames = {b.id: b.name for b in db.scalars(select(Branch)).all()}
    branches: dict[str, dict] = {}
    for e in entries:
        bkey = e.branch_id or "—"
        b = branches.setdefault(bkey, {
            "branch_id": e.branch_id, "branch_name": bnames.get(e.branch_id),
            "totals": {"entries": 0, "submitted_today": 0, "linked": 0, "unlinked": 0,
                       "images": 0, "voices": 0},
            "_workers": {},
        })
        img, aud = cmap.get(e.id, (0, 0))
        t = b["totals"]
        t["entries"] += 1
        t["images"] += img
        t["voices"] += aud
        linked = bool(e.linked_job_card_id or e.linked_job_id or e.linked_assignment_id)
        t["linked"] += 1 if linked else 0
        t["unlinked"] += 0 if linked else 1
        if _iso(e.submitted_at) and str(e.submitted_at)[:10] == today:
            t["submitted_today"] += 1
        wkey = e.worker_id or "—"
        w = b["_workers"].setdefault(wkey, {
            "worker_id": e.worker_id, "worker_name": e.worker_name,
            "entry_count": 0, "latest_submitted_at": None, "entries": [],
        })
        w["entry_count"] += 1
        w["entries"].append(entry_card(e, (img, aud)))
        sub = _iso(e.submitted_at)
        if sub and (w["latest_submitted_at"] is None or sub > w["latest_submitted_at"]):
            w["latest_submitted_at"] = sub
    out = []
    for b in branches.values():
        workers = sorted(b.pop("_workers").values(),
                         key=lambda g: (g["latest_submitted_at"] or ""), reverse=True)
        b["workers"] = workers
        out.append(b)
    return sorted(out, key=lambda b: (b["totals"]["entries"]), reverse=True)


# ── audit ───────────────────────────────────────────────────────────
def log_event(db: Session, entry_id: str, actor_type: str, actor_id: str | None,
              actor_name: str | None, event_type: str, message: str | None = None,
              meta: dict | None = None) -> None:
    db.add(VehicleIntakeEvent(
        intake_entry_id=entry_id, actor_type=actor_type, actor_id=actor_id,
        actor_name=actor_name, event_type=event_type, message=message,
        metadata_json=json.dumps(meta, default=str) if meta else None,
    ))


# ── 14-day retention cleanup (used by startup + the scheduler sweep) ─
def _delete_media_file(m: VehicleIntakeMedia) -> bool:
    """Best-effort verified deletion of a media file + its thumbnail. Returns True only if
    the primary file is actually gone afterwards."""
    ok = True
    for key in (m.file_path, m.thumbnail_path):
        if not key:
            continue
        p = (MEDIA_ROOT / key).resolve()
        try:
            root = MEDIA_ROOT.resolve()
            if (root in p.parents or p == root) and p.exists():
                p.unlink()
        except Exception:
            log.warning("intake: could not delete %s", key, exc_info=True)
    primary = local_path(m.file_path)
    if primary is not None:          # still present → deletion not verified
        ok = False
    return ok


def cleanup_expired(db: Session, now: datetime | None = None) -> dict:
    """Past the 14-day window: stop access + verified-delete the physical media, mark it
    deleted/expired, then ARCHIVE an entry once all of its media is gone. NEVER touches any
    core business record (job card / assignment / session / completion / invoice / approval).
    Idempotent + safe to run on startup and on a schedule."""
    now = now or _now()
    expired_media = 0
    deleted_files = 0
    archived_entries = 0

    # 1) Stop access + verified-delete the physical bytes of any media past its expiry.
    media = db.scalars(
        select(VehicleIntakeMedia).where(
            VehicleIntakeMedia.status.in_(("active",)),
            VehicleIntakeMedia.expires_at.is_not(None),
            VehicleIntakeMedia.expires_at <= now,
        )
    ).all()
    for m in media:
        gone = _delete_media_file(m)
        m.deleted_at = now
        if gone:
            m.status = "deleted"
            deleted_files += 1
        else:
            m.status = "expired"     # access stopped; file held (couldn't verify deletion)
        expired_media += 1

    # 2) Archive submitted/linked entries past their retention window that no longer have any
    # ACTIVE media — covers entries whose media we just expired AND media-less entries. The link
    # data + audit trail are preserved; no core business record is touched.
    for e in db.scalars(
        select(VehicleIntakeEntry).where(
            VehicleIntakeEntry.status.in_(("submitted", "linked")),
            VehicleIntakeEntry.expires_at.is_not(None),
            VehicleIntakeEntry.expires_at <= now,
            VehicleIntakeEntry.deleted_at.is_(None),
        )
    ).all():
        remaining = db.scalar(
            select(func.count()).select_from(VehicleIntakeMedia).where(
                VehicleIntakeMedia.intake_entry_id == e.id,
                VehicleIntakeMedia.status == "active",
            )
        )
        if not remaining:
            e.status = "archived"
            log_event(db, e.id, "system", None, None, "retention_archived",
                      "Temporary intake media expired; entry archived.")
            archived_entries += 1

    if expired_media or archived_entries:
        db.commit()
    return {"expired_media": expired_media, "deleted_files": deleted_files,
            "archived_entries": archived_entries}
