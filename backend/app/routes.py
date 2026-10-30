"""HTTP routes exposed by the API."""

from fastapi import APIRouter, HTTPException, Query

from .services import fetch_air_quality, fetch_weather

router = APIRouter()


@router.get("/weather", tags=["weather"])
async def get_weather(city: str = Query(..., min_length=1)) -> dict:
    """Return current weather for a city."""
    try:
        return await fetch_weather(city)
    except NotImplementedError as exc:
        raise HTTPException(status_code=501, detail=str(exc)) from exc


@router.get("/air-quality", tags=["air-quality"])
async def get_air_quality(city: str = Query(..., min_length=1)) -> dict:
    """Return current air quality for a city."""
    try:
        return await fetch_air_quality(city)
    except NotImplementedError as exc:
        raise HTTPException(status_code=501, detail=str(exc)) from exc
