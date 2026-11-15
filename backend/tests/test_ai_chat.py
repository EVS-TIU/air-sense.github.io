"""Unit tests for the interactive AI chat service (no network).

The Weather Chat is a pure LLM conversation grounded in live current
weather + air-quality data; no prediction model runs here.
"""

import asyncio
from types import SimpleNamespace

import httpx

from app.ai_chat import AiChatService
from app.config import Settings


def _service(weather=None, llm_key: str = "") -> AiChatService:
    return AiChatService(
        Settings(llm_api_key=llm_key, llm_base_url="https://example.test/v1"
                 if llm_key else "", llm_model="test-model" if llm_key else ""),
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
    )


def _async(value):
    async def call(*_args, **_kwargs):
        return value
    return call()


def test_fallback_first_turn_reports_live_data_plus_key_note():
    service = _service()  # no LLM key -> summary fallback
    result = asyncio.run(service.ask("hi", 22.57, 88.36, city="Kolkata"))
    assert result["usedLlm"] is False
    answer = result["answer"]
    assert "Kolkata" in answer
    assert "28.4" in answer            # current temperature
    assert "AQI 96.4" in answer        # air quality
    assert "LLM_API_KEY" in answer     # honest notice about the missing key


def test_fallback_later_turns_do_not_repeat_the_summary():
    service = _service()
    history = [{"role": "user", "content": "hi"},
               {"role": "assistant", "content": "summary was given"}]
    result = asyncio.run(service.ask("what can you suggest me?", 22.57, 88.36,
                                     city="Kolkata", history=history))
    assert result["usedLlm"] is False
    answer = result["answer"]
    assert "LLM_API_KEY" in answer
    # The canned conditions paragraph must not be replayed every turn.
    assert "28.4" not in answer


def test_intro_reports_overview_without_prediction():
    service = _service()
    result = asyncio.run(service.intro(22.57, 88.36, city="Kolkata"))
    assert result["usedLlm"] is False
    answer = result["answer"]
    assert "28.4" in answer
    assert "AQI 96.4" in answer
    # The prediction machinery stays out of the chat entirely.
    assert "Prediction for" not in answer
    assert "neural network" not in answer


def test_llm_key_enables_the_llm_path():
    service = _service(llm_key="test-key")
    assert service.llm_enabled is True
    service_no_key = _service()
    assert service_no_key.llm_enabled is False


def test_data_failures_degrade_gracefully():
    def broken(*_a, **_kw):
        async def call():
            raise RuntimeError("provider down")
        return call()

    weather = SimpleNamespace(current=broken, air_quality=broken)
    service = _service(weather=weather)
    result = asyncio.run(service.ask("hi", 22.57, 88.36))
    # No data at all: the answer still comes back and says so.
    assert result["answer"]


def test_llm_context_is_sanitised():
    service = _service(llm_key="test-key")
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

    async def fake_post(self, url, json=None, headers=None):
        messages.extend(json["messages"])
        return FakeResponse()

    original_post = httpx.AsyncClient.post
    httpx.AsyncClient.post = fake_post
    try:
        result = asyncio.run(service._llm_answer("How hot is it?", {}, history))
    finally:
        httpx.AsyncClient.post = original_post
    roles = [message["role"] for message in messages]
    # system prompt + valid history ("hi") + the final user question; the
    # invalid role and the empty assistant message are both dropped.
    assert roles == ["system", "user", "user"]
    assert result == "ok"
    assert "DATA:" in messages[-1]["content"]
