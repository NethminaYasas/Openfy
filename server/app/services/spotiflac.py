from __future__ import annotations

import os
import re
import sys
import threading
import logging
from pathlib import Path
import time
from concurrent.futures import ThreadPoolExecutor, TimeoutError as FutureTimeoutError

from mutagen import File as MutagenFile
from sqlalchemy.orm import Session

from ..models import DownloadJob, Track
from ..settings import settings
from .storage import ensure_dirs, is_audio_file, store_upload
from .library import scan_paths


def _resolve_apple_music_url(track_name: str, artist_name: str, duration_ms: int = 0) -> str | None:
    """Resolve an Apple Music track URL using iTunes Search API."""
    import urllib.parse
    try:
        first_artist = artist_name.split(",")[0].strip()
        query = f"{track_name} {first_artist}"
        url = f"https://itunes.apple.com/search?term={urllib.parse.quote(query)}&entity=song&limit=5"
        import requests
        resp = requests.get(url, timeout=15, headers={"User-Agent": "AppleMusic/1.0"})
        results = resp.json().get("results", [])
        if not results:
            return None

        best_match = None
        best_score = -1
        for r in results:
            score = 0
            t_name = r.get("trackName", "").lower()
            a_name = r.get("artistName", "").lower()
            if track_name.lower() in t_name or t_name in track_name.lower():
                score += 30
            if artist_name.lower() in a_name or a_name in artist_name.lower():
                score += 20
            t_time = r.get("trackTimeMillis", 0)
            if duration_ms > 0 and t_time > 0 and abs(duration_ms - t_time) <= 10000:
                score += 15
            if score > best_score:
                best_score = score
                best_match = r.get("trackViewUrl")

        return best_match
    except Exception as e:
        logger.warning("iTunes search failed: %s", e)
    return None


def _download_via_apple_proxy(track_url: str, output_dir: str, codec: str = "aac") -> str:
    """Download a track from Apple Music via zarz.moe proxy."""
    import requests
    api_url = "https://api.zarz.moe/v1/dl/app2"
    headers = {
        "Accept": "application/json",
        "Content-Type": "application/json",
        "User-Agent": "AppleMusic/1.0",
        "Origin": "https://music.apple.com",
        "Referer": "https://music.apple.com/"
    }
    logger.info("Downloading via Apple proxy: %s", track_url)
    job_resp = requests.post(
        api_url,
        json={"url": track_url, "codec": codec},
        headers=headers,
        timeout=30
    )
    if job_resp.headers.get("cf-mitigated", "").lower() == "challenge":
        raise Exception("Apple Music proxy blocked by Cloudflare")

    job_data = job_resp.json()
    stream_url = None

    if job_data.get("success") and job_data.get("stream_url"):
        stream_url = job_data["stream_url"]
    elif job_data.get("job_id"):
        # Queued download - poll for completion
        job_id = job_data["job_id"]
        deadline = time.time() + 600
        while time.time() < deadline:
            time.sleep(2.5)
            st_resp = requests.get(
                f"https://api.zarz.moe/v1/dl/app/status/{job_id}",
                headers=headers, timeout=15
            )
            st = st_resp.json()
            status = st.get("status", "").lower()
            if status == "completed":
                stream_url = f"https://api.zarz.moe/v1/dl/app/file/{job_id}"
                break
            elif status == "failed":
                raise Exception(f"Apple proxy failed: {st.get('error', 'unknown')}")

        if not stream_url:
            raise Exception("Apple Music proxy timed out")
    else:
        raise Exception(f"Apple Music proxy error: {job_data}")

    # Download the stream
    os.makedirs(output_dir, exist_ok=True)
    from urllib.parse import urlparse
    parsed = urlparse(track_url)
    path_parts = [p for p in parsed.path.split("/") if p]
    filename = path_parts[-1] if len(path_parts) > 1 else "track.m4a"
    if not filename.endswith(".m4a"):
        filename += ".m4a"
    output_path = os.path.join(output_dir, filename)

    with requests.get(stream_url, stream=True, timeout=30) as r:
        r.raise_for_status()
        with open(output_path, "wb") as f:
            for chunk in r.iter_content(chunk_size=8192):
                if chunk:
                    f.write(chunk)
    logger.info("Downloaded via Apple proxy: %s", output_path)
    return output_path


