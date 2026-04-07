from __future__ import annotations

import threading
import logging
from pathlib import Path

from sqlalchemy.orm import Session

from ..models import DownloadJob
from ..settings import settings
from .storage import ensure_dirs, is_audio_file, store_upload
from .library import scan_paths

logger = logging.getLogger(__name__)


def _append_log(job: DownloadJob, text: str) -> None:
    if not text:
        return
    if job.log:
        job.log = f"{job.log}\n{text}"
    else:
        job.log = text


def _run_download(
    job_id: str, query: str, db_url: str, user_hash: str | None = None
) -> None:
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
            from SpotiFLAC import SpotiFLAC

            ensure_dirs()

            logger.info(
                "SpotiFLAC downloading %s to %s", query, settings.downloads_dir
            )
            _append_log(job, f"Starting download to {settings.downloads_dir}")

            files_before = set(
                p for p in settings.downloads_dir.rglob("*") if p.is_file()
            )

            # Try tidal first (lossless), fall back to youtube (universal coverage)
            SpotiFLAC(
                url=query,
                output_dir=str(settings.downloads_dir),
                services=["tidal", "youtube"],
                use_artist_subfolders=False,
                filename_format="{title} - {artist}",
            )

            _append_log(job, "Download process finished, scanning for audio files")

            # Retry scan a few times for slow downloads
            import time
            for attempt in range(6):
                time.sleep(5)
                moved_files = []
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
                if not new_files and attempt < 5:
                    _append_log(job, f"Waiting for download to complete... (attempt {attempt + 1})")
                    continue
                elif new_files and attempt < 5:
                    _append_log(job, f"Waiting for download to complete... found temp files (attempt {attempt + 1})")
                    continue

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
                _append_log(
                    job,
                    "No audio files downloaded - check the URL.",
                )
                job.status = "failed"
                job.log = (
                    job.log or ""
                ) + "\nNo audio files found."
                db.commit()
                return

            scan_paths(db, moved_files, user_hash=user_hash)
            _append_log(job, "Scan complete - track(s) added to library")
            job.status = "completed"
            job.output_path = str(settings.music_dir)
            job.source = "spotiflac"

        except ImportError:
            _append_log(job, "SpotiFLAC not installed. Run: pip install SpotiFLAC")
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
    job = DownloadJob(source="spotiflac", query=query, status="queued", user_hash=user_hash)
    db.add(job)
    db.commit()
    db.refresh(job)

    if not (query.startswith("http://") or query.startswith("https://")):
        job.status = "failed"
        job.log = "Downloader only accepts full URLs. Paste a complete https:// link."
        db.commit()
        return job

    thread = threading.Thread(
        target=_run_download,
        args=(job.id, query, settings.database_url, user_hash),
        daemon=True,
    )
    thread.start()

    return job
