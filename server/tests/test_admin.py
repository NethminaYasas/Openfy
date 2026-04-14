import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from server.app.main import app, get_db, Base, User, Track, Artist, Album
from server.app.settings import settings

# Use a separate in‑memory SQLite DB for tests
SQLALCHEMY_DATABASE_URL = "sqlite:///:memory:"
engine = create_engine(SQLALCHEMY_DATABASE_URL, connect_args={"check_same_thread": False})
TestingSessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)

# Override the FastAPI dependency
def override_get_db():
    db = TestingSessionLocal()
    try:
        yield db
    finally:
        db.close()

app.dependency_overrides[get_db] = override_get_db

# Create tables
Base.metadata.create_all(bind=engine)

@pytest.fixture
def client():
    return TestClient(app)

def create_user(db, name, auth_hash, is_admin=False):
    user = User(name=name, auth_hash=auth_hash, is_admin=is_admin)
    db.add(user)
    db.commit()
    db.refresh(user)
    return user

def create_track(db, title, user_hash):
    track = Track(title=title, user_hash=user_hash)
    db.add(track)
    db.commit()
    db.refresh(track)
    return track

def test_admin_users_endpoint_hides_auth_hash(client):
    # Setup admin user
    db = TestingSessionLocal()
    admin = create_user(db, "admin", "admintoken", is_admin=True)
    # Normal user for completeness
    create_user(db, "bob", "bobtoken")
    db.close()

    response = client.get("/admin/users", headers={"x-auth-hash": "admintoken"})
    assert response.status_code == 200
    data = response.json()
    # Ensure no auth_hash fields are present in any user dict
    for user in data:
        assert "auth_hash" not in user
        assert "id" in user
        assert "name" in user

def test_admin_tracks_endpoint_hides_user_hash(client):
    db = TestingSessionLocal()
    admin = create_user(db, "admin", "admintoken", is_admin=True)
    user = create_user(db, "alice", "alicetoken")
    create_track(db, "Test Track", user.auth_hash)
    db.close()

    response = client.get("/admin/tracks", headers={"x-auth-hash": "admintoken"})
    assert response.status_code == 200
    data = response.json()
    for track in data:
        assert "user_hash" not in track
        # Ensure other expected fields are present
        assert "id" in track
        assert "title" in track
        assert "user_name" in track
