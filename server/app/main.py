import secrets
from pathlib import Path
import json
import time
from datetime import datetime, timedelta
from typing import List

from fastapi import (
    FastAPI,
    Depends,
    HTTPException,
    Header,
    Query,
    Request,
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
from sqlalchemy.orm import Session, selectinload
from sqlalchemy import select, text, func
from sqlalchemy import delete
from sqlalchemy.exc import IntegrityError

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
)
from .settings import settings
from .services.storage import ensure_dirs
from .services.library import scan_default_library, scan_paths
from .services.spotiflac import queue_download

# Global variable to track last track update
last_track_update = 0


def update_track_timestamp():
    """Update the global track update timestamp"""
    global last_track_update
    import time

    last_track_update = int(time.time() * 1000)  # Milliseconds since epoch


def _delete_playlist_collage(playlist_id: str):
    """Delete cached collage for given playlist if it exists."""
    collages_dir = settings.artwork_dir / "collages"
    path = collages_dir / f"{playlist_id}.jpg"
    if path.exists():
        path.unlink()


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


allowed_origins = [
    origin.strip() for origin in settings.allowed_origins.split(",") if origin.strip()
]
cors_allow_credentials = True
if "*" in allowed_origins:
    # Wildcard + credentials is unsafe and rejected by browsers anyway.
    allowed_origins = ["*"]
    cors_allow_credentials = False

app.add_middleware(
    CORSMiddleware,
    allow_origins=allowed_origins,
    allow_credentials=cors_allow_credentials,
    allow_methods=["*"],
    allow_headers=["*"],
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
    return db.execute(
        select(User).where(User.auth_hash == auth_hash)
    ).scalar_one_or_none()


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
        target = Path(path).resolve()
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


@app.get("/tracks/{track_id}", response_model=TrackOut)
def get_track(track_id: str, db: Session = Depends(get_db)):
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
    path = Path(track.album.artwork_path).resolve()
    if not path.exists():
        raise HTTPException(status_code=404, detail="Artwork not found")
    if not _is_within_dir(path, settings.artwork_dir):
        raise HTTPException(status_code=403, detail="Access denied")
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
    # Audio elements can't set custom headers, so we support passing the auth hash via query too.
    auth = request.query_params.get("auth")
    user = _require_user(db, x_auth_hash or auth)

    path = Path(track.file_path).resolve()
    if not path.exists():
        raise HTTPException(status_code=404, detail="File not found")
    if not _is_within_dir(path, settings.music_dir):
        raise HTTPException(status_code=403, detail="Access denied")

    range_header = request.headers.get("range")
    if not range_header:
        try:
            track.play_count = (track.play_count or 0) + 1
            db.add(TrackPlay(track_id=track_id, user_hash=user.auth_hash))
            # Update user's last played track
            user.last_track_id = track_id
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
    playlist = db.get(Playlist, playlist_id)
    if not playlist:
        raise HTTPException(status_code=404, detail="Playlist not found")
    if playlist.user_hash != user.auth_hash and not user.is_admin:
        raise HTTPException(status_code=403, detail="Not your playlist")
    return playlist


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
            raise HTTPException(status_code=500, detail=f"Database error: {type(e).__name__}: {e}")
    except HTTPException:
        raise
    except Exception as e:
        log_error(f"Unexpected error in add_track_to_playlist: {e}")
        raise HTTPException(status_code=500, detail=f"Server error: {type(e).__name__}: {e}")


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

    playlist = db.get(Playlist, playlist_id)
    if not playlist:
        raise HTTPException(status_code=404, detail="Playlist not found")
    if playlist.is_liked:
        raise HTTPException(status_code=403, detail="Cannot delete Liked Songs")
    if playlist.user_hash != x_auth_hash:
        raise HTTPException(status_code=403, detail="Not your playlist")

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
def signup(payload: UserSignup, db: Session = Depends(get_db)):
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
def signin(payload: UserSignin, db: Session = Depends(get_db)):
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


# Admin endpoints
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
    stmt = stmt.order_by(Track.created_at.desc())

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

    # Delete from database (cascades to playlist_tracks)
    db.delete(track)
    db.commit()

    # Delete file from disk
    try:
        p = Path(file_path).resolve()
        if p.exists() and _is_within_dir(p, settings.music_dir):
            p.unlink()
    except Exception as e:
        pass  # File deletion failure shouldn't break the response

    return {"status": "deleted", "track": track_title}
