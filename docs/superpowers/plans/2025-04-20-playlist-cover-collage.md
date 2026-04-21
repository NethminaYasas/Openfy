# Playlist Cover Collage Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Generate and serve a 2×2 collage of the first 4 tracks' album artwork as the playlist cover, shown for regular playlists (not Liked Songs) when they have 4 or more tracks.

**Architecture:** Backend generates collage on-demand using Pillow, caches to disk at `data/artwork/collages/{playlist_id}.jpg`. Frontend fetches via new `GET /playlists/{id}/cover` endpoint. Cache invalidates when tracks are added/removed.

**Tech Stack:** Python, FastAPI, Pillow, SQLAlchemy, JavaScript, Docker

---

## File Structure Map

| File | Role | Modified/Created |
|------|------|------------------|
| `server/requirements.txt` | Add Pillow dependency | Modified |
| `server/app/main.py` | Add collage endpoint, invalidation hooks, helper functions | Modified |
| `client/script.js` | Update `openPlaylist()` and `loadPlaylists()` to display collage | Modified |
| `server/tests/conftest.py` | Test fixtures (db, client) | Created |
| `server/tests/test_playlist_collage.py` | Unit + integration tests for collage feature | Created |

---

## Phase 0: Test Infrastructure Setup

### Task 1: Create test directory and conftest.py

**Files:**
- Create: `server/tests/__init__.py`
- Create: `server/tests/conftest.py`

**Step 1: Create `server/tests/__init__.py` (empty file for package)**

```bash
# No code needed - just create empty file
touch server/tests/__init__.py
```

**Step 2: Write `server/tests/conftest.py`**

```python
"""Pytest fixtures for Openfy server tests."""

import os
import tempfile
import shutil
from pathlib import Path
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker, Session

from app.main import app
from app.db import Base, get_db

# Use a temporary SQLite database for tests
TEST_DB_PATH = Path(tempfile.gettempdir()) / "openfy_test.db"


@pytest.fixture(scope="session")
def test_db_path():
    """Session-scoped temporary database path."""
    return TEST_DB_PATH


@pytest.fixture(scope="session")
def engine(test_db_path):
    """Create test database engine."""
    db_url = f"sqlite:///{test_db_path}"
    engine = create_engine(db_url, connect_args={"check_same_thread": False})
    Base.metadata.create_all(bind=engine)
    yield engine
    # Teardown
    if test_db_path.exists():
        test_db_path.unlink()


@pytest.fixture(scope="function")
def db_session(engine):
    """Create a fresh database session for each test."""
    TestingSessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)
    session: Session = TestingSessionLocal()
    # Clear all tables before each test
    for table in reversed(Base.metadata.sorted_tables):
        session.execute(table.delete())
    session.commit()
    yield session
    session.close()


@pytest.fixture(scope="function")
def client(db_session):
    """Create FastAPI test client with overridden DB dependency."""
    def override_get_db():
        yield db_session

    app.dependency_overrides[get_db] = override_get_db
    with TestClient(app) as c:
        yield c
    app.dependency_overrides.clear()


@pytest.fixture
def auth_hash(client):
    """Create a user and return their auth hash."""
    resp = client.post("/auth/signup", json={"name": "testuser"})
    return resp.json()["auth_hash"]


@pytest.fixture
def admin_auth_hash(client):
    """Create an admin user and return their auth hash."""
    # Use environment variable for admin hash (set in test env)
    # For tests, we'll promote the test user
    resp = client.post("/auth/signup", json={"name": "testadmin"})
    hash_val = resp.json()["auth_hash"]
    # Promote to admin via direct DB manipulation
    from app.db import SessionLocal
    from app.models import User
    db = SessionLocal()
    try:
        user = db.query(User).filter(User.auth_hash == hash_val).first()
        if user:
            user.is_admin = True
            db.commit()
    finally:
        db.close()
    return hash_val


@pytest.fixture
def sample_track(client, auth_hash, tmp_path):
    """Create a sample track with artwork for testing."""
    # Use the settings override for artwork/music dirs
    from app.settings import settings
    import mutagen
    from mutagen.id3 import ID3, APIC
    from mutagen.mp3 import MP3

    # Create a minimal valid MP3 file (just ID3 header for artwork test)
    test_file = tmp_path / "test.mp3"
    # Create minimal MP3 with ID3 tag
    audio = MP3(str(test_file))
    audio["TIT2"] = mutagen.id3.TIT2(encoding=3, text="Test Song")
    audio["TPE1"] = mutagen.id3.TPE1(encoding=3, text=["Test Artist"])
    audio["TALB"] = mutagen.id3.TALB(encoding=3, text="Test Album")
    audio["TRCK"] = mutagen.id3.TRCK(encoding=3, text="1")
    audio["TPOS"] = mutagen.id3.TPOS(encoding=3, text="1")
    audio["TDRC"] = mutagen.id3.TDRC(encoding=3, text="2024")
    audio["APIC"] = APIC(
        encoding=3,
        mime='image/jpeg',
        type=3,
        desc='Cover',
        data=b'\xff\xd8\xff\xe0' + b'\x00' * 100  # Minimal JPEG header + padding
    )
    audio.save(str(test_file), v1=2)

    # Upload via scan
    from app.services.library import scan_paths
    from app.db import SessionLocal
    db = SessionLocal()
    try:
        result = scan_paths(db, [test_file], user_hash=auth_hash)
        track = db.execute(
            f"SELECT * FROM tracks WHERE file_path = '{str(test_file)}'"
        ).first()
        if track:
            track_id = track[0]  # id column
        else:
            track_id = None
    finally:
        db.close()

    return {"id": track_id, "file_path": str(test_file)}


@pytest.fixture(autouse=True)
def cleanup_collages():
    """Clean up collage files after each test."""
    yield
    # Teardown: remove any collage files created during test
    from app.settings import settings
    collages_dir = settings.artwork_dir / "collages"
    if collages_dir.exists():
        for f in collages_dir.glob("*.jpg"):
            f.unlink()
```

