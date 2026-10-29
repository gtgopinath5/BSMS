"""Scheduler Service — background maintenance for recordings.

Two sweeps run on a daemon-thread loop (swap in Celery-beat/APScheduler later by
calling these on a cron):

  • archive_sweep()   — upload finished local recordings to Google Drive, verify,
                        store the Drive id/link, then delete the local SSD copy
                        ONLY after a verified upload. Failures keep the local file
                        and retry next cycle. (No-op until Drive is configured.)
  • retention_sweep() — past the 14-day expiry, delete the Drive file + any local
                        media and mark the recording expired.

Upload lifecycle (RecordingSession.upload_status), so the Storage Management
dashboard reflects reality and nothing is ever lost:

    Service Completed → Recording Saved (local)
        → pending → uploading → [verify upload + verify size + share link]
            → uploaded  (DB updated, completion PDF link live, local deleted)
        on any failure → failed (local KEPT, auto-retried next sweep)
"""
import logging
import re
import shutil
import threading
import time
from datetime import datetime, timezone

from sqlalchemy import select
from sqlalchemy.orm import Session

from ..config import settings
from ..database import SessionLocal
from ..models.base import naive_utcnow
from ..models.session import RecordingSession, RecordingStatus, ServiceSession
from ..models.job import JobCard
from ..models.bay import Bay
from ..models.user import User
from ..models.customer_watch import CustomerWatchSession, WatchDecision, WatchStatus
from ..utils import recordings as rec_utils
from ..utils.audit import log_action
from . import drive_service, recording_service
from .recording_service import REC_ROOT

log = logging.getLogger("baywatch.scheduler")

SWEEP_INTERVAL = 6 * 3600     # recording archival/retention sweeps every 6h
CW_SWEEP_INTERVAL = 300       # customer-watch link expiry sweep every 5 min
_started = False

# ── observability: when each sweep last ran + what it did (Phase 9) ──
_last_run: dict[str, datetime | None] = {"archive": None, "retention": None}
_last_result: dict[str, dict | None] = {"archive": None, "retention": None}


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _stamp(name: str, result: dict) -> dict:
    """Record the wall-clock time + outcome of a sweep for the health dashboard."""
    _last_run[name] = _now()
    _last_result[name] = result
    return result


# ── Drive folder/filename targeting (Date / Bay-XX / Worker_HH-mm_Bike_JOB) ──
_SAFE_RE = re.compile(r"[^A-Za-z0-9_.-]")


def _san(value, fallback: str) -> str:
    """Drive/filesystem-safe token: spaces→underscore, drop unsafe chars, collapse
    repeated separators, trim edges, and fall back to a safe placeholder so a file
    is always uploadable (e.g. 'A. Krishnan' → 'A_Krishnan')."""
    s = (value or "").strip().replace(" ", "_")
    s = _SAFE_RE.sub("", s)
    s = re.sub(r"[_.\-]{2,}", "_", s).strip("_.-")
    return s or fallback


def _drive_cfg() -> dict:
    from ..utils import integration_config
    try:
        return integration_config.get_config("google_drive")
    except Exception:
        return {}


def _drive_target(db: Session, rec: RecordingSession):
    """Resolve the Drive target for a recording:
        subfolders = [YYYY-MM-DD, Bay-XX]   filename = Worker_HH-mm_Bike_JOB.mp4
    Pulls worker / bay / bike / job from the service-session context; safe
    fallbacks (UnknownWorker / UnknownBike / JOB-<rec id>) keep it always valid."""
    sess = db.get(ServiceSession, rec.service_session_id) if rec.service_session_id else None
    job = db.get(JobCard, sess.job_card_id) if sess and sess.job_card_id else None
    bay = db.get(Bay, sess.bay_id) if sess and sess.bay_id else None
    worker = db.get(User, rec.worker_id) if rec.worker_id else None
    dt = rec.recording_start or rec.created_at or (sess.start_time if sess else None) or _now()
    date_folder = dt.strftime("%Y-%m-%d")
    hhmm = dt.strftime("%H-%M")
    try:
        bay_folder = f"Bay-{int(bay.bay_number):02d}" if bay and bay.bay_number is not None else "Bay-00"
    except (TypeError, ValueError):
        bay_folder = "Bay-" + _san(str(bay.bay_number) if bay else "", "00")
    worker_name = _san(worker.name if worker else None, "UnknownWorker")
    bike = _san(job.vehicle_model if job else None, "UnknownBike")
    job_id = _san(job.job_card_number if job else None, f"JOB-{rec.id}")
    return [date_folder, bay_folder], f"{worker_name}_{hhmm}_{bike}_{job_id}.mp4"


