from __future__ import annotations

import asyncio
import logging
import math
import time
from datetime import datetime, timezone
from zoneinfo import ZoneInfo
from collections.abc import Mapping
from typing import Any

import httpx

import re
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
    return f"{suffix}:{float(lat).hex()}:{float(lon).hex()}"


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
    if condition_id == 803:
        return "cloudy"
    if condition_id == 804:
        return "overcast"
    return "unknown"



COUNTRY_NAMES: dict[str, str] = {
    "AD": "Andorra", "AE": "United Arab Emirates", "AF": "Afghanistan", "AG": "Antigua and Barbuda",
    "AL": "Albania", "AM": "Armenia", "AO": "Angola", "AR": "Argentina", "AT": "Austria", "AU": "Australia",
    "AZ": "Azerbaijan", "BA": "Bosnia and Herzegovina", "BB": "Barbados", "BD": "Bangladesh", "BE": "Belgium",
    "BF": "Burkina Faso", "BG": "Bulgaria", "BH": "Bahrain", "BI": "Burundi", "BJ": "Benin", "BN": "Brunei",
    "BO": "Bolivia", "BR": "Brazil", "BS": "Bahamas", "BT": "Bhutan", "BW": "Botswana", "BY": "Belarus",
    "BZ": "Belize", "CA": "Canada", "CD": "DR Congo", "CF": "Central African Republic", "CG": "Republic of the Congo",
    "CH": "Switzerland", "CI": "Ivory Coast", "CL": "Chile", "CM": "Cameroon", "CN": "China", "CO": "Colombia",
    "CR": "Costa Rica", "CU": "Cuba", "CV": "Cape Verde", "CY": "Cyprus", "CZ": "Czech Republic", "DE": "Germany",
    "DJ": "Djibouti", "DK": "Denmark", "DM": "Dominica", "DO": "Dominican Republic", "DZ": "Algeria", "EC": "Ecuador",
    "EE": "Estonia", "EG": "Egypt", "ER": "Eritrea", "ES": "Spain", "ET": "Ethiopia", "FI": "Finland", "FJ": "Fiji",
    "FM": "Micronesia", "FR": "France", "GA": "Gabon", "GB": "United Kingdom", "GD": "Grenada", "GE": "Georgia",
    "GH": "Ghana", "GM": "Gambia", "GN": "Guinea", "GR": "Greece", "GT": "Guatemala", "GW": "Guinea-Bissau",
    "GY": "Guyana", "HN": "Honduras", "HR": "Croatia", "HT": "Haiti", "HU": "Hungary", "ID": "Indonesia",
    "IE": "Ireland", "IL": "Israel", "IN": "India", "IQ": "Iraq", "IR": "Iran", "IS": "Iceland", "IT": "Italy",
    "JM": "Jamaica", "JO": "Jordan", "JP": "Japan", "KE": "Kenya", "KG": "Kyrgyzstan", "KH": "Cambodia",
    "KI": "Kiribati", "KM": "Comoros", "KN": "Saint Kitts and Nevis", "KP": "North Korea", "KR": "South Korea",
    "KW": "Kuwait", "KZ": "Kazakhstan", "LA": "Laos", "LB": "Lebanon", "LC": "Saint Lucia", "LI": "Liechtenstein",
    "LK": "Sri Lanka", "LR": "Liberia", "LS": "Lesotho", "LT": "Lithuania", "LU": "Luxembourg", "LV": "Latvia",
    "LY": "Libya", "MA": "Morocco", "MC": "Monaco", "MD": "Moldova", "ME": "Montenegro", "MG": "Madagascar",
    "MH": "Marshall Islands", "MK": "North Macedonia", "ML": "Mali", "MM": "Myanmar", "MN": "Mongolia",
    "MR": "Mauritania", "MT": "Malta", "MU": "Mauritius", "MV": "Maldives", "MW": "Malawi", "MX": "Mexico",
    "MY": "Malaysia", "MZ": "Mozambique", "NA": "Namibia", "NE": "Niger", "NG": "Nigeria", "NI": "Nicaragua",
    "NL": "Netherlands", "NO": "Norway", "NP": "Nepal", "NR": "Nauru", "NZ": "New Zealand", "OM": "Oman",
    "PA": "Panama", "PE": "Peru", "PG": "Papua New Guinea", "PH": "Philippines", "PK": "Pakistan", "PL": "Poland",
    "PR": "Puerto Rico", "PT": "Portugal", "PW": "Palau", "PY": "Paraguay", "QA": "Qatar", "RO": "Romania",
    "RS": "Serbia", "RU": "Russia", "RW": "Rwanda", "SA": "Saudi Arabia", "SB": "Solomon Islands", "SC": "Seychelles",
    "SD": "Sudan", "SE": "Sweden", "SG": "Singapore", "SI": "Slovenia", "SK": "Slovakia", "SL": "Sierra Leone",
    "SM": "San Marino", "SN": "Senegal", "SO": "Somalia", "SR": "Suriname", "SS": "South Sudan", "ST": "Sao Tome and Principe",
    "SV": "El Salvador", "SY": "Syria", "SZ": "Eswatini", "TD": "Chad", "TG": "Togo", "TH": "Thailand",
    "TJ": "Tajikistan", "TL": "Timor-Leste", "TM": "Turkmenistan", "TN": "Tunisia", "TO": "Tonga", "TR": "Turkey",
    "TT": "Trinidad and Tobago", "TV": "Tuvalu", "TW": "Taiwan", "TZ": "Tanzania", "UA": "Ukraine", "UG": "Uganda",
    "US": "United States", "UY": "Uruguay", "UZ": "Uzbekistan", "VA": "Vatican City", "VC": "Saint Vincent and the Grenadines",
    "VE": "Venezuela", "VN": "Vietnam", "VU": "Vanuatu", "WS": "Samoa", "YE": "Yemen", "ZA": "South Africa",
    "ZM": "Zambia", "ZW": "Zimbabwe",
}


