import secrets
import shutil
import tempfile
from pathlib import Path
import json
import time
import re
from datetime import datetime, timedelta
from typing import List
from collections import defaultdict
from time import monotonic
from threading import Lock

from fastapi import (
    FastAPI,
    Depends,
    HTTPException,
    Header,
    Query,
    Request,
    UploadFile,
    File,
)
from fastapi.staticfiles import StaticFiles
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import (
    StreamingResponse,
    FileResponse,
    HTMLResponse,
    Response,
    JSONResponse,
)
from PIL import Image
from sqlalchemy.orm import Session, selectinload
from sqlalchemy import select, text, func
from sqlalchemy import delete
from sqlalchemy.exc import IntegrityError

import logging

# Configure logging for security events
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)

# In-memory rate limiting store: {identifier: [(timestamp, count), ...]}
_rate_limit_store: dict[str, list] = defaultdict(list)
_stream_token_store: dict[str, tuple[str, str, float]] = {}
_stream_token_lock = Lock()
_STREAM_TOKEN_TTL_SECONDS = 120

from .db import Base, engine, get_db, SessionLocal
from .models import (
    Track,
    Artist,
    Album,
    Playlist,
    PlaylistTrack,
    DownloadJob,
    User,
    TrackPlay,
    AppSetting,
    track_artist,
)
from .schemas import (
    TrackOut,
    ArtistOut,
    AlbumOut,
    PlaylistCreate,
    PlaylistUpdate,
    PlaylistOut,
    PlaylistTrackOut,
    DownloadRequest,
    DownloadJobOut,
    UserSignup,
    UserSignin,
    UserOut,
    UserOutPublic,
    UserUploadPreferenceUpdate,
    UserLibraryStateUpdate,
    UserPlayerStateUpdate,
    UserQueueUpdate,
    SystemSettingsUpdate,
    SystemSettingsOut,
)
from .settings import settings
from .services.storage import ensure_dirs, store_upload, is_audio_file
from .services.library import scan_default_library, scan_paths, compute_universal_track_id
from .services.spotiflac import queue_download

# Global variable to track last track update
last_track_update = 0
MANUAL_AUDIO_UPLOAD_SETTING_KEY = "manual_audio_upload_enabled"


def update_track_timestamp():
    """Update the global track update timestamp"""
    global last_track_update
    import time

    last_track_update = int(time.time() * 1000)  # Milliseconds since epoch


def _parse_bool_setting(value: str | None, default: bool) -> bool:
    if value is None:
        return default
    normalized = str(value).strip().lower()
    if normalized in {"1", "true", "yes", "on"}:
        return True
    if normalized in {"0", "false", "no", "off", ""}:
        return False
    return default


def _get_app_setting_bool(db: Session, key: str, default: bool) -> bool:
    row = db.get(AppSetting, key)
    if not row:
        return default
    return _parse_bool_setting(row.value, default=default)


def _set_app_setting_bool(db: Session, key: str, value: bool) -> bool:
    row = db.get(AppSetting, key)
    raw = "1" if value else "0"
    if not row:
        row = AppSetting(key=key, value=raw)
        db.add(row)
    else:
        row.value = raw
    db.commit()
    return value


def rate_limit(max_requests: int, window_seconds: int = 60):
    """
    Simple in-memory rate limiter.
    Limits requests based on client IP address.
    """
    def limiter(request: Request):
        # Get client IP (consider X-Forwarded-For if behind proxy)
        client_ip = request.client.host if request.client else "unknown"
        key = f"auth:{client_ip}"
        now = monotonic()
        window_start = now - window_seconds

        # Clean old entries
        store = _rate_limit_store[key]
        store[:] = [t for t in store if t > window_start]

        if len(store) >= max_requests:
            raise HTTPException(
                status_code=429,
                detail="Too many requests. Please try again later."
            )

        store.append(now)
        return True

    return limiter


def _delete_playlist_collage(playlist_id: str):
    """Delete cached collage for given playlist if it exists."""
    collages_dir = settings.artwork_dir / "collages"
    path = collages_dir / f"{playlist_id}.jpg"
    if path.exists():
        path.unlink()


def _issue_stream_token(user_hash: str, track_id: str) -> str:
    token = secrets.token_urlsafe(24)
    expires_at = monotonic() + _STREAM_TOKEN_TTL_SECONDS
    with _stream_token_lock:
        _stream_token_store[token] = (user_hash, track_id, expires_at)
    return token


def _validate_stream_token(token: str, track_id: str) -> str | None:
    now = monotonic()
    with _stream_token_lock:
        # Opportunistic cleanup for expired tokens.
        expired = [k for k, (_, _, exp) in _stream_token_store.items() if exp <= now]
        for key in expired:
            _stream_token_store.pop(key, None)

        row = _stream_token_store.get(token)
        if not row:
            return None
        user_hash, token_track_id, expires_at = row
        if expires_at <= now or token_track_id != track_id:
            _stream_token_store.pop(token, None)
            return None
        return user_hash


# Auto-migration: add queue_data column to users table if missing
def _migrate():
    from sqlalchemy import text
    from .db import engine
    with engine.begin() as conn:
        # Check if queue_data column exists
        try:
            conn.execute(text("SELECT queue_data FROM users LIMIT 1"))
        except Exception:
            # Column doesn't exist, add it
            conn.execute(text("ALTER TABLE users ADD COLUMN queue_data TEXT"))
            print("Migration: Added queue_data column to users table")
    # Create all tables (for new installations)
    Base.metadata.create_all(bind=engine)

_migrate()


app = FastAPI(title=settings.app_name)

static_dir = Path("/app/client")
if not static_dir.exists():
    static_dir = Path(__file__).resolve().parent.parent / "client"
if not static_dir.exists():
    static_dir = Path(__file__).resolve().parent.parent.parent / "client"
if static_dir.exists():
    app.mount(
        "/static", StaticFiles(directory=str(static_dir), html=True), name="static"
    )


def _is_within_dir(path: Path, root: Path) -> bool:
    try:
        path.resolve().relative_to(root.resolve())
        return True
    except Exception:
        return False


def _require_user(db: Session, x_auth_hash: str | None) -> User:
    if not x_auth_hash:
        raise HTTPException(status_code=401, detail="Not authenticated")
    user = _get_user(db, x_auth_hash)
    if not user:
        raise HTTPException(status_code=401, detail="Invalid auth hash")
    return user


# Configure CORS with secure defaults
_allowed_origins_raw = getattr(settings, 'allowed_origins', 'http://localhost:8000')
_allowed_origins = [origin.strip() for origin in _allowed_origins_raw.split(",") if origin.strip()]

# If no specific origins configured, default to localhost development server
if not _allowed_origins:
    _allowed_origins = ["http://localhost:8000"]

# Reject wildcard origins for security - explicit origins only
if "*" in _allowed_origins:
    logger.warning("Wildcard CORS origin detected in settings; using restrictive defaults instead")
    _allowed_origins = ["http://localhost:8000"]

# Define explicit allowed headers instead of wildcard
_allowed_headers = [
    "Content-Type",
    "Authorization",
    "x-auth-hash",
    "Origin",
    "Accept",
]

# Define explicit allowed methods
_allowed_methods = ["GET", "POST", "PUT", "DELETE", "OPTIONS"]

app.add_middleware(
    CORSMiddleware,
    allow_origins=_allowed_origins,
    allow_credentials=True,
    allow_methods=_allowed_methods,
    allow_headers=_allowed_headers,
)


@app.middleware("http")
async def add_track_update_timestamp(request: Request, call_next):
    global last_track_update
    try:
        response = await call_next(request)

        # Basic hardening headers for the UI/API responses.
        response.headers.setdefault("X-Content-Type-Options", "nosniff")
        response.headers.setdefault("X-Frame-Options", "DENY")
        response.headers.setdefault("Referrer-Policy", "same-origin")
        response.headers.setdefault(
            "Permissions-Policy",
            "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
        )

        # Add track update timestamp to responses for tracks endpoint
        if request.url.path.startswith("/tracks"):
            response.headers["X-Track-Update-Timestamp"] = str(last_track_update)
        if request.url.path.startswith("/auth/") or request.url.path.endswith("/stream-token"):
            # Prevent caches from storing sensitive bearer-like auth material.
            response.headers.setdefault("Cache-Control", "no-store")
            response.headers.setdefault("Pragma", "no-cache")

        return response
    except Exception:
        # If there was an exception in the endpoint, re-raise it without trying to set headers
        raise


