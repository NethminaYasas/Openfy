from pathlib import Path
import shutil

from ..settings import settings


SUPPORTED_EXTENSIONS = {".mp3", ".flac", ".wav", ".m4a", ".ogg", ".opus"}


def ensure_dirs() -> None:
    settings.data_dir.mkdir(parents=True, exist_ok=True)
    settings.music_dir.mkdir(parents=True, exist_ok=True)
    settings.downloads_dir.mkdir(parents=True, exist_ok=True)
    settings.artwork_dir.mkdir(parents=True, exist_ok=True)


def is_audio_file(path: Path) -> bool:
    return path.suffix.lower() in SUPPORTED_EXTENSIONS


def store_upload(file_path: Path, destination_dir: Path | None = None) -> Path:
    dest_dir = destination_dir or settings.music_dir
    dest_dir.mkdir(parents=True, exist_ok=True)
    target = dest_dir / file_path.name

    counter = 1
    while target.exists():
        target = dest_dir / f"{file_path.stem}_{counter}{file_path.suffix}"
        counter += 1

    shutil.move(str(file_path), str(target))
    return target
