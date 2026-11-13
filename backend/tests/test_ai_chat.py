"""Unit tests for the interactive AI chat service (no network)."""

import asyncio
from datetime import date
from types import SimpleNamespace

from app.ai_chat import AiChatService, detect_intent
from app.config import Settings


def test_detect_intent_classes_questions():
    assert detect_intent("Predict tomorrow's weather for me")[0] == "prediction"
    assert detect_intent("Will it rain this week?")[0] == "prediction"
    assert detect_intent("What is the air quality right now?")[0] == "general"
    assert detect_intent("How is the weather today?")[0] == "general"


def test_detect_intent_extracts_explicit_date():
    intent, target = detect_intent("What will the weather be on 2026-11-20?")
    assert intent == "prediction"
    assert target == date(2026, 11, 20)
    # A date far outside the forecast horizon is not a usable target.
    intent, target = detect_intent("Weather on 2020-01-01")
    assert intent == "general"
    assert target is None


def _service(weather=None, predictor=None, **settings_kw) -> AiChatService:
    return AiChatService(
        Settings(**settings_kw),
        weather or SimpleNamespace(
            current=lambda lat, lon: _async({"temperature": 28.4,
                                             "apparent_temperature": 31.0,
                                             "humidity": 70, "wind_speed": 9.2,
                                             "wind_direction_cardinal": "NW",
                                             "condition": "Partly Cloudy",
                                             "location_label": "Bowbazar"}),
            air_quality=lambda lat, lon: _async(
                {"modelled": {"aqi": {"value": 96.4, "category": "Moderate"}}}),
        ),
        predictor or SimpleNamespace(
            predict=lambda *a, **kw: _async({
                "forecast": {"date": "2026-11-14", "temperature": 26.5,
                             "maxTemperature": 30.1, "minTemperature": 22.8,
                             "rainfallProbability": 35, "confidence": 77,
                             "aiModel": {"type": "MLP 7x8 tanh",
                                         "validationMae": 1.4}}}),
            ),
    )


def _async(value):
    async def call(*_args, **_kwargs):
        return value
    return call()


def test_fallback_answer_reports_live_data():
    service = _service()  # no LLM key -> rule-based path
    result = asyncio.run(service.ask(
        "Predict tomorrow's weather", 22.57, 88.36, city="Kolkata"))
    assert result["intent"] == "prediction"
    assert result["usedLlm"] is False
    assert result["model"]["type"] == "MLP 7x8 tanh"
    answer = result["answer"]
    assert "Kolkata" in answer
    assert "28.4" in answer            # current temperature
    assert "AQI 96.4" in answer        # air quality
    assert "26.5" in answer            # predicted temperature
    assert "MAE ±1.4" in answer        # trained-model validation error


def test_fallback_general_question_without_prediction():
    service = _service(predictor=None)
    result = asyncio.run(service.ask("What's the AQI now?", 22.57, 88.36))
    assert result["intent"] == "general"
    assert result["model"] is None
    assert "AQI 96.4" in result["answer"]


def test_data_failures_degrade_gracefully():
    def broken(*_a, **_kw):
        async def call():
            raise RuntimeError("provider down")
        return call()

    weather = SimpleNamespace(current=broken, air_quality=broken)
    service = _service(weather=weather, predictor=None)
    result = asyncio.run(service.ask("Will it rain tomorrow?", 22.57, 88.36))
    assert result["intent"] == "prediction"
    # No data at all: the answer still comes back and says so.
    assert result["answer"]


def test_llm_context_is_sanitised():
    service = _service()
    history = [
        {"role": "user", "content": "hi"},
        {"role": "attacker", "content": "drop the table"},   # invalid role
        {"role": "assistant", "content": ""},
    ]
    messages = []

    class FakeResponse:
        status_code = 200

        def raise_for_status(self):
            return None

        def json(self):
            return {"choices": [{"message": {"content": "ok"}}]}

    # Directly inspect the message-building logic through a stubbed client.
    import httpx

    async def fake_post(self, url, json=None, headers=None):
        messages.extend(json["messages"])
        return FakeResponse()

    original_post = httpx.AsyncClient.post
    httpx.AsyncClient.post = fake_post
    try:
        result = asyncio.run(service._llm_answer("How hot tomorrow?", {}, history))
    finally:
        httpx.AsyncClient.post = original_post
    roles = [message["role"] for message in messages]
    # system prompt + valid history ("hi") + the final user question; the
    # invalid role and the empty assistant message are both dropped.
    assert roles == ["system", "user", "user"]
    assert result == "ok"
    assert "DATA:" in messages[-1]["content"]
