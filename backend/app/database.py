"""SQLAlchemy engine + session factory.

Sync engine so the project runs against either SQLite (default, zero-config)
or Postgres (`postgresql+psycopg://...`) with no code change. To go async,
swap to `create_async_engine` + asyncpg and make the routers `async def`.
"""
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker, DeclarativeBase
from .config import settings

connect_args = {}
if settings.database_url.startswith("sqlite"):
    # allow use across FastAPI's threadpool
    connect_args = {"check_same_thread": False}

# settings.sqlalchemy_url (not database_url) so a managed provider's
# `postgres://` / `postgresql://` URL is rewritten to the psycopg v3 driver.
engine = create_engine(settings.sqlalchemy_url, echo=False, future=True, connect_args=connect_args)
SessionLocal = sessionmaker(bind=engine, autoflush=False, autocommit=False, future=True)


class Base(DeclarativeBase):
    """Declarative base for all ORM models."""


def get_db():
    """FastAPI dependency yielding a DB session."""
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


def init_db() -> None:
    """Create all tables (used for SQLite/dev; use Alembic for Postgres)."""
    from . import models  # noqa: F401  (ensure models are imported/registered)
    Base.metadata.create_all(bind=engine)