def _extract_source_id(url: str) -> str | None:
    """Extract track ID from Spotify or Apple Music URL."""
    # Spotify: https://open.spotify.com/track/xyz123?...
    spotify_match = re.search(r"spotify\.com/track/([a-zA-Z0-9]+)", url)
    if spotify_match:
        return f"spotify:{spotify_match.group(1)}"

    # Apple Music: https://music.apple.com/us/track/name/id123456789
    apple_match = re.search(r"music\.apple\.com/[^/]+/track/[^/]+/(\d+)", url)
    if apple_match:
        return f"apple:{apple_match.group(1)}"

    return None


logger = logging.getLogger(__name__)

SPOTIFY_TRACK_SOURCE_OVERRIDES: dict[str, str] = {
    "6V9CHG6y1FmHiLv3REsCy8": "https://music.youtube.com/watch?v=iIm4gcybpsI",
    "2z1xxec9iMmanvQEYsuJUO": "https://music.youtube.com/watch?v=zKCij1se4lo",
    "17LHJ9PlRZEHcUruRd7mll": "https://music.youtube.com/watch?v=SSu75qEX3Kg",
}

# Local SpotiFLAC source
SPOTIFLAC_SRC = Path(__file__).resolve().parents[2] / "SpotiFLAC"
_spotiflac_added = False


def _normalize_for_match(text: str) -> str:
    return re.sub(r"[^a-z0-9]+", " ", text.lower()).strip()


def _extract_downloaded_title(path: Path) -> str:
    audio = MutagenFile(path)
    if not audio:
        return ""
    tags = audio.tags or {}
    title = tags.get("TIT2") or tags.get("title") or tags.get("TITLE")
    if isinstance(title, (list, tuple)):
        title = title[0] if title else ""
    if title is None:
        return ""
    if hasattr(title, "text"):
        text = getattr(title, "text")
        if isinstance(text, (list, tuple)):
            return str(text[0]).strip() if text else ""
        return str(text).strip()
    return str(title).strip()


def _extract_downloaded_duration_ms(path: Path) -> int:
    audio = MutagenFile(path)
    if not audio or not getattr(audio, "info", None):
        return 0
    duration = getattr(audio.info, "length", 0) or 0
    return int(float(duration) * 1000)


def _extract_downloaded_artist(path: Path) -> str:
    audio = MutagenFile(path)
    if not audio:
        return ""
    tags = audio.tags or {}
    artist = tags.get("TPE1") or tags.get("artist") or tags.get("ARTIST")
    if isinstance(artist, (list, tuple)):
        artist = artist[0] if artist else ""
    if artist is None:
        return ""
    if hasattr(artist, "text"):
        text = getattr(artist, "text")
        if isinstance(text, (list, tuple)):
            return str(text[0]).strip() if text else ""
        return str(text).strip()
    return str(artist).strip()


def _has_artist_overlap(expected_artist: str, actual_artist: str) -> bool:
    def tokens(value: str) -> set[str]:
        cleaned = re.sub(r"[^a-z0-9]+", " ", (value or "").lower()).strip()
        return {t for t in cleaned.split() if len(t) >= 3}

    exp_tokens = tokens(expected_artist)
    act_tokens = tokens(actual_artist)
    if not exp_tokens or not act_tokens:
        return False
    return len(exp_tokens & act_tokens) >= 1


