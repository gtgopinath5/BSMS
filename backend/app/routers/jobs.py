from fastapi import APIRouter, Depends, HTTPException, status, UploadFile, File
from sqlalchemy import select, func, text
from sqlalchemy.orm import Session

from ..database import get_db, engine
from ..models.job import JobCard, JobQueue, QueueStatus, Priority
from ..models.user import User
from ..schemas.job import JobCardCreate, JobCardUpdate
from ..schemas.common import ok
from ..utils.auth import require_admin, assert_branch_access
from ..utils.audit import log_action
from ..utils import ids, job_extractor, jobcard_parser
from ..services import workflow_engine, estimate_service

router = APIRouter()

_JOB_MIGRATED = False


def ensure_job_schema() -> None:
    """Add JobCard columns introduced after first release. Idempotent."""
    global _JOB_MIGRATED
    if _JOB_MIGRATED:
        return
    dialect = engine.dialect.name
    json_type = "JSON" if dialect == "postgresql" else "TEXT"
    cols = [("customer_address", "VARCHAR"), ("complaint", "VARCHAR"), ("notes", "VARCHAR"),
            ("services", json_type),
            # PDF extraction → Parts Time matching (additive)
            ("parts", json_type), ("estimate_status", "VARCHAR"),
            ("extraction_confidence", "FLOAT")]
    with engine.begin() as conn:
        try:
            if dialect == "postgresql":
                existing = {r[0] for r in conn.execute(text(
                    "SELECT column_name FROM information_schema.columns WHERE table_name='job_cards'"))}
            else:
                existing = {r[1] for r in conn.execute(text("PRAGMA table_info(job_cards)"))}
        except Exception:
            existing = set()
        for name, ddl in cols:
            if name not in existing:
                try:
                    conn.execute(text(f"ALTER TABLE job_cards ADD COLUMN {name} {ddl}"))
                except Exception:
                    pass
    _JOB_MIGRATED = True


def _queue_job(db: Session, job: JobCard, worker_id: str, priority: Priority, bay_id: str | None = None) -> JobQueue:
    pos = db.scalar(
        select(func.count()).select_from(JobQueue).where(
            JobQueue.worker_id == worker_id, JobQueue.status == QueueStatus.queued
        )
    ) or 0
    item = JobQueue(job_card_id=job.id, worker_id=worker_id, status=QueueStatus.queued,
                    priority=priority, queue_position=pos + 1, bay_id=bay_id)
    db.add(item)
    return item


def _resolve_worker_for_job(db: Session, body: JobCardCreate, admin: User) -> str:
    """Bay-first, strict: the job is created FOR a bay; its worker is the bay's
    current owner (temp replacement > primary). A client-supplied `worker_id`
    is IGNORED — there is no legacy fallback, so the API cannot be used to
    hand-pick a worker. An unstaffed / maintenance / disabled bay is rejected.
    Branch ownership of the target bay is enforced (Master bypasses)."""
    from ..models.bay import Bay
    if not body.bay_id:
        raise HTTPException(status.HTTP_400_BAD_REQUEST,
                            "Bay-first: select a bay for this job (worker is resolved from the bay).")
    bay = db.get(Bay, body.bay_id)
    if not bay:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Bay not found")
    assert_branch_access(admin, bay.branch_id, "create job for bay")
    if bay.status in ("maintenance", "disabled") or getattr(bay, "is_active", True) is False:
        raise HTTPException(status.HTTP_409_CONFLICT,
                            f"Bay {bay.bay_number:02d} is not operational ({bay.status}).")
    worker_id = workflow_engine.resolve_bay_worker(db, body.bay_id)
    if not worker_id:
        raise HTTPException(status.HTTP_400_BAD_REQUEST,
                            "Bay is not operational. Assign a primary worker first.")
    return worker_id


@router.post("/manual")
def create_manual(body: JobCardCreate, db: Session = Depends(get_db), admin: User = Depends(require_admin)):
    ensure_job_schema()
    worker_id = _resolve_worker_for_job(db, body, admin)
    job = JobCard(
        job_card_number=ids.next_job_card_number(db, JobCard),
        vehicle_number=body.vehicle_number, vehicle_model=body.vehicle_model,
        chassis_number=body.chassis_number, engine_number=body.engine_number, km_reading=body.km_reading,
        customer_name=body.customer_name, customer_mobile=body.customer_mobile, customer_email=body.customer_email,
        customer_address=body.customer_address,
        service_type=body.service_type, repair_type=body.repair_type,
        estimated_cost=body.estimated_cost, estimated_minutes=body.estimated_minutes,
        complaint=body.complaint, notes=body.notes, services=body.services,
        parts=body.parts, estimate_status=body.estimate_status,
        extraction_confidence=body.extraction_confidence,
        source_type=body.source_type or "manual", branch_id=admin.branch_id, created_by=admin.id,
    )
    db.add(job); db.flush()
    item = _queue_job(db, job, worker_id, body.priority, body.bay_id)
    log_action(db, "JOB_CREATED", "job_card", job.id, admin.id,
               new={"jc": job.job_card_number, "customer": job.customer_name})
    db.commit(); db.refresh(item)
    return ok({"job_card_id": job.id, "job_card_number": job.job_card_number, "queue_id": item.id},
              "Job card created and queued")


@router.put("/{job_card_id}")
def update_job(job_card_id: str, body: JobCardUpdate, db: Session = Depends(get_db), admin: User = Depends(require_admin)):
    ensure_job_schema()
    job = db.get(JobCard, job_card_id)
    if not job:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Job card not found")
    assert_branch_access(admin, job.branch_id, "update job")
    for field, value in body.model_dump(exclude_unset=True).items():
        setattr(job, field, value)
    log_action(db, "JOB_UPDATED", "job_card", job.id, admin.id, new={"jc": job.job_card_number})
    db.commit()
    return ok({"job_card_id": job.id}, "Job card updated")


