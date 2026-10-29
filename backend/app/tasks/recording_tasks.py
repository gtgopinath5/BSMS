"""Recording capture + retention tasks.

Real capture uses FFmpeg against each bay's RTSP stream and uploads to MinIO
(see app/utils/camera.py). These are wired through Celery; in dev without a
worker the workflow engine simply tracks recording metadata.
"""
from datetime import datetime, timezone
from .celery_app import celery
from ..database import SessionLocal
from ..models.session import RecordingSession, RecordingStatus
from ..utils import recordings, storage


@celery.task
def start_bay_recording(bay_id: str, session_id: str):
    from ..utils import camera
    return camera.start_recording(bay_id, session_id)


@celery.task
def stop_bay_recording(bay_id: str, session_id: str):
    from ..utils import camera
    result = camera.stop_recording(bay_id, session_id)   # -> {video_url, duration}
    db = SessionLocal()
    try:
        rec = db.get(RecordingSession, None)  # noqa - looked up by session in real impl
    finally:
        db.close()
    return result


@celery.task
def generate_completion_pdf(session_id: str):
    from ..utils import pdf_generator
    return pdf_generator.generate_completion_pdf(session_id)


@celery.task
def expire_old_recordings():
    """Daily (Celery Beat): delete expired recordings from storage, mark expired.
    The DB record is preserved for history (is_deleted=True)."""
    db = SessionLocal()
    removed = 0
    try:
        now = datetime.now(timezone.utc)
        rows = db.query(RecordingSession).filter(
            RecordingSession.expiry_date.isnot(None),
            RecordingSession.is_deleted.is_(False),
        ).all()
        for rec in rows:
            if recordings.status(rec.expiry_date, now=now) == "expired":
                if rec.video_url:
                    try:
                        bucket, _, key = rec.video_url.partition("/")
                        storage.delete_file(bucket, key)
                    except Exception:
                        pass
                rec.status = RecordingStatus.expired
                rec.is_deleted = True
                removed += 1
        db.commit()
    finally:
        db.close()
    return {"expired": removed}
