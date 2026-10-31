from functools import lru_cache
from pathlib import Path

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """Runtime configuration loaded from environment variables."""

    model_config = SettingsConfigDict(
        env_file=Path(__file__).resolve().parents[1] / ".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )

    openweather_api_key: str = Field(default="", validation_alias="OPENWEATHER_API_KEY")
    frontend_url: str = Field(default="http://localhost:5500", validation_alias="FRONTEND_URL")
    environment: str = Field(default="development", validation_alias="ENVIRONMENT")
    port: int = Field(default=8000, validation_alias="PORT", ge=1, le=65535)
    cache_ttl_seconds: int = Field(default=300, validation_alias="CACHE_TTL_SECONDS", ge=0, le=86400)
    http_timeout_seconds: float = Field(default=8.0, validation_alias="HTTP_TIMEOUT_SECONDS", gt=0, le=60)
    llm_api_key: str = Field(default="", validation_alias="LLM_API_KEY")
    llm_base_url: str = Field(default="", validation_alias="LLM_BASE_URL")
    llm_model: str = Field(default="", validation_alias="LLM_MODEL")

    # Configurable intelligence thresholds.
    heat_celsius: float = 35
    extreme_heat_celsius: float = 40
    cold_celsius: float = 5
    extreme_cold_celsius: float = -10
    high_humidity_percent: float = 85
    heavy_rain_mm: float = 10
    strong_wind_kmh: float = 50
    low_visibility_m: float = 1000
    poor_aqi: int = 4


@lru_cache
def get_settings() -> Settings:
    return Settings()