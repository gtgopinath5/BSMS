"""Customer Live Watch — PUBLIC plane (no auth, token-gated).

Mounted at /customer-watch (NOT under /api/v1). The customer only ever sees
/customer-watch/{token}/… — the opaque token is resolved to a ServiceSession server-side,
so camera ids, branch ids, internal API URLs and the SS-… session id are never exposed. The
live HLS feed is proxied through this token (segment URIs rewritten to stay under it). Ended
or expired links return 410 Gone. A visible watermark — not impossible "screenshot blocking" —
is applied client-side on the page.
"""
import hashlib
from datetime import timezone
from pathlib import Path

from fastapi import APIRouter, HTTPException, Response, status
from fastapi.responses import FileResponse, HTMLResponse
from sqlalchemy import select
from sqlalchemy.orm import Session
from fastapi import Depends

from ..database import get_db
from ..models.base import utcnow, naive_utcnow
from ..models.customer_watch import (
    CustomerWatchSession, WatchDecision, WatchStatus, WATCH_DEAD,
)
from ..models.session import ServiceSession, RecordingSession
from ..models.job import JobCard
from ..utils.audit import log_action
from ..utils import timer, recordings
from ..services import streaming_service, recording_service, workflow_engine, camera_service

router = APIRouter()

_PAGE = Path(__file__).resolve().parents[3] / "frontend" / "watch" / "index.html"
_FALLBACK = ("<!doctype html><meta charset=utf-8><title>Live service</title>"
             "<body style='font:16px system-ui;background:#0b0b0d;color:#eee;"
             "display:grid;place-items:center;height:100vh;margin:0'>"
             "<p>Loading your live service…</p></body>")


def _hash(raw: str) -> str:
    return hashlib.sha256(raw.encode()).hexdigest()


def _lookup(db: Session, token: str) -> CustomerWatchSession | None:
    """Resolve a raw token to its SENT watch row, applying lazy TTL expiry."""
    row = db.scalar(select(CustomerWatchSession).where(
        CustomerWatchSession.token_hash == _hash(token),
        CustomerWatchSession.decision == WatchDecision.sent,
    ))
    if not row:
        return None
    # expires_at is stored naive-UTC (TIMESTAMP WITHOUT TIME ZONE). Compare against a
    # naive-UTC now; coerce any stray aware value to naive-UTC so the compare never raises.
    # Only a CREATED (issued-but-never-started) link expires by TTL — a LIVE/PAUSED link
    # belongs to an active service and ends via COMPLETE, so a long service is never cut off.
    exp = row.expires_at
    if exp is not None and exp.tzinfo is not None:
        exp = exp.astimezone(timezone.utc).replace(tzinfo=None)
    if row.status == WatchStatus.created and exp and naive_utcnow() > exp:
        row.status = WatchStatus.expired
        log_action(db, "TOKEN_EXPIRED", "customer_watch", row.id, None)
        db.commit()
    return row


def _require_live(db: Session, token: str) -> CustomerWatchSession:
    """For stream/segment requests: 404 unknown, 410 ended/expired, 404 when not currently live."""
    row = _lookup(db, token)
    if not row:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Invalid link")
    if row.status in WATCH_DEAD:
        raise HTTPException(status.HTTP_410_GONE, "This live session has ended")
    if row.status != WatchStatus.live:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "No live stream right now")
    return row


# ── customer state (polled by the page) ────────────────────────────────────
# Soft, customer-facing wording only — never technical (no MQTT/FFmpeg/RTSP).
_CUST_MSG = {
    "waiting":   "Your service has not started yet.",
    "live":      "Your service is in progress.",
    "paused":    "Your service is temporarily paused by the workshop.",
    "completed": "Your service is complete.",
}


