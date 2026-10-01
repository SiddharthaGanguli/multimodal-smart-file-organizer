from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """Application settings loaded from environment variables or a local .env file."""

    app_name: str = "Multimodal Smart File Organizer"
    app_env: str = "development"
    app_debug: bool = True
    app_host: str = "0.0.0.0"
    app_port: int = 8000

    storage_dir: str = "storage"
    asset_database_path: str = "storage/assets.sqlite3"
    max_upload_bytes: int = 20 * 1024 * 1024

    database_url: str = "postgresql+psycopg://smartfile:smartfile@localhost:5432/smartfile"
    redis_url: str = "redis://localhost:6379/0"

    google_client_id: str = ""
    google_client_secret: str = ""
    google_redirect_uri: str = ""

    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )


@lru_cache
def get_settings() -> Settings:
    return Settings()