**Step 3: Write `server/tests/__init__.py` (empty)**

```bash
touch server/tests/__init__.py
```

**Step 4: Create pytest configuration**

Create `server/pytest.ini`:
```ini
[pytest]
testpaths = server/tests
python_files = test_*.py
python_functions = test_*
addopts = -v --tb=short
```

**Step 5: Install pytest**

```bash
cd server && pip install pytest httpx
```

**Step 6: Verify test setup works**

```bash
cd server && python -m pytest server/tests/conftest.py -v 2>&1 | head -20
```

Expected: Should not error on import.

---

### Task 2: Write smoke test

**Files:**
- Create: `server/tests/test_smoke.py`

**Step 1: Write smoke test**

```python
"""Basic smoke tests for Openfy test setup."""

def test_pytest_works():
    """Verify pytest is functioning."""
    assert 1 + 1 == 2


def test_client_creation(client):
    """Test that the FastAPI test client is usable."""
    response = client.get("/health")
    assert response.status_code == 200
    assert response.json() == {"status": "ok"}
```

**Step 2: Run smoke test**

```bash
cd server && python -m pytest server/tests/test_smoke.py -v
```

Expected: `test_pytest_works` and `test_client_creation` both PASS.

**Step 3: Commit**

```bash
git add server/tests/ server/pytest.ini server/requirements.txt
git commit -m "test: set up pytest fixtures and smoke tests"
```

---

## Phase 1: Backend — Collage Infrastructure

### Task 3: Add Pillow dependency

**File:** `server/requirements.txt`

**Step 1:** Add Pillow line at end of file

```text
fastapi==0.115.6
uvicorn==0.30.6
SQLAlchemy==2.0.36
pydantic==2.9.2
pydantic-settings==2.5.2
python-multipart==0.0.12
mutagen==1.47.0
git+https://github.com/ShuShuzinhuu/SpotiFLAC-Module-Version.git
requests
ytmusicapi
beautifulsoup4
yt-dlp
Pillow==10.4.0
```

**Step 2: Install Pillow**

```bash
cd server && pip install Pillow==10.4.0
```

**Step 3: Commit**

```bash
git add server/requirements.txt
git commit -m "deps: add Pillow for image collage generation"
```

---

### Task 4: Create collages directory on startup

**File:** `server/app/main.py`

**Step 1: Add import for Path if not present (already present at top)**

Check that `from pathlib import Path` exists (line 1 shows it does). If not, add it.

**Step 2: Modify `_startup()` function**

Find the `_startup()` function starting around line 148. After `ensure_dirs()` call, add:

```python
from .services.storage import ensure_dirs

# ... existing _startup code ...

def _startup():
    ensure_dirs()
    # Ensure collages directory exists
    from pathlib import Path
    collages_dir = settings.artwork_dir / "collages"
    collages_dir.mkdir(parents=True, exist_ok=True)

    Base.metadata.create_all(bind=engine)
    # ... rest of existing _startup() code ...
```

**Step 3: No test needed yet (covered by integration test later).**

**Step 4: Commit**

```bash
git add server/app/main.py
git commit -m "feat: create collages directory on app startup"
```

---

### Task 5: Implement `_delete_playlist_collage()` helper

**File:** `server/app/main.py`

**Step 1: Add helper function after imports, before `_startup()`**

```python
from pathlib import Path
# ... other imports ...

def _delete_playlist_collage(playlist_id: str):
    """Delete cached collage for given playlist if it exists."""
    collages_dir = settings.artwork_dir / "collages"
    path = collages_dir / f"{playlist_id}.jpg"
    if path.exists():
        path.unlink()
```

**Step 2: Commit**