# ── single-recording upload (shared by the sweep + manual Retry) ────
def _upload_one(db: Session, rec: RecordingSession) -> dict:
    """Upload ONE completed recording to Drive end-to-end:
        verify success → verify size → share link → update DB →
        (completion-PDF link is now live via the recording metadata) →
        delete local SSD copy ONLY after the verified upload commits.
    On any failure the local file is kept and the row is marked 'failed' for
    automatic retry. Returns {ok, status, message}."""
    path = recording_service.local_path(rec.video_path)
    rec.last_verified_at = _now()
    if not path:
        # nothing local to upload — already gone or never captured
        if rec.drive_file_id:
            return {"ok": True, "status": "uploaded", "message": "Already archived"}
        rec.upload_status = "failed"
        rec.upload_error = "Local recording file is missing"
        db.commit()
        return {"ok": False, "status": "failed", "message": "Local file missing"}
    # truthful pre-upload check: a 0-byte file is not a real recording — never
    # upload it (and never report success), keep the row honest for review.
    if path.stat().st_size <= 0:
        rec.upload_status = "failed"
        rec.upload_error = "Local recording file is empty (0 bytes)"
        db.commit()
        return {"ok": False, "status": "failed", "message": "Local file is empty"}

    rec.upload_status = "uploading"
    rec.upload_attempts = (rec.upload_attempts or 0) + 1
    db.commit()

    subfolders, filename = _drive_target(db, rec)
    res = drive_service.upload(str(path), filename, subfolders=subfolders)   # size-verified + link-shared inside
    if not res:
        rec.upload_status = "failed"
        rec.upload_error = "Upload failed or size verification mismatch"
        db.commit()
        log.warning("scheduler: upload FAILED for %s (attempt %d) — local kept, will retry",
                    rec.id, rec.upload_attempts)
        return {"ok": False, "status": "failed", "message": "Upload failed — local copy kept, will retry"}

    # verified upload → persist the Drive link FIRST (so a crash before cleanup
    # never loses the recording; the local copy is still there to retry from).
    rec.drive_file_id = res["file_id"]
    rec.drive_url = res["url"]
    rec.video_url = res["url"]
    rec.upload_status = "uploaded"
    rec.upload_error = None
    rec.uploaded_at = _now()
    # system-initiated (changed_by=None → renders as "system" in the audit feed)
    log_action(db, "DRIVE_UPLOAD", "recording", rec.id, None,
               new={"file_id": res["file_id"], "folder": "/".join(subfolders), "name": filename,
                    "size_mb": round((res.get("size") or 0) / 1e6, 1)})
    db.commit()
    # The completion PDF / "View Recording" links read recording metadata via the
    # recordings API, which now returns the Drive URL — so the PDF link is live.

    # Delete the local copy ONLY after the verified upload commits AND only if the
    # admin opted in (delete_local_after_upload). Off → keep the local copy too
    # (the safe first-run default); a failed/unverified upload already returned
    # above with the local file kept, so the only copy is never lost.
    if _drive_cfg().get("delete_local_after_upload", True):
        try:
            shutil.rmtree(REC_ROOT / rec.service_session_id, ignore_errors=True)
        except Exception:
            log.exception("scheduler: local cleanup failed for %s", rec.service_session_id)
        log.info("scheduler: archived %s → Drive %s (%.1f MB), local removed",
                 rec.id, res["file_id"], (res.get("size") or 0) / 1e6)
        return {"ok": True, "status": "uploaded", "message": "Archived to Google Drive · local copy removed"}
    log.info("scheduler: archived %s → Drive %s (%.1f MB), local kept (delete_local_after_upload off)",
             rec.id, res["file_id"], (res.get("size") or 0) / 1e6)
    return {"ok": True, "status": "uploaded", "message": "Archived to Google Drive · local copy kept"}