@app.on_event("startup")
def _startup():
    ensure_dirs()
    # Ensure collages directory exists
    collages_dir = settings.artwork_dir / "collages"
    collages_dir.mkdir(parents=True, exist_ok=True)
    Base.metadata.create_all(bind=engine)
    if settings.database_url.startswith("sqlite"):
        with engine.connect() as conn:
            cols = [
                row[1]
                for row in conn.execute(text("PRAGMA table_info(tracks)")).fetchall()
            ]
            if "play_count" not in cols:
                conn.execute(
                    text("ALTER TABLE tracks ADD COLUMN play_count INTEGER DEFAULT 0")
                )
                conn.commit()

            if "user_hash" not in cols:
                conn.execute(
                    text("ALTER TABLE tracks ADD COLUMN user_hash VARCHAR(64)")
                )
                conn.commit()
            if "source_url" not in cols:
                conn.execute(
                    text("ALTER TABLE tracks ADD COLUMN source_url VARCHAR(2048)")
                )
                conn.commit()
            if "universal_track_id" not in cols:
                conn.execute(
                    text("ALTER TABLE tracks ADD COLUMN universal_track_id VARCHAR(64)")
                )
                conn.commit()
            conn.execute(
                text(
                    "CREATE INDEX IF NOT EXISTS idx_tracks_universal_track_id ON tracks(universal_track_id)"
                )
            )
            conn.commit()

            pcols = [
                row[1]
                for row in conn.execute(text("PRAGMA table_info(playlists)")).fetchall()
            ]
            if "user_hash" not in pcols:
                conn.execute(
                    text(
                        "ALTER TABLE playlists ADD COLUMN user_hash VARCHAR(64) DEFAULT ''"
                    )
                )
                conn.commit()
            if "is_liked" not in pcols:
                conn.execute(
                    text("ALTER TABLE playlists ADD COLUMN is_liked INTEGER DEFAULT 0")
                )
                conn.commit()
            if "pinned" not in pcols:
                conn.execute(
                    text("ALTER TABLE playlists ADD COLUMN pinned INTEGER DEFAULT 0")
                )
                conn.commit()

            # Ensure unique constraint/index on (user_hash, name) to prevent duplicate playlist names per user
            indexes = [
                row[1]
                for row in conn.execute(text("PRAGMA index_list(playlists)")).fetchall()
            ]
            if "idx_playlists_user_hash_name" not in indexes:
                try:
                    conn.execute(
                        text(
                            "CREATE UNIQUE INDEX IF NOT EXISTS idx_playlists_user_hash_name ON playlists(user_hash, name)"
                        )
                    )
                    conn.commit()
                except Exception as e:
                    # If index creation fails (e.g., duplicates already exist), log but continue
                    print(f"Warning: Could not create unique index on playlists: {e}")

            djcols = [
                row[1]
                for row in conn.execute(
                    text("PRAGMA table_info(download_jobs)")
                ).fetchall()
            ]
            if "user_hash" not in djcols:
                conn.execute(
                    text("ALTER TABLE download_jobs ADD COLUMN user_hash VARCHAR(64)")
                )
                conn.commit()

            # Fix embed_lyrics column: make it nullable if it exists and is NOT NULL
            # The ORM model doesn't use embed_lyrics anymore, but old DB schema may have it as NOT NULL
            try:
                # Check if embed_lyrics column exists and its notnull constraint
                pragma_result = conn.execute(
                    text("PRAGMA table_info(download_jobs)")
                ).fetchall()
                for col in pragma_result:
                    if col[1] == "embed_lyrics" and col[3] == 1:  # col[3]=1 means NOT NULL
                        # SQLite doesn't support ALTER COLUMN directly.
                        # The simplest fix: create new table without NOT NULL, copy data, swap.
                        # But for simplicity, we just make it nullable via table rebuild.
                        print("Detected download_jobs.embed_lyrics with NOT NULL constraint. Fixing schema...")
                        break
                # Note: For production, a proper migration would rebuild the table.
                # For now, we handle this by making the ORM model match or accepting NULLs.
                # Since SQLite can't easily modify constraints, we'll make embed_lyrics nullable by recreating table if needed.
                # Actually simpler: just ensure the column allows NULL by recreating the table if it has NOT NULL.
                # We'll check and if needed, rebuild the table without the NOT NULL constraint.
            except Exception as e:
                print(f"Warning: Could not check embed_lyrics column: {e}")

            # Create track_plays table if not exists
            try:
                conn.execute(
                    text(
                        "CREATE TABLE IF NOT EXISTS track_plays (id VARCHAR(36) PRIMARY KEY, track_id VARCHAR(36), played_at DATETIME, user_hash VARCHAR(64) NULL, FOREIGN KEY(track_id) REFERENCES tracks(id))"
                    )
                )
                conn.execute(
                    text(
                        "CREATE INDEX IF NOT EXISTS idx_track_plays_played_at ON track_plays(played_at)"
                    )
                )
                conn.execute(
                    text(
                        "CREATE INDEX IF NOT EXISTS idx_track_plays_track_id ON track_plays(track_id)"
                    )
                )
                conn.commit()
            except Exception:
                conn.rollback()

            ucols = [
                row[1]
                for row in conn.execute(text("PRAGMA table_info(users)")).fetchall()
            ]
            if "is_admin" not in ucols:
                conn.execute(
                    text("ALTER TABLE users ADD COLUMN is_admin INTEGER DEFAULT 0")
                )
                conn.commit()

            if "upload_enabled" not in ucols:
                conn.execute(
                    text(
                        "ALTER TABLE users ADD COLUMN upload_enabled INTEGER DEFAULT 1"
                    )
                )
                conn.commit()
                # Ensure all existing users have upload_enabled set to 1
                conn.execute(
                    text(
                        "UPDATE users SET upload_enabled = 1 WHERE upload_enabled IS NULL"
                    )
                )
                conn.commit()

            if "last_track_id" not in ucols:
                conn.execute(
                    text("ALTER TABLE users ADD COLUMN last_track_id VARCHAR(36)")
                )
                conn.commit()

            if "library_minimized" not in ucols:
                conn.execute(
                    text("ALTER TABLE users ADD COLUMN library_minimized INTEGER DEFAULT 0")
                )
                conn.commit()

            conn.execute(
                text(
                    "CREATE TABLE IF NOT EXISTS app_settings (key VARCHAR(128) PRIMARY KEY, value TEXT NOT NULL DEFAULT '', updated_at DATETIME DEFAULT CURRENT_TIMESTAMP)"
                )
            )
            conn.execute(
                text(
                    "INSERT OR IGNORE INTO app_settings(key, value, updated_at) VALUES (:key, '1', CURRENT_TIMESTAMP)"
                ),
                {"key": MANUAL_AUDIO_UPLOAD_SETTING_KEY},
            )
            conn.commit()

            # Clean up orphaned playlist_tracks that reference missing tracks or playlists
            with engine.connect() as conn2:
                conn2.execute(
                    text(
                        "DELETE FROM playlist_tracks WHERE track_id NOT IN (SELECT id FROM tracks)"
                    )
                )
                conn2.execute(
                    text(
                        "DELETE FROM playlist_tracks WHERE playlist_id NOT IN (SELECT id FROM playlists)"
                    )
                )
                conn2.commit()

            # Add indexes for common read paths in API endpoints.
            conn.execute(
                text(
                    "CREATE INDEX IF NOT EXISTS idx_playlist_tracks_playlist_pos ON playlist_tracks(playlist_id, position)"
                )
            )
            conn.execute(
                text(
                    "CREATE INDEX IF NOT EXISTS idx_tracks_created_at ON tracks(created_at DESC)"
                )
            )
            conn.execute(
                text(
                    "CREATE INDEX IF NOT EXISTS idx_tracks_user_hash_created_at ON tracks(user_hash, created_at DESC)"
                )
            )
            conn.execute(
                text(
                    "CREATE INDEX IF NOT EXISTS idx_playlists_user_hash_created_at ON playlists(user_hash, created_at DESC)"
                )
            )
            conn.commit()

    db = SessionLocal()
    try:
        users = db.execute(select(User)).scalars().all()
        for u in users:
            existing = db.execute(
                select(Playlist).where(
                    Playlist.user_hash == u.auth_hash, Playlist.is_liked == 1
                )
            ).scalar_one_or_none()
            if not existing:
                db.add(
                    Playlist(
                        name="Liked Songs",
                        description="",
                        user_hash=u.auth_hash,
                        is_liked=True,
                    )
                )
        db.commit()
    finally:
        db.close()

    # Backfill universal track IDs for old rows that don't have one yet.
    db = SessionLocal()
    try:
        tracks_missing_hash = db.execute(
            select(Track).where(Track.universal_track_id.is_(None))
        ).scalars().all()
        changed = False
        for track in tracks_missing_hash:
            if not track.file_path:
                continue
            path = Path(track.file_path)
            if not _is_within_dir(path, settings.music_dir):
                continue
            path = path.resolve()
            if not _is_within_dir(path, settings.music_dir) or not path.exists():
                continue
            try:
                track.universal_track_id = compute_universal_track_id(path)
                changed = True
            except Exception:
                logger.warning("Failed computing universal_track_id for track %s", track.id)
        if changed:
            db.commit()
    finally:
        db.close()

    if settings.admin_username and settings.admin_hash:
        db = SessionLocal()
        try:
            existing = db.execute(
                select(User).where(User.name == settings.admin_username)
            ).scalar_one_or_none()
            if not existing:
                admin = User(
                    name=settings.admin_username,
                    auth_hash=settings.admin_hash,
                    is_admin=True,
                )
                db.add(admin)
                db.commit()
                print(f"Admin user '{settings.admin_username}' created.")
            else:
                existing.auth_hash = settings.admin_hash
                existing.is_admin = True
                db.commit()
                print(f"Admin user '{settings.admin_username}' ensured.")
        finally:
            db.close()


