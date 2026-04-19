import pytest
import tempfile
import os
from pathlib import Path
from unittest.mock import patch, mock_open
from fastapi.testclient import TestClient
from server.app.main import app
from server.app.db import Base, get_db
from server.app.models import Track, User, TrackPlay
import uuid
from sqlalchemy import create_engine, select, func
from sqlalchemy.orm import sessionmaker
from server.app.settings import settings
from datetime import datetime

# Override the database URL for testing
SQLALCHEMY_DATABASE_URL = "sqlite:///./test_stream.db"

engine = create_engine(
    SQLALCHEMY_DATABASE_URL, connect_args={"check_same_thread": False}
)
TestingSessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)

@pytest.fixture(scope="function")
def db_session():
    # Create the database and tables
    Base.metadata.create_all(bind=engine)
    db = TestingSessionLocal()
    try:
        yield db
    finally:
        db.close()
        # Drop all tables after test
        Base.metadata.drop_all(bind=engine)

@pytest.fixture(scope="function")
def client(db_session):
    # Override the get_db dependency
    def override_get_db():
        try:
            yield db_session
        finally:
            db_session.close()

    app.dependency_overrides[get_db] = override_get_db
    yield TestClient(app)
    app.dependency_overrides.clear()

@pytest.fixture
def auth_user(db_session):
    """Create a test user and return auth hash"""
    user = User(name="testuser", auth_hash="testhash123")
    db_session.add(user)
    db_session.commit()
    db_session.refresh(user)
    return user

@pytest.fixture
def test_track(db_session, auth_user):
    """Create a test track with a temporary file in the music directory"""
    # Ensure music directory exists
    settings.music_dir.mkdir(parents=True, exist_ok=True)

    # Create a temporary audio file in the music directory (large enough for range tests)
    # Create a file with ~1KB of data to satisfy range requests
    audio_content = b"ID3\x03\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00"  # Minimal MP3 header
    audio_content += b"\x00" * 1000  # Add 1000 bytes of silence

    # Create a subdirectory for test files to avoid conflicts
    test_music_dir = settings.music_dir / "test"
    test_music_dir.mkdir(parents=True, exist_ok=True)

    audio_file = test_music_dir / f"test_{uuid.uuid4().hex}.mp3"
    audio_file.write_bytes(audio_content)

    track = Track(
        id=str(uuid.uuid4()),
        title="Test Track",
        file_path=str(audio_file),
        mime_type="audio/mpeg",
        user_hash=auth_user.auth_hash
    )
    db_session.add(track)
    db_session.commit()
    db_session.refresh(track)
    return track, audio_file

def test_stream_track_non_range_increments_play_count(client, db_session, auth_user, test_track):
    """Test that non-range request increments play count and creates TrackPlay"""
    track, audio_file = test_track
    auth_hash = auth_user.auth_hash  # Extract auth hash while user is bound to session
    user_id = auth_user.id  # Extract user ID while user is bound to session

    # Make request without range header
    response = client.get(
        f"/tracks/{track.id}/stream",
        headers={"x-auth-hash": auth_hash}
    )

    assert response.status_code == 200
    assert response.headers["content-type"] == "audio/mpeg"

    # Verify play count incremented (query track again in current session)
    track_from_db = db_session.execute(
        select(Track).where(Track.id == track.id)
    ).scalar_one()
    assert track_from_db.play_count == 1

    # Verify TrackPlay record created
    track_play = db_session.execute(
        select(TrackPlay).where(TrackPlay.track_id == track.id)
    ).scalar_one_or_none()
    assert track_play is not None
    assert track_play.user_hash == auth_hash

    # Verify user's last_track_id updated
    user_from_db = db_session.execute(
        select(User).where(User.id == user_id)
    ).scalar_one()
    assert user_from_db.last_track_id == track.id

