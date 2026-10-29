"""Worker Jobcard Entry / Vehicle Intake Evidence — API (Phase B).

One router mounted at ``/api/v1`` serving three role planes plus token-gated media:

  • Worker  (require_worker, own branch + OWN entries only) — create, upload image/audio,
            view, history, delete draft media, submit.
  • Admin   (require_admin, branch-isolated; master sees all) — list, grouped-by-worker,
            detail, by-bike, link-job, revoke media.
  • Master  (require_master, global) — list, grouped-by-branch, detail, revoke media.
  • Media   (token-gated, no auth dependency) — view / thumbnail with HTTP Range; expired → 410,
            bad token → 403. Raw filesystem paths are never exposed.

Backend stays the source of truth; pinned modules are untouched (matching uses the PDF parser's
already-extracted ``vehicle_number`` — the parser itself is never called here).
"""
import logging
from datetime import datetime, timedelta

from fastapi import (APIRouter, Depends, File, Form, HTTPException, Query, Request,
                     Response, UploadFile, status)
from fastapi.responses import FileResponse, StreamingResponse
from pydantic import BaseModel
from sqlalchemy import select, text
from sqlalchemy.orm import Session

from ..database import get_db, engine
from ..models.base import naive_utcnow
from ..models.user import User
from ..models.vehicle_intake import VehicleIntakeEntry, VehicleIntakeMedia
from ..schemas.common import ok
from ..utils import intake
from ..utils.auth import (assert_branch_access, effective_branch, is_master,
                          require_admin, require_master, require_worker)

log = logging.getLogger("baywatch.intake")
router = APIRouter()

_INTAKE_MIGRATED = False


def ensure_intake_schema() -> None:
    """Idempotent, additive schema guard for the vehicle-intake tables. The tables themselves
    are created by ``init_db()`` (create_all); this only ADDs any column introduced after a
    table already exists (PG + SQLite). Never drops. Mirrors ensure_customer_approval_schema."""
    global _INTAKE_MIGRATED
    if _INTAKE_MIGRATED:
        return
    dialect = engine.dialect.name
    later: dict[str, list[tuple[str, str]]] = {
        "vehicle_intake_entries": [
            ("linked_job_id", "VARCHAR(36)"), ("linked_job_card_id", "VARCHAR(36)"),
            ("linked_assignment_id", "VARCHAR(36)"), ("linked_by_admin_id", "VARCHAR"),
            ("linked_by_admin_name", "VARCHAR"), ("linked_at", "TIMESTAMP"),
            ("submitted_at", "TIMESTAMP"), ("updated_at", "TIMESTAMP"),
            ("expires_at", "TIMESTAMP"), ("deleted_at", "TIMESTAMP"),
        ],
        "vehicle_intake_media": [
            ("thumbnail_path", "VARCHAR(512)"), ("duration_seconds", "INTEGER"),
            ("uploaded_by_worker_name", "VARCHAR"), ("revoked_at", "TIMESTAMP"),
            ("revoked_by_id", "VARCHAR"), ("revoked_by_name", "VARCHAR"),
            ("deleted_at", "TIMESTAMP"), ("expires_at", "TIMESTAMP"),
        ],
    }
    with engine.begin() as conn:
        for tbl, cols in later.items():
            try:
                if dialect == "postgresql":
                    existing = {r[0] for r in conn.execute(text(
                        "SELECT column_name FROM information_schema.columns WHERE table_name=:t"), {"t": tbl})}
                else:
                    existing = {r[1] for r in conn.execute(text(f"PRAGMA table_info({tbl})"))}
            except Exception:
                existing = set()
            for name, ddl in cols:
                if name not in existing:
                    try:
                        conn.execute(text(f"ALTER TABLE {tbl} ADD COLUMN {name} {ddl}"))
                    except Exception:
                        pass
    _INTAKE_MIGRATED = True


# ── request bodies ──────────────────────────────────────────────────
class IntakeBody(BaseModel):
    customer_name: str | None = None
    phone_number: str | None = None
    whatsapp_number: str | None = None
    email: str | None = None
    address: str | None = None
    bike_number: str | None = None
    engine_number: str | None = None
    chassis_number: str | None = None
    complaint_description: str | None = None


