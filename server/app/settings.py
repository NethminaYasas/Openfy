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
    onthespot_cmd: str = "onthespot-cli"
    onthespot_config_dir: Path = Path("./data/onthespot")
    onthespot_timeout_sec: int = 900
    downloader: str = "auto"  # auto | onthespot | votify

    votify_cmd: str = "votify"
    votify_config_dir: Path = Path("./data/votify")
    votify_cookies_path: Path = Path("./data/votify/cookies.txt")
    votify_wvd_path: Path = Path("./data/votify/device.wvd")

    model_config = SettingsConfigDict(
        env_file=str(BASE_DIR / ".env"), env_prefix="OPENFY_"
    )


settings = Settings()