class WeatherClient:
    BASE_URL = "https://api.openweathermap.org"
    WIND_TILE_URL = "https://tile.openweathermap.org/map/wind_new/{z}/{x}/{y}.png"
    OPEN_METEO_URL = "https://api.open-meteo.com/v1/forecast"

    def __init__(self, settings: Settings, client: httpx.AsyncClient | None = None):
        self.settings = settings
        self.client = client
        self.cache = TTLCache(settings.cache_ttl_seconds)
        self.air_quality_cache = TTLCache(settings.air_quality_cache_ttl_seconds)
        self._nominatim_lock = asyncio.Lock()
        self._last_nominatim_request = 0.0

    async def _nominatim_get(self, path: str, params: Mapping[str, Any]) -> httpx.Response:
        if self.client is None:
            await self.startup()
        assert self.client is not None
        async with self._nominatim_lock:
            delay = 1.0 - (time.monotonic() - self._last_nominatim_request)
            if delay > 0:
                await asyncio.sleep(delay)
            self._last_nominatim_request = time.monotonic()
            return await self.client.get(
                f"https://nominatim.openstreetmap.org/{path}", params=params,
                headers={"User-Agent": "AirSenseWeatherApp/1.0 (https://air-sense.github.io)"},
            )

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

    async def wind_tile(self, z: int, x: int, y: int) -> bytes:
        """Return an OpenWeather wind tile without exposing the API key."""
        if self.client is None:
            await self.startup()
        assert self.client is not None
        try:
            response = await self.client.get(
                self.WIND_TILE_URL.format(z=z, x=x, y=y),
                params={"appid": self._require_key()},
            )
            if response.status_code == 401:
                raise WeatherServiceError("Weather service authentication failed", 502)
            response.raise_for_status()
            return response.content
        except WeatherServiceError:
            raise
        except (httpx.TimeoutException, httpx.NetworkError):
            raise WeatherServiceError("Wind tile service is temporarily unavailable", 502) from None
        except httpx.HTTPError:
            raise WeatherServiceError("Wind tile service returned an error", 502) from None
        except (httpx.HTTPStatusError, ValueError):
            logger.warning("Weather provider returned an invalid response")
            raise WeatherServiceError("Weather service returned an invalid response", 502) from None

    async def current(self, lat: float, lon: float) -> dict[str, Any]:
        key = _cache_key(lat, lon, "current")
        cached = await self.cache.get(key)
        if cached is not None:
            return cached
        try:
            raw = await self._open_meteo(lat, lon)
            result = normalize_openmeteo(raw, lat, lon)
            await self._apply_nominatim_location(result, lat, lon)
            await self.cache.set(key, result)
            return result
        except (WeatherServiceError, httpx.HTTPError, ValueError, KeyError, TypeError) as exc:
            logger.warning("Open-Meteo current weather unavailable; using OpenWeather fallback: %s", type(exc).__name__)
        current, forecast, uv_response, geo_response = await asyncio.gather(
            self._get("/data/2.5/weather", {"lat": lat, "lon": lon, "units": "metric"}),
            self._get("/data/2.5/forecast", {"lat": lat, "lon": lon, "units": "metric"}),
            self._get(
                "/data/3.0/onecall",
                {"lat": lat, "lon": lon, "exclude": "minutely,hourly,alerts", "units": "metric"},
            ),
            self._get("/geo/1.0/reverse", {"lat": lat, "lon": lon, "limit": 1}),
            return_exceptions=True,
        )
        if isinstance(current, Exception):
            raise current
        if isinstance(forecast, Exception):
            raise forecast
        if isinstance(uv_response, Exception):
            logger.info("UV data is unavailable from the configured OpenWeather plan")
            uv_response = None
        geo_item = (
            geo_response[0]
            if isinstance(geo_response, list) and len(geo_response) > 0 and isinstance(geo_response[0], dict)
            else None
        )
        result = normalize_current(current, forecast, uv_response, None, geo_item)
        # OpenWeather reports its own snapped grid coordinates. Keep the
        # caller's exact selection as the authoritative dashboard location.
        result["latitude"] = lat
        result["longitude"] = lon
        await self._apply_nominatim_location(result, lat, lon)
        await self.cache.set(key, result)
        return result

    async def _apply_nominatim_location(self, weather: dict[str, Any], lat: float, lon: float) -> None:
        try:
            results = await self.reverse(lat, lon)
        except Exception:
            logger.info("Location name unavailable for selected coordinates")
            results = []
        if not results:
            # A provider city label can be useful as a hint, but without a
            # reverse-geocoder match it must not be presented as the exact
            # device locality.
            weather.update({
                "latitude": lat,
                "longitude": lon,
                "location_is_approximate": bool(weather.get("location_name") or weather.get("location_label")),
                "location_geocoding_source": None,
            })
            return
        place = results[0]
        weather.update({
            "latitude": lat,
            "longitude": lon,
            "location_name": place.get("name"),
            "location_label": place.get("name"),
            "location_locality": place.get("locality"),
            "location_district": place.get("district"),
            "location_state": place.get("state"),
            "location_country": place.get("country"),
            "location_country_code": place.get("country_code"),
            "location_is_approximate": not bool(place.get("locality")),
            "location_geocoding_source": "nominatim",
        })

    async def forecast(self, lat: float, lon: float) -> dict[str, Any]:
        key = _cache_key(lat, lon, "forecast")
        cached = await self.cache.get(key)
        if cached is not None:
            return cached
        try:
            raw = await self._open_meteo(lat, lon)
            result = normalize_openmeteo(raw, lat, lon)
            await self.cache.set(key, result)
            return {"location": {"latitude": lat, "longitude": lon}, "timezone": result["timezone"],
                    "hourly": result["hourly"], "daily": result["daily"]}
        except (WeatherServiceError, httpx.HTTPError, ValueError, KeyError, TypeError) as exc:
            logger.warning("Open-Meteo forecast unavailable; using OpenWeather fallback: %s", type(exc).__name__)
        raw = await self._get("/data/2.5/forecast", {"lat": lat, "lon": lon, "units": "metric"})
        result = normalize_forecast(raw)
        try:
            onecall = await self._get("/data/3.0/onecall", {"lat": lat, "lon": lon, "exclude": "current,minutely,hourly,alerts", "units": "metric"})
            result["daily"] = normalize_openweather_daily(onecall.get("daily", []), onecall.get("timezone_offset", 0))
        except WeatherServiceError:
            result["daily"] = []
        await self.cache.set(key, result)
        return result

    async def _open_meteo(self, lat: float, lon: float) -> dict[str, Any]:
        if self.client is None:
            await self.startup()
        assert self.client is not None
        response = await self.client.get(self.settings.openmeteo_forecast_url or self.OPEN_METEO_URL, params={
            "latitude": lat, "longitude": lon,
            "current": "temperature_2m,relative_humidity_2m,apparent_temperature,precipitation,rain,weather_code,wind_speed_10m,wind_direction_10m",
            "hourly": "temperature_2m,relative_humidity_2m,apparent_temperature,precipitation_probability,precipitation,weather_code,visibility,uv_index,wind_speed_10m,wind_direction_10m",
            "daily": "temperature_2m_max,temperature_2m_min,weather_code,precipitation_probability_max",
            "timezone": "auto", "forecast_days": 7,
        })
        response.raise_for_status()
        raw = response.json()
        if not isinstance(raw, dict):
            raise ValueError("Invalid Open-Meteo payload")
        return raw

    async def air_quality(self, lat: float, lon: float) -> dict[str, Any]:
        key = _cache_key(lat, lon, "air-quality:v1")
        cached = await self.air_quality_cache.get(key)
        if cached is None:
            modelled = await self._fetch_modelled_air_quality(lat, lon)
            openaq = await self._fetch_openaq_stations(lat, lon)
            cache_value = {
                "latitude": lat,
                "longitude": lon,
                "modelled": modelled,
                "stations": {"openaq": openaq},
            }
            await self.air_quality_cache.set(key, cache_value)
            cached = {**cache_value, "stations": dict(cache_value["stations"])}
        else:
            # Make the station collection request-local; never mutate a value
            # held by the shared cache.
            cached = {**cached, "stations": dict(cached["stations"])}

        # WAQI prohibits redistributing cached/archived data. Fetch its nearby
        # station feed separately and never store that response in our cache.
        cached["stations"]["waqi"] = await self._fetch_waqi_station(lat, lon)
        return cached

    async def _fetch_modelled_air_quality(self, lat: float, lon: float) -> dict[str, Any]:
        if self.client is None:
            await self.startup()
        assert self.client is not None
        try:
            response = await self.client.get(
                self.settings.openmeteo_air_quality_url,
                params={
                    "latitude": lat,
                    "longitude": lon,
                    "current": "us_aqi,pm2_5,pm10,nitrogen_dioxide,ozone,carbon_monoxide,sulphur_dioxide",
                    "timezone": "auto",
                },
            )
            response.raise_for_status()
            payload = response.json()
            current = payload.get("current") if isinstance(payload, dict) else None
            if (
                not isinstance(current, dict)
                or not isinstance(current.get("us_aqi"), (int, float))
                or not math.isfinite(current["us_aqi"])
                or current["us_aqi"] < 0
            ):
                raise ValueError("Open-Meteo did not return a current US AQI")
            timestamp = current.get("time")
            if not timestamp:
                raise ValueError("Open-Meteo did not return an AQI timestamp")
        except (httpx.TimeoutException, httpx.NetworkError):
            logger.warning("Open-Meteo air-quality request timed out or failed")
            raise WeatherServiceError("Modelled air-quality data is temporarily unavailable", 504) from None
        except (httpx.HTTPError, ValueError, TypeError):
            logger.warning("Open-Meteo returned invalid air-quality data")
            raise WeatherServiceError("Modelled air-quality data is temporarily unavailable", 502) from None

        units = payload.get("current_units")
        if not isinstance(units, dict):
            units = {}
        pollutant_names = {
            "pm2_5": "PM2.5",
            "pm10": "PM10",
            "nitrogen_dioxide": "NO2",
            "ozone": "O3",
            "carbon_monoxide": "CO",
            "sulphur_dioxide": "SO2",
        }
        return {
            "provider": "Open-Meteo / CAMS",
            "data_type": "modelled",
            "scale": "US AQI",
            "aqi": {
                "value": current["us_aqi"],
                "category": epa_category(round(current["us_aqi"])),
                "scale": "US AQI",
            },
            "pollutants": {
                name: {
                    "value": current.get(key) if isinstance(current.get(key), (int, float)) and math.isfinite(current[key]) else None,
                    "unit": units.get(key, "μg/m³"),
                }
                for key, name in pollutant_names.items()
            },
            "timestamp": timestamp,
            "timezone": payload.get("timezone"),
            "coordinates": {"latitude": lat, "longitude": lon},
            "attribution": "Open-Meteo; CAMS ENSEMBLE",
        }

    async def _fetch_waqi_station(self, lat: float, lon: float) -> dict[str, Any]:
        if not self.settings.waqi_api_token:
            return {"provider": "WAQI", "status": "not_configured", "data_type": "station"}
        if self.client is None:
            await self.startup()
        assert self.client is not None
        try:
            response = await self.client.get(
                f"https://api.waqi.info/feed/geo:{lat};{lon}/",
                params={"token": self.settings.waqi_api_token},
            )
            response.raise_for_status()
            payload = response.json()
            if not isinstance(payload, dict):
                return {"provider": "WAQI", "status": "unavailable", "data_type": "station"}
            data = payload.get("data")
            if payload.get("status") != "ok" or not isinstance(data, dict):
                return {"provider": "WAQI", "status": "unavailable", "data_type": "station"}
        except (httpx.HTTPError, ValueError, TypeError, AttributeError):
            logger.info("WAQI station validation is unavailable")
            return {"provider": "WAQI", "status": "unavailable", "data_type": "station"}

        city = data.get("city") if isinstance(data.get("city"), dict) else {}
        geo = city.get("geo") or []
        time_data = data.get("time") if isinstance(data.get("time"), dict) else {}
        indices = {}
        iaqi = data.get("iaqi") if isinstance(data.get("iaqi"), dict) else {}
        for key, item in iaqi.items():
            value = item.get("v") if isinstance(item, dict) else None
            if isinstance(value, (int, float)) and math.isfinite(value):
                indices[key] = value
        aqi = data.get("aqi")
        def coordinate_or_none(index: int) -> float | None:
            try:
                value = float(geo[index])
                return value if math.isfinite(value) else None
            except (IndexError, TypeError, ValueError):
                return None

        attributions = [
            {"name": str(item.get("name")), "url": item.get("url")}
            for item in data.get("attributions", [])
            if isinstance(item, dict) and item.get("name")
        ] if isinstance(data.get("attributions"), list) else []
        return {
            "provider": "WAQI",
            "status": "available" if isinstance(aqi, (int, float)) and math.isfinite(aqi) else "no_aqi",
            "data_type": "station",
            "station": city.get("name"),
            "coordinates": {
                "latitude": coordinate_or_none(0),
                "longitude": coordinate_or_none(1),
            },
            "aqi": {"value": aqi, "scale": "WAQI station AQI"}
            if isinstance(aqi, (int, float)) and math.isfinite(aqi) else None,
            # WAQI iaqi readings are indices, not interchangeable raw
            # concentrations; preserve that distinction in the response.
            "pollutant_indices": indices,
            "timestamp": time_data.get("iso") or time_data.get("s"),
            "attributions": attributions,
            "attribution": "World Air Quality Index Project (WAQI)",
        }

    async def _fetch_openaq_stations(self, lat: float, lon: float) -> dict[str, Any]:
        if not self.settings.openaq_api_key:
            return {"provider": "OpenAQ", "status": "not_configured", "data_type": "station", "stations": []}
        if self.client is None:
            await self.startup()
        assert self.client is not None
        headers = {"X-API-Key": self.settings.openaq_api_key}
        try:
            response = await self.client.get(
                "https://api.openaq.org/v3/locations",
                params={"coordinates": f"{lat},{lon}", "radius": 25000, "limit": 100, "page": 1},
                headers=headers,
            )
            response.raise_for_status()
            locations_payload = response.json()
            if not isinstance(locations_payload, dict):
                raise ValueError("Invalid OpenAQ locations response")
            locations = locations_payload.get("results", [])
            if not isinstance(locations, list):
                raise ValueError("Invalid OpenAQ locations response")
        except (httpx.HTTPError, ValueError, TypeError, AttributeError):
            logger.info("OpenAQ station validation is unavailable")
            return {"provider": "OpenAQ", "status": "unavailable", "data_type": "station", "stations": []}

        def distance_m(location: dict[str, Any]) -> float:
            coordinates = location.get("coordinates") or {}
            station_lat, station_lon = coordinates.get("latitude"), coordinates.get("longitude")
            if (
                not isinstance(station_lat, (int, float))
                or not isinstance(station_lon, (int, float))
                or not math.isfinite(station_lat)
                or not math.isfinite(station_lon)
            ):
                return float("inf")
            phi1, phi2 = math.radians(lat), math.radians(station_lat)
            dphi = math.radians(station_lat - lat)
            dlambda = math.radians(station_lon - lon)
            a = min(1.0, max(0.0, math.sin(dphi / 2) ** 2 + math.cos(phi1) * math.cos(phi2) * math.sin(dlambda / 2) ** 2))
            return 6_371_000 * 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))

        nearest = sorted(
            (location for location in locations if isinstance(location, dict) and location.get("id")),
            key=distance_m,
        )[:3]

        async def station_data(location: dict[str, Any]) -> dict[str, Any] | None:
            try:
                latest_response = await self.client.get(
                    f"https://api.openaq.org/v3/locations/{location['id']}/latest",
                    params={"limit": 100, "page": 1},
                    headers=headers,
                )
                latest_response.raise_for_status()
                latest_payload = latest_response.json()
                if not isinstance(latest_payload, dict):
                    return None
                readings = latest_payload.get("results", [])
                if not isinstance(readings, list):
                    return None
            except (httpx.HTTPError, ValueError, TypeError, AttributeError):
                return None

            sensors = {}
            for instrument in location.get("instruments") or []:
                if not isinstance(instrument, dict):
                    continue
                for sensor in instrument.get("sensors") or []:
                    if not isinstance(sensor, dict):
                        continue
                    sensors[sensor.get("id")] = sensor
            for sensor in location.get("sensors") or []:
                if not isinstance(sensor, dict):
                    continue
                sensors[sensor.get("id")] = sensor
            measurements = []
            for reading in readings:
                if not isinstance(reading, dict):
                    continue
                sensor = sensors.get(reading.get("sensorsId"), {})
                parameter = sensor.get("parameter") if isinstance(sensor.get("parameter"), dict) else {}
                name = parameter.get("name") or parameter.get("displayName")
                if name:
                    measurements.append({
                        "parameter": name,
                        "value": reading.get("value")
                        if isinstance(reading.get("value"), (int, float)) and math.isfinite(reading["value"])
                        else None,
                        "unit": parameter.get("units") or sensor.get("units"),
                        "timestamp": (reading.get("datetime") or {}).get("utc"),
                    })
            if not measurements:
                return None
            source_attributions = []
            for license_item in location.get("licenses") or []:
                if not isinstance(license_item, dict):
                    continue
                attribution = license_item.get("attribution")
                if isinstance(attribution, dict) and attribution.get("name"):
                    source_attributions.append({
                        "name": str(attribution["name"]),
                        "url": attribution.get("url"),
                    })
            return {
                "provider": "OpenAQ",
                "data_type": "station",
                "station": location.get("name"),
                "locality": location.get("locality"),
                "distance_m": round(distance_m(location)),
                "coordinates": location.get("coordinates"),
                "measurements": measurements,
                "attributions": source_attributions,
            }

        station_results = await asyncio.gather(*(station_data(location) for location in nearest))
        stations = [station for station in station_results if station]
        return {
            "provider": "OpenAQ",
            "status": "available" if stations else "no_nearby_data",
            "data_type": "station",
            "stations": stations,
            "attribution": "OpenAQ",
        }


    async def search(self, query: str) -> list[dict[str, Any]]:
        clean_q = query.strip()
        if not clean_q:
            return []
        key = f"search:v2:{clean_q.lower()}"
        cached = await self.cache.get(key)
        if cached is not None:
            return cached

        if self.client is None:
            await self.startup()
        assert self.client is not None

        q_lower = clean_q.lower()
        query_tokens = [w for w in re.split(r"[, \t]+", q_lower) if len(w) > 0]

        async def fetch_nominatim() -> list[dict[str, Any]]:
            try:
                resp = await self._nominatim_get(
                    "search",
                    params={"q": clean_q, "format": "jsonv2", "addressdetails": 1, "limit": 10, "accept-language": "en"},
                )
                if resp.status_code == 200:
                    candidates = []
                    for item in resp.json():
                        addr = item.get("address") or {}
                        name = (
                            addr.get("neighbourhood")
                            or addr.get("suburb")
                            or item.get("name")
                            or addr.get("town")
                            or addr.get("city")
                            or addr.get("village")
                            or addr.get("state_district")
                            or addr.get("state")
                        )
                        city = addr.get("city") or addr.get("town") or addr.get("village") or addr.get("municipality")
                        district = addr.get("district") or addr.get("state_district") or addr.get("county") or addr.get("city_district")
                        state = addr.get("state") or addr.get("region")
                        country = addr.get("country") or ""
                        cc = (addr.get("country_code") or "").upper()
                        if cc and not country:
                            country = COUNTRY_NAMES.get(cc, cc)
                        elif cc and cc in COUNTRY_NAMES and not country:
                            country = COUNTRY_NAMES[cc]
                        importance = float(item.get("importance") or 0.3)
                        place_type = item.get("type") or item.get("category") or "place"
                        lat_val = item.get("lat")
                        lon_val = item.get("lon")
                        if name and lat_val and lon_val:
                            candidates.append({
                                "name": name,
                                "city": city or name,
                                "district": district if district != name else None,
                                "state": state if state != name else None,
                                "country": country or (COUNTRY_NAMES.get(cc, cc) if cc else ""),
                                "country_code": cc,
                                "latitude": float(lat_val),
                                "longitude": float(lon_val),
                                "type": place_type,
                                "importance": importance,
                                "source": "nominatim",
                            })
                    return candidates
            except Exception:
                pass
            return []

        async def fetch_openweather() -> list[dict[str, Any]]:
            try:
                raw = await self._get("/geo/1.0/direct", {"q": clean_q, "limit": 6})
                if isinstance(raw, list):
                    candidates = []
                    for item in raw:
                        name = item.get("name")
                        lat = item.get("lat")
                        lon = item.get("lon")
                        if name and lat is not None and lon is not None:
                            cc = (item.get("country") or "").upper()
                            country = COUNTRY_NAMES.get(cc, cc)
                            state = item.get("state")
                            candidates.append({
                                "name": name,
                                "city": name,
                                "district": None,
                                "state": state if state != name else None,
                                "country": country,
                                "country_code": cc,
                                "latitude": float(lat),
                                "longitude": float(lon),
                                "type": "city",
                                "importance": 0.7,
                                "source": "openweather",
                            })
                    return candidates
            except Exception:
                pass
            return []

        async def fetch_geoapify() -> list[dict[str, Any]]:
            if not self.settings.geoapify_api_key:
                return []
            try:
                resp = await self.client.get(
                    "https://api.geoapify.com/v1/geocode/autocomplete",
                    params={"text": clean_q, "apiKey": self.settings.geoapify_api_key, "limit": 8},
                )
                if resp.status_code == 200:
                    candidates = []
                    for feature in resp.json().get("features", []):
                        props = feature.get("properties", {})
                        geom = feature.get("geometry", {})
                        coords = geom.get("coordinates") or []
                        if len(coords) >= 2 and props.get("name"):
                            cc = (props.get("country_code") or "").upper()
                            candidates.append({
                                "name": props.get("name") or props.get("city"),
                                "city": props.get("city") or props.get("name"),
                                "district": props.get("district") or props.get("suburb"),
                                "state": props.get("state"),
                                "country": props.get("country") or COUNTRY_NAMES.get(cc, cc),
                                "country_code": cc,
                                "latitude": float(coords[1]),
                                "longitude": float(coords[0]),
                                "type": props.get("result_type") or "place",
                                "importance": props.get("rank", {}).get("confidence", 0.5),
                                "source": "geoapify",
                            })
                    return candidates
            except Exception:
                pass
            return []

        async def fetch_maptiler() -> list[dict[str, Any]]:
            if not self.settings.maptiler_api_key:
                return []
            try:
                resp = await self.client.get(
                    f"https://api.maptiler.com/geocoding/{clean_q}.json",
                    params={"key": self.settings.maptiler_api_key, "limit": 8},
                )
                if resp.status_code == 200:
                    candidates = []
                    for feature in resp.json().get("features", []):
                        center = feature.get("center") or []
                        text = feature.get("text")
                        if len(center) >= 2 and text:
                            context = feature.get("context") or []
                            country_part = next((c.get("text") for c in context if "country" in (c.get("id") or "")), None)
                            cc_part = next((c.get("short_code", "").upper() for c in context if "country" in (c.get("id") or "")), "")
                            region_part = next((c.get("text") for c in context if "region" in (c.get("id") or "")), None)
                            candidates.append({
                                "name": text,
                                "city": text,
                                "district": None,
                                "state": region_part,
                                "country": country_part or COUNTRY_NAMES.get(cc_part, cc_part),
                                "country_code": cc_part,
                                "latitude": float(center[1]),
                                "longitude": float(center[0]),
                                "type": (feature.get("place_type") or ["place"])[0],
                                "importance": feature.get("relevance", 0.5),
                                "source": "maptiler",
                            })
                    return candidates
            except Exception:
                pass
            return []

        tasks = [fetch_nominatim(), fetch_openweather()]
        if self.settings.geoapify_api_key:
            tasks.append(fetch_geoapify())
        if self.settings.maptiler_api_key:
            tasks.append(fetch_maptiler())

        gathered = await asyncio.gather(*tasks, return_exceptions=True)

        all_candidates: list[dict[str, Any]] = []
        for res_list in gathered:
            if isinstance(res_list, list):
                all_candidates.extend(res_list)

        def score(cand: dict[str, Any]) -> float:
            s = 0.0
            name = (cand.get("name") or "").lower()
            city = (cand.get("city") or "").lower()
            state = (cand.get("state") or "").lower()
            country = (cand.get("country") or "").lower()
            cc = (cand.get("country_code") or "").lower()

            # Exact match prioritization
            if name == q_lower or city == q_lower:
                s += 1200
            elif name.startswith(q_lower) or city.startswith(q_lower):
                s += 600
            elif any(tok == name or tok == city for tok in query_tokens):
                s += 450
            elif any(tok in name or tok in city for tok in query_tokens):
                s += 200
            else:
                s -= 400

            # Well-known / populated importance weight
            s += cand.get("importance", 0.3) * 500

            # Place type weighting
            ptype = str(cand.get("type") or "").lower()
            if ptype in ("city", "capital"):
                s += 160
            elif ptype in ("administrative", "town", "state"):
                s += 80
            elif ptype in ("landmark", "tourism", "historic", "attraction", "tower", "monument"):
                s += 190
            elif ptype in ("postcode", "postal_code"):
                s += 100

            # Multi-token queries (e.g. "Paris, Texas", "Dubai, UAE")
            if len(query_tokens) > 1:
                for tok in query_tokens:
                    if tok != name and tok != city:
                        if tok in country or tok == cc:
                            s += 350
                        elif tok in state:
                            s += 250

            # Explicit disambiguation boost for global major metropolises
            if name == "dubai" and (cc == "ae" or "emirates" in country):
                s += 400
                if cand.get("state") and "dubai" in cand["state"].lower():
                    s += 100

            return s

        all_candidates.sort(key=score, reverse=True)

        # Deduplication preserving highest-scoring provider coordinates
        seen_coords = set()
        seen_ident = set()
        deduped = []
        for cand in all_candidates:
            coord_key = (round(cand["latitude"], 5), round(cand["longitude"], 5))
            ident_key = (
                (cand.get("name") or "").lower(),
                (cand.get("state") or "").lower(),
                (cand.get("country_code") or "").lower(),
            )
            if coord_key in seen_coords or ident_key in seen_ident:
                continue
            seen_coords.add(coord_key)
            seen_ident.add(ident_key)
            deduped.append({
                "name": cand.get("name"),
                "city": cand.get("city"),
                "district": cand.get("district"),
                "state": cand.get("state"),
                "country": cand.get("country"),
                "country_code": cand.get("country_code"),
                "latitude": cand["latitude"],
                "longitude": cand["longitude"],
                "type": cand.get("type"),
            })

        results = deduped[:7]
        await self.cache.set(key, results)
        return results

    async def reverse(self, lat: float, lon: float) -> list[dict[str, Any]]:
        key = f"reverse:v4:{float(lat).hex()}:{float(lon).hex()}"
        cached = await self.cache.get(key)
        if cached is not None:
            return cached
        results: list[dict[str, Any]] = []
        try:
            response = await self._nominatim_get("reverse", {
                "lat": lat, "lon": lon, "format": "jsonv2", "zoom": 16,
                "addressdetails": 1, "accept-language": "en",
            })
            response.raise_for_status()
            data = response.json()
            address = data.get("address") or {}
            locality = next((address.get(key) for key in (
                "neighbourhood", "residential", "suburb", "town", "city", "village",
                "municipality", "hamlet", "quarter", "locality", "isolated_dwelling", "island",
            ) if address.get(key)), None)
            district = next((address.get(key) for key in (
                "district", "state_district", "county", "city_district",
            ) if address.get(key) and address.get(key) != locality), None)
            state = address.get("state") or address.get("region")
            country_code = (address.get("country_code") or "").upper()
            country = address.get("country") or COUNTRY_NAMES.get(country_code, country_code)
            if locality or district or state or country:
                results = [{
                    "name": locality or district or state or country,
                    "locality": locality,
                    "district": district if district != locality else None,
                    "state": state,
                    "country": country,
                    "country_code": country_code,
                    "latitude": lat,
                    "longitude": lon,
                    "source": "nominatim",
                }]
        except (httpx.HTTPError, ValueError, TypeError):
            logger.info("Nominatim reverse geocoding unavailable")
        await self.cache.set(key, results)
        return results