class LinkBody(BaseModel):
    job_id: str | None = None
    job_card_id: str | None = None
    assignment_id: str | None = None


# ── helpers ─────────────────────────────────────────────────────────
def _now() -> datetime:
    return naive_utcnow()


def _parse_date(s):
    if not s or not isinstance(s, str):
        return None
    try:
        return datetime.strptime(s[:10], "%Y-%m-%d").date()
    except Exception:
        return None


def _filtered(stmt, *, bike_number=None, date_from=None, date_to=None, status_f=None, linked=None):
    from sqlalchemy import func
    stmt = stmt.where(VehicleIntakeEntry.deleted_at.is_(None))
    if bike_number:
        norm = intake.normalize_bike_number(bike_number)
        if norm:
            stmt = stmt.where(VehicleIntakeEntry.bike_number_normalized.contains(norm))
    df, dt = _parse_date(date_from), _parse_date(date_to)
    if df:
        stmt = stmt.where(func.date(VehicleIntakeEntry.created_at) >= df)
    if dt:
        stmt = stmt.where(func.date(VehicleIntakeEntry.created_at) <= dt)
    if status_f:
        stmt = stmt.where(VehicleIntakeEntry.status == status_f)
    if linked in ("true", "false"):
        if linked == "true":
            stmt = stmt.where(VehicleIntakeEntry.linked_job_card_id.is_not(None)
                              | VehicleIntakeEntry.linked_job_id.is_not(None))
        else:
            stmt = stmt.where(VehicleIntakeEntry.linked_job_card_id.is_(None),
                              VehicleIntakeEntry.linked_job_id.is_(None))
    return stmt.order_by(VehicleIntakeEntry.created_at.desc())


def _cards(db: Session, entries: list[VehicleIntakeEntry]) -> list[dict]:
    cmap = intake.counts_map(db, [e.id for e in entries])
    return [intake.entry_card(e, cmap.get(e.id, (0, 0))) for e in entries]


def _worker_entry(db: Session, me: User, entry_id: str) -> VehicleIntakeEntry:
    e = db.get(VehicleIntakeEntry, entry_id)
    if not e or e.worker_id != me.id or e.deleted_at is not None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Intake entry not found")
    return e


def _admin_entry(db: Session, me: User, entry_id: str) -> VehicleIntakeEntry:
    e = db.get(VehicleIntakeEntry, entry_id)
    if not e or e.deleted_at is not None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Intake entry not found")
    assert_branch_access(me, e.branch_id, "intake")
    return e


def _any_entry(db: Session, entry_id: str) -> VehicleIntakeEntry:
    e = db.get(VehicleIntakeEntry, entry_id)
    if not e or e.deleted_at is not None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Intake entry not found")
    return e


def _pdf_response(db: Session, e: VehicleIntakeEntry) -> Response:
    """Render the standalone evidence PDF for an entry and return it as an application/pdf
    download with a safe filename. Errors surface as a clean 500 (no raw path / no stack)."""
    from ..utils import intake_evidence_pdf as evpdf
    try:
        data = evpdf.build_evidence_pdf(db, e)
    except Exception:
        log.exception("intake evidence pdf failed for entry %s", e.id)
        raise HTTPException(status.HTTP_500_INTERNAL_SERVER_ERROR,
                            "Could not generate the evidence PDF")
    fname = evpdf.safe_filename(e.intake_no, e.bike_number_normalized)
    return Response(content=data, media_type="application/pdf",
                    headers={"Content-Disposition": f'attachment; filename="{fname}"',
                             "Cache-Control": "private, no-store"})