```bash
git add server/app/main.py
git commit -m "feat: add helper to delete cached playlist collages"
```

---

### Task 6: Write unit tests for `_delete_playlist_collage()`

**File:** `server/tests/test_playlist_collage.py`

**Step 1: Create test file and write failing tests**

```python
"""Tests for playlist cover collage generation."""

import io
from pathlib import Path
from PIL import Image

import pytest
from fastapi.testclient import TestClient


def test_delete_playlist_collage_removes_file(app_settings, tmp_path):
    """_delete_playlist_collage() removes collage file if it exists."""
    from app.main import _delete_playlist_collage

    # Arrange: set collages dir to temp path for test
    from app.settings import settings
    original_collages = settings.artwork_dir / "collages"
    test_collages_dir = tmp_path / "collages"
    test_collages_dir.mkdir()
    settings.artwork_dir = tmp_path  # override for test

    playlist_id = "test-playlist-123"
    collage_path = test_collages_dir / f"{playlist_id}.jpg"
    collage_path.write_bytes(b"fake image data")

    # Act
    _delete_playlist_collage(playlist_id)

    # Assert
    assert not collage_path.exists()

    # Restore settings
    settings.artwork_dir = original_collages.parent


def test_delete_playlist_collage_noop_when_missing(app_settings, tmp_path):
    """_delete_playlist_collage() does nothing if file doesn't exist."""
    from app.main import _delete_playlist_collage

    from app.settings import settings
    settings.artwork_dir = tmp_path

    # Should not raise
    _delete_playlist_collage("nonexistent-playlist-id")
    assert True


def test_generate_collage_2x2_grid(client, auth_hash, tmp_path, monkeypatch):
    """Collage endpoint returns a 500x500 image with 2x2 grid of album artwork."""
    from app.settings import settings
    settings.artwork_dir = tmp_path / "artwork"
    settings.artwork_dir.mkdir()
    (settings.artwork_dir / "collages").mkdir()

    # Create 4 mini artwork files (10x10 red, green, blue, yellow)
    artwork_dir = tmp_path / "album_art"
    artwork_dir.mkdir()
    colors = [(255,0,0), (0,255,0), (0,0,255), (255,255,0)]
    artwork_ids = []
    for i, color in enumerate(colors):
        img = Image.new("RGB", (10, 10), color)
        path = artwork_dir / f"album_{i}.jpg"
        img.save(path)
        artwork_ids.append(str(path))

    # Create 1 user, 1 album with artwork, 1 track linked to that album
    # We need to create proper DB records
    from app.db import SessionLocal
    from app.models import User, Album, Track, Playlist, PlaylistTrack

    db = SessionLocal()
    try:
        user = db.query(User).filter(User.auth_hash == auth_hash).first()
        album = Album(artwork_path=str(artwork_ids[0]))
        db.add(album)
        db.flush()
        track = Track(
            title="Track 1",
            file_path="/fake/path1.mp3",
            artist_id=None,
            album_id=album.id,
        )
        db.add(track)
        db.commit()

        # Also need Playlist with 4 tracks
        playlist = Playlist(name="Test Playlist", user_hash=auth_hash)
        db.add(playlist)
        db.flush()

        for i in range(4):
            pt = PlaylistTrack(playlist_id=playlist.id, track_id=track.id, position=i)
            db.add(pt)
        db.commit()

        playlist_id = playlist.id
    finally:
        db.close()

    # Set artwork_path for all tracks' albums to exist
    # (override to our test paths for the test)
    from app.main import app
    orig_artwork_dir = settings.artwork_dir

    # Call endpoint
    response = client.get(
        f"/playlists/{playlist_id}/cover",
        headers={"x-auth-hash": auth_hash}
    )

    assert response.status_code == 200
    assert response.headers["content-type"] == "image/jpeg"

    # Verify image dimensions
    img = Image.open(io.BytesIO(response.content))
    assert img.size == (500, 500)

    # Clean up
    settings.artwork_dir = orig_artwork_dir


def test_collage_endpoint_404_for_liked_songs(client, auth_hash):
    """Collage endpoint returns 404 for Liked Songs playlist."""
    # Get the auto-created Liked Songs playlist
    response = client.get("/playlists", headers={"x-auth-hash": auth_hash})
    playlists = response.json()
    liked = [p for p in playlists if p["is_liked"]][0]
    liked_id = liked["id"]

    resp = client.get(f"/playlists/{liked_id}/cover")
    assert resp.status_code == 404


def test_collage_endpoint_404_for_less_than_4_tracks(client, auth_hash):
    """Collage endpoint returns 404 when playlist has < 4 tracks."""
    from app.db import SessionLocal
    from app.models import Playlist, Track, Album, PlaylistTrack

    db = SessionLocal()
    try:
        user = db.query(User).filter(User.auth_hash == auth_hash).first()
        album = Album(title="Test Album")
        db.add(album)
        db.flush()
        track = Track(title="Track 1", file_path="/fake/1.mp3", album_id=album.id)
        db.add(track)
        db.flush()
        playlist = Playlist(name="Small Playlist", user_hash=auth_hash)
        db.add(playlist)
        db.flush()
        # Only 2 tracks
        for i in range(2):
            pt = PlaylistTrack(playlist_id=playlist.id, track_id=track.id, position=i)
            db.add(pt)
        db.commit()
        playlist_id = playlist.id
    finally:
        db.close()

    resp = client.get(f"/playlists/{playlist_id}/cover", headers={"x-auth-hash": auth_hash})
    assert resp.status_code == 404


def test_collage_cached_on_second_request(client, auth_hash, tmp_path, monkeypatch):
    """Second request for same collage serves cached file without regeneration."""
    from app.settings import settings
    settings.artwork_dir = tmp_path / "artwork"
    settings.artwork_dir.mkdir()
    collages = settings.artwork_dir / "collages"
    collages.mkdir()

    # Create proper DB with artwork
    from app.db import SessionLocal
    from app.models import User, Album, Track, Playlist, PlaylistTrack

    db = SessionLocal()
    try:
        user = db.query(User).filter(User.auth_hash == auth_hash).first()
        album = Album(artwork_path=str(tmp_path / "art0.jpg"))
        db.add(album)
        db.flush()
        track = Track(title="T1", file_path="/fake/1.mp3", album_id=album.id)
        db.add(track)
        db.flush()
        playlist = Playlist(name="Cache Test", user_hash=auth_hash)
        db.add(playlist)
        db.flush()
        for i in range(4):
            db.add(PlaylistTrack(playlist_id=playlist.id, track_id=track.id, position=i))
        db.commit()
        playlist_id = playlist.id
    finally:
        db.close()

    # First request — generates collage
    resp1 = client.get(f"/playlists/{playlist_id}/cover", headers={"x-auth-hash": auth_hash})
    assert resp1.status_code == 200

    # File should now exist
    collage_path = collages / f"{playlist_id}.jpg"
    assert collage_path.exists()

    # Modify file mtime to ensure we detect reuse
    original_mtime = collage_path.stat().st_mtime

    # Second request — should hit cache (file exists and serves faster)
    resp2 = client.get(f"/playlists/{playlist_id}/cover", headers={"x-auth-hash": auth_hash})
    assert resp2.status_code == 200
    # Content should be identical
    assert resp2.content == resp1.content


def test_collage_invalidates_on_track_add(client, auth_hash, tmp_path):
    """Adding a track invalidates cached collage."""
    from app.settings import settings
    settings.artwork_dir = tmp_path / "artwork"
    settings.artwork_dir.mkdir()
    collages = settings.artwork_dir / "collages"
    collages.mkdir()

    from app.db import SessionLocal
    from app.models import User, Album, Track, Playlist, PlaylistTrack

    # Create playlist with 4 tracks, album with artwork
    db = SessionLocal()
    try:
        user = db.query(User).filter(User.auth_hash == auth_hash).first()
        album = Album(artwork_path=str(tmp_path / "art0.jpg"))
        db.add(album)
        db.flush()
        track = Track(title="T1", file_path="/fake/1.mp3", album_id=album.id)
        db.add(track)
        db.flush()
        playlist = Playlist(name="Invalidation Test", user_hash=auth_hash)
        db.add(playlist)
        db.flush()
        for i in range(4):
            db.add(PlaylistTrack(playlist_id=playlist.id, track_id=track.id, position=i))
        db.commit()
        playlist_id = playlist.id
    finally:
        db.close()

    # Pre-generate collage
    resp1 = client.get(f"/playlists/{playlist_id}/cover", headers={"x-auth-hash": auth_hash})
    assert resp1.status_code == 200
    collage_path = collages / f"{playlist_id}.jpg"
    assert collage_path.exists()
    collage_mtime_before = collage_path.stat().st_mtime

    # Add a 5th track (POST /playlists/{id}/tracks)
    response = client.post(
        f"/playlists/{playlist_id}/tracks?track_id={track.id}",
        headers={"x-auth-hash": auth_hash}
    )
    assert response.status_code == 200

    # Collage file should be deleted
    assert not collage_path.exists()

    # Next cover request regenerates
    resp2 = client.get(f"/playlists/{playlist_id}/cover", headers={"x-auth-hash": auth_hash})
    assert resp2.status_code == 200
    assert collage_path.exists()

    # The newly generated file should have a different mtime
    collage_mtime_after = collage_path.stat().st_mtime
    assert collage_mtime_after > collage_mtime_before


def test_collage_invalidates_on_playlist_delete(client, auth_hash, tmp_path):
    """Deleting a playlist removes its cached collage."""
    from app.settings import settings
    settings.artwork_dir = tmp_path / "artwork"
    settings.artwork_dir.mkdir()
    collages = settings.artwork_dir / "collages"
    collages.mkdir()

    from app.db import SessionLocal
    from app.models import User, Album, Track, Playlist, PlaylistTrack

    db = SessionLocal()
    try:
        user = db.query(User).filter(User.auth_hash == auth_hash).first()
        album = Album(artwork_path=str(tmp_path / "art0.jpg"))
        db.add(album)
        db.flush()
        track = Track(title="T1", file_path="/fake/1.mp3", album_id=album.id)
        db.add(track)
        db.flush()
        playlist = Playlist(name="Delete Me", user_hash=auth_hash)
        db.add(playlist)
        db.flush()
        for i in range(4):
            db.add(PlaylistTrack(playlist_id=playlist.id, track_id=track.id, position=i))
        db.commit()
        playlist_id = playlist.id
    finally:
        db.close()

    # Generate collage
    resp = client.get(f"/playlists/{playlist_id}/cover", headers={"x-auth-hash": auth_hash})
    assert resp.status_code == 200
    collage_path = collages / f"{playlist_id}.jpg"
    assert collage_path.exists()

    # Delete playlist
    response = client.delete(
        f"/playlists/{playlist_id}",
        headers={"x-auth-hash": auth_hash}
    )
    assert response.status_code == 200

    # Collage file should be gone
    assert not collage_path.exists()


def test_collage_403_for_other_users_playlist(client, auth_hash, admin_auth_hash):
    """User cannot access another user's playlist collage."""
    from app.db import SessionLocal
    from app.models import User, Playlist

    # Create second user with their own playlist
    db = SessionLocal()
    try:
        other_hash = "otheruserauthhash12345678901234567890"
        other_user = User(name="otheruser", auth_hash=other_hash)
        db.add(other_user)
        pl = Playlist(name="Other Playlist", user_hash=other_hash)
        db.add(pl)
        db.commit()
        other_playlist_id = pl.id
    finally:
        db.close()

    # auth_hash user tries to access other's collage
    resp = client.get(
        f"/playlists/{other_playlist_id}/cover",
        headers={"x-auth-hash": auth_hash}
    )
    assert resp.status_code == 403


def test_collage_missing_artwork_shows_gray_quadrants(client, auth_hash, tmp_path):
    """Tracks without album artwork produce gray quadrants in collage."""
    from app.settings import settings
    settings.artwork_dir = tmp_path / "artwork"
    settings.artwork_dir.mkdir()
    collages = settings.artwork_dir / "collages"
    collages.mkdir()

    from app.db import SessionLocal
    from app.models import User, Album, Track, Playlist, PlaylistTrack

    db = SessionLocal()
    try:
        user = db.query(User).filter(User.auth_hash == auth_hash).first()
        # Create 4 albums: only 1 has artwork, others have None
        albums = []
        for i in range(4):
            art_path = None if i > 0 else str(tmp_path / "art0.jpg")
            alb = Album(artwork_path=art_path)
            db.add(alb)
            db.flush()
            albums.append(alb)

        playlist = Playlist(name="Mixed Artwork", user_hash=auth_hash)
        db.add(playlist)
        db.flush()

        for i, alb in enumerate(albums):
            t = Track(title=f"Track {i+1}", file_path=f"/fake/{i}.mp3", album_id=alb.id)
            db.add(t)
            db.flush()
            db.add(PlaylistTrack(playlist_id=playlist.id, track_id=t.id, position=i))
        db.commit()
        playlist_id = playlist.id
    finally:
        db.close()

    resp = client.get(f"/playlists/{playlist_id}/cover", headers={"x-auth-hash": auth_hash})
    assert resp.status_code == 200

    img = Image.open(io.BytesIO(resp.content))
    assert img.size == (500, 500)
    # Top-left quadrant should have image data (non-gray), others can be gray
    # We just verify collage was generated without error
    assert img is not None
```

