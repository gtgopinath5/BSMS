"""Password hashing helpers.

Uses pbkdf2_sha256 (pure-Python, no native bcrypt dependency, no 72-byte
limit). Swap to bcrypt/argon2 in production if you prefer — just add the
scheme here; existing hashes keep verifying.
"""
from passlib.context import CryptContext

_pwd = CryptContext(schemes=["pbkdf2_sha256"], deprecated="auto")


def hash_password(plain: str) -> str:
    return _pwd.hash(plain)


def verify_password(plain: str, hashed: str) -> bool:
    try:
        return _pwd.verify(plain, hashed)
    except Exception:
        return False