async def _save_upload(db: Session, e: VehicleIntakeEntry, me: User, media_type: str,
                       file: UploadFile, caption: str | None,
                       client_duration: int | None = None) -> VehicleIntakeMedia:
    if e.status != "draft":
        raise HTTPException(status.HTTP_409_CONFLICT,
                            "Media can only be added while the intake is a draft")
    existing = db.scalar(
        select(__import__("sqlalchemy").func.count()).select_from(VehicleIntakeMedia).where(
            VehicleIntakeMedia.intake_entry_id == e.id,
            VehicleIntakeMedia.media_type == media_type,
            VehicleIntakeMedia.status == "active",
        )) or 0
    cap = intake.MAX_IMAGES if media_type == "image" else intake.MAX_AUDIO
    if existing >= cap:
        raise HTTPException(status.HTTP_409_CONFLICT,
                            f"Limit reached ({cap} {media_type}s per intake)")
    data = await file.read()
    try:
        if media_type == "image":
            intake.validate_image(file.filename, file.content_type, len(data))
        else:
            intake.validate_audio(file.filename, file.content_type, len(data))
    except intake.IntakeValidationError as ex:
        raise HTTPException(ex.code, ex.message)

    meta = intake.save_media_file(e, media_type, file.filename, data)
    duration = meta["duration_seconds"]
    if duration is None and client_duration:
        try:
            duration = max(0, int(client_duration))
        except (TypeError, ValueError):
            duration = None
    m = VehicleIntakeMedia(
        intake_entry_id=e.id, branch_id=e.branch_id,
        bike_number_normalized=e.bike_number_normalized, media_type=media_type,
        file_path=meta["file_key"], thumbnail_path=meta["thumbnail_key"],
        mime_type=file.content_type, original_filename=file.filename,
        size_bytes=meta["size_bytes"], duration_seconds=duration, caption=caption,
        uploaded_by_worker_id=me.id, uploaded_by_worker_name=me.name,
        status="active", expires_at=e.expires_at,
    )
    db.add(m)
    intake.log_event(db, e.id, "worker", me.id, me.name, f"{media_type}_uploaded",
                     f"{media_type} added", {"filename": file.filename, "bytes": meta["size_bytes"]})
    db.commit()
    db.refresh(m)
    return m


# ════════════════════════════════════════════════════════════════════
#  WORKER
# ════════════════════════════════════════════════════════════════════
@router.post("/worker/intake")
def worker_create(body: IntakeBody, db: Session = Depends(get_db), me: User = Depends(require_worker)):
    raw = body.bike_number
    e = VehicleIntakeEntry(
        intake_no=intake.next_intake_no(db),
        branch_id=effective_branch(me, None), worker_id=me.id, worker_name=me.name,
        bike_number_raw=raw, bike_number_normalized=intake.normalize_bike_number(raw),
        customer_name=body.customer_name, phone_number=body.phone_number,
        whatsapp_number=body.whatsapp_number, email=body.email, address=body.address,
        engine_number=body.engine_number, chassis_number=body.chassis_number,
        complaint_description=body.complaint_description, status="draft",
    )
    db.add(e)
    db.flush()
    intake.log_event(db, e.id, "worker", me.id, me.name, "created", "Intake entry created")
    db.commit()
    db.refresh(e)
    return ok(intake.entry_detail(db, e), "Intake entry created")


@router.post("/worker/intake/{entry_id}/media/image")
async def worker_upload_image(entry_id: str, file: UploadFile = File(...),
                              caption: str | None = Form(None),
                              db: Session = Depends(get_db), me: User = Depends(require_worker)):
    e = _worker_entry(db, me, entry_id)
    m = await _save_upload(db, e, me, "image", file, caption)
    return ok(intake.media_out(m), "Image added")


@router.post("/worker/intake/{entry_id}/media/audio")
async def worker_upload_audio(entry_id: str, file: UploadFile = File(...),
                              caption: str | None = Form(None),
                              duration_seconds: int | None = Form(None),
                              db: Session = Depends(get_db), me: User = Depends(require_worker)):
    e = _worker_entry(db, me, entry_id)
    m = await _save_upload(db, e, me, "audio", file, caption, duration_seconds)
    return ok(intake.media_out(m), "Voice note added")


@router.get("/worker/intake")
def worker_history(bike_number: str = Query(None), date_from: str = Query(None),
                   date_to: str = Query(None), status_f: str = Query(None, alias="status"),
                   db: Session = Depends(get_db), me: User = Depends(require_worker)):
    """The worker's OWN intake history (only entries they created)."""
    stmt = _filtered(select(VehicleIntakeEntry).where(VehicleIntakeEntry.worker_id == me.id),
                     bike_number=bike_number, date_from=date_from, date_to=date_to, status_f=status_f)
    return ok(_cards(db, db.scalars(stmt).all()))


