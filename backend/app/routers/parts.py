from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, status, UploadFile, File, Query
from sqlalchemy import select, or_, func, text
from sqlalchemy.orm import Session

from ..database import get_db, engine
from ..models.part import ImportedFile, PartsMaster, UnitConversionSetting
from ..models.user import User
from ..models.audit import AuditLog
from ..schemas.part import PartCreate, PartUpdate, PartOut, UnitConversionUpdate, ImportRowsBody
from ..schemas.common import ok
from ..utils.auth import require_admin
from ..utils.audit import log_action
from ..utils import file_parser, jobcard_parser
from ..services import estimate_service

router = APIRouter()


# ── Idempotent schema migration (dev: SQLite/Postgres add missing columns) ──
_MIGRATED = False


def ensure_parts_schema() -> None:
    """Add columns introduced after the first release. Safe to call repeatedly."""
    global _MIGRATED
    if _MIGRATED:
        return
    dialect = engine.dialect.name
    adds = {
        "imported_files": [
            ("uploaded_by_name", "VARCHAR"), ("total_rows", "INTEGER DEFAULT 0"),
            ("total_codes", "INTEGER DEFAULT 0"), ("dup_skipped", "INTEGER DEFAULT 0"),
            ("size_bytes", "INTEGER DEFAULT 0"), ("version", "INTEGER DEFAULT 1"),
            ("history", "JSON" if dialect == "postgresql" else "TEXT"),
        ],
        "parts_master": [
            ("model", "VARCHAR"), ("source_file_name", "VARCHAR"), ("imported_by", "VARCHAR"),
        ],
    }
    with engine.begin() as conn:
        for table, cols in adds.items():
            # discover existing columns
            try:
                if dialect == "postgresql":
                    existing = {r[0] for r in conn.execute(text(
                        "SELECT column_name FROM information_schema.columns WHERE table_name=:t"), {"t": table})}
                else:
                    existing = {r[1] for r in conn.execute(text(f"PRAGMA table_info({table})"))}
            except Exception:
                existing = set()
            for name, ddl in cols:
                if name not in existing:
                    try:
                        conn.execute(text(f"ALTER TABLE {table} ADD COLUMN {name} {ddl}"))
                    except Exception:
                        pass
    _MIGRATED = True


def _conversion(db: Session) -> float:
    row = db.scalars(select(UnitConversionSetting).order_by(UnitConversionSetting.changed_at.desc())).first()
    return row.value_minutes if row else 1.0


def _file_out(f: ImportedFile) -> dict:
    return {
        "id": f.id, "name": f.file_name, "file_name": f.file_name,
        "type": f.file_type, "file_type": f.file_type,
        "status": f.status or "active",
        "totalParts": f.total_records, "total_records": f.total_records,
        "totalRows": f.total_rows or f.total_records, "total_rows": f.total_rows,
        "totalCodes": f.total_codes or 0, "total_codes": f.total_codes,
        "dupSkipped": f.dup_skipped or 0, "dup_skipped": f.dup_skipped,
        "size": f.size_bytes or 0, "sizeStr": _fmt_size(f.size_bytes or 0),
        "version": f.version or 1,
        "uploadedBy": f.uploaded_by_name or "ADMIN",
        "uploadDate": f.created_at.isoformat() if f.created_at else None,
        "upload_date": f.created_at.isoformat() if f.created_at else None,
        "history": f.history or [],
    }


def _part_out(p: PartsMaster, mpu: float) -> dict:
    """Shape parts the way the frontend (demo design) expects."""
    return {
        "id": p.id, "pn": p.part_number or "", "name": p.part_name or "",
        "code": p.product_code or "", "model": p.model or "",
        "units": p.unit_value, "unit_time": p.unit_time,
        "est": round((p.unit_value or 0) * mpu * 100) / 100,
        "estimated_time": p.estimated_time,
        "sourceFileId": p.source_file_id or "manual",
        "sourceFileName": p.source_file_name or ("Manual entry" if not p.source_file_id else "—"),
        "importedBy": p.imported_by,
        "created": p.created_at.isoformat() if p.created_at else None,
        "updated": p.updated_at.isoformat() if p.updated_at else None,
    }


def _fmt_size(b: int) -> str:
    if b > 1_000_000:
        return f"{b/1_000_000:.1f} MB"
    if b > 1_000:
        return f"{b/1_000:.0f} KB"
    return f"{b} B"


