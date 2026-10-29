"""Worker Bay-to-Bay Time Analysis — the calculation engine (READ-ONLY over the job lifecycle).

Everything here is DERIVED from ``ServiceSession`` rows (created_at = assigned, start_time = started,
end_time = completed) + the pinned pause truth in ``utils/completion.py``. It NEVER writes a session
or touches the workflow engine. The only persisted state is the admin/master delay reason
(``WorkerTransitionDelayReason``), which this service merges in and upserts.

Shift model (confirmed): a FIXED 9-hour / 540-minute shift denominator — the app has no attendance
clock-in/out, so ``unassigned_idle`` is the *remaining shift capacity* and is labeled as an
assumption (see ``shift_basis`` in every worker payload). Overtime = active span beyond 540.
"""
from datetime import datetime, date as date_cls

from sqlalchemy import select
from sqlalchemy.orm import Session

from ..models.session import ServiceSession, SessionStatus
from ..models.job import JobCard
from ..models.bay import Bay
from ..models.user import User, UserRole
from ..models.branch import Branch
from ..models.worker_transition import (
    WorkerTransitionDelayReason, REASON_CATEGORIES, RESPONSIBLE_TYPES,
)
from ..models.base import naive_utcnow
from ..utils.auth import is_master
from ..utils.completion import pause_counts_for, derive_pause

# ── constants (fixed shift + transition thresholds) ────────────────────────
SHIFT_MINUTES = 540
T_GOOD_MAX = 10          # <=10 good
T_WARNING_MAX = 20       # 11-20 warning
T_LATE_MAX = 30          # 21-30 late  · >30 critical
REASON_REQUIRED_ABOVE = 20
SHIFT_BASIS = "Fixed 9-hour / 540-minute shift (no attendance clock — unassigned idle is remaining capacity)"

# reason vocab is owned by the model; re-exported here as lists for the API/UI
REASON_CATEGORIES = list(REASON_CATEGORIES)
RESPONSIBLE_TYPES = list(RESPONSIBLE_TYPES)


def _iso(dt):
    return dt.isoformat() if dt else None


def _naive(dt):
    return dt.replace(tzinfo=None) if (dt and dt.tzinfo) else dt


def _mins_between(a, b):
    """b − a in whole minutes (rounded), or None when either side is missing."""
    a, b = _naive(a), _naive(b)
    if a and b:
        return round((b - a).total_seconds() / 60)
    return None


def threshold_status(gap):
    if gap is None:
        return "unknown"
    if gap <= T_GOOD_MAX:
        return "good"
    if gap <= T_WARNING_MAX:
        return "warning"
    if gap <= T_LATE_MAX:
        return "late"
    return "critical"


def transition_id(prev_session_id, next_session_id):
    return f"{prev_session_id}__{next_session_id}"


def _parse_date(s):
    if not s:
        return naive_utcnow().date()
    try:
        return date_cls.fromisoformat(s)
    except (TypeError, ValueError):
        return naive_utcnow().date()


# ── caches ─────────────────────────────────────────────────────────────────
class _Ctx:
    def __init__(self, db):
        self.db = db
        self._u, self._b, self._j, self._br = {}, {}, {}, {}

    def user(self, uid):
        if uid not in self._u:
            self._u[uid] = self.db.get(User, uid) if uid else None
        return self._u[uid]

    def bay(self, bid):
        if bid not in self._b:
            self._b[bid] = self.db.get(Bay, bid) if bid else None
        return self._b[bid]

    def job(self, jid):
        if jid not in self._j:
            self._j[jid] = self.db.get(JobCard, jid) if jid else None
        return self._j[jid]

    def branch(self, brid):
        if brid not in self._br:
            self._br[brid] = self.db.get(Branch, brid) if brid else None
        return self._br[brid]


# ── session fetch (branch/date/worker scoped) ──────────────────────────────
def _fetch_sessions(db, me, day, worker_id=None, branch_id=None):
    """Sessions whose activity (start_time, else created_at) falls on ``day``, scoped to the caller's
    branch (admin) or a chosen/global branch (master). Includes running/paused for the current block."""
    stmt = select(ServiceSession).join(User, ServiceSession.worker_id == User.id)
    if not is_master(me):
        stmt = stmt.where(User.branch_id == me.branch_id)
    elif branch_id:
        stmt = stmt.where(User.branch_id == branch_id)
    if worker_id:
        stmt = stmt.where(ServiceSession.worker_id == worker_id)
    rows = db.scalars(stmt).all()
    out = []
    for s in rows:
        ref = _naive(s.start_time) or _naive(s.created_at)
        if ref and ref.date() == day:
            out.append(s)
    return out