def _validate_download_against_expected(
    downloaded_path: Path, track_info: dict
) -> None:
    expected_title = str(track_info.get("name", "")).strip()
    expected_artist = str(track_info.get("artist", "")).strip()
    expected_duration_ms = int(track_info.get("duration_ms", 0) or 0)

    if not expected_title:
        raise Exception("Missing expected title metadata from URL")
    if not expected_artist:
        raise Exception("Missing expected artist metadata from URL")
    if expected_duration_ms <= 0:
        raise Exception("Missing expected duration metadata from URL")

    actual_title = _extract_downloaded_title(downloaded_path)
    if actual_title:
        exp_norm = _normalize_for_match(expected_title)
        act_norm = _normalize_for_match(actual_title)
        if exp_norm not in act_norm and act_norm not in exp_norm:
            raise Exception(
                f"Downloaded title mismatch (expected '{expected_title}', got '{actual_title}')"
            )

    actual_duration_ms = _extract_downloaded_duration_ms(downloaded_path)
    if actual_duration_ms <= 0:
        raise Exception("Could not read downloaded track duration")

    actual_artist = _extract_downloaded_artist(downloaded_path)
    if actual_artist and not _has_artist_overlap(expected_artist, actual_artist):
        raise Exception(
            f"Downloaded artist mismatch (expected '{expected_artist}', got '{actual_artist}')"
        )

    duration_diff = abs(actual_duration_ms - expected_duration_ms)
    duration_tolerance_ms = 5000
    if duration_diff > duration_tolerance_ms:
        print(
            f"[WARNING] Downloaded duration mismatch (expected {expected_duration_ms}ms, got {actual_duration_ms}ms)"
        )


def _ensure_spotiflac_import() -> None:
    global _spotiflac_added
    if _spotiflac_added:
        return
    src = SPOTIFLAC_SRC.resolve()
    # Check for local SpotiFLAC directory (either as SpotiFLAC/ subdir or directly)
    local_spotiflac = src / "SpotiFLAC" if src.name != "SpotiFLAC" else src
    if src.is_dir() and (local_spotiflac.exists() or src.exists()):
        if str(src) not in sys.path:
            sys.path.insert(0, str(src))
        _spotiflac_added = True


def _append_log(db, job: DownloadJob, text: str) -> None:
    if not text:
        return
    job.log = f"{job.log}\n{text}" if job.log else text
    db.commit()


def _download_with_yt_music(
    job_id: str, query: str, db_url: str, user_hash: str | None = None, artist_url: str | None = None, album_source_id: str | None = None
) -> None:
    """Download from Apple Music or Spotify URL using ytmusicapi (official audio tracks)."""
    import logging
    logger = logging.getLogger(__name__)
    logger.info(f"[DOWNLOAD] Starting download job {job_id}: query={query}, album_source_id={album_source_id}")

    from sqlalchemy import create_engine
    from sqlalchemy.orm import sessionmaker

    engine = create_engine(
        db_url,
        connect_args={"check_same_thread": False}
        if db_url.startswith("sqlite")
        else {},
    )
    SessionLocal = sessionmaker(bind=engine, autoflush=False, autocommit=False)

    db = SessionLocal()
    try:
        job = db.get(DownloadJob, job_id)
        if not job:
            return

        job.status = "running"
        db.commit()

        try:
            ensure_dirs()
            _append_log(db, job, f"Starting download to {settings.downloads_dir}")

            is_spotify = "open.spotify.com" in query or "play.spotify.com" in query
            is_apple_music = "music.apple.com" in query

            if not is_spotify and not is_apple_music:
                raise Exception("Only Spotify and Apple Music URLs are supported")

            _ensure_spotiflac_import()
            from SpotiFLAC.appleDL import AppleMusicDownloader
            downloader = AppleMusicDownloader()

            if is_apple_music:
                downloaded_file = downloader.download_by_apple_music_url(
                    query, str(settings.downloads_dir)
                )
            else:
                downloaded_file = downloader.download_from_spotify(
                    query, str(settings.downloads_dir)
                )

            _append_log(db, job, f"Download complete: {Path(downloaded_file).name}")

            downloaded_path = Path(downloaded_file)

            # Move to library and scan
            if is_audio_file(downloaded_path):
                moved = store_upload(
                    downloaded_path,
                    settings.music_dir,
                )
                source_id = _extract_source_id(query)
                album_source_id = job.album_source_id if job else None
                if moved:
                    scan_paths(
                        db,
                        [moved],
                        user_hash=user_hash,
                        source_id=source_id,
                        source_url=query,
                        artist_url=artist_url,
                        album_source_id=album_source_id,
                    )
                    _append_log(db, job, "Scan complete - track added to library")
                    job.status = "completed"
                    job.output_path = str(moved)
                    job.source = "youtube_music"
                else:
                    job.status = "failed"
                    _append_log(db, job, "Failed to move file to library")
            else:
                job.status = "failed"
                _append_log(db, job, "Downloaded file is not a recognized audio file")

        except ImportError:
            _append_log(db, job, f"Downloader not found at {SPOTIFLAC_SRC}")
            job.status = "failed"
        except Exception as e:
            logger.exception("Download failed for job %s", job_id)
            _append_log(db, job, f"Error: {e}")
            job.status = "failed"

        db.commit()
    finally:
        db.close()