@router.delete("/worker/intake/media/{media_id}")
def worker_delete_media(media_id: str, db: Session = Depends(get_db), me: User = Depends(require_worker)):
    m = db.get(VehicleIntakeMedia, media_id)
    if not m:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Media not found")
    e = db.get(VehicleIntakeEntry, m.intake_entry_id)
    if not e or e.worker_id != me.id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Media not found")
    if e.status != "draft":
        raise HTTPException(status.HTTP_409_CONFLICT,
                            "Submitted intake media cannot be deleted (ask an admin to revoke)")
    intake._delete_media_file(m)
    db.delete(m)
    intake.log_event(db, e.id, "worker", me.id, me.name, "media_deleted", "Draft media removed")
    db.commit()
    return ok(None, "Media removed")


@router.post("/worker/intake/{entry_id}/submit")
def worker_submit(entry_id: str, db: Session = Depends(get_db), me: User = Depends(require_worker)):
    e = _worker_entry(db, me, entry_id)
    if e.status != "draft":
        raise HTTPException(status.HTTP_409_CONFLICT, "Intake is already submitted")
    if not e.bike_number_normalized:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Bike registration number is required")
    if not (e.complaint_description or "").strip():
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Complaint description is required")
    now = _now()
    expiry = now + timedelta(days=intake.retention_days())
    e.status = "submitted"
    e.submitted_at = now
    e.expires_at = expiry
    for m in db.scalars(select(VehicleIntakeMedia).where(
            VehicleIntakeMedia.intake_entry_id == e.id, VehicleIntakeMedia.status == "active")):
        m.expires_at = expiry
    intake.log_event(db, e.id, "worker", me.id, me.name, "submitted",
                     f"Intake submitted · expires {expiry.date().isoformat()}")
    db.commit()
    db.refresh(e)
    return ok(intake.entry_detail(db, e), "Intake submitted")


@router.get("/worker/intake/{entry_id}/evidence-pdf")
def worker_evidence_pdf(entry_id: str, db: Session = Depends(get_db),
                        me: User = Depends(require_worker)):
    """Standalone evidence PDF — worker can download ONLY their own entry."""
    return _pdf_response(db, _worker_entry(db, me, entry_id))


@router.get("/worker/intake/{entry_id}")
def worker_detail(entry_id: str, db: Session = Depends(get_db), me: User = Depends(require_worker)):
    return ok(intake.entry_detail(db, _worker_entry(db, me, entry_id)))


# ════════════════════════════════════════════════════════════════════
#  ADMIN (branch-isolated; master sees all branches)
# ════════════════════════════════════════════════════════════════════
def _admin_scope(stmt, me: User):
    return stmt if is_master(me) else stmt.where(VehicleIntakeEntry.branch_id == me.branch_id)


@router.get("/admin/intake")
def admin_list(worker_id: str = Query(None), worker_name: str = Query(None),
               bike_number: str = Query(None), date_from: str = Query(None),
               date_to: str = Query(None), status_f: str = Query(None, alias="status"),
               linked: str = Query(None),
               db: Session = Depends(get_db), me: User = Depends(require_admin)):
    stmt = _admin_scope(select(VehicleIntakeEntry), me)
    if worker_id:
        stmt = stmt.where(VehicleIntakeEntry.worker_id == worker_id)
    if worker_name:
        stmt = stmt.where(VehicleIntakeEntry.worker_name.ilike(f"%{worker_name}%"))
    stmt = _filtered(stmt, bike_number=bike_number, date_from=date_from, date_to=date_to,
                     status_f=status_f, linked=linked)
    return ok(_cards(db, db.scalars(stmt).all()))


@router.get("/admin/intake/grouped-by-worker")
def admin_grouped_by_worker(date_from: str = Query(None), date_to: str = Query(None),
                            status_f: str = Query(None, alias="status"),
                            db: Session = Depends(get_db), me: User = Depends(require_admin)):
    stmt = _filtered(_admin_scope(select(VehicleIntakeEntry), me),
                     date_from=date_from, date_to=date_to, status_f=status_f)
    return ok(intake.group_by_worker(db, db.scalars(stmt).all()))


