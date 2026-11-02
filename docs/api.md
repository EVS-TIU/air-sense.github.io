# AIR_SENSE API

The API is served by FastAPI under `/api/v1`. Weather coordinates may be sent
as either `lat`/`lon` or `latitude`/`longitude`; latitude is `-90..90` and
longitude is `-180..180`.

## Run locally

```bash
cd backend
python3 -m venv .venv && . .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env
# Set OPENWEATHER_API_KEY and FRONTEND_URL in .env
uvicorn app.main:app --reload --host 0.0.0.0 --port 8000
```

When using VS Code Live Server (“Go Live”), open the frontend through a
`localhost` URL such as `http://127.0.0.1:5500/frontend/`. The frontend
automatically uses the local API at `http://127.0.0.1:8000/api/v1`; deployed
frontend hosts continue to use the configured deployed API URL. Live Server
ports are allowed by the backend CORS configuration.

## Endpoints

* `GET /api/v1/health` - service status and provider configuration status.
* `GET /api/v1/weather/current?lat=35.46&lon=-97.51` - normalized current
  conditions plus the next forecast points used by the dashboard.
* `GET /api/v1/weather/forecast?lat=35.46&lon=-97.51` - normalized 5-day,
  3-hour forecast.
* `GET /api/v1/weather/air-quality?lat=35.46&lon=-97.51` - Open-Meteo/CAMS
  modelled US AQI and pollutants, with separate nearby WAQI/OpenAQ station
  validation when their optional server-side credentials are configured.
* `GET /api/v1/location/search?q=London` - up to five OpenWeather geocoding
  results.
* `GET /api/v1/recommendations?lat=35.46&lon=-97.51` - rule-based risks and
  practical recommendations.
* `GET /api/v1/weather/summary?lat=35.46&lon=-97.51` - weather, air quality,
  and recommendations in one response.
* `GET /api/v1/map/weather?bbox=west,south,east,north&zoom=5` - viewport
  weather grid for the map layers (temperature, wind, humidity, rainfall,
  clouds). Fetching one grid returns every variable, so switching between
  weather layers does not create another provider request.
* `GET /api/v1/map/air-quality?bbox=west,south,east,north&zoom=5` - viewport
  US AQI grid from the Open-Meteo Air Quality API (CAMS).
* `GET /api/v1/map/point?lat=35.46&lon=-97.51` - combined live weather and
  air-quality point values used by the map popup.
* `GET /api/v1/map/historical?bbox=west,south,east,north&zoom=5&date=2025-01-15`
  - historical archive grid for a past UTC date. This is a separate dataset
  from the live forecast layers and is not mixed into current conditions.

### Map grid contract

Map endpoints accept a Leaflet-style `bbox` (`west,south,east,north`), a
zoom level `0..19`, and an optional comma-separated `variables` filter. The
backend splits viewports that cross the antimeridian, clamps latitude to the
Web-Mercator-safe `-85..85` range, and chooses a grid step from a fixed ladder
so nearby viewports share cache entries. Grids are capped by
`MAP_MAX_POINTS` (400 by default).

Responses contain `provider`, `family`, `dataset`, `bbox`, `zoom`,
`resolution_deg`, `columns`, `rows`, `point_count`, `data_time`, `units`,
`stale`, and `segments`. Each segment contains its own `bbox`, `latitudes`,
`longitudes`, and a `values` matrix per variable indexed as
`values[variable][row][column]`. Missing values are `null` and are rendered as
transparent cells, never as zero.

Weather grids use a 300-second cache, air-quality grids 900 seconds, and
historical grids 3600 seconds. Identical in-flight requests are coalesced. If
the provider fails after a cached grid exists, the cached response is returned
with `stale: true` and a warning. Provider rate limits return HTTP 503 with a
`Retry-After` header when the provider supplies one.

Map data is sourced from Open-Meteo. Weather data is © Open-Meteo.com
(CC BY 4.0); air quality is based on CAMS data distributed by Open-Meteo. The
frontend displays this attribution plus the effective sampling grid and the
approximate model resolution. No paid API or API key is required.

Successful current response includes `temperature`, `apparent_temperature`,
`humidity`, `pressure`, `visibility`, `wind_speed` (km/h), `wind_direction`,
`clouds`, `condition`, `description`, sunrise/sunset, precipitation fields,
`timezone_offset`, `uv_index`, and `hourly`. `uv_index` comes from
OpenWeather One Call 3.0 `current.uvi`; if the configured OpenWeather plan
does not provide One Call 3.0, it is `null` rather than fabricated. Provider
failures return a safe JSON `detail` with HTTP 502;
missing configuration returns 503.

The live air-quality response keeps datasets separate. `modelled` contains
Open-Meteo/CAMS `us_aqi`, its US AQI category/scale, six pollutant
concentrations and the model timestamp. `stations.waqi` contains a nearby
WAQI station's reported index on its own WAQI scale and its own pollutant
indices. `stations.openaq.stations` contains nearby ground-station pollutant
concentrations and observation times; OpenAQ concentrations are not converted
to AQI. Station readings are never averaged or substituted into the modelled
AQI. Missing station credentials or provider failures leave modelled results
available and mark that station source unavailable.

Open-Meteo/CAMS model data and OpenAQ station results are cached for
`AIR_QUALITY_CACHE_TTL_SECONDS` (300 seconds by default). WAQI results are
requested live and not cached, in accordance with its data terms. Configure
`WAQI_API_TOKEN` and `OPENAQ_API_KEY` in the backend environment; neither key is
sent to the browser. Open-Meteo requires no key. Cite Open-Meteo/CAMS, WAQI and
OpenAQ when their data is shown. WAQI's free API terms prohibit paid-app use
and require additional permission for public for-profit use.

## Configuration

`OPENWEATHER_API_KEY` is used by the existing OpenWeather weather fallback.
`WAQI_API_TOKEN` and `OPENAQ_API_KEY` optionally enable nearby station checks;
the Open-Meteo/CAMS modelled AQI endpoint works without API keys.
`FRONTEND_URL`, `ENVIRONMENT`, `PORT`, `CACHE_TTL_SECONDS`, and
`HTTP_TIMEOUT_SECONDS`, and `AIR_QUALITY_CACHE_TTL_SECONDS` are supported.
`LLM_API_KEY`, `LLM_BASE_URL`, and
`LLM_MODEL` optionally enable the isolated hosted-LLM adapter; weather endpoints
never depend on it. Do not commit `.env`.

## Tests and Docker

```bash
cd backend
pytest
docker build -t air-sense-backend .
docker run --rm -p 8000:8000 --env-file .env air-sense-backend
```

The container reads `PORT` and listens on `0.0.0.0`.

On Voroa, a Dockerfile is used only when the service runtime is
**Docker (Dockerfile)** at create time. Auto-detect defaults to Node.js and
cannot be switched later. Create a new web service with:

- Runtime: Docker (Dockerfile)
- Dockerfile path: `/Dockerfile`
- Root directory: `/`

The repo-root Dockerfile builds the FastAPI app in `backend/`. Set
`OPENWEATHER_API_KEY` and `FRONTEND_URL` on the service. Health check path:
`/api/v1/health`.
