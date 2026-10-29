"""Barricade decision authority — the backend is the ONLY thing that decides whether a barrier
opens. The external detection service merely SUGGESTS (posts an event via ``ingest``); this module
applies the branch's rules and, only when authorized, asks the relay controller to open.

Decision rules (Phase B simulation):

  ENTRANCE
    person                 → auto-open IF camera.auto_open_person else pending_admin
    bike/car, conf<thr     → pending_admin
    bike/car, no plate /   → pending_admin
       OCR conf<thr
    bike/car, plate known  → auto-open IF camera.auto_open_known_vehicle else pending_admin
    bike/car, plate unknown→ pending_admin
  EXIT
    bike/car with an APPROVED bill match           → auto-open
    bike/car with an ACTIVE temporary approval     → auto-open
    otherwise                                       → pending_admin
  unknown object / disabled camera / low confidence → pending_admin (FAIL-SAFE)

Admin allow → open; admin deny → never open; manual open → override + open. A cooldown prevents a
burst of detections from re-firing the relay. The relay controller is the only thing that "opens",
and it is reached ONLY from here, ONLY after a decision authorizes it.
"""
import json
import logging
from datetime import datetime, timedelta

from sqlalchemy import select
from sqlalchemy.orm import Session

from ..models.barricade import (BarricadeCameraConfig, BarricadeEvent, BarricadeMedia,
                                BarricadeBillApproval, BarricadeTemporaryApproval, OBJECT_TYPES)
from ..models.base import naive_utcnow
from ..models.job import JobCard
from ..models.vehicle_intake import VehicleIntakeEntry
from ..utils import barricade as B
from . import barricade_controller_service as controller

log = logging.getLogger("baywatch.barricade")


def _now() -> datetime:
    return naive_utcnow()


# ── known-vehicle / approval matching ───────────────────────────────
def _match_known_vehicle(db: Session, branch_id: str | None, norm: str | None) -> dict | None:
    """Match a normalized plate against intake evidence + job cards (queue rides on the job card).
    Returns {source, job_card_id, intake_id} or None."""
    if not norm:
        return None
    istmt = select(VehicleIntakeEntry).where(
        VehicleIntakeEntry.bike_number_normalized == norm,
        VehicleIntakeEntry.deleted_at.is_(None))
    if branch_id:
        istmt = istmt.where(VehicleIntakeEntry.branch_id == branch_id)
    intake = db.scalars(istmt.order_by(VehicleIntakeEntry.created_at.desc())).first()

    jstmt = select(JobCard).where(JobCard.vehicle_number.is_not(None))
    if branch_id:
        jstmt = jstmt.where(JobCard.branch_id == branch_id)
    job = None
    for j in db.scalars(jstmt).all():                 # no normalized col on JobCard → compare here
        if B.normalize_plate(j.vehicle_number) == norm:
            job = j
            break
    if not (job or intake):
        return None
    return {
        "source": "job card" if job else "intake evidence",
        "job_card_id": job.id if job else (intake.linked_job_card_id if intake else None),
        "intake_id": intake.id if intake else None,
    }


def _approved_bill(db: Session, branch_id: str | None, norm: str | None) -> BarricadeBillApproval | None:
    """An APPROVED + PAID, not-yet-used bill for this plate authorises exit. Unpaid/unknown payment,
    used/rejected/expired status, or a plate mismatch → no match (the caller falls to pending_admin)."""
    if not norm:
        return None
    stmt = select(BarricadeBillApproval).where(
        BarricadeBillApproval.vehicle_number_normalized == norm,
        BarricadeBillApproval.status == "approved",
        BarricadeBillApproval.payment_status == "paid")
    if branch_id:
        stmt = stmt.where(BarricadeBillApproval.branch_id == branch_id)
    return db.scalars(stmt.order_by(BarricadeBillApproval.created_at.desc())).first()


def _bill_for_plate(db: Session, branch_id: str | None, norm: str | None) -> BarricadeBillApproval | None:
    """The latest bill for this plate REGARDLESS of status/payment — used only to craft a precise
    pending reason (e.g. 'payment not confirmed'), never to authorise."""
    if not norm:
        return None
    stmt = select(BarricadeBillApproval).where(BarricadeBillApproval.vehicle_number_normalized == norm)
    if branch_id:
        stmt = stmt.where(BarricadeBillApproval.branch_id == branch_id)
    return db.scalars(stmt.order_by(BarricadeBillApproval.created_at.desc())).first()


