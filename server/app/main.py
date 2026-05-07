import secrets
import tempfile
from pathlib import Path
import json
import time
import re
from datetime import datetime, timedelta, timezone
from typing import List, Optional, Dict, Any
from collections import defaultdict
from time import monotonic
from threading import Lock
from contextlib import asynccontextmanager
import io
from urllib.parse import urlparse
from urllib.request import Request as UrlRequest, urlopen
from PIL import Image

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
from sqlalchemy.orm import Session, selectinload, joinedload
from sqlalchemy import select, text, func
from sqlalchemy import delete
from sqlalchemy.exc import IntegrityError

import logging

from .db import Base, engine, get_db, SessionLocal
from .models import (
    Track,
    Artist,
    Album,
    Playlist,
    PlaylistTrack,
    FollowedPlaylist,
    FollowedAlbum,
    DownloadJob,
    User,
    TrackPlay,
    AppSetting,
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
    SpotifyImportRequest,
)
from .settings import settings
from .services.storage import ensure_dirs, store_upload, store_avatar, is_audio_file
from .services.library import scan_default_library, scan_paths, compute_universal_track_id
from .services.spotiflac import queue_download

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

# Global variable to track last track update
last_track_update = 0
MANUAL_AUDIO_UPLOAD_SETTING_KEY = "manual_audio_upload_enabled"
PLAYLIST_IMPORT_SETTING_KEY = "playlist_import_enabled"


def update_track_timestamp():
    """Update the global track update timestamp"""
    global last_track_update

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


def _delete_playlist_external_cover(playlist_id: str):
    """Delete cached proxied external cover for given playlist if it exists."""
    external_dir = settings.artwork_dir / "playlist_external"
    path = external_dir / f"{playlist_id}.jpg"
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





@asynccontextmanager
async def lifespan(app: FastAPI):
    _startup()
    yield

