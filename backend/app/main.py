"""Baywatch Service OS — FastAPI backend entry point."""
import logging
import sys
from contextlib import asynccontextmanager

# Route our own logs (incl. timer recovery) through a visible INFO handler.
_bw_log = logging.getLogger("baywatch")
_bw_log.setLevel(logging.INFO)
if not _bw_log.handlers:
    _h = logging.StreamHandler(sys.stdout)
    _h.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(name)s: %(message)s", "%H:%M:%S"))
    _bw_log.addHandler(_h)
    _bw_log.propagate = False

from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, FileResponse
from fastapi.staticfiles import StaticFiles
from fastapi.exceptions import RequestValidationError
from starlette.exceptions import HTTPException as StarletteHTTPException

from .config import settings
from .database import init_db
from .routers import (
    auth, workers, bays, parts, jobs, queue as queue_router,
    bay_dashboard, worker as worker_router, reports, master, ws, leave,
    cameras, streaming, recordings as recordings_router, storage_admin, timers,
    platform as platform_router, branches as branches_router,
    customer_watch as customer_watch_router, watch_public,
    integrations as integrations_router,
    customer_approvals as customer_approvals_router, approval_public,
    test_drives as test_drives_router,
    vehicle_intake as vehicle_intake_router,
    barricade as barricade_router,
    worker_transition as worker_transition_router,
)
from .utils import storage, timer


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Production config validation — warns always; in APP_ENV=production a genuine
    # blocker (weak secret, SQLite, default seed, localhost watch url, …) fails fast.
    # Optional integrations are never blockers. No secret value is ever logged.
    from .startup import validate_startup
    validate_startup()
    init_db()                       # create_all (idempotent, never drops) — see DEPLOYMENT_RUNBOOK.md
    from .routers.parts import ensure_parts_schema
    from .routers.jobs import ensure_job_schema
    from .routers.bays import ensure_bay_schema
    from .routers.recordings import ensure_recording_schema
    from .routers.workers import ensure_user_schema
    from .routers.timers import ensure_timer_schema
    from .routers.cameras import ensure_camera_schema
    from .routers.test_drives import ensure_test_drive_schema
    from .routers.customer_approvals import ensure_customer_approval_schema
    from .routers.vehicle_intake import ensure_intake_schema
    from .routers.barricade import ensure_barricade_schema
    from .routers.worker_transition import ensure_worker_transition_schema
    ensure_parts_schema()           # add columns introduced after first release
    ensure_job_schema()
    ensure_bay_schema()
    ensure_recording_schema()
    ensure_user_schema()            # worker HR columns: address, emergency_contact, last_login
    ensure_timer_schema()           # timer admin-command telemetry: last_command/_at/_error
    ensure_camera_schema()          # camera fields: brand/rtsp_port/rtsp_path/last_error
    ensure_test_drive_schema()      # bike test drive tracking tables (additive)
    ensure_customer_approval_schema()  # approval cost-detail + Phase-2 version/link/retention cols (additive)
    ensure_intake_schema()          # vehicle intake evidence tables (additive)
    ensure_barricade_schema()       # AI barricade detection tables (additive)
    ensure_worker_transition_schema()  # worker bay-to-bay delay reason table (additive)
    _customer_approval_cleanup()    # Phase 2: soft-expire approval temp history past 14 days
    _intake_cleanup()               # vehicle intake: expire/purge temp media past 14 days
    _barricade_cleanup()            # barricade: purge temp detection frames past 30 days
    storage.ensure_buckets()        # no-op if MinIO not configured
    if settings.seed_on_startup:
        from .seed import seed
        seed()
    # ── recover persistent bay timers from Redis ──────────────────
    timer.restore_all()
    _reconcile_sessions()
    # ── recording pipeline: reap orphan ffmpeg + start retention sweeper ──
    from .services import recording_service, scheduler_service, mqtt_service
    recording_service.restore()
    scheduler_service.start_scheduler()
    # ── MQTT: connect to broker + start the 1s ESP32 state publisher ──
    # On connect it republishes every active timer's state, so any ESP32 that
    # survived the backend restart is immediately resynced (no drift).
    mqtt_service.start()
    yield


def _customer_approval_cleanup() -> None:
    """Phase 2 retention: soft-expire approval links/records past their 14-day window. Safe +
    idempotent; never touches core business data. Never blocks startup."""
    import logging
    from .database import SessionLocal
    from .utils import approval as A
    db = SessionLocal()
    try:
        res = A.cleanup_expired(db)
        if res.get("expired_links") or res.get("expired_requests"):
            logging.getLogger("baywatch").info(
                "[approval][retention] expired %s link(s), %s record(s)",
                res["expired_links"], res["expired_requests"])
    except Exception:
        logging.getLogger("baywatch").exception("[approval][retention] cleanup failed (non-fatal)")
    finally:
        db.close()


