from __future__ import annotations

import asyncio
import logging
import time
from collections.abc import Mapping
from typing import Any

import httpx

from .config import Settings

logger = logging.getLogger(__name__)


class WeatherServiceError(Exception):
    """A safe, user-facing weather provider error."""

    def __init__(self, message: str, status_code: int = 502):
        super().__init__(message)
        self.status_code = status_code


class TTLCache:
    def __init__(self, ttl_seconds: int):
        self.ttl_seconds = ttl_seconds
        self._values: dict[str, tuple[float, Any]] = {}
        self._lock = asyncio.Lock()

    async def get(self, key: str) -> Any | None:
        async with self._lock:
            item = self._values.get(key)
            if not item:
                return None
            if self.ttl_seconds == 0 or time.monotonic() - item[0] >= self.ttl_seconds:
                self._values.pop(key, None)
                return None
            return item[1]

    async def set(self, key: str, value: Any) -> None:
        async with self._lock:
            self._values[key] = (time.monotonic(), value)


def _cache_key(lat: float, lon: float, suffix: str) -> str:
    return f"{suffix}:{lat:.3f}:{lon:.3f}"


def wind_cardinal(degrees: float | None) -> str | None:
    if degrees is None:
        return None
    directions = ("N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE",
                  "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW")
    return directions[round(degrees / 22.5) % 16]


def condition_group(condition_id: int | None) -> str:
    if condition_id is None:
        return "unknown"
    if condition_id // 100 == 2:
        return "thunderstorm"
    if condition_id // 100 == 3:
        return "drizzle"
    if condition_id // 100 == 5:
        return "rain"
    if condition_id // 100 == 6:
        return "snow"
    if condition_id // 100 == 7:
        return "fog"
    if condition_id == 800:
        return "clear"
    if condition_id in (801, 802):
        return "partly_cloudy"
    if condition_id in (803, 804):
        return "overcast"
    return "unknown"


class WeatherClient:
    BASE_URL = "https://api.openweathermap.org"

    def __init__(self, settings: Settings, client: httpx.AsyncClient | None = None):
        self.settings = settings
        self.client = client
        self.cache = TTLCache(settings.cache_ttl_seconds)

    async def startup(self) -> None:
        if self.client is None:
            self.client = httpx.AsyncClient(timeout=self.settings.http_timeout_seconds)

    async def shutdown(self) -> None:
        if self.client is not None:
            await self.client.aclose()
            self.client = None

    def _require_key(self) -> str:
        if not self.settings.openweather_api_key:
            raise WeatherServiceError("Weather service is not configured", 503)
        return self.settings.openweather_api_key

    async def _get(self, path: str, params: Mapping[str, Any]) -> dict[str, Any]:
        if self.client is None:
            await self.startup()
        assert self.client is not None
        try:
            response = await self.client.get(f"{self.BASE_URL}{path}", params={**params, "appid": self._require_key()})
            if response.status_code == 401:
                raise WeatherServiceError("Weather service authentication failed", 502)
            if response.status_code == 404:
                raise WeatherServiceError("Weather data is unavailable for this location", 404)
            response.raise_for_status()
            return response.json()
        except WeatherServiceError:
            raise
        except (httpx.TimeoutException, httpx.NetworkError):
            logger.warning("Weather provider request failed due to network or timeout")
            raise WeatherServiceError("Weather service is temporarily unavailable", 502) from None
        except (httpx.HTTPStatusError, ValueError):
            logger.warning("Weather provider returned an invalid response")
            raise WeatherServiceError("Weather service returned an invalid response", 502) from None

    async def current(self, lat: float, lon: float) -> dict[str, Any]:
        key = _cache_key(lat, lon, "current")
        cached = await self.cache.get(key)
        if cached is not None:
            return cached
        current, forecast, uv_response, air_response = await asyncio.gather(
            self._get("/data/2.5/weather", {"lat": lat, "lon": lon, "units": "metric"}),
            self._get("/data/2.5/forecast", {"lat": lat, "lon": lon, "units": "metric"}),
            self._get(
                "/data/3.0/onecall",
                {"lat": lat, "lon": lon, "exclude": "minutely,hourly,daily,alerts", "units": "metric"},
            ),
            self._get("/data/2.5/air_pollution", {"lat": lat, "lon": lon}),
            return_exceptions=True,
        )
        if isinstance(current, Exception):
            raise current
        if isinstance(forecast, Exception):
            raise forecast
        if isinstance(uv_response, Exception):
            logger.info("UV data is unavailable from the configured OpenWeather plan")
            uv_response = None
        air = None if isinstance(air_response, Exception) else normalize_air_quality(air_response, lat, lon)
        result = normalize_current(current, forecast, uv_response, air)
        await self.cache.set(key, result)
        return result

    async def forecast(self, lat: float, lon: float) -> dict[str, Any]:
        key = _cache_key(lat, lon, "forecast")
        cached = await self.cache.get(key)
        if cached is not None:
            return cached
        raw = await self._get("/data/2.5/forecast", {"lat": lat, "lon": lon, "units": "metric"})
        result = normalize_forecast(raw)
        await self.cache.set(key, result)
        return result

    async def air_quality(self, lat: float, lon: float) -> dict[str, Any]:
        key = _cache_key(lat, lon, "air")
        cached = await self.cache.get(key)
        if cached is not None:
            return cached
        raw = await self._get("/data/2.5/air_pollution", {"lat": lat, "lon": lon})
        item = (raw.get("list") or [{}])[0]
        result = normalize_air_quality(raw, lat, lon)
        await self.cache.set(key, result)
        return result

    async def search(self, query: str) -> list[dict[str, Any]]:
        raw = await self._get("/geo/1.0/direct", {"q": query, "limit": 5})
        return [{"name": item.get("name"), "country": item.get("country"), "state": item.get("state"),
                 "latitude": item.get("lat"), "longitude": item.get("lon")} for item in raw]