def _get_user(db: Session, auth_hash: str) -> "User | None":
    user = db.execute(
        select(User).where(User.auth_hash == auth_hash)
    ).scalar_one_or_none()
    if user:
        now = datetime.utcnow()
        if not user.last_active_at or (now - user.last_active_at).total_seconds() > 60:
            user.last_active_at = now
            db.commit()
    return user


def _ensure_liked_songs(db: Session, user_hash: str) -> Playlist:
    playlist = db.execute(
        select(Playlist).where(Playlist.user_hash == user_hash, Playlist.is_liked == 1)
    ).scalar_one_or_none()
    if not playlist:
        playlist = Playlist(
            name="Liked Songs", description="", user_hash=user_hash, is_liked=True
        )
        db.add(playlist)
        db.commit()
        db.refresh(playlist)
    return playlist


@app.get("/health")
def health():
    return {"status": "ok"}


@app.get("/tracks/updates")
def get_track_updates(
    since: int = Query(0, ge=0),
    x_auth_hash: str | None = Header(None),
):
    """Get track updates since a given timestamp"""
    global last_track_update

    db = SessionLocal()
    try:
        _require_user(db, x_auth_hash)
    finally:
        db.close()

    # Return whether there are updates since the given timestamp
    has_updates = last_track_update > since

    return {"has_updates": has_updates, "timestamp": last_track_update}


@app.get("/", response_class=HTMLResponse)
def serve_index():
    if not static_dir.exists():
        return HTMLResponse("<h1>Openfy Server</h1>")
    index_path = static_dir / "index.html"
    if not index_path.exists():
        return HTMLResponse("<h1>Openfy UI missing</h1>")
    return HTMLResponse(index_path.read_text(encoding="utf-8"))


@app.post("/library/scan")
def scan_library(
    path: str | None = None,
    x_auth_hash: str | None = Header(None),
    db: Session = Depends(get_db),
):
    user = _require_user(db, x_auth_hash)
    if not user or not user.is_admin:
        raise HTTPException(status_code=403, detail="Admin access required")
    if path:
        target = Path(path)
        # Check BEFORE resolution to prevent symlink attacks
        if not _is_within_dir(target, settings.music_dir):
            raise HTTPException(status_code=403, detail="Path outside music directory")
        target = target.resolve()
        # Double-check after resolution
        if not _is_within_dir(target, settings.music_dir):
            raise HTTPException(status_code=403, detail="Path outside music directory")
        if not target.exists():
            raise HTTPException(status_code=404, detail="Path not found")
        return scan_paths(db, [target])
    return scan_default_library(db)


@app.get("/tracks", response_model=List[TrackOut])
def list_tracks(
    limit: int = Query(50, ge=1, le=200),
    offset: int = Query(0, ge=0),
    user_hash: str | None = Query(None),
    random: int = Query(0, ge=0, le=1),
    x_auth_hash: str | None = Header(None),
    db: Session = Depends(get_db),
):
    global last_track_update
    user = _require_user(db, x_auth_hash)

    if random:
        stmt = (
            select(Track)
            .options(selectinload(Track.artists))
            .offset(offset)
            .limit(limit)
            .order_by(func.random())
        )
    else:
        stmt = (
            select(Track)
            .options(selectinload(Track.artists))
            .order_by(Track.created_at.desc())
            .limit(limit)
            .offset(offset)
        )

    # If user_hash is provided, require auth and check authorization
    if user_hash:
        # Validate auth hash format (64 hex characters) to prevent injection
        if not re.match(r'^[0-9a-f]{64}$', user_hash):
            raise HTTPException(status_code=400, detail="Invalid user hash format")
        # Admin can query any user's tracks; regular users can only query their own
        if not user.is_admin and user.auth_hash != user_hash:
            raise HTTPException(
                status_code=403, detail="Not authorized to view these tracks"
            )
        stmt = stmt.where(Track.user_hash == user_hash)

    tracks = db.execute(stmt).scalars().all()
    return tracks


# Add most-played endpoint before the generic track-by-id endpoint to avoid route conflicts
@app.get("/tracks/most-played", response_model=List[TrackOut])
def most_played(
    limit: int = Query(10, ge=1, le=100),
    x_auth_hash: str | None = Header(None),
    db: Session = Depends(get_db),
):
    _require_user(db, x_auth_hash)
    # Remove the 24-hour restriction to show all-time most played tracks
    stmt = (
        select(Track, func.count(TrackPlay.id).label("play_ct"))
        .options(selectinload(Track.artists))
        .outerjoin(TrackPlay, Track.id == TrackPlay.track_id)
        .group_by(Track.id)
        .order_by(func.count(TrackPlay.id).desc())
        .limit(limit)
    )
    results = db.execute(stmt).all()
    tracks = [row[0] for row in results]
    return tracks


@app.get("/tracks/batch", response_model=list[TrackOut])
def get_tracks_batch(
    ids: str = Query(..., description="Comma-separated track IDs"),
    x_auth_hash: str | None = Header(None),
    db: Session = Depends(get_db),
):
    """Get multiple tracks by IDs (comma-separated) in the order requested"""
    _require_user(db, x_auth_hash)
    id_list = [tid.strip() for tid in ids.split(",") if tid.strip()]
    if not id_list:
        return []
    stmt = (
        select(Track)
        .options(selectinload(Track.artists), selectinload(Track.album))
        .where(Track.id.in_(id_list))
    )
    tracks = db.execute(stmt).scalars().all()
    # Preserve order: map by id and reorder according to id_list
    track_map = {str(t.id): t for t in tracks}
    ordered = [track_map[tid] for tid in id_list if tid in track_map]
    return ordered


@app.get("/tracks/{track_id}", response_model=TrackOut)
def get_track(
    track_id: str,
    x_auth_hash: str | None = Header(None),
    db: Session = Depends(get_db),
):
    user = _require_user(db, x_auth_hash)
    stmt = (
        select(Track)
        .options(selectinload(Track.artists), selectinload(Track.album))
        .where(Track.id == track_id)
    )
    track = db.execute(stmt).scalar_one_or_none()
    if not track:
        raise HTTPException(status_code=404, detail="Track not found")
    return track


@app.get("/tracks/{track_id}/artwork")
def track_artwork(track_id: str, db: Session = Depends(get_db)):
    # Validate track_id as UUID
    import uuid

    try:
        uuid.UUID(track_id)
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid track ID format")
    track = db.get(Track, track_id)
    if not track or not track.album:
        raise HTTPException(status_code=404, detail="Artwork not found")
    if not track.album.artwork_path:
        raise HTTPException(status_code=404, detail="Artwork not found")
    # Double-check path is within artwork directory BEFORE and AFTER resolution
    # to prevent symlink-based attacks
    path = Path(track.album.artwork_path)
    if not _is_within_dir(path, settings.artwork_dir):
        raise HTTPException(status_code=403, detail="Access denied")
    path = path.resolve()
    if not _is_within_dir(path, settings.artwork_dir):
        raise HTTPException(status_code=403, detail="Access denied")
    if not path.exists():
        raise HTTPException(status_code=404, detail="Artwork not found")
    return FileResponse(path)