@router.get("/admin/intake/summary")
def admin_summary(db: Session = Depends(get_db), me: User = Depends(require_admin)):
    """Dashboard summary for the admin's branch (master: global) — counts + a small latest list."""
    stmt = _admin_scope(select(VehicleIntakeEntry), me).where(VehicleIntakeEntry.deleted_at.is_(None))
    return ok(intake.summary(db, db.scalars(stmt).all()))


@router.get("/admin/intake/by-bike/{bike_number}")
def admin_by_bike(bike_number: str, db: Session = Depends(get_db), me: User = Depends(require_admin)):
    norm = intake.normalize_bike_number(bike_number)
    stmt = _admin_scope(select(VehicleIntakeEntry), me).where(
        VehicleIntakeEntry.bike_number_normalized == norm,
        VehicleIntakeEntry.deleted_at.is_(None),
    ).order_by(VehicleIntakeEntry.created_at.desc())
    e = db.scalars(stmt).first()
    if not e:
        return ok(None, "No intake evidence for this bike")
    return ok(intake.entry_detail(db, e))


@router.post("/admin/intake/{entry_id}/link-job")
def admin_link_job(entry_id: str, body: LinkBody, db: Session = Depends(get_db),
                   me: User = Depends(require_admin)):
    e = _admin_entry(db, me, entry_id)
    if not (body.job_id or body.job_card_id or body.assignment_id):
        raise HTTPException(status.HTTP_400_BAD_REQUEST,
                            "Provide a job_id, job_card_id or assignment_id to link")
    e.linked_job_id = body.job_id or e.linked_job_id
    e.linked_job_card_id = body.job_card_id or e.linked_job_card_id
    e.linked_assignment_id = body.assignment_id or e.linked_assignment_id
    e.linked_by_admin_id = me.id
    e.linked_by_admin_name = me.name
    e.linked_at = _now()
    if e.status in ("submitted",):
        e.status = "linked"
    intake.log_event(db, e.id, "admin", me.id, me.name, "linked",
                     "Linked to job/jobcard",
                     {"job_id": body.job_id, "job_card_id": body.job_card_id,
                      "assignment_id": body.assignment_id})
    db.commit()
    db.refresh(e)
    return ok(intake.entry_detail(db, e), "Intake linked")


@router.post("/admin/intake/media/{media_id}/revoke")
def admin_revoke_media(media_id: str, db: Session = Depends(get_db), me: User = Depends(require_admin)):
    return _revoke_media(db, me, media_id, "admin")


@router.get("/admin/intake/{entry_id}/evidence-pdf")
def admin_evidence_pdf(entry_id: str, db: Session = Depends(get_db),
                       me: User = Depends(require_admin)):
    """Standalone evidence PDF — admin can download ONLY own-branch entries (master: any)."""
    return _pdf_response(db, _admin_entry(db, me, entry_id))


@router.get("/admin/intake/{entry_id}")
def admin_detail(entry_id: str, db: Session = Depends(get_db), me: User = Depends(require_admin)):
    return ok(intake.entry_detail(db, _admin_entry(db, me, entry_id)))


# ════════════════════════════════════════════════════════════════════
#  MASTER (global)
# ════════════════════════════════════════════════════════════════════
@router.get("/master/intake")
def master_list(branch_id: str = Query(None), worker_id: str = Query(None),
                bike_number: str = Query(None), date_from: str = Query(None),
                date_to: str = Query(None), status_f: str = Query(None, alias="status"),
                linked: str = Query(None),
                db: Session = Depends(get_db), me: User = Depends(require_master)):
    stmt = select(VehicleIntakeEntry)
    if branch_id:
        stmt = stmt.where(VehicleIntakeEntry.branch_id == branch_id)
    if worker_id:
        stmt = stmt.where(VehicleIntakeEntry.worker_id == worker_id)
    stmt = _filtered(stmt, bike_number=bike_number, date_from=date_from, date_to=date_to,
                     status_f=status_f, linked=linked)
    return ok(_cards(db, db.scalars(stmt).all()))


@router.get("/master/intake/grouped-by-branch")
def master_grouped_by_branch(date_from: str = Query(None), date_to: str = Query(None),
                             status_f: str = Query(None, alias="status"),
                             db: Session = Depends(get_db), me: User = Depends(require_master)):
    stmt = _filtered(select(VehicleIntakeEntry), date_from=date_from, date_to=date_to, status_f=status_f)
    return ok(intake.group_by_branch(db, db.scalars(stmt).all()))


