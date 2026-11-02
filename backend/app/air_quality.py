from __future__ import annotations

from collections.abc import Sequence

from .openmeteo import OpenMeteoClient

AIR_QUALITY_VARIABLES = (
    "us_aqi",
    "pm2_5",
    "pm10",
    "nitrogen_dioxide",
    "ozone",
    "sulphur_dioxide",
    "carbon_monoxide",
)


class AirQualityService:
    """Open-Meteo Air Quality API integration."""

    def __init__(self, client: OpenMeteoClient):
        self.client = client

    async def fetch(self, points: Sequence[tuple[float, float]]) -> list[dict]:
        return await self.client.fetch_locations(
            self.client.settings.openmeteo_air_quality_url,
            points,
            {"current": ",".join(AIR_QUALITY_VARIABLES)},
        )