def _reasons_map(db, worker_id, day_str, branch_id=None):
    stmt = select(WorkerTransitionDelayReason).where(WorkerTransitionDelayReason.date == day_str)
    if worker_id:
        stmt = stmt.where(WorkerTransitionDelayReason.worker_id == worker_id)
    if branch_id:
        stmt = stmt.where(WorkerTransitionDelayReason.branch_id == branch_id)
    return {(r.prev_session_id, r.next_session_id): r for r in db.scalars(stmt).all()}


def _session_minutes(s):
    """(estimated_min, actual_work_min, clock_min-fallback) mirroring reports.work_completion."""
    est = round((s.estimated_duration or 0) / 60)
    if s.actual_duration is not None:
        actual = round(s.actual_duration / 60)
    elif s.start_time and s.end_time:
        actual = round((_naive(s.end_time) - _naive(s.start_time)).total_seconds() / 60)
    else:
        actual = est
    return est, actual


# ── per-worker day analysis ────────────────────────────────────────────────
def _worker_day(ctx, worker_id, sessions, reasons, day_str):
    """Build the full per-worker/day analytics from that worker's sessions."""
    db = ctx.db
    worker = ctx.user(worker_id)
    completed = [s for s in sessions if s.status == SessionStatus.completed and s.start_time and s.end_time]
    completed.sort(key=lambda s: _naive(s.start_time))
    running = [s for s in sessions if s.status in (SessionStatus.running, SessionStatus.paused)]
    pause_counts = pause_counts_for(db, [s.id for s in completed])

    productive = pause_total = est_total = actual_total = 0
    timeline = []
    per_session = {}
    for s in completed:
        est, actual = _session_minutes(s)
        pc = pause_counts.get(s.id, 0)
        paused_min, paused_known, clock_min = derive_pause(s.start_time, s.end_time, s.actual_duration, pc)
        pm = paused_min or 0
        productive += actual
        pause_total += pm
        est_total += est
        actual_total += actual
        job = ctx.job(s.job_card_id)
        bay = ctx.bay(s.bay_id)
        per_session[s.id] = {"actual": actual, "paused": pm, "bay": bay.bay_number if bay else None,
                             "job_no": job.job_card_number if job else None}
        timeline.append({
            "type": "job_work", "start_at": _iso(s.start_time), "end_at": _iso(s.end_time),
            "minutes": actual, "clock_minutes": clock_min, "paused_minutes": pm,
            "paused_known": paused_known, "bay_number": bay.bay_number if bay else None,
            "session_id": s.id, "job_card_id": s.job_card_id,
            "job_no": job.job_card_number if job else None,
            "service_type": job.service_type if job else None,
            "estimated_minutes": est, "variance_minutes": actual - est, "status": "completed",
        })

    # transitions between consecutive completed jobs
    transitions = []
    transition_idle = 0
    late_ct = critical_ct = 0
    for i in range(1, len(completed)):
        a, b = completed[i - 1], completed[i]
        gap = _mins_between(a.end_time, b.start_time)
        adelay = _mins_between(a.end_time, b.created_at)
        sdelay = _mins_between(b.created_at, b.start_time)
        status = threshold_status(gap)
        if gap is not None and gap > 0:
            transition_idle += gap
        if status == "late":
            late_ct += 1
        if status == "critical":
            critical_ct += 1
        tid = transition_id(a.id, b.id)
        rr = reasons.get((a.id, b.id))
        pa, pb = per_session[a.id], per_session[b.id]
        row = {
            "transition_id": tid, "worker_id": worker_id,
            "worker_name": worker.name if worker else None, "date": day_str,
            "prev_session_id": a.id, "prev_job_no": pa["job_no"], "prev_bay_number": pa["bay"],
            "next_session_id": b.id, "next_job_no": pb["job_no"], "next_bay_number": pb["bay"],
            "prev_completed_at": _iso(a.end_time), "next_assigned_at": _iso(b.created_at),
            "next_started_at": _iso(b.start_time),
            "assignment_delay_minutes": adelay, "start_delay_minutes": sdelay,
            "transition_gap_minutes": gap, "threshold_status": status,
            "assignment_known": b.created_at is not None,
            "reason_required": bool(gap is not None and gap > REASON_REQUIRED_ABOVE),
            "reason_given": bool(rr and rr.reason_category),
            "reason_category": rr.reason_category if rr else None,
            "reason_note": rr.reason_note if rr else None,
            "responsible_type": rr.responsible_type if rr else None,
            "marked_by_name": rr.marked_by_admin_name if rr else None,
            "marked_by_role": rr.marked_by_role if rr else None,
            "marked_at": _iso(rr.marked_at) if rr else None,
        }
        transitions.append(row)
        timeline.append({
            "type": "transition_gap", "start_at": _iso(a.end_time), "end_at": _iso(b.start_time),
            "minutes": gap, "from_bay": pa["bay"], "to_bay": pb["bay"], "color_status": status,
            "transition_id": tid, "reason_required": row["reason_required"],
            "reason_given": row["reason_given"], "reason_category": row["reason_category"],
            "reason_note": row["reason_note"],
        })

    # current (running/paused) session shown as a live block, no transition math
    for s in running:
        job = ctx.job(s.job_card_id)
        bay = ctx.bay(s.bay_id)
        timeline.append({
            "type": "job_work", "start_at": _iso(s.start_time), "end_at": None, "minutes": None,
            "bay_number": bay.bay_number if bay else None, "session_id": s.id,
            "job_no": job.job_card_number if job else None,
            "service_type": job.service_type if job else None,
            "status": "running" if s.status == SessionStatus.running else "paused",
        })

    span = None
    if completed:
        span = _mins_between(completed[0].start_time, completed[-1].end_time)
    overtime = max(0, (span or 0) - SHIFT_MINUTES) if span is not None else 0
    accounted = productive + pause_total + transition_idle
    unassigned_idle = max(0, SHIFT_MINUTES - accounted) if (span is not None and span <= SHIFT_MINUTES) else 0
    idle_total = transition_idle + unassigned_idle
    util = round(productive / SHIFT_MINUTES * 100) if SHIFT_MINUTES else 0
    gaps = [t["transition_gap_minutes"] for t in transitions if t["transition_gap_minutes"] is not None]
    avg_gap = round(sum(gaps) / len(gaps)) if gaps else 0

    if not completed and not running:
        rating = "no_data"
    elif critical_ct > 0 or util < 50:
        rating = "critical" if util < 50 else "needs_attention"
    elif util >= 85:
        rating = "excellent"
    elif util >= 70:
        rating = "good"
    else:
        rating = "needs_attention"

    if overtime > 0:
        timeline.append({"type": "overtime", "minutes": overtime})
    elif unassigned_idle > 0:
        timeline.append({"type": "unassigned_idle", "minutes": unassigned_idle})

    return {
        "worker_id": worker_id, "worker_name": worker.name if worker else None,
        "branch_id": worker.branch_id if worker else None, "date": day_str,
        "shift_minutes": SHIFT_MINUTES, "shift_basis": SHIFT_BASIS,
        "productive_minutes": productive, "pause_minutes": pause_total,
        "transition_idle_minutes": transition_idle, "unassigned_idle_minutes": unassigned_idle,
        "overtime_minutes": overtime, "idle_minutes": idle_total,
        "utilization_percent": util,
        "idle_percent": round(idle_total / SHIFT_MINUTES * 100),
        "pause_percent": round(pause_total / SHIFT_MINUTES * 100),
        "completed_jobs_count": len(completed), "running_jobs_count": len(running),
        "average_transition_gap": avg_gap,
        "late_transition_count": late_ct, "critical_transition_count": critical_ct,
        "estimated_total_minutes": est_total, "actual_total_minutes": actual_total,
        "estimate_variance_minutes": actual_total - est_total,
        "active_span_minutes": span, "rating": rating,
        "timeline": timeline, "transitions": transitions,
    }


