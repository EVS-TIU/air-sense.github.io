import asyncio
from types import SimpleNamespace
from unittest.mock import AsyncMock

from app.config import Settings
from app.services import WeatherClient, build_recommendations


def fake_response(payload):
    return SimpleNamespace(raise_for_status=lambda: None, json=lambda: payload)


def test_air_quality_modelled_data_is_cached_and_station_sources_stay_separate():
    service = WeatherClient(Settings(air_quality_cache_ttl_seconds=300))
    model_payload = {
        "timezone": "Asia/Kolkata",
        "current": {
            "time": "2026-11-02T12:00",
            "us_aqi": 67,
            "pm2_5": 18.4,
            "pm10": 31.2,
            "nitrogen_dioxide": 10,
            "ozone": 40,
            "carbon_monoxide": 250,
            "sulphur_dioxide": 4,
        },
        "current_units": {key: "μg/m³" for key in (
            "pm2_5", "pm10", "nitrogen_dioxide", "ozone", "carbon_monoxide", "sulphur_dioxide"
        )},
    }
    service.client = SimpleNamespace(get=AsyncMock(return_value=fake_response(model_payload)))

    async def exercise():
        first = await service.air_quality(22.5582323, 88.4142686)
        second = await service.air_quality(22.5582323, 88.4142686)
        return first, second

    first, second = asyncio.run(exercise())
    assert first["modelled"]["provider"] == "Open-Meteo / CAMS"
    assert first["modelled"]["data_type"] == "modelled"
    assert first["modelled"]["aqi"] == {"value": 67, "category": "Moderate", "scale": "US AQI"}
    assert first["modelled"]["pollutants"]["PM2.5"]["value"] == 18.4
    assert first["latitude"] == second["latitude"] == 22.5582323
    assert first["longitude"] == second["longitude"] == 88.4142686
    assert first["stations"]["waqi"]["status"] == "not_configured"
    assert first["stations"]["openaq"]["status"] == "not_configured"
    # The modelled/OpenAQ response is cached, but WAQI status is requested fresh.
    assert service.client.get.await_count == 1


def test_station_validation_keeps_provider_values_and_units_separate():
    settings = Settings(waqi_api_token="waqi-test", openaq_api_key="openaq-test")
    service = WeatherClient(settings)
    model = fake_response({
        "timezone": "UTC",
        "current": {"time": "2026-11-02T12:00", "us_aqi": 32, "pm2_5": 5.0, "pm10": 8.0},
        "current_units": {"pm2_5": "μg/m³", "pm10": "μg/m³"},
    })
    locations = fake_response({"results": [{
        "id": 41,
        "name": "Ground station",
        "locality": "Test area",
        "coordinates": {"latitude": 22.56, "longitude": 88.41},
        "sensors": [{"id": 7, "parameter": {"name": "pm25", "units": "μg/m³"}}],
    }]})
    latest = fake_response({"results": [{
        "sensorsId": 7,
        "value": 44.0,
        "datetime": {"utc": "2026-11-02T11:00:00Z"},
    }]})
    def waqi_response(aqi):
        return fake_response({"status": "ok", "data": {
            "aqi": aqi,
            "city": {"name": "WAQI monitor", "geo": ["22.57", "88.42"]},
            "time": {"iso": "2026-11-02T11:15:00+05:30"},
            "iaqi": {"pm25": {"v": 58}},
        }})
    service.client = SimpleNamespace(get=AsyncMock(side_effect=[model, locations, latest, waqi_response(91), waqi_response(92)]))

    async def fetch_twice():
        return await service.air_quality(22.5582323, 88.4142686), await service.air_quality(22.5582323, 88.4142686)

    result, refreshed = asyncio.run(fetch_twice())
    assert result["modelled"]["aqi"]["value"] == 32
    assert result["stations"]["waqi"]["aqi"] == {"value": 91, "scale": "WAQI station AQI"}
    assert result["stations"]["waqi"]["pollutant_indices"]["pm25"] == 58
    openaq_station = result["stations"]["openaq"]["stations"][0]
    assert openaq_station["measurements"][0]["value"] == 44.0
    assert openaq_station["measurements"][0]["unit"] == "μg/m³"
    assert refreshed["stations"]["waqi"]["aqi"]["value"] == 92
    assert service.client.get.await_count == 5
    assert service.client.get.await_args_list[0].kwargs["params"]["latitude"] == 22.5582323
    assert service.client.get.await_args_list[0].kwargs["params"]["longitude"] == 88.4142686
    assert service.client.get.await_args_list[1].kwargs["params"]["coordinates"] == "22.5582323,88.4142686"
    assert service.client.get.await_args_list[3].args[0].endswith("/geo:22.5582323;88.4142686/")
    assert service.client.get.await_args_list[-1].kwargs["params"]["token"] == "waqi-test"
    assert service.client.get.await_args_list[1].kwargs["headers"]["X-API-Key"] == "openaq-test"


def test_recommendations_only_use_modelled_aqi_not_station_aqi():
    weather = {"temperature": 20, "humidity": 50, "hourly": [], "wind_speed": 0}
    air = {
        "modelled": {"aqi": {"value": 40, "scale": "US AQI"}},
        "stations": {
            "waqi": {"aqi": {"value": 350, "scale": "WAQI station AQI"}},
            "openaq": {"stations": [{"measurements": [{"parameter": "pm25", "value": 400}]}]},
        },
    }
    assert not any(risk["type"] == "air_quality" for risk in build_recommendations(weather, air, Settings())["risks"])
