from unittest.mock import AsyncMock

import pytest
from fastapi.testclient import TestClient

from app.config import Settings
from app.main import app
from app.services import (
    TTLCache,
    WeatherClient,
    WeatherServiceError,
    build_recommendations,
    calculate_epa_aqi,
    normalize_current,
)


@pytest.fixture
def fake_weather():
    return {
        "location_label": "Test City", "location_country": "TC", "latitude": 10, "longitude": 20,
        "temperature": 36, "apparent_temperature": 38, "temperature_min": 30, "temperature_max": 37,
        "humidity": 90, "visibility": 800, "wind_speed": 55, "condition": "thunderstorm",
        "hourly": [{"precipitation_probability": 80, "rain_3h": 12}],
    }


@pytest.fixture
def client(fake_weather):
    settings = Settings(openweather_api_key="test-key")
    weather = WeatherClient(settings)
    weather.current = AsyncMock(return_value=fake_weather)
    weather.forecast = AsyncMock(return_value={"hourly": []})
    weather.air_quality = AsyncMock(return_value={"aqi": 4, "components": {}})
    with TestClient(app) as test_client:
        app.state.settings = settings
        app.state.weather = weather
        yield test_client


def test_health(client):
    response = client.get("/api/v1/health")
    assert response.status_code == 200
    assert response.json()["status"] == "ok"


def test_current_weather_accepts_both_coordinate_names(client, fake_weather):
    response = client.get("/api/v1/weather/current?latitude=10&longitude=20")
    assert response.status_code == 200
    assert response.json()["location_label"] == fake_weather["location_label"]
    response = client.get("/api/v1/weather/current?lat=10&lon=20")
    assert response.status_code == 200


def test_forecast_and_air_quality(client):
    assert client.get("/api/v1/weather/forecast?lat=10&lon=20").status_code == 200
    assert client.get("/api/v1/weather/air-quality?lat=10&lon=20").status_code == 200


def test_invalid_coordinates(client):
    response = client.get("/api/v1/weather/current?lat=100&lon=20")
    assert response.status_code == 422


def test_provider_failure_is_safe(client):
    app.state.weather.current = AsyncMock(side_effect=WeatherServiceError("Weather service is temporarily unavailable"))
    response = client.get("/api/v1/weather/current?lat=10&lon=20")
    assert response.status_code == 502
    assert response.json()["detail"] == "Weather service is temporarily unavailable"


def test_missing_api_key():
    import asyncio
    service = WeatherClient(Settings(openweather_api_key=""))
    with pytest.raises(WeatherServiceError) as error:
        asyncio.run(service.current(10, 20))
    assert error.value.status_code == 503


def test_recommendation_engine(fake_weather):
    result = build_recommendations(fake_weather, {"provider_index": 5}, Settings())
    assert result["overall_severity"] == "Severe"
    assert any(r["type"] == "thunderstorm" for r in result["risks"])
    assert result["recommendations"]


def test_cache():
    import asyncio
    cache = TTLCache(60)
    async def exercise():
        assert await cache.get("x") is None
        await cache.set("x", {"value": 1})
        assert await cache.get("x") == {"value": 1}
    asyncio.run(exercise())


def test_current_weather_includes_normalized_hourly_forecast():
    current = {"name": "Test City", "coord": {"lat": 1, "lon": 2}, "weather": [{"id": 800}],
               "main": {}, "wind": {}, "sys": {}}
    forecast = {"city": {"coord": {"lat": 1, "lon": 2}}, "list": [
        {"dt": 1, "dt_txt": "2026-10-31 12:00:00", "main": {"temp": 20},
         "weather": [{"id": 801}], "pop": 0.6}
    ]}
    result = normalize_current(current, forecast)
    assert len(result["hourly"]) == 1
    assert result["hourly"][0]["temperature"] == 20
    assert result["hourly"][0]["precipitation_probability"] == 60


def test_current_weather_maps_uv_and_location_sun_times():
    current = {
        "name": "Kolkata", "coord": {"lat": 22.57, "lon": 88.36},
        "weather": [{"id": 800}], "main": {}, "wind": {},
        "sys": {"sunrise": 1000, "sunset": 2000},
        "timezone": 19800,
    }
    result = normalize_current(
        current,
        {"city": {}, "list": []},
        {"timezone": "Asia/Kolkata", "current": {"uvi": 6.2}},
    )
    assert result["uv_index"] == 6.2
    assert result["sunrise"] == 1000
    assert result["sunset"] == 2000
    assert result["timezone_offset"] == 19800


def test_current_weather_leaves_uv_unavailable_when_one_call_has_no_uv():
    current = {"name": "Night City", "coord": {}, "weather": [], "main": {}, "wind": {}, "sys": {}}
    result = normalize_current(current, {"city": {}, "list": []}, {"current": {}})
    assert result["uv_index"] is None


def test_us_epa_aqi_breakpoints_category_and_dominant_pollutant():
    result = calculate_epa_aqi({
        "pm25": {"value": 35.49, "unit": "ug/m3", "averaging_period": "24h"},
        "o3": {"value": 0.040, "unit": "ppm", "averaging_period": "8h"},
    })
    assert result == {
        "value": 100,
        "category": "Moderate",
        "dominant_pollutant": "pm25",
        "subindices": {"pm25": 100, "o3": 37},
        "methodology": "US EPA AQI",
    }


def test_us_epa_aqi_62_is_moderate():
    result = calculate_epa_aqi({
        "pm25": {"value": 15.1, "unit": "ug/m3", "averaging_period": "24h"},
    })
    assert result["value"] == 62
    assert result["category"] == "Moderate"


def test_epa_aqi_requires_averaging_period_and_units():
    assert calculate_epa_aqi({"pm25": {"value": 35.4, "unit": "ug/m3"}}) is None
