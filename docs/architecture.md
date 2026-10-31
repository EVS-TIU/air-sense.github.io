# AIR_SENSE backend architecture

The lightweight service is organized into four layers:

* `app/config.py` loads and validates environment configuration.
* `app/routes.py` owns HTTP validation, status codes, and response shapes.
* `app/services.py` owns asynchronous OpenWeather calls, normalization, a
  bounded-by-TTL in-memory cache, and the deterministic recommendation engine.
* `app/llm.py` is an optional hosted-LLM adapter. It receives verified
  measurements and detected risks only, and failures return to rule-based
  output rather than affecting weather availability.

`WeatherClient` creates one reusable `httpx.AsyncClient` per application
lifespan. Current weather and the forecast are fetched concurrently, while
cached coordinate buckets prevent repeated provider calls. No user location is
derived from IP: the browser supplies GPS coordinates and city search uses
OpenWeather geocoding. UV is requested from OpenWeather One Call 3.0
`current.uvi` as an optional request; if unavailable for the API plan, the
weather response still succeeds with `uv_index: null`.

The frontend's existing `/weather/current` contract is retained: normalized
metric temperatures, `visibility` in metres, wind in km/h, condition metadata,
location fields, sunrise/sunset epochs, location timezone offset, UV data, and
`hourly` forecast points. The UV card compares the current epoch and the
sunrise/sunset epochs after applying the selected location's offset, so it
does not use the browser timezone. CORS allows only the configured
`FRONTEND_URL` (plus localhost development origins).