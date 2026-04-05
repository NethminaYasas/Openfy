from pathlib import Path
from pydantic_settings import BaseSettings, SettingsConfigDict

BASE_DIR = Path(__file__).resolve().parent.parent.parent


class Settings(BaseSettings):
    app_name: str = "Openfy Server"
    env: str = "dev"

    data_dir: Path = Path("./data")
    music_dir: Path = Path("./data/music")
    downloads_dir: Path = Path("./data/downloads")
    artwork_dir: Path = Path("./data/artwork")

    database_url: str = "sqlite:///./data/openfy.db"

    allowed_origins: str = "*"

    spotiflac_cmd: str = "spotiflac"
    spotiflac_timeout_sec: int = 900

    model_config = SettingsConfigDict(
        env_file=str(BASE_DIR / ".env"), env_prefix="OPENFY_"
    )


settings = Settings()