def normalize_forecast(raw: dict[str, Any]) -> dict[str, Any]:
    points = []
    for item in raw.get("list", []):
        weather = (item.get("weather") or [{}])[0]
        rain = item.get("rain", {}).get("3h", 0) if isinstance(item.get("rain"), dict) else 0
        snow = item.get("snow", {}).get("3h", 0) if isinstance(item.get("snow"), dict) else 0
        points.append({"time": item.get("dt_txt"), "timestamp": item.get("dt"), "temperature": item.get("main", {}).get("temp"),
                       "feels_like": item.get("main", {}).get("feels_like"), "humidity": item.get("main", {}).get("humidity"),
                       "weather_code": weather.get("id"), "condition": condition_group(weather.get("id")),
                       "description": weather.get("description"), "precipitation_probability": round((item.get("pop") or 0) * 100),
                       "rain_3h": rain, "snow_3h": snow, "wind_speed": (item.get("wind") or {}).get("speed", 0) * 3.6})
    return {"location": {"latitude": raw.get("city", {}).get("coord", {}).get("lat"),
                         "longitude": raw.get("city", {}).get("coord", {}).get("lon")},
            "timezone": raw.get("city", {}).get("timezone"), "hourly": points}


def normalize_current(
    raw: dict[str, Any],
    forecast: dict[str, Any],
    uv_response: dict[str, Any] | None = None,
    air: dict[str, Any] | None = None,
) -> dict[str, Any]:
    main, wind = raw.get("main", {}), raw.get("wind", {})
    weather = (raw.get("weather") or [{}])[0]
    sys = raw.get("sys", {})
    normalized_forecast = normalize_forecast(forecast)
    return {"location_label": raw.get("name"), "location_name": raw.get("name"), "location_country": sys.get("country"),
            "latitude": raw.get("coord", {}).get("lat"), "longitude": raw.get("coord", {}).get("lon"),
            "timezone": None, "timezone_offset": raw.get("timezone", 0), "observed_at": raw.get("dt"),
            "is_day": None, "uv_index": uv_response.get("current", {}).get("uvi") if uv_response else None,
            "temperature": main.get("temp"), "apparent_temperature": main.get("feels_like"),
            "temperature_min": main.get("temp_min"), "temperature_max": main.get("temp_max"),
            "humidity": main.get("humidity"), "pressure": main.get("pressure"), "visibility": raw.get("visibility"),
            "wind_speed": (wind.get("speed") or 0) * 3.6, "wind_direction": wind.get("deg"),
            "wind_direction_cardinal": wind_cardinal(wind.get("deg")), "clouds": (raw.get("clouds") or {}).get("all"),
            "condition_code": weather.get("id"), "condition": condition_group(weather.get("id")),
            "description": weather.get("description"), "icon": weather.get("icon"),
            "icon_url": f"https://openweathermap.org/img/wn/{weather.get('icon')}@2x.png" if weather.get("icon") else None,
            "sunrise": sys.get("sunrise"), "sunset": sys.get("sunset"),
            "rain_1h": (raw.get("rain") or {}).get("1h"), "snow_1h": (raw.get("snow") or {}).get("1h"),
            "hourly": normalized_forecast["hourly"], "air_quality": air}