def _intake_cleanup() -> None:
    """Vehicle Intake retention: expire/purge temporary bike photos + complaint voice notes past
    their 14-day window and archive entries whose media is gone. Safe + idempotent; never touches
    core business data. Never blocks startup."""
    import logging
    from .database import SessionLocal
    from .utils import intake as intake_utils
    db = SessionLocal()
    try:
        res = intake_utils.cleanup_expired(db)
        if res.get("expired_media") or res.get("archived_entries"):
            logging.getLogger("baywatch").info(
                "[intake][retention] expired %s media, archived %s entries",
                res["expired_media"], res["archived_entries"])
    except Exception:
        logging.getLogger("baywatch").exception("[intake][retention] cleanup failed (non-fatal)")
    finally:
        db.close()


def _barricade_cleanup() -> None:
    """AI Barricade retention: purge temporary detection frames past their 30-day window. Event
    metadata + the decision/audit trail are kept forever. Safe + idempotent; never blocks startup."""
    import logging
    from .database import SessionLocal
    from .utils import barricade as barricade_utils
    db = SessionLocal()
    try:
        res = barricade_utils.cleanup_expired_media(db)
        if res.get("expired_media"):
            logging.getLogger("baywatch").info(
                "[barricade][retention] expired %s detection frame(s)", res["expired_media"])
    except Exception:
        logging.getLogger("baywatch").exception("[barricade][retention] cleanup failed (non-fatal)")
    finally:
        db.close()


def _reconcile_sessions() -> None:
    """After restore, cross-check DB running/paused sessions against Redis so the
    bay dashboard, worker/customer portals and recording state stay in sync."""
    import logging
    from .database import SessionLocal
    from .models.session import ServiceSession, RecordingSession, SessionStatus
    from sqlalchemy import select
    log = logging.getLogger("baywatch.timer")
    db = SessionLocal()
    try:
        live = db.scalars(select(ServiceSession).where(
            ServiceSession.status.in_([SessionStatus.running, SessionStatus.paused]))).all()
        for s in live:
            t = timer.get_state(s.bay_id)
            rec = db.scalar(select(RecordingSession).where(RecordingSession.service_session_id == s.id))
            if t.get("current_status") in ("RUNNING", "PAUSED"):
                log.info("[timer][recovery] Session %s (bay) re-synced · timer=%s · recording=%s",
                         s.id, t.get("current_status"), rec.status.value if rec else "none")
            else:
                # Redis lost this timer (e.g. flushed) — surface it loudly
                log.error("[timer][recovery] Session %s is %s in DB but has NO active timer in Redis "
                          "— admin must re-Start the bay.", s.id, s.status.value)
        if live:
            log.warning("[timer][recovery] reconciled %d live session(s) with Redis + recordings", len(live))
    finally:
        db.close()


app = FastAPI(title="Baywatch Service OS API", version="1.0.0", lifespan=lifespan)

_main_log = logging.getLogger("baywatch.main")


# Catch-all error guard. Registered BEFORE CORSMiddleware so CORS stays the
# OUTERMOST middleware — that ordering is what guarantees an unexpected 500
# still carries Access-Control-Allow-Origin (otherwise the browser reports it
# as a CORS / "Failed to fetch" error and hides the real status). An unhandled
# exception is turned into the standard JSON envelope instead of a bare 500.
@app.middleware("http")
async def catch_all_errors(request: Request, call_next):
    try:
        return await call_next(request)
    except Exception:
        _main_log.exception("Unhandled error · %s %s", request.method, request.url.path)
        return JSONResponse(
            status_code=500,
            content={"success": False, "message": "Internal server error", "data": None},
        )


app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_list,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

API = "/api/v1"
app.include_router(auth.router,         prefix=f"{API}/auth",          tags=["auth"])
app.include_router(workers.router,      prefix=f"{API}/workers",       tags=["workers"])
app.include_router(bays.router,         prefix=f"{API}/bays",          tags=["bays"])
app.include_router(cameras.router,      prefix=f"{API}/cameras",       tags=["cameras"])
app.include_router(parts.router,        prefix=f"{API}/parts",         tags=["parts"])
app.include_router(jobs.router,         prefix=f"{API}/jobs",          tags=["jobs"])
app.include_router(queue_router.router, prefix=f"{API}/queue",         tags=["queue"])
app.include_router(bay_dashboard.router,prefix=f"{API}/bay-dashboard", tags=["bay-dashboard"])
app.include_router(worker_router.router, prefix=f"{API}/worker",        tags=["worker"])
app.include_router(leave.router,        prefix=f"{API}/leave",         tags=["leave"])
app.include_router(reports.router,      prefix=f"{API}/reports",       tags=["reports"])
app.include_router(recordings_router.router, prefix=f"{API}/recordings", tags=["recordings"])
app.include_router(storage_admin.router, prefix=f"{API}/storage",       tags=["storage"])
app.include_router(timers.router,       prefix=f"{API}/timers",        tags=["timers"])
app.include_router(test_drives_router.router, prefix=f"{API}/test-drives", tags=["test-drives"])
app.include_router(platform_router.router, prefix=f"{API}/platform",    tags=["platform"])
app.include_router(master.router,       prefix=f"{API}/master",        tags=["master"])
app.include_router(branches_router.router, prefix=f"{API}/branches",    tags=["branches"])
app.include_router(customer_watch_router.router, prefix=f"{API}/customer-watch", tags=["customer-watch"])
app.include_router(integrations_router.router, prefix=f"{API}/integrations", tags=["integrations"])
app.include_router(customer_approvals_router.router, prefix=f"{API}/customer-approvals", tags=["customer-approvals"])
# Vehicle Intake Evidence — worker/admin/master planes + token-gated media (paths are fully
# qualified inside the router: /worker/intake, /admin/intake, /master/intake, /intake/media).
app.include_router(vehicle_intake_router.router, prefix=API, tags=["vehicle-intake"])
# AI Barricade Vehicle Detection — admin/master planes + NOT-public ingest + token-gated media
# (paths fully qualified in the router: /admin/barricade, /master/barricade, /barricade/ingest,
# /barricade/media).
app.include_router(barricade_router.router, prefix=API, tags=["barricade"])
# Worker Bay-to-Bay Time Analysis — admin/master analytics derived from ServiceSession lifecycle
# (paths fully qualified: /admin/analytics/worker-transition, /master/analytics/worker-transition).
app.include_router(worker_transition_router.router, prefix=API, tags=["worker-transition"])
app.include_router(ws.router,           prefix="/ws",                  tags=["websocket"])
app.include_router(streaming.router,    prefix="/hls",                 tags=["streaming"])
# PUBLIC, token-gated customer plane (no auth) — same origin as the API.
app.include_router(watch_public.router, prefix="/customer-watch",      tags=["customer-watch-public"])
app.include_router(approval_public.router, prefix="/customer-approval", tags=["customer-approval-public"])