def _active_temp_approval(db: Session, branch_id: str | None, norm: str | None,
                          now: datetime | None = None) -> BarricadeTemporaryApproval | None:
    if not norm:
        return None
    now = now or _now()
    stmt = select(BarricadeTemporaryApproval).where(
        BarricadeTemporaryApproval.vehicle_number_normalized == norm,
        BarricadeTemporaryApproval.status == "active")
    if branch_id:
        stmt = stmt.where(BarricadeTemporaryApproval.branch_id == branch_id)
    for t in db.scalars(stmt.order_by(BarricadeTemporaryApproval.created_at.desc())).all():
        vf, vu = t.valid_from, t.valid_until
        if vf and vf.tzinfo is not None:
            vf = vf.replace(tzinfo=None)
        if vu and vu.tzinfo is not None:
            vu = vu.replace(tzinfo=None)
        if (vf is None or vf <= now) and (vu is None or vu >= now):
            return t
    return None


# ── the decision ────────────────────────────────────────────────────
def _evaluate(db: Session, event: BarricadeEvent,
              camera_cfg: BarricadeCameraConfig | None) -> tuple[str, str, bool]:
    """Return (new_status, reason, authorize_open). authorize_open is True ONLY for an automatic
    allow; everything uncertain returns pending_admin (fail-safe)."""
    direction = event.direction
    obj = event.object_type
    conf = event.detection_confidence or 0.0
    det_t = camera_cfg.detection_threshold if camera_cfg else B.default_detection_threshold()
    ocr_t = camera_cfg.ocr_threshold if camera_cfg else B.default_ocr_threshold()
    norm = event.vehicle_number_normalized

    if camera_cfg is not None and (not camera_cfg.enabled or not camera_cfg.detection_enabled):
        return "pending_admin", "Camera/detection disabled for this gate — admin review required", False

    if obj not in ("person", "bike", "car") or obj == "unknown":
        return "pending_admin", "Unknown object type — admin review required", False

    if obj == "person":
        if camera_cfg and camera_cfg.auto_open_person:
            event.authorization_source = "auto_person"
            return "auto_allowed", f"Person auto-open enabled ({direction})", True
        return "pending_admin", "Person detected — admin review required", False

    # bike / car
    if conf < det_t:
        return "pending_admin", f"Detection confidence {conf:.2f} below threshold {det_t:.2f}", False
    if not norm:
        return "pending_admin", "Vehicle number missing — admin review required", False
    if event.ocr_confidence is not None and event.ocr_confidence < ocr_t:
        return ("pending_admin",
                f"Plate OCR confidence {event.ocr_confidence:.2f} below threshold {ocr_t:.2f}", False)

    if direction == "entrance":
        match = _match_known_vehicle(db, event.branch_id, norm)
        if match:
            event.linked_job_card_id = match.get("job_card_id") or event.linked_job_card_id
            event.linked_intake_id = match.get("intake_id") or event.linked_intake_id
            if camera_cfg is None or camera_cfg.auto_open_known_vehicle:
                event.authorization_source = "known_vehicle"
                return "auto_allowed", f"Known vehicle matched via {match['source']}", True
            return ("pending_admin",
                    f"Known vehicle matched via {match['source']} — admin confirm (auto-open off)", False)
        return "pending_admin", "Unknown vehicle — admin review required", False

    # exit — an approved+paid bill or an active temp approval authorises; both are marked used.
    bill = _approved_bill(db, event.branch_id, norm)
    if bill:
        event.linked_bill_id = bill.id
        event.linked_job_card_id = bill.job_card_id or event.linked_job_card_id
        event.authorization_source = "bill"
        # NB: the bill is marked 'used' by _mark_links_used ONLY after the barrier actually opens.
        return "auto_allowed", f"Approved paid bill {bill.bill_no or bill.id} authorises exit", True
    temp = _active_temp_approval(db, event.branch_id, norm)
    if temp:
        event.linked_test_drive_id = temp.linked_test_drive_id or event.linked_test_drive_id
        event.linked_job_card_id = temp.linked_job_card_id or event.linked_job_card_id
        event.authorization_source = "temporary"
        # NB: the temp approval is marked used (single-use) by _mark_links_used after the open.
        return "auto_allowed", f"Active {temp.approval_type} approval authorises exit", True
    # a bill exists for this plate but is not approved+paid → precise reason (payment not confirmed)
    known = _bill_for_plate(db, event.branch_id, norm)
    if known is not None and (known.status != "approved" or known.payment_status != "paid"):
        return ("pending_admin",
                f"Bill {known.bill_no or ''} found but not authorised (status={known.status}, "
                f"payment={known.payment_status}) — admin review required", False)
    return "pending_admin", "Exit requires an approved bill, a temporary approval, or admin allow", False


