"""External provider integrations (weather + air quality).

Replace the placeholder bodies with real API calls, e.g. OpenWeatherMap for
weather and OpenAQ for air quality. Keep provider-specific code here so routes
stay thin.
"""


async def fetch_weather(city: str) -> dict:
    """Return current weather for ``city``."""
    raise NotImplementedError(
        f"Weather provider is not configured yet (requested city: {city})."
    )


async def fetch_air_quality(city: str) -> dict:
    """Return current air quality for ``city``."""
    raise NotImplementedError(
        f"Air-quality provider is not configured yet (requested city: {city})."
    )