# ── Consistent error envelope ──────────────────────────────────────
@app.exception_handler(StarletteHTTPException)
async def http_error(request: Request, exc: StarletteHTTPException):
    return JSONResponse(status_code=exc.status_code,
                        content={"success": False, "message": str(exc.detail), "data": None})


@app.exception_handler(RequestValidationError)
async def validation_error(request: Request, exc: RequestValidationError):
    return JSONResponse(status_code=422,
                        content={"success": False, "message": "Validation error",
                                 "data": exc.errors()})


@app.get("/health", tags=["system"])
def health():
    from .database import engine
    from .services import mqtt_service, recording_service, drive_service
    db_ok = True
    try:
        with engine.connect() as c:
            c.exec_driver_sql("SELECT 1")
    except Exception:
        db_ok = False
    return {
        "success": True,
        "data": {
            "db": db_ok,
            "timer_backend": timer.backend(),
            "timer_persistent": timer.persistent(),
            "active_timers": timer.active_count(),
            "mqtt": mqtt_service.status(),
            "recording_engine": recording_service.status_label(),   # ffmpeg | unavailable
            "drive_configured": drive_service.is_configured(),
            "retention_days": settings.recording_retention_days,
        },
        "message": "ok",
    }


@app.get("/ready", tags=["system"])
def ready():
    """Readiness probe for a load balancer / orchestrator: returns 503 (not 200)
    when a hard dependency is down, so traffic is only routed to a node that can
    actually serve. DB connectivity + a writable recording media root are required;
    optional integrations (Drive/MQTT/WhatsApp) are reported by /health, not here."""
    from .database import engine
    from .startup import media_writable
    db_ok = True
    try:
        with engine.connect() as c:
            c.exec_driver_sql("SELECT 1")
    except Exception:
        db_ok = False
    media_ok = media_writable()
    ready_ok = db_ok and media_ok
    body = {"success": ready_ok, "data": {"ready": ready_ok, "checks": {"db": db_ok, "media_writable": media_ok}},
            "message": "ready" if ready_ok else "not ready"}
    return JSONResponse(status_code=200 if ready_ok else 503, content=body)


# ── Single-service deployment (optional) ───────────────────────────
# When the frontend build is present next to the backend (the repo layout, and
# how the Docker image is assembled), this process serves the app AND the API on
# ONE origin. That removes CORS from the deployment entirely and keeps the
# customer watch/approval pages same-origin, exactly as they are in dev.
# When it is absent (plain API container), every route below behaves as before
# and `/` returns the API banner. Nothing here affects the dev workflow, where
# the frontend is served separately by frontend/serve.py on :7890.
_FRONTEND_DIR = Path(__file__).resolve().parents[2] / "frontend"
_INDEX = _FRONTEND_DIR / "index.html"


@app.get("/", tags=["system"])
def root():
    if _INDEX.exists():
        return FileResponse(str(_INDEX), media_type="text/html",
                            headers={"Cache-Control": "no-store"})
    return {"success": True, "message": "Baywatch Service OS API", "data": {"docs": "/docs"}}


# Mounted LAST so every API route, /ws, /hls and the public customer planes
# registered above keep priority; this only catches what they did not match.
if _FRONTEND_DIR.is_dir():
    app.mount("/", StaticFiles(directory=str(_FRONTEND_DIR), html=True), name="frontend")
    _main_log.info("serving frontend from %s (single-origin deployment)", _FRONTEND_DIR)