# ════════════════════════════════════════════════════════════════
#  File import — JSON rows (client-side extracted) · large-file safe
# ════════════════════════════════════════════════════════════════
@router.post("/import-rows")
def import_rows(body: ImportRowsBody, db: Session = Depends(get_db), admin: User = Depends(require_admin)):
    ensure_parts_schema()
    conv = _conversion(db)

    imp = ImportedFile(
        file_name=body.file_name, file_type=body.file_type,
        uploaded_by=admin.id, uploaded_by_name=admin.name or admin.username or "ADMIN",
        status="active", size_bytes=body.size_bytes, version=1,
        total_rows=len(body.rows), history=[],
    )
    db.add(imp); db.flush()

    # global dedup by part_number (case-insensitive), matching the demo store
    have = {r[0].lower() for r in db.execute(
        select(PartsMaster.part_number).where(PartsMaster.part_number.isnot(None))).all() if r[0]}
    added, dup = 0, 0
    codes: set[str] = set()
    mappings = []
    for r in body.rows:
        pn = (r.pn or "").strip()
        if not pn:
            continue
        key = pn.lower()
        if key in have:
            dup += 1
            continue
        have.add(key)
        code = (r.code or "").strip()
        if code:
            codes.add(code)
        units = float(r.units or 0)
        mappings.append({
            "product_code": code or None, "part_number": pn,
            "part_name": (r.name or "").strip(), "model": (r.model or "").strip() or None,
            "unit_value": units, "unit_time": 0, "estimated_time": units * conv,
            "source_file_id": imp.id, "source_file_name": body.file_name,
            "imported_by": imp.uploaded_by_name,
        })
        added += 1

    if mappings:
        db.bulk_insert_mappings(PartsMaster, mappings)

    imp.total_records = added
    imp.total_codes = len(codes)
    imp.dup_skipped = dup
    log_action(db, "PARTS_IMPORT", "imported_file", imp.id, admin.id,
               new={"file": body.file_name, "added": added, "codes": len(codes), "skipped": dup})
    db.commit()
    return ok({"file_id": imp.id, "added": added, "dup_skipped": dup,
               "codes": len(codes), "total_rows": len(body.rows), "version": 1},
              f'Imported "{body.file_name}" → {added} parts · {len(codes)} codes · {dup} skipped')


@router.post("/files/{file_id}/replace")
def replace_file(file_id: str, body: ImportRowsBody, db: Session = Depends(get_db), admin: User = Depends(require_admin)):
    ensure_parts_schema()
    f = db.get(ImportedFile, file_id)
    if not f:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "File not found")
    conv = _conversion(db)

    # archive history
    hist = list(f.history or [])
    hist.insert(0, {"version": f.version or 1, "date": f.created_at.isoformat() if f.created_at else None,
                    "total_parts": f.total_records, "name": f.file_name})

    # remove this file's existing parts
    db.query(PartsMaster).filter(PartsMaster.source_file_id == file_id).delete()
    db.flush()

    have = {r[0].lower() for r in db.execute(
        select(PartsMaster.part_number).where(PartsMaster.part_number.isnot(None))).all() if r[0]}
    added, dup = 0, 0
    codes: set[str] = set()
    mappings = []
    for r in body.rows:
        pn = (r.pn or "").strip()
        if not pn:
            continue
        key = pn.lower()
        if key in have:
            dup += 1
            continue
        have.add(key)
        code = (r.code or "").strip()
        if code:
            codes.add(code)
        units = float(r.units or 0)
        mappings.append({
            "product_code": code or None, "part_number": pn,
            "part_name": (r.name or "").strip(), "model": (r.model or "").strip() or None,
            "unit_value": units, "unit_time": 0, "estimated_time": units * conv,
            "source_file_id": file_id, "source_file_name": body.file_name,
            "imported_by": admin.name or admin.username or "ADMIN",
        })
        added += 1

    if mappings:
        db.bulk_insert_mappings(PartsMaster, mappings)

    f.file_name = body.file_name
    f.file_type = body.file_type
    f.size_bytes = body.size_bytes
    f.total_records = added
    f.total_codes = len(codes)
    f.dup_skipped = dup
    f.total_rows = len(body.rows)
    f.version = (f.version or 1) + 1
    f.history = hist
    f.status = "active"
    log_action(db, "PARTS_REPLACE", "imported_file", file_id, admin.id,
               new={"file": body.file_name, "version": f.version, "added": added})
    db.commit()
    return ok({"file_id": file_id, "added": added, "dup_skipped": dup,
               "codes": len(codes), "version": f.version},
              f'Replaced → v{f.version} · {added} parts re-imported · {dup} skipped')