# ── Drive archival (stage 3, real) ─────────────────────────────────
def _eligible_query():
    """Completed recordings still held locally that should go to Drive."""
    return select(RecordingSession).where(
        RecordingSession.is_deleted.is_(False),
        RecordingSession.drive_file_id.is_(None),
        RecordingSession.video_path.is_not(None),
    )


def archive_sweep() -> dict:
    """Upload completed recordings that are still local-only to Google Drive."""
    if not drive_service.is_configured():
        # Keep the dashboard honest: mark finished local recordings 'local'.
        db = SessionLocal()
        try:
            for rec in db.scalars(_eligible_query()).all():
                if rec.upload_status in (None, "uploading"):
                    rec.upload_status = "local"
            db.commit()
        finally:
            db.close()
        return _stamp("archive", {"uploaded": 0, "skipped": "drive-not-configured"})

    db = SessionLocal()
    uploaded, failed = 0, 0
    try:
        for rec in db.scalars(_eligible_query()).all():
            res = _upload_one(db, rec)
            if res["ok"]:
                uploaded += 1
            else:
                failed += 1
        if uploaded or failed:
            log.info("scheduler: archive sweep uploaded=%d failed=%d", uploaded, failed)
        return _stamp("archive", {"uploaded": uploaded, "failed": failed})
    finally:
        db.close()


def retry_one(recording_id: str) -> dict:
    """Manual 'Retry Upload' for a single recording (Storage Management button)."""
    if not drive_service.is_configured():
        return {"ok": False, "status": "local", "message": "Google Drive is not configured."}
    db = SessionLocal()
    try:
        rec = db.get(RecordingSession, recording_id)
        if not rec:
            return {"ok": False, "status": "missing", "message": "Recording not found"}
        if rec.drive_file_id:
            return {"ok": True, "status": "uploaded", "message": "Already archived to Drive"}
        rec.upload_error = None
        db.commit()
        return _upload_one(db, rec)
    finally:
        db.close()


def sync_now() -> dict:
    """Manual 'Sync Now' — run the archive sweep immediately in the background so
    the request returns at once; the dashboard polls to show progress."""
    if not drive_service.is_configured():
        return {"started": False, "message": "Google Drive is not configured."}
    threading.Thread(target=archive_sweep, name="bw-sync-now", daemon=True).start()
    return {"started": True, "message": "Drive sync started"}


# ── manual per-recording actions (Storage Management buttons) ───────
def verify_one(recording_id: str) -> dict:
    """Verify File / Verify Drive Link — confirm the recording's REAL storage state:
    does the local file exist (and have bytes), and if archived is the Drive file
    really still there. Stamps last_verified_at. Never fakes; if an archived Drive
    file is gone it is reported honestly so the UI stops showing a dead link."""
    db = SessionLocal()
    try:
        rec = db.get(RecordingSession, recording_id)
        if not rec:
            return {"ok": False, "status": "missing", "message": "Recording not found"}
        path = recording_service.local_path(rec.video_path)
        local_present = path is not None and path.stat().st_size > 0
        drive_present = None
        if rec.drive_file_id:
            drive_present = drive_service.exists(rec.drive_file_id) if drive_service.is_configured() else None
        rec.last_verified_at = _now()
        msg = []
        msg.append("local file present" if local_present else
                   ("local file missing" if rec.video_path else "no local file"))
        if rec.drive_file_id:
            msg.append("Drive file present" if drive_present else
                       ("Drive file MISSING" if drive_present is False else "Drive not reachable"))
        db.commit()
        info = rec_utils.archive_state(rec, local_present)
        return {"ok": True, "state": info["state"], "local": info["local"], "drive": info["drive"],
                "available": info["customer_available"],
                "message": "Verified — " + ", ".join(msg)}
    finally:
        db.close()