EPA_BREAKPOINTS: dict[str, tuple[tuple[float, float, int, int], ...]] = {
    "pm25": ((0.0, 9.0, 0, 50), (9.1, 35.4, 51, 100), (35.5, 55.4, 101, 150),
             (55.5, 125.4, 151, 200), (125.5, 225.4, 201, 300), (225.5, 325.4, 301, 500)),
    "pm10": ((0, 54, 0, 50), (55, 154, 51, 100), (155, 254, 101, 150),
             (255, 354, 151, 200), (355, 424, 201, 300), (425, 604, 301, 500)),
    "co": ((0.0, 4.4, 0, 50), (4.5, 9.4, 51, 100), (9.5, 12.4, 101, 150),
           (12.5, 15.4, 151, 200), (15.5, 30.4, 201, 300), (30.5, 50.4, 301, 500)),
    "so2": ((0, 35, 0, 50), (36, 75, 51, 100), (76, 185, 101, 150),
            (186, 304, 151, 200), (305, 604, 201, 300), (605, 1004, 301, 500)),
    "no2": ((0, 53, 0, 50), (54, 100, 51, 100), (101, 360, 101, 150),
            (361, 649, 151, 200), (650, 1249, 201, 300), (1250, 2049, 301, 500)),
    "o3": ((0.000, 0.054, 0, 50), (0.055, 0.070, 51, 100), (0.071, 0.085, 101, 150),
           (0.086, 0.105, 151, 200), (0.106, 0.200, 201, 300)),
}
EPA_REQUIREMENTS = {
    "pm25": ("24h", "ug/m3"),
    "pm10": ("24h", "ug/m3"),
    "co": ("8h", "ppm"),
    "so2": ("1h", "ppb"),
    "no2": ("1h", "ppb"),
    "o3": ("8h", "ppm"),
}


def calculate_epa_aqi(pollutants: Mapping[str, Mapping[str, Any]]) -> dict[str, Any] | None:
    """Calculate EPA AQI only from explicitly averaged, correctly unit-tagged values."""
    subindices: dict[str, int] = {}
    for name, value in pollutants.items():
        concentration = value.get("value")
        if not isinstance(concentration, (int, float)) or value.get("averaging_period") not in {"1h", "8h", "24h"}:
            continue
        expected_period, expected_unit = EPA_REQUIREMENTS.get(name, (None, None))
        if value.get("averaging_period") != expected_period or value.get("unit") != expected_unit:
            continue
        truncated = value.get("truncated_value", truncate_epa_concentration(name, concentration))
        for low, high, index_low, index_high in EPA_BREAKPOINTS.get(name, ()):
            if low <= truncated <= high:
                index = round((index_high - index_low) / (high - low) * (truncated - low) + index_low)
                subindices[name] = min(index, 500)
                break
    if not subindices:
        return None
    dominant_pollutant, aqi = max(subindices.items(), key=lambda item: item[1])
    return {"value": aqi, "category": epa_category(aqi), "dominant_pollutant": dominant_pollutant,
            "subindices": subindices, "methodology": "US EPA AQI"}


def truncate_epa_concentration(pollutant: str, concentration: float) -> float:
    if pollutant in {"pm25", "co"}:
        return int(concentration * 10) / 10
    if pollutant == "o3":
        return int(concentration * 1000) / 1000
    return int(concentration)


