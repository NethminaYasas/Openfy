import pytest
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session
from sqlalchemy import delete

from server.app.main import app
from server.app.db import Base, engine, SessionLocal
from server.app.models import User, Playlist, Track, PlaylistTrack


@pytest.fixture(scope="function", autouse=True)
def setup_db():
    """Create and drop tables for each test function."""
    Base.metadata.create_all(bind=engine)
    yield
    # Clear all data first with raw SQL to avoid FK ordering issues, then drop
    with engine.connect() as conn:
        for table in reversed(Base.metadata.sorted_tables):
            conn.execute(delete(table))
        conn.commit()
    Base.metadata.drop_all(bind=engine)


@pytest.fixture
def client() -> TestClient:
    """Create a fresh TestClient for each test."""
    with TestClient(app) as c:
        yield c


@pytest.fixture
def db():
    """Provide a fresh DB session per test."""
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


def create_unique_user(db: Session, name_suffix="", is_admin=0):
    """Create a user with guaranteed unique name and auth_hash."""
    from secrets import token_hex
    auth_hash = token_hex(32)
    name = f"test_{token_hex(4)}{name_suffix}"
    user = User(name=name, auth_hash=auth_hash, is_admin=is_admin)
    db.add(user)
    db.commit()
    db.refresh(user)
    return user


@pytest.fixture
def user_and_auth(db: Session):
    """Create a regular user and return user object + auth_hash."""
    user = create_unique_user(db)
    return {"user": user, "auth_hash": user.auth_hash}


@pytest.fixture
def playlist_with_track(db: Session, user_and_auth):
    """Create a regular playlist with one track."""
    user = user_and_auth["user"]

    track = Track(
        title="Test Track",
        file_path="/fake/path.mp3",
        user_hash=user.auth_hash,
    )
    db.add(track)
    db.commit()
    db.refresh(track)

    playlist = Playlist(
        name="Test Playlist",
        description="",
        user_hash=user.auth_hash,
        is_liked=0,
    )
    db.add(playlist)
    db.commit()
    db.refresh(playlist)

    link = PlaylistTrack(playlist_id=playlist.id, track_id=track.id, position=1)
    db.add(link)
    db.commit()

    return {"user": user, "track": track, "playlist": playlist}


# ——— Tests ———

def test_get_track_playlists_requires_auth(client: TestClient):
    """Endpoint returns 401 without x-auth-hash header."""
    resp = client.get("/tracks/fake-id/playlists")
    assert resp.status_code == 401


def test_get_track_playlists_invalid_auth(client: TestClient):
    """Endpoint returns 401 with invalid auth hash."""
    resp = client.get("/tracks/fake-id/playlists", headers={"x-auth-hash": "invalid"})
    assert resp.status_code == 401


def test_get_track_playlists_returns_empty_for_nonexistent_track(client: TestClient, user_and_auth):
    """Track ID that doesn't exist returns empty list (track not found is not an error)."""
    auth = user_and_auth["auth_hash"]
    resp = client.get(f"/tracks/00000000-0000-0000-0000-000000000000/playlists", headers={"x-auth-hash": auth})
    assert resp.status_code == 200
    assert resp.json() == []


def test_get_track_playlists_returns_playlists_containing_track(client: TestClient, playlist_with_track):
    """Track in a regular playlist returns that playlist."""
    auth = playlist_with_track["user"].auth_hash
    track_id = playlist_with_track["track"].id

    resp = client.get(f"/tracks/{track_id}/playlists", headers={"x-auth-hash": auth})
    assert resp.status_code == 200
    data = resp.json()
    assert isinstance(data, list)
    assert len(data) == 1
    assert data[0]["id"] == playlist_with_track["playlist"].id
    assert data[0]["name"] == "Test Playlist"
    assert data[0]["is_liked"] is False


def test_get_track_playlists_excludes_liked_songs(client: TestClient, db: Session, user_and_auth):
    """Liked Songs playlist is excluded from results."""
    user = user_and_auth["user"]
    auth = user_and_auth["auth_hash"]

    liked = Playlist(name="Liked Songs", user_hash=user.auth_hash, is_liked=1)
    db.add(liked)
    db.commit()
    db.refresh(liked)

    regular = Playlist(name="Regular", user_hash=user.auth_hash, is_liked=0)
    db.add(regular)
    db.commit()
    db.refresh(regular)

    track = Track(title="Test", file_path="/fake.mp3", user_hash=user.auth_hash)
    db.add(track)
    db.commit()
    db.refresh(track)

    db.add(PlaylistTrack(playlist_id=liked.id, track_id=track.id, position=1))
    db.add(PlaylistTrack(playlist_id=regular.id, track_id=track.id, position=1))
    db.commit()

    resp = client.get(f"/tracks/{track.id}/playlists", headers={"x-auth-hash": auth})
    assert resp.status_code == 200
    data = resp.json()
    names = [p["name"] for p in data]
    assert "Regular" in names
    assert "Liked Songs" not in names


def test_get_track_playlists_only_returns_owned_playlists(client: TestClient, db: Session, user_and_auth):
    """Endpoint only returns playlists belonging to the authenticated user."""
    user1 = user_and_auth["user"]
    auth1 = user_and_auth["auth_hash"]

    user2 = create_unique_user(db, name_suffix="_2")
    auth2 = user2.auth_hash

    track = Track(title="Secret", file_path="/secret.mp3", user_hash=user2.auth_hash)
    db.add(track)
    db.commit()
    db.refresh(track)

    pl2 = Playlist(name="User2 Playlist", user_hash=user2.auth_hash, is_liked=0)
    db.add(pl2)
    db.commit()
    db.refresh(pl2)
    db.add(PlaylistTrack(playlist_id=pl2.id, track_id=track.id, position=1))
    db.commit()

    resp = client.get(f"/tracks/{track.id}/playlists", headers={"x-auth-hash": auth1})
    assert resp.status_code == 200
    assert resp.json() == []
