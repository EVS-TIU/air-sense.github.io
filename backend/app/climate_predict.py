"""Climate prediction: provider forecast compared against multi-year climatology.

A "small AI agent" design that needs no training pipeline:

1. Pull the last HISTORY_YEARS of archive (reanalysis) data from Open-Meteo for
   the same calendar window as the target date. That is real past data.
2. Pull the provider's numerical forecast for the target date.
3. Blend both deterministically (weight shrinks with lead time and with how
   noisy the historical record is) and derive a confidence from the observed
   year-to-year spread.
4. Optionally let the hosted LLM (llm settings) act as the comparing agent: it
   may only nudge the blended numbers within strict bounds and must explain the
   comparison in aiInsight. Anything it returns is re-validated and clamped, so
   the LLM can never invent values.
"""

from __future__ import annotations

import asyncio
import json
import logging
import math
from dataclasses import dataclass
from datetime import date as date_type, timedelta

import httpx

from . import ml_model
from .config import Settings
from .services import TTLCache, wind_cardinal

logger = logging.getLogger(__name__)

HISTORY_YEARS = 5
HISTORY_WINDOW_DAYS = 2  # days on either side of the target date, per year
MAX_FORECAST_DAYS_AHEAD = 15  # Open-Meteo forecast horizon is ~16 days

# The trained regression model (ml_model.py) learns temperature from ten
# years of archive data around the target season, then contributes to the
# climatology term of the blend. One contiguous archive request covers it.
MODEL_YEARS = 10
MODEL_WINDOW_DAYS = 20  # season window (days on either side of the target DOY)
MODEL_MAX_MAE = 6.0     # a validation MAE above this means the model is useless

# Open-Meteo daily variable -> prediction field, unit, absolute bounds.
VARIABLES: dict[str, tuple[str, str, tuple[float, float]]] = {
    "temperature_2m_mean": ("temperature", "°C", (-90.0, 60.0)),
    "apparent_temperature_mean": ("apparent_temperature", "°C", (-90.0, 60.0)),
    "temperature_2m_max": ("max_temperature", "°C", (-90.0, 60.0)),
    "temperature_2m_min": ("min_temperature", "°C", (-90.0, 60.0)),
    "relative_humidity_2m_mean": ("humidity", "%", (0.0, 100.0)),
    "precipitation_sum": ("precipitation", "mm", (0.0, 500.0)),
    "wind_speed_10m_max": ("wind_speed", "km/h", (0.0, 250.0)),
    "cloud_cover_mean": ("cloud_cover", "%", (0.0, 100.0)),
}

# Forecast-only fields (no climatology blend; degrees are never averaged linearly).
FORECAST_ONLY_VARS: tuple[str, ...] = ("wind_direction_10m_dominant",)

# How far each LLM adjustment is allowed to move a blended value.
AGENT_ADJUSTMENT_LIMITS = {
    "temperature": 3.0,
    "humidity": 15.0,
    "wind_speed": 10.0,
    "rainfall_probability": 20.0,
}

AGENT_SYSTEM_PROMPT = (
    "You are a compact weather-prediction agent. You receive a numerical weather "
    "model's forecast for a location and date, plus the multi-year climatology "
    "(mean, std-dev, min, max) computed from reanalysis archive data for the same "
    "calendar window. Compare them, and return ONLY strict JSON — no prose, no "
    "markdown — with this exact shape: "
    '{"insight": string, "anomalies": string[], '
    '"adjustments": {"temperature": number, "humidity": number, '
    '"wind_speed": number, "rainfall_probability": number}}. '
    "adjustments are deltas applied to the blended prediction; keep each within "
    "temperature ±3, humidity ±15, wind_speed ±10, rainfall_probability ±20. "
    "Use them only when the forecast clearly disagrees with climatology. "
    "The insight (max 60 words) must explain how the forecast compares with the "
    "historical average for these dates. Never invent data that is not provided."
)


class ClimatePredictError(Exception):
    """Raised when neither provider nor archive data can produce a prediction."""