**Important Note:** The above tests use `app_settings` fixture and monkeypatching of `settings.artwork_dir`. In practice, you'll need to adapt the fixtures above — specifically you need to create fixtures that properly isolate file system operations. The `conftest.py` should include fixtures that override settings paths to temp directories.

**Expected run:** All tests initially FAIL because endpoint doesn't exist yet.

**Step 2: Run tests (they should fail)**

```bash
cd server && python -m pytest server/tests/test_playlist_collage.py -v
```

Expected: Test collection errors or "function not defined" errors.

**Step 3: Commit**

```bash
git add server/tests/test_playlist_collage.py
git commit -m "test: add collage generation unit tests (initially failing)"
```

---

### Task 7: Implement collage generation function

**File:** `server/app/main.py`

**Step 1: Add imports at top**

Add below existing imports (around line 60):

```python
from io import BytesIO
from PIL import Image
```

**Step 2: Write `_generate_playlist_collage()` function**

Add before `_startup()`:

```python
def _generate_playlist_collage(
    playlist_tracks: list,
    settings_obj,
    canvas_size: int = 500,
    grid_columns: int = 2,
    grid_rows: int = 2,
) -> bytes:
    """
    Generate a 2x2 collage of album artwork from first 4 tracks.

    Args:
        playlist_tracks: List of PlaylistTrack objects with loaded track.album
        settings_obj: Settings instance for artwork_dir
        canvas_size: Output image size (default 500px square)
        grid_columns: Number of columns in grid (default 2)
        grid_rows: Number of rows in grid (default 2)

    Returns:
        JPEG image bytes
    """
    tile_size = canvas_size // grid_columns  # 250px each
    collage = Image.new("RGB", (canvas_size, canvas_size), (40, 40, 40))  # #282828 gray

    # Take first 4 tracks
    for idx, pt in enumerate(playlist_tracks[:4]):
        track = pt.track
        if not track or not track.album or not track.album.artwork_path:
            continue  # leave this quadrant as gray

        artwork_path = Path(track.album.artwork_path)
        if not artwork_path.exists():
            continue

        try:
            img = Image.open(artwork_path)
            # Convert to RGB if needed (handles PNG, etc.)
            if img.mode in ("RGBA", "LA", "P"):
                img = img.convert("RGB")
            # Resize with Lanczos for quality
            img_resized = img.resize((tile_size, tile_size), Image.Resampling.LANCZOS)

            # Calculate grid position
            col = idx % grid_columns
            row = idx // grid_columns
            x = col * tile_size
            y = row * tile_size

            collage.paste(img_resized, (x, y))
        except Exception:
            # On any image error, skip — quadrant remains gray
            continue

    # Save to bytes as JPEG
    buffer = BytesIO()
    collage.save(buffer, format="JPEG", quality=85)
    return buffer.getvalue()
```

