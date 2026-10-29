"""JWT creation/verification + role-based FastAPI guards."""
import logging
from datetime import datetime, timedelta, timezone

from fastapi import Depends, HTTPException, Request, status
from fastapi.security import OAuth2PasswordBearer
from jose import jwt, JWTError
from sqlalchemy.orm import Session

from ..config import settings
from ..database import get_db
from ..models.user import User, UserRole

log = logging.getLogger("baywatch.auth")

oauth2_scheme = OAuth2PasswordBearer(tokenUrl="/api/v1/auth/login", auto_error=False)


def create_access_token(user: User) -> str:
    expire = datetime.now(timezone.utc) + timedelta(minutes=settings.jwt_expire_minutes)
    payload = {
        "sub": user.id,
        "role": user.role.value,
        "branch_id": user.branch_id,
        "name": user.name,
        "exp": expire,
    }
    return jwt.encode(payload, settings.jwt_secret, algorithm=settings.jwt_algorithm)


def verify_token(token: str) -> dict:
    try:
        return jwt.decode(token, settings.jwt_secret, algorithms=[settings.jwt_algorithm])
    except JWTError:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Invalid or expired token")


def get_current_user(
    request: Request,
    token: str = Depends(oauth2_scheme),
    db: Session = Depends(get_db),
) -> User:
    path = request.url.path
    if not token:
        log.info("AUTH 401 · no token · path=%s", path)
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Not authenticated")
    try:
        payload = jwt.decode(token, settings.jwt_secret, algorithms=[settings.jwt_algorithm])
    except JWTError as e:
        log.info("AUTH 401 · bad/expired token · path=%s · %s", path, e.__class__.__name__)
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Invalid or expired token")
    user = db.get(User, payload.get("sub"))
    if not user:
        log.info("AUTH 401 · user-not-found · path=%s · sub=%s", path, payload.get("sub"))
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "User not found")
    # stash the token's claimed role so the role guard can log token-vs-db drift
    request.state.token_role = payload.get("role")
    return user


def require_roles(*roles: UserRole):
    """Dependency factory: allow only the given roles. On denial it logs the
    full picture — path, the token's claimed role, the DB user's actual role,
    the user id and what was expected — so every 403 is traceable."""
    allowed = {r.value for r in roles}

    def guard(request: Request, user: User = Depends(get_current_user)) -> User:
        if user.role.value not in allowed:
            log.warning(
                "AUTHZ 403 · path=%s · user=%s · db_role=%s · token_role=%s · expected=%s",
                request.url.path, user.id, user.role.value,
                getattr(request.state, "token_role", None), sorted(allowed),
            )
            raise HTTPException(status.HTTP_403_FORBIDDEN, "Insufficient permissions")
        return user

    return guard


# Convenience guards
require_master = require_roles(UserRole.master_admin)
require_admin = require_roles(UserRole.master_admin, UserRole.admin)
require_worker = require_roles(UserRole.worker)


# ── Branch-level authorization (multi-branch RBAC) ──────────────────────────
def is_master(user: User) -> bool:
    return user.role == UserRole.master_admin


def assert_branch_access(user: User, branch_id, action: str = "resource") -> None:
    """Branch isolation: a Master Admin may act on any branch; every other role
    is confined to its own ``branch_id``. Raises 403 on a cross-branch attempt.
    Call this in any write/read that targets a specific branch-owned resource."""
    if is_master(user):
        return
    if branch_id is not None and branch_id == user.branch_id:
        return
    log.warning(
        "AUTHZ 403 (branch) · user=%s · user_branch=%s · target_branch=%s · action=%s",
        user.id, user.branch_id, branch_id, action,
    )
    raise HTTPException(status.HTTP_403_FORBIDDEN, "Cross-branch access denied")


def effective_branch(user: User, requested):
    """Branch a create/write should target: a Master Admin may choose any branch
    (``requested``, falling back to their own); Admin/Worker are pinned to their
    own branch regardless of what the request body asked for."""
    if is_master(user):
        return requested or user.branch_id
    return user.branch_id
