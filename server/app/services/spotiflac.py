from __future__ import annotations

import threading
from pathlib import Path

from sqlalchemy.orm import Session

from ..models import DownloadJob
from ..settings import settings
from .storage import ensure_dirs, is_audio_file, store_upload
from .library import scan_paths


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

            SpotiFLAC(
                url=query,
                output_dir=str(settings.downloads_dir),
                services=["tidal", "qobuz", "amazon", "spoti", "apple"],
                use_artist_subfolders=True,
            )
            ensure_dirs()
            moved_files = []
            for file in settings.downloads_dir.rglob("*"):
                if file.is_file() and is_audio_file(file):
                    _append_log(job, f"Found: {file.name}")
                    moved_files.append(store_upload(file, settings.music_dir))
            _append_log(job, f"Moved {len(moved_files)} files to library")
            if moved_files:
                scan_paths(db, moved_files)
                _append_log(job, "Scan complete")
            else:
                _append_log(
                    job,
                    "No audio files found in downloads dir, scanning music dir directly",
                )
                scan_paths(db, [settings.music_dir])
            job.status = "completed"
            job.output_path = str(settings.downloads_dir)
            job.source = "spotiflac"
        except ImportError:
            _append_log(job, "SpotiFLAC not installed. Run: pip install SpotiFLAC")
            job.status = "failed"
        except Exception as e:
            _append_log(job, str(e))
            job.status = "failed"

        db.commit()
    finally:
        db.close()


def queue_download(
    db: Session, query: str, source: str = "auto", user_hash: str | None = None
) -> DownloadJob:
    job = DownloadJob(source="spotiflac", query=query, status="queued")
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

    thread = threading.Thread(
        target=_run_download,
        args=(job.id, query, settings.database_url, user_hash),
        daemon=True,
    )
    thread.start()

    return job