@app.get("/tracks/{track_id}/stream")
def stream_track(
    track_id: str,
    request: Request,
    x_auth_hash: str | None = Header(None),
    db: Session = Depends(get_db),
):
    # Validate track_id as UUID
    import uuid

    try:
        uuid.UUID(track_id)
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid track ID format")
    track = db.get(Track, track_id)
    if not track:
        raise HTTPException(status_code=404, detail="Track not found")
    user: User | None = None
    if x_auth_hash:
        user = _require_user(db, x_auth_hash)
    else:
        token = request.query_params.get("token")
        if not token:
            raise HTTPException(status_code=401, detail="Not authenticated")
        user_hash = _validate_stream_token(token, track_id)
        if not user_hash:
            raise HTTPException(status_code=401, detail="Invalid or expired stream token")
        user = _get_user(db, user_hash)
        if not user:
            raise HTTPException(status_code=401, detail="Invalid stream user")

    # Double-check path is within music directory BEFORE and AFTER resolution
    # to prevent symlink-based path traversal attacks
    path = Path(track.file_path)
    if not _is_within_dir(path, settings.music_dir):
        raise HTTPException(status_code=403, detail="Access denied")
    path = path.resolve()
    if not _is_within_dir(path, settings.music_dir):
        raise HTTPException(status_code=403, detail="Access denied")
    if not path.exists():
        raise HTTPException(status_code=404, detail="File not found")

    range_header = request.headers.get("range")
    if not range_header:
        try:
            track.play_count = (track.play_count or 0) + 1
            db.add(TrackPlay(track_id=track_id, user_hash=user.auth_hash))
            # Update user's last played track
            user.last_track_id = track_id
            
            # Sync queue index if track is in the current queue
            if user.queue_data:
                try:
                    import json
                    qdata = json.loads(user.queue_data)
                    tids = qdata.get("track_ids", [])
                    curr_idx = qdata.get("current_index", 0)
                    # If current index track doesn't match streamed track, find it in queue
                    if 0 <= curr_idx < len(tids) and tids[curr_idx] != track_id:
                        if track_id in tids:
                            qdata["current_index"] = tids.index(track_id)
                            user.queue_data = json.dumps(qdata)
                    elif curr_idx >= len(tids) and track_id in tids:
                        qdata["current_index"] = tids.index(track_id)
                        user.queue_data = json.dumps(qdata)
                except Exception:
                    pass # Best effort

            db.commit()  # Single atomic commit
        except Exception:
            db.rollback()
            raise
        return FileResponse(path, media_type=track.mime_type or "audio/mpeg")

    size = path.stat().st_size
    try:
        bytes_unit, byte_range = range_header.split("=", 1)
        if bytes_unit.strip().lower() != "bytes":
            raise ValueError("Unsupported range unit")
        start_str, end_str = byte_range.split("-", 1)
        start = int(start_str) if start_str else 0
        end = int(end_str) if end_str else size - 1
    except Exception:
        return Response(status_code=416, headers={"Content-Range": f"bytes */{size}"})

    if start < 0 or end < 0 or start > end or start >= size:
        return Response(status_code=416, headers={"Content-Range": f"bytes */{size}"})

    end = min(end, size - 1)

    if start == 0:
        try:
            track.play_count = (track.play_count or 0) + 1
            db.add(TrackPlay(track_id=track_id, user_hash=user.auth_hash))
            # Update user's last played track
            user.last_track_id = track_id

            # Sync queue index if track is in the current queue
            if user.queue_data:
                try:
                    import json
                    qdata = json.loads(user.queue_data)
                    tids = qdata.get("track_ids", [])
                    curr_idx = qdata.get("current_index", 0)
                    if 0 <= curr_idx < len(tids) and tids[curr_idx] != track_id:
                        if track_id in tids:
                            qdata["current_index"] = tids.index(track_id)
                            user.queue_data = json.dumps(qdata)
                    elif curr_idx >= len(tids) and track_id in tids:
                        qdata["current_index"] = tids.index(track_id)
                        user.queue_data = json.dumps(qdata)
                except Exception:
                    pass # Best effort

            db.commit()  # Single atomic commit
        except Exception:
            db.rollback()
            raise

    if start == 0 and end == size - 1:
        return FileResponse(path, media_type=track.mime_type or "audio/mpeg")

    def iterfile():
        with path.open("rb") as file:
            file.seek(start)
            remaining = end - start + 1
            chunk_size = 1024 * 512
            while remaining > 0:
                chunk = file.read(min(chunk_size, remaining))
                if not chunk:
                    break
                remaining -= len(chunk)
                yield chunk

    headers = {
        "Content-Range": f"bytes {start}-{end}/{size}",
        "Accept-Ranges": "bytes",
        "Content-Length": str(end - start + 1),
    }
    return StreamingResponse(
        iterfile(),
        status_code=206,
        headers=headers,
        media_type=track.mime_type or "audio/mpeg",
    )


@app.get("/tracks/{track_id}/stream-token")
def create_stream_token(
    track_id: str,
    x_auth_hash: str | None = Header(None),
    db: Session = Depends(get_db),
):
    import uuid

    try:
        uuid.UUID(track_id)
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid track ID format")

    user = _require_user(db, x_auth_hash)
    track = db.get(Track, track_id)
    if not track:
        raise HTTPException(status_code=404, detail="Track not found")
    token = _issue_stream_token(user.auth_hash, track_id)
    return {"token": token, "expires_in": _STREAM_TOKEN_TTL_SECONDS}


@app.post("/tracks/upload", response_model=TrackOut)
def upload_track_file(
    file: UploadFile = File(...),
    x_auth_hash: str | None = Header(None),
    db: Session = Depends(get_db),
):
    user = _require_user(db, x_auth_hash)
    if not user.is_admin and not user.upload_enabled:
        raise HTTPException(
            status_code=403, detail="Uploads are disabled for your account"
        )
    manual_upload_enabled = _get_app_setting_bool(
        db, MANUAL_AUDIO_UPLOAD_SETTING_KEY, default=False
    )
    if not manual_upload_enabled:
        raise HTTPException(
            status_code=403,
            detail="Manual audio file uploads are currently disabled by admin",
        )

    original_name = file.filename or ""
    suffix = Path(original_name).suffix.lower()
    if not suffix or not is_audio_file(Path(f"track{suffix}")):
        raise HTTPException(
            status_code=400,
            detail="Unsupported audio format. Use mp3/flac/wav/m4a/ogg/opus.",
        )

    tmp_dir = settings.data_dir / "tmp_uploads"
    tmp_dir.mkdir(parents=True, exist_ok=True)
    tmp_file = tempfile.NamedTemporaryFile(
        delete=False, suffix=suffix, dir=str(tmp_dir)
    )
    tmp_path = Path(tmp_file.name)
    tmp_file.close()

    try:
        with tmp_path.open("wb") as out:
            shutil.copyfileobj(file.file, out)
        final_path = store_upload(tmp_path, settings.music_dir)
        scan_paths(db, [final_path], user_hash=user.auth_hash)
        track = db.execute(
            select(Track)
            .options(selectinload(Track.artists), selectinload(Track.album))
            .where(Track.file_path == str(final_path))
        ).scalar_one_or_none()
        if not track:
            raise HTTPException(status_code=500, detail="Uploaded track was not indexed")
        return track
    finally:
        try:
            file.file.close()
        except Exception:
            pass
        if tmp_path.exists():
            try:
                tmp_path.unlink()
            except Exception:
                pass


@app.get("/tracks/by-universal/{universal_track_id}", response_model=TrackOut)
def get_track_by_universal_id(
    universal_track_id: str,
    x_auth_hash: str | None = Header(None),
    db: Session = Depends(get_db),
):
    _require_user(db, x_auth_hash)
    universal_track_id = universal_track_id.lower()
    if not re.match(r"^[0-9a-f]{64}$", universal_track_id):
        raise HTTPException(status_code=400, detail="Invalid universal track ID format")
    track = db.execute(
        select(Track)
        .options(selectinload(Track.artists), selectinload(Track.album))
        .where(Track.universal_track_id == universal_track_id)
    ).scalar_one_or_none()
    if not track:
        raise HTTPException(status_code=404, detail="Track not found")
    return track


@app.get("/artists", response_model=List[ArtistOut])
def list_artists(x_auth_hash: str | None = Header(None), db: Session = Depends(get_db)):
    _require_user(db, x_auth_hash)
    artists = db.execute(select(Artist).order_by(Artist.name.asc())).scalars().all()
    return artists


@app.get("/albums", response_model=List[AlbumOut])
def list_albums(x_auth_hash: str | None = Header(None), db: Session = Depends(get_db)):
    _require_user(db, x_auth_hash)
    albums = db.execute(select(Album).order_by(Album.title.asc())).scalars().all()
    return albums


@app.get("/search", response_model=List[TrackOut])
def search(
    q: str = Query(..., min_length=1, max_length=255, description="Search query"),
    limit: int = Query(50, ge=1, le=200),
    x_auth_hash: str | None = Header(None),
    db: Session = Depends(get_db),
):
    _require_user(db, x_auth_hash)
    pattern = f"%{q}%"
    stmt = (
        select(Track)
        .options(selectinload(Track.artists))
        .join(Album, isouter=True)  # keep for album title search
        .where(
            (Track.title.ilike(pattern))
            | (Track.artists.any(Artist.name.ilike(pattern)))
            | (Album.title.ilike(pattern))
        )
    )
    return db.execute(stmt.limit(limit)).scalars().all()


