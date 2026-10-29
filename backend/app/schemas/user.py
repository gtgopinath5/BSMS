from datetime import datetime, date
from pydantic import BaseModel, ConfigDict
from ..models.user import UserRole


class WorkerCreate(BaseModel):
    name: str
    employee_id: str | None = None        # auto-generated (EMP-NNNN) when omitted
    company_id: str | None = None
    pf_number: str | None = None
    aadhaar: str | None = None
    mobile: str | None = None
    email: str | None = None
    address: str | None = None
    emergency_contact: str | None = None
    dob: date | None = None
    joining_date: date | None = None
    department: str | None = None
    designation: str | None = None
    branch_id: str
    username: str
    password: str
    status: str | None = None
    role: UserRole = UserRole.worker


class WorkerUpdate(BaseModel):
    name: str | None = None
    mobile: str | None = None
    email: str | None = None
    address: str | None = None
    emergency_contact: str | None = None
    aadhaar: str | None = None
    dob: date | None = None
    joining_date: date | None = None
    department: str | None = None
    designation: str | None = None
    status: str | None = None


class PasswordReset(BaseModel):
    new_password: str


class StatusChange(BaseModel):
    status: str                           # active · inactive · suspended · locked


class UserOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: str
    name: str
    role: UserRole
    branch_id: str | None = None
    employee_id: str | None = None
    email: str | None = None
    mobile: str | None = None
    address: str | None = None
    emergency_contact: str | None = None
    aadhaar: str | None = None
    dob: date | None = None
    department: str | None = None
    designation: str | None = None
    profile_photo_url: str | None = None
    status: str
    last_login: datetime | None = None
    joining_date: date | None = None
    join_date: date | None = None        # explicit joining_date, else created_at date
