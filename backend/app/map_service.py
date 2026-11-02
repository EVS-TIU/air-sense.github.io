from __future__ import annotations

import asyncio
import copy
import math
from datetime import datetime, timezone
from typing import Any

from .air_quality import AIR_QUALITY_VARIABLES, AirQualityService
from .config import Settings
from .forecast import FORECAST_VARIABLES, ForecastService
from .historical import HISTORICAL_VARIABLES, HistoricalService
from .map_cache import BoundedTTLCache
from .map_grid import GridSegment, build_grid_segments
from .openmeteo import OpenMeteoClient
from .services import WeatherServiceError

WEATHER_LAYER_VARIABLES = set(FORECAST_VARIABLES)
AIR_LAYER_VARIABLES = set(AIR_QUALITY_VARIABLES)
HISTORICAL_LAYER_VARIABLES = set(HISTORICAL_VARIABLES)

STALE_IF_ERROR_SECONDS = 1800


def parse_bbox(value: str) -> tuple[float, float, float, float]:
    parts = [part.strip() for part in str(value).split(",")]
    if len(parts) != 4:
        raise WeatherServiceError("bbox must be west,south,east,north", 400)
    try:
        west, south, east, north = (float(part) for part in parts)
    except ValueError:
        raise WeatherServiceError("bbox must contain four numbers", 400) from None
    if not all(math.isfinite(value) for value in (west, south, east, north)):
        raise WeatherServiceError("bbox values must be finite numbers", 400)
    return west, south, east, north


def _clean_number(value: Any) -> float | int | None:
    if isinstance(value, bool) or value is None:
        return None
    if isinstance(value, (int, float)):
        return value
    return None


def _iso_time(value: Any) -> str | None:
    if not isinstance(value, str) or not value:
        return None
    if value.endswith("Z") or value.endswith("+00:00") or "T" not in value:
        return value
    return f"{value}Z"


def _grid_key(family: str, segments: list[GridSegment], zoom: int, suffix: str = "") -> str:
    boxes = ";".join(
        ",".join(f"{value:.2f}" for value in segment.bbox) for segment in segments
    )
    return f"{family}:{zoom}:{boxes}:{suffix}"


