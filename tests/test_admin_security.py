import pytest
from fastapi.testclient import TestClient
from server.app.main import app
from server.app.models import User
from server.app.db import SessionLocal, engine, Base
from server.app.services.storage import ensure_dirs

# Setup test DB (in‑memory SQLite) and FastAPI client
@pytest.fixture(scope="module")
def client():
    # Use a fresh database for tests
    Base.metadata.drop_all(bind=engine)
    Base.metadata.create_all(bind=engine)
    ensure_dirs()
    with TestClient(app) as c:
        yield c

def create_admin_and_user(db_session):
    admin = User(name="admin", auth_hash="adminhash" * 4, is_admin=True)
    user = User(name="bob", auth_hash="bobhash" * 4, is_admin=False)
    db_session.add_all([admin, user])
    db_session.commit()
    return admin.auth_hash, user.auth_hash

def test_admin_tracks_does_not_expose_user_hash(client):
    db = SessionLocal()
    admin_hash, user_hash = create_admin_and_user(db)
    db.close()

    # Call admin tracks endpoint with admin auth
    response = client.get("/admin/tracks", headers={"x-auth-hash": admin_hash})
    assert response.status_code == 200
    data = response.json()
    # Ensure each item does not contain the sensitive field
    for track in data:
        assert "user_hash" not in track

def test_admin_users_does_not_expose_auth_hash(client):
    db = SessionLocal()
    admin_hash, user_hash = create_admin_and_user(db)
    db.close()

    response = client.get("/admin/users", headers={"x-auth-hash": admin_hash})
    assert response.status_code == 200
    data = response.json()
    for user in data:
        # The endpoint never returned auth_hash, but verify explicitly
        assert "auth_hash" not in user
