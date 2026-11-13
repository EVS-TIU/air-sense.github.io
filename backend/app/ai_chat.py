"""Interactive AI assistant: chat over the site's live weather data.

The AI Recommendation page's chat box posts here. The service gathers the
same data the dashboard shows (current weather, modelled air quality) and,
when the question asks for a forecast, runs the climate prediction whose
temperature term includes the trained MLP (ml_model.py). A hosted LLM
composes the answer from that data when an LLM key is configured; without
one, a deterministic rule-based answer reports the same numbers, so the
feature never depends on a third-party key.
"""

from __future__ import annotations

import asyncio
import json
import logging
import re
from datetime import date as date_type, timedelta
from typing import Any

import httpx

from .climate_predict import ClimatePredictError, ClimatePredictService, aqi_status
from .config import Settings
from .services import WeatherClient, WeatherServiceError

logger = logging.getLogger(__name__)

PREDICTION_HINT = re.compile(
    r"\b(predict|prediction|forecast|tomorrow|day after tomorrow|"
    r"next (?:week|days?|month)|coming (?:week|days)|"
    r"will it (?:rain|snow|be))\b",
    re.IGNORECASE,
)
ISO_DATE = re.compile(r"\b(\d{4}-\d{2}-\d{2})\b")
MAX_PREDICT_DAYS_AHEAD = 15

CURRENT_KEYS = ("temperature", "apparent_temperature", "humidity", "wind_speed",
                "wind_direction_cardinal", "condition", "pressure", "visibility",
                "uv_index", "precipitation", "location_label")
PREDICTION_KEYS = ("date", "temperature", "feelsLike", "humidity", "windSpeed",
                   "rainfallProbability", "condition", "confidence",
                   "maxTemperature", "minTemperature", "aiInsight", "aiModel")

AQI_ADVICE = {
    "Good": "Air quality is safe for all outdoor activity.",
    "Moderate": "Unusually sensitive people should limit prolonged outdoor exertion.",
    "Unhealthy for Sensitive Groups": "Children, older adults and people with heart or lung conditions should reduce outdoor exertion.",
    "Unhealthy": "Everyone should reduce prolonged outdoor exertion.",
    "Very Unhealthy": "Avoid outdoor exertion; keep windows closed if possible.",
    "Hazardous": "Stay indoors and avoid all outdoor activity.",
}

SYSTEM_PROMPT = (
    "You are AirSense, a weather and air-quality assistant inside a weather "
    "dashboard. Answer the user's question using ONLY the JSON DATA provided "
    "with the question (live site data for their selected location). Quote "
    "concrete numbers with units when the data contains them, never invent "
    "values, and if the data does not cover the question say so briefly. "
    "Reply in at most 120 words of plain text."
)


def detect_intent(question: str) -> tuple[str, date_type | None]:
    """Classify the question and extract an explicit target date if given."""
    today = date_type.today()
    target: date_type | None = None
    match = ISO_DATE.search(question)
    if match:
        try:
            candidate = date_type.fromisoformat(match.group(1))
        except ValueError:
            candidate = None
        if candidate is not None and 0 <= (candidate - today).days <= MAX_PREDICT_DAYS_AHEAD:
            target = candidate
    intent = "prediction" if (target or PREDICTION_HINT.search(question)) else "general"
    return intent, target


def _pick(data: dict[str, Any], keys: tuple[str, ...]) -> dict[str, Any]:
    return {key: data[key] for key in keys if data.get(key) is not None}


class AiChatService:
    """One conversational endpoint grounded in the dashboard's live data."""

    def __init__(self, settings: Settings, weather: WeatherClient,
                 predictor: ClimatePredictService):
        self.settings = settings
        self.weather = weather
        self.predictor = predictor

    @property
    def llm_enabled(self) -> bool:
        return bool(self.settings.llm_api_key and self.settings.llm_base_url
                    and self.settings.llm_model)

    async def ask(self, question: str, lat: float, lon: float,
                  city: str | None = None, country: str | None = None,
                  history: list[dict] | None = None) -> dict:
        today = date_type.today()
        intent, target = detect_intent(question)
        location = city or f"{lat:.2f}, {lon:.2f}"

        prediction = None
        if intent == "prediction":
            target = target or today + timedelta(days=1)
            try:
                prediction = await self.predictor.predict(
                    lat, lon, target, city=city, country=country)
            except (ClimatePredictError, WeatherServiceError, httpx.HTTPError,
                    ValueError, KeyError) as exc:
                logger.warning("Chat prediction unavailable: %s", exc)

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
            "location": {"city": location, "country": country or "",
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
        if prediction is not None:
            forecast = prediction.get("forecast") or {}
            context["prediction"] = _pick(forecast, PREDICTION_KEYS)

        answer = None
        if self.llm_enabled:
            answer = await self._llm_answer(question, context, history or [])
        used_llm = answer is not None
        if not used_llm:
            answer = self._fallback_answer(context, intent)
        return {
            "answer": answer,
            "intent": intent,
            "usedLlm": used_llm,
            "model": (context.get("prediction") or {}).get("aiModel"),
            "contextKeys": sorted(context.keys() - {"location"}),
        }

    # ------------------------------------------------------------------- llm

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
                "temperature": 0.3, "max_tokens": 300}
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
            logger.warning("LLM chat unavailable; using rule-based answer: %s", exc)
            return None

    # -------------------------------------------------------------- fallback

    def _fallback_answer(self, context: dict, intent: str) -> str:
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
        prediction = context.get("prediction")
        if prediction:
            line = (f"Prediction for {prediction.get('date')}: "
                    f"{prediction.get('temperature')}°C "
                    f"(high {prediction.get('maxTemperature')}°C, "
                    f"low {prediction.get('minTemperature')}°C), rain chance "
                    f"{prediction.get('rainfallProbability')}%, confidence "
                    f"{prediction.get('confidence')}%.")
            model = prediction.get("aiModel")
            if model:
                line += (f" A neural network trained on a {model.get('trainedOn')} "
                         f"contributed (validation MAE ±{model.get('validationMae')}°C).")
            insight = prediction.get("aiInsight")
            if insight:
                line += f" {insight}"
            lines.append(line)
        elif intent == "prediction":
            lines.append("I could not compute a prediction right now — the data "
                         "provider may be busy. Please try again in a moment.")
        else:
            lines.append("Ask me for a prediction (for example: \"predict "
                         "tomorrow's weather here\") and I will run the trained "
                         "model on the last ten years of data.")
        return " ".join(lines)
