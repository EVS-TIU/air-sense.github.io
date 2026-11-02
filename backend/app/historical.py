from __future__ import annotations

import math
from collections.abc import Sequence

from .openmeteo import OpenMeteoClient

HISTORICAL_VARIABLES = (
    "temperature_2m",
    "relative_humidity_2m",
    "precipitation",
    "cloud_cover",
    "wind_speed_10m",
    "wind_direction_10m",
)


def _finite(values: Sequence[object]) -> list[float]:
    return [float(value) for value in values if isinstance(value, (int, float)) and math.isfinite(float(value))]


def _circular_mean(values: Sequence[object]) -> float | None:
    radians = [math.radians(float(value)) for value in _finite(values)]
    if not radians:
        return None
    sine = sum(math.sin(value) for value in radians) / len(radians)
    cosine = sum(math.cos(value) for value in radians) / len(radians)
    return (math.degrees(math.atan2(sine, cosine)) + 360) % 360


def aggregate_hourly(variable: str, values: Sequence[object]) -> float | None:
    """Reduce one archive day of hourly values to a single map value."""
    if variable == "precipitation":
        finite = _finite(values)
        return round(sum(finite), 2) if finite else None
    if variable == "wind_direction_10m":
        mean = _circular_mean(values)
        return round(mean, 1) if mean is not None else None
    finite = _finite(values)
    return round(sum(finite) / len(finite), 2) if finite else None


class HistoricalService:
    """Open-Meteo Historical Weather (Archive) API integration.

    This stays separate from the live forecast pipeline: archive data is an
    observation/reanalysis record for a past date, not a current condition.
    """

    def __init__(self, client: OpenMeteoClient):
        self.client = client

    async def fetch(
        self,
        points: Sequence[tuple[float, float]],
        date: str,
        variables: Sequence[str],
    ) -> list[dict]:
        locations = await self.client.fetch_locations(
            self.client.settings.openmeteo_archive_url,
            points,
            {
                "start_date": date,
                "end_date": date,
                "hourly": ",".join(variables),
            },
        )

        results: list[dict] = []
        for location in locations:
            hourly = location.get("hourly") or {}
            values: dict[str, float | None] = {}
            for variable in variables:
                values[variable] = aggregate_hourly(variable, hourly.get(variable) or [])
            times = hourly.get("time") or []
            results.append({
                "values": values,
                "time": times[0] if times else f"{date}T00:00",
                "units": location.get("hourly_units") or {},
            })
        return results
