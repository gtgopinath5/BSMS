"""Human-readable ID generators that mirror the frontend formats."""
import uuid
from datetime import datetime
from sqlalchemy import select, func
from sqlalchemy.orm import Session


def new_uuid() -> str:
    return str(uuid.uuid4())


def _year() -> int:
    return datetime.utcnow().year


def _next_seq(db: Session, model, prefix: str) -> str:
    """{prefix}-YYYY-NNNNNN where N = (max existing numeric suffix) + 1.

    Derived from the MAX existing id, never the row COUNT — counting breaks the
    moment any row is deleted (count < max ⇒ a reused number ⇒ PK UniqueViolation).
    """
    mx = 0
    for v in db.scalars(select(model.id)).all():
        tail = str(v).rsplit("-", 1)[-1]
        if tail.isdigit():
            mx = max(mx, int(tail))
    return f"{prefix}-{_year()}-{mx + 1:06d}"


def next_service_session_id(db: Session, model) -> str:
    """SS-YYYY-NNNNNN — monotonic, collision-proof across deletions."""
    return _next_seq(db, model, "SS")


def next_recording_id(db: Session, model) -> str:
    """REC-YYYY-NNNNNN — monotonic, collision-proof across deletions."""
    return _next_seq(db, model, "REC")


def next_customer_watch_id(db: Session, model) -> str:
    """CW-YYYY-NNNNNN — the public, shareable watch "Session ID" (safe as a watermark)."""
    return _next_seq(db, model, "CW")


def next_customer_approval_id(db: Session, model) -> str:
    """CA-YYYY-NNNNNN — the customer estimate-approval request number."""
    return _next_seq(db, model, "CA")


def next_job_card_number(db: Session, model) -> str:
    """JC-NNNN — continues from the max existing number."""
    rows = db.scalars(select(model.job_card_number)).all()
    mx = 1000
    for v in rows:
        digits = "".join(ch for ch in str(v) if ch.isdigit())
        if digits:
            mx = max(mx, int(digits))
    return f"JC-{mx + 1}"


def next_employee_id(db: Session, model) -> str:
    """EMP-NNNN — continues from the max numeric EMP id (starts at EMP-1001).

    Only considers ids that look like EMP-#### so admin/master ids (ADMIN-014,
    MA-001) never collide with the worker sequence."""
    mx = 1000
    for v in db.scalars(select(model.employee_id)).all():
        s = str(v or "")
        if s.upper().startswith("EMP-"):
            tail = s.split("-")[-1]
            if tail.isdigit():
                mx = max(mx, int(tail))
    return f"EMP-{mx + 1}"
