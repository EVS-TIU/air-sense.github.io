from __future__ import annotations

import math
from collections.abc import Sequence

from .openmeteo import OpenMeteoClient

AIR_QUALITY_VARIABLES = (
    "us_aqi",
    "pm2_5",
    "pm10",
    "nitrogen_dioxide",
    "ozone",
    "sulphur_dioxide",
    "carbon_monoxide",
)


class AirQualityService:
    """Open-Meteo Air Quality API integration."""

    def __init__(self, client: OpenMeteoClient):
        self.client = client

    async def fetch(
        self, points: Sequence[tuple[float, float]], domain: str = "auto"
    ) -> list[dict]:
        return await self.client.fetch_locations(
            self.client.settings.openmeteo_air_quality_url,
            points,
            {"current": ",".join(AIR_QUALITY_VARIABLES), "domains": domain},
        )

    async def fetch_stations(self, north: float, west: float, south: float, east: float) -> dict:
        """Fetch current WAQI station markers for one visible map bounds."""
        token = self.client.settings.waqi_api_token
        if not token:
            return {"status": "not_configured", "provider": "WAQI", "stations": []}
        response = await self.client._request(
            "https://api.waqi.info/v2/map/bounds/",
            {"latlng": f"{north},{west},{south},{east}", "token": token},
        )
        if not isinstance(response, dict) or response.get("status") != "ok":
            return {"status": "unavailable", "provider": "WAQI", "stations": []}

        stations = []
        for item in response.get("data", []):
            if not isinstance(item, dict):
                continue
            try:
                latitude = float(item.get("lat"))
                longitude = float(item.get("lon"))
                aqi = float(item.get("aqi"))
            except (TypeError, ValueError):
                continue
            if not all(map(math.isfinite, (latitude, longitude, aqi))) or aqi < 0:
                continue
            station = item.get("station") if isinstance(item.get("station"), dict) else {}
            try:
                station_id = int(item.get("uid"))
            except (TypeError, ValueError):
                continue
            stations.append({
                "id": station_id,
                "latitude": latitude,
                "longitude": longitude,
                "aqi": aqi,
                "name": str(station.get("name") or "Air quality monitor")[:160],
                "url": str(station.get("url") or "")[:500],
            })
        return {"status": "available", "provider": "WAQI", "stations": stations}

    async def fetch_station(self, station_id: int) -> dict:
        """Fetch uncached live pollutant details for one WAQI monitor."""
        token = self.client.settings.waqi_api_token
        if not token:
            return {"status": "not_configured", "provider": "WAQI"}
        response = await self.client._request(
            f"https://api.waqi.info/feed/@{station_id}/", {"token": token}
        )
        if not isinstance(response, dict) or response.get("status") != "ok":
            return {"status": "unavailable", "provider": "WAQI"}
        data = response.get("data")
        if not isinstance(data, dict):
            return {"status": "unavailable", "provider": "WAQI"}
        city = data.get("city") if isinstance(data.get("city"), dict) else {}
        iaqi = data.get("iaqi") if isinstance(data.get("iaqi"), dict) else {}

        def pollutant(name: str) -> float | None:
            raw = iaqi.get(name)
            raw = raw.get("v") if isinstance(raw, dict) else None
            try:
                value = float(raw)
            except (TypeError, ValueError):
                return None
            return value if math.isfinite(value) and value >= 0 else None

        try:
            aqi = float(data.get("aqi"))
        except (TypeError, ValueError):
            aqi = None
        timestamp = data.get("time", {}).get("s") if isinstance(data.get("time"), dict) else None
        return {
            "status": "available",
            "provider": "WAQI",
            "name": str(city.get("name") or "Air quality monitor")[:160],
            "aqi": aqi if aqi is not None and math.isfinite(aqi) else None,
            "timestamp": str(timestamp)[:64] if timestamp else None,
            "pm2_5": pollutant("pm25"),
            "pm10": pollutant("pm10"),
            "unit": "µg/m³",
            "url": str(city.get("url") or "")[:500],
        }
