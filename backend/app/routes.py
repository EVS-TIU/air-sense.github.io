from __future__ import annotations

import logging
from datetime import date as date_type, datetime, timezone
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi.responses import Response
from pydantic import BaseModel, Field

from .map_service import MapService, parse_bbox
from .services import WeatherClient, WeatherServiceError, build_recommendations

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/v1")


class Coordinates(BaseModel):
    latitude: float = Field(ge=-90, le=90)
    longitude: float = Field(ge=-180, le=180)


def coordinates(
    lat: Annotated[float | None, Query(ge=-90, le=90)] = None,
    lon: Annotated[float | None, Query(ge=-180, le=180)] = None,
    latitude: Annotated[float | None, Query(ge=-90, le=90)] = None,
    longitude: Annotated[float | None, Query(ge=-180, le=180)] = None,
) -> Coordinates:
    try:
        return Coordinates(latitude=latitude if latitude is not None else lat, longitude=longitude if longitude is not None else lon)
    except Exception:
        raise HTTPException(422, "Both latitude and longitude are required and must be valid") from None


def service(request: Request) -> WeatherClient:
    return request.app.state.weather


def map_service(request: Request) -> MapService:
    return request.app.state.map_service


def map_variables(value: str | None) -> tuple[str, ...] | None:
    if value is None:
        return None
    variables = tuple(part.strip() for part in value.split(",") if part.strip())
    if not variables:
        raise HTTPException(400, "At least one variable is required")
    return variables


def historical_date(value: str) -> str:
    try:
        parsed = datetime.strptime(value, "%Y-%m-%d").date()
    except ValueError:
        raise HTTPException(400, "date must use YYYY-MM-DD") from None
    if parsed > date_type.today():
        raise HTTPException(400, "date cannot be in the future")
    return parsed.isoformat()


def forecast_time(value: str | None) -> str | None:
    if value is None:
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        raise HTTPException(400, "time must be an ISO-8601 timestamp") from None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    parsed = parsed.astimezone(timezone.utc).replace(minute=0, second=0, microsecond=0)
    return parsed.isoformat().replace("+00:00", "Z")


async def provider_call(call):
    try:
        return await call
    except WeatherServiceError as exc:
        headers = None
        retry_after = getattr(exc, "retry_after", None)
        if retry_after:
            headers = {"Retry-After": str(retry_after)}
        raise HTTPException(exc.status_code, str(exc), headers=headers) from None


@router.get("/health")
async def health(request: Request) -> dict:
    client: WeatherClient = request.app.state.weather
    return {"status": "ok", "environment": request.app.state.settings.environment,
            "services": {"api": "available", "openweather": "configured" if client.settings.openweather_api_key else "not_configured"}}


@router.get("/health/")
async def health_slash(request: Request) -> dict:
    client: WeatherClient = request.app.state.weather
    return {"status": "ok", "environment": request.app.state.settings.environment,
            "services": {"api": "available", "openweather": "configured" if client.settings.openweather_api_key else "not_configured"}}


@router.get("/weather/current")
async def current_weather(request: Request, location: Annotated[Coordinates, Depends(coordinates)]) -> dict:
    return await provider_call(service(request).current(location.latitude, location.longitude))


@router.get("/weather/forecast")
async def forecast(request: Request, location: Annotated[Coordinates, Depends(coordinates)]) -> dict:
    return await provider_call(service(request).forecast(location.latitude, location.longitude))


@router.get("/weather/air-quality")
async def air_quality(request: Request, location: Annotated[Coordinates, Depends(coordinates)]) -> dict:
    return await provider_call(service(request).air_quality(location.latitude, location.longitude))


def bounds(value: str) -> tuple[float, float, float, float]:
    try:
        return parse_bbox(value)
    except WeatherServiceError as exc:
        raise HTTPException(exc.status_code, str(exc)) from None


@router.get("/map/weather")
async def map_weather(
    request: Request,
    bbox: Annotated[str, Query(description="west,south,east,north")],
    zoom: Annotated[int, Query(ge=0, le=19)] = 6,
    variables: Annotated[str | None, Query()] = None,
    time: Annotated[str | None, Query(description="UTC forecast hour, ISO-8601")] = None,
) -> dict:
    west, south, east, north = bounds(bbox)
    return await provider_call(
        map_service(request).weather_grid(
            west, south, east, north, zoom, map_variables(variables), forecast_time(time)
        )
    )


@router.get("/map/wind-tile/{z}/{x}/{y}.png")
async def wind_tile(request: Request, z: int, x: int, y: int) -> Response:
    if z < 0 or z > 19 or x < 0 or y < 0:
        raise HTTPException(400, "Invalid map tile coordinates")
    content = await provider_call(service(request).wind_tile(z, x, y))
    return Response(
        content=content,
        media_type="image/png",
        headers={"Cache-Control": "public, max-age=300"},
    )


@router.get("/map/air-quality")
async def map_air_quality(
    request: Request,
    bbox: Annotated[str, Query(description="west,south,east,north")],
    zoom: Annotated[int, Query(ge=0, le=19)] = 6,
    variables: Annotated[str | None, Query()] = None,
) -> dict:
    west, south, east, north = bounds(bbox)
    return await provider_call(
        map_service(request).air_quality_grid(
            west, south, east, north, zoom, map_variables(variables)
        )
    )


@router.get("/map/point")
async def map_point(
    request: Request,
    location: Annotated[Coordinates, Depends(coordinates)],
) -> dict:
    return await provider_call(
        map_service(request).point(location.latitude, location.longitude)
    )


@router.get("/map/historical")
async def map_historical(
    request: Request,
    bbox: Annotated[str, Query(description="west,south,east,north")],
    date: Annotated[str, Query(description="YYYY-MM-DD")],
    zoom: Annotated[int, Query(ge=0, le=19)] = 6,
    variables: Annotated[str | None, Query()] = None,
) -> dict:
    west, south, east, north = bounds(bbox)
    selected = map_variables(variables) or ("temperature_2m",)
    return await provider_call(
        map_service(request).historical_grid(
            west, south, east, north, zoom, historical_date(date), selected
        )
    )


@router.get("/location/search")
async def location_search(request: Request, q: Annotated[str, Query(min_length=2, max_length=100)]) -> dict:
    return {"results": await provider_call(service(request).search(q.strip()))}


@router.get("/location/reverse")
async def location_reverse(request: Request, location: Annotated[Coordinates, Depends(coordinates)]) -> dict:
    return {"results": await provider_call(service(request).reverse(location.latitude, location.longitude))}


@router.get("/recommendations")
async def recommendations(request: Request, location: Annotated[Coordinates, Depends(coordinates)]) -> dict:
    weather = await provider_call(service(request).current(location.latitude, location.longitude))
    air = await provider_call(service(request).air_quality(location.latitude, location.longitude))
    return build_recommendations(weather, air, request.app.state.settings)


@router.get("/weather/summary")
async def summary(request: Request, location: Annotated[Coordinates, Depends(coordinates)]) -> dict:
    weather = await provider_call(service(request).current(location.latitude, location.longitude))
    air = await provider_call(service(request).air_quality(location.latitude, location.longitude))
    intelligence = build_recommendations(weather, air, request.app.state.settings)
    return {"location": {"name": weather.get("location_label"), "country": weather.get("location_country"),
                         "latitude": weather.get("latitude"), "longitude": weather.get("longitude")},
            "weather": weather, "air_quality": air, "intelligence": intelligence}