def _run_download(
    job_id: str, query: str, db_url: str, user_hash: str | None = None, artist_url: str | None = None
) -> None:
    """Download from Spotify/other URLs using SpotiFLAC."""
    from sqlalchemy import create_engine
    from sqlalchemy.orm import sessionmaker

    engine = create_engine(
        db_url,
        connect_args={"check_same_thread": False}
        if db_url.startswith("sqlite")
        else {},
    )
    SessionLocal = sessionmaker(bind=engine, autoflush=False, autocommit=False)

    db = SessionLocal()
    try:
        job = db.get(DownloadJob, job_id)
        if not job:
            return

        job.status = "running"
        db.commit()

        # Extract source_id for duplicate detection
        source_id = _extract_source_id(query)

        try:
            _ensure_spotiflac_import()
            from SpotiFLAC import SpotiFLAC

            ensure_dirs()

            logger.info("SpotiFLAC downloading %s to %s", query, settings.downloads_dir)
            _append_log(db, job, f"Starting download to {settings.downloads_dir}")

            files_before = set(
                p for p in settings.downloads_dir.rglob("*") if p.is_file()
            )

            SpotiFLAC(
                url=query,
                output_dir=str(settings.downloads_dir),
                services=["qobuz", "tidal", "deezer", "amazon", "spoti", "youtube"],
                use_artist_subfolders=True,
            )

            _append_log(db, job, "Download process finished, scanning for audio files")

            moved_files = []
            for attempt in range(6):
                time.sleep(5)
                for file in settings.downloads_dir.rglob("*"):
                    if file.is_file() and is_audio_file(file):
                        _append_log(db, job, f"Found audio: {file.name}")
                        moved_files.append(store_upload(file, settings.music_dir))

                if moved_files:
                    break

                files_after = set(
                    p for p in settings.downloads_dir.rglob("*") if p.is_file()
                )
                new_files = files_after - files_before
                if new_files and attempt < 5:
                    _append_log(
                        db,
                        job,
                        f"Waiting for download to complete... (attempt {attempt + 1})",
                    )
                    continue
                elif not new_files and attempt < 5:
                    _append_log(
                        db,
                        job,
                        f"Waiting for download to complete... (attempt {attempt + 1})",
                    )

            _append_log(db, job, f"Moved {len(moved_files)} files to library")

            if not moved_files:
                files_after = set(
                    p for p in settings.downloads_dir.rglob("*") if p.is_file()
                )
                new_files = files_after - files_before
                if new_files:
                    _append_log(
                        db,
                        job,
                        f"Non-audio files created: {', '.join(f.name for f in new_files)}",
                    )
                job.status = "failed"
                job.log = (job.log or "") + "\nNo audio files found - check the URL."
                db.commit()
                return

            # Get album_source_id from job
            album_source_id = job.album_source_id if job else None

            scan_paths(
                db,
                moved_files,
                user_hash=user_hash,
                source_id=source_id,
                source_url=query,
                artist_url=artist_url,
                album_source_id=album_source_id,
            )
            _append_log(db, job, "Scan complete - track(s) added to library")
            job.status = "completed"
            if moved_files:
                job.output_path = str(moved_files[0])
            job.source = "spotiflac"

        except ImportError:
            _append_log(db, job, f"SpotiFLAC source not found at {SPOTIFLAC_SRC}")
            job.status = "failed"
        except Exception as e:
            logger.exception("Download failed for job %s", job_id)
            _append_log(db, job, f"Error: {e}")
            job.status = "failed"

        db.commit()
    finally:
        db.close()


