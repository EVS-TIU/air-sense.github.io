from unittest.mock import AsyncMock

import pytest
from fastapi.testclient import TestClient

from app.config import Settings
from app.map_grid import STEP_LADDER, build_grid_segments
from app.map_service import MapService
from app.main import app
from app.openmeteo import OpenMeteoError
from app.services import WeatherServiceError

WEATHER_VALUES = {
    "temperature_2m": 20.5,
    "apparent_temperature": 21.0,
    "relative_humidity_2m": 55,
    "precipitation": 0.2,
    "cloud_cover": 40,
    "wind_speed_10m": 12.4,
    "wind_direction_10m": 180,
    "surface_pressure": 1012.5,
}
WEATHER_UNITS = {
    "temperature_2m": "°C",
    "apparent_temperature": "°C",
    "relative_humidity_2m": "%",
    "precipitation": "mm",
    "cloud_cover": "%",
    "wind_speed_10m": "km/h",
    "wind_direction_10m": "°",
    "surface_pressure": "hPa",
}
AIR_VALUES = {
    "us_aqi": 42,
    "pm2_5": 9.5,
    "pm10": 18.0,
    "nitrogen_dioxide": 11.0,
    "ozone": 65.0,
    "sulphur_dioxide": 2.0,
    "carbon_monoxide": 210.0,
}
AIR_UNITS = {
    "us_aqi": "USAQI",
    "pm2_5": "μg/m³",
    "pm10": "μg/m³",
    "nitrogen_dioxide": "μg/m³",
    "ozone": "μg/m³",
    "sulphur_dioxide": "μg/m³",
    "carbon_monoxide": "μg/m³",
}


def weather_records(points):
    return [
        {
            "current": {**WEATHER_VALUES, "time": "2026-11-02T06:00"},
            "current_units": WEATHER_UNITS,
            "time": "2026-11-02T06:00",
        }
        for _ in points
    ]


def air_records(points):
    return [
        {
            "current": {**AIR_VALUES, "time": "2026-11-02T06:00"},
            "current_units": AIR_UNITS,
            "time": "2026-11-02T06:00",
        }
        for _ in points
    ]


def historical_records(points, date, variables):
    return [
        {
            "values": {variable: 12.5 for variable in variables},
            "time": f"{date}T00:00",
            "units": {},
        }
        for _ in points
    ]


def make_map_service(settings=None):
    service = MapService(settings or Settings(openweather_api_key="test-key"))
    service.forecast.fetch = AsyncMock(side_effect=weather_records)
    service.air_quality.fetch = AsyncMock(side_effect=air_records)
    service.historical.fetch = AsyncMock(side_effect=historical_records)
    return service


@pytest.fixture
def map_client():
    service = make_map_service()
    with TestClient(app) as client:
        app.state.map_service = service
        yield client, service


def test_grid_segments_cover_viewport_and_respect_point_budget():
    segments = build_grid_segments(-10, 35, 30, 60, zoom=5, max_points=120)
    assert len(segments) == 1
    segment = segments[0]
    assert segment.columns >= 2
    assert segment.rows >= 2
    assert segment.columns * segment.rows <= 120
    assert segment.resolution_deg in STEP_LADDER
    assert segment.bbox == (-10.0, 35.0, 30.0, 60.0)
    assert min(segment.latitudes) == 35.0
    assert max(segment.latitudes) == 60.0
    assert min(segment.longitudes) == -10.0
    assert max(segment.longitudes) == 30.0


def test_grid_segments_split_antimeridian_and_clamp_poles():
    segments = build_grid_segments(170, -90, -170, 90, zoom=3, max_points=200)
    assert len(segments) == 2
    assert segments[0].bbox[2] == 180.0
    assert segments[1].bbox[0] == -180.0
    for segment in segments:
        assert -85.0 <= min(segment.latitudes) <= max(segment.latitudes) <= 85.0
        assert all(-180.0 <= longitude <= 180.0 for longitude in segment.longitudes)
    assert sum(segment.columns * segment.rows for segment in segments) <= 200


def test_grid_resolution_increases_with_zoom():
    def point_count(zoom):
        segments = build_grid_segments(-10, 35, 30, 60, zoom=zoom, max_points=400)
        return sum(segment.columns * segment.rows for segment in segments)

    assert point_count(10) > point_count(2)


def test_grid_rejects_invalid_viewports():
    with pytest.raises(ValueError):
        build_grid_segments(0, 10, 10, 10, zoom=5)
    with pytest.raises(ValueError):
        build_grid_segments(0, 0, 0, 10, zoom=5)
    with pytest.raises(ValueError):
        build_grid_segments(float("nan"), 0, 10, 10, zoom=5)


