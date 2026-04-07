from __future__ import annotations

import sys
import threading
import logging
from pathlib import Path
import time

from sqlalchemy.orm import Session

from ..models import DownloadJob
from ..settings import settings
from .storage import ensure_dirs, is_audio_file, store_upload
from .library import scan_paths

logger = logging.getLogger(__name__)

# Local SpotiFLAC source
SPOTIFLAC_SRC = Path(__file__).resolve().parents[3] / "../SpotiFLAC-Module-Version"
_spotiflac_added = False


def _ensure_spotiflac_import() -> None:
    global _spotiflac_added
    if _spotiflac_added:
        return
    src = SPOTIFLAC_SRC.resolve()
    if src.is_dir() and (src / "SpotiFLAC").is_dir():
        if str(src) not in sys.path:
            sys.path.insert(0, str(src))
        _spotiflac_added = True


def _append_log(job: DownloadJob, text: str) -> None:
    if not text:
        return
    job.log = f"{job.log}\n{text}" if job.log else text


def _download_apple_music(
    job_id: str, query: str, db_url: str, user_hash: str | None = None
) -> None:
    """Download from Apple Music URL using iTunes API + YouTube audio (no Spotify needed)."""
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
            _append_log(job, f"Starting Apple Music download to {settings.downloads_dir}")

            downloader = AppleMusicDownloader()

            files_before = set(
                p for p in settings.downloads_dir.rglob("*") if p.is_file()
            )

            # Download the track
            downloaded_file = downloader.download_by_apple_music_url(
                apple_music_url=query,
                output_dir=str(settings.downloads_dir),
            )

            _append_log(job, f"Download complete: {Path(downloaded_file).name}")

            # Move to library and scan
            if is_audio_file(Path(downloaded_file)):
                moved = store_upload(Path(downloaded_file), settings.music_dir)
                if moved:
                    scan_paths(db, [moved], user_hash=user_hash)
                    _append_log(job, "Scan complete - track added to library")
                    job.status = "completed"
                    job.output_path = str(settings.music_dir)
                    job.source = "apple_music"
                else:
                    job.status = "failed"
                    _append_log(job, "Failed to move file to library")
            else:
                job.status = "failed"
                _append_log(job, "Downloaded file is not a recognized audio file")

        except ImportError:
            _append_log(job, f"Apple Music downloader not found at {SPOTIFLAC_SRC}")
            job.status = "failed"
        except Exception as e:
            logger.exception("Apple Music download failed for job %s", job_id)
            _append_log(job, f"Error: {e}")
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

        try:
            _ensure_spotiflac_import()
            from SpotiFLAC import SpotiFLAC

            ensure_dirs()

            logger.info(
                "SpotiFLAC downloading %s to %s", query, settings.downloads_dir
            )
            _append_log(job, f"Starting download to {settings.downloads_dir}")

            files_before = set(
                p for p in settings.downloads_dir.rglob("*") if p.is_file()
            )

            SpotiFLAC(
                url=query,
                output_dir=str(settings.downloads_dir),
                services=["qobuz", "tidal", "deezer", "amazon", "spoti", "youtube"],
                use_artist_subfolders=True,
            )

            _append_log(job, "Download process finished, scanning for audio files")

            moved_files = []
            for attempt in range(6):
                time.sleep(5)
                for file in settings.downloads_dir.rglob("*"):
                    if file.is_file() and is_audio_file(file):
                        _append_log(job, f"Found audio: {file.name}")
                        moved_files.append(store_upload(file, settings.music_dir))

                if moved_files:
                    break

                files_after = set(
                    p for p in settings.downloads_dir.rglob("*") if p.is_file()
                )
                new_files = files_after - files_before
                if new_files and attempt < 5:
                    _append_log(
                        job, f"Waiting for download to complete... (attempt {attempt + 1})"
                    )
                    continue
                elif not new_files and attempt < 5:
                    _append_log(
                        job, f"Waiting for download to complete... (attempt {attempt + 1})"
                    )

            _append_log(job, f"Moved {len(moved_files)} files to library")

            if not moved_files:
                files_after = set(
                    p for p in settings.downloads_dir.rglob("*") if p.is_file()
                )
                new_files = files_after - files_before
                if new_files:
                    _append_log(
                        job,
                        f"Non-audio files created: {', '.join(f.name for f in new_files)}",
                    )
                job.status = "failed"
                job.log = (job.log or "") + "\nNo audio files found - check the URL."
                db.commit()
                return

            scan_paths(db, moved_files, user_hash=user_hash)
            _append_log(job, "Scan complete - track(s) added to library")
            job.status = "completed"
            job.output_path = str(settings.music_dir)
            job.source = "spotiflac"

        except ImportError:
            _append_log(job, f"SpotiFLAC source not found at {SPOTIFLAC_SRC}")
            job.status = "failed"
        except Exception as e:
            logger.exception("Download failed for job %s", job_id)
            _append_log(job, f"Error: {e}")
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

    # Route Apple Music URLs to the dedicated Apple Music downloader
    if "music.apple.com" in query:
        job.source = "apple_music"
        db.commit()
        thread = threading.Thread(
            target=_download_apple_music,
            args=(job.id, query, settings.database_url, user_hash),
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
