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
from fastapi.responses import StreamingResponse, FileResponse, HTMLResponse
from sqlalchemy.orm import Session, selectinload
from sqlalchemy import select, text, func
from sqlalchemy import delete

from .db import Base, engine, get_db, SessionLocal
from .models import Track, Artist, Album, Playlist, PlaylistTrack, DownloadJob, User, TrackPlay, track_artist
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
)
from .settings import settings
from .services.storage import ensure_dirs
from .services.library import scan_default_library, scan_paths
from .services.spotiflac import queue_download


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

app.add_middleware(
    CORSMiddleware,
    allow_origins=[origin.strip() for origin in settings.allowed_origins.split(",")],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.on_event("startup")
def _startup():
    ensure_dirs()
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

            djcols = [
                row[1]
                for row in conn.execute(text("PRAGMA table_info(download_jobs)")).fetchall()
            ]
            if "user_hash" not in djcols:
                conn.execute(
                    text("ALTER TABLE download_jobs ADD COLUMN user_hash VARCHAR(64)")
                )
                conn.commit()

            # Create track_plays table if not exists
            try:
                conn.execute(text("CREATE TABLE IF NOT EXISTS track_plays (id VARCHAR(36) PRIMARY KEY, track_id VARCHAR(36), played_at DATETIME, user_hash VARCHAR(64), FOREIGN KEY(track_id) REFERENCES tracks(id))"))
                conn.execute(text("CREATE INDEX IF NOT EXISTS idx_track_plays_played_at ON track_plays(played_at)"))
                conn.execute(text("CREATE INDEX IF NOT EXISTS idx_track_plays_track_id ON track_plays(track_id)"))
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
    if not x_auth_hash:
        raise HTTPException(status_code=401, detail="Not authenticated")
    user = _get_user(db, x_auth_hash)
    if not user or not user.is_admin:
        raise HTTPException(status_code=403, detail="Admin access required")
    if path:
        target = Path(path).resolve()
        if not str(target).startswith(str(settings.music_dir)):
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
    if random:
        stmt = select(Track).options(selectinload(Track.artists)).offset(offset).limit(limit).order_by(func.random())
    else:
        stmt = select(Track).options(selectinload(Track.artists)).order_by(Track.created_at.desc()).limit(limit).offset(offset)

    # If user_hash is provided, require auth and check authorization
    if user_hash:
        if not x_auth_hash:
            raise HTTPException(status_code=401, detail="Not authenticated")
        user = _get_user(db, x_auth_hash)
        if not user:
            raise HTTPException(status_code=401, detail="Invalid auth hash")
        # Admin can query any user's tracks; regular users can only query their own
        if not user.is_admin and user.auth_hash != user_hash:
            raise HTTPException(
                status_code=403, detail="Not authorized to view these tracks"
            )
        stmt = stmt.where(Track.user_hash == user_hash)
    # If no user_hash, return all tracks (main library) - no filter applied

    tracks = db.execute(stmt).scalars().all()
    return tracks


@app.get("/tracks/{track_id}", response_model=TrackOut)
def get_track(track_id: str, db: Session = Depends(get_db)):
    stmt = select(Track).options(selectinload(Track.artists), selectinload(Track.album)).where(Track.id == track_id)
    track = db.execute(stmt).scalar_one_or_none()
    if not track:
        raise HTTPException(status_code=404, detail="Track not found")
    return track


@app.get("/tracks/{track_id}/artwork")
def track_artwork(track_id: str, db: Session = Depends(get_db)):
    track = db.get(Track, track_id)
    if not track or not track.album:
        raise HTTPException(status_code=404, detail="Artwork not found")
    if not track.album.artwork_path:
        raise HTTPException(status_code=404, detail="Artwork not found")
    path = Path(track.album.artwork_path).resolve()
    if not path.exists():
        raise HTTPException(status_code=404, detail="Artwork not found")
    if not str(path).startswith(str(settings.artwork_dir)):
        raise HTTPException(status_code=403, detail="Access denied")
    return FileResponse(path)


@app.get("/tracks/most-played", response_model=List[TrackOut])
def most_played(limit: int = Query(10, ge=1, le=100), db: Session = Depends(get_db)):
    one_day_ago = datetime.utcnow() - timedelta(days=1)
    stmt = (
        select(Track, func.count(TrackPlay.id).label("play_ct"))
        .options(selectinload(Track.artists))
        .outerjoin(TrackPlay, Track.id == TrackPlay.track_id)
        .where(TrackPlay.played_at >= one_day_ago)
        .group_by(Track.id)
        .order_by(func.count(TrackPlay.id).desc())
        .limit(limit)
    )
    results = db.execute(stmt).all()
    return [row[0] for row in results]


@app.get("/tracks/{track_id}/stream")
def stream_track(track_id: str, request: Request, x_auth_hash: str | None = Header(None), db: Session = Depends(get_db)):
    track = db.get(Track, track_id)
    if not track:
        raise HTTPException(status_code=404, detail="Track not found")
    track.play_count = (track.play_count or 0) + 1
    db.commit()

    play = TrackPlay(track_id=track_id, user_hash=x_auth_hash)
    db.add(play)
    db.commit()

    path = Path(track.file_path)
    if not path.exists():
        raise HTTPException(status_code=404, detail="File not found")

    range_header = request.headers.get("range")
    if not range_header:
        return FileResponse(path, media_type=track.mime_type or "audio/mpeg")

    size = path.stat().st_size
    bytes_unit, byte_range = range_header.split("=")
    if bytes_unit != "bytes":
        return FileResponse(path, media_type=track.mime_type or "audio/mpeg")

    start_str, end_str = byte_range.split("-")
    start = int(start_str) if start_str else 0
    end = int(end_str) if end_str else size - 1
    end = min(end, size - 1)

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
def list_artists(db: Session = Depends(get_db)):
    artists = db.execute(select(Artist).order_by(Artist.name.asc())).scalars().all()
    return artists


@app.get("/albums", response_model=List[AlbumOut])
def list_albums(db: Session = Depends(get_db)):
    albums = db.execute(select(Album).order_by(Album.title.asc())).scalars().all()
    return albums


@app.get("/search", response_model=List[TrackOut])
def search(
    q: str,
    limit: int = Query(50, ge=1, le=200),
    db: Session = Depends(get_db),
):
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
    stmt = select(Playlist).order_by(
        Playlist.is_liked.desc(),
        Playlist.pinned.desc(),
        Playlist.created_at.desc()
    )
    if x_auth_hash:
        stmt = stmt.where(Playlist.user_hash == x_auth_hash)
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
    playlist = Playlist(
        name=payload.name,
        description=payload.description,
        user_hash=user.auth_hash,
    )
    db.add(playlist)
    db.commit()
    db.refresh(playlist)
    return playlist


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
    if playlist.user_hash != x_auth_hash:
        raise HTTPException(status_code=403, detail="Not your playlist")
    # Disallow renaming the Liked Songs playlist
    if playlist.is_liked and payload.name is not None:
        raise HTTPException(status_code=403, detail="Cannot rename Liked Songs playlist")
    # Allow name change for non-liked playlists
    if not playlist.is_liked and payload.name is not None:
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
    stmt = (
        select(PlaylistTrack)
        .options(
            selectinload(PlaylistTrack.track).selectinload(Track.artists),
            selectinload(PlaylistTrack.track).selectinload(Track.album)
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
    if not x_auth_hash:
        raise HTTPException(status_code=401, detail="Not authenticated")
    user = _get_user(db, x_auth_hash)
    if not user:
        raise HTTPException(status_code=401, detail="Invalid auth hash")
    playlist = db.get(Playlist, playlist_id)
    track = db.get(Track, track_id)
    if not playlist or not track:
        raise HTTPException(status_code=404, detail="Playlist or track not found")
    if playlist.user_hash != x_auth_hash and not user.is_admin:
        raise HTTPException(status_code=403, detail="Not your playlist")
    if playlist.is_liked:
        raise HTTPException(
            status_code=403, detail="Cannot manually add to Liked Songs"
        )

    existing = db.execute(
        select(PlaylistTrack).where(
            PlaylistTrack.playlist_id == playlist_id,
            PlaylistTrack.track_id == track_id,
        )
    ).scalar_one_or_none()
    if existing:
        return existing

    position = db.execute(
        select(PlaylistTrack.position)
        .where(PlaylistTrack.playlist_id == playlist_id)
        .order_by(PlaylistTrack.position.desc())
    ).scalar_one_or_none()
    next_position = (position or 0) + 1

    link = PlaylistTrack(
        playlist_id=playlist_id, track_id=track_id, position=next_position
    )
    db.add(link)
    db.commit()
    db.refresh(link)
    return link


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


@app.get("/auth/me", response_model=UserOut)
def auth_me(x_auth_hash: str | None = Header(None), db: Session = Depends(get_db)):
    if not x_auth_hash:
        raise HTTPException(status_code=401, detail="Not authenticated")
    user = _get_user(db, x_auth_hash)
    if not user:
        raise HTTPException(status_code=401, detail="Invalid auth hash")
    return user


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

    stmt = select(User).order_by(User.created_at.desc())
    if q:
        stmt = stmt.where(User.name.ilike(f"%{q}%"))

    users = db.execute(stmt).scalars().all()
    result = []
    for user in users:
        track_count = (
            db.execute(select(Track).where(Track.user_hash == user.auth_hash))
            .scalars()
            .all()
        )
        user_data = {
            "id": user.id,
            "name": user.name,
            "is_admin": user.is_admin,
            "created_at": user.created_at,
            "uploaded_tracks_count": len(track_count),
        }
        result.append(user_data)
    return result


@app.delete("/admin/users/{user_hash}")
def delete_user(
    user_hash: str,
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
    if user_hash == admin_user.auth_hash:
        raise HTTPException(status_code=400, detail="Cannot delete yourself")

    user = db.execute(
        select(User).where(User.auth_hash == user_hash)
    ).scalar_one_or_none()
    if not user:
        raise HTTPException(status_code=404, detail="User not found")

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

    stmt = select(Track).options(selectinload(Track.artists)).order_by(Track.created_at.desc())
    if q:
        stmt = (
            stmt.where(
                (Track.title.ilike(f"%{q}%"))
                | (Track.artists.any(Artist.name.ilike(f"%{q}%")))
                | (Album.title.ilike(f"%{q}%"))
            )
            .join(Album, isouter=True)  # join Album for album title search
        )

    tracks = db.execute(stmt).scalars().all()
    result = []
    for track in tracks:
        user = db.execute(
            select(User).where(User.auth_hash == track.user_hash)
        ).scalar_one_or_none()
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
                "user_hash": track.user_hash,
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
        p = Path(file_path)
        if p.exists():
            p.unlink()
    except Exception as e:
        pass  # File deletion failure shouldn't break the response

    return {"status": "deleted", "track": track_title}
