from __future__ import annotations

import json
import os
import shutil
import subprocess
import threading
from pathlib import Path

from sqlalchemy.orm import Session

from ..models import DownloadJob
from ..settings import settings
from .storage import ensure_dirs, is_audio_file, store_upload
from .library import scan_paths


def _ensure_ots_config() -> Path:
    settings.onthespot_config_dir.mkdir(parents=True, exist_ok=True)
    cfg_path = settings.onthespot_config_dir / "otsconfig.json"
    if not cfg_path.exists():
        cfg_path.write_text(
            json.dumps(
                {
                    "audio_download_path": str(settings.downloads_dir),
                    "video_download_path": str(settings.downloads_dir),
                },
                indent=4,
            ),
            encoding="utf-8",
        )
    return cfg_path


def _ensure_votify_config() -> Path:
    settings.votify_config_dir.mkdir(parents=True, exist_ok=True)
    cfg_path = settings.votify_config_dir / "config.ini"
    if not cfg_path.exists():
        cfg_path.write_text("[votify]\n", encoding="utf-8")
    return cfg_path


def _append_log(job: DownloadJob, text: str) -> None:
    if not text:
        return
    if job.log:
        job.log = f"{job.log}\n{text}"
    else:
        job.log = text


def _run_download(job_id: str, query: str, db_url: str) -> None:
    from sqlalchemy import create_engine
    from sqlalchemy.orm import sessionmaker

    engine = create_engine(db_url, connect_args={"check_same_thread": False} if db_url.startswith("sqlite") else {})
    SessionLocal = sessionmaker(bind=engine, autoflush=False, autocommit=False)

    db = SessionLocal()
    try:
        job = db.get(DownloadJob, job_id)
        if not job:
            return

        job.status = "running"
        db.commit()

        success = False

        if settings.downloader in ("auto", "onthespot"):
            _ensure_ots_config()
            env = dict(**os.environ)
            env["ONTHESPOTDIR"] = str(settings.onthespot_config_dir)

            cmd = [settings.onthespot_cmd, "--download", query]
            try:
                result = subprocess.run(
                    cmd,
                    capture_output=True,
                    text=True,
                    env=env,
                    timeout=settings.onthespot_timeout_sec,
                )
                output = (result.stdout or "") + "\n" + (result.stderr or "")
                _append_log(job, output.strip())
                if result.returncode == 0:
                    success = True
                    job.source = "onthespot"
            except subprocess.TimeoutExpired:
                _append_log(job, f"OnTheSpot timed out after {settings.onthespot_timeout_sec}s.")

        if not success and settings.downloader in ("auto", "votify"):
            _ensure_votify_config()
            if not settings.votify_cookies_path.exists():
                _append_log(job, "Votify requires cookies.txt (OPENFY_VOTIFY_COOKIES_PATH).")
            else:
                cmd = [
                    settings.votify_cmd,
                    "--cookies-path",
                    str(settings.votify_cookies_path),
                    "--output-path",
                    str(settings.downloads_dir),
                    "--temp-path",
                    str(settings.downloads_dir / "tmp"),
                    "--config-path",
                    str(settings.votify_config_dir / "config.ini"),
                    query,
                ]
                if settings.votify_wvd_path.exists():
                    cmd.extend(["--wvd-path", str(settings.votify_wvd_path)])
                else:
                    cmd.append("--disable-wvd")

                try:
                    result = subprocess.run(
                        cmd,
                        capture_output=True,
                        text=True,
                        timeout=settings.onthespot_timeout_sec,
                    )
                    output = (result.stdout or "") + "\n" + (result.stderr or "")
                    _append_log(job, output.strip())
                    if result.returncode == 0:
                        success = True
                        job.source = "votify"
                except subprocess.TimeoutExpired:
                    _append_log(job, f"Votify timed out after {settings.onthespot_timeout_sec}s.")

        if success:
            job.status = "completed"
            job.output_path = str(settings.downloads_dir)
            ensure_dirs()
            moved_files = []
            for file in settings.downloads_dir.rglob("*"):
                if file.is_file() and is_audio_file(file):
                    moved_files.append(store_upload(file, settings.music_dir))
            if moved_files:
                scan_paths(db, moved_files)
        else:
            job.status = "failed"

        db.commit()
    finally:
        db.close()


def queue_download(db: Session, query: str, source: str = "auto") -> DownloadJob:
    job = DownloadJob(source=source, query=query, status="queued")
    db.add(job)
    db.commit()
    db.refresh(job)

    if source not in ("auto", "onthespot", "votify"):
        job.status = "failed"
        job.log = f"Unsupported source: {source}"
        db.commit()
        return job

    if not (query.startswith("http://") or query.startswith("https://")):
        job.status = "failed"
        job.log = "Downloader only accepts full URLs. Paste a complete https:// link."
        db.commit()
        return job

    settings.downloader = source

    if source in ("auto", "onthespot") and not shutil.which(settings.onthespot_cmd):
        _append_log(job, f"Command not found: {settings.onthespot_cmd}")
        if source == "onthespot":
            job.status = "failed"
            db.commit()
            return job

    if source in ("auto", "votify") and not shutil.which(settings.votify_cmd):
        _append_log(job, f"Command not found: {settings.votify_cmd}")
        if source == "votify":
            job.status = "failed"
            db.commit()
            return job

    thread = threading.Thread(
        target=_run_download,
        args=(job.id, query, str(db.bind.url)),
        daemon=True,
    )
    thread.start()

    return job
