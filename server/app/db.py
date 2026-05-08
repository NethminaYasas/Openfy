from sqlalchemy import create_engine, text
from sqlalchemy.orm import sessionmaker, DeclarativeBase, Session as SASession

from .settings import settings


class Base(DeclarativeBase):
    pass


def _create_engine():
    connect_args = {"check_same_thread": False} if settings.database_url.startswith("sqlite") else {}
    return create_engine(settings.database_url, connect_args=connect_args)


engine = _create_engine()
# Ensure all tables are created for this engine
Base.metadata.create_all(bind=engine)

# Migrate: add shuffle column to followed_albums if not exists (SQLite only)
if settings.database_url.startswith("sqlite"):
    with engine.connect() as conn:
        result = conn.execute(text("PRAGMA table_info(followed_albums)"))
        columns = [row[1] for row in result]
        if "shuffle" not in columns:
            conn.execute(text("ALTER TABLE followed_albums ADD COLUMN shuffle INTEGER DEFAULT 0"))
            conn.commit()

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