def wmo_condition(code: int | None) -> str:
    if code == 0: return "clear"
    if code in (1, 2): return "partly_cloudy"
    if code == 3: return "overcast"
    if code in (45, 48): return "fog"
    if code is not None and 51 <= code <= 57: return "drizzle"
    if code is not None and 61 <= code <= 67 or code is not None and 80 <= code <= 82: return "rain"
    if code is not None and 71 <= code <= 77 or code in (85, 86): return "snow"
    if code is not None and 95 <= code <= 99: return "thunderstorm"
    return "unknown"


def normalize_openweather_daily(items: list[dict[str, Any]], timezone_offset: int = 0) -> list[dict[str, Any]]:
    return [{"date": datetime.fromtimestamp(item["dt"] + timezone_offset, tz=timezone.utc).date().isoformat(),
             "temperature_max": item.get("temp", {}).get("max"),
             "temperature_min": item.get("temp", {}).get("min"),
             "weather_code": (item.get("weather") or [{}])[0].get("id"),
             "condition": condition_group((item.get("weather") or [{}])[0].get("id")),
             "precipitation_probability": round((item.get("pop") or 0) * 100)}
            for item in items[:7] if isinstance(item, dict) and item.get("dt") is not None]


def normalize_openmeteo(raw: dict[str, Any], lat: float, lon: float) -> dict[str, Any]:
    current = raw.get("current") or {}
    required = ("temperature_2m", "relative_humidity_2m", "apparent_temperature", "weather_code",
                "wind_speed_10m", "wind_direction_10m")
    if any(current.get(key) is None for key in required):
        raise ValueError("Open-Meteo current data is incomplete")
    hourly_data, daily_data = raw.get("hourly") or {}, raw.get("daily") or {}
    hourly_required = ("time", "temperature_2m", "relative_humidity_2m", "apparent_temperature",
                       "precipitation_probability", "precipitation", "weather_code", "visibility", "uv_index",
                       "wind_speed_10m", "wind_direction_10m")
    daily_required = ("time", "temperature_2m_max", "temperature_2m_min", "weather_code", "precipitation_probability_max")
    if any(key not in hourly_data for key in hourly_required) or any(key not in daily_data for key in daily_required):
        raise ValueError("Open-Meteo forecast data is incomplete")
    hourly = []
    now = time.time()
    timezone = raw.get("timezone")
    def local_timestamp(value: str) -> int:
        parsed = datetime.fromisoformat(value)
        if parsed.tzinfo is None and timezone:
            parsed = parsed.replace(tzinfo=ZoneInfo(timezone))
        return int(parsed.timestamp())

    for i, stamp in enumerate(hourly_data["time"]):
        try:
            timestamp = local_timestamp(stamp)
            if now <= timestamp < now + 24 * 3600:
                code = hourly_data["weather_code"][i]
                hourly.append({"time": stamp, "timestamp": timestamp,
                    "temperature": hourly_data["temperature_2m"][i], "feels_like": hourly_data["apparent_temperature"][i],
                    "humidity": hourly_data["relative_humidity_2m"][i], "precipitation_probability": hourly_data["precipitation_probability"][i],
                    "precipitation": hourly_data["precipitation"][i], "rain_3h": hourly_data["precipitation"][i],
                    "weather_code": code, "condition": wmo_condition(code), "visibility": hourly_data["visibility"][i],
                    "uv_index": hourly_data["uv_index"][i], "wind_speed": hourly_data["wind_speed_10m"][i],
                    "wind_direction": hourly_data["wind_direction_10m"][i]})
        except (ValueError, IndexError, TypeError):
            raise ValueError("Open-Meteo hourly data is invalid") from None
    if not hourly:
        raise ValueError("Open-Meteo hourly data is unavailable")
    daily = [{"date": daily_data["time"][i], "temperature_max": daily_data["temperature_2m_max"][i],
              "temperature_min": daily_data["temperature_2m_min"][i], "weather_code": daily_data["weather_code"][i],
              "condition": wmo_condition(daily_data["weather_code"][i]),
              "precipitation_probability": daily_data["precipitation_probability_max"][i]}
             for i in range(min(7, len(daily_data["time"]))) ]
    if len(daily) != 7 or any(day["temperature_max"] is None or day["temperature_min"] is None or day["weather_code"] is None for day in daily):
        raise ValueError("Open-Meteo daily data is incomplete")
    current_hour_index = min(range(len(hourly_data["time"])), key=lambda i: abs(local_timestamp(hourly_data["time"][i]) - now))
    observed_at = local_timestamp(current["time"]) if current.get("time") else int(now)
    return {"location_label": None, "location_name": None,
        "location_state": None, "location_country": None, "latitude": lat, "longitude": lon,
        "timezone": timezone, "timezone_offset": raw.get("utc_offset_seconds", 0),
        "observed_at": observed_at,
        "is_day": None, "uv_index": hourly_data["uv_index"][current_hour_index], "temperature": current["temperature_2m"],
        "apparent_temperature": current["apparent_temperature"], "temperature_min": daily[0]["temperature_min"], "temperature_max": daily[0]["temperature_max"],
        "humidity": current["relative_humidity_2m"], "pressure": None, "visibility": hourly_data["visibility"][current_hour_index],
        "wind_speed": current["wind_speed_10m"], "wind_direction": current["wind_direction_10m"],
        "wind_direction_cardinal": wind_cardinal(current["wind_direction_10m"]), "clouds": None,
        "condition_code": current["weather_code"], "condition": wmo_condition(current["weather_code"]),
        "description": wmo_condition(current["weather_code"]).replace("_", " "), "icon": None, "icon_url": None,
        "sunrise": None, "sunset": None, "precipitation": current.get("precipitation"),
        "rain_1h": current.get("rain"), "snow_1h": None, "hourly": hourly, "daily": daily, "air_quality": None}


