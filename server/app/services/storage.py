import hashlib
import os
import re
import secrets
import time
from pathlib import Path
import shutil

from ..settings import settings


SUPPORTED_EXTENSIONS = {".mp3", ".flac", ".wav", ".m4a", ".ogg", ".opus"}


def compute_file_hash(file_path: Path, chunk_size: int = 1024 * 1024) -> str:
    hasher = hashlib.sha256()
    with file_path.open("rb") as f:
        while True:
            chunk = f.read(chunk_size)
            if not chunk:
                break
            hasher.update(chunk)
    return hasher.hexdigest()


def find_existing_by_hash(file_path: Path, dest_dir: Path) -> Path | None:
    new_hash = compute_file_hash(file_path)
    for existing in dest_dir.iterdir():
        if existing.is_file() and existing.suffix.lower() in SUPPORTED_EXTENSIONS:
            if compute_file_hash(existing) == new_hash:
                return existing
    return None


def ensure_dirs() -> None:
    settings.data_dir.mkdir(parents=True, exist_ok=True)
    settings.music_dir.mkdir(parents=True, exist_ok=True)
    settings.downloads_dir.mkdir(parents=True, exist_ok=True)
    settings.artwork_dir.mkdir(parents=True, exist_ok=True)


def is_audio_file(path: Path) -> bool:
    return path.suffix.lower() in SUPPORTED_EXTENSIONS


def store_upload(
    file_path: Path,
    destination_dir: Path | None = None,
    preferred_stem: str | None = None,
) -> Path:
    dest_dir = destination_dir or settings.music_dir
    dest_dir.mkdir(parents=True, exist_ok=True)

    existing = find_existing_by_hash(file_path, dest_dir)
    if existing is not None:
        return existing

    suffix = file_path.suffix
    if preferred_stem:
        stem = re.sub(r'[^a-zA-Z0-9._-]', '_', os.path.basename(preferred_stem)).strip("._")
        if not stem or stem in ('.', '..'):
            stem = f"uploaded_{secrets.token_hex(8)}"
    else:
        # Sanitize filename: keep only safe characters, strip path components
        original_name = file_path.name
        # Remove any directory path components (path traversal protection)
        safe_name = os.path.basename(original_name)
        # Replace potentially dangerous characters with underscore
        # Allow: alphanumeric, dots, hyphens, underscores
        safe_name = re.sub(r'[^a-zA-Z0-9._-]', '_', safe_name)
        # Prevent empty filename or reserved names
        if not safe_name or safe_name in ('.', '..'):
            safe_name = f"uploaded_{secrets.token_hex(8)}{suffix}"
        stem = safe_name.rsplit('.', 1)[0] if '.' in safe_name else safe_name

    target = dest_dir / f"{stem}{suffix}"

    counter = 1
    max_attempts = 1000
    while target.exists() and counter < max_attempts:
        target = dest_dir / f"{stem}_{counter}{suffix}"
        counter += 1

    shutil.move(str(file_path), str(target))
    return target


def store_avatar(file_path: Path, user_id: str) -> Path:
    """Store an uploaded avatar file with a unique, user-specific filename in data/avatars/."""
    avatar_dir = settings.data_dir / "avatars"
    avatar_dir.mkdir(parents=True, exist_ok=True)

    suffix = file_path.suffix.lower()
    if not suffix:
        suffix = ".jpg"

    stem = f"avatar_{user_id}_{int(time.time())}_{secrets.token_hex(8)}"
    target = avatar_dir / f"{stem}{suffix}"

    counter = 1
    max_attempts = 100
    while target.exists() and counter < max_attempts:
        target = avatar_dir / f"{stem}_{counter}{suffix}"
        counter += 1

    shutil.move(str(file_path), str(target))
    return target