def epa_category(aqi: int) -> str:
    if aqi <= 50: return "Good"
    if aqi <= 100: return "Moderate"
    if aqi <= 150: return "Unhealthy for Sensitive Groups"
    if aqi <= 200: return "Unhealthy"
    if aqi <= 300: return "Very Unhealthy"
    return "Hazardous"


def normalize_air_quality(raw: dict[str, Any], lat: float, lon: float) -> dict[str, Any]:
    item = (raw.get("list") or [{}])[0]
    provider_aqi = item.get("main", {}).get("aqi")
    components = item.get("components", {})
    return {"location": {"latitude": lat, "longitude": lon}, "provider": "OpenWeather",
            "provider_index": provider_aqi, "provider_scale": "1–5 (OpenWeather air pollution index)",
            "methodology": "US EPA AQI when valid averaged pollutant data is available; otherwise OpenWeather 1–5 index",
            "epa_aqi": None, "dominant_pollutant": None, "components": components,
            "observed_at": item.get("dt")}


def build_recommendations(weather: Mapping[str, Any], air: Mapping[str, Any] | None, settings: Settings) -> dict[str, Any]:
    risks: list[dict[str, Any]] = []
    def add(kind: str, severity: str, message: str) -> None:
        risks.append({"type": kind, "severity": severity, "message": message})
    temp = weather.get("temperature")
    if isinstance(temp, (int, float)):
        if temp >= settings.extreme_heat_celsius: add("extreme_heat", "Severe", "Avoid prolonged outdoor exposure and stay hydrated.")
        elif temp >= settings.heat_celsius: add("heat", "High", "Stay hydrated and limit strenuous outdoor activity.")
        elif temp <= settings.extreme_cold_celsius: add("extreme_cold", "Severe", "Limit time outdoors and wear insulated clothing.")
        elif temp <= settings.cold_celsius: add("cold", "Moderate", "Wear warm layers when going outside.")
    humidity = weather.get("humidity")
    if isinstance(humidity, (int, float)) and humidity >= settings.high_humidity_percent:
        add("humidity", "Moderate", "Expect uncomfortable conditions and take breaks in a cool place.")
    rain = max((p.get("rain_3h", 0) or 0) for p in weather.get("hourly", []) if isinstance(p, Mapping)) if weather.get("hourly") else (weather.get("rain_1h") or 0)
    pop = max((p.get("precipitation_probability", 0) or 0) for p in weather.get("hourly", []) if isinstance(p, Mapping)) if weather.get("hourly") else 0
    if rain >= settings.heavy_rain_mm: add("heavy_rain", "High", "Consider postponing outdoor activities and avoid flooded areas.")
    elif pop >= 50 or rain > 0: add("rain", "Low", "Carry an umbrella or rain protection.")
    wind = weather.get("wind_speed")
    if isinstance(wind, (int, float)) and wind >= settings.strong_wind_kmh: add("strong_wind", "High", "Secure loose items and use caution outdoors.")
    if weather.get("condition") == "thunderstorm": add("thunderstorm", "Severe", "Stay indoors and avoid exposed high places.")
    visibility = weather.get("visibility")
    if isinstance(visibility, (int, float)) and visibility <= settings.low_visibility_m: add("low_visibility", "High", "Use caution when driving and allow extra travel time.")
    aqi = air.get("epa_aqi", {}).get("value") if air and isinstance(air.get("epa_aqi"), Mapping) else None
    provider_index = air.get("provider_index") if air else None
    if isinstance(aqi, int) and aqi >= 101:
        add("air_quality", "High" if aqi < 201 else "Severe", "Reduce strenuous outdoor activity and consider a mask.")
    elif isinstance(provider_index, int) and provider_index >= settings.poor_aqi:
        add("air_quality", "High", "Reduce strenuous outdoor activity and consider a mask.")
    return {"recommendations": [risk["message"] for risk in risks], "risks": risks,
            "overall_severity": max((r["severity"] for r in risks), key=("Low", "Moderate", "High", "Severe").index, default="Low")}