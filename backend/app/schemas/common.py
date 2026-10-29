from typing import Any, Generic, TypeVar
from pydantic import BaseModel

T = TypeVar("T")


class Envelope(BaseModel):
    """Consistent API response: { success, data, message }."""
    success: bool = True
    data: Any | None = None
    message: str = ""


def ok(data: Any = None, message: str = "") -> dict:
    return {"success": True, "data": data, "message": message}


def fail(message: str, data: Any = None) -> dict:
    return {"success": False, "data": data, "message": message}