def queue_download(
    db: Session, query: str, source: str = "auto", user_hash: str | None = None, artist_url: str | None = None,
    album_source_id: str | None = None,
) -> DownloadJob:
    job = DownloadJob(
        source="spotiflac", query=query, status="queued", user_hash=user_hash,
        album_source_id=album_source_id,
    )
    db.add(job)
    db.commit()
    db.refresh(job)

    if not (query.startswith("http://") or query.startswith("https://")):
        job.status = "failed"
        job.log = "Downloader only accepts full URLs. Paste a complete https:// link."
        db.commit()
        return job

    # Check for duplicate track by source_id or title+artist (Spotify/Apple Music URLs)
    from sqlalchemy import select

    source_id = _extract_source_id(query)
    is_apple = "music.apple.com" in query
    is_spotify = "open.spotify.com" in query or "play.spotify.com" in query

    if source_id:
        # Check by source_id first
        existing = db.execute(
            select(Track).where(Track.source_id == source_id)
        ).scalar_one_or_none()
        if existing:
            job.status = "failed"
            job.log = f"Track already in library: {existing.title}"
            db.commit()
            return job

    # Fuzzy duplicate check by title + artist for any URL
    is_apple = "music.apple.com" in query
    is_spotify = "open.spotify.com" in query or "play.spotify.com" in query
    is_youtube_music = "music.youtube.com" in query or "youtube.com/watch" in query
    if is_apple or is_spotify or is_youtube_music:
        try:
            _ensure_spotiflac_import()
            from SpotiFLAC.appleDL import AppleMusicDownloader
            downloader = AppleMusicDownloader()
            url_type = downloader.parse_url_type(query)
            track_info = None
            if url_type == "spotify":
                track_info = downloader._extract_spotify_metadata(query)
            elif url_type == "apple":
                parsed = downloader.parse_apple_music_url(query)
                if parsed and parsed.get("track_id"):
                    track_info = downloader.get_track_info(parsed["track_id"])
            if track_info:
                expected_title = _normalize_for_match(str(track_info.get("name", "")))
                expected_artist = _normalize_for_match(str(track_info.get("artist", "")))
                if expected_title and expected_artist:
                    all_tracks = db.execute(select(Track)).scalars().all()
                    for t in all_tracks:
                        if _normalize_for_match(t.title) == expected_title and _normalize_for_match(t.artist.name if t.artist else "") == expected_artist:
                            job.status = "failed"
                            job.log = f"Duplicate track already in library: {t.title} by {t.artist.name if t.artist else 'Unknown'}"
                            db.commit()
                            return job
        except Exception:
            pass  # Don't block download if metadata fetch fails

    # Route Apple Music, Spotify, and YouTube Music URLs to the ytmusicapi-based downloader
    is_apple = "music.apple.com" in query
    is_spotify = "open.spotify.com" in query or "play.spotify.com" in query
    is_youtube_music = "music.youtube.com" in query or "youtube.com/watch" in query
    if is_apple or is_spotify or is_youtube_music:
        job.source = "spotify" if is_spotify else ("apple_music" if is_apple else "youtube_music")
        db.commit()
        thread = threading.Thread(
            target=lambda: _download_with_yt_music(
                job.id, query, settings.database_url, user_hash, artist_url=artist_url, album_source_id=album_source_id
            ),
            daemon=True,
        )
        thread.start()
        return job

    # All other URLs go through SpotiFLAC
    thread = threading.Thread(
        target=_run_download,
        args=(job.id, query, settings.database_url, user_hash, artist_url),
        daemon=True,
    )
    thread.start()

    return job
