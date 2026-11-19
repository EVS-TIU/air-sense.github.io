"""Unit tests for the climate prediction blend/guardrail logic (no network)."""

import asyncio
from datetime import date, timedelta

import pytest

from app.climate_predict import (
    ClimatePredictService,
    VariableStats,
    aqi_status,
    climatology_rows,
    clamp,
    confidence_score,
    condition_text,
    fallback_insight,
    parse_agent_json,
    provider_weight,
    rainfall_intensity,
    summarize,
    year_window,
)
from app.config import Settings


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


def test_year_window_crosses_new_year_instead_of_building_an_inverted_range():
    # The old implementation produced 2025-12-29 .. 2025-01-02 (start > end)
    # for this date and Open-Meteo answered 400 for all five years.
    start, end = year_window(2025, date(2026, 12, 31))
    assert (start.isoformat(), end.isoformat()) == ("2025-12-29", "2026-01-02")
    start, end = year_window(2026, date(2027, 1, 1))
    assert (start.isoformat(), end.isoformat()) == ("2025-12-30", "2026-01-03")


def test_climatology_rows_include_days_on_both_sides_of_new_year():
    rows = [
        {"date": "2025-12-30"},
        {"date": "2026-01-01"},   # belongs to the 2025 winter window
        {"date": "2026-01-05"},   # too far from 31 Dec
        {"date": "2026-12-31"},   # current year is excluded
    ]
    picked = climatology_rows(rows, date(2026, 12, 31), 2026)
    assert {row["date"] for row in picked} == {"2025-12-30", "2026-01-01"}


def _sample_days(start: date, end: date, values: dict[str, float]) -> dict:
    times, stamps = [], []
    current = start
    while current <= end:
        times.append(current.isoformat())
        stamps.append(current.isoformat() + "T12:00")
        current += timedelta(days=1)
    daily = {"time": times}
    daily.update({key: [value] * len(times) for key, value in values.items()})
    return {"daily": daily, "hourly": {
        "time": stamps,
        "temperature_2m": [24.0] * len(stamps),
        "relative_humidity_2m": [70.0] * len(stamps),
        "precipitation": [0.0] * len(stamps),
        "us_aqi": [100.0] * len(stamps),
        "pm2_5": [12.0] * len(stamps),
        "pm10": [20.0] * len(stamps),
        "nitrogen_dioxide": [10.0] * len(stamps),
    }}


def test_new_year_prediction_uses_one_archive_fetch_and_reuses_it():
    """A 31 Dec target must not issue ten inverted archive requests."""
    settings = Settings(chronos_enabled=False)
    service = ClimatePredictService(settings)
    today = date.today()
    target = date(today.year, 12, 31)
    calls: list[tuple[str, str | None, str | None]] = []

    values = {
        "temperature_2m_mean": 24.0, "apparent_temperature_mean": 27.0,
        "temperature_2m_max": 29.0, "temperature_2m_min": 19.0,
        "relative_humidity_2m_mean": 70.0, "precipitation_sum": 0.0,
        "wind_speed_10m_max": 10.0, "cloud_cover_mean": 30.0,
        "wind_direction_10m_dominant": 90.0,
    }

    async def fake_open_meteo(url, params, attempts=3):
        calls.append((url, params.get("start_date"), params.get("end_date")))
        if url == settings.openmeteo_archive_url:
            assert date.fromisoformat(params["start_date"]) < date.fromisoformat(params["end_date"])
            return _sample_days(date(target.year - 10, 1, 1), today, values)
        if url == settings.openmeteo_forecast_url:
            return _sample_days(params["start_date"], params["end_date"], values)
        return {"current": {"us_aqi": 100.0}, **_sample_days(
            target, target, {"temperature_2m_mean": 24.0})}

    service._open_meteo = fake_open_meteo

    async def exercise():
        first = await service.predict(22.70, 88.40, target, "Sukant Nagar", "India")
        archive_calls = [call for call in calls if call[0] == settings.openmeteo_archive_url]
        assert len(archive_calls) == 1
        assert isinstance(first["forecast"]["temperature"], (int, float))
        next_target = date(today.year + 1, 1, 2)
        await service.predict(22.70, 88.40, next_target, "Sukant Nagar", "India")
        archive_calls = [call for call in calls if call[0] == settings.openmeteo_archive_url]
        assert len(archive_calls) == 1  # archive rows reused from the one-slot cache

    asyncio.run(exercise())