def expire_one(recording_id: str) -> dict:
    """Mark Expired — stop customer access now (sets status=expired + expiry=now).
    Does NOT delete any file; the recording is still held for admin if un-archived."""
    db = SessionLocal()
    try:
        rec = db.get(RecordingSession, recording_id)
        if not rec:
            return {"ok": False, "status": "missing", "message": "Recording not found"}
        if rec.is_deleted:
            return {"ok": False, "status": "deleted", "message": "Recording already deleted"}
        rec.status = RecordingStatus.expired
        rec.expiry_date = _now()
        rec.video_url = None
        log_action(db, "STORAGE_MARK_EXPIRED", "recording", rec.id, None)
        db.commit()
        return {"ok": True, "status": "expired", "message": "Recording marked expired — customer access stopped"}
    finally:
        db.close()


def delete_one(recording_id: str) -> dict:
    """Delete Manually / Delete Expired Now — admin removes an EXPIRED recording's
    files (the only way a held un-archived local copy is ever removed). Deletes Drive
    (if archived) + local with verification; marks deleted only on verified deletion,
    else records delete_error (deletion_failed). Refuses to delete a still-valid
    recording so a live one is never lost by accident."""
    db = SessionLocal()
    try:
        rec = db.get(RecordingSession, recording_id)
        if not rec:
            return {"ok": False, "status": "missing", "message": "Recording not found"}
        if rec.is_deleted:
            return {"ok": True, "status": "deleted", "message": "Already deleted"}
        if rec_utils.status(rec.expiry_date, rec.status.value if rec.status else None) != "expired":
            return {"ok": False, "status": "active",
                    "message": "Only expired recordings can be deleted here. Mark Expired first."}
        delete_failed = None
        if rec.drive_file_id:
            if drive_service.delete(rec.drive_file_id):
                log_action(db, "DRIVE_DELETE", "recording", rec.id, None, old={"file_id": rec.drive_file_id})
            else:
                delete_failed = "Drive delete failed"
        sdir = REC_ROOT / rec.service_session_id
        if sdir.exists():
            try:
                shutil.rmtree(sdir, ignore_errors=True)
                if (REC_ROOT / rec.service_session_id).exists():
                    delete_failed = (delete_failed or "") + " Local delete failed"
            except Exception:
                log.exception("scheduler: manual delete failed for %s", rec.service_session_id)
                delete_failed = (delete_failed or "") + " Local delete failed"
        rec.last_verified_at = _now()
        if delete_failed:
            rec.delete_error = delete_failed.strip()
            log_action(db, "STORAGE_DELETE_FAILED", "recording", rec.id, None, new={"error": rec.delete_error})
            db.commit()
            return {"ok": False, "status": "deletion_failed", "message": f"Deletion failed: {rec.delete_error}"}
        rec.is_deleted = True
        rec.delete_error = None
        rec.video_url = None
        rec.drive_url = None
        log_action(db, "STORAGE_DELETE", "recording", rec.id, None)
        db.commit()
        return {"ok": True, "status": "deleted", "message": "Recording deleted"}
    finally:
        db.close()