def clamp(value: float, lo: float, hi: float) -> float:
    return max(lo, min(hi, value))


def _finite(values: list[object]) -> list[float]:
    out = []
    for value in values:
        if isinstance(value, (int, float)) and math.isfinite(float(value)):
            out.append(float(value))
    return out


@dataclass(frozen=True)
class VariableStats:
    """Year-to-year distribution of one variable for the target date window."""

    mean: float
    std: float
    min: float
    max: float
    count: int


def summarize(values: list[float]) -> VariableStats | None:
    if not values:
        return None
    mean = sum(values) / len(values)
    if len(values) > 1:
        variance = sum((v - mean) ** 2 for v in values) / (len(values) - 1)
        std = math.sqrt(variance)
    else:
        std = 0.0
    return VariableStats(round(mean, 2), round(std, 2), min(values), max(values), len(values))


def model_weight(validation_mae: float | None) -> float:
    """Share of the trained MLP inside the climatology term (0 = ignore it).

    The better the model validates on held-out archive years, the more of
    the climatology term it may carry; a poor model falls back fully to the
    plain multi-year mean.
    """
    if validation_mae is None or validation_mae > MODEL_MAX_MAE:
        return 0.0
    if validation_mae <= 1.5:
        return 0.6
    if validation_mae <= 2.5:
        return 0.45
    return 0.25


def provider_weight(days_ahead: int, temp_std: float | None) -> float:
    """Trust the model less as lead time grows and as history gets tighter."""
    weight = 0.92 - 0.05 * days_ahead
    if temp_std is not None and temp_std > 0:
        # Tight climatology (std < 2.5 °C) pulls weight toward climatology.
        weight -= max(0.0, (2.5 - temp_std) / 2.5) * 0.12
    return clamp(weight, 0.5, 0.92)


def confidence_score(days_ahead: int, temp_std: float | None, precip_values: list[float]) -> int:
    """Confidence derives from lead time and observed historical spread."""
    score = 92.0 - 3.0 * days_ahead
    if temp_std is not None:
        score -= min(25.0, temp_std * 6.0)
    if precip_values:
        mean = sum(precip_values) / len(precip_values)
        variability = sum(abs(v - mean) for v in precip_values) / len(precip_values)
        score -= min(15.0, variability * 2.0)
    return int(clamp(round(score), 25, 95))


def condition_text(cloud: float | None, precip_mm: float | None, rain_probability: float | None) -> str:
    probability = rain_probability or 0
    mm = precip_mm or 0
    if mm >= 7.5 or probability >= 70:
        return "Rain"
    if (mm >= 1.0 and probability >= 25) or probability >= 45:
        return "Rain Likely"
    if cloud is None:
        return "Partly Cloudy"
    if cloud >= 70:
        return "Cloudy"
    if cloud >= 35:
        return "Partly Cloudy"
    return "Clear Sky"


def rainfall_intensity(precip_mm: float | None) -> str:
    if precip_mm is None or precip_mm < 0.2:
        return "None"
    if precip_mm < 2.5:
        return "Light"
    if precip_mm < 10.0:
        return "Moderate"
    return "Heavy"


def aqi_status(aqi: float | None) -> str | None:
    if aqi is None:
        return None
    bands = ((50, "Good"), (100, "Moderate"), (200, "Unhealthy"),
             (300, "Very Unhealthy"), (float("inf"), "Hazardous"))
    for limit, label in bands:
        if aqi <= limit:
            return label
    return "Hazardous"


