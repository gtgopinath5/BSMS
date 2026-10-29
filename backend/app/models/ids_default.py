"""Default-value callables for model columns."""
import uuid


def uuid_pk() -> str:
    return str(uuid.uuid4())
