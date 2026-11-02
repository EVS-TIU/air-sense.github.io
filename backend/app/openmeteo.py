from __future__ import annotations

import asyncio
import logging
import random
from collections.abc import Iterable, Sequence

import httpx

from .config import Settings
from .services import WeatherServiceError

logger = logging.getLogger(__name__)


class OpenMeteoError(WeatherServiceError):
    """A safe, user-facing Open-Meteo error."""

    def __init__(self, message: str, status_code: int = 502, retry_after: int | None = None):
        super().__init__(message, status_code)
        self.retry_after = retry_after


class OpenMeteoClient:
    """Shared HTTP client and batching helper for the Open-Meteo APIs.

    The public API endpoints are configurable through ``Settings`` so the
    application can be pointed at a proxy or a self-hosted instance without
    code changes. No API key is required for Open-Meteo's free tier.
    """

    def __init__(self, settings: Settings, client: httpx.AsyncClient | None = None):
        self.settings = settings
        self.client = client
        self._owns_client = client is None

    async def startup(self) -> None:
        if self.client is None:
            self.client = httpx.AsyncClient(
                timeout=self.settings.http_timeout_seconds,
                headers={"Accept": "application/json", "User-Agent": "AirSense/1.0"},
            )

    async def shutdown(self) -> None:
        if self._owns_client and self.client is not None:
            await self.client.aclose()
        self.client = None

    async def _request(self, url: str, params: dict[str, object]) -> object:
        if self.client is None:
            await self.startup()
        assert self.client is not None

        for attempt in range(2):
            try:
                response = await self.client.get(url, params=params)
            except (httpx.TimeoutException, httpx.NetworkError) as exc:
                if attempt == 0:
                    await asyncio.sleep(0.2 + random.random() * 0.2)
                    continue
                logger.warning("Open-Meteo request failed: %s", type(exc).__name__)
                raise OpenMeteoError("Weather data provider is temporarily unavailable", 504) from None
            except httpx.HTTPError:
                logger.warning("Open-Meteo request failed")
                raise OpenMeteoError("Weather data provider is temporarily unavailable", 502) from None

            if response.status_code == 429:
                retry_after = response.headers.get("Retry-After")
                try:
                    retry_after_value = int(retry_after) if retry_after else None
                except ValueError:
                    retry_after_value = None
                raise OpenMeteoError("Weather data rate limit reached", 503, retry_after_value)
            if response.status_code >= 500:
                raise OpenMeteoError("Weather data provider is temporarily unavailable", 502)
            if response.status_code >= 400:
                raise OpenMeteoError("Weather data provider rejected the request", 502)
            try:
                return response.json()
            except ValueError:
                raise OpenMeteoError("Weather data provider returned an invalid response", 502) from None

        raise OpenMeteoError("Weather data provider is temporarily unavailable", 504)

    @staticmethod
    def _chunks(points: Sequence[tuple[float, float]], size: int) -> Iterable[Sequence[tuple[float, float]]]:
        for index in range(0, len(points), size):
            yield points[index:index + size]

    async def fetch_locations(
        self,
        url: str,
        points: Sequence[tuple[float, float]],
        params: dict[str, object],
    ) -> list[dict]:
        """Fetch one Open-Meteo response per point, preserving input order.

        Open-Meteo accepts comma-separated coordinate lists and returns an array
        of location objects in the same order. Requests are batched to keep URL
        lengths and free-tier request counts under control.
        """
        if not points:
            return []

        batches = list(self._chunks(points, self.settings.map_max_batch_points))
        tasks = [self._fetch_batch(url, batch, params) for batch in batches]
        results = await asyncio.gather(*tasks)

        locations: list[dict] = []
        for batch_result in results:
            locations.extend(batch_result)
        return locations

    async def _fetch_batch(
        self,
        url: str,
        points: Sequence[tuple[float, float]],
        params: dict[str, object],
    ) -> list[dict]:
        latitude = ",".join(f"{lat:.4f}" for lat, _ in points)
        longitude = ",".join(f"{lon:.4f}" for _, lon in points)
        payload = await self._request(
            url,
            {
                **params,
                "latitude": latitude,
                "longitude": longitude,
                "timezone": "UTC",
            },
        )

        if isinstance(payload, list):
            locations = payload
        elif isinstance(payload, dict):
            locations = [payload]
        else:
            raise OpenMeteoError("Weather data provider returned an invalid response", 502)

        if len(locations) != len(points):
            raise OpenMeteoError("Weather data provider returned an incomplete response", 502)
        return locations
