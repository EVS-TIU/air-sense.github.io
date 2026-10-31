# AIR_SENSE API

The API is served by FastAPI under `/api/v1`. Weather coordinates may be sent
as either `lat`/`lon` or `latitude`/`longitude`; latitude is `-90..90` and
longitude is `-180..180`.

## Run locally

```bash
cd backend
python -m venv .venv && . .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env
# Set OPENWEATHER_API_KEY and FRONTEND_URL in .env
uvicorn app.main:app --reload --host 0.0.0.0 --port 8000
```

## Endpoints

* `GET /api/v1/health` - service status and provider configuration status.
* `GET /api/v1/weather/current?lat=35.46&lon=-97.51` - normalized current
  conditions plus the next forecast points used by the dashboard.
* `GET /api/v1/weather/forecast?lat=35.46&lon=-97.51` - normalized 5-day,
  3-hour forecast.
* `GET /api/v1/weather/air-quality?lat=35.46&lon=-97.51` - OpenWeather AQI
  and pollutant components.
* `GET /api/v1/location/search?q=London` - up to five OpenWeather geocoding
  results.
* `GET /api/v1/recommendations?lat=35.46&lon=-97.51` - rule-based risks and
  practical recommendations.
* `GET /api/v1/weather/summary?lat=35.46&lon=-97.51` - weather, air quality,
  and recommendations in one response.

Successful current response includes `temperature`, `apparent_temperature`,
`humidity`, `pressure`, `visibility`, `wind_speed` (km/h), `wind_direction`,
`clouds`, `condition`, `description`, sunrise/sunset, precipitation fields,
`timezone_offset`, `uv_index`, and `hourly`. `uv_index` comes from
OpenWeather One Call 3.0 `current.uvi`; if the configured OpenWeather plan
does not provide One Call 3.0, it is `null` rather than fabricated. Provider
failures return a safe JSON `detail` with HTTP 502;
missing configuration returns 503.

Air-quality responses include OpenWeather pollutant components and its
`provider_index` on the documented 1–5 OpenWeather scale. `epa_aqi` is
populated only when pollutant values include valid US EPA averaging periods
and units; the current OpenWeather endpoint provides instantaneous μg/m³
concentrations, so it normally remains `null`. The UI never labels the
provider index as US EPA AQI.

## Configuration

`OPENWEATHER_API_KEY` is required for provider-backed endpoints.
`FRONTEND_URL`, `ENVIRONMENT`, `PORT`, `CACHE_TTL_SECONDS`, and
`HTTP_TIMEOUT_SECONDS` are supported. `LLM_API_KEY`, `LLM_BASE_URL`, and
`LLM_MODEL` optionally enable the isolated hosted-LLM adapter; weather endpoints
never depend on it. Do not commit `.env`.

## Tests and Docker

```bash
cd backend
pytest
docker build -t air-sense-backend .
docker run --rm -p 8000:8000 --env-file .env air-sense-backend
```

The container reads `PORT` and listens on `0.0.0.0`, making the backend
suitable for a Voroa Nano deployment with `backend` as its deployment root.