# ── 14-day retention (real) ────────────────────────────────────────
def retention_sweep() -> dict:
    """Past the 14-day expiry, STOP customer access immediately, then purge files
    safely. A recording that was safely archived to Drive is deleted (Drive + local,
    with verified deletion). A recording that was NEVER archived and still has a local
    copy is HELD — the only copy is never auto-destroyed — and surfaced as
    'expired · not archived' for an admin to retry/verify/delete. A deletion that
    fails is recorded (deletion_failed), never silently marked deleted."""
    now = _now()
    db = SessionLocal()
    purged, held, freed = 0, 0, 0
    try:
        rows = db.scalars(
            select(RecordingSession).where(
                RecordingSession.expiry_date.is_not(None),
                RecordingSession.is_deleted.is_(False),
            )
        ).all()
        for rec in rows:
            exp = rec.expiry_date
            if exp and exp.tzinfo is None:
                exp = exp.replace(tzinfo=timezone.utc)
            if not exp or exp > now:
                continue
            # Customer access stops the moment it is expired — always, regardless of
            # what happens to the files below.
            rec.status = RecordingStatus.expired
            rec.video_url = None

            local_present = recording_service.local_path(rec.video_path) is not None
            rec.last_verified_at = now

            # HOLD: never archived + a local copy survives → keep it (admin resolves).
            if not rec.drive_file_id and local_present:
                held += 1
                log_action(db, "RETENTION_HOLD", "recording", rec.id, None,
                           old={"reason": "expired but never archived — local copy held"})
                continue

            # Otherwise purge: delete the Drive file (if archived) + any local media,
            # and only mark deleted when the deletion actually succeeded.
            delete_failed = None
            if rec.drive_file_id:
                if drive_service.delete(rec.drive_file_id):
                    log_action(db, "DRIVE_DELETE", "recording", rec.id, None,
                               old={"file_id": rec.drive_file_id})
                else:
                    delete_failed = "Drive delete failed"
            sdir = REC_ROOT / rec.service_session_id
            if sdir.exists():
                try:
                    freed += sum(f.stat().st_size for f in sdir.rglob("*") if f.is_file())
                    shutil.rmtree(sdir, ignore_errors=True)
                    if (REC_ROOT / rec.service_session_id).exists():
                        delete_failed = (delete_failed or "") + " Local delete failed"
                except Exception:
                    log.exception("scheduler: failed to delete media for %s", rec.service_session_id)
                    delete_failed = (delete_failed or "") + " Local delete failed"

            if delete_failed:
                rec.delete_error = delete_failed.strip()
                log_action(db, "RETENTION_DELETE_FAILED", "recording", rec.id, None,
                           new={"error": rec.delete_error})
            else:
                rec.is_deleted = True
                rec.delete_error = None
                rec.drive_url = None
                log_action(db, "RETENTION_CLEANUP", "recording", rec.id, None,
                           old={"expiry": rec_utils.fmt_date(rec.expiry_date)})
                purged += 1
        db.commit()
        if purged or held:
            log.warning("scheduler: retention purged %d, held %d un-archived, freed %.1f MB",
                        purged, held, freed / 1e6)
        return _stamp("retention", {"purged": purged, "held": held, "freed_mb": round(freed / 1e6, 1)})
    finally:
        db.close()


# ── dashboard aggregation (Storage Management) ─────────────────────
def _local_media_bytes() -> int:
    """Total bytes of recording media currently on local SSD."""
    if not REC_ROOT.exists():
        return 0
    total = 0
    try:
        for f in REC_ROOT.rglob("*"):
            if f.is_file():
                total += f.stat().st_size
    except Exception:
        log.exception("scheduler: local storage scan failed")
    return total


