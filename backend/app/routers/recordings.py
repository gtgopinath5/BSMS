"""Authorized recording playback (Stage 3).

    GET /api/v1/recordings/{recording_id}          → JWT + role + ownership; returns
                                                      metadata + a short-lived signed
                                                      playback URL (or 'expired').
    GET /api/v1/recordings/{recording_id}/stream    → token-authorized; serves the
                                                      local MP4 with HTTP Range (seek),
                                                      or 302-redirects to Google Drive
                                                      once archived. Expired → 410 with
                                                      a friendly message (never a broken
                                                      page). Raw SSD paths never exposed.

Access: admin → own branch; master → all branches; worker → own completed jobs.
"""
import logging

from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from fastapi.responses import FileResponse, RedirectResponse, StreamingResponse
from sqlalchemy import text
from sqlalchemy.orm import Session

from ..database import get_db, engine
from ..models.bay import Bay
from ..models.session import RecordingSession
from ..models.user import User
from ..schemas.common import ok
from ..services import recording_service
from ..utils import recordings
from ..utils.auth import get_current_user

log = logging.getLogger("baywatch.recordings")
router = APIRouter()

_REC_MIGRATED = False


def ensure_recording_schema() -> None:
    """Add the Stage-3 columns to an existing recording_sessions table. Idempotent."""
    global _REC_MIGRATED
    if _REC_MIGRATED:
        return
    dialect = engine.dialect.name
    cols = [("video_path", "VARCHAR"), ("file_size", "INTEGER"),
            ("drive_file_id", "VARCHAR"), ("drive_url", "VARCHAR"),
            ("upload_status", "VARCHAR"), ("upload_attempts", "INTEGER"),
            ("upload_error", "VARCHAR"), ("uploaded_at", "TIMESTAMP"),
            ("delete_error", "VARCHAR"), ("last_verified_at", "TIMESTAMP")]
    with engine.begin() as conn:
        try:
            if dialect == "postgresql":
                existing = {r[0] for r in conn.execute(text(
                    "SELECT column_name FROM information_schema.columns WHERE table_name='recording_sessions'"))}
            else:
                existing = {r[1] for r in conn.execute(text("PRAGMA table_info(recording_sessions)"))}
        except Exception:
            existing = set()
        for name, ddl in cols:
            if name not in existing:
                try:
                    conn.execute(text(f"ALTER TABLE recording_sessions ADD COLUMN {name} {ddl}"))
                except Exception:
                    pass
    _REC_MIGRATED = True


def _rec_branch(db: Session, rec: RecordingSession) -> str | None:
    """A recording's branch, resolved via its service session's bay (RecordingSession
    has no bay_id of its own)."""
    from ..models.session import ServiceSession
    sess = db.get(ServiceSession, rec.service_session_id) if rec.service_session_id else None
    bay = db.get(Bay, sess.bay_id) if sess and sess.bay_id else None
    return bay.branch_id if bay else None


def _can_access(db: Session, user: User, rec: RecordingSession) -> bool:
    role = user.role.value
    if role == "master_admin":          # Master sees every branch's recordings
        return True
    if role == "admin":                 # Admin only within their own branch
        return _rec_branch(db, rec) == user.branch_id
    if role == "worker":                # Worker only their own recordings
        return rec.worker_id == user.id
    return False


@router.get("/{recording_id}")
def get_recording(recording_id: str, db: Session = Depends(get_db), me: User = Depends(get_current_user)):
    rec = db.get(RecordingSession, recording_id)
    if not rec:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Recording not found")
    if not _can_access(db, me, rec):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Not allowed to view this recording")

    st = recordings.status(rec.expiry_date, rec.status.value)
    base = {
        "recording_id": rec.id, "session_id": rec.service_session_id,
        "status": st,
        "recording_date": recordings.fmt_date(rec.created_at or rec.recording_end),
        "duration": recordings.duration_full(rec.duration_seconds),
        "expiry_date": recordings.fmt_date(rec.expiry_date),
        "days_left": recordings.days_left(rec.expiry_date),
        "file_size_mb": round((rec.file_size or 0) / 1e6, 1),
        "drive_url": rec.drive_url,
    }
    if st == "expired" or rec.is_deleted:
        return ok({**base, "available": False,
                   "message": "This service recording has expired and is no longer available."})

    # Truthful availability — not just "not expired": a real copy must exist
    # (archived on Drive, or the local file is actually present). A missing file
    # is reported unavailable instead of handing out a link that 404s.
    local_present = recording_service.local_path(rec.video_path) is not None
    if not recordings.is_available(rec, local_present):
        return ok({**base, "available": False,
                   "message": "This service recording is not available."})

    tok, exp = recordings.playback_token(rec.id, rec.expiry_date)
    return ok({**base, "available": True,
               "playback_url": f"/api/v1/recordings/{rec.id}/stream?token={tok}&exp={exp}"})


def _range_response(path, request: Request):
    """Serve a file with HTTP Range support so the browser <video> can seek."""
    file_size = path.stat().st_size
    rng = request.headers.get("range")
    common = {"Accept-Ranges": "bytes", "Cache-Control": "private, no-store"}
    if not rng:
        return FileResponse(str(path), media_type="video/mp4", headers=common)
    try:
        start_s, end_s = rng.split("=")[1].split("-")
        start = int(start_s) if start_s else 0
        end = int(end_s) if end_s else file_size - 1
    except Exception:
        start, end = 0, file_size - 1
    start = max(0, start)
    end = min(end, file_size - 1)
    length = max(0, end - start + 1)

    def _iter():
        with open(path, "rb") as f:
            f.seek(start)
            remaining = length
            while remaining > 0:
                chunk = f.read(min(64 * 1024, remaining))
                if not chunk:
                    break
                remaining -= len(chunk)
                yield chunk

    headers = {**common, "Content-Range": f"bytes {start}-{end}/{file_size}",
               "Content-Length": str(length)}
    return StreamingResponse(_iter(), status_code=206, media_type="video/mp4", headers=headers)


@router.get("/{recording_id}/stream")
def stream_recording(recording_id: str, request: Request,
                     token: str = Query(""), exp: str = Query(""),
                     db: Session = Depends(get_db)):
    rec = db.get(RecordingSession, recording_id)
    if not rec:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Recording not found")
    # expired → friendly 410 (old links never show a broken page)
    if recordings.status(rec.expiry_date, rec.status.value) == "expired" or rec.is_deleted:
        raise HTTPException(status.HTTP_410_GONE,
                            "This service recording has expired and is no longer available.")
    if not recordings.verify_playback(recording_id, token, exp):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Invalid or expired playback link")
    # archived to Drive → redirect (no local copy to serve)
    if rec.drive_url:
        return RedirectResponse(rec.drive_url, status_code=302)
    path = recording_service.local_path(rec.video_path)
    if not path:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Recording file is not available")
    return _range_response(path, request)
