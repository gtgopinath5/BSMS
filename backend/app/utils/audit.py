"""Append-only audit logging."""
from sqlalchemy.orm import Session
from ..models.audit import AuditLog


def log_action(db: Session, action: str, entity_type: str | None = None,
               entity_id: str | None = None, by: str | None = None,
               old: dict | None = None, new: dict | None = None) -> None:
    db.add(AuditLog(
        action=action, entity_type=entity_type, entity_id=entity_id,
        changed_by=by, old_value=old, new_value=new,
    ))
