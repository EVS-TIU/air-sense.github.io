from __future__ import annotations

import logging
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from pydantic import BaseModel, Field

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


async def provider_call(call):
    try:
        return await call
    except WeatherServiceError as exc:
        raise HTTPException(exc.status_code, str(exc)) from None


@router.get("/health")
async def health(request: Request) -> dict:
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


@router.get("/location/search")
async def location_search(request: Request, q: Annotated[str, Query(min_length=2, max_length=100)]) -> dict:
    return {"results": await provider_call(service(request).search(q.strip()))}


@router.get("/recommendations")
async def recommendations(request: Request, location: Annotated[Coordinates, Depends(coordinates)]) -> dict:
    weather = await provider_call(service(request).current(location.latitude, location.longitude))
    air = weather.get("air_quality") or await provider_call(service(request).air_quality(location.latitude, location.longitude))
    return build_recommendations(weather, air, request.app.state.settings)


@router.get("/weather/summary")
async def summary(request: Request, location: Annotated[Coordinates, Depends(coordinates)]) -> dict:
    weather = await provider_call(service(request).current(location.latitude, location.longitude))
    air = weather.get("air_quality") or await provider_call(service(request).air_quality(location.latitude, location.longitude))
    intelligence = build_recommendations(weather, air, request.app.state.settings)
    return {"location": {"name": weather.get("location_label"), "country": weather.get("location_country"),
                         "latitude": weather.get("latitude"), "longitude": weather.get("longitude")},
            "weather": weather, "air_quality": air, "intelligence": intelligence}