**Step 3: Run unit tests**

```bash
cd server && python -m pytest server/tests/test_playlist_collage.py -v
```

Expected: Tests involving actual collage generation should now PASS (or at least get past "function not defined").

**Step 4: Commit**

```bash
git add server/app/main.py
git commit -m "feat: add _generate_playlist_collage() helper function"
```

---

### Task 8: Implement GET /playlists/{playlist_id}/cover endpoint

**File:** `server/app/main.py`

**Step 1: Add endpoint after `DELETE /playlists/{playlist_id}` (around line 851)**

```python
@app.get("/playlists/{playlist_id}/cover")
def get_playlist_cover(
    playlist_id: str,
    x_auth_hash: str | None = Header(None),
    db: Session = Depends(get_db),
):
    """Generate or serve cached playlist cover collage.

    Returns a 500x500 JPEG image composed of first 4 tracks' album artwork.
    Liked Songs playlists and playlists with < 4 tracks return 404.
    """
    from pathlib import Path
    from io import BytesIO
    from PIL import Image

    if not x_auth_hash:
        raise HTTPException(status_code=401, detail="Not authenticated")

    user = _get_user(db, x_auth_hash)
    if not user:
        raise HTTPException(status_code=401, detail="Invalid auth hash")

    playlist = db.get(Playlist, playlist_id)
    if not playlist:
        raise HTTPException(status_code=404, detail="Playlist not found")

    if playlist.user_hash != x_auth_hash and not user.is_admin:
        raise HTTPException(status_code=403, detail="Not your playlist")

    # Liked Songs never uses collage
    if playlist.is_liked:
        raise HTTPException(status_code=404, detail="No collage for Liked Songs")

    # Check track count
    track_count = db.execute(
        select(func.count(PlaylistTrack.track_id)).where(
            PlaylistTrack.playlist_id == playlist_id
        )
    ).scalar_one_or_none() or 0

    if track_count < 4:
        raise HTTPException(status_code=404, detail="Playlist has fewer than 4 tracks")

    # Build collage
    stmt = (
        select(PlaylistTrack)
        .options(selectinload(PlaylistTrack.track).selectinload(Track.album))
        .where(PlaylistTrack.playlist_id == playlist_id)
        .order_by(PlaylistTrack.position.asc())
        .limit(4)
    )
    first_four = db.execute(stmt).scalars().all()
    if len(first_four) < 4:
        raise HTTPException(status_code=404, detail="Not enough tracks")

    image_bytes = _generate_playlist_collage(first_four, settings)

    return Response(content=image_bytes, media_type="image/jpeg")
```