def _all_worker_days(db, me, day, worker_id=None, branch_id=None):
    ctx = _Ctx(db)
    sessions = _fetch_sessions(db, me, day, worker_id, branch_id)
    day_str = day.isoformat()
    by_worker = {}
    for s in sessions:
        by_worker.setdefault(s.worker_id, []).append(s)
    reasons = _reasons_map(db, worker_id, day_str, branch_id if is_master(me) else me.branch_id)
    out = []
    for wid, ss in by_worker.items():
        wr = {k: reasons[k] for k in reasons if reasons[k].worker_id == wid}
        out.append(_worker_day(ctx, wid, ss, wr, day_str))
    out.sort(key=lambda w: (-(w["utilization_percent"] or 0), w["worker_name"] or ""))
    return out


# ── public surfaces ────────────────────────────────────────────────────────
def workers(db, me, date=None, worker_id=None, status=None, branch_id=None):
    day = _parse_date(date)
    days = _all_worker_days(db, me, day, worker_id, branch_id)
    if status:
        days = [w for w in days if w["rating"] == status]
    # trim heavy arrays for the list surface (timeline lives on the per-worker endpoint)
    return [{k: v for k, v in w.items() if k not in ("timeline",)} for w in days]


def timeline(db, me, worker_id, date=None):
    day = _parse_date(date)
    days = _all_worker_days(db, me, day, worker_id)
    return days[0] if days else {
        "worker_id": worker_id, "date": day.isoformat(), "shift_minutes": SHIFT_MINUTES,
        "shift_basis": SHIFT_BASIS, "completed_jobs_count": 0, "timeline": [], "transitions": [],
        "empty": True,
    }