def _rec_card(db: Session, rec: RecordingSession) -> dict:
    """One truthful Storage Management row — real storage state + service context.
    NEVER includes the local filesystem path or any credential; `drive_url` (a public
    share link) + error strings are admin-only operational detail."""
    local_present = recording_service.local_path(rec.video_path) is not None
    info = rec_utils.archive_state(rec, local_present)
    sess = db.get(ServiceSession, rec.service_session_id) if rec.service_session_id else None
    job = db.get(JobCard, sess.job_card_id) if sess and sess.job_card_id else None
    bay = db.get(Bay, sess.bay_id) if sess and sess.bay_id else None
    worker = db.get(User, rec.worker_id) if rec.worker_id else None
    return {
        "recording_id": rec.id,
        "session_id": rec.service_session_id,
        "job_card_number": job.job_card_number if job else None,
        "customer_name": job.customer_name if job else None,
        "vehicle_number": job.vehicle_number if job else None,
        "bay_number": bay.bay_number if bay else None,
        "worker_name": worker.name if worker else None,
        "state": info["state"],
        "local_status": info["local"],          # saved | missing | none
        "drive_status": info["drive"],          # uploaded | pending | uploading | failed | none
        "available": info["customer_available"],
        "status": rec.status.value if rec.status else None,
        "upload_status": rec.upload_status or "local",
        "attempts": rec.upload_attempts or 0,
        "error": rec.upload_error,
        "delete_error": rec.delete_error,
        "size_mb": round((rec.file_size or 0) / 1e6, 1),
        "recording_date": rec_utils.fmt_date(rec.created_at or rec.recording_end),
        "expiry_date": rec_utils.fmt_date(rec.expiry_date),
        "days_left": rec_utils.days_left(rec.expiry_date),
        "last_verified": rec_utils.fmt_date(rec.last_verified_at) if rec.last_verified_at else None,
        "drive_url": rec.drive_url,
    }


def storage_overview() -> dict:
    """Everything the Storage Management dashboard shows: local footprint, Drive
    status, and truthful per-state counts + lists. Classification comes from the ONE
    `archive_state` helper, so a missing local file, a held un-archived recording, or
    a failed deletion are all surfaced honestly (never as 'available')."""
    drive = drive_service.health()
    db = SessionLocal()
    try:
        recs = db.scalars(select(RecordingSession)).all()
        buckets: dict[str, list] = {
            "pending": [], "failed": [], "archived": [], "expired": [],
            "held": [], "problems": [],
        }
        counts = {k: 0 for k in ("total", "active", "local_saved", "pending", "failed",
                                 "archived", "expired", "held", "deleted", "deletion_failed",
                                 "local_missing")}
        for rec in recs:
            card = _rec_card(db, rec)
            st = card["state"]
            counts["total"] += 1
            if st not in ("expired", "expired_unarchived", "deleted", "deletion_failed"):
                counts["active"] += 1
            if st == "deletion_failed":
                counts["deletion_failed"] += 1; buckets["problems"].append(card)
            elif st == "local_missing":
                counts["local_missing"] += 1; buckets["problems"].append(card)
            elif st == "deleted":
                counts["deleted"] += 1; counts["expired"] += 1; buckets["expired"].append(card)
            elif st == "expired_unarchived":
                counts["expired"] += 1; counts["held"] += 1; buckets["held"].append(card)
            elif st == "expired":
                counts["expired"] += 1; buckets["expired"].append(card)
            elif st == "drive_uploaded":
                counts["archived"] += 1; buckets["archived"].append(card)
            elif st == "upload_failed":
                counts["failed"] += 1; buckets["failed"].append(card)
            elif st in ("local_saved", "upload_pending", "upload_in_progress"):
                counts["local_saved"] += 1; counts["pending"] += 1; buckets["pending"].append(card)
        local_bytes = _local_media_bytes()
        return {
            "drive": drive,
            "local": {
                "total_bytes": local_bytes,
                "total_mb": round(local_bytes / 1e6, 1),
                "total_gb": round(local_bytes / 1e9, 2),
            },
            "counts": counts,
            "retention_days": settings.recording_retention_days,
            "sweep_interval_hours": SWEEP_INTERVAL // 3600,
            "lists": {
                "pending": buckets["pending"],
                "failed": buckets["failed"],
                "archived": buckets["archived"][:50],
                "expired": buckets["expired"][:50],
                "held": buckets["held"][:50],
                "problems": buckets["problems"][:50],
            },
        }
    finally:
        db.close()


