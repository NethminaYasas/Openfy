from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker, DeclarativeBase, Session as SASession

from .settings import settings


class Base(DeclarativeBase):
    pass


def _create_engine():
    connect_args = {"check_same_thread": False} if settings.database_url.startswith("sqlite") else {}
    return create_engine(settings.database_url, connect_args=connect_args)


engine = _create_engine()

# NOTE:
# We intentionally avoid schema migration work in this module because `db.py` is
# imported before models are guaranteed to be registered on `Base.metadata`.
# Migrations and `create_all` are handled during app startup in `main.py`.
# Running ALTERs here can crash fresh installs with "no such table" errors.

class SafeSession(SASession):
    def execute(self, statement, *args, **kwargs):
        from sqlalchemy import text
        if isinstance(statement, str):
            statement = text(statement)
        return super().execute(statement, *args, **kwargs)

SessionLocal = sessionmaker(class_=SafeSession, bind=engine, autoflush=False, autocommit=False)


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