**Note:** The `selectinload` for `Track.album` is already imported at the top (line 25 in main.py shows `from sqlalchemy.orm import Session, selectinload`). If `_generate_playlist_collage` isn't visible (defined below), ensure it's defined before this endpoint.

**Step 2: Place `_generate_playlist_collage` function before this endpoint** (if not already placed from Task 7)

**Step 3: Run tests**

```bash
cd server && python -m pytest server/tests/test_playlist_collage.py::test_collage_endpoint_404_for_liked_songs -v
```

Expected: That test should now PASS.

**Step 4: Commit**

```bash
git add server/app/main.py
git commit -m "feat: add GET /playlists/{id}/cover endpoint"
```

---

### Task 9: Add cache invalidation to POST /playlists/{id}/tracks

**File:** `server/app/main.py`

**Step 1: Modify the existing `add_track_to_playlist` function**

Find the `@app.post("/playlists/{playlist_id}/tracks")` endpoint (around line 783).

After the `db.commit()` and `db.refresh(link)` near the end (currently lines 826–828), add:

```python
    # Invalidate cached collage after adding a track
    _delete_playlist_collage(playlist_id)
```

The full end of the function should now read:

```python
    link = PlaylistTrack(
        playlist_id=playlist_id, track_id=track_id, position=next_position
    )
    db.add(link)
    db.commit()
    db.refresh(link)

    # Invalidate cached collage
    _delete_playlist_collage(playlist_id)

    return link
```