# ── relay open (after authorization only) ───────────────────────────
def _apply_open(db: Session, event: BarricadeEvent, *, reason: str,
                camera_cfg: BarricadeCameraConfig | None = None,
                bypass_cooldown: bool = False) -> dict:
    """Open the barrier for an already-authorized event, honouring cooldown. Updates the event's
    status / barrier_opened_at / relay_result_json truthfully."""
    ctrl = controller.get_controller(db, event.branch_id)
    cd = (ctrl.cooldown_seconds if ctrl and ctrl.cooldown_seconds
          else (camera_cfg.cooldown_seconds if camera_cfg else 0))
    if not bypass_cooldown and B.cooldown_active(db, event.branch_id, event.direction, cd):
        result = {"opened": False, "status": "cooldown",
                  "detail": f"Cooldown active ({cd}s) — open suppressed to avoid a repeat.",
                  "direction": event.direction, "at": _now().isoformat()}
        event.relay_result_json = json.dumps(result)
        # keep the authorized status; the barrier simply was not re-fired
        B.log_decision(db, event.id, "system", None, None, "cooldown_skip",
                       result["detail"], {"cooldown_seconds": cd})
        return result

    result = controller.open_barricade(db, event.branch_id, event.direction,
                                       controller=ctrl, reason=reason)
    event.relay_result_json = json.dumps(result, default=str)
    if result.get("opened"):
        event.status = "opened"
        event.barrier_opened_at = _now()
        _mark_links_used(db, event)
    else:
        event.status = "failed"
    B.log_decision(db, event.id, "system", None, None, "relay",
                   result.get("detail"), {"opened": result.get("opened"),
                                          "relay_status": result.get("status")})
    return result


def _mark_links_used(db: Session, event: BarricadeEvent) -> None:
    """A bill/temp approval that just released an exit is recorded as used (single-use ones are
    closed; multi-use temp passes stay active within their window)."""
    if event.linked_bill_id:
        b = db.get(BarricadeBillApproval, event.linked_bill_id)
        if b and b.status == "approved":
            b.status = "used"
            b.used_event_id = event.id
            b.used_at = _now()
    if event.direction == "exit":
        t = db.scalar(select(BarricadeTemporaryApproval).where(
            BarricadeTemporaryApproval.used_event_id.is_(None),
            BarricadeTemporaryApproval.status == "active",
            BarricadeTemporaryApproval.vehicle_number_normalized == event.vehicle_number_normalized))
        if t:
            t.used_event_id = event.id
            t.used_at = _now()
            if t.approval_type == "manual_once":
                t.status = "used"


# ── ingest (the suggest → decide → maybe-open pipeline) ─────────────
def _resolve_camera(db: Session, branch_id: str | None, direction: str,
                    camera_config_id: str | None) -> BarricadeCameraConfig | None:
    if camera_config_id:
        return db.get(BarricadeCameraConfig, camera_config_id)
    stmt = select(BarricadeCameraConfig).where(BarricadeCameraConfig.direction == direction)
    if branch_id:
        stmt = stmt.where(BarricadeCameraConfig.branch_id == branch_id)
    return db.scalars(stmt.order_by(BarricadeCameraConfig.created_at.desc())).first()


