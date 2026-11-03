from __future__ import annotations

from collections.abc import Sequence
from datetime import datetime, timezone

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

    async def fetch_at(
        self,
        points: Sequence[tuple[float, float]],
        variables: Sequence[str] | None,
        forecast_time: str,
        *,
        gfs: bool = False,
    ) -> list[dict]:
        """Fetch one hourly forecast slice for a map timeline position."""
        selected = tuple(variables or FORECAST_VARIABLES)
        records = await self.client.fetch_locations(
            self.client.settings.openmeteo_gfs_url if gfs else self.client.settings.openmeteo_forecast_url,
            points,
            {
                "hourly": ",".join(selected),
                "forecast_days": 7,
                "temperature_unit": "celsius",
                "wind_speed_unit": "kmh",
                "precipitation_unit": "mm",
            },
        )
        target = datetime.fromisoformat(forecast_time.replace("Z", "+00:00")).replace(tzinfo=timezone.utc)
        result: list[dict] = []
        for record in records:
            times = record.get("hourly", {}).get("time", [])
            if not times:
                result.append({"current": {}, "current_units": record.get("hourly_units", {}), "time": forecast_time})
                continue
            index = min(
                range(len(times)),
                key=lambda position: abs(
                    datetime.fromisoformat(times[position]).replace(tzinfo=timezone.utc).timestamp()
                    - target.timestamp()
                ),
            )
            hourly = record.get("hourly", {})
            result.append({
                "current": {
                    **{variable: (hourly.get(variable) or [None])[index] for variable in selected},
                    "time": times[index],
                },
                "current_units": record.get("hourly_units", {}),
                "time": times[index],
            })
        return result

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