def parse_agent_json(text: str) -> dict | None:
    """Parse the agent's reply; tolerate code fences. Returns None when invalid."""
    if not text:
        return None
    cleaned = text.strip()
    if cleaned.startswith("```"):
        cleaned = cleaned.strip("`")
        if cleaned.lower().startswith("json"):
            cleaned = cleaned[4:]
    try:
        parsed = json.loads(cleaned)
    except (ValueError, TypeError):
        return None
    if not isinstance(parsed, dict) or not isinstance(parsed.get("insight"), str):
        return None
    adjustments = parsed.get("adjustments")
    if adjustments is None:
        adjustments = {}
    elif not isinstance(adjustments, dict):
        return None
    cleaned_adjustments = {}
    for key, limit in AGENT_ADJUSTMENT_LIMITS.items():
        raw = adjustments.get(key)
        if isinstance(raw, (int, float)) and math.isfinite(float(raw)):
            cleaned_adjustments[key] = float(clamp(float(raw), -limit, limit))
    parsed["adjustments"] = cleaned_adjustments
    if not isinstance(parsed.get("anomalies"), list):
        parsed["anomalies"] = []
    parsed["anomalies"] = [str(item)[:120] for item in parsed["anomalies"][:3]]
    parsed["insight"] = parsed["insight"][:600]
    return parsed


def fallback_insight(prediction: dict, climatology: dict, days_ahead: int, confidence: int) -> str:
    """Deterministic insight used when no LLM key is configured or it fails."""
    temp_stats: VariableStats | None = climatology.get("temperature_2m_mean")
    predicted = prediction["temperature"]
    parts: list[str] = []
    if temp_stats and temp_stats.count:
        delta = predicted - temp_stats.mean
        direction = "above" if delta >= 0 else "below"
        parts.append(
            f"{predicted:.1f}°C is {abs(delta):.1f}°C {direction} the "
            f"{HISTORY_YEARS}-year average of {temp_stats.mean:.1f}°C for these dates"
            f" (spread ±{temp_stats.std:.1f}°C)"
        )
    rain_stats: VariableStats | None = climatology.get("precipitation_sum")
    if rain_stats and rain_stats.count:
        parts.append(f"typical rainfall here is {rain_stats.mean:.1f} mm/day")
    lead = f" {days_ahead} days ahead" if days_ahead > 0 else ""
    parts.append(f"prediction is {confidence}% confident{lead}")
    return ". ".join(parts).capitalize() + "."