def _match_service_time(db: Session, service: str, phrase: str, default_min: float) -> dict:
    """Match a mapped service against Parts Time. Priority:
       1) exact product_code  2) full service phrase inside a product name
       3) service-map default. Matching is deliberately STRICT — the Triumph
       card is service-based, so loose single-word matches (e.g. "service",
       "indicator") would grab unrelated parts and inflate the estimate."""
    from ..models.part import PartsMaster
    from sqlalchemy import select, func

    svc = (service or "").strip()
    # priority 1: a product code equal to the service token (rare but exact)
    for tok in {svc.lower(), (phrase or "").lower()}:
        if tok:
            row = db.scalar(select(PartsMaster).where(func.lower(PartsMaster.product_code) == tok))
            if row:
                return {"part_code": row.product_code, "part_name": row.part_name,
                        "match": "CODE", "minutes": round(row.estimated_time or default_min, 1)}
    # priority 2: the FULL service name appears as a phrase in a part name
    row = db.scalar(select(PartsMaster).where(PartsMaster.part_name.ilike(f"%{svc}%")))
    if row:
        return {"part_code": row.product_code, "part_name": row.part_name,
                "match": "NAME", "minutes": round(row.estimated_time or default_min, 1)}
    # priority 3: service-map default time
    return {"part_code": None, "part_name": service, "match": "SERVICE", "minutes": round(default_min, 1)}


def _build_analysis(db: Session, services: list[dict]) -> dict:
    rows, total = [], 0.0
    matched = unmatched = 0
    for s in services:
        r = _match_service_time(db, s["service"], s.get("matched_phrase", ""), s.get("default_minutes", 15))
        total += r["minutes"]
        if r["match"] in ("CODE", "NAME"):
            matched += 1
        else:
            unmatched += 1
        rows.append({"service": s["service"], "phrase": s.get("matched_phrase"), "qty": 1, **r})
    return {"rows": rows, "total_minutes": round(total),
            "matched_count": matched, "unmatched_count": unmatched, "service_count": len(rows)}


@router.post("/extract-pdf")
async def extract_pdf(file: UploadFile = File(...), db: Session = Depends(get_db), _: User = Depends(require_admin)):
    """Deterministic, template-aware job-card extraction (6 sections + Parts Detail
    table) → match parts against the Parts Time master → estimated minutes. The
    estimate comes ONLY from matched master parts (qty × master minutes); Customer
    Voice is extracted for context but never added."""
    from ..utils import triumph_parser
    data = await file.read()
    parsed = jobcard_parser.parse(data)
    if not parsed.get("valid"):
        return ok({"valid": False, "score": parsed.get("score", 0),
                   "template": parsed.get("template"),
                   "missing_keywords": parsed.get("missing_keywords", [])},
                  "Invalid Job Card — please upload a valid job card PDF")

    parts = parsed.get("parts") or []
    pta = estimate_service.estimate_from_parts(db, parts)

    # Customer Voice → canonical services, CONTEXT ONLY (not summed into the estimate)
    voice_services = triumph_parser.map_services(parsed.get("customer_voice") or "")

    # backward-compat `analysis` shape (the current modal renders analysis.rows /
    # analysis.total_minutes until Phase 2 redesigns the table) — now parts-based.
    rows = []
    for r in (pta["matched_parts"] + pta["low_confidence_parts"] + pta["missing_parts"]):
        rows.append({
            "service": r.get("part_name"), "part_name": r.get("part_name"),
            "part_number": r.get("part_number"), "qty": r.get("qty"),
            "match": r.get("match"), "minutes": r.get("total_minutes", 0),
            "matched_part_name": r.get("matched_part_name"),
        })
    analysis = {"rows": rows, "total_minutes": pta["estimated_minutes"],
                "matched_count": pta["matched_count"] + pta["low_confidence_count"],
                "unmatched_count": pta["missing_count"], "service_count": pta["extracted_count"]}

    return ok({
        "valid": True,
        "template": parsed.get("template"),
        "score": parsed.get("score", 0),
        "confidence": parsed.get("confidence"),
        "fields": parsed.get("fields", {}),
        # structured sections (Phase 2 modal)
        "vehicle": parsed.get("vehicle", {}), "customer": parsed.get("customer", {}),
        "service": parsed.get("service", {}), "staff_status": parsed.get("staff_status", {}),
        "customer_voice": parsed.get("customer_voice"),
        "voice_services": voice_services,        # context only
        "services": voice_services,              # backward-compat key (context)
        "parts": parts,                          # Parts Detail incl. dealership cost columns
        "cost_totals": parsed.get("cost_totals", {}),     # service/labour/grand totals from the PDF
        "cost_warnings": parsed.get("cost_warnings", []), # row/grand mismatch warnings (display only)
        "parts_time_analysis": pta,
        "analysis": analysis,                    # backward-compat for the existing modal
        "total_estimated_minutes": pta["estimated_minutes"],
        # convenience top-level mirrors for the Phase 2 modal (single source = pta / parsed)
        "estimate_status": pta["estimate_status"],
        "extraction_confidence": parsed.get("confidence"),
        "parts_corrupted": parsed.get("parts_corrupted", False),
    }, f'Extracted · {len(parts)} parts · {pta["matched_count"]} matched · {pta["missing_count"]} missing · {pta["estimated_minutes"]} min')


@router.post("/save-to-queue")
def save_to_queue(body: JobCardCreate, db: Session = Depends(get_db), admin: User = Depends(require_admin)):
    """Save an extracted (or manually-edited) job card into a worker's queue."""
    return create_manual(body, db, admin)