class MapService:
    """Coordinates Open-Meteo data, viewport grids, caching, and responses."""

    def __init__(
        self,
        settings: Settings,
        forecast: ForecastService | None = None,
        air_quality: AirQualityService | None = None,
        historical: HistoricalService | None = None,
        cache: BoundedTTLCache | None = None,
    ):
        self.settings = settings
        self.client = OpenMeteoClient(settings)
        self.forecast = forecast or ForecastService(self.client)
        self.air_quality = air_quality or AirQualityService(self.client)
        self.historical = historical or HistoricalService(self.client)
        self.cache = cache or BoundedTTLCache()
        self._inflight: dict[str, asyncio.Task] = {}

    async def startup(self) -> None:
        await self.client.startup()

    async def shutdown(self) -> None:
        for task in self._inflight.values():
            task.cancel()
        self._inflight.clear()
        await self.client.shutdown()

    # ------------------------------------------------------------------
    # Cache / request coalescing
    # ------------------------------------------------------------------
    async def _cached(self, key: str, ttl: int, loader) -> dict:
        entry = await self.cache.get_entry(key)
        if entry is not None and entry[1] < ttl:
            return entry[0]

        existing = self._inflight.get(key)
        if existing is not None:
            return await existing

        async def run() -> dict:
            try:
                payload = await loader()
            except WeatherServiceError:
                if entry is not None and entry[1] < ttl + STALE_IF_ERROR_SECONDS:
                    stale = copy.deepcopy(entry[0])
                    stale["stale"] = True
                    warnings = list(stale.get("warnings") or [])
                    warnings.append("Showing cached data because the provider is unavailable")
                    stale["warnings"] = warnings
                    return stale
                raise
            payload["stale"] = False
            payload["fetched_at"] = datetime.now(timezone.utc).isoformat()
            await self.cache.set(key, payload)
            return payload

        task = asyncio.create_task(run())
        self._inflight[key] = task
        try:
            return await task
        finally:
            self._inflight.pop(key, None)

    # ------------------------------------------------------------------
    # Grid payloads
    # ------------------------------------------------------------------
    def _segments(
        self, west: float, south: float, east: float, north: float, zoom: int
    ) -> list[GridSegment]:
        try:
            return build_grid_segments(
                west, south, east, north, zoom, self.settings.map_max_points
            )
        except ValueError as exc:
            raise WeatherServiceError(f"Invalid map viewport: {exc}", 400) from None

    def _build_payload(
        self,
        family: str,
        segments: list[GridSegment],
        records: list[dict],
        variables: tuple[str, ...],
        *,
        value_source: str = "current",
        dataset: str | None = None,
        date: str | None = None,
    ) -> dict:
        units: dict[str, Any] = {}
        data_time: str | None = None
        warnings: list[str] = []
        missing = 0
        offset = 0
        segment_payloads: list[dict] = []

        for segment in segments:
            values = {
                variable: [
                    [None for _ in range(segment.columns)] for _ in range(segment.rows)
                ]
                for variable in variables
            }

            for row in range(segment.rows):
                for column in range(segment.columns):
                    record = records[offset]
                    offset += 1
                    source = record.get(value_source) or {}
                    if not units:
                        units = dict(record.get("current_units") or record.get("hourly_units") or {})
                    if data_time is None:
                        data_time = _iso_time(
                            record.get("time")
                            if value_source != "current"
                            else source.get("time")
                        )
                    for variable in variables:
                        value = _clean_number(source.get(variable))
                        if value is None:
                            missing += 1
                        values[variable][row][column] = value

            segment_payloads.append({
                "bbox": list(segment.bbox),
                "resolution_deg": segment.resolution_deg,
                "columns": segment.columns,
                "rows": segment.rows,
                "latitudes": list(segment.latitudes),
                "longitudes": list(segment.longitudes),
                "values": values,
            })

        if missing:
            warnings.append("Some grid points returned no data")

        first = segments[0]
        payload: dict[str, Any] = {
            "provider": "open-meteo",
            "family": family,
            "dataset": dataset or ("forecast" if family == "weather" else family),
            "bbox": list(first.bbox),
            "zoom": None,
            "resolution_deg": first.resolution_deg,
            "columns": first.columns,
            "rows": first.rows,
            "point_count": sum(segment.columns * segment.rows for segment in segments),
            "truncated": False,
            "data_time": data_time,
            "fetched_at": None,
            "units": {
                variable: units.get(variable)
                for variable in variables
            },
            "segments": segment_payloads,
            "warnings": warnings,
        }
        if date is not None:
            payload["date"] = date
        return payload

    @staticmethod
    def _filter_variables(payload: dict, variables: tuple[str, ...] | None) -> dict:
        if not variables:
            return payload
        filtered = copy.deepcopy(payload)
        filtered["units"] = {
            variable: value for variable, value in filtered.get("units", {}).items()
            if variable in variables
        }
        for segment in filtered["segments"]:
            segment["values"] = {
                variable: value for variable, value in segment["values"].items()
                if variable in variables
            }
        return filtered

    @staticmethod
    def _assert_variables(
        requested: tuple[str, ...] | None,
        allowed: set[str],
        label: str,
    ) -> tuple[str, ...]:
        if not requested:
            return tuple(sorted(allowed))
        unknown = [variable for variable in requested if variable not in allowed]
        if unknown:
            raise WeatherServiceError(
                f"Unsupported {label} variable(s): {', '.join(unknown)}", 400
            )
        return requested

    async def weather_grid(
        self,
        west: float,
        south: float,
        east: float,
        north: float,
        zoom: int,
        variables: tuple[str, ...] | None = None,
    ) -> dict:
        selected = self._assert_variables(variables, WEATHER_LAYER_VARIABLES, "weather")
        segments = self._segments(west, south, east, north, zoom)
        key = _grid_key("weather", segments, zoom)

        async def load() -> dict:
            points = [point for segment in segments for point in segment.points]
            records = await self.forecast.fetch(points)
            return self._build_payload(
                "weather", segments, records, tuple(FORECAST_VARIABLES)
            )

        payload = await self._cached(key, self.settings.map_cache_ttl_seconds, load)
        payload = copy.deepcopy(payload)
        payload["zoom"] = zoom
        return self._filter_variables(payload, selected)

    async def air_quality_grid(
        self,
        west: float,
        south: float,
        east: float,
        north: float,
        zoom: int,
        variables: tuple[str, ...] | None = None,
    ) -> dict:
        selected = self._assert_variables(variables, AIR_LAYER_VARIABLES, "air-quality")
        segments = self._segments(west, south, east, north, zoom)
        key = _grid_key("air", segments, zoom)

        async def load() -> dict:
            points = [point for segment in segments for point in segment.points]
            records = await self.air_quality.fetch(points)
            return self._build_payload(
                "air", segments, records, tuple(AIR_QUALITY_VARIABLES)
            )

        payload = await self._cached(key, self.settings.map_air_cache_ttl_seconds, load)
        payload = copy.deepcopy(payload)
        payload["zoom"] = zoom
        return self._filter_variables(payload, selected)

    async def historical_grid(
        self,
        west: float,
        south: float,
        east: float,
        north: float,
        zoom: int,
        date: str,
        variables: tuple[str, ...] | None = None,
    ) -> dict:
        selected = self._assert_variables(
            variables, HISTORICAL_LAYER_VARIABLES, "historical"
        )
        segments = self._segments(west, south, east, north, zoom)
        key = _grid_key("historical", segments, zoom, suffix=f"{date}:{','.join(selected)}")

        async def load() -> dict:
            points = [point for segment in segments for point in segment.points]
            records = await self.historical.fetch(points, date, selected)
            return self._build_payload(
                "historical",
                segments,
                records,
                selected,
                value_source="values",
                dataset="historical",
                date=date,
            )

        payload = await self._cached(
            key, self.settings.map_historical_cache_ttl_seconds, load
        )
        payload = copy.deepcopy(payload)
        payload["zoom"] = zoom
        return payload

    async def point(self, latitude: float, longitude: float) -> dict:
        key = f"point:{latitude:.4f}:{longitude:.4f}"

        async def load() -> dict:
            weather_result, air_result = await asyncio.gather(
                self.forecast.fetch([(latitude, longitude)]),
                self.air_quality.fetch([(latitude, longitude)]),
                return_exceptions=True,
            )
            if isinstance(weather_result, BaseException):
                raise weather_result
            if not weather_result:
                raise WeatherServiceError("Weather data is unavailable for this location", 502)

            record = weather_result[0]
            source = record.get("current") or {}
            values = {
                variable: _clean_number(source.get(variable))
                for variable in FORECAST_VARIABLES
            }
            units = dict(record.get("current_units") or {})
            warnings: list[str] = []

            if isinstance(air_result, BaseException) or not air_result:
                warnings.append("Air quality data is unavailable for this location")
                for variable in AIR_QUALITY_VARIABLES:
                    values[variable] = None
            else:
                air_record = air_result[0]
                air_source = air_record.get("current") or {}
                for variable in AIR_QUALITY_VARIABLES:
                    values[variable] = _clean_number(air_source.get(variable))
                units.update(air_record.get("current_units") or {})

            return {
                "provider": "open-meteo",
                "family": "point",
                "latitude": latitude,
                "longitude": longitude,
                "data_time": _iso_time(source.get("time")),
                "fetched_at": None,
                "units": units,
                "values": values,
                "stale": False,
                "warnings": warnings,
            }

        payload = await self._cached(key, self.settings.map_cache_ttl_seconds, load)
        payload = copy.deepcopy(payload)
        payload["latitude"] = latitude
        payload["longitude"] = longitude
        return payload