@app.get("/playlists", response_model=List[PlaylistOut])
def list_playlists(
    x_auth_hash: str | None = Header(None),
    db: Session = Depends(get_db),
):
    user = _require_user(db, x_auth_hash)
    stmt = select(Playlist).order_by(
        Playlist.is_liked.desc(), Playlist.pinned.desc(), Playlist.created_at.desc()
    )
    stmt = stmt.where(Playlist.user_hash == user.auth_hash)
    return db.execute(stmt).scalars().all()


@app.post("/playlists", response_model=PlaylistOut)
def create_playlist(
    payload: PlaylistCreate,
    x_auth_hash: str | None = Header(None),
    db: Session = Depends(get_db),
):
    if not x_auth_hash:
        raise HTTPException(status_code=401, detail="Not authenticated")
    user = _get_user(db, x_auth_hash)
    if not user:
        raise HTTPException(status_code=401, detail="Invalid auth hash")

    # Determine base name: use provided name or default to "My Playlist"
    base_name = (payload.name or "").strip()
    if not base_name:
        base_name = "My Playlist"

    final_name = base_name
    counter = 2
    max_retries = 1000  # Safety limit

    for attempt in range(max_retries):
        try:
            playlist = Playlist(
                name=final_name,
                description=payload.description,
                user_hash=user.auth_hash,
            )
            db.add(playlist)
            db.commit()
            db.refresh(playlist)
            return playlist
        except IntegrityError:
            db.rollback()
            # Name collision, try next incremented name
            final_name = f"{base_name} #{counter}"
            counter += 1

    raise HTTPException(
        status_code=409, detail="Could not generate unique playlist name"
    )


@app.get("/playlists/{playlist_id}", response_model=PlaylistOut)
def get_playlist(
    playlist_id: str,
    x_auth_hash: str | None = Header(None),
    db: Session = Depends(get_db),
):
    if not x_auth_hash:
        raise HTTPException(status_code=401, detail="Not authenticated")
    user = _get_user(db, x_auth_hash)
    if not user:
        raise HTTPException(status_code=401, detail="Invalid auth hash")
    stmt = (
        select(Playlist)
        .options(selectinload(Playlist.user))
        .where(Playlist.id == playlist_id)
    )
    playlist = db.execute(stmt).scalar_one_or_none()
    if not playlist:
        raise HTTPException(status_code=404, detail="Playlist not found")
    if playlist.user_hash != user.auth_hash and not user.is_admin:
        raise HTTPException(status_code=403, detail="Not your playlist")
    return playlist


@app.get("/playlists/{playlist_id}/cover")
def get_playlist_cover(
    playlist_id: str,
    x_auth_hash: str | None = Header(None),
    db: Session = Depends(get_db),
):
    """
    Return a cached 500x500 JPEG collage of a playlist's first 4 tracks.
    Requires authentication and playlist ownership (or admin).
    """
    import uuid

    try:
        uuid.UUID(playlist_id)
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid playlist ID format")

    user = _require_user(db, x_auth_hash)
    playlist = db.get(Playlist, playlist_id)
    if not playlist:
        raise HTTPException(status_code=404, detail="Playlist not found")
    if playlist.user_hash != user.auth_hash and not user.is_admin:
        raise HTTPException(status_code=403, detail="Not your playlist")
    if playlist.is_liked:
        raise HTTPException(status_code=404, detail="Liked Songs has no collage")

    collages_dir = settings.artwork_dir / "collages"
    collages_dir.mkdir(parents=True, exist_ok=True)
    out_path = collages_dir / f"{playlist_id}.jpg"
    if out_path.exists():
        return FileResponse(out_path, media_type="image/jpeg")

    # Get first 4 tracks (ordered by position)
    tracks_stmt = (
        select(PlaylistTrack)
        .options(
            selectinload(PlaylistTrack.track).selectinload(Track.album),
        )
        .where(PlaylistTrack.playlist_id == playlist_id)
        .order_by(PlaylistTrack.position.asc())
        .limit(4)
    )
    playlist_tracks = db.execute(tracks_stmt).scalars().all()

    if len(playlist_tracks) < 4:
        raise HTTPException(status_code=404, detail="Playlist has fewer than 4 tracks")

    # Collage dimensions: 2x2 grid of 250px tiles = 500x500 total
    tile_size = 250
    collage_size = tile_size * 2
    collage = Image.new("RGB", (collage_size, collage_size), (40, 40, 40))  # #282828 fallback

    positions = [(0, 0), (tile_size, 0), (0, tile_size), (tile_size, tile_size)]

    for pt, pos in zip(playlist_tracks, positions):
        track = pt.track
        album = track.album if track else None
        artwork_path = getattr(album, "artwork_path", None) if album else None

        if artwork_path:
            path = Path(artwork_path)
            # Validate path is within artwork directory both before and after resolution
            if not _is_within_dir(path, settings.artwork_dir):
                continue  # Skip invalid/outside paths
            path = path.resolve()
            if not _is_within_dir(path, settings.artwork_dir):
                continue  # Skip invalid/outside paths
            if path.exists():
                try:
                    with Image.open(path) as opened:
                        img = opened.convert("RGB")
                        img = img.resize((tile_size, tile_size), Image.Resampling.LANCZOS)
                        collage.paste(img, pos)
                    continue
                except Exception:
                    pass  # fall through to gray block
        # Missing artwork — leave gray (already the background)

    collage.save(out_path, format="JPEG", quality=85)
    return FileResponse(out_path, media_type="image/jpeg")


@app.put("/playlists/{playlist_id}", response_model=PlaylistOut)
def update_playlist(
    playlist_id: str,
    payload: PlaylistUpdate,
    x_auth_hash: str | None = Header(None),
    db: Session = Depends(get_db),
):
    if not x_auth_hash:
        raise HTTPException(status_code=401, detail="Not authenticated")
    playlist = db.get(Playlist, playlist_id)
    if not playlist:
        raise HTTPException(status_code=404, detail="Playlist not found")
    user = _get_user(db, x_auth_hash)
    if not user:
        raise HTTPException(status_code=401, detail="Invalid auth hash")
    if playlist.user_hash != user.auth_hash and not user.is_admin:
        raise HTTPException(status_code=403, detail="Not your playlist")
    # Disallow renaming the Liked Songs playlist
    if playlist.is_liked and payload.name is not None:
        raise HTTPException(
            status_code=403, detail="Cannot rename Liked Songs playlist"
        )
    # Allow name change for non-liked playlists
    if not playlist.is_liked and payload.name is not None:
        # Check for duplicate name among user's playlists (excluding current)
        existing = db.execute(
            select(Playlist).where(
                Playlist.user_hash == user.auth_hash,
                Playlist.name == payload.name,
                Playlist.id != playlist_id,
            )
        ).scalar_one_or_none()
        if existing:
            raise HTTPException(status_code=409, detail="Playlist name already exists")
        playlist.name = payload.name
    # Allow pinned changes for any playlist (including Liked Songs)
    if payload.pinned is not None:
        playlist.pinned = 1 if payload.pinned else 0
    if payload.shuffle is not None:
        playlist.shuffle = 1 if payload.shuffle else 0
    db.commit()
    db.refresh(playlist)
    return playlist


@app.get("/playlists/{playlist_id}/tracks", response_model=List[PlaylistTrackOut])
def list_playlist_tracks(
    playlist_id: str,
    x_auth_hash: str | None = Header(None),
    db: Session = Depends(get_db),
):
    if not x_auth_hash:
        raise HTTPException(status_code=401, detail="Not authenticated")
    user = _get_user(db, x_auth_hash)
    if not user:
        raise HTTPException(status_code=401, detail="Invalid auth hash")
    playlist = db.get(Playlist, playlist_id)
    if not playlist:
        raise HTTPException(status_code=404, detail="Playlist not found")
    if playlist.user_hash != user.auth_hash and not user.is_admin:
        raise HTTPException(status_code=403, detail="Not your playlist")
    stmt = (
        select(PlaylistTrack)
        .options(
            selectinload(PlaylistTrack.track).selectinload(Track.artists),
            selectinload(PlaylistTrack.track).selectinload(Track.album),
        )
        .where(PlaylistTrack.playlist_id == playlist_id)
        .order_by(PlaylistTrack.position.asc())
    )
    return db.execute(stmt).scalars().all()


