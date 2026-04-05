import hashlib
import secrets
from pathlib import Path
import json
import time
from typing import List

from fastapi import (
    FastAPI,
    Depends,
    UploadFile,
    File,
    HTTPException,
    Query,
    Request,
    Header,
)
from fastapi.staticfiles import StaticFiles
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse, FileResponse, HTMLResponse
from sqlalchemy.orm import Session
from sqlalchemy import select, text
from sqlalchemy import delete

from .db import Base, engine, get_db, SessionLocal
from .models import Track, Artist, Album, Playlist, PlaylistTrack, DownloadJob, User
from .schemas import (
    TrackOut,
    ArtistOut,
    AlbumOut,
    PlaylistCreate,
    PlaylistOut,
    PlaylistTrackOut,
    DownloadRequest,
    DownloadJobOut,
    UserSignup,
    UserSignin,
    UserOut,
)
from .settings import settings
from .services.storage import ensure_dirs, store_upload
from .services.library import scan_default_library, scan_paths
from .services.onthespot import queue_download


app = FastAPI(title=settings.app_name)

static_dir = Path(__file__).resolve().parent.parent / "static"
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
def scan_library(path: str | None = None, db: Session = Depends(get_db)):
    if path:
        target = Path(path)
        if not target.exists():
            raise HTTPException(status_code=404, detail="Path not found")
        return scan_paths(db, [target])
    return scan_default_library(db)


@app.get("/tracks", response_model=List[TrackOut])
def list_tracks(
    limit: int = Query(50, ge=1, le=200),
    offset: int = Query(0, ge=0),
    db: Session = Depends(get_db),
):
    stmt = select(Track).order_by(Track.created_at.desc()).limit(limit).offset(offset)
    tracks = db.execute(stmt).scalars().all()
    return tracks


@app.get("/tracks/{track_id}", response_model=TrackOut)
def get_track(track_id: str, db: Session = Depends(get_db)):
    track = db.get(Track, track_id)
    if not track:
        raise HTTPException(status_code=404, detail="Track not found")
    return track


@app.delete("/tracks/{track_id}")
def delete_track(track_id: str, db: Session = Depends(get_db)):
    track = db.get(Track, track_id)
    if not track:
        raise HTTPException(status_code=404, detail="Track not found")

    path = Path(track.file_path)
    if path.exists():
        path.unlink(missing_ok=True)

    db.execute(delete(PlaylistTrack).where(PlaylistTrack.track_id == track_id))
    db.delete(track)
    db.commit()

    return {"status": "deleted"}


@app.get("/tracks/{track_id}/artwork")
def track_artwork(track_id: str, db: Session = Depends(get_db)):
    track = db.get(Track, track_id)
    if not track or not track.album:
        raise HTTPException(status_code=404, detail="Artwork not found")
    if not track.album.artwork_path:
        raise HTTPException(status_code=404, detail="Artwork not found")
    path = Path(track.album.artwork_path)
    if not path.exists():
        raise HTTPException(status_code=404, detail="Artwork not found")
    return FileResponse(path)


@app.get("/tracks/most-played", response_model=List[TrackOut])
def most_played(limit: int = Query(12, ge=1, le=100), db: Session = Depends(get_db)):
    stmt = (
        select(Track)
        .order_by(Track.play_count.desc(), Track.created_at.desc())
        .limit(limit)
    )
    return db.execute(stmt).scalars().all()


@app.get("/tracks/{track_id}/stream")
def stream_track(track_id: str, request: Request, db: Session = Depends(get_db)):
    track = db.get(Track, track_id)
    if not track:
        raise HTTPException(status_code=404, detail="Track not found")
    track.play_count = (track.play_count or 0) + 1
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


@app.post("/tracks/upload", response_model=TrackOut)
def upload_track(
    file: UploadFile = File(...),
    db: Session = Depends(get_db),
):
    ensure_dirs()
    temp_path = settings.downloads_dir / file.filename
    with temp_path.open("wb") as buffer:
        buffer.write(file.file.read())

    final_path = store_upload(temp_path, settings.music_dir)
    scan_paths(db, [final_path])

    track = db.execute(
        select(Track).where(Track.file_path == str(final_path))
    ).scalar_one_or_none()
    if not track:
        raise HTTPException(status_code=500, detail="Track not indexed")
    return track


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
        .join(Artist, isouter=True)
        .join(Album, isouter=True)
        .where(
            (Track.title.ilike(pattern))
            | (Artist.name.ilike(pattern))
            | (Album.title.ilike(pattern))
        )
    )
    return db.execute(stmt.limit(limit)).scalars().all()