def test_stream_track_range_start_zero_increments_play_count(client, db_session, auth_user, test_track):
    """Test that range request with start=0 increments play count and creates TrackPlay"""
    track, audio_file = test_track
    auth_hash = auth_user.auth_hash  # Extract auth hash while user is bound to session
    user_id = auth_user.id  # Extract user ID while user is bound to session

    # Make request with range header starting at 0
    response = client.get(
        f"/tracks/{track.id}/stream",
        headers={"x-auth-hash": auth_hash, "range": "bytes=0-100"}
    )

    assert response.status_code == 206  # Partial content
    assert response.headers["content-type"] == "audio/mpeg"
    assert "bytes 0-100/" in response.headers["content-range"]

    # Verify play count incremented (query track again in current session)
    track_from_db = db_session.execute(
        select(Track).where(Track.id == track.id)
    ).scalar_one()
    assert track_from_db.play_count == 1

    # Verify TrackPlay record created
    track_play = db_session.execute(
        select(TrackPlay).where(TrackPlay.track_id == track.id)
    ).scalar_one_or_none()
    assert track_play is not None
    assert track_play.user_hash == auth_hash

    # Verify user's last_track_id updated
    user_from_db = db_session.execute(
        select(User).where(User.id == user_id)
    ).scalar_one()
    assert user_from_db.last_track_id == track.id

def test_stream_track_range_non_zero_no_increment(client, db_session, auth_user, test_track):
    """Test that range request with start>0 does NOT increment play count"""
    track, audio_file = test_track
    auth_hash = auth_user.auth_hash  # Extract auth hash while user is bound to session
    user_id = auth_user.id  # Extract user ID while user is bound to session

    # Make request with range header not starting at 0
    response = client.get(
        f"/tracks/{track.id}/stream",
        headers={"x-auth-hash": auth_hash, "range": "bytes=100-200"}
    )

    assert response.status_code == 206  # Partial content

    # Verify play count NOT incremented
    track_from_db = db_session.execute(
        select(Track).where(Track.id == track.id)
    ).scalar_one()
    assert track_from_db.play_count == 0

    # Verify no TrackPlay record created
    track_play_count = db_session.execute(
        select(func.count(TrackPlay.id)).where(TrackPlay.track_id == track.id)
    ).scalar()
    assert track_play_count == 0

    # Verify user's last_track_id NOT updated
    user_from_db = db_session.execute(
        select(User).where(User.id == user_id)
    ).scalar_one()
    assert user_from_db.last_track_id is None

def test_stream_track_db_rollback_on_error(client, db_session, auth_user, test_track):
    """Test that database errors trigger rollback and no partial state"""
    track, audio_file = test_track
    auth_hash = auth_user.auth_hash  # Extract auth hash while user is bound to session
    user_id = auth_user.id  # Extract user ID while user is bound to session

    # Mock a database error during commit
    with patch.object(db_session, 'commit', side_effect=Exception("DB error")):
        response = client.get(
            f"/tracks/{track.id}/stream",
            headers={"x-auth-hash": auth_hash}
        )

    # Should return 500 error
    assert response.status_code == 500

    # Verify rollback happened: play count not incremented
    # Use a fresh session to avoid issues with the current session state
    from server.app.db import TestingSessionLocal
    fresh_db = TestingSessionLocal()
    try:
        track_from_db = fresh_db.execute(
            select(Track).where(Track.id == track.id)
        ).scalar_one()
        assert track_from_db.play_count == 0  # Should remain 0

        # Verify no TrackPlay record created
        track_play_count = fresh_db.execute(
            select(func.count(TrackPlay.id)).where(TrackPlay.track_id == track.id)
        ).scalar()
        assert track_play_count == 0

        # Verify user's last_track_id not updated
        user_from_db = fresh_db.execute(
            select(User).where(User.id == user_id)
        ).scalar_one()
        assert user_from_db.last_track_id is None
    finally:
        fresh_db.close()

def test_stream_track_file_not_found_returns_404(client, auth_user):
    """Test that non-existent track returns 404"""
    # Use a valid UUID format that doesn't exist in the database
    nonexistent_uuid = "00000000-0000-0000-0000-000000000000"
    response = client.get(
        f"/tracks/{nonexistent_uuid}/stream",
        headers={"x-auth-hash": auth_user.auth_hash}
    )
    assert response.status_code == 404

def test_stream_track_unauthorized_returns_401(client, test_track):
    """Test that missing auth returns 401"""
    track, _ = test_track
    response = client.get(f"/tracks/{track.id}/stream")
    assert response.status_code == 401