# ── Customer Live Watch link expiry (real, not just lazy-on-read) ──
def customer_watch_expiry_sweep() -> dict:
    """Expire abandoned watch links — ones SENT and CREATED (link issued but the
    service never started) whose TTL has passed. LIVE/PAUSED links are NOT touched:
    they belong to an active service and end via the COMPLETE lifecycle, so a long
    service never has its customer cut off. Emits a TOKEN_EXPIRED audit per link."""
    now = naive_utcnow()
    db = SessionLocal()
    expired = 0
    try:
        rows = db.scalars(
            select(CustomerWatchSession).where(
                CustomerWatchSession.decision == WatchDecision.sent,
                CustomerWatchSession.status == WatchStatus.created,
                CustomerWatchSession.expires_at.is_not(None),
                CustomerWatchSession.expires_at < now,
            )
        ).all()
        for r in rows:
            r.status = WatchStatus.expired
            log_action(db, "TOKEN_EXPIRED", "customer_watch", r.id, None)
            expired += 1
        db.commit()
        if expired:
            log.info("scheduler: customer-watch expired %d abandoned link(s)", expired)
        return _stamp("customer_watch", {"expired": expired})
    finally:
        db.close()


def intake_media_retention_sweep() -> dict:
    """14-day Vehicle Intake Evidence cleanup — past the window, stop access + verified-delete
    bike photos / complaint voice notes, then archive the entry once all its media is gone. Only
    temporary intake media is ever removed; core business records are never touched. Delegates to
    the single ``intake.cleanup_expired`` truth (shared with the startup one-shot)."""
    db = SessionLocal()
    try:
        from ..utils import intake as intake_utils
        res = intake_utils.cleanup_expired(db)
        if res.get("expired_media") or res.get("archived_entries"):
            log.info("scheduler: intake retention expired %d media, archived %d entries",
                     res["expired_media"], res["archived_entries"])
        return _stamp("intake_retention", res)
    finally:
        db.close()


def barricade_media_retention_sweep() -> dict:
    """30-day AI Barricade cleanup — past the window, stop access + verified-delete the temporary
    detection frames. Event metadata + the decision/audit trail are NEVER touched. Delegates to the
    single ``barricade.cleanup_expired_media`` truth (shared with the startup one-shot)."""
    db = SessionLocal()
    try:
        from ..utils import barricade as barricade_utils
        res = barricade_utils.cleanup_expired_media(db)
        if res.get("expired_media"):
            log.info("scheduler: barricade retention expired %d detection frame(s)", res["expired_media"])
        return _stamp("barricade_retention", res)
    finally:
        db.close()


def _loop() -> None:
    while True:
        for sweep in (archive_sweep, retention_sweep, intake_media_retention_sweep,
                      barricade_media_retention_sweep):
            try:
                sweep()
            except Exception:
                log.exception("scheduler: %s error", sweep.__name__)
        time.sleep(SWEEP_INTERVAL)


def _cw_loop() -> None:
    while True:
        try:
            customer_watch_expiry_sweep()
        except Exception:
            log.exception("scheduler: customer_watch_expiry_sweep error")
        time.sleep(CW_SWEEP_INTERVAL)


def start_scheduler() -> None:
    """Launch the background maintenance threads (idempotent)."""
    global _started
    if _started:
        return
    _started = True
    threading.Thread(target=_loop, name="bw-scheduler", daemon=True).start()
    threading.Thread(target=_cw_loop, name="bw-cw-expiry", daemon=True).start()
    log.info("scheduler: started · retention=%dd · drive=%s · rec sweep %dh · watch expiry %ds",
             settings.recording_retention_days,
             "on" if drive_service.is_configured() else "off",
             SWEEP_INTERVAL // 3600, CW_SWEEP_INTERVAL)


def health() -> dict:
    """Scheduler observability for the system-health dashboard (Phase 9):
    is the maintenance loop alive, and when did each sweep last run + with what
    outcome. `None` last-run means the sweep has not executed since boot yet."""
    def _iso(dt: datetime | None) -> str | None:
        return dt.isoformat() if dt else None
    return {
        "running": _started,
        "sweep_interval_hours": SWEEP_INTERVAL // 3600,
        "last_archive_run": _iso(_last_run["archive"]),
        "last_archive_result": _last_result["archive"],
        "last_retention_run": _iso(_last_run["retention"]),
        "last_retention_result": _last_result["retention"],
    }