def test_weather_grid_contract_and_variable_filter(map_client):
    client, service = map_client
    response = client.get("/api/v1/map/weather?bbox=-10,35,30,60&zoom=5")
    assert response.status_code == 200
    payload = response.json()
    assert payload["provider"] == "open-meteo"
    assert payload["family"] == "weather"
    assert payload["dataset"] == "forecast"
    assert payload["zoom"] == 5
    assert payload["data_time"] == "2026-11-02T06:00Z"
    assert payload["units"]["temperature_2m"] == "°C"
    assert payload["point_count"] <= 400
    assert len(payload["segments"]) == 1

    segment = payload["segments"][0]
    assert segment["rows"] >= 2
    assert segment["columns"] >= 2
    assert len(segment["values"]["temperature_2m"]) == segment["rows"]
    assert len(segment["values"]["temperature_2m"][0]) == segment["columns"]
    assert set(segment["values"]) == set(WEATHER_VALUES)
    assert payload["point_count"] == segment["rows"] * segment["columns"]
    assert service.forecast.fetch.await_count == 1

    filtered = client.get(
        "/api/v1/map/weather?bbox=-10,35,30,60&zoom=5&variables=temperature_2m"
    )
    assert filtered.status_code == 200
    filtered_payload = filtered.json()
    assert set(filtered_payload["segments"][0]["values"]) == {"temperature_2m"}
    assert set(filtered_payload["units"]) == {"temperature_2m"}
    assert service.forecast.fetch.await_count == 1


def test_map_endpoints_validate_parameters(map_client):
    client, _ = map_client
    assert client.get("/api/v1/map/weather?bbox=1,2,3&zoom=5").status_code == 400
    assert client.get("/api/v1/map/weather?bbox=a,b,c,d&zoom=5").status_code == 400
    assert (
        client.get("/api/v1/map/weather?bbox=-10,35,30,60&zoom=5&variables=bad").status_code
        == 400
    )
    assert (
        client.get(
            "/api/v1/map/historical?bbox=-10,35,30,60&zoom=5&date=not-a-date"
        ).status_code
        == 400
    )
    assert (
        client.get(
            "/api/v1/map/historical?bbox=-10,35,30,60&zoom=5&date=2099-01-01"
        ).status_code
        == 400
    )


def test_air_quality_and_point_contract(map_client):
    client, service = map_client
    air = client.get("/api/v1/map/air-quality?bbox=-10,35,30,60&zoom=5")
    assert air.status_code == 200
    air_payload = air.json()
    assert air_payload["family"] == "air"
    assert air_payload["dataset"] == "air"
    assert air_payload["units"]["us_aqi"] == "USAQI"
    assert set(air_payload["segments"][0]["values"]) == set(AIR_VALUES)
    assert service.air_quality.fetch.await_count == 1

    point = client.get("/api/v1/map/point?lat=25.2048&lon=55.2708")
    assert point.status_code == 200
    point_payload = point.json()
    assert point_payload["family"] == "point"
    assert point_payload["latitude"] == 25.2048
    assert point_payload["longitude"] == 55.2708
    assert point_payload["values"]["temperature_2m"] == 20.5
    assert point_payload["values"]["us_aqi"] == 42
    assert point_payload["units"]["temperature_2m"] == "°C"


def test_historical_grid_uses_archive_dataset(map_client):
    client, service = map_client
    response = client.get(
        "/api/v1/map/historical?bbox=10,45,20,55&zoom=5"
        "&date=2025-01-15&variables=temperature_2m"
    )
    assert response.status_code == 200
    payload = response.json()
    assert payload["family"] == "historical"
    assert payload["dataset"] == "historical"
    assert payload["date"] == "2025-01-15"
    assert payload["data_time"] == "2025-01-15T00:00Z"
    assert set(payload["segments"][0]["values"]) == {"temperature_2m"}
    assert payload["segments"][0]["values"]["temperature_2m"][0][0] == 12.5
    assert service.historical.fetch.await_count == 1


def test_map_cache_reuses_grid_and_serves_stale_on_error(map_client):
    client, service = map_client
    first = client.get("/api/v1/map/weather?bbox=-10,35,30,60&zoom=5")
    assert first.status_code == 200
    assert first.json()["stale"] is False
    assert service.forecast.fetch.await_count == 1

    # A different variable selection is served from the same cached grid.
    filtered = client.get(
        "/api/v1/map/weather?bbox=-10,35,30,60&zoom=5&variables=cloud_cover"
    )
    assert filtered.status_code == 200
    assert service.forecast.fetch.await_count == 1

    # Expire the cache, then fail the provider: the previous payload is
    # returned with a stale marker instead of replacing the map with an error.
    service.settings.map_cache_ttl_seconds = 0
    service.forecast.fetch.side_effect = WeatherServiceError(
        "Weather data provider is temporarily unavailable", 502
    )
    stale = client.get("/api/v1/map/weather?bbox=-10,35,30,60&zoom=5")
    assert stale.status_code == 200
    stale_payload = stale.json()
    assert stale_payload["stale"] is True
    assert any("provider is unavailable" in warning for warning in stale_payload["warnings"])


def test_map_rate_limit_returns_retry_after(map_client):
    client, service = map_client
    service.forecast.fetch.side_effect = OpenMeteoError(
        "Weather data rate limit reached", 503, retry_after=30
    )
    response = client.get("/api/v1/map/weather?bbox=-10,35,30,60&zoom=5")
    assert response.status_code == 503
    assert response.json()["detail"] == "Weather data rate limit reached"
    assert response.headers["retry-after"] == "30"
