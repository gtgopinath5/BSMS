"""Public branch directory — read-only, NO authentication.

Powers the pre-login facility picker on the landing page so that the
list of branches comes from PostgreSQL (the `branches` table) instead of
a hardcoded frontend array. Exposes ONLY non-sensitive directory info
plus aggregate counts (bays / crew / jobs today); no per-user or
per-job data. This is the single pre-auth read in the system.
"""
from datetime import datetime, timezone

from fastapi import APIRouter, Depends
from sqlalchemy import select, func
from sqlalchemy.orm import Session

from ..database import get_db
from ..models.branch import Branch
from ..models.bay import Bay
from ..models.user import User, UserRole
from ..models.job import JobCard
from ..schemas.common import ok

router = APIRouter()


@router.get("")
@router.get("/")
def list_branches(db: Session = Depends(get_db)):
    """Operational branches + live counts, straight from PostgreSQL."""
    rows = db.scalars(select(Branch).order_by(Branch.id)).all()
    today = datetime.now(timezone.utc).date()
    out = []
    for b in rows:
        bays = db.scalar(select(func.count()).select_from(Bay).where(
            Bay.branch_id == b.id, Bay.is_active.isnot(False))) or 0
        crew = db.scalar(select(func.count()).select_from(User).where(
            User.branch_id == b.id, User.role == UserRole.worker)) or 0
        jobs_today = db.scalar(select(func.count()).select_from(JobCard).where(
            JobCard.branch_id == b.id,
            func.date(JobCard.created_at) == today)) or 0
        out.append({
            "id": b.id,
            "name": b.name,
            "region": b.location,
            "bays": bays,
            "workers": crew,
            "jobs": jobs_today,
            "status": b.status,
        })
    return ok(out)