def transitions(db, me, date=None, worker_id=None, status=None, reason_missing=None, branch_id=None):
    day = _parse_date(date)
    days = _all_worker_days(db, me, day, worker_id, branch_id)
    rows = [t for w in days for t in w["transitions"]]
    if status:
        rows = [t for t in rows if t["threshold_status"] == status]
    if reason_missing in (True, "true"):
        rows = [t for t in rows if t["reason_required"] and not t["reason_given"]]
    rows.sort(key=lambda t: -(t["transition_gap_minutes"] or 0))
    return rows


def summary(db, me, date=None, worker_id=None, branch_id=None):
    day = _parse_date(date)
    days = _all_worker_days(db, me, day, worker_id, branch_id)
    active = [w for w in days if w["completed_jobs_count"] or w["running_jobs_count"]]
    utils = [w["utilization_percent"] for w in active]
    all_tr = [t for w in days for t in w["transitions"]]
    gaps = [t["transition_gap_minutes"] for t in all_tr if t["transition_gap_minutes"] is not None]
    late = sum(1 for t in all_tr if t["threshold_status"] == "late")
    crit = sum(1 for t in all_tr if t["threshold_status"] == "critical")
    best = max(active, key=lambda w: w["utilization_percent"], default=None)
    worst = max(all_tr, key=lambda t: (t["transition_gap_minutes"] or 0), default=None)
    needs = [w for w in active if w["rating"] in ("needs_attention", "critical")]
    # top delay reason among saved reasons
    cats = {}
    for t in all_tr:
        if t.get("reason_category"):
            cats[t["reason_category"]] = cats.get(t["reason_category"], 0) + 1
    top_reason = max(cats, key=cats.get) if cats else None
    return {
        "date": day.isoformat(), "shift_minutes": SHIFT_MINUTES, "shift_basis": SHIFT_BASIS,
        "total_workers": len(active),
        "average_utilization": round(sum(utils) / len(utils)) if utils else 0,
        "average_transition_gap": round(sum(gaps) / len(gaps)) if gaps else 0,
        "total_transitions": len(all_tr),
        "total_late_transitions": late, "total_critical_transitions": crit,
        "reasons_missing": sum(1 for t in all_tr if t["reason_required"] and not t["reason_given"]),
        "productive_minutes": sum(w["productive_minutes"] for w in active),
        "idle_minutes": sum(w["idle_minutes"] for w in active),
        "pause_minutes": sum(w["pause_minutes"] for w in active),
        "best_worker": {"worker_id": best["worker_id"], "worker_name": best["worker_name"],
                        "utilization_percent": best["utilization_percent"]} if best else None,
        "needs_attention_count": len(needs),
        "worst_transition": {"worker_name": worst["worker_name"], "transition_gap_minutes": worst["transition_gap_minutes"],
                             "from_bay": worst["prev_bay_number"], "to_bay": worst["next_bay_number"],
                             "threshold_status": worst["threshold_status"]} if worst else None,
        "top_delay_reason": top_reason,
    }