def ingest(db: Session, *, branch_id: str | None, direction: str, object_type: str,
           detection_confidence: float | None, vehicle_number_raw: str | None = None,
           ocr_confidence: float | None = None, camera_config_id: str | None = None,
           actor_type: str = "system", actor_id: str | None = None, actor_name: str | None = None,
           frame: bytes | None = None, source: str | None = None) -> BarricadeEvent:
    """Record a SUGGESTED detection, run the backend decision, and open ONLY if authorized."""
    now = _now()
    if direction not in ("entrance", "exit"):
        direction = "entrance"
    obj = object_type if object_type in OBJECT_TYPES else "unknown"
    camera_cfg = _resolve_camera(db, branch_id, direction, camera_config_id)
    norm = B.normalize_plate(vehicle_number_raw)

    event = BarricadeEvent(
        event_no=B.next_event_no(db), branch_id=branch_id, direction=direction,
        camera_config_id=(camera_cfg.id if camera_cfg else camera_config_id),
        object_type=obj, detection_confidence=detection_confidence,
        vehicle_number_raw=vehicle_number_raw, vehicle_number_normalized=norm or None,
        ocr_confidence=ocr_confidence, event_time=now, status="detected",
        entry_time=now if direction == "entrance" else None,
        exit_time=now if direction == "exit" else None,
    )
    db.add(event)
    db.flush()
    if camera_cfg:
        camera_cfg.last_seen_at = now
    B.log_decision(db, event.id, actor_type, actor_id, actor_name, "ingested",
                   f"{direction} detection suggested: {obj} conf={detection_confidence}",
                   {"plate": norm or None, "ocr_confidence": ocr_confidence,
                    "source": source or "manual"})

    if frame:
        try:
            meta = B.save_frame(event, frame)
            db.add(BarricadeMedia(
                event_id=event.id, branch_id=branch_id, media_type="frame",
                file_path=meta["file_key"], mime_type="image/jpeg",
                size_bytes=meta["size_bytes"], status="active",
                expires_at=now + timedelta(days=B.retention_days())))
        except Exception:
            log.warning("barricade: frame save failed for %s", event.event_no, exc_info=True)

    new_status, reason, authorize = _evaluate(db, event, camera_cfg)
    event.decision_reason = reason
    event.status = new_status
    B.log_decision(db, event.id, "system", None, None, "decision", reason, {"authorize": authorize})
    if authorize:
        _apply_open(db, event, reason=reason, camera_cfg=camera_cfg)

    db.commit()
    db.refresh(event)
    return event


# ── human actions ───────────────────────────────────────────────────
def admin_allow(db: Session, event: BarricadeEvent, actor_type: str, actor_id: str | None,
                actor_name: str | None) -> BarricadeEvent:
    if event.status == "opened":
        return event
    event.status = "admin_allowed"
    event.approved_by_admin_id = actor_id
    event.approved_by_admin_name = actor_name
    event.approved_at = _now()
    event.authorization_source = "master_override" if actor_type == "master" else "admin_manual"
    event.decision_reason = f"Allowed by {actor_name or actor_type}"
    B.log_decision(db, event.id, actor_type, actor_id, actor_name, "allow", event.decision_reason)
    _apply_open(db, event, reason="admin allow", bypass_cooldown=True)
    db.commit()
    db.refresh(event)
    return event


def admin_deny(db: Session, event: BarricadeEvent, actor_type: str, actor_id: str | None,
               actor_name: str | None) -> BarricadeEvent:
    event.status = "denied"
    event.decision_reason = f"Denied by {actor_name or actor_type}"
    B.log_decision(db, event.id, actor_type, actor_id, actor_name, "deny", event.decision_reason)
    db.commit()
    db.refresh(event)
    return event


def manual_open(db: Session, event: BarricadeEvent, actor_type: str, actor_id: str | None,
                actor_name: str | None) -> BarricadeEvent:
    event.approved_by_admin_id = actor_id
    event.approved_by_admin_name = actor_name
    event.approved_at = _now()
    event.authorization_source = "master_override" if actor_type == "master" else "admin_manual"
    event.decision_reason = f"Manual override open by {actor_name or actor_type}"
    B.log_decision(db, event.id, actor_type, actor_id, actor_name, "manual_open",
                   event.decision_reason)
    _apply_open(db, event, reason="manual override", bypass_cooldown=True)
    db.commit()
    db.refresh(event)
    return event


