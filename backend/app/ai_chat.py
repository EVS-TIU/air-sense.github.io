"""Interactive AI assistant: conversational chat over the site's live data.

The Weather Chat page posts here. The service gathers the same live data
the dashboard shows (current weather, modelled air quality) and hands it
to the hosted LLM, which composes every reply — greeting, suggestions
and answers about the day. No prediction model runs here; the Climate
Analysis page owns the trained-ML predictions. Without an LLM key the
service degrades to a short factual summary plus a notice that real
conversational replies need the key configured on the server — it never
pretends to be a chatbot it cannot be.
"""

from __future__ import annotations

import asyncio
import json
import logging
from typing import Any

import httpx

from .climate_predict import aqi_status
from .config import Settings
from .services import WeatherClient

logger = logging.getLogger(__name__)

CURRENT_KEYS = ("temperature", "apparent_temperature", "humidity", "wind_speed",
                "wind_direction_cardinal", "condition", "pressure", "visibility",
                "uv_index", "precipitation", "location_label")

AQI_ADVICE = {
    "Good": "Air quality is safe for all outdoor activity.",
    "Moderate": "Unusually sensitive people should limit prolonged outdoor exertion.",
    "Unhealthy for Sensitive Groups": "Children, older adults and people with heart or lung conditions should reduce outdoor exertion.",
    "Unhealthy": "Everyone should reduce prolonged outdoor exertion.",
    "Very Unhealthy": "Avoid outdoor exertion; keep windows closed if possible.",
    "Hazardous": "Stay indoors and avoid all outdoor activity.",
}

SYSTEM_PROMPT = (
    "You are AirSense, a friendly weather and air-quality chat assistant "
    "inside a weather dashboard. Answer the user using ONLY the JSON DATA "
    "provided with their message (live site data for their selected "
    "location, for today). Quote concrete numbers with units when the "
    "data contains them, never invent values, and if the data does not "
    "cover the question say so briefly. Chat naturally — greet, suggest "
    "what to do for the rest of the day (outdoor plans, clothing, "
    "health precautions) and answer follow-up questions in context. Stay "
    "strictly on topic: weather, air quality and this app's own features. "
    "If the user asks about anything else — news, coding, games, personal "
    "or medical advice unrelated to weather — politely decline in one "
    "short sentence and say you can only help with weather and "
    "air-quality questions. Reply in at most 120 words of plain text."
)

INTRO_PROMPT = (
    "Open the conversation: greet the user and give a short overview of "
    "today's conditions at their selected location, using ONLY the DATA. "
    "Cover the current temperature and sky, one notable factor (wind, "
    "humidity or rain), the US AQI value with its health meaning, and one "
    "practical tip for the next hours. End by inviting questions about "
    "weather or air quality. At most 90 words of plain text."
)

KEY_NOTE = ("Full conversational replies need the LLM key (LLM_API_KEY, "
            "LLM_BASE_URL, LLM_MODEL) configured on this server.")


def _pick(data: dict[str, Any], keys: tuple[str, ...]) -> dict[str, Any]:
    return {key: data[key] for key in keys if data.get(key) is not None}


