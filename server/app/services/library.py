from __future__ import annotations

import hashlib
import re
from pathlib import Path
from typing import Iterable

from mutagen import File as MutagenFile
from mutagen.id3 import ID3
from sqlalchemy.orm import Session
from sqlalchemy import select, delete, func
from sqlalchemy.exc import IntegrityError

from ..models import Artist, Album, Track, track_artist
from ..settings import settings
from .storage import ensure_dirs
from .storage import is_audio_file


def _safe_int(value):
    try:
        if isinstance(value, (list, tuple)):
            value = value[0]
        if value is None:
            return None
        text = str(value).split("/")[0].strip()
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


def _parse_artist_names(raw_artists) -> list[str]:
    """Parse raw artist metadata (string or list) into a clean list of artist names."""
    artist_names = []
    if isinstance(raw_artists, str):
        # Split on common delimiters: comma, semicolon, slash, &, "and"
        parts = re.split(r'[,;/&]|\s+and\s+', raw_artists, flags=re.IGNORECASE)
        for name in parts:
            name = name.strip()
            if name:
                norm = _normalize(name, fallback=None)
                if norm and norm.lower() not in ("unknown", "unknown artist"):
                    artist_names.append(norm)
    elif isinstance(raw_artists, (list, tuple)):
        for name in raw_artists:
            norm = _normalize(name, fallback=None)
            if norm and norm.lower() not in ("unknown", "unknown artist"):
                artist_names.append(norm)
    else:
        # Handle None or other types
        artist_names = []
    return artist_names


def _get_primary_artist(db: Session, artist_name: str | None) -> Artist | None:
    """Get or create primary artist from artist name."""
    if not artist_name:
        return None
    return _get_or_create_artist(db, artist_name)


def _associate_track_artists(db: Session, track_id: int, artist_names: list[str]) -> None:
    """Clear old artist associations and insert new ones with position order."""
    if not track_id:
        return
    # Delete existing associations
    db.execute(delete(track_artist).where(track_artist.c.track_id == track_id))
    # Insert new associations with position
    for idx, name in enumerate(artist_names):
        artist_obj = _get_or_create_artist(db, name)
        db.execute(
            track_artist.insert().values(
                track_id=track_id,
                artist_id=artist_obj.id,
                position=idx,
            )
        )


def _build_track_from_metadata(
    metadata: dict,
    file_path: Path,
    title: str,
    duration: float | None,
    artist_id: str | None,
    album_id: str | None,
    user_hash: str | None,
    source_id: str | None = None,
    universal_track_id: str | None = None,
) -> Track:
    """Create a new Track instance from metadata (without adding to session)."""
    return Track(
        title=title,
        file_path=str(file_path),
        file_size=metadata.get("file_size"),
        duration=duration,
        mime_type=metadata.get("mime_type"),
        bitrate=metadata.get("bitrate"),
        sample_rate=metadata.get("sample_rate"),
        channels=metadata.get("channels"),
        track_no=metadata.get("track_no"),
        disc_no=metadata.get("disc_no"),
        artist_id=artist_id,
        album_id=album_id,
        user_hash=user_hash,
        source_id=source_id,
        universal_track_id=universal_track_id,
    )


def compute_universal_track_id(file_path: Path) -> str:
    """Stable content hash used as a cross-server track address."""
    hasher = hashlib.sha256()
    with file_path.open("rb") as handle:
        while True:
            chunk = handle.read(1024 * 1024)
            if not chunk:
                break
            hasher.update(chunk)
    return hasher.hexdigest()


