from pathlib import Path
from pydantic_settings import BaseSettings, SettingsConfigDict

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

    allowed_origins: str = "*"

    admin_username: str = ""
    admin_hash: str = ""

    spotiflac_cmd: str = "spotiflac"
    spotiflac_timeout_sec: int = 900

    model_config = SettingsConfigDict(
        env_file=str(BASE_DIR / ".env"), env_prefix="OPENFY_"
    )


settings = Settings()