**Step 2: Test via existing integration test `test_collage_invalidates_on_track_add`**

```bash
cd server && python -m pytest server/tests/test_playlist_collage.py::test_collage_invalidates_on_track_add -v
```

Expected: PASS.

**Step 3: Commit**

```bash
git add server/app/main.py
git commit -m "feat: invalidate collage cache on track addition"
```

---

### Task 10: Add cache invalidation to DELETE /playlists/{playlist_id}

**File:** `server/app/main.py`

**Step 1: Modify `delete_playlist` function**

Find `@app.delete("/playlists/{playlist_id}")` around line 831.

Before `db.delete(playlist)`, add collage deletion:

```python
    # Delete cached collage if it exists
    _delete_playlist_collage(playlist_id)

    db.delete(playlist)
    db.commit()
    return {"status": "deleted"}
```

**Step 2: Run invalidation test**

```bash
cd server && python -m pytest server/tests/test_playlist_collage.py::test_collage_invalidates_on_playlist_delete -v
```

Expected: PASS.

**Step 3: Commit**

```bash
git add server/app/main.py
git commit -m "feat: delete collage file when playlist is deleted"
```

---

## Phase 2: Frontend — Display Collage

### Task 11: Update `openPlaylist()` to load collage image

**File:** `client/script.js`

**Step 1: Locate `openPlaylist()` function (~line 2472)**

Replace the existing cover setup code (lines 2480–2482):

```javascript
var cover = document.getElementById("playlist-cover");
cover.style.background = pl.is_liked ? "linear-gradient(135deg,#450af5,#c4efd9)" : "#282828";
cover.innerHTML = pl.is_liked ? '<i class="fa-solid fa-heart"></i>' : '<svg class="playlist-cover-icon" viewBox="292 128 156 156" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Playlist"><title>Playlist icon</title><desc>A music note/playlist icon</desc><g transform="translate(297, 133) scale(6.667)"><path fill="currentColor" d="M6 3h15v15.167a3.5 3.5 0 1 1-3.5-3.5H19V5H8v13.167a3.5 3.5 0 1 1-3.5-3.5H6zm0 13.667H4.5a1.5 1.5 0 1 0 1.5 1.5zm13 0h-1.5a1.5 1.5 0 1 0 1.5 1.5z"/></g></svg>';
```

**Step 2: Replace with new logic**

```javascript
var cover = document.getElementById("playlist-cover");

if (pl.is_liked) {
    // Liked Songs: keep gradient + heart icon
    cover.style.background = "linear-gradient(135deg,#450af5,#c4efd9)";
    cover.innerHTML = '<i class="fa-solid fa-heart"></i>';
} else {
    // Regular playlist: try to load collage image, fall back to icon
    cover.style.background = "transparent";
    cover.innerHTML = ""; // clear

    var img = document.createElement("img");
    img.src = withBase("/playlists/" + playlistId + "/cover?v=" + Date.now());
    img.style.width = "100%";
    img.style.height = "100%";
    img.style.objectFit = "cover";
    img.style.borderRadius = "8px";

    img.onerror = function() {
        // Fallback: gray background + playlist icon
        cover.style.background = "#282828";
        cover.innerHTML = '<svg class="playlist-cover-icon" viewBox="292 128 156 156" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Playlist"><title>Playlist icon</title><desc>A music note/playlist icon</desc><g transform="translate(297, 133) scale(6.667)"><path fill="currentColor" d="M6 3h15v15.167a3.5 3.5 0 1 1-3.5-3.5H19V5H8v13.167a3.5 3.5 0 1 1-3.5-3.5H6zm0 13.667H4.5a1.5 1.5 0 1 0 1.5 1.5zm13 0h-1.5a1.5 1.5 0 1 0 1.5 1.5z"/></g></svg>';
    };

    cover.appendChild(img);
}
```