def _safe_state_payload(db: Session, row: CustomerWatchSession) -> dict:
    """Customer-facing state — a strict ALLOWLIST of safe fields. The customer sees
    only their own service: status, vehicle, their approved estimate, live remaining
    time, and (on completion) recording availability. NEVER any internal id, camera
    URL, RTSP/MQTT detail, storage path, or token. Read-only."""
    ui = ("live" if row.status == WatchStatus.live
          else "paused" if row.status == WatchStatus.paused
          else "completed" if row.status == WatchStatus.completed
          else "waiting")           # CREATED — service not started yet
    sess = db.get(ServiceSession, row.service_session_id) if row.service_session_id else None
    job = db.get(JobCard, row.job_card_id) if row.job_card_id else None
    out = {
        "state": ui,
        "service_message": _CUST_MSG.get(ui, ""),
        "customer_name": row.customer_name,
        "vehicle_number": row.vehicle_number,
        "vehicle_model": job.vehicle_model if job else None,
        "service_type": job.service_type if job else None,
        "job_card_number": job.job_card_number if job else None,
        "session_display_id": row.id,               # public CW-… id (safe watermark)
        "server_time": utcnow().isoformat(),
    }
    if sess:
        out["estimated_minutes"] = (sess.estimated_duration or 0) // 60
        # The customer's OWN approved estimate (safe to show them); falls back silently.
        _m, est_source, approved_cost = workflow_engine.resolve_estimate(db, job, None)
        out["estimate_source"] = est_source
        if est_source == "approved" and approved_cost is not None:
            out["approved_cost"] = approved_cost
        if ui == "live":
            ts = timer.get_state(sess.bay_id)
            out["remaining_seconds"] = max(0, ts.get("remaining") or 0)
            out["elapsed_seconds"] = max(0, ts.get("elapsed") or 0)
    # On completion, surface recording availability honestly (no fake link). A bay
    # with no paired camera never produced the customer's actual service recording
    # (only a synthetic test source), so it is truthfully "not available".
    if ui == "completed":
        rec = db.scalar(select(RecordingSession).where(
            RecordingSession.service_session_id == row.service_session_id)) if row.service_session_id else None
        has_camera = bool(sess and camera_service.get_camera(db, sess.bay_id) is not None)
        local_present = recording_service.local_path(rec.video_path) is not None if rec else False
        if rec and not rec.is_deleted and has_camera:
            st = recordings.status(rec.expiry_date, rec.status.value)
            if st == "expired":
                out.update({"recording_available": False, "recording_status": "expired", "recording_url": None,
                            "service_message": "Your service is complete. The recording for this service has expired."})
            elif recordings.is_available(rec, local_present):
                out.update({"recording_available": True, "recording_status": st,
                            "recording_url": recordings.signed_url(rec.id, rec.expiry_date),
                            "recording_expiry": recordings.fmt_date(rec.expiry_date),
                            "service_message": "Your service is complete. Your service recording is available below."})
            else:
                # not expired, but no real copy exists yet — never hand out a broken link
                out.update({"recording_available": False, "recording_status": "none", "recording_url": None,
                            "service_message": "Your service is complete. A recording was not available for this service."})
        else:
            out.update({"recording_available": False, "recording_status": "none", "recording_url": None,
                        "service_message": "Your service is complete. A recording was not available for this service."})
    return out


@router.get("/{token}/state")
def state(token: str, db: Session = Depends(get_db)):
    row = _lookup(db, token)
    if not row:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Invalid link")
    # A truly dead link (past its TTL) is gone; a COMPLETED service still shows the
    # customer a safe completion summary + recording status while the link is valid.
    if row.status == WatchStatus.expired:
        raise HTTPException(status.HTTP_410_GONE, "This live link has expired")
    return {"success": True, "data": _safe_state_payload(db, row), "message": ""}


# ── HLS proxy (token in the path; session id stays server-side) ─────────────
@router.get("/{token}/stream.m3u8")
def playlist(token: str, db: Session = Depends(get_db)):
    row = _require_live(db, token)
    path = streaming_service.live_playlist(row.service_session_id)
    if not path or not path.exists():
        raise HTTPException(status.HTTP_404_NOT_FOUND, "No live stream right now")
    lines = []
    for line in path.read_text().splitlines():
        s = line.strip()
        if s and not s.startswith("#") and s.endswith(".ts"):
            line = f"seg/{s}"       # → /customer-watch/{token}/seg/{name}.ts (same origin)
        lines.append(line)
    return Response("\n".join(lines) + "\n",
                    media_type="application/vnd.apple.mpegurl",
                    headers={"Cache-Control": "no-store"})


@router.get("/{token}/seg/{segment}")
def segment(token: str, segment: str, db: Session = Depends(get_db)):
    row = _require_live(db, token)
    if not segment.endswith(".ts") or "/" in segment or ".." in segment:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Not found")
    seg = recording_service.live_hls_path(row.service_session_id).parent / segment
    if not seg.exists():
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Segment expired")
    return FileResponse(str(seg), media_type="video/mp2t",
                        headers={"Cache-Control": "no-store"})


# ── the standalone customer page (kept last so it doesn't shadow the routes above) ──
@router.get("/{token}", response_class=HTMLResponse)
def page(token: str):
    if _PAGE.exists():
        return FileResponse(str(_PAGE), media_type="text/html",
                            headers={"Cache-Control": "no-store"})
    return HTMLResponse(_FALLBACK)