def normalize_forecast(raw: dict[str, Any]) -> dict[str, Any]:
    points = []
    for item in raw.get("list", []):
        weather = (item.get("weather") or [{}])[0]
        rain = item.get("rain", {}).get("3h", 0) if isinstance(item.get("rain"), dict) else 0
        snow = item.get("snow", {}).get("3h", 0) if isinstance(item.get("snow"), dict) else 0
        icon = weather.get("icon")
        points.append({"time": item.get("dt_txt"), "timestamp": item.get("dt"), "temperature": item.get("main", {}).get("temp"),
                       "feels_like": item.get("main", {}).get("feels_like"), "humidity": item.get("main", {}).get("humidity"),
                       "weather_code": weather.get("id"), "condition": condition_group(weather.get("id")),
                       "description": weather.get("description"), "icon": icon,
                       "is_day": icon.endswith("d") if isinstance(icon, str) and icon.endswith(("d", "n")) else None,
                       "precipitation_probability": round((item.get("pop") or 0) * 100),
                       "rain_3h": rain, "snow_3h": snow, "wind_speed": (item.get("wind") or {}).get("speed", 0) * 3.6})
    return {"location": {"latitude": raw.get("city", {}).get("coord", {}).get("lat"),
                         "longitude": raw.get("city", {}).get("coord", {}).get("lon")},
            "timezone": raw.get("city", {}).get("timezone"), "hourly": points}


