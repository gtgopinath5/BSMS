"""Worker Bay-to-Bay Time Analysis — API (Admin + Master analytics; READ-ONLY over the lifecycle).

All numbers are DERIVED from ``ServiceSession`` rows by ``worker_transition_analysis_service`` (which
reuses the pinned ``utils/completion.py`` pause truth). The ONLY persisted state is the delay reason
(``WorkerTransitionDelayReason``). Admin = own branch; Master = global. ``require_admin`` already
admits master, so master can add a reason via the admin route; an explicit ``require_master`` reason
route is also provided (both funnel through one guarded upsert, tagging the actual role).
"""
import logging

from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel
from sqlalchemy import text

from ..database import get_db, engine
from ..models.user import User
from ..models.worker_transition import REASON_CATEGORIES, RESPONSIBLE_TYPES, THRESHOLD_STATUSES
from ..schemas.common import ok
from ..services import worker_transition_analysis_service as WTA
from ..utils.auth import require_admin, require_master, is_master

log = logging.getLogger("baywatch.worker_transition")
router = APIRouter()

_WTA_MIGRATED = False


def ensure_worker_transition_schema() -> None:
    """Idempotent guard. ``init_db()`` create_all builds the table; this only exists to ADD columns
    introduced after the table already exists (PG + SQLite). Never drops. Currently a no-op set."""
    global _WTA_MIGRATED
    if _WTA_MIGRATED:
        return
    later = {"worker_transition_delay_reasons": []}   # add ("col","DDL") tuples here in future
    dialect = engine.dialect.name
    with engine.begin() as conn:
        for tbl, cols in later.items():
            if not cols:
                continue
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
    _WTA_MIGRATED = True


class ReasonBody(BaseModel):
    reason_category: str | None = None
    reason_note: str | None = None
    responsible_type: str | None = None


def _validate_reason(body: ReasonBody):
    if body.reason_category and body.reason_category not in REASON_CATEGORIES:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Invalid reason_category")
    if body.responsible_type and body.responsible_type not in RESPONSIBLE_TYPES:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Invalid responsible_type")
    if not body.reason_category:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "reason_category is required")


def _save(db, me, transition_id, body: ReasonBody, role: str):
    _validate_reason(body)
    try:
        return WTA.save_reason(db, me, transition_id, reason_category=body.reason_category,
                               reason_note=body.reason_note, responsible_type=body.responsible_type,
                               role=role)
    except LookupError as e:
        raise HTTPException(status.HTTP_404_NOT_FOUND, str(e))
    except ValueError as e:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(e))


# ════════════════════════════════════════════════════════════════════
#  ADMIN (own branch; master admits here too)
# ════════════════════════════════════════════════════════════════════
@router.get("/admin/analytics/worker-transition/meta")
def admin_meta(me: User = Depends(require_admin)):
    """Vocab + thresholds for the UI dropdowns / legend."""
    return ok({"reason_categories": REASON_CATEGORIES, "responsible_types": RESPONSIBLE_TYPES,
               "threshold_statuses": list(THRESHOLD_STATUSES), "shift_minutes": WTA.SHIFT_MINUTES,
               "shift_basis": WTA.SHIFT_BASIS,
               "thresholds": {"good_max": WTA.T_GOOD_MAX, "warning_max": WTA.T_WARNING_MAX,
                              "late_max": WTA.T_LATE_MAX, "reason_required_above": WTA.REASON_REQUIRED_ABOVE}})


@router.get("/admin/analytics/worker-transition/summary")
def admin_summary(date: str = Query(None), worker_id: str = Query(None),
                  db=Depends(get_db), me: User = Depends(require_admin)):
    return ok(WTA.summary(db, me, date=date, worker_id=worker_id))


@router.get("/admin/analytics/worker-transition/workers")
def admin_workers(date: str = Query(None), worker_id: str = Query(None), status_f: str = Query(None, alias="status"),
                  db=Depends(get_db), me: User = Depends(require_admin)):
    return ok(WTA.workers(db, me, date=date, worker_id=worker_id, status=status_f))


@router.get("/admin/analytics/worker-transition/workers/{worker_id}/timeline")
def admin_timeline(worker_id: str, date: str = Query(None),
                   db=Depends(get_db), me: User = Depends(require_admin)):
    return ok(WTA.timeline(db, me, worker_id, date=date))


@router.get("/admin/analytics/worker-transition/transitions")
def admin_transitions(date: str = Query(None), worker_id: str = Query(None),
                      status_f: str = Query(None, alias="status"), reason_missing: str = Query(None),
                      db=Depends(get_db), me: User = Depends(require_admin)):
    return ok(WTA.transitions(db, me, date=date, worker_id=worker_id, status=status_f,
                              reason_missing=reason_missing))


@router.post("/admin/analytics/worker-transition/transitions/{transition_id}/reason")
def admin_save_reason(transition_id: str, body: ReasonBody,
                      db=Depends(get_db), me: User = Depends(require_admin)):
    role = "master" if is_master(me) else "admin"
    return ok(_save(db, me, transition_id, body, role), "Delay reason saved")


# ════════════════════════════════════════════════════════════════════
#  MASTER (global)
# ════════════════════════════════════════════════════════════════════
@router.get("/master/analytics/worker-transition/summary")
def master_summary(date: str = Query(None), db=Depends(get_db), me: User = Depends(require_master)):
    return ok(WTA.master_summary(db, me, date=date))


@router.get("/master/analytics/worker-transition/branches/{branch_id}")
def master_branch(branch_id: str, date: str = Query(None), worker_id: str = Query(None),
                  db=Depends(get_db), me: User = Depends(require_master)):
    return ok({
        "branch_id": branch_id, "date": date,
        "summary": WTA.summary(db, me, date=date, worker_id=worker_id, branch_id=branch_id),
        "workers": WTA.workers(db, me, date=date, worker_id=worker_id, branch_id=branch_id),
        "transitions": WTA.transitions(db, me, date=date, worker_id=worker_id, branch_id=branch_id),
    })


@router.get("/master/analytics/worker-transition/workers/{worker_id}/timeline")
def master_timeline(worker_id: str, date: str = Query(None),
                    db=Depends(get_db), me: User = Depends(require_master)):
    return ok(WTA.timeline(db, me, worker_id, date=date))


@router.post("/master/analytics/worker-transition/transitions/{transition_id}/reason")
def master_save_reason(transition_id: str, body: ReasonBody,
                       db=Depends(get_db), me: User = Depends(require_master)):
    return ok(_save(db, me, transition_id, body, "master"), "Delay reason saved")
