"""Single source of truth for the 'paused (reference)' duration shown on every
Work Completion surface — Admin/Master Work Completion, the Completion Report
modal, the PDF report, and the Worker Job Log.

Pause COUNT comes from the real JOB_PAUSED audit trail (never faked). Total
paused DURATION is derived exactly from (clock − actual), since actual_duration
already excludes pauses. Keeping this here guarantees all screens agree on the
same value for the same job/session.
"""
from sqlalchemy import select, func

from ..models.audit import AuditLog


def pause_counts_for(db, session_ids):
    """Batched JOB_PAUSED audit counts → {session_id: count} (one query)."""
    out: dict[str, int] = {}
    if session_ids:
        for sid, cnt in db.execute(
            select(AuditLog.entity_id, func.count())
            .where(
                AuditLog.action == "JOB_PAUSED",
                AuditLog.entity_type == "service_session",
                AuditLog.entity_id.in_(session_ids),
            )
            .group_by(AuditLog.entity_id)
        ).all():
            out[sid] = int(cnt)
    return out


def started_meta_for(db, session_ids):
    """Batched JOB_STARTED audit meta → {session_id: new_value_dict}.

    `workflow_engine.emit` records `{warnings, estimate_source, approved_cost,
    estimated_minutes}` on the single JOB_STARTED audit row per session (a second
    Start is a 409, so there is exactly one row). This is the canonical, truthful
    snapshot of *what was used at start* — the authoritative warning summary and
    estimate source/cost for a COMPLETED job, without any recompute. Sessions
    started before this hardening simply have no row → callers fall back safely.
    """
    out: dict[str, dict] = {}
    if session_ids:
        for sid, meta in db.execute(
            select(AuditLog.entity_id, AuditLog.new_value)
            .where(
                AuditLog.action == "JOB_STARTED",
                AuditLog.entity_type == "service_session",
                AuditLog.entity_id.in_(session_ids),
            )
        ).all():
            if isinstance(meta, dict) and sid not in out:
                out[sid] = meta
    return out


def derive_pause(start_time, end_time, actual_duration, pause_count):
    """Return (paused_min, paused_known, clock_min) using the canonical
    derivation. `actual_duration` is in seconds (ServiceSession.actual_duration).

    - No pause events ever recorded (pause_count == 0) → paused = 0 (any tiny
      clock−actual delta is timing noise, not a real pause).
    - Otherwise paused = round((clock − actual) / 60) computed in SECONDS so it
      is not double-rounded.
    - Timestamps incomplete → paused unknown.
    """
    clock_sec = (
        (end_time - start_time).total_seconds() if (start_time and end_time) else None
    )
    actual_sec = actual_duration if actual_duration is not None else clock_sec
    clock_min = round(clock_sec / 60) if clock_sec is not None else None
    if pause_count == 0:
        return 0, True, clock_min
    if clock_sec is not None and actual_sec is not None:
        return round(max(0.0, clock_sec - actual_sec) / 60), True, clock_min
    return None, False, clock_min