@app.get("/playlists", response_model=List[PlaylistOut])
def list_playlists(
    x_auth_hash: str | None = Header(None),
    db: Session = Depends(get_db),
):
    stmt = select(Playlist).order_by(Playlist.created_at.desc())
    if x_auth_hash:
        stmt = stmt.where(Playlist.user_hash == x_auth_hash)
    return db.execute(stmt).scalars().all()


@app.post("/playlists", response_model=PlaylistOut)
def create_playlist(
    payload: PlaylistCreate,
    x_auth_hash: str | None = Header(None),
    db: Session = Depends(get_db),
):
    playlist = Playlist(
        name=payload.name,
        description=payload.description,
        user_hash=x_auth_hash or "",
    )
    db.add(playlist)
    db.commit()
    db.refresh(playlist)
    return playlist


@app.get("/playlists/{playlist_id}", response_model=PlaylistOut)
def get_playlist(playlist_id: str, db: Session = Depends(get_db)):
    playlist = db.get(Playlist, playlist_id)
    if not playlist:
        raise HTTPException(status_code=404, detail="Playlist not found")
    return playlist


@app.get("/playlists/{playlist_id}/tracks", response_model=List[PlaylistTrackOut])
def list_playlist_tracks(playlist_id: str, db: Session = Depends(get_db)):
    playlist = db.get(Playlist, playlist_id)
    if not playlist:
        raise HTTPException(status_code=404, detail="Playlist not found")
    stmt = (
        select(PlaylistTrack)
        .where(PlaylistTrack.playlist_id == playlist_id)
        .order_by(PlaylistTrack.position.asc())
    )
    return db.execute(stmt).scalars().all()


@app.post("/playlists/{playlist_id}/tracks", response_model=PlaylistTrackOut)
def add_track_to_playlist(
    playlist_id: str,
    track_id: str,
    x_auth_hash: str | None = None,
    db: Session = Depends(get_db),
):
    playlist = db.get(Playlist, playlist_id)
    track = db.get(Track, track_id)
    if not playlist or not track:
        raise HTTPException(status_code=404, detail="Playlist or track not found")
    if x_auth_hash and playlist.user_hash != x_auth_hash:
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


@app.delete("/playlists/{playlist_id}/tracks/{track_id}")
def remove_track_from_playlist(
    playlist_id: str,
    track_id: str,
    x_auth_hash: str | None = None,
    db: Session = Depends(get_db),
):
    playlist = db.get(Playlist, playlist_id)
    if not playlist:
        raise HTTPException(status_code=404, detail="Playlist not found")
    if playlist.is_liked:
        raise HTTPException(status_code=403, detail="Cannot remove from Liked Songs")
    if x_auth_hash and playlist.user_hash != x_auth_hash:
        raise HTTPException(status_code=403, detail="Not your playlist")

    link = db.execute(
        select(PlaylistTrack).where(
            PlaylistTrack.playlist_id == playlist_id,
            PlaylistTrack.track_id == track_id,
        )
    ).scalar_one_or_none()
    if not link:
        raise HTTPException(status_code=404, detail="Track not in playlist")

    db.delete(link)
    db.commit()
    return {"status": "removed"}


@app.delete("/playlists/{playlist_id}")
def delete_playlist(
    playlist_id: str, x_auth_hash: str | None = None, db: Session = Depends(get_db)
):
    playlist = db.get(Playlist, playlist_id)
    if not playlist:
        raise HTTPException(status_code=404, detail="Playlist not found")
    if playlist.is_liked:
        raise HTTPException(status_code=403, detail="Cannot delete Liked Songs")
    if x_auth_hash and playlist.user_hash != x_auth_hash:
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
    from .services.onthespot import queue_download

    return queue_download(db, payload.query, payload.source or "auto", x_auth_hash)


@app.get("/downloads/{job_id}", response_model=DownloadJobOut)
def get_download_status(job_id: str, db: Session = Depends(get_db)):
    job = db.get(DownloadJob, job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Download job not found")
    return job


@app.post("/liked/{track_id}")
def toggle_liked(
    track_id: str, x_auth_hash: str | None = None, db: Session = Depends(get_db)
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
    track_id: str, x_auth_hash: str | None = None, db: Session = Depends(get_db)
):
    if not x_auth_hash:
        return {"liked": False}
    user = _get_user(db, x_auth_hash)
    if not user:
        return {"liked": False}
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


@app.get("/auth/me")
def auth_me(x_auth_hash: str | None = Header(None), db: Session = Depends(get_db)):
    if not x_auth_hash:
        raise HTTPException(status_code=401, detail="Not authenticated")
    user = _get_user(db, x_auth_hash)
    if not user:
        raise HTTPException(status_code=401, detail="Invalid auth hash")
    return user
