"""Unit tests for the climate prediction blend/guardrail logic (no network)."""

from datetime import date

import pytest

from app.climate_predict import (
    VariableStats,
    aqi_status,
    clamp,
    confidence_score,
    condition_text,
    fallback_insight,
    parse_agent_json,
    provider_weight,
    rainfall_intensity,
    summarize,
)


def test_summarize_computes_mean_std_and_bounds():
    stats = summarize([10.0, 12.0, 14.0])
    assert stats == VariableStats(mean=12.0, std=2.0, min=10.0, max=14.0, count=3)
    assert summarize([]) is None


def test_provider_weight_stays_in_bounds_and_shrinks_with_lead_time():
    soon = provider_weight(1, 3.0)
    far = provider_weight(15, 3.0)
    assert 0.5 <= soon <= 0.92
    assert far < soon


def test_confidence_stays_within_bounds():
    assert 25 <= confidence_score(0, None, []) <= 95
    assert 25 <= confidence_score(15, 8.0, [50.0] * 10) <= 95


def test_condition_and_rainfall_intensity():
    assert condition_text(20.0, 0.0, 10.0) == "Clear Sky"
    assert condition_text(50.0, 0.0, 10.0) == "Partly Cloudy"
    assert condition_text(80.0, 0.0, 10.0) == "Cloudy"
    assert condition_text(50.0, 2.0, 50.0) == "Rain Likely"
    # Wet climatology but low rain probability must not read "Rain Likely".
    assert condition_text(50.0, 1.2, 4.0) == "Partly Cloudy"
    assert condition_text(50.0, 10.0, 80.0) == "Rain"
    assert rainfall_intensity(None) == "None"
    assert rainfall_intensity(1.0) == "Light"
    assert rainfall_intensity(5.0) == "Moderate"
    assert rainfall_intensity(20.0) == "Heavy"


def test_aqi_status_bands():
    assert aqi_status(42) == "Good"
    assert aqi_status(142) == "Unhealthy"
    assert aqi_status(None) is None


def test_clamp():
    assert clamp(5.0, 0.0, 3.0) == 3.0
    assert clamp(-1.0, 0.0, 3.0) == 0.0


def test_parse_agent_json_accepts_plain_and_fenced_json():
    plain = parse_agent_json('{"insight": "ok", "anomalies": [], "adjustments": {"temperature": 1.5}}')
    assert plain is not None
    assert plain["adjustments"]["temperature"] == 1.5
    fenced = parse_agent_json('```json\n{"insight": "ok"}\n```')
    assert fenced is not None
    assert fenced["adjustments"] == {}


def test_parse_agent_json_clamps_out_of_bounds_adjustments():
    parsed = parse_agent_json('{"insight": "x", "adjustments": {"temperature": 50.0, "humidity": -99.0}}')
    assert parsed["adjustments"]["temperature"] == 3.0
    assert parsed["adjustments"]["humidity"] == -15.0


def test_parse_agent_json_rejects_garbage():
    assert parse_agent_json("") is None
    assert parse_agent_json("not json at all") is None
    assert parse_agent_json('{"adjustments": {}}') is None  # insight missing


def test_fallback_insight_mentions_climatology_and_confidence():
    stats = VariableStats(mean=25.0, std=2.0, min=22.0, max=28.0, count=15)
    prediction = {"temperature": 28.5}
    text = fallback_insight(prediction, {"temperature_2m_mean": stats}, days_ahead=2, confidence=80)
    assert "25.0" in text and "28.5" in text and "80%" in text
