import os
import re
import secrets
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

    # Sanitize filename: keep only safe characters, strip path components
    original_name = file_path.name
    # Remove any directory path components (path traversal protection)
    safe_name = os.path.basename(original_name)
    # Replace potentially dangerous characters with underscore
    # Allow: alphanumeric, dots, hyphens, underscores
    safe_name = re.sub(r'[^a-zA-Z0-9._-]', '_', safe_name)
    # Prevent empty filename or reserved names
    if not safe_name or safe_name in ('.', '..'):
        safe_name = f"uploaded_{secrets.token_hex(8)}{file_path.suffix}"

    # Split into stem and suffix for collision handling
    stem = safe_name.rsplit('.', 1)[0] if '.' in safe_name else safe_name
    suffix = file_path.suffix  # Preserve original extension after sanitization

    target = dest_dir / f"{stem}{suffix}"

    counter = 1
    max_attempts = 1000
    while target.exists() and counter < max_attempts:
        target = dest_dir / f"{stem}_{counter}{suffix}"
        counter += 1

    shutil.move(str(file_path), str(target))
    return target