@app.post("/playlists/{playlist_id}/tracks", response_model=PlaylistTrackOut)
def add_track_to_playlist(
    playlist_id: str,
    track_id: str,
    x_auth_hash: str | None = Header(None),
    db: Session = Depends(get_db),
):
    import sys
    import traceback

    def log_error(msg: str):
        print(f"[add_track_to_playlist ERROR] {msg}", file=sys.stderr)
        traceback.print_exc(file=sys.stderr)

    try:
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
        if playlist.is_liked:
            raise HTTPException(
                status_code=403, detail="Cannot manually add to Liked Songs"
            )

        # Check if track already in playlist
        existing = db.execute(
            select(PlaylistTrack)
            .options(
                selectinload(PlaylistTrack.track).selectinload(Track.artists),
                selectinload(PlaylistTrack.track).selectinload(Track.album),
            )
            .where(
                PlaylistTrack.playlist_id == playlist_id,
                PlaylistTrack.track_id == track_id,
            )
        ).scalar_one_or_none()
        if existing:
            log_error(f"Track {track_id} already in playlist {playlist_id}, returning existing")
            return existing

        # Load track with needed relationships
        track = db.execute(
            select(Track).options(
                selectinload(Track.artists),
                selectinload(Track.album),
            ).where(Track.id == track_id)
        ).scalar_one_or_none()
        if not track:
            raise HTTPException(status_code=404, detail=f"Track {track_id} not found")

        # Calculate next position
        max_position = db.execute(
            select(func.max(PlaylistTrack.position))
            .where(PlaylistTrack.playlist_id == playlist_id)
        ).scalar_one_or_none()
        next_position = (max_position or 0) + 1

        # Create the association using the loaded track
        link = PlaylistTrack(
            playlist_id=playlist_id,
            track_id=track_id,
            position=next_position
        )
        # Attach the track to the link before adding to session
        # This ensures relationship is available for serialization
        link.track = track
        db.add(link)

        try:
            db.commit()
            # Invalidate collage cache since track order/artwork may affect it
            _delete_playlist_collage(playlist_id)
            # Re-query the link with full eager loading to guarantee serializable state
            result = db.execute(
                select(PlaylistTrack)
                .options(
                    selectinload(PlaylistTrack.track).selectinload(Track.artists),
                    selectinload(PlaylistTrack.track).selectinload(Track.album),
                )
                .where(
                    PlaylistTrack.playlist_id == playlist_id,
                    PlaylistTrack.track_id == track_id,
                )
            ).scalar_one_or_none()
            if result is None:
                raise HTTPException(status_code=500, detail="Failed to retrieve created playlist track")
            return result
        except IntegrityError as ie:
            db.rollback()
            log_error(f"IntegrityError on add: {ie}")
            existing = db.execute(
                select(PlaylistTrack)
                .options(
                    selectinload(PlaylistTrack.track).selectinload(Track.artists),
                    selectinload(PlaylistTrack.track).selectinload(Track.album),
                )
                .where(
                    PlaylistTrack.playlist_id == playlist_id,
                    PlaylistTrack.track_id == track_id,
                )
            ).scalar_one_or_none()
            if existing:
                log_error(f"Race condition: track already exists, returning it")
                return existing
            raise HTTPException(status_code=409, detail="Database conflict when adding track")
        except Exception as e:
            db.rollback()
            log_error(f"Commit/refresh failed: {e}")
            logger.error(f"add_track_to_playlist error: {e}", exc_info=True)
            raise HTTPException(status_code=500, detail="Internal server error")
    except HTTPException:
        raise
    except Exception as e:
        log_error(f"Unexpected error in add_track_to_playlist: {e}")
        logger.error(f"add_track_to_playlist unexpected error: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail="Internal server error")


@app.get("/tracks/{track_id}/playlists", response_model=List[PlaylistOut])
def list_track_playlists(
    track_id: str,
    x_auth_hash: str | None = Header(None),
    db: Session = Depends(get_db),
):
    """List all regular (non-Liked) playlists owned by the user that contain the given track."""
    if not x_auth_hash:
        raise HTTPException(status_code=401, detail="Not authenticated")
    user = _get_user(db, x_auth_hash)
    if not user:
        raise HTTPException(status_code=401, detail="Invalid auth hash")

    stmt = (
        select(Playlist)
        .join(PlaylistTrack, Playlist.id == PlaylistTrack.playlist_id)
        .where(
            Playlist.user_hash == user.auth_hash,
            Playlist.is_liked == 0,
            PlaylistTrack.track_id == track_id,
        )
        .order_by(Playlist.created_at.desc())
    )
    return db.execute(stmt).scalars().all()


@app.delete("/playlists/{playlist_id}/tracks/{track_id}")
def remove_track_from_playlist(
    playlist_id: str,
    track_id: str,
    x_auth_hash: str | None = Header(None),
    db: Session = Depends(get_db),
):
    """Remove a track from a regular playlist. Idempotent: returns success even if track was not present."""
    if not x_auth_hash:
        raise HTTPException(status_code=401, detail="Not authenticated")
    user = _get_user(db, x_auth_hash)
    if not user:
        raise HTTPException(status_code=401, detail="Invalid auth hash")

    playlist = db.get(Playlist, playlist_id)
    if not playlist:
        raise HTTPException(status_code=404, detail="Playlist not found")

    if playlist.user_hash != user.auth_hash and not user.is_admin:
        raise HTTPException(status_code=403, detail="Not your playlist")

    if playlist.is_liked:
        raise HTTPException(
            status_code=403, detail="Use /liked/{track_id} endpoint for Liked Songs"
        )

    # Delete the association
    result = db.execute(
        delete(PlaylistTrack).where(
            PlaylistTrack.playlist_id == playlist_id,
            PlaylistTrack.track_id == track_id,
        )
    )
    if result.rowcount > 0:
        db.commit()
        # Invalidate collage cache since track removal may drop below 4 tracks
        _delete_playlist_collage(playlist_id)
        return {
            "status": "removed",
            "playlist_id": playlist_id,
            "track_id": track_id,
            "was_present": True,
        }
    else:
        # Idempotent: no row existed, still success
        return {
            "status": "removed",
            "playlist_id": playlist_id,
            "track_id": track_id,
            "was_present": False,
        }


@app.delete("/playlists/{playlist_id}")
def delete_playlist(
    playlist_id: str,
    x_auth_hash: str | None = Header(None),
    db: Session = Depends(get_db),
):
    """Delete a playlist (owner only, admins cannot delete others' playlists)"""
    if not x_auth_hash:
        raise HTTPException(status_code=401, detail="Not authenticated")
    user = _get_user(db, x_auth_hash)
    if not user:
        raise HTTPException(status_code=401, detail="Invalid auth hash")

    playlist = db.get(Playlist, playlist_id)
    if not playlist:
        raise HTTPException(status_code=404, detail="Playlist not found")
    if playlist.is_liked:
        raise HTTPException(status_code=403, detail="Cannot delete Liked Songs")
    if playlist.user_hash != user.auth_hash and not user.is_admin:
        raise HTTPException(status_code=403, detail="Not your playlist")

    # Delete collage file before removing playlist
    _delete_playlist_collage(playlist_id)
    db.delete(playlist)
    db.commit()
    return {"status": "deleted"}


@app.post("/downloads", response_model=DownloadJobOut)
def create_download(
    payload: DownloadRequest,
    x_auth_hash: str | None = Header(None),
    db: Session = Depends(get_db),
):
    if not x_auth_hash:
        raise HTTPException(status_code=401, detail="Not authenticated")
    user = _get_user(db, x_auth_hash)
    if not user:
        raise HTTPException(status_code=401, detail="Invalid auth hash")
    if not user.is_admin and not user.upload_enabled:
        raise HTTPException(
            status_code=403, detail="Uploads are disabled for your account"
        )
    from .services.spotiflac import queue_download

    return queue_download(db, payload.query, payload.source or "auto", user.auth_hash)


@app.get("/downloads/{job_id}", response_model=DownloadJobOut)
def get_download_status(
    job_id: str,
    x_auth_hash: str | None = Header(None),
    db: Session = Depends(get_db),
):
    if not x_auth_hash:
        raise HTTPException(status_code=401, detail="Not authenticated")
    user = _get_user(db, x_auth_hash)
    if not user:
        raise HTTPException(status_code=401, detail="Invalid auth hash")
    job = db.get(DownloadJob, job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Download job not found")
    if job.user_hash != x_auth_hash and not user.is_admin:
        raise HTTPException(status_code=403, detail="Not your download job")
    return job


@app.post("/liked/{track_id}")
def toggle_liked(
    track_id: str, x_auth_hash: str | None = Header(None), db: Session = Depends(get_db)
):
    if not x_auth_hash:
        raise HTTPException(status_code=401, detail="Not authenticated")
    user = _get_user(db, x_auth_hash)
    if not user:
        raise HTTPException(status_code=401, detail="Invalid auth hash")
    track = db.get(Track, track_id)
    if not track:
        raise HTTPException(status_code=404, detail="Track not found")

    liked = _ensure_liked_songs(db, user.auth_hash)
    existing = db.execute(
        select(PlaylistTrack).where(
            PlaylistTrack.playlist_id == liked.id,
            PlaylistTrack.track_id == track_id,
        )
    ).scalar_one_or_none()
    if existing:
        db.delete(existing)
        db.commit()
        return {"status": "unliked"}
    else:
        position = db.execute(
            select(PlaylistTrack.position)
            .where(PlaylistTrack.playlist_id == liked.id)
            .order_by(PlaylistTrack.position.desc())
        ).scalar_one_or_none()
        link = PlaylistTrack(
            playlist_id=liked.id, track_id=track_id, position=(position or 0) + 1
        )
        db.add(link)
        db.commit()
        return {"status": "liked"}


@app.get("/liked/{track_id}")
def is_track_liked(
    track_id: str, x_auth_hash: str | None = Header(None), db: Session = Depends(get_db)
):
    if not x_auth_hash:
        raise HTTPException(status_code=401, detail="Not authenticated")
    user = _get_user(db, x_auth_hash)
    if not user:
        raise HTTPException(status_code=401, detail="Invalid auth hash")
    liked = _ensure_liked_songs(db, user.auth_hash)
    existing = db.execute(
        select(PlaylistTrack).where(
            PlaylistTrack.playlist_id == liked.id,
            PlaylistTrack.track_id == track_id,
        )
    ).scalar_one_or_none()
    return {"liked": existing is not None}


@app.post("/auth/signup", response_model=UserOut)
def signup(
    payload: UserSignup,
    db: Session = Depends(get_db),
    _: bool = Depends(rate_limit(max_requests=10, window_seconds=300)),  # 10 per 5 minutes per IP
):
    existing = db.execute(
        select(User).where(User.name == payload.name)
    ).scalar_one_or_none()
    if existing:
        raise HTTPException(status_code=409, detail="Username taken")
    auth_hash = secrets.token_hex(32)
    user = User(name=payload.name, auth_hash=auth_hash)
    db.add(user)
    db.commit()
    db.refresh(user)
    _ensure_liked_songs(db, user.auth_hash)
    return user


@app.post("/auth/signin", response_model=UserOut)
def signin(
    payload: UserSignin,
    db: Session = Depends(get_db),
    _: bool = Depends(rate_limit(max_requests=15, window_seconds=300)),  # 15 per 5 minutes per IP
):
    user = _get_user(db, payload.auth_hash)
    if not user:
        raise HTTPException(status_code=401, detail="Invalid auth hash")
    return user


@app.get("/auth/me", response_model=UserOutPublic)
def auth_me(x_auth_hash: str | None = Header(None), db: Session = Depends(get_db)):
    if not x_auth_hash:
        raise HTTPException(status_code=401, detail="Not authenticated")
    user = _get_user(db, x_auth_hash)
    if not user:
        raise HTTPException(status_code=401, detail="Invalid auth hash")
    return user


@app.get("/system/settings", response_model=SystemSettingsOut)
def get_system_settings(
    x_auth_hash: str | None = Header(None),
    db: Session = Depends(get_db),
):
    _require_user(db, x_auth_hash)
    return {
        "manual_audio_upload_enabled": _get_app_setting_bool(
            db, MANUAL_AUDIO_UPLOAD_SETTING_KEY, default=True
        )
    }


@app.put("/user/upload-preference")
def update_upload_preference(
    payload: UserUploadPreferenceUpdate,
    x_auth_hash: str | None = Header(None),
    db: Session = Depends(get_db),
):
    """Update user's upload enabled preference"""
    if not x_auth_hash:
        raise HTTPException(status_code=401, detail="Not authenticated")
    user = _get_user(db, x_auth_hash)
    if not user:
        raise HTTPException(status_code=401, detail="Invalid auth hash")

    user.upload_enabled = 1 if payload.upload_enabled else 0
    db.commit()
    db.refresh(user)
    return {"status": "updated", "upload_enabled": bool(user.upload_enabled)}


@app.get("/user/last-track", response_model=TrackOut | None)
def get_last_track(
    x_auth_hash: str | None = Header(None),
    db: Session = Depends(get_db),
):
    """Get the user's last played track"""
    user = _require_user(db, x_auth_hash)
    if not user.last_track_id:
        return None
    track = db.execute(
        select(Track)
        .options(selectinload(Track.artists), selectinload(Track.album))
        .where(Track.id == user.last_track_id)
    ).scalar_one_or_none()
    return track


@app.put("/user/last-track")
def update_last_track(
    track_id: str = Query(..., description="Track ID to set as last played"),
    x_auth_hash: str | None = Header(None),
    db: Session = Depends(get_db),
):
    """Update the user's last played track"""
    user = _require_user(db, x_auth_hash)
    track = db.get(Track, track_id)
    if not track:
        raise HTTPException(status_code=404, detail="Track not found")
    user.last_track_id = track_id
    db.commit()
    return {"status": "updated", "track_id": track_id}


@app.get("/user/library-state")
def get_library_state(
    x_auth_hash: str | None = Header(None),
    db: Session = Depends(get_db),
):
    """Get the user's library sidebar state (minimized/expanded)"""
    user = _require_user(db, x_auth_hash)
    return {"library_minimized": bool(user.library_minimized)}


@app.put("/user/library-state")
def update_library_state(
    payload: UserLibraryStateUpdate,
    x_auth_hash: str | None = Header(None),
    db: Session = Depends(get_db),
):
    """Update the user's library sidebar state"""
    if not x_auth_hash:
        raise HTTPException(status_code=401, detail="Not authenticated")
    user = _get_user(db, x_auth_hash)
    if not user:
        raise HTTPException(status_code=401, detail="Invalid auth hash")

    user.library_minimized = 1 if payload.library_minimized else 0
    db.commit()
    db.refresh(user)
    return {"status": "updated", "library_minimized": bool(user.library_minimized)}


@app.get("/user/player-state")
def get_user_player_state(
    x_auth_hash: str | None = Header(None),
    db: Session = Depends(get_db),
):
    """Get the user's saved player state (shuffle, repeat)"""
    user = _require_user(db, x_auth_hash)
    return {
        "shuffle": bool(user.shuffle),
        "repeat_state": user.repeat_state or "off"
    }


@app.put("/user/player-state")
def update_user_player_state(
    payload: UserPlayerStateUpdate,
    x_auth_hash: str | None = Header(None),
    db: Session = Depends(get_db),
):
    """Update the user's saved player state"""
    user = _require_user(db, x_auth_hash)
    if payload.shuffle is not None:
        user.shuffle = 1 if payload.shuffle else 0
    if payload.repeat_state is not None:
        user.repeat_state = payload.repeat_state
    db.commit()
    return {"status": "updated"}


@app.get("/user/queue")
def get_user_queue(
    x_auth_hash: str | None = Header(None),
    db: Session = Depends(get_db),
):
    """Get the user's saved queue state"""
    if not x_auth_hash:
        raise HTTPException(status_code=401, detail="Not authenticated")
    user = _get_user(db, x_auth_hash)
    if not user:
        raise HTTPException(status_code=401, detail="Invalid auth hash")

    if not user.queue_data:
        return {"queue": [], "current_index": 0}

    import json
    try:
        data = json.loads(user.queue_data)
        return {
            "queue": data.get("track_ids", []),
            "current_index": data.get("current_index", 0)
        }
    except (json.JSONDecodeError, KeyError):
        return {"queue": [], "current_index": 0}


@app.put("/user/queue")
def update_user_queue(
    payload: UserQueueUpdate,
    x_auth_hash: str | None = Header(None),
    db: Session = Depends(get_db),
):
    """Save the user's current queue state"""
    if not x_auth_hash:
        raise HTTPException(status_code=401, detail="Not authenticated")
    user = _get_user(db, x_auth_hash)
    if not user:
        raise HTTPException(status_code=401, detail="Invalid auth hash")

    import json
    user.queue_data = json.dumps({
        "track_ids": payload.track_ids,
        "current_index": payload.current_index
    })
    db.commit()
    return {"status": "updated"}


# Admin endpoints
@app.get("/admin/stats")
def get_admin_stats(
    x_auth_hash: str | None = Header(None),
    db: Session = Depends(get_db),
):
    """Get server statistics (admin only)"""
    admin_user = _require_user(db, x_auth_hash)
    if not admin_user.is_admin:
        raise HTTPException(status_code=403, detail="Admin access required")
    
    total_users = db.scalar(select(func.count(User.id)))
    
    # Online users: active in last 5 minutes
    five_mins_ago = datetime.utcnow() - timedelta(minutes=5)
    online_users = db.scalar(select(func.count(User.id)).where(User.last_active_at >= five_mins_ago))
    
    # Storage used: sum of all track files
    music_dir = settings.music_dir
    total_bytes = 0
    if music_dir.exists():
        # Iterate over all files in music directory
        for f in music_dir.rglob('*'):
            if f.is_file():
                try:
                    total_bytes += f.stat().st_size
                except Exception:
                    continue
                
    return {
        "total_users": total_users,
        "online_users": online_users,
        "total_storage_bytes": total_bytes
    }


@app.get("/admin/settings", response_model=SystemSettingsOut)
def get_admin_settings(
    x_auth_hash: str | None = Header(None),
    db: Session = Depends(get_db),
):
    """Get system-wide settings (admin only)"""
    admin_user = _require_user(db, x_auth_hash)
    if not admin_user.is_admin:
        raise HTTPException(status_code=403, detail="Admin access required")
    
    manual_enabled = _get_app_setting_bool(db, MANUAL_AUDIO_UPLOAD_SETTING_KEY, default=True)
    timezone_row = db.get(AppSetting, "timezone")
    return {
        "manual_audio_upload_enabled": manual_enabled,
        "timezone": timezone_row.value if timezone_row else "UTC"
    }


@app.put("/admin/settings", response_model=SystemSettingsOut)
def update_admin_settings(
    payload: SystemSettingsUpdate,
    x_auth_hash: str | None = Header(None),
    db: Session = Depends(get_db),
):
    """Update system-wide settings (admin only)"""
    admin_user = _require_user(db, x_auth_hash)
    if not admin_user.is_admin:
        raise HTTPException(status_code=403, detail="Admin access required")
    
    res = {}
    if payload.manual_audio_upload_enabled is not None:
        res["manual_audio_upload_enabled"] = _set_app_setting_bool(
            db, MANUAL_AUDIO_UPLOAD_SETTING_KEY, payload.manual_audio_upload_enabled
        )
    else:
        res["manual_audio_upload_enabled"] = _get_app_setting_bool(
            db, MANUAL_AUDIO_UPLOAD_SETTING_KEY, default=True
        )
        
    if payload.timezone is not None:
        tz_row = db.get(AppSetting, "timezone")
        if not tz_row:
            tz_row = AppSetting(key="timezone", value=payload.timezone)
            db.add(tz_row)
        else:
            tz_row.value = payload.timezone
        db.commit()
        res["timezone"] = payload.timezone
    else:
        tz_row = db.get(AppSetting, "timezone")
        res["timezone"] = tz_row.value if tz_row else "UTC"
        
    return res


@app.get("/admin/users")
def list_all_users(
    q: str | None = Query(None),
    x_auth_hash: str | None = Header(None),
    db: Session = Depends(get_db),
):
    """List all users (admin only)"""
    if not x_auth_hash:
        raise HTTPException(status_code=401, detail="Not authenticated")
    admin_user = _get_user(db, x_auth_hash)
    if not admin_user or not admin_user.is_admin:
        raise HTTPException(status_code=403, detail="Admin access required")

    # Subquery to get track counts per user
    track_counts_subq = (
        select(Track.user_hash, func.count(Track.id).label("track_count"))
        .group_by(Track.user_hash)
        .subquery()
    )

    # Main query with join to track counts subquery
    stmt = (
        select(
            User,
            func.coalesce(track_counts_subq.c.track_count, 0).label("uploaded_tracks_count")
        )
        .outerjoin(track_counts_subq, User.auth_hash == track_counts_subq.c.user_hash)
        .order_by(User.created_at.desc())
        .limit(50)
    )
    if q:
        stmt = stmt.where(User.name.ilike(f"%{q}%"))

    results = db.execute(stmt).all()
    result = []
    for user, uploaded_tracks_count in results:
        user_data = {
            "id": user.id,
            "name": user.name,
            "is_admin": user.is_admin,
            "upload_enabled": bool(user.upload_enabled),
            "created_at": user.created_at,
            "uploaded_tracks_count": uploaded_tracks_count,
        }
        result.append(user_data)
    return result


@app.delete("/admin/users/{user_id}")
def delete_user(
    user_id: str,
    x_auth_hash: str | None = Header(None),
    db: Session = Depends(get_db),
):
    """Delete a user and their data (admin only, cannot delete self)"""
    if not x_auth_hash:
        raise HTTPException(status_code=401, detail="Not authenticated")
    admin_user = _get_user(db, x_auth_hash)
    if not admin_user or not admin_user.is_admin:
        raise HTTPException(status_code=403, detail="Admin access required")

    # Prevent self-deletion
    if user_id == admin_user.id:
        raise HTTPException(status_code=400, detail="Cannot delete yourself")

    user = db.get(User, user_id)
    if not user:
        raise HTTPException(status_code=404, detail="User not found")
    user_hash = user.auth_hash

    # Delete user's playlists first (cascade may not work for all DBs)
    db.execute(delete(Playlist).where(Playlist.user_hash == user_hash))
    # Delete user's tracks from database (files remain)
    # Note: We don't delete actual files to prevent accidental data loss
    db.execute(
        text("UPDATE tracks SET user_hash = NULL WHERE user_hash = :hash"),
        {"hash": user_hash},
    )

    db.delete(user)
    db.commit()
    return {"status": "deleted", "user": user.name}


@app.get("/admin/tracks")
def list_all_tracks(
    q: str | None = Query(None),
    x_auth_hash: str | None = Header(None),
    db: Session = Depends(get_db),
):
    """List all tracks with user info (admin only)"""
    if not x_auth_hash:
        raise HTTPException(status_code=401, detail="Not authenticated")
    admin_user = _get_user(db, x_auth_hash)
    if not admin_user or not admin_user.is_admin:
        raise HTTPException(status_code=403, detail="Admin access required")

    stmt = select(Track, User).join(User, Track.user_hash == User.auth_hash, isouter=True).options(selectinload(Track.artists))
    if q:
        stmt = stmt.join(Album, isouter=True).where(
            (Track.title.ilike(f"%{q}%"))
            | (Track.artists.any(Artist.name.ilike(f"%{q}%")))
            | (Album.title.ilike(f"%{q}%"))
        )
    stmt = stmt.order_by(Track.created_at.desc()).limit(50)

    results = db.execute(stmt).all()
    result = []
    for track, user in results:
        # Get primary artist name (first in artists list or fallback)
        artist_name = "Unknown"
        if track.artists and len(track.artists) > 0:
            artist_name = track.artists[0].name
        elif track.artist:
            artist_name = track.artist.name
        result.append(
            {
                "id": track.id,
                "universal_track_id": track.universal_track_id,
                "title": track.title,
                "artist_name": artist_name,
                "user_name": user.name if user else "Unclaimed",
                # user_hash omitted for privacy
                "duration": track.duration,
                "play_count": track.play_count,
            }
        )
    return result


@app.delete("/admin/tracks/{track_id}")
def delete_track(
    track_id: str, x_auth_hash: str | None = Header(None), db: Session = Depends(get_db)
):
    """Delete a track (admin only)"""
    if not x_auth_hash:
        raise HTTPException(status_code=401, detail="Not authenticated")
    admin_user = _get_user(db, x_auth_hash)
    if not admin_user or not admin_user.is_admin:
        raise HTTPException(status_code=403, detail="Admin access required")

    track = db.get(Track, track_id)
    if not track:
        raise HTTPException(status_code=404, detail="Track not found")

    # Store track info before deletion
    track_title = track.title
    file_path = track.file_path

    # Validate path before deletion, but never fail DB deletion if file path is untrusted.
    p = Path(file_path)
    safe_delete_target: Path | None = None
    if _is_within_dir(p, settings.music_dir):
        resolved = p.resolve()
        if _is_within_dir(resolved, settings.music_dir):
            safe_delete_target = resolved
    else:
        logger.warning("Skipping file delete for track %s outside music dir: %s", track_id, file_path)

    # Delete from database (cascades to playlist_tracks)
    db.delete(track)
    db.commit()

    # Best-effort delete from disk for validated local paths.
    if safe_delete_target and safe_delete_target.exists():
        try:
            safe_delete_target.unlink()
        except Exception:
            logger.warning("Failed to delete file for track %s at %s", track_id, safe_delete_target)

    return {"status": "deleted", "track": track_title}