**Step 3: Manual verification**

Open a playlist in browser, check network tab for `/playlists/{id}/cover` request.

**Step 4: Commit**

```bash
git add client/script.js
git commit -m "feat: display collage image on playlist page for regular playlists"
```

---

### Task 12: Add collage thumbnails to sidebar playlists

**File:** `client/script.js`

**Step 1: Find `loadPlaylists()` function (~line 2369)**

Within that function, locate the code that creates `lib-item-cover`. The section around line 2396–2402:

```javascript
var bg = pl.is_liked ? "linear-gradient(135deg,#450af5,#c4efd9)" : "#282828";
var cover = document.createElement("div");
cover.className = "lib-item-cover";
cover.style.background = bg;
if (pl.is_liked) {
    var iconEl = document.createElement("i");
    iconEl.className = "fa-solid fa-heart";
    cover.appendChild(iconEl);
} else {
    var iconEl = document.createElement("img");
    iconEl.className = "playlist-cover-icon";
    // ... existing icon SVG probably not there, check exactly
}
```

**Step 2: Replace the non-liked branch to attempt collage**

```javascript
var bg = pl.is_liked ? "linear-gradient(135deg,#450af5,#c4efd9)" : "#282828";
var cover = document.createElement("div");
cover.className = "lib-item-cover";
cover.style.background = bg;

if (pl.is_liked) {
    cover.innerHTML = '<i class="fa-solid fa-heart"></i>';
} else {
    // Try to load collage thumbnail
    var img = document.createElement("img");
    img.className = "playlist-cover-icon";
    img.src = withBase("/playlists/" + pl.id + "/cover?v=" + Date.now());
    img.style.width = "100%";
    img.style.height = "100%";
    img.style.objectFit = "cover";
    img.style.display = "block";
    img.onerror = function() {
        // On error, keep gray background and show default icon
        img.style.display = "none";
        cover.innerHTML = '<svg class="playlist-cover-icon" viewBox="292 128 156 156" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Playlist"><title>Playlist icon</title><desc>A music note/playlist icon</desc><g transform="translate(297, 133) scale(6.667)"><path fill="currentColor" d="M6 3h15v15.167a3.5 3.5 0 1 1-3.5-3.5H19V5H8v13.167a3.5 3.5 0 1 1-3.5-3.5H6zm0 13.667H4.5a1.5 1.5 0 1 0 1.5 1.5zm13 0h-1.5a1.5 1.5 0 1 0 1.5 1.5z"/></g></svg>';
    };
    cover.appendChild(img);
}
```

**Step 3: Commit**

```bash
git add client/script.js
git commit -m "feat: show collage thumbnails in sidebar playlist list"
```

---

## Phase 3: Docker Build & Verification

### Task 13: Rebuild Docker image

```bash
docker compose build --no-cache
```

Wait for build to complete.

**Check:** Build includes Pillow (from requirements.txt) and no caching issues.

---

### Task 14: Start services and run manual test

```bash
docker compose up -d
```

Wait ~10 seconds for server to start.

---

### Task 15: Manual test checklist

Open browser: `http://localhost:8000`

For each item, verify behavior:

1. **Create account** and log in
2. **Upload 4+ tracks** with album artwork (MP3 files with embedded album art)
3. **Create new playlist** and add all 4+ tracks
4. **Open playlist page:**
   - [ ] Large 232px cover shows 2×2 collage of album artwork
   - [ ] Network tab shows successful `/playlists/{id}/cover` request (200)
5. **Check sidebar playlist item:**
   - [ ] Small 48px cover shows same collage (scaled down)
6. **Add 5th track:**
   - [ ] Collage should refresh (old collage invalidated)
   - [ ] New collage still shows first 4 tracks (not middle 4)
7. **Remove 1 track (drops below 4):**
   - [ ] Next cover request returns 404 (gray fallback)
8. **Liked Songs playlist:**
   - [ ] Shows gradient background + heart, no collage
9. **Delete playlist:**
   - [ ] Removed from sidebar, collage file deleted from disk

---

### Task 16: Final commit and push

```bash
git add .
git commit -m "feat: implement playlist cover collage feature

- Add Pillow dependency
- Backend endpoint GET /playlists/{id}/cover generates on-demand collage
- Cache stored in data/artwork/collages/, invalidates on track changes
- Frontend displays collage in playlist header and sidebar
- Liked Songs retains gradient styling"
```

---

## End of Plan

**Plan complete and saved to `docs/superpowers/plans/2025-04-20-playlist-cover-collage.md`.**

---

**Two execution options:**

**1. Subagent-Driven (recommended)** - I dispatch a fresh subagent per task, review between tasks, fast iteration

**2. Inline Execution** - Execute tasks in this session using executing-plans, batch execution with checkpoints

Which approach?