@router.get("/master/intake/summary")
def master_summary(branch_id: str = Query(None), db: Session = Depends(get_db),
                   me: User = Depends(require_master)):
    """Global intake summary (optionally one branch) — counts + a small latest list."""
    stmt = select(VehicleIntakeEntry).where(VehicleIntakeEntry.deleted_at.is_(None))
    if branch_id:
        stmt = stmt.where(VehicleIntakeEntry.branch_id == branch_id)
    return ok(intake.summary(db, db.scalars(stmt).all()))


@router.post("/master/intake/media/{media_id}/revoke")
def master_revoke_media(media_id: str, db: Session = Depends(get_db), me: User = Depends(require_master)):
    return _revoke_media(db, me, media_id, "master")


@router.get("/master/intake/{entry_id}/evidence-pdf")
def master_evidence_pdf(entry_id: str, db: Session = Depends(get_db),
                        me: User = Depends(require_master)):
    """Standalone evidence PDF — master can download any branch's entry."""
    return _pdf_response(db, _any_entry(db, entry_id))


@router.get("/master/intake/{entry_id}")
def master_detail(entry_id: str, db: Session = Depends(get_db), me: User = Depends(require_master)):
    return ok(intake.entry_detail(db, _any_entry(db, entry_id)))


def _revoke_media(db: Session, me: User, media_id: str, actor: str):
    m = db.get(VehicleIntakeMedia, media_id)
    if not m:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Media not found")
    if actor == "admin":
        assert_branch_access(me, m.branch_id, "intake-media")
    if m.status in ("revoked", "deleted"):
        return ok(intake.media_out(m), "Media already revoked")
    m.status = "revoked"
    m.revoked_at = _now()
    m.revoked_by_id = me.id
    m.revoked_by_name = me.name
    intake.log_event(db, m.intake_entry_id, actor, me.id, me.name, "media_revoked", "Media revoked")
    db.commit()
    db.refresh(m)
    return ok(intake.media_out(m), "Media revoked")


# ════════════════════════════════════════════════════════════════════
#  MEDIA (token-gated; no auth dependency — like recording stream)
# ════════════════════════════════════════════════════════════════════
def _range_response(path, request: Request, media_type: str | None):
    file_size = path.stat().st_size
    rng = request.headers.get("range")
    common = {"Accept-Ranges": "bytes", "Cache-Control": "private, no-store"}
    mt = media_type or "application/octet-stream"
    if not rng:
        return FileResponse(str(path), media_type=mt, headers=common)
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
    return StreamingResponse(_iter(), status_code=206, media_type=mt, headers=headers)


def _serve_media(db: Session, request: Request, media_id: str, token: str, exp: str, thumb: bool):
    m = db.get(VehicleIntakeMedia, media_id)
    if not m:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Media not found")
    if intake.media_dead(m):
        raise HTTPException(status.HTTP_410_GONE,
                            "This intake media has expired and is no longer available.")
    if not intake.verify_view(media_id, token, exp):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Invalid or expired media link")
    key = m.thumbnail_path if thumb else m.file_path
    path = intake.local_path(key)
    if not path:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Media file is not available")
    if thumb:
        return FileResponse(str(path), media_type="image/jpeg",
                            headers={"Cache-Control": "private, no-store"})
    if m.media_type == "audio":
        return _range_response(path, request, m.mime_type)
    return FileResponse(str(path), media_type=m.mime_type or "application/octet-stream",
                        headers={"Cache-Control": "private, no-store"})


@router.get("/intake/media/{media_id}/view")
def media_view(media_id: str, request: Request, token: str = Query(""),
               exp: str = Query(""), db: Session = Depends(get_db)):
    return _serve_media(db, request, media_id, token, exp, thumb=False)


@router.get("/intake/media/{media_id}/thumbnail")
def media_thumbnail(media_id: str, request: Request, token: str = Query(""),
                    exp: str = Query(""), db: Session = Depends(get_db)):
    return _serve_media(db, request, media_id, token, exp, thumb=True)