class ClimatePredictService:
    """Blends Open-Meteo forecast with archive climatology, optionally via LLM."""

    def __init__(self, settings: Settings, client: httpx.AsyncClient | None = None):
        self.settings = settings
        # Archive hosts can be slow (>25 s under load); give them headroom.
        self.client = client or httpx.AsyncClient(
            timeout=httpx.Timeout(60.0, connect=10.0))
        self._owns_client = client is None
        # Date+location predictions are expensive (multi-year archive fetch);
        # reuse them well beyond the default weather cache window.
        self.cache: TTLCache = TTLCache(max(settings.cache_ttl_seconds, 1800))

    async def startup(self) -> None:
        return None

    async def shutdown(self) -> None:
        if self._owns_client:
            await self.client.aclose()

    # ------------------------------------------------------------------ fetch

    async def _forecast(self, lat: float, lon: float, start: date_type, end: date_type) -> dict:
        data = await self._open_meteo(
            self.settings.openmeteo_forecast_url,
            {
                "latitude": lat,
                "longitude": lon,
                "daily": ",".join(VARIABLES) + "," + ",".join(FORECAST_ONLY_VARS),
                "timezone": "auto",
                "start_date": start.isoformat(),
                "end_date": end.isoformat(),
            },
        )
        daily = data.get("daily") or {}
        times = daily.get("time") or []
        rows: dict[str, dict] = {}
        for index, day in enumerate(times):
            row = {}
            for variable in tuple(VARIABLES) + FORECAST_ONLY_VARS:
                values = daily.get(variable) or []
                finite = _finite(values[index:index + 1])
                row[variable] = finite[0] if finite else None
            rows[day] = row
        if not rows:
            raise ClimatePredictError("Provider returned no forecast rows")
        return rows

    def _history_params(self, lat: float, lon: float, start: date_type, end: date_type) -> dict:
        return {
            "latitude": lat,
            "longitude": lon,
            "daily": ",".join(VARIABLES),
            "timezone": "auto",
            "start_date": start.isoformat(),
            "end_date": end.isoformat(),
        }

    async def _history_year(self, lat: float, lon: float, year: int, window_start: date_type, window_end: date_type) -> list[dict]:
        try:
            start = date_type(year, window_start.month, window_start.day)
            end = date_type(year, window_end.month, window_end.day)
        except ValueError:  # Feb 29 in a non-leap year
            return []
        try:
            data = await self._open_meteo(
                self.settings.openmeteo_archive_url,
                self._history_params(lat, lon, start, end),
                attempts=2,
            )
        except ClimatePredictError as exc:
            # The archive host is frequently overloaded; the ERA5-based
            # historical-forecast host serves the same daily fields.
            logger.info("Archive fetch %s..%s failed (%s); trying historical-forecast host", start, end, exc)
            try:
                data = await self._open_meteo(
                    self.settings.openmeteo_historical_forecast_url,
                    self._history_params(lat, lon, start, end),
                )
            except ClimatePredictError as exc2:
                logger.warning("Historical fetch %s..%s failed: %s", start, end, exc2)
                return []
        daily = data.get("daily") or {}
        times = daily.get("time") or []
        records: list[dict] = []
        for index in range(len(times)):
            record: dict[str, float | None] = {}
            for variable in VARIABLES:
                values = daily.get(variable) or []
                finite = _finite(values[index:index + 1])
                record[variable] = finite[0] if finite else None
            records.append(record)
        return records

    # -------------------------------------------------------- trained model

    async def _trained_model(self, lat: float, lon: float,
                             target: date_type) -> ml_model.MLPModel | None:
        """Train (or reuse) the tiny MLP for this location and season.

        One contiguous archive request covers the last MODEL_YEARS of
        daily data; the training samples are the days near the target's
        season. Cached per location and calendar day, like the predictions
        themselves. Never raises: any failure means "no model", and the
        plain climatology blend runs as before.
        """
        cache_key = f"mlp:{lat:.2f}:{lon:.2f}:{target.month}:{target.day}"
        cached = await self.cache.get(cache_key)
        if cached is not None:
            return None if cached == "none" else cached
        try:
            start = date_type(target.year - MODEL_YEARS, target.month, target.day)
        except ValueError:  # Feb 29 in a non-leap year
            start = date_type(target.year - MODEL_YEARS, target.month, 28)
        try:
            data = await self._open_meteo(
                self.settings.openmeteo_archive_url,
                self._history_params(lat, lon, start, date_type.today()),
                attempts=2,
            )
        except ClimatePredictError as exc:
            logger.warning("Trained-model archive fetch failed: %s", exc)
            await self.cache.set(cache_key, "none")
            return None
        daily = data.get("daily") or {}
        times = daily.get("time") or []
        rows: list[dict] = []
        for index in range(len(times)):
            row: dict[str, object] = {"date": times[index]}
            for variable in VARIABLES:
                values = daily.get(variable) or []
                finite = _finite(values[index:index + 1])
                row[variable] = finite[0] if finite else None
            rows.append(row)
        samples = ml_model.build_samples(
            rows, ml_model.day_of_year(target), MODEL_WINDOW_DAYS)
        # Training is pure-Python CPU work; keep it off the event loop.
        model = await asyncio.to_thread(ml_model.train, samples) if samples else None
        await self.cache.set(cache_key, model if model is not None else "none")
        return model

    async def _open_meteo(self, url: str, params: dict, attempts: int = 3) -> dict:
        delay = 0.6
        last_error: ClimatePredictError | None = None
        for _ in range(attempts):
            try:
                response = await self.client.get(url, params=params)
                if response.status_code in (429, 500, 502, 503):
                    last_error = ClimatePredictError(f"provider busy (HTTP {response.status_code})")
                else:
                    response.raise_for_status()
                    return response.json()
            except httpx.HTTPError as exc:
                last_error = ClimatePredictError(str(exc))
            except ValueError as exc:
                raise ClimatePredictError(f"Open-Meteo response was not JSON: {exc}") from exc
            await asyncio.sleep(delay)
            delay *= 2.5
        raise last_error or ClimatePredictError("Open-Meteo unavailable")

    async def _current_aqi(self, lat: float, lon: float) -> float | None:
        try:
            data = await self._open_meteo(
                self.settings.openmeteo_air_quality_url,
                {"latitude": lat, "longitude": lon, "current": "us_aqi", "timezone": "auto"},
            )
            current = (data.get("current") or {}).get("us_aqi")
            return round(float(current), 1) if current is not None else None
        except (ClimatePredictError, TypeError, ValueError):
            return None

    # ------------------------------------------------------------------- agent

    async def _agent_adjust(self, payload: dict) -> dict | None:
        """Ask the hosted LLM to compare forecast vs climatology. None = fallback."""
        if not (self.settings.llm_api_key and self.settings.llm_base_url and self.settings.llm_model):
            return None
        body = {
            "model": self.settings.llm_model,
            "messages": [
                {"role": "system", "content": AGENT_SYSTEM_PROMPT},
                {"role": "user", "content": json.dumps(payload, ensure_ascii=False)},
            ],
            "temperature": 0.2,
            "max_tokens": 400,
        }
        headers = {"Authorization": f"Bearer {self.settings.llm_api_key}"}
        try:
            response = await self.client.post(self.settings.llm_base_url, json=body, headers=headers)
            response.raise_for_status()
            choices = response.json().get("choices") or []
            text = (choices[0].get("message") or {}).get("content") if choices else None
            return parse_agent_json(text or "")
        except (httpx.HTTPError, ValueError, KeyError, IndexError):
            logger.warning("LLM climate agent unavailable; using deterministic blend")
            return None

    # ---------------------------------------------------------------- predict

    async def predict(self, lat: float, lon: float, target: date_type,
                      city: str | None = None, country: str | None = None) -> dict:
        today = date_type.today()
        if target < today:
            target = today
        days_ahead = (target - today).days
        if days_ahead > MAX_FORECAST_DAYS_AHEAD:
            raise ClimatePredictError(f"date must be within {MAX_FORECAST_DAYS_AHEAD} days of today")

        cache_key = f"predict:{lat:.3f}:{lon:.3f}:{target.isoformat()}"
        cached = await self.cache.get(cache_key)
        if cached is not None:
            return cached

        trend_end = min(max(target, today + timedelta(days=6)), today + timedelta(days=MAX_FORECAST_DAYS_AHEAD))
        window_start = target - timedelta(days=HISTORY_WINDOW_DAYS)
        window_end = target + timedelta(days=HISTORY_WINDOW_DAYS)

        forecast_rows, aqi = await asyncio.gather(
            self._forecast(lat, lon, today, trend_end),
            self._current_aqi(lat, lon),
        )
        provider_row = forecast_rows.get(target.isoformat())
        if provider_row is None:
            raise ClimatePredictError("Provider returned no row for the target date")

        # Sequential on purpose: hammering the archive endpoint with parallel
        # requests is what gets it to answer "service is overloaded".
        records: list[dict] = []
        for offset in range(1, HISTORY_YEARS + 1):
            records.extend(await self._history_year(
                lat, lon, today.year - offset, window_start, window_end))
        if not records:
            raise ClimatePredictError("No historical archive data available for this location")

        climatology: dict[str, VariableStats] = {}
        for variable in VARIABLES:
            values = [record[variable] for record in records if record[variable] is not None]
            stats = summarize(values)
            if stats is not None:
                climatology[variable] = stats

        weight = provider_weight(
            days_ahead,
            climatology["temperature_2m_mean"].std if "temperature_2m_mean" in climatology else None,
        )

        # Trained non-linear model: learns mean temperature from weather
        # drivers + season over the last MODEL_YEARS of archive data, then
        # carries part of the climatology term when it validates well.
        ai_model: dict | None = None
        model_temp: float | None = None
        mlp_weight = 0.0
        try:
            model = await self._trained_model(lat, lon, target)
        except Exception as exc:  # the model must never break a working prediction
            logger.warning("Trained model unavailable: %s", exc)
            model = None
        if model is not None:
            mlp_weight = model_weight(model.validation_mae)
            if mlp_weight > 0.0:
                model_temp = model.predict(ml_model.day_of_year(target), {
                    "t_max": provider_row.get("temperature_2m_max"),
                    "t_min": provider_row.get("temperature_2m_min"),
                    "humidity": provider_row.get("relative_humidity_2m_mean"),
                    "wind": provider_row.get("wind_speed_10m_max"),
                    "precip": provider_row.get("precipitation_sum"),
                })
                if model_temp is not None and math.isfinite(model_temp):
                    model_temp = clamp(model_temp, -90.0, 60.0)
                    ai_model = {
                        "type": "MLP 7x8 tanh",
                        "trainedOn": f"{model.sample_count} archive days "
                                     f"({MODEL_YEARS}-year window)",
                        "validationMae": round(model.validation_mae, 2),
                        "prediction": round(model_temp, 2),
                        "weight": mlp_weight,
                    }
                else:
                    model_temp = None

        blended: dict[str, float | None] = {}
        baseline_temperature: float | None = None
        for variable, (field, _unit, bounds) in VARIABLES.items():
            provider_value = provider_row.get(variable)
            stats = climatology.get(variable)
            if provider_value is None and stats is None:
                blended[field] = None
                continue
            climatology_term = stats.mean if stats is not None else None
            if variable == "temperature_2m_mean" and model_temp is not None and climatology_term is not None:
                baseline_temperature = weight * provider_value + (1.0 - weight) * climatology_term \
                    if provider_value is not None else climatology_term
                climatology_term = mlp_weight * model_temp + (1.0 - mlp_weight) * climatology_term
            if provider_value is None:
                blended[field] = climatology_term
            elif climatology_term is None:
                blended[field] = provider_value
            else:
                blended[field] = weight * provider_value + (1.0 - weight) * climatology_term
            lo, hi = bounds
            blended[field] = clamp(blended[field], lo, hi)

        # A learned shift of the mean temperature also shifts the daily
        # extremes, keeping the diurnal range consistent.
        if model_temp is not None and baseline_temperature is not None:
            delta = blended["temperature"] - baseline_temperature
            if abs(delta) >= 0.05:
                for field in ("max_temperature", "min_temperature"):
                    if blended[field] is not None:
                        blended[field] = clamp(blended[field] + delta, -90.0, 60.0)

        # Rain probability: provider probability if present, else wet-day frequency.
        provider_rain_prob = provider_row.get("precipitation_probability_max")
        wet_days = [record["precipitation_sum"] for record in records
                    if record["precipitation_sum"] is not None]
        climatology_rain_prob = (100.0 * sum(1 for mm in wet_days if mm >= 1.0) / len(wet_days)) if wet_days else None
        if provider_rain_prob is not None and climatology_rain_prob is not None:
            rainfall_probability = weight * provider_rain_prob + (1.0 - weight) * climatology_rain_prob
        else:
            rainfall_probability = provider_rain_prob if provider_rain_prob is not None else climatology_rain_prob
        rainfall_probability = clamp(rainfall_probability or 0.0, 0.0, 100.0)

        prediction = {
            "temperature": round(blended["temperature"], 1),
            "feels_like": round(blended["apparent_temperature"] if blended["apparent_temperature"] is not None else blended["temperature"], 1),
            "humidity": round(blended["humidity"] or 0.0, 1),
            "wind_speed": round(blended["wind_speed"] or 0.0, 1),
            "precipitation": round(blended["precipitation"] or 0.0, 1),
            "rainfall_probability": round(rainfall_probability),
            "max_temperature": round(blended["max_temperature"], 1),
            "min_temperature": round(blended["min_temperature"], 1),
        }

        agent_payload = {
            "location": city or f"{lat:.2f}, {lon:.2f}",
            "date": target.isoformat(),
            "days_ahead": days_ahead,
            "provider_forecast": {key: value for key, value in provider_row.items() if value is not None},
            "climatology": {
                variable: {
                    "mean": stats.mean, "std": stats.std, "min": stats.min,
                    "max": stats.max, "samples": stats.count,
                }
                for variable, stats in climatology.items()
            },
            "blended_baseline": prediction,
        }
        if ai_model is not None:
            agent_payload["trainedModel"] = ai_model
        agent = await self._agent_adjust(agent_payload)
        if agent and agent["adjustments"]:
            limits = {field: AGENT_ADJUSTMENT_LIMITS[key]
                      for key, field in (("temperature", "temperature"), ("humidity", "humidity"),
                                         ("wind_speed", "wind_speed"), ("rainfall_probability", "rainfall_probability"))}
            for field, limit in limits.items():
                if field in prediction:
                    lo, hi = (0.0, 100.0) if field in ("humidity", "rainfall_probability") else (None, None)
                    adjusted = prediction[field] + agent["adjustments"].get(field, 0.0)
                    prediction[field] = round(clamp(adjusted, lo if lo is not None else -90.0,
                                                    hi if hi is not None else 250.0), 1)

        trend: list[dict] = []
        trend_day = today
        while trend_day <= trend_end and len(trend) < 7:
            row = forecast_rows.get(trend_day.isoformat()) or {}
            max_temp = row.get("temperature_2m_max")
            min_temp = row.get("temperature_2m_min")
            if max_temp is not None or min_temp is not None:
                trend.append({
                    "date": trend_day.strftime("%d %b"),
                    "max": round(max_temp if max_temp is not None else prediction["max_temperature"], 1),
                    "min": round(min_temp if min_temp is not None else prediction["min_temperature"], 1),
                })
            trend_day += timedelta(days=1)

        temp_stats = climatology.get("temperature_2m_mean")
        confidence = confidence_score(
            days_ahead,
            temp_stats.std if temp_stats else None,
            [record["precipitation_sum"] for record in records if record["precipitation_sum"] is not None],
        )
        if agent:
            confidence = int(clamp(confidence + (2 if not agent["anomalies"] else -3), 25, 95))

        insight = agent["insight"] if agent else fallback_insight(
            prediction, climatology, days_ahead, confidence)
        if agent and agent["anomalies"]:
            insight = insight.rstrip(".") + ". Noted: " + "; ".join(agent["anomalies"]) + "."
        elif ai_model is not None:
            insight = insight.rstrip(".") + (
                f" Trained neural model ({MODEL_YEARS}-year archive, "
                f"MAE ±{ai_model['validationMae']}°C) estimates "
                f"{ai_model['prediction']}°C for this date.")

        result = {
            "location": {"city": city or f"{lat:.2f}, {lon:.2f}", "country": country or ""},
            "forecast": {
                "date": target.isoformat(),
                "condition": condition_text(blended["cloud_cover"], blended["precipitation"], rainfall_probability),
                "temperature": prediction["temperature"],
                "feelsLike": prediction["feels_like"],
                "confidence": confidence,
                "humidity": prediction["humidity"],
                "windSpeed": prediction["wind_speed"],
                "windDirection": wind_cardinal(provider_row.get("wind_direction_10m_dominant")),
                "rainfallProbability": prediction["rainfall_probability"],
                "rainfallIntensity": rainfall_intensity(prediction["precipitation"]),
                "aqi": aqi,
                "aqiStatus": aqi_status(aqi),
                "snowfall": 0,
                "maxTemperature": prediction["max_temperature"],
                "minTemperature": prediction["min_temperature"],
            },
            "temperatureTrend": trend,
            "aiInsight": insight,
        }
        if ai_model is not None:
            result["forecast"]["aiModel"] = ai_model
        await self.cache.set(cache_key, result)
        return result
