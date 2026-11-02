from __future__ import annotations

from collections.abc import Sequence

from .openmeteo import OpenMeteoClient

# One weather-grid request returns every scalar field needed by all weather
# layers, so switching between temperature/wind/humidity/rain/cloud does not
# consume another provider request.
FORECAST_VARIABLES = (
    "temperature_2m",
    "apparent_temperature",
    "relative_humidity_2m",
    "precipitation",
    "cloud_cover",
    "wind_speed_10m",
    "wind_direction_10m",
    "surface_pressure",
)


class ForecastService:
    """Open-Meteo current/forecast API integration."""

    def __init__(self, client: OpenMeteoClient):
        self.client = client

    async def fetch(
        self,
        points: Sequence[tuple[float, float]],
        variables: Sequence[str] | None = None,
    ) -> list[dict]:
        return await self._fetch_from_url(
            self.client.settings.openmeteo_forecast_url, points, variables
        )

    async def fetch_gfs(
        self,
        points: Sequence[tuple[float, float]],
        variables: Sequence[str] | None = None,
    ) -> list[dict]:
        """Fetch the free NOAA GFS-backed fallback through Open-Meteo."""
        return await self._fetch_from_url(
            self.client.settings.openmeteo_gfs_url, points, variables
        )

    async def _fetch_from_url(
        self,
        url: str,
        points: Sequence[tuple[float, float]],
        variables: Sequence[str] | None = None,
    ) -> list[dict]:
        selected = tuple(variables or FORECAST_VARIABLES)
        return await self.client.fetch_locations(
            url,
            points,
            {
                "current": ",".join(selected),
                "temperature_unit": "celsius",
                "wind_speed_unit": "kmh",
                "precipitation_unit": "mm",
            },
        )