def master_override(db: Session, event: BarricadeEvent, action: str, actor_id: str | None,
                    actor_name: str | None) -> BarricadeEvent:
    action = (action or "").lower()
    if action == "deny":
        return admin_deny(db, event, "master", actor_id, actor_name)
    if action == "open":
        return manual_open(db, event, "master", actor_id, actor_name)
    return admin_allow(db, event, "master", actor_id, actor_name)


def link_job(db: Session, event: BarricadeEvent, job_card_id: str, actor_type: str,
             actor_id: str | None, actor_name: str | None) -> BarricadeEvent:
    event.linked_job_card_id = job_card_id
    B.log_decision(db, event.id, actor_type, actor_id, actor_name, "link_job",
                   "Linked event to job card", {"job_card_id": job_card_id})
    db.commit()
    db.refresh(event)
    return event


# ── approval lifecycle (Phase G) ────────────────────────────────────
def expire_stale_temps(db: Session, branch_id: str | None = None, now: datetime | None = None) -> int:
    """Lazily flip ACTIVE temp approvals past ``valid_until`` to ``expired`` (status label hygiene;
    the matcher already ignores out-of-window ones). Returns the count flipped. Never deletes."""
    now = now or _now()
    stmt = select(BarricadeTemporaryApproval).where(BarricadeTemporaryApproval.status == "active")
    if branch_id:
        stmt = stmt.where(BarricadeTemporaryApproval.branch_id == branch_id)
    n = 0
    for t in db.scalars(stmt).all():
        vu = t.valid_until.replace(tzinfo=None) if (t.valid_until and t.valid_until.tzinfo) else t.valid_until
        if vu is not None and vu < now:
            t.status, t.updated_at = "expired", now
            n += 1
    if n:
        db.commit()
    return n


def approve_bill(db: Session, bill: BarricadeBillApproval, actor_type: str, actor_id: str | None,
                 actor_name: str | None) -> BarricadeBillApproval:
    bill.status, bill.updated_at = "approved", _now()
    B.log_decision(db, None, actor_type, actor_id, actor_name, "bill_approval",
                   f"Bill {bill.bill_no or bill.id} approved", {"status": "approved", "bill_id": bill.id})
    db.commit(); db.refresh(bill)
    return bill


def reject_bill(db: Session, bill: BarricadeBillApproval, actor_type: str, actor_id: str | None,
                actor_name: str | None) -> BarricadeBillApproval:
    bill.status, bill.updated_at = "rejected", _now()
    B.log_decision(db, None, actor_type, actor_id, actor_name, "bill_approval",
                   f"Bill {bill.bill_no or bill.id} rejected", {"status": "rejected", "bill_id": bill.id})
    db.commit(); db.refresh(bill)
    return bill


def revoke_temp(db: Session, temp: BarricadeTemporaryApproval, actor_type: str, actor_id: str | None,
                actor_name: str | None) -> BarricadeTemporaryApproval:
    temp.status, temp.updated_at = "revoked", _now()
    B.log_decision(db, None, actor_type, actor_id, actor_name, "temp_approval",
                   f"Temporary {temp.approval_type} approval revoked",
                   {"status": "revoked", "temp_id": temp.id})
    db.commit(); db.refresh(temp)
    return temp


def test_open(db: Session, branch_id: str | None, direction: str, actor_type: str,
              actor_id: str | None, actor_name: str | None) -> dict:
    """Admin 'test open' — exercise the relay controller directly (no detection event). Logged as a
    manual override; bypasses cooldown. Never reachable by the detection ingest path."""
    if direction not in ("entrance", "exit"):
        direction = "entrance"
    result = controller.open_barricade(db, branch_id, direction, reason="admin test-open")
    B.log_decision(db, None, actor_type, actor_id, actor_name, "test_open",
                   result.get("detail"), {"direction": direction, "relay_status": result.get("status"),
                                          "opened": result.get("opened")})
    db.commit()
    return result