# ── Legacy server-side parse (kept for small files / API clients) ──
@router.post("/import-file")
async def import_file(file: UploadFile = File(...), db: Session = Depends(get_db), admin: User = Depends(require_admin)):
    ensure_parts_schema()
    data = await file.read()
    name = file.filename or "upload"
    ftype = "excel" if name.lower().endswith((".xlsx", ".xls")) else "pdf"
    rows = file_parser.parse_excel(data) if ftype == "excel" else file_parser.parse_pdf_parts(data)

    imp = ImportedFile(file_name=name, file_type=ftype, uploaded_by=admin.id,
                       uploaded_by_name=admin.name or admin.username or "ADMIN",
                       status="active", size_bytes=len(data), total_rows=len(rows), history=[])
    db.add(imp); db.flush()

    conv = _conversion(db)
    seen: set[str] = set()
    codes: set[str] = set()
    created = 0
    for r in rows:
        pn = r.get("part_number")
        if pn and pn in seen:
            continue
        if pn:
            seen.add(pn)
        code = r.get("product_code")
        if code:
            codes.add(code)
        db.add(PartsMaster(
            product_code=code, part_number=pn, part_name=r.get("part_name", ""),
            unit_value=r.get("unit_value", 0), unit_time=r.get("unit_time", 0),
            estimated_time=r.get("unit_value", 0) * conv, source_file_id=imp.id,
            source_file_name=name, imported_by=imp.uploaded_by_name,
        ))
        created += 1
    imp.total_records = created
    imp.total_codes = len(codes)
    log_action(db, "PARTS_IMPORT", "imported_file", imp.id, admin.id, new={"records": created})
    db.commit()
    return ok({"file_id": imp.id, "records": created, "added": created}, f"Imported {created} parts")


@router.get("/files")
def list_files(db: Session = Depends(get_db), _: User = Depends(require_admin)):
    ensure_parts_schema()
    files = db.scalars(select(ImportedFile).order_by(ImportedFile.created_at.desc())).all()
    return ok([_file_out(f) for f in files])


@router.get("/files/{file_id}")
def file_detail(file_id: str, db: Session = Depends(get_db), _: User = Depends(require_admin)):
    ensure_parts_schema()
    f = db.get(ImportedFile, file_id)
    if not f:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "File not found")
    mpu = _conversion(db)
    parts = db.scalars(select(PartsMaster).where(PartsMaster.source_file_id == file_id)
                       .order_by(PartsMaster.created_at)).all()
    return ok({
        "file": _file_out(f),
        "parts": [_part_out(p, mpu) for p in parts],
        "mpu": mpu,
        "total_est": round(sum((p.unit_value or 0) * mpu for p in parts)),
    })


@router.get("/files/{file_id}/dependencies")
def file_dependencies(file_id: str, db: Session = Depends(get_db), _: User = Depends(require_admin)):
    """Best-effort check: are any of this file's parts referenced by active work?
    Job cards in this system don't persist matched part numbers, so this is 0
    unless a future schema links them — keeps the cascade-delete UI honest."""
    return ok({"hasActive": False, "count": 0})


# ── Parts CRUD / search ────────────────────────────────────────────
@router.get("")
def list_parts(
    q: str | None = Query(None), source_file_id: str | None = None, model: str | None = None,
    page: int = 1, size: int = 50,
    db: Session = Depends(get_db), _: User = Depends(require_admin),
):
    ensure_parts_schema()
    mpu = _conversion(db)
    stmt = select(PartsMaster)
    if source_file_id == "manual":
        stmt = stmt.where(PartsMaster.source_file_id.is_(None))
    elif source_file_id and source_file_id not in ("ALL", ""):
        stmt = stmt.where(PartsMaster.source_file_id == source_file_id)
    if model and model not in ("ALL", ""):
        stmt = stmt.where(PartsMaster.model == model)
    if q:
        like = f"%{q}%"
        stmt = stmt.where(or_(
            PartsMaster.product_code.ilike(like),
            PartsMaster.part_number.ilike(like),
            PartsMaster.part_name.ilike(like),
            PartsMaster.model.ilike(like),
        ))
    total = db.scalar(select(func.count()).select_from(stmt.subquery()))
    stmt = stmt.order_by(PartsMaster.created_at.desc())
    rows = db.scalars(stmt.offset((page - 1) * size).limit(size)).all()
    return ok({"total": total, "page": page, "size": size, "mpu": mpu,
               "items": [_part_out(p, mpu) for p in rows]})