def master_summary(db, me, date=None):
    """Branch-wise summary cards for master (global)."""
    day = _parse_date(date)
    day_str = day.isoformat()
    ctx = _Ctx(db)
    sessions = _fetch_sessions(db, me, day)   # master → all branches
    reasons = _reasons_map(db, None, day_str)
    by_branch = {}
    for s in sessions:
        w = ctx.user(s.worker_id)
        brid = w.branch_id if w else None
        by_branch.setdefault(brid, {}).setdefault(s.worker_id, []).append(s)
    branches = []
    totals = {"workers": 0, "late": 0, "critical": 0, "avg_util": []}
    for brid, workers_map in by_branch.items():
        wdays = []
        for wid, ss in workers_map.items():
            wr = {k: reasons[k] for k in reasons if reasons[k].worker_id == wid}
            wdays.append(_worker_day(ctx, wid, ss, wr, day_str))
        active = [w for w in wdays if w["completed_jobs_count"] or w["running_jobs_count"]]
        utils = [w["utilization_percent"] for w in active]
        all_tr = [t for w in wdays for t in w["transitions"]]
        late = sum(1 for t in all_tr if t["threshold_status"] == "late")
        crit = sum(1 for t in all_tr if t["threshold_status"] == "critical")
        best = max(active, key=lambda w: w["utilization_percent"], default=None)
        needs = [w for w in active if w["rating"] in ("needs_attention", "critical")]
        branch = ctx.branch(brid)
        branches.append({
            "branch_id": brid, "branch_name": branch.name if branch else (brid or "—"),
            "total_workers": len(active),
            "average_utilization": round(sum(utils) / len(utils)) if utils else 0,
            "total_late_transitions": late, "total_critical_transitions": crit,
            "best_worker": {"worker_name": best["worker_name"], "utilization_percent": best["utilization_percent"]} if best else None,
            "needs_attention_count": len(needs),
        })
        totals["workers"] += len(active)
        totals["late"] += late
        totals["critical"] += crit
        totals["avg_util"].extend(utils)
    branches.sort(key=lambda b: -b["total_late_transitions"])
    return {
        "date": day_str, "shift_minutes": SHIFT_MINUTES, "shift_basis": SHIFT_BASIS,
        "totals": {"total_workers": totals["workers"], "total_late_transitions": totals["late"],
                   "total_critical_transitions": totals["critical"],
                   "average_utilization": round(sum(totals["avg_util"]) / len(totals["avg_util"])) if totals["avg_util"] else 0,
                   "branches": len(branches)},
        "branches": branches,
    }


# ── reason upsert (shared by admin + master routes) ────────────────────────
def save_reason(db, me, tid, *, reason_category, reason_note, responsible_type, role):
    """Upsert an admin/master delay reason for a transition. Recomputes the transition snapshot from
    the two sessions so the stored gap/delays are authoritative; enforces branch access for admins."""
    try:
        prev_id, next_id = tid.split("__", 1)
    except ValueError:
        raise ValueError("Invalid transition id")
    a = db.get(ServiceSession, prev_id)
    b = db.get(ServiceSession, next_id)
    if not a or not b:
        raise LookupError("Transition sessions not found")
    worker = db.get(User, b.worker_id)
    branch_id = worker.branch_id if worker else None
    from ..utils.auth import assert_branch_access
    assert_branch_access(me, branch_id, "worker-transition-reason")   # master bypasses; admin own-branch

    gap = _mins_between(a.end_time, b.start_time)
    adelay = _mins_between(a.end_time, b.created_at)
    sdelay = _mins_between(b.created_at, b.start_time)
    day_str = (_naive(b.start_time) or _naive(b.created_at) or naive_utcnow()).date().isoformat()
    ja, jb = db.get(JobCard, a.job_card_id), db.get(JobCard, b.job_card_id)
    ba, bb = db.get(Bay, a.bay_id), db.get(Bay, b.bay_id)
    now = naive_utcnow()

    row = db.scalar(select(WorkerTransitionDelayReason).where(
        WorkerTransitionDelayReason.prev_session_id == prev_id,
        WorkerTransitionDelayReason.next_session_id == next_id))
    if not row:
        row = WorkerTransitionDelayReason(branch_id=branch_id, worker_id=b.worker_id,
                                          prev_session_id=prev_id, next_session_id=next_id)
        db.add(row)
    row.worker_name = worker.name if worker else None
    row.date = day_str
    row.prev_job_card_id, row.prev_job_no = a.job_card_id, (ja.job_card_number if ja else None)
    row.prev_bay_number = ba.bay_number if ba else None
    row.next_job_card_id, row.next_job_no = b.job_card_id, (jb.job_card_number if jb else None)
    row.next_bay_number = bb.bay_number if bb else None
    row.prev_completed_at, row.next_assigned_at, row.next_started_at = _naive(a.end_time), _naive(b.created_at), _naive(b.start_time)
    row.assignment_delay_minutes, row.start_delay_minutes, row.transition_gap_minutes = adelay, sdelay, gap
    row.threshold_status = threshold_status(gap)
    row.reason_category, row.reason_note, row.responsible_type = reason_category, reason_note, responsible_type
    row.marked_by_admin_id, row.marked_by_admin_name = me.id, me.name
    row.marked_by_role = "master" if role == "master" else "admin"
    row.marked_at = now
    db.commit()
    db.refresh(row)
    return {
        "transition_id": tid, "reason_category": row.reason_category, "reason_note": row.reason_note,
        "responsible_type": row.responsible_type, "threshold_status": row.threshold_status,
        "transition_gap_minutes": row.transition_gap_minutes,
        "marked_by_name": row.marked_by_admin_name, "marked_by_role": row.marked_by_role,
        "marked_at": _iso(row.marked_at), "reason_given": True,
    }