class AiChatService:
    """One conversational endpoint grounded in the dashboard's live data."""

    def __init__(self, settings: Settings, weather: WeatherClient):
        self.settings = settings
        self.weather = weather

    @property
    def llm_enabled(self) -> bool:
        return bool(self.settings.llm_api_key and self.settings.llm_base_url
                    and self.settings.llm_model)

    # ------------------------------------------------------------- context

    async def _context(self, lat: float, lon: float,
                       city: str | None, country: str | None) -> dict[str, Any]:
        """Live data snapshot: current weather + modelled air quality."""
        async def safe(call):
            try:
                return await call
            except Exception as exc:  # chat must answer even with partial data
                logger.warning("Chat context fetch failed: %s", exc)
                return None

        current, air_quality = await asyncio.gather(
            safe(self.weather.current(lat, lon)),
            safe(self.weather.air_quality(lat, lon)),
        )

        context: dict[str, Any] = {
            "location": {"city": city or f"{lat:.2f}, {lon:.2f}",
                         "country": country or "",
                         "latitude": round(lat, 3), "longitude": round(lon, 3)},
        }
        if isinstance(current, dict):
            context["currentWeather"] = _pick(current, CURRENT_KEYS)
        if isinstance(air_quality, dict):
            modelled = air_quality.get("modelled") or {}
            aqi = (modelled.get("aqi") or {}).get("value") if isinstance(modelled, dict) else None
            if aqi is not None:
                context["airQuality"] = {"usAqi": round(float(aqi), 1),
                                         "status": aqi_status(aqi)}
        return context

    # ----------------------------------------------------------------- ask

    async def ask(self, question: str, lat: float, lon: float,
                  city: str | None = None, country: str | None = None,
                  history: list[dict] | None = None) -> dict:
        context = await self._context(lat, lon, city, country)
        answer = None
        if self.llm_enabled:
            answer = await self._llm_answer(question, context, history or [])
        used_llm = answer is not None
        if not used_llm:
            answer = self._fallback_answer(context, first=not history)
        return {
            "answer": answer,
            "usedLlm": used_llm,
            "contextKeys": sorted(context.keys() - {"location"}),
        }

    # --------------------------------------------------------------- intro

    async def intro(self, lat: float, lon: float,
                    city: str | None = None, country: str | None = None) -> dict:
        """Automatic opening message: today's overview for the location.

        The Weather Chat page fires this on load so the chat always starts
        with a grounded, data-backed greeting instead of an empty panel.
        Composed by the hosted LLM when configured; otherwise the
        deterministic overview is returned.
        """
        context = await self._context(lat, lon, city, country)
        answer = None
        if self.llm_enabled:
            answer = await self._llm_answer(INTRO_PROMPT, context, [])
        used_llm = answer is not None
        if not used_llm:
            answer = self._fallback_answer(context, first=True)
        return {"answer": answer, "usedLlm": used_llm}

    # ----------------------------------------------------------------- llm

    async def _llm_answer(self, question: str, context: dict,
                          history: list[dict]) -> str | None:
        messages: list[dict] = [{"role": "system", "content": SYSTEM_PROMPT}]
        for item in history:
            role = item.get("role")
            content = item.get("content")
            if role in ("user", "assistant") and isinstance(content, str) and content.strip():
                messages.append({"role": role, "content": content[:1000]})
        messages.append({
            "role": "user",
            "content": f"{question}\n\nDATA:\n{json.dumps(context, ensure_ascii=False)}",
        })
        body = {"model": self.settings.llm_model, "messages": messages,
                "temperature": 0.4, "max_tokens": 300}
        headers = {"Authorization": f"Bearer {self.settings.llm_api_key}"}
        try:
            async with httpx.AsyncClient(timeout=20.0) as client:
                response = await client.post(self.settings.llm_base_url,
                                             json=body, headers=headers)
                response.raise_for_status()
                choices = response.json().get("choices") or []
                text = (choices[0].get("message") or {}).get("content") if choices else None
                return text.strip() if isinstance(text, str) and text.strip() else None
        except (httpx.HTTPError, ValueError, KeyError, IndexError) as exc:
            logger.warning("LLM chat unavailable; using summary fallback: %s", exc)
            return None

    # ------------------------------------------------------------ fallback

    def _fallback_answer(self, context: dict, first: bool) -> str:
        """No LLM key: report the live numbers once, then stop pretending.

        The old behaviour replayed the same canned text for every message;
        now the first turn gives the factual summary plus a notice about
        the missing key, and later turns just point at the notice instead
        of repeating the same paragraph.
        """
        lines: list[str] = []
        city = (context.get("location") or {}).get("city", "this location")
        current = context.get("currentWeather") or {}
        if current:
            lines.append(
                f"Current conditions in {city}"
                + (f" ({current['location_label']})" if current.get("location_label") else "")
                + f": {current.get('temperature')}°C"
                + (f" (feels like {current['apparent_temperature']}°C)"
                   if current.get("apparent_temperature") is not None else "")
                + f", humidity {current.get('humidity')}%, wind {current.get('wind_speed')} km/h"
                + (f" {current['wind_direction_cardinal']}" if current.get("wind_direction_cardinal") else "")
                + (f", {current.get('condition')}" if current.get("condition") else "")
                + ".")
        air = context.get("airQuality") or {}
        if air.get("usAqi") is not None:
            line = f"Air quality: US AQI {air['usAqi']} ({air.get('status')})."
            advice = AQI_ADVICE.get(air.get("status"))
            if advice:
                line += f" {advice}"
            lines.append(line)
        if not lines:
            lines.append("Live weather data is unavailable right now.")
        if first:
            lines.append(KEY_NOTE)
            return " ".join(lines)
        return KEY_NOTE
