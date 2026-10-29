from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select, or_
from sqlalchemy.orm import Session

from ..database import get_db
from ..models.user import User
from ..schemas.auth import LoginRequest, TokenResponse
from ..schemas.common import ok
from ..utils.security import verify_password
from ..utils.auth import create_access_token, get_current_user
from ..utils.audit import log_action

router = APIRouter()

# accounts that an admin has locked/suspended/deactivated cannot log in
_BLOCKED_STATUS = {"locked": "This account is locked. Contact your administrator.",
                   "suspended": "This account is suspended. Contact your administrator.",
                   "inactive": "This account is deactivated. Contact your administrator."}


@router.post("/login", response_model=TokenResponse)
def login(body: LoginRequest, db: Session = Depends(get_db)):
    user = db.scalar(
        select(User).where(
            or_(User.username == body.username,
                User.employee_id == body.username,
                User.email == body.username)
        )
    )
    if not user or not user.hashed_password or not verify_password(body.password, user.hashed_password):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Invalid credentials")
    if user.status in _BLOCKED_STATUS:                  # Lock / Suspend / Deactivate blocks login
        raise HTTPException(status.HTTP_403_FORBIDDEN, _BLOCKED_STATUS[user.status])
    from datetime import datetime, timezone
    user.last_login = datetime.now(timezone.utc)        # stamp Last Login (HR record)
    log_action(db, "LOGIN", "user", user.id, by=user.id)   # login activity record
    db.commit()
    return TokenResponse(
        access_token=create_access_token(user),
        role=user.role.value, branch_id=user.branch_id,
        user_id=user.id, name=user.name,
    )


@router.post("/logout")
def logout(user: User = Depends(get_current_user)):
    return ok(message="Logged out")


@router.get("/me")
def me(user: User = Depends(get_current_user)):
    return ok({
        "id": user.id, "name": user.name, "role": user.role.value,
        "branch_id": user.branch_id, "employee_id": user.employee_id,
    })
