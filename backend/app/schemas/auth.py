from pydantic import BaseModel


class LoginRequest(BaseModel):
    username: str          # accepts username OR employee_id OR email
    password: str


class TokenResponse(BaseModel):
    access_token: str
    token_type: str = "bearer"
    role: str
    branch_id: str | None = None
    user_id: str
    name: str
