from __future__ import annotations

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


def _extract_source_id(url: str) -> str | None:
    """Extract track ID from Spotify or Apple Music URL."""
    # Spotify: https://open.spotify.com/track/xyz123?...
    spotify_match = re.search(r'spotify\.com/track/([a-zA-Z0-9]+)', url)
    if spotify_match:
        return f"spotify:{spotify_match.group(1)}"

    # Apple Music: https://music.apple.com/us/track/name/id123456789
    apple_match = re.search(r'music\.apple\.com/[^/]+/track/[^/]+/(\d+)', url)
    if apple_match:
        return f"apple:{apple_match.group(1)}"

    return None

logger = logging.getLogger(__name__)

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


def _validate_download_against_expected(downloaded_path: Path, track_info: dict) -> None:
    expected_title = str(track_info.get("name", "")).strip()
    expected_duration_ms = int(track_info.get("duration_ms", 0) or 0)

    if not expected_title:
        raise Exception("Missing expected title metadata from URL")
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

    duration_diff = abs(actual_duration_ms - expected_duration_ms)
    duration_tolerance_ms = 3000
    if duration_diff > duration_tolerance_ms:
        raise Exception(
            f"Duration mismatch (expected {expected_duration_ms}ms, got {actual_duration_ms}ms)"
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
    job_id: str, query: str, db_url: str, user_hash: str | None = None
) -> None:
    """Download from Apple Music or Spotify URL using ytmusicapi (official audio tracks)."""
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
            _ensure_spotiflac_import()
            from SpotiFLAC.appleDL import AppleMusicDownloader

            ensure_dirs()
            _append_log(db, job, f"Starting download to {settings.downloads_dir}")

            downloader = AppleMusicDownloader()
            expected_track_info: dict | None = None

            # Auto-detect URL type and download
            url_type = downloader.parse_url_type(query)
            if url_type == "spotify":
                expected_track_info = downloader._extract_spotify_metadata(query)
                if not expected_track_info:
                    raise Exception("Could not extract Spotify metadata for strict verification")
                if not expected_track_info.get("duration_ms"):
                    raise Exception("Spotify duration metadata missing; refusing non-verifiable download")
                _append_log(db, job, "Spotify track detected, searching for audio source...")

                # Run download with timeout to prevent hanging
                def do_download():
                    return downloader.download_from_spotify(
                        spotify_url=query,
                        output_dir=str(settings.downloads_dir),
                    )

                with ThreadPoolExecutor(max_workers=1) as executor:
                    future = executor.submit(do_download)
                    try:
                        downloaded_file = future.result(timeout=600)  # 10 minute timeout
                    except FutureTimeoutError:
                        _append_log(db, job, "Download timed out after 10 minutes")
                        job.status = "failed"
                        db.commit()
                        return
                    except Exception as e:
                        _append_log(db, job, f"Download failed: {e}")
                        job.status = "failed"
                        db.commit()
                        return
            else:
                parsed = downloader.parse_apple_music_url(query)
                if not parsed or not parsed.get("track_id"):
                    raise Exception("Could not parse Apple Music track URL")
                expected_track_info = downloader.get_track_info(parsed["track_id"])
                if not expected_track_info:
                    raise Exception("Could not extract Apple Music metadata for strict verification")
                if not expected_track_info.get("duration_ms"):
                    raise Exception("Apple Music duration metadata missing; refusing non-verifiable download")
                _append_log(db, job, "Apple Music track detected, searching for audio source...")

                def do_download():
                    return downloader.download_by_apple_music_url(
                        apple_music_url=query,
                        output_dir=str(settings.downloads_dir),
                    )

                with ThreadPoolExecutor(max_workers=1) as executor:
                    future = executor.submit(do_download)
                    try:
                        downloaded_file = future.result(timeout=600)  # 10 minute timeout
                    except FutureTimeoutError:
                        _append_log(db, job, "Download timed out after 10 minutes")
                        job.status = "failed"
                        db.commit()
                        return
                    except Exception as e:
                        _append_log(db, job, f"Download failed: {e}")
                        job.status = "failed"
                        db.commit()
                        return

            _append_log(db, job, f"Download complete: {Path(downloaded_file).name}")

            # Move to library and scan
            if is_audio_file(Path(downloaded_file)):
                downloaded_path = Path(downloaded_file)
                if expected_track_info:
                    _validate_download_against_expected(downloaded_path, expected_track_info)
                preferred_stem = (
                    str(expected_track_info.get("name", "")).strip()
                    if expected_track_info
                    else None
                )
                moved = store_upload(
                    downloaded_path,
                    settings.music_dir,
                    preferred_stem=preferred_stem or None,
                )
                source_id = _extract_source_id(query)
                if moved:
                    scan_paths(
                        db,
                        [moved],
                        user_hash=user_hash,
                        source_id=source_id,
                        source_url=query,
                    )
                    _append_log(db, job, "Scan complete - track added to library")
                    job.status = "completed"
                    job.output_path = str(settings.music_dir)
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
    job_id: str, query: str, db_url: str, user_hash: str | None = None
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

            logger.info(
                "SpotiFLAC downloading %s to %s", query, settings.downloads_dir
            )
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
                        db, job, f"Waiting for download to complete... (attempt {attempt + 1})"
                    )
                    continue
                elif not new_files and attempt < 5:
                    _append_log(
                        db, job, f"Waiting for download to complete... (attempt {attempt + 1})"
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

            scan_paths(
                db,
                moved_files,
                user_hash=user_hash,
                source_id=source_id,
                source_url=query,
            )
            _append_log(db, job, "Scan complete - track(s) added to library")
            job.status = "completed"
            job.output_path = str(settings.music_dir)
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
    db: Session, query: str, source: str = "auto", user_hash: str | None = None
) -> DownloadJob:
    job = DownloadJob(
        source="spotiflac", query=query, status="queued", user_hash=user_hash
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

    # Route Apple Music and Spotify URLs to the ytmusicapi-based downloader
    is_apple = "music.apple.com" in query
    is_spotify = "open.spotify.com" in query or "play.spotify.com" in query
    if is_apple or is_spotify:
        job.source = "spotify" if is_spotify else "apple_music"
        db.commit()
        thread = threading.Thread(
            target=lambda: _download_with_yt_music(job.id, query, settings.database_url, user_hash),
            daemon=True,
        )
        thread.start()
        return job

    # All other URLs go through SpotiFLAC
    thread = threading.Thread(
        target=_run_download,
        args=(job.id, query, settings.database_url, user_hash),
        daemon=True,
    )
    thread.start()

    return job
