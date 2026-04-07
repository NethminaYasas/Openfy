from __future__ import annotations

from pathlib import Path
from typing import Iterable

from mutagen import File as MutagenFile
from mutagen.id3 import ID3
from sqlalchemy.orm import Session
from sqlalchemy import select

from ..models import Artist, Album, Track
from ..settings import settings
from .storage import ensure_dirs
from .storage import is_audio_file


def _safe_int(value):
    try:
        if isinstance(value, (list, tuple)):
            value = value[0]
        if value is None:
            return None
        text = str(value).split("/")[0]
        return int(text)
    except (ValueError, TypeError):
        return None


def _normalize(value, fallback="Unknown"):
    if isinstance(value, (list, tuple)):
        value = value[0]
    if value is None:
        return fallback
    text = str(value).strip()
    return text or fallback


def _get_or_create_artist(db: Session, name: str) -> Artist:
    stmt = select(Artist).where(Artist.name == name)
    artist = db.execute(stmt).scalar_one_or_none()
    if artist:
        return artist
    artist = Artist(name=name)
    db.add(artist)
    db.flush()
    return artist


def _get_or_create_album(db: Session, title: str, artist_id: str | None, year: int | None) -> Album:
    stmt = select(Album).where(Album.title == title, Album.artist_id == artist_id)
    album = db.execute(stmt).scalar_one_or_none()
    if album:
        if year and album.year != year:
            album.year = year
        return album
    album = Album(title=title, artist_id=artist_id, year=year)
    db.add(album)
    db.flush()
    return album


def _extract_artwork(path: Path) -> tuple[bytes, str] | None:
    if path.suffix.lower() == ".mp3":
        try:
            id3 = ID3(path)
            apic_list = id3.getall("APIC")
            if apic_list:
                return apic_list[0].data, ".jpg"
        except Exception:
            pass

    audio = MutagenFile(path)
    if not audio:
        return None

    if hasattr(audio, "tags") and audio.tags:
        tags = audio.tags
        for key in tags.keys():
            if str(key).startswith("APIC"):
                apic = tags.get(key)
                if apic and getattr(apic, "data", None):
                    return apic.data, ".jpg"
        if "covr" in tags:
            covr = tags.get("covr")
            if covr:
                return covr[0], ".jpg"

    if hasattr(audio, "pictures") and audio.pictures:
        pic = audio.pictures[0]
        if getattr(pic, "data", None):
            return pic.data, ".jpg"

    return None


def _store_artwork(album: Album, file_path: Path) -> None:
    ensure_dirs()
    artwork = _extract_artwork(file_path)
    if not artwork:
        return
    data, ext = artwork
    target = settings.artwork_dir / f"{album.id}{ext}"
    if not target.exists():
        target.write_bytes(data)
    album.artwork_path = str(target)


def _upsert_track(db: Session, file_path: Path, metadata: dict, user_hash: str | None = None) -> Track:
    existing = db.execute(select(Track).where(Track.file_path == str(file_path))).scalar_one_or_none()

    artist_name = _normalize(metadata.get("artist"))
    album_title = _normalize(metadata.get("album"), fallback=None) if metadata.get("album") else None
    title = _normalize(metadata.get("title"), fallback=file_path.stem)

    artist = _get_or_create_artist(db, artist_name) if artist_name else None
    if not album_title:
        album_title = title
    album = _get_or_create_album(db, album_title, artist.id if artist else None, metadata.get("year"))
    if album:
        _store_artwork(album, file_path)

    if existing:
        existing.title = title
        existing.artist_id = artist.id if artist else None
        existing.album_id = album.id if album else None
        existing.duration = metadata.get("duration")
        existing.bitrate = metadata.get("bitrate")
        existing.sample_rate = metadata.get("sample_rate")
        existing.channels = metadata.get("channels")
        existing.track_no = metadata.get("track_no")
        existing.disc_no = metadata.get("disc_no")
        existing.file_size = metadata.get("file_size")
        existing.mime_type = metadata.get("mime_type")
        if user_hash and not existing.user_hash:
            existing.user_hash = user_hash
        return existing

    track = Track(
        title=title,
        file_path=str(file_path),
        file_size=metadata.get("file_size"),
        duration=metadata.get("duration"),
        mime_type=metadata.get("mime_type"),
        bitrate=metadata.get("bitrate"),
        sample_rate=metadata.get("sample_rate"),
        channels=metadata.get("channels"),
        track_no=metadata.get("track_no"),
        disc_no=metadata.get("disc_no"),
        artist_id=artist.id if artist else None,
        album_id=album.id if album else None,
        user_hash=user_hash,
    )
    db.add(track)
    return track


def _read_metadata(path: Path) -> dict:
    info = {
        "title": None,
        "artist": None,
        "album": None,
        "year": None,
        "duration": None,
        "bitrate": None,
        "sample_rate": None,
        "channels": None,
        "track_no": None,
        "disc_no": None,
        "file_size": path.stat().st_size if path.exists() else None,
        "mime_type": None,
    }

    audio = MutagenFile(path)
    if not audio:
        return info

    info["duration"] = float(getattr(audio.info, "length", 0)) if getattr(audio, "info", None) else None
    info["bitrate"] = int(getattr(audio.info, "bitrate", 0) / 1000) if getattr(audio, "info", None) else None
    info["sample_rate"] = getattr(audio.info, "sample_rate", None) if getattr(audio, "info", None) else None
    info["channels"] = getattr(audio.info, "channels", None) if getattr(audio, "info", None) else None
    info["mime_type"] = audio.mime[0] if getattr(audio, "mime", None) else None

    tags = audio.tags or {}
    info["title"] = tags.get("TIT2") or tags.get("title") or tags.get("TITLE")
    info["artist"] = tags.get("TPE1") or tags.get("artist") or tags.get("ARTIST")
    info["album"] = tags.get("TALB") or tags.get("album") or tags.get("ALBUM")
    info["track_no"] = _safe_int(tags.get("TRCK") or tags.get("tracknumber"))
    info["disc_no"] = _safe_int(tags.get("TPOS") or tags.get("discnumber"))
    info["year"] = _safe_int(tags.get("TDRC") or tags.get("date") or tags.get("YEAR"))

    return info


def scan_paths(db: Session, paths: Iterable[Path], user_hash: str | None = None) -> dict:
    scanned = 0
    created = 0
    for path in paths:
        if path.is_dir():
            for file in path.rglob("*"):
                if is_audio_file(file):
                    scanned += 1
                    before = db.query(Track).filter_by(file_path=str(file)).first()
                    _upsert_track(db, file, _read_metadata(file), user_hash=user_hash)
                    if before is None:
                        created += 1
        elif path.is_file() and is_audio_file(path):
            scanned += 1
            before = db.query(Track).filter_by(file_path=str(path)).first()
            _upsert_track(db, path, _read_metadata(path), user_hash=user_hash)
            if before is None:
                created += 1

    db.commit()
    return {"scanned": scanned, "new": created}


def scan_default_library(db: Session) -> dict:
    return scan_paths(db, [settings.music_dir])