@router.get("/models")
def list_models(db: Session = Depends(get_db), _: User = Depends(require_admin)):
    rows = db.execute(select(PartsMaster.model).where(PartsMaster.model.isnot(None))
                      .where(PartsMaster.model != "").distinct()).all()
    return ok(sorted({r[0] for r in rows if r[0]}))


@router.post("")
def add_part(body: PartCreate, db: Session = Depends(get_db), admin: User = Depends(require_admin)):
    ensure_parts_schema()
    conv = _conversion(db)
    # duplicate part_number guard
    if body.part_number:
        existing = db.scalar(select(PartsMaster).where(
            func.lower(PartsMaster.part_number) == body.part_number.strip().lower()))
        if existing:
            raise HTTPException(status.HTTP_409_CONFLICT, "Duplicate part number")
    p = PartsMaster(**body.model_dump(), estimated_time=body.unit_value * conv,
                    source_file_name="Manual entry", imported_by=admin.name or admin.username)
    db.add(p)
    log_action(db, "PARTS_CREATE", "part", None, admin.id, new={"pn": body.part_number, "name": body.part_name})
    db.commit(); db.refresh(p)
    return ok(_part_out(p, conv), "Part added")


@router.put("/{part_id}")
def update_part(part_id: str, body: PartUpdate, db: Session = Depends(get_db), admin: User = Depends(require_admin)):
    ensure_parts_schema()
    p = db.get(PartsMaster, part_id)
    if not p:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Part not found")
    if body.part_number:
        dupe = db.scalar(select(PartsMaster).where(
            func.lower(PartsMaster.part_number) == body.part_number.strip().lower(),
            PartsMaster.id != part_id))
        if dupe:
            raise HTTPException(status.HTTP_409_CONFLICT, "Duplicate part number")
    for field, value in body.model_dump(exclude_none=True).items():
        setattr(p, field, value)
    p.estimated_time = p.unit_value * _conversion(db)
    log_action(db, "PARTS_UPDATE", "part", part_id, admin.id, new={"pn": p.part_number, "name": p.part_name})
    db.commit(); db.refresh(p)
    return ok(_part_out(p, _conversion(db)), "Part updated")


@router.delete("/{part_id}")
def delete_part(part_id: str, db: Session = Depends(get_db), admin: User = Depends(require_admin)):
    p = db.get(PartsMaster, part_id)
    if not p:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Part not found")
    log_action(db, "PARTS_DELETE", "part", part_id, admin.id, old={"pn": p.part_number, "name": p.part_name})
    db.delete(p); db.commit()
    return ok(message="Part deleted")


@router.delete("/files/{file_id}")
def delete_file(file_id: str, db: Session = Depends(get_db), admin: User = Depends(require_admin)):
    f = db.get(ImportedFile, file_id)
    if not f:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "File not found")
    removed = db.query(PartsMaster).filter(PartsMaster.source_file_id == file_id).delete()
    db.delete(f)
    log_action(db, "PARTS_FILE_DELETE", "imported_file", file_id, admin.id,
               old={"file": f.file_name, "parts_removed": removed})
    db.commit()
    return ok({"removed": removed}, f'Deleted "{f.file_name}" → {removed} parts cascade-removed')


