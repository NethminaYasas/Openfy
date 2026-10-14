from pathlib import Path
import re
from pydantic import field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

ADMIN_TOKEN_PATTERN = r"of1_[A-Za-z0-9_-]{60}"

BASE_DIR = Path(__file__).resolve().parent.parent.parent

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

    database_url: str = f"sqlite:///{DEFAULT_DATA_DIR}/openfy.db"

    allowed_origins: str = "http://localhost"

    admin_username: str = ""
    admin_hash: str = ""

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
        env_file=str(BASE_DIR / ".env"), env_prefix="OPENFY_"
    )


settings = Settings()
