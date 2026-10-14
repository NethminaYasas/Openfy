from pathlib import Path
import re
from pydantic import field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

ADMIN_TOKEN_PATTERN = r"of1_[A-Za-z0-9_-]{60}"

BASE_DIR = Path(__file__).resolve().parent.parent.parent
# In the Docker image the app lives at /app/app/settings.py, so the naive
# parent.parent.parent resolves to "/" — fall back to /app so defaults and
# the .env lookup point at the real app root instead of the filesystem root.
if BASE_DIR == Path("/") and Path("/app").is_dir():
    BASE_DIR = Path("/app")

DEFAULT_DATA_DIR = BASE_DIR / "data"
DEFAULT_MUSIC_DIR = DEFAULT_DATA_DIR / "music"
DEFAULT_DOWNLOADS_DIR = DEFAULT_DATA_DIR / "downloads"
DEFAULT_ARTWORK_DIR = DEFAULT_DATA_DIR / "artwork"


class Settings(BaseSettings):
    app_name: str = "Openfy Server"
    env: str = "dev"

    data_dir: Path = DEFAULT_DATA_DIR
    music_dir: Path = DEFAULT_MUSIC_DIR
    downloads_dir: Path = DEFAULT_DOWNLOADS_DIR
    artwork_dir: Path = DEFAULT_ARTWORK_DIR

    database_url: str = f"sqlite:///{DEFAULT_DATA_DIR.as_posix()}/openfy.db"

    allowed_origins: str = "http://localhost"

    admin_username: str = ""
    admin_hash: str = ""

    @field_validator("data_dir", "music_dir", "downloads_dir", "artwork_dir", mode="before")
    @classmethod
    def resolve_relative_dirs(cls, value) -> Path:
        # Resolve relative ./data-style paths against BASE_DIR (repo root
        # locally, /app in Docker) instead of CWD, so `cd server && uvicorn`
        # and Docker WORKDIR=/app behave consistently.
        p = value if isinstance(value, Path) else Path(str(value))
        if not p.is_absolute():
            p = (BASE_DIR / p).resolve()
        return p

    @field_validator("database_url", mode="before")
    @classmethod
    def resolve_relative_sqlite(cls, value) -> str:
        # sqlite:///./data/openfy.db is CWD-relative by default; anchor it to
        # BASE_DIR so local dev works regardless of launch directory.
        # Docker Compose now pins an absolute sqlite:////data/... URL, so this
        # is a safety net for manual `docker run` / local runs only.
        if isinstance(value, str) and value.startswith("sqlite:///./"):
            rel = value[len("sqlite:///./"):]
            abs_path = (BASE_DIR / rel).as_posix()
            return f"sqlite:///{abs_path}"
        return value

    @field_validator("admin_hash")
    @classmethod
    def validate_admin_hash(cls, value: str) -> str:
        if value and not re.fullmatch(ADMIN_TOKEN_PATTERN, value):
            raise ValueError(
                "Generate a new random administrator credential with "
                "python scripts/generate_hash.py and set OPENFY_ADMIN_HASH; "
                "legacy password-derived hashes are no longer supported"
            )
        return value

    spotiflac_cmd: str = "spotiflac"
    spotiflac_timeout_sec: int = 900
    max_upload_size_mb: int = 200

    model_config = SettingsConfigDict(
        env_file=str(BASE_DIR / ".env"), env_prefix="OPENFY_",
        extra="ignore",
    )


settings = Settings()