app = FastAPI(title=settings.app_name, lifespan=lifespan)

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

            if "is_public" not in pcols:
                conn.execute(
                    text("ALTER TABLE playlists ADD COLUMN is_public INTEGER DEFAULT 0")
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

            # Add image_url column to playlists if it doesn't exist
            pcols = [
                row[1]
                for row in conn.execute(text("PRAGMA table_info(playlists)")).fetchall()
            ]
            if "image_url" not in pcols:
                conn.execute(
                    text("ALTER TABLE playlists ADD COLUMN image_url VARCHAR(512)")
                )
                conn.commit()

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

            if "queue_data" not in ucols:
                conn.execute(
                    text("ALTER TABLE users ADD COLUMN queue_data TEXT")
                )
                conn.commit()

            if "avatar_path" not in ucols:
                conn.execute(
                    text("ALTER TABLE users ADD COLUMN avatar_path VARCHAR(512)")
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

            # Restored indexes and migration logic
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

            # Migration: Add type and owner_name to playlists table if they don't exist
            existing_columns = [
                row[1]
                for row in conn.execute(text("PRAGMA table_info(playlists)")).fetchall()
            ]
            if "type" not in existing_columns:
                conn.execute(text("ALTER TABLE playlists ADD COLUMN type VARCHAR(20) DEFAULT 'playlist'"))
            if "owner_name" not in existing_columns:
                conn.execute(text("ALTER TABLE playlists ADD COLUMN owner_name VARCHAR(255)"))

            # Create followed_playlists table if it doesn't exist
            for row in conn.execute(text("PRAGMA table_info(followed_playlists)")).fetchall():
                table_exists = True
                break
            else:
                table_exists = False
            if not table_exists:
                conn.execute(text("""
                    CREATE TABLE followed_playlists (
                        id VARCHAR(36) PRIMARY KEY,
                        user_hash VARCHAR(64) NOT NULL,
                        playlist_id VARCHAR(36) NOT NULL,
                        followed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                        FOREIGN KEY (user_hash) REFERENCES users(auth_hash) ON DELETE CASCADE,
                        FOREIGN KEY (playlist_id) REFERENCES playlists(id) ON DELETE CASCADE,
                        UNIQUE(user_hash, playlist_id)
                    )
                """))
                conn.execute(text("CREATE INDEX IF NOT EXISTS idx_followed_playlists_user ON followed_playlists(user_hash)"))
                conn.execute(text("CREATE INDEX IF NOT EXISTS idx_followed_playlists_playlist ON followed_playlists(playlist_id)"))

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
        # Use naive UTC to stay compatible with SQLite's offset-naive datetime storage
        now = datetime.now(timezone.utc).replace(tzinfo=None)
        last = user.last_active_at
        if last is not None and hasattr(last, 'tzinfo') and last.tzinfo is not None:
            last = last.replace(tzinfo=None)
        if not last or (now - last).total_seconds() > 60:
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


def _refresh_30_day_play_counts(db: Session) -> None:
    """Refresh the play_count_30_days for all tracks based on track_plays from last 30 days."""
    from datetime import timedelta
    from sqlalchemy import update

    cutoff_date = datetime.now(timezone.utc) - timedelta(days=30)

    # Get play counts grouped by track_id for last 30 days
    stmt = (
        select(TrackPlay.track_id, func.count(TrackPlay.id))
        .where(TrackPlay.played_at >= cutoff_date)
        .group_by(TrackPlay.track_id)
    )
    results = db.execute(stmt).all()

    # First, reset all 30-day counts to 0
    db.execute(
        update(Track).values(play_count_30_days=0)
    )

    # Then update with actual counts
    for track_id, count in results:
        db.execute(
            update(Track).where(Track.id == track_id).values(play_count_30_days=count)
        )

    db.commit()


@app.get("/tracks/refresh-30day-counts")
def refresh_30_day_play_counts(
    x_auth_hash: str | None = Header(None),
    db: Session = Depends(get_db),
):
    """Refresh play counts for the last 30 days (admin only)"""
    user = _require_user(db, x_auth_hash)
    if not user.is_admin:
        raise HTTPException(status_code=403, detail="Admin only")
    _refresh_30_day_play_counts(db)
    return {"status": "success", "message": "30-day play counts refreshed"}


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
    _require_user(db, x_auth_hash)
    stmt = (
        select(Track)
        .options(selectinload(Track.artists), selectinload(Track.album))
        .where(Track.id == track_id)
    )
    track = db.execute(stmt).scalar_one_or_none()
    if not track:
        raise HTTPException(status_code=404, detail="Track not found")
    return track


@app.get("/tracks/by-spotify-id/{spotify_id}", response_model=TrackOut)
def get_track_by_spotify_id(
    spotify_id: str,
    x_auth_hash: str | None = Header(None),
    db: Session = Depends(get_db),
):
    _require_user(db, x_auth_hash)
    if not re.match(r"^[A-Za-z0-9]+$", spotify_id):
        raise HTTPException(status_code=400, detail="Invalid Spotify track ID format")

    track = db.execute(
        select(Track)
        .options(selectinload(Track.artists))
        .where(Track.source_id == f"spotify:{spotify_id}")
        .order_by(Track.created_at.desc())
    ).scalars().first()

    if not track:
        raise HTTPException(status_code=404, detail="Track not found")
    return track


@app.get("/tracks/{track_id}/artwork")
def track_artwork(
    track_id: str,
    db: Session = Depends(get_db),
):
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

            # Don't modify queue_data - keep queue order as saved by user
            # (Removed automatic queue reordering that was causing issues)

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

            # Don't modify queue_data - keep queue order as saved by user
            # (Removed automatic queue reordering that was causing issues)

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
        max_upload_bytes = max(1, settings.max_upload_size_mb) * 1024 * 1024
        total_written = 0
        with tmp_path.open("wb") as out:
            while True:
                chunk = file.file.read(1024 * 1024)
                if not chunk:
                    break
                total_written += len(chunk)
                if total_written > max_upload_bytes:
                    raise HTTPException(
                        status_code=413,
                        detail=f"File too large. Maximum allowed size is {settings.max_upload_size_mb}MB.",
                    )
                out.write(chunk)
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
        except Exception:  # nosec B110 – best-effort file handle cleanup
            pass
        if tmp_path.exists():
            try:
                tmp_path.unlink()
            except Exception:  # nosec B110 – best-effort temp file cleanup
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


@app.get("/artists/{artist_id}", response_model=ArtistOut)
def get_artist(artist_id: str, x_auth_hash: str | None = Header(None), db: Session = Depends(get_db)):
    from app.models import Artist, Track
    from sqlalchemy import select, or_
    from sqlalchemy.orm import selectinload

    _require_user(db, x_auth_hash)

    # Get artist and include both primary tracks and featured tracks (many-to-many)
    artist = db.execute(
        select(Artist)
        .options(selectinload(Artist.tracks).selectinload(Track.album))
        .options(selectinload(Artist.tracks).joinedload(Track.artist))
        .options(selectinload(Artist.tracks).selectinload(Track.artists))
        .options(selectinload(Artist.many_tracks).selectinload(Track.album))
        .options(selectinload(Artist.many_tracks).joinedload(Track.artist))
        .options(selectinload(Artist.many_tracks).selectinload(Track.artists))
        .options(selectinload(Artist.albums))
        .where(Artist.id == artist_id)
    ).scalar_one_or_none()
    if not artist:
        raise HTTPException(status_code=404, detail="Artist not found")

    # Combine primary tracks and featured tracks (remove duplicates)
    all_track_ids = set()
    combined_tracks = []
    for track in artist.tracks:
        if track.id not in all_track_ids:
            all_track_ids.add(track.id)
            combined_tracks.append(track)
    for track in artist.many_tracks:
        if track.id not in all_track_ids:
            all_track_ids.add(track.id)
            combined_tracks.append(track)

    # Replace tracks with combined list
    artist.tracks = combined_tracks

    return artist


@app.post("/albums/{album_id}/follow")
def follow_album(
    album_id: str,
    x_auth_hash: str | None = Header(None),
    db: Session = Depends(get_db),
):
    """Follow an album by creating a local playlist for it."""
    if not x_auth_hash:
        raise HTTPException(status_code=401, detail="Not authenticated")
    user = _get_user(db, x_auth_hash)
    if not user:
        raise HTTPException(status_code=401, detail="Invalid auth hash")

    album = db.get(Album, album_id)
    if not album:
        raise HTTPException(status_code=404, detail="Album not found")

    # Check if already followed (as a playlist)
    existing = db.execute(
        select(Playlist).where(
            Playlist.user_hash == user.auth_hash,
            Playlist.name == album.title,
            Playlist.type == "album",
        )
    ).scalar_one_or_none()

    if existing:
        return {"playlist_id": existing.id, "already_followed": True}

    # Create playlist for album
    import uuid

    playlist_id = str(uuid.uuid4())
    playlist = Playlist(
        id=playlist_id,
        name=album.title,
        user_hash=user.auth_hash,
        type="album",
        is_public=True,
    )
    db.add(playlist)

    # Add all tracks of this album to the playlist
    tracks = db.execute(select(Track).where(Track.album_id == album.id)).scalars().all()
    for track in tracks:
        pt = PlaylistTrack(playlist_id=playlist_id, track_id=track.id)
        db.add(pt)

    db.commit()
    return {"playlist_id": playlist_id, "success": True}


@app.get("/artists/{artist_id}/refresh-image")
def refresh_artist_image(
    artist_id: str,
    x_auth_hash: str | None = Header(None),
    db: Session = Depends(get_db),
):
    """Background task to refresh artist image from Spotify."""
    from app.models import Artist

    user = _require_user(db, x_auth_hash)

    artist = db.get(Artist, artist_id)
    if not artist:
        raise HTTPException(status_code=404, detail="Artist not found")

    # Only allow if user has tracks by this artist
    has_access = (
        any(t.user_hash == user.auth_hash for t in artist.tracks) or
        any(t.user_hash == user.auth_hash for t in artist.many_tracks) or
        user.is_admin
    )
    if not has_access:
        raise HTTPException(status_code=403, detail="No access to this artist")

    # Run in background - don't block the response
    import threading
    from .db import SessionLocal
    artist_id_for_thread = artist.id
    def background_fetch():
        new_db = SessionLocal()
        try:
            from app.models import Artist
            bg_artist = new_db.get(Artist, artist_id_for_thread)
            if bg_artist:
                _auto_fetch_artist_image(new_db, bg_artist)
                new_db.commit()
        except Exception as e:
            print(f"Background artist image fetch failed: {e}")
        finally:
            new_db.close()

    threading.Thread(target=background_fetch, daemon=True).start()

    return {"status": "triggered"}


def _auto_fetch_artist_image(db: Session, artist: Artist) -> None:
    """Automatically fetch artist image from Spotify using existing track URLs."""
    from app.models import Track
    from sqlalchemy import select
    from app.services.artist_service import get_artist_info_from_spotify

    artist_info = None

    # 1. Try using artist's own Spotify URL if present
    if artist.spotify_url:
        try:
            artist_info = get_artist_info_from_spotify(artist.spotify_url)
        except Exception as e:
            print(f"Direct artist info fetch failed for {artist.name}: {e}")

    # 2. Fallback to track-based discovery if needed
    if not artist_info:
        # Look for a Spotify track URL in the artist's tracks
        tracks = db.execute(
            select(Track).where(Track.artist_id == artist.id).limit(10)
        ).scalars().all()

        spotify_track_url = None
        for track in tracks:
            if track.source_url and "open.spotify.com" in track.source_url and "/track/" in track.source_url:
                spotify_track_url = track.source_url
                break

        if spotify_track_url:
            try:
                artist_info = get_artist_info_from_spotify(spotify_track_url)
            except Exception as e:
                print(f"Track-based artist info fetch failed for {artist.name}: {e}")

    if not artist_info:
        return

    try:
        artist_info = get_artist_info_from_spotify(spotify_track_url)
        if not artist_info:
            return

        # Get the largest available image
        if artist_info.get("images"):
            images = sorted(artist_info["images"], key=lambda x: x.get("width", 0), reverse=True)
            if images and images[0].get("url"):
                artist.image_url = images[0]["url"]

        # Store Spotify artist URL if available
        if not artist.spotify_url and artist_info.get("external_urls", {}).get("spotify"):
            artist.spotify_url = artist_info["external_urls"]["spotify"]

        if artist.image_url or artist.spotify_url:
            db.commit()
    except Exception as e:
        print(f"[DEBUG] Auto-fetch artist image failed: {e}")


@app.post("/artists/{artist_id}/fetch-spotify-image")
def fetch_spotify_artist_image(
    artist_id: str,
    x_auth_hash: str | None = Header(None),
    db: Session = Depends(get_db)
):
    """Fetch artist image from Spotify and update the artist record."""
    from app.models import Artist, Track
    from sqlalchemy import select
    from app.services.artist_service import get_artist_from_spotify_url

    _require_admin(db, x_auth_hash)

    artist = db.get(Artist, artist_id)
    if not artist:
        raise HTTPException(status_code=404, detail="Artist not found")

    # Try to find a Spotify URL from any of the artist's tracks
    spotify_url = artist.spotify_url
    if not spotify_url:
        # Look through tracks to find a Spotify URL
        tracks = db.execute(
            select(Track).where(Track.artist_id == artist_id).limit(10)
        ).scalars().all()
        for track in tracks:
            if track.source_url and "open.spotify.com" in track.source_url:
                spotify_url = track.source_url
                break

    if not spotify_url:
        raise HTTPException(
            status_code=400,
            detail="No Spotify URL found for this artist. Add a track from Spotify first."
        )

    # Fetch artist info from Spotify using our service
    artist_info = get_artist_from_spotify_url(spotify_url)
    if not artist_info:
        raise HTTPException(status_code=500, detail="Failed to fetch artist from Spotify")

    # Get the largest available image
    image_url = artist_info.get("largest_image")
    if not image_url and artist_info.get("images"):
        images = sorted(artist_info["images"], key=lambda x: x.get("width", 0), reverse=True)
        if images and images[0].get("url"):
            image_url = images[0]["url"]

    if not image_url:
        raise HTTPException(status_code=404, detail="No artist image found on Spotify")

    # Update the artist record
    artist.image_url = image_url
    # Try to get artist URL from external_urls
    external_urls = artist_info.get("external_urls", {})
    if not artist.spotify_url and external_urls.get("spotify"):
        artist.spotify_url = external_urls["spotify"]
    db.commit()
    db.refresh(artist)

    return {"image_url": artist.image_url, "spotify_url": artist.spotify_url, "name": artist_info.get("name")}

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


@app.get("/spotify-search")
def spotify_search(
    q: str = Query(..., min_length=1, max_length=255, description="Search query"),
    limit: int = Query(10, ge=1, le=20),
    x_auth_hash: str | None = Header(None),
    db: Session = Depends(get_db),
):
    """Search Spotify for tracks using web search."""
    _require_user(db, x_auth_hash)
    # Import here to avoid circular imports
    try:
        from spotify_search import search_spotify
        results = search_spotify(q, limit)
        return results
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Spotify search failed: {str(e)}")


@app.get("/playlists", response_model=List[PlaylistOut])
def list_playlists(
    x_auth_hash: str | None = Header(None),
    db: Session = Depends(get_db),
):
    user = None
    if x_auth_hash:
        user = _get_user(db, x_auth_hash)

    # Get user's own playlists
    own_playlists = []
    if user:
        stmt = (
            select(Playlist)
            .options(joinedload(Playlist.user))
            .where(Playlist.user_hash == user.auth_hash)
            .order_by(Playlist.created_at.desc())
        )
        own_playlists = db.execute(stmt).scalars().all()

    # Get followed playlists
    followed_playlists = []
    if user:
        followed_stmt = (
            select(Playlist)
            .options(joinedload(Playlist.user))
            .join(FollowedPlaylist, FollowedPlaylist.playlist_id == Playlist.id)
            .where(FollowedPlaylist.user_hash == user.auth_hash)
            .order_by(FollowedPlaylist.followed_at.desc())
        )
        followed_playlists = db.execute(followed_stmt).scalars().all()

    # Get followed albums
    followed_albums = []
    if user:
        albums_stmt = (
            select(Album)
            .options(joinedload(Album.artist))
            .join(FollowedAlbum, FollowedAlbum.album_id == Album.id)
            .where(FollowedAlbum.user_hash == user.auth_hash)
            .order_by(FollowedAlbum.followed_at.desc())
        )
        followed_albums = db.execute(albums_stmt).scalars().all()

    # Combine and mark is_owner and is_followed
    result = []
    for pl in own_playlists:
        pl_dict = pl.__dict__.copy()
        pl_dict["is_owner"] = True
        # For albums, we consider them "followed" in the UI sense even if owned
        pl_dict["is_followed"] = pl.type == "album"
        # Get track count
        track_count = db.scalar(
            select(func.count(PlaylistTrack.track_id)).where(PlaylistTrack.playlist_id == pl.id)
        ) or 0
        pl_dict["track_count"] = track_count
        result.append(pl_dict)

    for pl in followed_playlists:
        pl_dict = pl.__dict__.copy()
        pl_dict["is_owner"] = False
        pl_dict["is_followed"] = True
        # Get track count
        track_count = db.scalar(
            select(func.count(PlaylistTrack.track_id)).where(PlaylistTrack.playlist_id == pl.id)
        ) or 0
        pl_dict["track_count"] = track_count
        result.append(pl_dict)

    # Add followed albums converted to playlist-like dicts
    for alb in followed_albums:
        alb_dict = {
            "id": alb.id,
            "name": alb.title,
            "type": "album",
            "is_public": True,
            "is_owner": False,
            "is_followed": True,
            "owner_name": alb.artist.name if alb.artist else "Unknown Artist",
            "created_at": alb.created_at,
            "track_count": db.scalar(select(func.count(Track.id)).where(Track.album_id == alb.id)) or 0
        }
        result.append(alb_dict)

    return result


@app.get("/albums/{album_id}")
def get_album(
    album_id: str,
    x_auth_hash: str | None = Header(None),
    db: Session = Depends(get_db),
):
    """Get an album by its ID. Returns it in a format compatible with the playlist view."""
    user = None
    if x_auth_hash:
        user = _get_user(db, x_auth_hash)
    album = db.execute(
        select(Album)
        .options(joinedload(Album.artist))
        .where(Album.id == album_id)
    ).scalar_one_or_none()

    if not album:
        # Fallback for legacy "album playlists"
        pl = db.get(Playlist, album_id)
        if pl and pl.type == "album":
            return get_playlist(album_id, x_auth_hash, db)
        raise HTTPException(status_code=404, detail="Album not found")

    # Get tracks
    tracks_stmt = (
        select(Track)
        .options(selectinload(Track.artists), joinedload(Track.artist))
        .where(Track.album_id == album_id)
        .order_by(Track.track_no, Track.id)
    )
    tracks = db.execute(tracks_stmt).scalars().all()

    # Check if user already follows this album
    is_followed = False
    if user:
        followed = db.execute(
            select(FollowedAlbum).where(
                FollowedAlbum.user_hash == user.auth_hash,
                FollowedAlbum.album_id == album_id,
            )
        ).scalar_one_or_none()
        is_followed = followed is not None

    # Construct a response that matches the Playlist structure for the UI
    return {
        "id": album.id,
        "name": album.title,
        "description": f"Album by {album.artist.name if album.artist else 'Unknown'}",
        "type": "album",
        "is_public": True,
        "is_followed": is_followed,
        "is_owner": False,
        "is_liked": False,
        "owner_name": album.artist.name if album.artist else "Unknown Artist",
        "tracks": tracks,
        "track_count": len(tracks),
    }


@app.get("/albums/{album_id}/artwork")
def get_album_artwork(
    album_id: str,
    x_auth_hash: str | None = Header(None),
    db: Session = Depends(get_db)
):
    """Get album artwork."""
    album = db.get(Album, album_id)
    if not album:
        # Fallback for legacy "album playlists"
        pl = db.get(Playlist, album_id)
        if pl and pl.type == "album":
            return get_playlist_cover(playlist_id=album_id, x_auth_hash=x_auth_hash, db=db)
        
    if not album or not album.artwork_path:
        # Fallback to first track's artwork
        track = db.execute(select(Track).where(Track.album_id == album_id)).scalar()
        if track and track.artwork_path:
            return FileResponse(track.artwork_path)
        raise HTTPException(status_code=404, detail="Artwork not found")
    
    if os.path.exists(album.artwork_path):
        return FileResponse(album.artwork_path)
    raise HTTPException(status_code=404, detail="Artwork file not found")


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
                type=payload.type or "playlist",
                owner_name=payload.owner_name,
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
    user = None
    if x_auth_hash:
        user = _get_user(db, x_auth_hash)

    stmt = (
        select(Playlist)
        .options(selectinload(Playlist.user))
        .where(Playlist.id == playlist_id)
    )
    playlist = db.execute(stmt).scalar_one_or_none()
    if not playlist:
        raise HTTPException(status_code=404, detail="Playlist not found")

    # Check access: owner or admin can always access
    # Public playlists can be accessed without auth
    # Liked Songs is always private
    is_owner = user and playlist.user_hash == user.auth_hash
    is_admin = user and user.is_admin
    is_public = playlist.is_public and not playlist.is_liked

    # Check if user is following this playlist
    is_followed = False
    if user:
        followed = db.execute(
            select(FollowedPlaylist).where(
                FollowedPlaylist.user_hash == user.auth_hash,
                FollowedPlaylist.playlist_id == playlist_id,
            )
        ).scalar_one_or_none()
        is_followed = followed is not None

    if not is_owner and not is_admin and not is_public:
        # Return limited data for private playlists to non-owners
        # This allows the frontend to show blurred name/cover with "Private playlist" overlay
        return JSONResponse(content={
            "id": playlist.id,
            "name": playlist.name,
            "description": playlist.description,
            "is_liked": playlist.is_liked,
            "pinned": playlist.pinned,
            "shuffle": playlist.shuffle,
            "is_public": playlist.is_public,
            "created_at": playlist.created_at.isoformat() if playlist.created_at else None,
            "user": None,  # Don't expose owner info for private playlists
            "access_denied": True,  # Frontend flag to show blur UI
            "is_followed": is_followed,
            "is_owner": is_owner,
            "track_count": 0,
        })

    # Add is_followed and is_owner attributes for the full response
    # For albums, we consider them "followed" in the UI sense even if owned
    playlist.is_followed = is_followed or (is_owner and playlist.type == "album")
    playlist.is_owner = is_owner

    # Get track count
    track_count = db.scalar(
        select(func.count(PlaylistTrack.track_id)).where(PlaylistTrack.playlist_id == playlist_id)
    ) or 0
    playlist.track_count = track_count

    return playlist


@app.get("/playlists/{playlist_id}/cover")
def get_playlist_cover(
    playlist_id: str,
    x_auth_hash: str | None = Header(None),
    db: Session = Depends(get_db),
):
    """
    Return a cached 500x500 JPEG collage of a playlist's first 4 tracks.
    Public playlists can be accessed without auth, private requires ownership.
    """
    import uuid

    try:
        uuid.UUID(playlist_id)
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid playlist ID format")

    user = None
    if x_auth_hash:
        try:
            user = _get_user(db, x_auth_hash)
        except:
            pass

    playlist = db.get(Playlist, playlist_id)
    if not playlist:
        raise HTTPException(status_code=404, detail="Playlist not found")

    # Check access
    is_owner = user and playlist.user_hash == user.auth_hash
    is_admin = user and user.is_admin
    is_public = playlist.is_public and not playlist.is_liked

    if not is_owner and not is_admin and not is_public:
        # Return 404 for private playlist covers - frontend will show placeholder
        raise HTTPException(status_code=404, detail="Cover not available for private playlist")
    if playlist.is_liked:
        raise HTTPException(status_code=404, detail="Liked Songs has no collage")

    # If playlist has a custom image_url set, proxy and cache it locally so
    # covers render quickly and consistently without cross-origin/CORS issues.
    if playlist.image_url:
        parsed = urlparse(playlist.image_url)
        if parsed.scheme not in {"http", "https"}:
            raise HTTPException(status_code=400, detail="Invalid playlist image URL")
        external_covers_dir = settings.artwork_dir / "playlist_external"
        external_covers_dir.mkdir(parents=True, exist_ok=True)
        cached_cover_path = external_covers_dir / f"{playlist_id}.jpg"
        if cached_cover_path.exists():
            return FileResponse(
                cached_cover_path,
                media_type="image/jpeg",
                headers={"Cache-Control": "private, max-age=86400"},
            )
        try:
            req = UrlRequest(
                playlist.image_url,
                headers={"User-Agent": "Openfy/1.0"},
            )
            with urlopen(req, timeout=10) as resp:
                image_bytes = resp.read()
            img = Image.open(io.BytesIO(image_bytes)).convert("RGB")
            img.save(cached_cover_path, format="JPEG", quality=95, optimize=True)
            return FileResponse(
                cached_cover_path,
                media_type="image/jpeg",
                headers={"Cache-Control": "private, max-age=86400"},
            )
        except Exception:
            raise HTTPException(status_code=404, detail="Playlist cover not available")

    collages_dir = settings.artwork_dir / "collages"
    collages_dir.mkdir(parents=True, exist_ok=True)
    out_path = collages_dir / f"{playlist_id}.jpg"
    if out_path.exists():
        return FileResponse(
            out_path,
            media_type="image/jpeg",
            headers={"Cache-Control": "private, max-age=3600"},
        )

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
                except Exception:  # nosec B110 – fall through to gray block if image fails
                    pass
        # Missing artwork — leave gray (already the background)

    collage.save(out_path, format="JPEG", quality=85)
    return FileResponse(
        out_path,
        media_type="image/jpeg",
        headers={"Cache-Control": "private, max-age=3600"},
    )


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
    # Allow is_public changes for non-liked playlists (Liked Songs is always private)
    if payload.is_public is not None and not playlist.is_liked:
        playlist.is_public = 1 if payload.is_public else 0
    # Allow image_url changes for any playlist (except Liked Songs)
    if payload.image_url is not None and not playlist.is_liked:
        if playlist.image_url != payload.image_url:
            _delete_playlist_external_cover(playlist_id)
        playlist.image_url = payload.image_url
    db.commit()
    db.refresh(playlist)
    return playlist


@app.post("/playlists/{playlist_id}/follow")
def follow_playlist(
    playlist_id: str,
    x_auth_hash: str | None = Header(None),
    db: Session = Depends(get_db),
):
    """Follow a public playlist."""
    if not x_auth_hash:
        raise HTTPException(status_code=401, detail="Not authenticated")

    user = _get_user(db, x_auth_hash)
    if not user:
        raise HTTPException(status_code=401, detail="Invalid auth hash")

    playlist = db.get(Playlist, playlist_id)
    if not playlist:
        raise HTTPException(status_code=404, detail="Playlist not found")

    # Cannot follow Liked Songs
    if playlist.is_liked:
        raise HTTPException(status_code=403, detail="Cannot follow Liked Songs playlist")

    # Cannot follow own playlist
    if playlist.user_hash == user.auth_hash:
        raise HTTPException(status_code=403, detail="Cannot follow your own playlist")

    # Must be public to follow
    if not playlist.is_public:
        raise HTTPException(status_code=403, detail="Cannot follow private playlist")

    # Check if already following
    existing = db.execute(
        select(FollowedPlaylist).where(
            FollowedPlaylist.user_hash == user.auth_hash,
            FollowedPlaylist.playlist_id == playlist_id,
        )
    ).scalar_one_or_none()

    if existing:
        raise HTTPException(status_code=409, detail="Already following this playlist")

    # Create follow
    followed = FollowedPlaylist(
        user_hash=user.auth_hash,
        playlist_id=playlist_id,
    )
    db.add(followed)
    db.commit()

    return {"success": True}


@app.post("/albums/{album_id}/follow")
def follow_album(
    album_id: str,
    x_auth_hash: str | None = Header(None),
    db: Session = Depends(get_db),
):
    """Follow an album."""
    if not x_auth_hash:
        raise HTTPException(status_code=401, detail="Not authenticated")

    user = _get_user(db, x_auth_hash)
    if not user:
        raise HTTPException(status_code=401, detail="Invalid auth hash")

    album = db.get(Album, album_id)
    if not album:
        # Fallback for legacy "album playlists"
        pl = db.get(Playlist, album_id)
        if pl and pl.type == "album":
            return follow_playlist(album_id, x_auth_hash, db)
        raise HTTPException(status_code=404, detail="Album not found")

    # Check if already following
    existing = db.execute(
        select(FollowedAlbum).where(
            FollowedAlbum.user_hash == user.auth_hash,
            FollowedAlbum.album_id == album_id,
        )
    ).scalar_one_or_none()

    if existing:
        raise HTTPException(status_code=409, detail="Already following this album")

    # Create follow
    followed = FollowedAlbum(
        user_hash=user.auth_hash,
        album_id=album_id,
    )
    db.add(followed)
    db.commit()

    return {"success": True}


@app.delete("/albums/{album_id}/follow")
def unfollow_album(
    album_id: str,
    x_auth_hash: str | None = Header(None),
    db: Session = Depends(get_db),
):
    """Unfollow an album."""
    if not x_auth_hash:
        raise HTTPException(status_code=401, detail="Not authenticated")

    user = _get_user(db, x_auth_hash)
    if not user:
        raise HTTPException(status_code=401, detail="Invalid auth hash")

    # Find and delete the follow
    followed = db.execute(
        select(FollowedAlbum).where(
            FollowedAlbum.user_hash == user.auth_hash,
            FollowedAlbum.album_id == album_id,
        )
    ).scalar_one_or_none()

    if followed:
        db.delete(followed)
        db.commit()
    else:
        # Fallback for legacy "album playlists"
        pl = db.get(Playlist, album_id)
        if pl and pl.type == "album":
            return unfollow_playlist(album_id, x_auth_hash, db)

    return {"success": True}


@app.delete("/playlists/{playlist_id}/follow")
def unfollow_playlist(
    playlist_id: str,
    x_auth_hash: str | None = Header(None),
    db: Session = Depends(get_db),
):
    """Unfollow a playlist."""
    if not x_auth_hash:
        raise HTTPException(status_code=401, detail="Not authenticated")

    user = _get_user(db, x_auth_hash)
    if not user:
        raise HTTPException(status_code=401, detail="Invalid auth hash")

    # If it's an owned album, unfollowing means deleting the playlist record
    playlist = db.get(Playlist, playlist_id)
    if playlist and playlist.user_hash == user.auth_hash and playlist.type == "album":
        _delete_playlist_collage(playlist_id)
        _delete_playlist_external_cover(playlist_id)
        db.delete(playlist)
        db.commit()
        return {"success": True}

    # Find and delete the follow
    followed = db.execute(
        select(FollowedPlaylist).where(
            FollowedPlaylist.user_hash == user.auth_hash,
            FollowedPlaylist.playlist_id == playlist_id,
        )
    ).scalar_one_or_none()

    if not followed:
        raise HTTPException(status_code=404, detail="Not following this playlist")

    db.delete(followed)
    db.commit()

    return {"success": True}


@app.get("/playlists/{playlist_id}/tracks", response_model=List[PlaylistTrackOut])
def list_playlist_tracks(
    playlist_id: str,
    x_auth_hash: str | None = Header(None),
    db: Session = Depends(get_db),
):
    user = None
    if x_auth_hash:
        user = _get_user(db, x_auth_hash)

    playlist = db.get(Playlist, playlist_id)
    if not playlist:
        raise HTTPException(status_code=404, detail="Playlist not found")

    # Check access
    is_owner = user and playlist.user_hash == user.auth_hash
    is_admin = user and user.is_admin
    is_public = playlist.is_public and not playlist.is_liked

    if not is_owner and not is_admin and not is_public:
        # Return empty list for non-owners of private playlists
        # Frontend will show blur UI based on access_denied flag from /playlists endpoint
        return []

    stmt = (
        select(PlaylistTrack)
        .options(
            selectinload(PlaylistTrack.track).selectinload(Track.artist),
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
                log_error("Race condition: track already exists, returning it")
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
    _delete_playlist_external_cover(playlist_id)
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

    return queue_download(db, payload.query, payload.source or "auto", user.auth_hash, artist_url=payload.artist_url)


@app.post("/playlists/import")
def import_spotify_playlist(
    payload: SpotifyImportRequest,
    x_auth_hash: str | None = Header(None),
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    """Import a Spotify playlist by URL."""
    if not x_auth_hash:
        raise HTTPException(status_code=401, detail="Not authenticated")
    user = _get_user(db, x_auth_hash)
    if not user:
        raise HTTPException(status_code=401, detail="Invalid auth hash")

    # Check if playlist importing is enabled
    playlist_import_enabled = _get_app_setting_bool(db, PLAYLIST_IMPORT_SETTING_KEY, default=True)
    if not playlist_import_enabled:
        raise HTTPException(status_code=403, detail="Playlist importing is currently disabled by admin")

    spotify_url = payload.url
    if not spotify_url:
        raise HTTPException(status_code=400, detail="URL is required")

    # Validate Spotify URL (playlist or album)
    if not re.match(r'^https?://open\.spotify\.com/(playlist|album)/[a-zA-Z0-9]+', spotify_url):
        raise HTTPException(status_code=400, detail="Please enter a valid Spotify playlist or album URL")

    # Parse ID and type from URL
    match = re.search(r'(playlist|album)/([a-zA-Z0-9]+)', spotify_url)
    if not match:
        raise HTTPException(status_code=400, detail="Invalid Spotify URL")

    url_type = match.group(1)
    playlist_id = match.group(2)

    # Try to extract owner from URL path (mostly for playlists)
    owner_match = re.search(r'/user/([^/]+)/playlist/', spotify_url)
    owner = owner_match.group(1) if owner_match else "spotify"

    # Import and use SpotifyClient to get data
    try:
        from spotify_scraper import SpotifyClient
        client = SpotifyClient()
        if url_type == "album":
            playlist_data = client.get_album_info(spotify_url)
        else:
            playlist_data = client.get_playlist_info(spotify_url)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Could not fetch {url_type}: {str(e)}")

    # Return parsed data for frontend to process
    # Extract owner name from owner dict if available
    owner_name = owner
    if url_type == "album" and playlist_data.get("artists"):
        # For albums, use the first artist's name
        artists = playlist_data.get("artists")
        if isinstance(artists, list) and len(artists) > 0:
            owner_name = artists[0].get("name", owner)
    elif playlist_data.get("owner") and isinstance(playlist_data.get("owner"), dict):
        owner_name = playlist_data.get("owner").get("display_name", owner)

    # Extract highest-resolution image URL from images array
    image_url = None
    images = playlist_data.get("images", [])
    if isinstance(images, list) and images:
        candidates = [img for img in images if isinstance(img, dict) and img.get("url")]
        if candidates:
            scored = []
            for img in candidates:
                width = img.get("width") or 0
                height = img.get("height") or 0
                scored.append((width * height, img.get("url")))
            scored.sort(key=lambda item: item[0], reverse=True)
            if scored[0][0] > 0:
                image_url = scored[0][1]
            else:
                # Some sources omit width/height; probe the candidates and choose
                # the largest real image to avoid low-quality covers.
                best_area = -1
                best_url = None
                for _, candidate_url in scored:
                    try:
                        req = UrlRequest(candidate_url, headers={"User-Agent": "Openfy/1.0"})
                        with urlopen(req, timeout=8) as resp:
                            raw = resp.read()
                        img_obj = Image.open(io.BytesIO(raw))
                        area = img_obj.width * img_obj.height
                        if area > best_area:
                            best_area = area
                            best_url = candidate_url
                    except Exception:
                        continue
                image_url = best_url or scored[0][1]

    # Extract tracks - may be array or dict with items
    tracks_data = playlist_data.get("tracks", [])
    if isinstance(tracks_data, dict):
        tracks_items = tracks_data.get("items", [])
    elif isinstance(tracks_data, list):
        tracks_items = tracks_data
    else:
        tracks_items = []

    normalized_tracks = []
    for raw_item in tracks_items:
        if not isinstance(raw_item, dict):
            continue
        # Spotify playlist APIs often wrap the track payload as {"track": {...}}
        track_obj = raw_item.get("track") if isinstance(raw_item.get("track"), dict) else raw_item
        if not isinstance(track_obj, dict):
            continue
        uri = track_obj.get("uri")
        spotify_url = (
            uri.replace("spotify:track:", "https://open.spotify.com/track/") if uri else None
        )
        artists = track_obj.get("artists", [])
        artist_id = artists[0].get("id") if isinstance(artists, list) and artists else None
        artist_url = f"https://open.spotify.com/artist/{artist_id}" if artist_id else None
        normalized_tracks.append(
            {
                "name": track_obj.get("name"),
                "artists": [a.get("name") for a in artists] if isinstance(artists, list) else [],
                "duration_ms": track_obj.get("duration_ms", 0),
                "spotify_url": spotify_url,
                "artist_url": artist_url,
            }
        )

    # An album must have more than 1 track to be considered a valid album
    final_type = url_type
    if url_type == "album" and len(normalized_tracks) <= 1:
        final_type = "playlist"

    # If it's an album, try to find it in our DB by matching tracks
    internal_album_id = None
    if url_type == "album":
        # Extract track Spotify IDs
        spotify_ids = []
        for raw_item in tracks_items:
            track_obj = raw_item.get("track") if isinstance(raw_item.get("track"), dict) else raw_item
            if isinstance(track_obj, dict):
                uri = track_obj.get("uri")
                if uri and uri.startswith("spotify:track:"):
                    spotify_ids.append(uri.replace("spotify:track:", ""))
        
        if spotify_ids:
            # Find any track in our DB with one of these Spotify IDs
            existing_track = db.execute(
                select(Track).where(Track.source_id.in_(spotify_ids), Track.album_id.is_not(None))
            ).scalars().first()
            if existing_track:
                # Verify that the album actually exists
                verified_album = db.get(Album, existing_track.album_id)
                if verified_album:
                    internal_album_id = verified_album.id

    return {
        "playlist_id": playlist_id,
        "name": playlist_data.get("name", "Imported Playlist"),
        "owner": owner_name,
        "image_url": image_url,
        "tracks": normalized_tracks,
        "type": final_type,
        "internal_album_id": internal_album_id,
    }


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

    resolved_track_id = None
    if job.status == "completed":
        if job.output_path:
            resolved_by_path = db.execute(
                select(Track.id).where(Track.file_path == job.output_path)
            ).scalar_one_or_none()
            if resolved_by_path:
                resolved_track_id = resolved_by_path
        if not resolved_track_id and job.query:
            resolved_by_source = db.execute(
                select(Track.id)
                .where(
                    Track.user_hash == job.user_hash,
                    Track.source_url == job.query,
                )
                .order_by(Track.created_at.desc())
            ).scalar_one_or_none()
            if resolved_by_source:
                resolved_track_id = resolved_by_source

    return {
        "id": job.id,
        "source": job.source,
        "query": job.query,
        "status": job.status,
        "track_id": resolved_track_id,
        "output_path": job.output_path,
        "log": job.log,
        "created_at": job.created_at,
        "updated_at": job.updated_at,
    }


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
        ),
        "playlist_import_enabled": _get_app_setting_bool(
            db, PLAYLIST_IMPORT_SETTING_KEY, default=True
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


# Avatar upload endpoint
@app.post("/users/upload-avatar")
def upload_user_avatar(
    file: UploadFile = File(...),
    x_auth_hash: str | None = Header(None),
    db: Session = Depends(get_db),
):
    """Upload a profile picture for the authenticated user."""
    user = _require_user(db, x_auth_hash)

    # 5 MB limit
    MAX_SIZE = 5 * 1024 * 1024
    # Read some bytes to check size + type
    content = file.file.read(MAX_SIZE + 1)
    file.file.seek(0)

    if len(content) > MAX_SIZE:
        raise HTTPException(400, "File too large — maximum 5MB")

    # Validate image type using PIL
    try:
        img = Image.open(io.BytesIO(content))
        img.verify()  # Verify that it is, in fact, an image
        image_type = img.format.lower()
        # Map PIL format to our expected extension
        format_to_ext = {
            'jpeg': 'jpg',
            'png': 'png',
            'gif': 'gif',
            'webp': 'webp',
        }
        ext = format_to_ext.get(image_type)
        if not ext:
            raise HTTPException(400, "Invalid image format — use jpg, png, gif, or webp")
        ext = '.' + ext
    except Exception:
        raise HTTPException(400, "Invalid image format — use jpg, png, gif, or webp")

    # Generate unique filename and store using store_avatar
    from .services.storage import store_avatar
    with tempfile.NamedTemporaryFile(suffix=ext, delete=False) as tmp:
        tmp.write(content)
        tmp.flush()
        tmp_path = Path(tmp.name)

    avatar_path_obj = store_avatar(tmp_path, user.id)
    avatar_path_str = str(avatar_path_obj)

    # Delete old avatar
    if user.avatar_path:
        old = Path(user.avatar_path)
        if old.exists() and _is_within_dir(old, settings.data_dir / "avatars"):
            try:
                old.unlink()
            except Exception:
                pass

    user.avatar_path = avatar_path_str
    db.commit()
    db.refresh(user)

    return UserOutPublic.model_validate(user)


@app.get("/users/{user_id}/avatar")
def get_user_avatar(user_id: str, db: Session = Depends(get_db)):
    """Serve a user's avatar image."""
    user = db.get(User, user_id)
    if not user or not user.avatar_path:
        raise HTTPException(404, "Avatar not found")

    path = Path(user.avatar_path)
    if not path.exists():
        raise HTTPException(404, "Avatar not found")

    # Ensure path is inside avatars directory
    avatars_dir = settings.data_dir / "avatars"
    if not _is_within_dir(path, avatars_dir):
        raise HTTPException(403, "Invalid avatar path")

    return FileResponse(
        path,
        media_type=f"image/{path.suffix.lstrip('.')}",
        filename=path.name,
    )


@app.delete("/users/avatar")
def delete_user_avatar(
    x_auth_hash: str | None = Header(None),
    db: Session = Depends(get_db),
):
    """Delete the authenticated user's avatar."""
    user = _require_user(db, x_auth_hash)
    if not user.avatar_path:
        raise HTTPException(404, "No avatar to delete")

    path = Path(user.avatar_path)
    avatars_dir = settings.data_dir / "avatars"
    if not _is_within_dir(path, avatars_dir):
        raise HTTPException(403, "Invalid avatar path")

    try:
        if path.exists():
            path.unlink()
    except Exception as e:
        # Log but continue
        pass

    user.avatar_path = None
    db.commit()
    db.refresh(user)
    return {"status": "deleted"}


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
    five_mins_ago = datetime.now(timezone.utc).replace(tzinfo=None) - timedelta(minutes=5)
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
                except Exception:  # nosec B112 – skip unreadable files in size tally
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
    playlist_import_enabled = _get_app_setting_bool(db, PLAYLIST_IMPORT_SETTING_KEY, default=True)
    timezone_row = db.get(AppSetting, "timezone")
    return {
        "manual_audio_upload_enabled": manual_enabled,
        "playlist_import_enabled": playlist_import_enabled,
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

    if payload.playlist_import_enabled is not None:
        res["playlist_import_enabled"] = _set_app_setting_bool(
            db, PLAYLIST_IMPORT_SETTING_KEY, payload.playlist_import_enabled
        )
    else:
        res["playlist_import_enabled"] = _get_app_setting_bool(
            db, PLAYLIST_IMPORT_SETTING_KEY, default=True
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


@app.get("/admin/albums")
def list_albums_admin(
    q: str | None = Query(None),
    x_auth_hash: str | None = Header(None),
    db: Session = Depends(get_db),
):
    user = _require_admin(db, x_auth_hash)
    stmt = select(Album).options(selectinload(Album.artist))
    if q:
        stmt = stmt.where(Album.title.ilike(f"%{q}%"))

    albums = db.execute(stmt).scalars().all()

    # Enrich with track count
    results = []
    for album in albums:
        track_count = (
            db.scalar(select(func.count(Track.id)).where(Track.album_id == album.id))
            or 0
        )
        results.append(
            {
                "id": album.id,
                "title": album.title or "Untitled Album",
                "artist_name": album.artist.name if album.artist else "Unknown Artist",
                "track_count": track_count,
                "created_at": album.created_at.isoformat() if album.created_at else None,
            }
        )

    # Sort by creation date descending
    results.sort(
        key=lambda x: x["created_at"] if x["created_at"] else "", reverse=True
    )
    return results


@app.delete("/admin/albums/{album_id}")
def delete_album_admin(
    album_id: str, x_auth_hash: str | None = Header(None), db: Session = Depends(get_db)
):
    user = _require_admin(db, x_auth_hash)
    album = db.get(Album, album_id)
    if not album:
        raise HTTPException(status_code=404, detail="Album not found")

    # Delete all tracks associated with this album
    tracks = db.execute(select(Track).where(Track.album_id == album.id)).scalars().all()
    for track in tracks:
        file_path = track.file_path
        p = Path(file_path)
        if _is_within_dir(p, settings.music_dir):
            resolved = p.resolve()
            if _is_within_dir(resolved, settings.music_dir) and resolved.exists():
                try:
                    resolved.unlink()
                except Exception:
                    logger.warning("Failed to delete file for track %s at %s", track.id, resolved)
        db.delete(track)

    db.delete(album)
    db.commit()
    return {"status": "deleted"}


# Serve index.html for all frontend routes (SPA routing)
_index_html_cache: str | None = None

def _get_index_html() -> str:
    global _index_html_cache
    if _index_html_cache is None:
        for candidate in [Path(__file__).resolve().parent.parent / "client" / "index.html",
                          Path(__file__).resolve().parent.parent.parent / "client" / "index.html"]:
            if candidate.exists():
                _index_html_cache = candidate.read_text()
                break
    return _index_html_cache or "<!DOCTYPE html><html><body><h1>Not Found</h1></body></html>"


@app.get("/{path:path}")
async def serve_frontend(path: str):
    """Serve index.html for all non-API routes to enable SPA client-side routing"""
    # Skip API routes
    if path.startswith("api/"):
        raise HTTPException(status_code=404, detail="API endpoint not found")
    # Skip static files - let StaticFiles handle them
    if path.startswith("static/"):
        raise HTTPException(status_code=404, detail="File not found")
    # Serve index.html for frontend routes
    return HTMLResponse(content=_get_index_html())
