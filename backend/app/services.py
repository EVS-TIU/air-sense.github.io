from __future__ import annotations

import asyncio
import logging
import time
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
        current, forecast, uv_response, air_response, geo_response = await asyncio.gather(
            self._get("/data/2.5/weather", {"lat": lat, "lon": lon, "units": "metric"}),
            self._get("/data/2.5/forecast", {"lat": lat, "lon": lon, "units": "metric"}),
            self._get(
                "/data/3.0/onecall",
                {"lat": lat, "lon": lon, "exclude": "minutely,hourly,daily,alerts", "units": "metric"},
            ),
            self._get("/data/2.5/air_pollution", {"lat": lat, "lon": lon}),
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
        air = None if isinstance(air_response, Exception) else normalize_air_quality(air_response, lat, lon)
        geo_item = (
            geo_response[0]
            if isinstance(geo_response, list) and len(geo_response) > 0 and isinstance(geo_response[0], dict)
            else None
        )
        result = normalize_current(current, forecast, uv_response, air, geo_item)
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
                resp = await self.client.get(
                    "https://nominatim.openstreetmap.org/search",
                    params={"q": clean_q, "format": "jsonv2", "addressdetails": 1, "limit": 10, "accept-language": "en"},
                    headers={"User-Agent": "AirSenseWeatherApp/1.0"},
                )
                if resp.status_code == 200:
                    candidates = []
                    for item in resp.json():
                        addr = item.get("address") or {}
                        name = (
                            item.get("name")
                            or addr.get("city")
                            or addr.get("town")
                            or addr.get("village")
                            or addr.get("suburb")
                            or addr.get("state_district")
                            or addr.get("state")
                        )
                        city = addr.get("city") or addr.get("town") or addr.get("village") or addr.get("municipality")
                        district = addr.get("suburb") or addr.get("neighbourhood") or addr.get("state_district") or addr.get("county")
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
            coord_key = (round(cand["latitude"], 2), round(cand["longitude"], 2))
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
        key = f"reverse:v2:{lat:.3f}:{lon:.3f}"
        cached = await self.cache.get(key)
        if cached is not None:
            return cached

        if self.client is None:
            await self.startup()
        assert self.client is not None

        async def fetch_nominatim_reverse() -> list[dict[str, Any]]:
            try:
                resp = await self.client.get(
                    "https://nominatim.openstreetmap.org/reverse",
                    params={"lat": lat, "lon": lon, "format": "jsonv2", "addressdetails": 1, "accept-language": "en"},
                    headers={"User-Agent": "AirSenseWeatherApp/1.0"},
                )
                if resp.status_code == 200:
                    data = resp.json()
                    addr = data.get("address") or {}
                    name = (
                        addr.get("city")
                        or addr.get("town")
                        or addr.get("village")
                        or addr.get("municipality")
                        or data.get("name")
                        or addr.get("suburb")
                        or addr.get("county")
                        or addr.get("state")
                    )
                    district = addr.get("suburb") or addr.get("neighbourhood") or addr.get("county")
                    state = addr.get("state") or addr.get("region")
                    country = addr.get("country")
                    cc = (addr.get("country_code") or "").upper()
                    if cc and not country:
                        country = COUNTRY_NAMES.get(cc, cc)
                    if name:
                        return [{
                            "name": name,
                            "district": district if district != name else None,
                            "state": state if state != name else None,
                            "country": country or (COUNTRY_NAMES.get(cc, cc) if cc else ""),
                            "country_code": cc,
                            "latitude": lat,
                            "longitude": lon,
                        }]
            except Exception:
                pass
            return []

        async def fetch_openweather_reverse() -> list[dict[str, Any]]:
            try:
                raw = await self._get("/geo/1.0/reverse", {"lat": lat, "lon": lon, "limit": 5})
                if isinstance(raw, list):
                    results = []
                    for item in raw:
                        cc = (item.get("country") or "").upper()
                        country = COUNTRY_NAMES.get(cc, cc)
                        results.append({
                            "name": item.get("name"),
                            "district": None,
                            "state": item.get("state"),
                            "country": country,
                            "country_code": cc,
                            "latitude": item.get("lat", lat),
                            "longitude": item.get("lon", lon),
                        })
                    return results
            except Exception:
                pass
            return []

        nom_res, ow_res = await asyncio.gather(
            fetch_nominatim_reverse(),
            fetch_openweather_reverse(),
            return_exceptions=True,
        )

        results: list[dict[str, Any]] = []
        if isinstance(nom_res, list) and nom_res:
            results.extend(nom_res)
        if isinstance(ow_res, list) and ow_res:
            for item in ow_res:
                if not any(r["name"].lower() == item["name"].lower() for r in results if r.get("name")):
                    results.append(item)

        if not results:
            lat_dir = "N" if lat >= 0 else "S"
            lon_dir = "E" if lon >= 0 else "W"
            results = [{
                "name": f"{abs(lat):.2f}° {lat_dir}, {abs(lon):.2f}° {lon_dir}",
                "district": None,
                "state": None,
                "country": "Selected Location",
                "country_code": "",
                "latitude": lat,
                "longitude": lon,
            }]

        await self.cache.set(key, results)
        return results


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