def _upsert_track(db: Session, file_path: Path, metadata: dict, user_hash: str | None = None, source_id: str | None = None) -> Track:
    # 1. Parse artist names
    raw_artists = metadata.get("artist") or []
    artist_names = _parse_artist_names(raw_artists)

    # 2. Get primary artist
    primary_artist_name = artist_names[0] if artist_names else None
    primary_artist = _get_primary_artist(db, primary_artist_name)

    album_title = _normalize(metadata.get("album"), fallback=None) if metadata.get("album") else None
    title = _normalize(metadata.get("title"), fallback=file_path.stem)
    duration = metadata.get("duration")
    universal_track_id = compute_universal_track_id(file_path)

    # Check if track already exists by source_id first (Spotify/Apple Music duplicates)
    if source_id:
        existing = db.execute(select(Track).where(Track.source_id == source_id)).scalar_one_or_none()
        if existing:
            if not existing.universal_track_id:
                existing.universal_track_id = universal_track_id
                db.add(existing)
            # Track already exists from same source, return existing without updating
            return existing

    # Check if track already exists by file path
    existing = db.execute(select(Track).where(Track.file_path == str(file_path))).scalar_one_or_none()

    if existing:
        # Update existing track
        if not album_title:
            album_title = title
        album = _get_or_create_album(db, album_title, primary_artist.id if primary_artist else None, metadata.get("year"))
        if album:
            _store_artwork(album, file_path)

        existing.title = title
        existing.artist_id = primary_artist.id if primary_artist else None
        existing.album_id = album.id if album else None
        existing.duration = duration
        existing.bitrate = metadata.get("bitrate")
        existing.sample_rate = metadata.get("sample_rate")
        existing.channels = metadata.get("channels")
        existing.track_no = metadata.get("track_no")
        existing.disc_no = metadata.get("disc_no")
        existing.file_size = metadata.get("file_size")
        existing.mime_type = metadata.get("mime_type")
        if user_hash and not existing.user_hash:
            existing.user_hash = user_hash
        if not existing.universal_track_id:
            existing.universal_track_id = universal_track_id

        # Sync artist associations
        _associate_track_artists(db, existing.id, artist_names)

        db.add(existing)
        return existing

    # Track doesn't exist, try to create it
    if not album_title:
        album_title = title
    album = _get_or_create_album(db, album_title, primary_artist.id if primary_artist else None, metadata.get("year"))
    if album:
        _store_artwork(album, file_path)

    track = _build_track_from_metadata(
        metadata=metadata,
        file_path=file_path,
        title=title,
        duration=duration,
        artist_id=primary_artist.id if primary_artist else None,
        album_id=album.id if album else None,
        user_hash=user_hash,
        source_id=source_id,
        universal_track_id=universal_track_id,
    )
    db.add(track)
    try:
        db.flush()
    except IntegrityError:
        # Another process inserted the same track concurrently
        db.rollback()
        # Re-check if the track now exists
        existing = db.execute(select(Track).where(Track.file_path == str(file_path))).scalar_one_or_none()
        if existing:
            # Update the existing track with current metadata
            existing.title = title
            existing.artist_id = primary_artist.id if primary_artist else None
            existing.album_id = album.id if album else None
            existing.duration = duration
            existing.bitrate = metadata.get("bitrate")
            existing.sample_rate = metadata.get("sample_rate")
            existing.channels = metadata.get("channels")
            existing.track_no = metadata.get("track_no")
            existing.disc_no = metadata.get("disc_no")
            existing.file_size = metadata.get("file_size")
            existing.mime_type = metadata.get("mime_type")
            if user_hash and not existing.user_hash:
                existing.user_hash = user_hash
            if not existing.universal_track_id:
                existing.universal_track_id = universal_track_id

            # Sync artist associations
            _associate_track_artists(db, existing.id, artist_names)

            db.add(existing)
            return existing
        else:
            # This was a different integrity error, re-raise
            raise

    # Insert artist associations with position order
    _associate_track_artists(db, track.id, artist_names)

    return track


def _read_metadata(path: Path) -> dict:
    info = {
        "title": None,
        "artist": None,  # will be list of strings
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
    # Extract artists into a list from various tag formats
    artist_entries = []
    tpe1 = tags.get("TPE1")
    if tpe1:
        text_val = None
        if hasattr(tpe1, "text"):
            text_val = tpe1.text
        elif isinstance(tpe1, (list, tuple)):
            text_val = tpe1
        else:
            text_val = str(tpe1)
        if isinstance(text_val, list):
            for t in text_val:
                if t:
                    artist_entries.append(str(t).strip())
        else:
            if text_val:
                artist_entries.append(str(text_val).strip())
    for key in ("artist", "ARTIST"):
        val = tags.get(key)
        if val:
            if isinstance(val, list):
                for v in val:
                    if v:
                        artist_entries.append(str(v).strip())
            else:
                artist_entries.append(str(val).strip())

    split_artists = []
    for entry in artist_entries:
        parts = re.split(r'[,;/&]|\s+and\s+', entry, flags=re.IGNORECASE)
        for p in parts:
            p = p.strip()
            if p:
                split_artists.append(p)
    seen = set()
    artists = []
    for a in split_artists:
        norm = a.lower()
        if norm not in seen:
            seen.add(norm)
            artists.append(a)
    info["artist"] = artists if artists else None
    info["album"] = tags.get("TALB") or tags.get("album") or tags.get("ALBUM")
    info["track_no"] = _safe_int(tags.get("TRCK") or tags.get("tracknumber"))
    info["disc_no"] = _safe_int(tags.get("TPOS") or tags.get("discnumber"))
    info["year"] = _safe_int(tags.get("TDRC") or tags.get("date") or tags.get("YEAR"))

    return info


def scan_paths(db: Session, paths: Iterable[Path], user_hash: str | None = None, source_id: str | None = None) -> dict:
    # Collect all audio files first
    audio_files = []
    for path in paths:
        if path.is_dir():
            for file in path.rglob("*"):
                if is_audio_file(file):
                    audio_files.append(file)
        elif path.is_file() and is_audio_file(path):
            audio_files.append(path)

    scanned = len(audio_files)
    if scanned == 0:
        return {"scanned": 0, "new": 0}

    # Batch fetch existing tracks
    from sqlalchemy import select
    audio_file_strings = [str(f) for f in audio_files]
    existing_paths = set()
    if audio_file_strings:
        stmt = select(Track.file_path).where(Track.file_path.in_(audio_file_strings))
        result = db.execute(stmt)
        existing_paths = {row[0] for row in result}

    created = 0
    for file in audio_files:
        _upsert_track(db, file, _read_metadata(file), user_hash=user_hash, source_id=source_id)
        if str(file) not in existing_paths:
            created += 1

    db.commit()

    # If new tracks were created, update the global timestamp
    if created > 0:
        from ..main import update_track_timestamp
        update_track_timestamp()

    return {"scanned": scanned, "new": created}


def scan_default_library(db: Session) -> dict:
    return scan_paths(db, [settings.music_dir])
