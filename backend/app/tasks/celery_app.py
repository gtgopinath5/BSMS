"""Celery application. Background workers run recording, notification and
expiry tasks. Optional in dev — the API works without a running worker
(tasks fall back to in-process no-ops)."""
from celery import Celery
from ..config import settings

celery = Celery("baywatch", broker=settings.celery_broker_url, backend=settings.celery_broker_url)
celery.conf.update(task_serializer="json", accept_content=["json"], timezone="UTC")

# Celery Beat: expire recordings daily at 02:00
celery.conf.beat_schedule = {
    "expire-old-recordings": {
        "task": "app.tasks.recording_tasks.expire_old_recordings",
        "schedule": 24 * 60 * 60,
    }
}
