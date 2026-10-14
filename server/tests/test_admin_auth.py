import hashlib
from pathlib import Path
import re
import subprocess
import sys
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient
from pydantic import ValidationError
from sqlalchemy import create_engine, event, select, text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import sessionmaker

from app import main
from app.db import Base, get_db
from app.models import (
    Album, Artist, DownloadJob, FollowedAlbum, FollowedArtist, FollowedPlaylist,
    Playlist, Track, TrackPlay, User,
)
from app.services import storage
from app.settings import ADMIN_TOKEN_PATTERN, Settings


LEGACY_HASH = hashlib.sha256(b"guessable-password").hexdigest()
ADMIN_TOKEN = "of1_" + "A" * 60  # Synthetic test credential only.
OWNED_MODELS = (Track, Playlist, FollowedPlaylist, FollowedAlbum, FollowedArtist, DownloadJob, TrackPlay)


@pytest.fixture
def auth_env(tmp_path, monkeypatch):
    config = Settings(
        _env_file=None,
        database_url=f"sqlite:///{tmp_path / 'test.db'}",
        data_dir=tmp_path, music_dir=tmp_path / "music",
        downloads_dir=tmp_path / "downloads", artwork_dir=tmp_path / "artwork",
        admin_username="admin", admin_hash=ADMIN_TOKEN,
    )
    engine = create_engine(config.database_url, connect_args={"check_same_thread": False})

    @event.listens_for(engine, "connect")
    def enable_foreign_keys(connection, _):
        connection.execute("PRAGMA foreign_keys = ON")

    sessions = sessionmaker(bind=engine, autoflush=False)
    Base.metadata.create_all(engine)
    monkeypatch.setattr(main, "settings", config)
    monkeypatch.setattr(storage, "settings", config)
    monkeypatch.setattr(main, "engine", engine)
    monkeypatch.setattr(main, "SessionLocal", sessions)
    monkeypatch.setattr(main, "_prefetch_artist_images", lambda: None)
    main._rate_limit_store.clear()

    def override_db():
        with sessions() as db:
            yield db

    main.app.dependency_overrides[get_db] = override_db
    client = TestClient(main.app)
    yield SimpleNamespace(config=config, sessions=sessions, client=client)
    client.close()
    main.app.dependency_overrides.pop(get_db)
    main._rate_limit_store.clear()
    engine.dispose()


def test_generator_produces_distinct_credentials_and_rejects_passwords():
    generator = Path(__file__).resolve().parents[2] / "scripts" / "generate_hash.py"
    tokens = [subprocess.check_output([sys.executable, str(generator)], text=True).strip() for _ in range(2)]
    assert tokens[0] != tokens[1]
    assert all(len(token) == 64 and re.fullmatch(ADMIN_TOKEN_PATTERN, token) for token in tokens)
    result = subprocess.run([sys.executable, str(generator), "password"], capture_output=True, text=True)
    assert result.returncode != 0
    assert result.stdout == ""


@pytest.mark.parametrize("credential", [LEGACY_HASH, "placeholder", "of1_" + "A" * 59])
def test_settings_require_rotation_of_legacy_credentials(credential):
    with pytest.raises(ValidationError, match="Generate a new random administrator credential"):
        Settings(_env_file=None, admin_hash=credential)


def test_legacy_admin_cannot_bypass_signin_limit(auth_env):
    with auth_env.sessions() as db:
        db.add(User(name="legacy-admin", auth_hash=LEGACY_HASH, is_admin=True))
        db.commit()
    # No configured admin: a leftover legacy administrator must still be rejected.
    auth_env.config.admin_username = ""
    auth_env.config.admin_hash = ""
    client = auth_env.client
    assert client.post("/auth/signin", json={"auth_hash": LEGACY_HASH}).status_code == 401
    for _ in range(14):
        assert client.post("/auth/signin", json={"auth_hash": "0" * 64}).status_code == 401
    assert client.post("/auth/signin", json={"auth_hash": LEGACY_HASH}).status_code == 429
    for path in ("/auth/me", "/admin/settings", "/admin/users"):
        assert client.get(path, headers={"x-auth-hash": LEGACY_HASH}).status_code in {401, 403}


def test_new_admin_and_existing_regular_user_can_authenticate(auth_env):
    main._startup()
    regular_hash = "b" * 64
    with auth_env.sessions() as db:
        db.add(User(name="regular", auth_hash=regular_hash))
        db.commit()
    for credential, is_admin in ((ADMIN_TOKEN, True), (regular_hash, False)):
        response = auth_env.client.post("/auth/signin", json={"auth_hash": credential})
        assert response.status_code == 200
        assert response.json()["auth_hash"] == credential
        assert response.json()["is_admin"] is is_admin
        headers = {"x-auth-hash": credential}
        response = auth_env.client.get("/auth/me", headers=headers)
        assert response.status_code == 200
        assert response.json()["is_admin"] is is_admin
        assert "auth_hash" not in response.json()
        assert auth_env.client.get("/admin/settings", headers=headers).status_code == (200 if is_admin else 403)


@pytest.mark.parametrize("collision", [False, True])
def test_rotation_preserves_ownership_and_is_atomic(auth_env, collision):
    with auth_env.sessions() as db:
        admin = User(name="admin", auth_hash=LEGACY_HASH, is_admin=True)
        other_hash = ADMIN_TOKEN if collision else "c" * 64
        db.add_all([admin, User(name="other", auth_hash=other_hash)])
        db.commit()
        admin_id = admin.id
        artist = Artist(name="Test artist")
        db.add(artist)
        db.flush()
        album = Album(title="Test album", artist_id=artist.id)
        track = Track(title="Test track", file_path="synthetic.flac", user_hash=LEGACY_HASH, universal_track_id="test")
        playlist = Playlist(name="Private playlist", user_hash=LEGACY_HASH)
        db.add_all([album, track, playlist, Playlist(name="Other playlist", user_hash=other_hash)])
        db.flush()
        db.add_all([
            FollowedPlaylist(user_hash=LEGACY_HASH, playlist_id=playlist.id),
            FollowedAlbum(user_hash=LEGACY_HASH, album_id=album.id),
            FollowedArtist(user_hash=LEGACY_HASH, artist_id=artist.id),
            DownloadJob(user_hash=LEGACY_HASH, source="test", query="test"),
            TrackPlay(user_hash=LEGACY_HASH, track_id=track.id),
        ])
        db.commit()

    if collision:
        with pytest.raises(IntegrityError):
            main._startup()
    else:
        main._startup()
        main._startup()  # Restarting must preserve the same account and references.

    expected = LEGACY_HASH if collision else ADMIN_TOKEN
    with auth_env.sessions() as db:
        assert db.get(User, admin_id).auth_hash == expected
        assert db.get(User, admin_id).is_admin
        for model in OWNED_MODELS:
            assert db.execute(select(model).where(model.user_hash == expected)).scalars().all()
            if not collision:
                assert not db.execute(select(model).where(model.user_hash == LEGACY_HASH)).first()
        other_playlist = db.execute(select(Playlist).where(Playlist.name == "Other playlist")).scalar_one()
        assert other_playlist.user_hash == other_hash
        assert not db.execute(text("PRAGMA foreign_key_check")).all()

    if not collision:
        assert auth_env.client.get("/auth/me", headers={"x-auth-hash": LEGACY_HASH}).status_code == 401
        assert auth_env.client.get("/admin/settings", headers={"x-auth-hash": ADMIN_TOKEN}).status_code == 200