def normalize_current(
    raw: dict[str, Any],
    forecast: dict[str, Any],
    uv_response: dict[str, Any] | None = None,
    air: dict[str, Any] | None = None,
    geo_item: dict[str, Any] | None = None,
) -> dict[str, Any]:
    main, wind = raw.get("main", {}), raw.get("wind", {})
    weather = (raw.get("weather") or [{}])[0]
    sys = raw.get("sys", {})
    normalized_forecast = normalize_forecast(forecast)
    precise_name = (geo_item.get("name") if geo_item else None) or raw.get("name")
    country = (geo_item.get("country") if geo_item else None) or sys.get("country")
    state = geo_item.get("state") if geo_item else None
    return {"location_label": precise_name, "location_name": precise_name,
            "location_state": state, "location_country": country,
            "station_name": raw.get("name"),
            "latitude": raw.get("coord", {}).get("lat"), "longitude": raw.get("coord", {}).get("lon"),
            "timezone": None, "timezone_offset": raw.get("timezone", 0), "observed_at": raw.get("dt"),
            "is_day": (weather.get("icon") or "").endswith("d") if isinstance(weather.get("icon"), str) and weather.get("icon").endswith(("d", "n")) else None,
            "uv_index": uv_response.get("current", {}).get("uvi") if uv_response else None,
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
            "hourly": normalized_forecast["hourly"], "daily": normalize_openweather_daily((uv_response or {}).get("daily", []), (uv_response or {}).get("timezone_offset", 0)), "air_quality": air}


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
    modelled = air.get("modelled") if air else None
    modelled_aqi = modelled.get("aqi") if isinstance(modelled, Mapping) else None
    aqi = modelled_aqi.get("value") if isinstance(modelled_aqi, Mapping) else None
    # Keep the legacy shape readable for older integrations, but never treat
    # WAQI/OpenAQ station data as a modelled or EPA AQI value.
    if aqi is None:
        aqi = air.get("epa_aqi", {}).get("value") if air and isinstance(air.get("epa_aqi"), Mapping) else None
    provider_index = air.get("provider_index") if air and not modelled else None
    if isinstance(aqi, int) and aqi >= 101:
        add("air_quality", "High" if aqi < 201 else "Severe", "Reduce strenuous outdoor activity and consider a mask.")
    elif isinstance(provider_index, int) and provider_index >= settings.poor_aqi:
        add("air_quality", "High", "Reduce strenuous outdoor activity and consider a mask.")
    return {"recommendations": [risk["message"] for risk in risks], "risks": risks,
            "overall_severity": max((r["severity"] for r in risks), key=("Low", "Moderate", "High", "Severe").index, default="Low")}
