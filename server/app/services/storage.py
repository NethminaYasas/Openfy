import hashlib
import os
import re
import secrets
import time
from pathlib import Path
import shutil

from ..settings import settings


SUPPORTED_EXTENSIONS = {".mp3", ".flac", ".wav", ".m4a", ".ogg", ".opus"}

# Bounds for upload deduplication scanning (CWE-400). find_existing_by_hash
# runs once per upload, so its work must not scale with the whole library:
# a tiny non-matching upload must not force a full-library rehash.
_MAX_DEDUP_SCAN_FILES = 5000  # max directory entries inspected per upload
_MAX_DEDUP_HASH_BYTES = 256 * 1024 * 1024  # max total bytes rehashed per upload


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
    """Return an existing file in dest_dir with identical content, if found cheaply.

    Candidates are prefiltered by file size (stat only, no content reads) and
    total rehashing is capped, so one upload cannot force a whole-library
    rehash. If the budget is exhausted the upload is treated as new; the
    later indexed universal_track_id lookup in _upsert_track still prevents
    duplicate track rows.
    """
    try:
        new_size = file_path.stat().st_size
    except OSError:
        return None
    new_hash = compute_file_hash(file_path)
    examined = 0
    hashed_bytes = 0
    for existing in dest_dir.iterdir():
        examined += 1
        if examined > _MAX_DEDUP_SCAN_FILES:
            break
        if not (existing.is_file() and existing.suffix.lower() in SUPPORTED_EXTENSIONS):
            continue
        try:
            if existing.stat().st_size != new_size:
                continue  # size prefilter: no content read
        except OSError:
            continue
        if hashed_bytes + new_size > _MAX_DEDUP_HASH_BYTES:
            break
        # Count the attempt up front: a hash that reads partial content and
        # then fails still consumed I/O, so failures count toward the budget.
        hashed_bytes += new_size
        try:
            if compute_file_hash(existing) == new_hash:
                return existing
        except OSError:
            continue  # file vanished/unreadable mid-scan; skip it
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
