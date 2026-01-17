"""Database connection and session management for Equipment module v2."""

import os
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker, DeclarativeBase

# Database URL from environment variable or default to local Docker PostgreSQL
DATABASE_URL = os.environ.get(
    "DATABASE_URL",
    "postgresql://inspirehub:inspirehub_dev@localhost:5432/inspirehub"
)

engine = create_engine(DATABASE_URL, echo=False)
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)


class Base(DeclarativeBase):
    """Base class for all SQLAlchemy models."""
    pass


def get_db():
    """Dependency for FastAPI to get database session."""
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