# ── Audit log ──────────────────────────────────────────────────────
@router.get("/audit")
def parts_audit(db: Session = Depends(get_db), _: User = Depends(require_admin)):
    rows = db.scalars(select(AuditLog).where(AuditLog.action.like("PARTS%") | (AuditLog.action == "UNIT_CONVERSION_CHANGE"))
                      .order_by(AuditLog.timestamp.desc()).limit(200)).all()
    names = {u.id: (u.name or u.username) for u in db.scalars(select(User)).all()}

    def _detail(r: AuditLog) -> str:
        n = r.new_value or {}
        o = r.old_value or {}
        if r.action == "PARTS_IMPORT":
            return f'Imported "{n.get("file","file")}" → {n.get("added", n.get("records",0))} parts, {n.get("codes",0)} codes, {n.get("skipped",0)} skipped'
        if r.action == "PARTS_REPLACE":
            return f'Replaced "{n.get("file","file")}" → v{n.get("version","?")}, {n.get("added",0)} new parts'
        if r.action == "PARTS_FILE_DELETE":
            return f'Deleted file "{o.get("file","file")}" → {o.get("parts_removed",0)} parts cascade-removed'
        if r.action == "PARTS_CREATE":
            return f'Added {n.get("pn","")} · {n.get("name","")}'
        if r.action == "PARTS_UPDATE":
            return f'Edited {n.get("pn","")} · {n.get("name","")}'
        if r.action == "PARTS_DELETE":
            return f'Removed {o.get("pn","")} · {o.get("name","")}'
        if r.action == "UNIT_CONVERSION_CHANGE":
            return f'Unit conversion {o.get("value","?")}→{n.get("value","?")} min/unit · {n.get("records",0)} parts recalculated'
        return r.action

    label = {"PARTS_IMPORT": "IMPORT", "PARTS_REPLACE": "REPLACE", "PARTS_FILE_DELETE": "DELETE_FILE",
             "PARTS_CREATE": "CREATE", "PARTS_UPDATE": "UPDATE", "PARTS_DELETE": "DELETE",
             "UNIT_CONVERSION_CHANGE": "CONFIG"}
    return ok([{
        "action": label.get(r.action, r.action),
        "detail": _detail(r),
        "ts": r.timestamp.isoformat() if r.timestamp else None,
        "user": names.get(r.changed_by, "system"),
    } for r in rows])


# ── Job-card estimation ────────────────────────────────────────────
@router.post("/estimate-from-job-card")
async def estimate_from_job_card(
    file: UploadFile = File(...),
    db: Session = Depends(get_db),
    _: User = Depends(require_admin),
):
    """Upload a job card PDF/Excel, extract part numbers, match against the
    parts master, and return the total estimated service time."""
    data = await file.read()
    name = file.filename or "job_card"
    is_excel = name.lower().endswith((".xlsx", ".xls"))

    # qty-aware parts (correct column order) via the shared deterministic parser
    if is_excel:
        parts = [{"part_name": r.get("part_name"), "part_number": r.get("part_number"),
                  "job_code": r.get("product_code"), "qty": 1,
                  "unit_value": r.get("unit_value")} for r in file_parser.parse_excel(data)]
    else:
        parts = jobcard_parser.parse(data).get("parts") or []
        if not parts:   # fallback: scrape part numbers (qty defaults to 1)
            parts = [{"part_number": n, "qty": 1}
                     for n in file_parser.extract_part_numbers_from_job_card(data, name)]

    # ONE estimator — qty × matched Parts Time minutes (never customer-voice)
    pta = estimate_service.estimate_from_parts(db, parts)
    return ok({
        "total_estimated_minutes": pta["estimated_minutes"],
        "estimate_status": pta["estimate_status"],
        "matched_count": pta["matched_count"] + pta["low_confidence_count"],
        "unmatched_count": pta["missing_count"],
        "matched_parts": pta["matched_parts"] + pta["low_confidence_parts"],
        "unmatched_part_numbers": [p.get("part_number") for p in pta["missing_parts"] if p.get("part_number")],
        "missing_parts": pta["missing_parts"],
        "extracted_count": pta["extracted_count"],
        "parts_time_analysis": pta,
    }, f'{pta["extracted_count"]} parts · {pta["matched_count"]} matched · {pta["estimated_minutes"]} min estimated')


# ── Unit conversion ────────────────────────────────────────────────
@router.get("/unit-conversion")
def get_conversion(db: Session = Depends(get_db), _: User = Depends(require_admin)):
    return ok({"value_minutes": _conversion(db)})


@router.post("/unit-conversion")
def set_conversion(body: UnitConversionUpdate, db: Session = Depends(get_db), admin: User = Depends(require_admin)):
    if not body.confirm:
        raise HTTPException(status.HTTP_400_BAD_REQUEST,
                            "Confirmation required: this recalculates every part's estimated time")
    previous = _conversion(db)
    parts = db.scalars(select(PartsMaster)).all()
    for p in parts:
        p.estimated_time = p.unit_value * body.value_minutes
    db.add(UnitConversionSetting(value_minutes=body.value_minutes, previous_value=previous,
                                 changed_by=admin.id, records_affected=len(parts)))
    log_action(db, "UNIT_CONVERSION_CHANGE", "unit_conversion", None, admin.id,
               old={"value": previous}, new={"value": body.value_minutes, "records": len(parts)})
    db.commit()
    return ok({"value_minutes": body.value_minutes, "records_affected": len(parts)}, "Conversion updated")
