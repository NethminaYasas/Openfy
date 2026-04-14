from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker, DeclarativeBase

from .settings import settings


class Base(DeclarativeBase):
    pass


def _create_engine():
    connect_args = {"check_same_thread": False} if settings.database_url.startswith("sqlite") else {}
    return create_engine(settings.database_url, connect_args=connect_args)


engine = _create_engine()
# Ensure all tables are created for this engine
Base.metadata.create_all(bind=engine)
from sqlalchemy.orm import Session as SASession

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
