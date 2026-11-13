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
    geoapify_api_key: str = Field(default="", validation_alias="GEOAPIFY_API_KEY")
    maptiler_api_key: str = Field(default="", validation_alias="MAPTILER_API_KEY")
    frontend_url: str = Field(default="http://localhost:5500", validation_alias="FRONTEND_URL")
    environment: str = Field(default="development", validation_alias="ENVIRONMENT")
    port: int = Field(default=8000, validation_alias="PORT", ge=1, le=65535)
    cache_ttl_seconds: int = Field(default=300, validation_alias="CACHE_TTL_SECONDS", ge=0, le=86400)
    http_timeout_seconds: float = Field(default=8.0, validation_alias="HTTP_TIMEOUT_SECONDS", gt=0, le=60)
    llm_api_key: str = Field(default="", validation_alias="LLM_API_KEY")
    llm_base_url: str = Field(default="", validation_alias="LLM_BASE_URL")
    llm_model: str = Field(default="", validation_alias="LLM_MODEL")

    # Open-Meteo map data. URLs are configurable so a self-hosted or proxy
    # deployment can be used without changing application code.
    openmeteo_forecast_url: str = Field(
        default="https://api.open-meteo.com/v1/forecast",
        validation_alias="OPENMETEO_FORECAST_URL",
    )
    openmeteo_gfs_url: str = Field(
        default="https://api.open-meteo.com/v1/gfs",
        validation_alias="OPENMETEO_GFS_URL",
    )
    openmeteo_archive_url: str = Field(
        default="https://archive-api.open-meteo.com/v1/archive",
        validation_alias="OPENMETEO_ARCHIVE_URL",
    )
    # ERA5-based historical model forecasts; fallback when the archive host is
    # overloaded (it has been seen answering 503 "service is overloaded").
    openmeteo_historical_forecast_url: str = Field(
        default="https://historical-forecast-api.open-meteo.com/v1/forecast",
        validation_alias="OPENMETEO_HISTORICAL_FORECAST_URL",
    )
    openmeteo_air_quality_url: str = Field(
        default="https://air-quality-api.open-meteo.com/v1/air-quality",
        validation_alias="OPENMETEO_AIR_QUALITY_URL",
    )
    waqi_api_token: str = Field(default="", validation_alias="WAQI_API_TOKEN")
    openaq_api_key: str = Field(default="", validation_alias="OPENAQ_API_KEY")
    air_quality_cache_ttl_seconds: int = Field(
        default=300, validation_alias="AIR_QUALITY_CACHE_TTL_SECONDS", ge=0, le=86400
    )
    map_cache_ttl_seconds: int = Field(
        default=300, validation_alias="MAP_CACHE_TTL_SECONDS", ge=0, le=86400
    )
    map_air_cache_ttl_seconds: int = Field(
        default=900, validation_alias="MAP_AIR_CACHE_TTL_SECONDS", ge=0, le=86400
    )
    map_historical_cache_ttl_seconds: int = Field(
        default=3600, validation_alias="MAP_HISTORICAL_CACHE_TTL_SECONDS", ge=0, le=86400
    )
    map_max_points: int = Field(
        default=400, validation_alias="MAP_MAX_POINTS", ge=4, le=2000
    )
    # Air-quality grids sample the CAMS lattice with their own budget: real
    # AQI detail is entirely point-limited, and each extra Open-Meteo
    # location is one more real model cell rendered without interpolation.
    # Open-Meteo's free tier counts every location in a request as one API
    # call against a ~600/minute weight cap, and fetch_locations fires all
    # batches at once — so this budget must stay below that cap or a
    # worldwide AQI view is rejected with 429 on every load.
    map_air_max_points: int = Field(
        default=480, validation_alias="MAP_AIR_MAX_POINTS", ge=4, le=6000
    )
    map_max_batch_points: int = Field(
        default=100, validation_alias="MAP_MAX_BATCH_POINTS", ge=1, le=100
    )

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
