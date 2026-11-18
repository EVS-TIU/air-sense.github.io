# AIR_SENSE — Weather & Air-Quality Intelligence Platform

AIR_SENSE is a location-aware weather, air-quality and climate-prediction dashboard.
It combines **live forecast APIs, a 10-year reanalysis archive, a custom-trained
neural network (pure-Python MLP), an optional pretrained time-series model
(Chronos-Bolt-mini), an LLM "comparing agent" and a deterministic rule engine**
into one system that answers three questions:

1. *What is the weather/air right now and on the map?* — live data layer
2. *What will it be on a chosen date (up to 1 year ahead)?* — the prediction pipeline
3. *What should I do about it?* — the recommendation / chat layer

This document is an in-depth technical walkthrough of how the system is built,
where every number comes from, how the ML model is trained and how the pieces
fit together. It is written to double as source material for the research paper
and presentation.

---

## Table of contents

- [1. System architecture](#1-system-architecture)
- [2. Data sources](#2-data-sources)
- [3. The prediction pipeline (how it predicts)](#3-the-prediction-pipeline-how-it-predicts)
  - [3.1 Two prediction modes](#31-two-prediction-modes)
  - [3.2 Step-by-step flow](#32-step-by-step-flow)
  - [3.3 The blending mathematics](#33-the-blending-mathematics)
  - [3.4 Confidence scoring](#34-confidence-scoring)
  - [3.5 Hourly shape-of-day reconstruction](#35-hourly-shape-of-day-reconstruction)
  - [3.6 The Chronos-Bolt-mini forecaster](#36-the-chronos-bolt-mini-forecaster)
- [4. The trained model (ml_model.py)](#4-the-trained-model-ml_modelpy)
  - [4.1 The task](#41-the-task)
  - [4.2 Features (7 inputs)](#42-features-7-inputs)
  - [4.3 Architecture](#43-architecture)
  - [4.4 Training procedure](#44-training-procedure)
  - [4.5 Validation and quality gates](#45-validation-and-quality-gates)
  - [4.6 Why pure Python?](#46-why-pure-python)
- [5. The LLM layers (what the LLM does and does not do)](#5-the-llm-layers)
- [6. The deterministic rule engine (recommendations)](#6-the-deterministic-rule-engine)
- [7. The interactive map subsystem](#7-the-interactive-map-subsystem)
- [8. AI chat](#8-ai-chat)
- [9. API reference (backend endpoints)](#9-api-reference)
- [10. Project structure](#10-project-structure)
- [11. Tech stack](#11-tech-stack)
- [12. Running, testing and deployment](#12-running-testing-and-deployment)
- [13. Design decisions and honest limitations](#13-design-decisions-and-honest-limitations)

---

## 1. System architecture

The backend is a small FastAPI service organized in four layers; the frontend is
a vanilla-JS single-page dashboard (no build step, no framework).

```
┌──────────────────────────────  Frontend (vanilla JS + Leaflet)  ─────────────────────────────┐
│  Dashboard   Weather Map (heatmap layers, wind particles)   Climate Analysis   AI Chat      │
│  engine.js deterministic rule engine · weather-map/* renderers · weather-prediction.js       │
└───────────────────────────────────────┬──────────────────────────────────────────────────────┘
                                        │  JSON over HTTP (/api/v1/…)
┌───────────────────────────────────────▼──────────────────────────────────────────────────────┐
│                                  FastAPI backend (Python 3)                                 │
│                                                                                              │
│  routes.py ── validation, status codes, response shapes                                      │
│     │                                                                                        │
│     ├─► WeatherClient (services.py) ────── live weather + AQI + geocoding + recommendations  │
│     ├─► MapService (map_service.py) ────── viewport grids: weather / AQI / historical        │
│     ├─► ClimatePredictService ─────────── the prediction pipeline (section 3)                │
│     │      ├─ ml_model.py  7×8×1 MLP, trained per request-location (section 4)               │
│     │      ├─ chronos_model.py  optional Chronos-Bolt-mini, zero-shot (§ 3.6)                │
│     │      └─ LLM agent (optional) nudges blended values within hard clamps (section 5)      │
│     └─► AiChatService ──────────────────── LLM chat grounded in live dashboard data (§ 8)    │
│                                                                                              │
│  TTLCache: every provider response and trained model is cached in-process, per family        │
└───────┬───────────────┬──────────────────┬──────────────────┬───────────────────┬────────────┘
        │               │                  │                  │                   │
   Open-Meteo      Open-Meteo        Open-Meteo        OpenWeather         OpenRouter /
   Forecast API    Archive (ERA5)    Air Quality       (fallback)          any OpenAI-
                   reanalysis        (CAMS) + WAQI                         compatible LLM
```

Everything stateless: no database, no training pipeline on disk. Each prediction
is computed on demand from public data and cached in memory (TTL ≥ 30 min for
predictions, 5 min for live data, 15 min for AQI grids, 60 min for historical grids).
The only optional state on disk is the Chronos-Bolt checkpoint (§ 3.6), which is
gitignored and absent from the deployment image.

---

## 2. Data sources

| Source | What it provides | Key required | Role in the system |
|---|---|---|---|
| **Open-Meteo Forecast API** | Day-specific daily + hourly forecast (~16-day horizon), NOAA GFS fallback host | none (free) | Primary driver of any forecast ≤ 15 days ahead; supplies the MLP's driver inputs |
| **Open-Meteo Archive API** (ERA5 reanalysis) | Daily reanalysis values for past years | none (free) | (a) 5-year climatology, (b) the 10-year **training set for the MLP**, (c) the 180-day context for Chronos-Bolt |
| **Open-Meteo Historical-Forecast API** | ERA5-based historical model forecasts | none (free) | Fallback host when the archive host answers "service overloaded" (503) |
| **Open-Meteo Air-Quality API (CAMS)** | Modelled US AQI, PM2.5, PM10, NO₂, O₃, SO₂, CO | none (free) | Air-quality everywhere (point + map grids) |
| **WAQI** | Live ground-station AQI + pollutant details | optional token | Independent *validation* of modelled AQI; never mixed into the model grid |
| **OpenAQ** | Nearby ground-station pollutant concentrations | optional key | Second station source; concentrations only, never converted to AQI |
| **OpenWeather** | Current weather, 5-day/3-hourly forecast, geocoding, wind tiles | key (server-side only) | Legacy/fallback weather provider; retained contract for the dashboard |
| **OpenRouter (or any OpenAI-compatible endpoint)** | Hosted LLM | optional key | Insight text + bounded adjustments; chat composition |

Key design rule: **modelled data and station data are never averaged together**,
and no weather number the LLM produces is ever shown without passing through
hard-coded clamps.

---

## 3. The prediction pipeline (how it predicts)

Implemented in `backend/app/climate_predict.py` and exposed as
`GET /api/v1/climate/predict?lat=…&lon=…&date=YYYY-MM-DD`.

### 3.1 Two prediction modes

| Mode | Trigger | What it means |
|---|---|---|
| `provider-forecast` | target date ≤ **15 days** ahead (Open-Meteo horizon) | A day-specific numerical forecast exists and is blended with climatology |
| `climate-outlook` | 15 days < target ≤ **365 days** ahead | No day-specific forecast can exist. The prediction is built from the trained MLP + multi-year archive climatology ("what this date is usually like"), and the response is *labelled* an outlook |

The mode is reported in the response (`forecast.mode`) and outlook confidence is
capped at **45 %** so the UI never presents an outlook with forecast-level certainty.

### 3.2 Step-by-step flow

```
target date chosen (today … +365 days)
   │
   ├─(1) Fetch provider forecast rows (daily + hourly) for target date     [skip in outlook mode]
   ├─(2) Fetch AQI: current US-AQI + hourly AQI/PM2.5/PM10/NO₂ for target
   ├─(3) Climatology: for each of the last 5 years, fetch the archive
   │       window target ± 2 days → VariableStats (mean, std, min, max, count)
   │       per variable. Requests are sequential on purpose — parallel
   │       archive requests are what gets the host to return "overloaded".
   ├─(4) Train/reuse the MLP (section 4): last 10 years of archive data
   │       around the target's season; cached per (location, calendar day).
   ├─(5) Chronos-Bolt (optional, § 3.6): last 180 days of archived mean
   │       temperature → pretrained forecast for the target day.
   ├─(6) Blend: weighted mix of provider value and climatology mean,
   │       with the MLP and Chronos carrying part of the temperature term.
   ├─(7) LLM agent (optional): compares forecast vs climatology, returns
   │       strict-JSON adjustments; every delta re-validated and clamped.
   ├─(8) Derivations: condition text, rain intensity, 7-day trend,
   │       24-hour temperature/humidity/rain/AQI series, insight text.
   └─(9) Cache the whole result (TTL ≥ 1800 s) under `predict:{lat}:{lon}:{date}`
```

The MLP and Chronos must never break a working prediction: any failure in step
4 (archive down, too few samples, non-finite loss) or step 5 (torch or model
missing, inference error) simply means "no model this time" and the plain
climatology blend runs exactly as before.

### 3.3 The blending mathematics

For every daily variable `v ∈ {temperature, apparent temperature, max/min temp,
humidity, precipitation, wind speed, cloud cover}`:

```
blended(v) = w_provider · forecast(v) + (1 − w_provider) · climatology_mean(v)
```

The provider weight **decays with lead time and with how predictable the
location is**:

```
w_provider = clamp( 0.92 − 0.05·days_ahead − max(0, (2.5 − σ_temp)/2.5)·0.12 , 0.5, 0.92 )
```

- Day 0 → weight ≈ 0.92 (almost pure provider forecast).
- Day 15 → weight ≈ 0.5–0.7 depending on climate.
- If the location's historical temperature spread σ_temp is small (< 2.5 °C —
  a very stable climate), weight is pulled further toward climatology, because
  the past is a better predictor there.

**The trained model's contribution** applies only to mean temperature. Inside
the climatology term:

```
climatology_term_temp = w_mlp · MLP_prediction + (1 − w_mlp) · 5y_climatology_mean
```

where the model weight is gated by its own honest validation error:

| validation MAE | w_mlp | meaning |
|---|---|---|
| ≤ 1.5 °C | 0.60 | strong model — carries most of the climatology term |
| ≤ 2.5 °C | 0.45 | decent model |
| ≤ 6.0 °C | 0.25 | weak model — small voice |
| > 6.0 °C or no model | 0.00 | ignored entirely |

Because a learned shift of the mean must not distort the diurnal range, the
same temperature delta is also applied to max/min so the day's amplitude stays
consistent.

**The Chronos-Bolt contribution** also applies only to mean temperature, in
`provider-forecast` mode (it is skipped for climate outlooks). It is layered
inside the same term, after the MLP:

```
climatology_term_temp = w_chronos · chronos_prediction
                     + (1 − w_chronos) · (MLP blend above)

w_chronos = CHRONOS_WEIGHT · (1 − 0.5 · days_ahead / 15)
```

The default `CHRONOS_WEIGHT=0.45` gives ≈ 0.42 at +1 day and ≈ 0.23 at +15
days: a univariate extrapolation deserves less trust as the horizon grows. Set
`CHRONOS_WEIGHT=0` to keep the model report-only (or `CHRONOS_ENABLED=false`
to skip it entirely). If the model is unavailable, `w_chronos = 0` and the
formula collapses to the MLP blend.

**Rain probability** blends the provider's probability with a *wet-day
frequency* computed from the archive (fraction of past days with ≥ 1 mm rain),
falling back to whichever is available.

All outputs pass through physical bounds, e.g. temperature ∈ [−90, 60] °C,
humidity ∈ [0, 100] % — nothing outside physical reality can leave the endpoint.

### 3.4 Confidence scoring

Confidence is deterministic — not the LLM's opinion:

```
confidence = clamp( 92 − 3·days_ahead − min(25, σ_temp·6) − min(15, rain_variability·2), 25, 95 )
```

- lead time penalty: −3 points per day ahead
- climate unpredictability penalty: up to −25 from the observed year-to-year σ
- rain variability penalty: up to −15 from mean-absolute deviation of past rainfall
- LLM agent feedback: +2 if it found no anomalies, −3 if it did
- outlook mode: hard cap at 45

### 3.5 Hourly shape-of-day reconstruction

For forecast targets the provider's real hourly curve is used, **re-centred**
so its mean equals the blended daily mean. For archive/outlook targets (no
hourly data exists), a standard diurnal curve is generated from the predicted
min/mean/max:

```
T(hour) = T_min + (T_max − T_min) · ½(1 − cos(2π·((hour − 3) mod 24)/24))
```

coldest at ≈ 03:00, warmest at ≈ 15:00 — the *shape* is a model, the
*magnitude* always comes from the prediction itself. Missing humidity/rain/AQI
hours are held flat rather than leaving blank charts.

### 3.6 The Chronos-Bolt-mini forecaster

An optional second learned signal: [autogluon/chronos-bolt-mini](https://huggingface.co/autogluon/chronos-bolt-mini),
a ~48 M-parameter pretrained time-series model (Chronos-Bolt family) run
zero-shot — it is never trained on this project's data.

- **Input**: the last `CHRONOS_CONTEXT_DAYS` (default 180) daily mean
  temperatures for the location, from the same Open-Meteo archive used for
  climatology. Gaps are forward-filled; sparse windows (≥ 40 % missing) are
  rejected.
- **Inference**: one step per day of lead time; the archive's real lag is
  respected by counting from the last observed day, not from yesterday.
- **Output**: median plus 10 %/90 % quantiles, exposed in the prediction as
  `forecast.chronosModel` and narrated in `aiInsight`:

```json
"chronosModel": {
  "model": "chronos-bolt-mini",
  "prediction": 25.69,
  "range": [24.36, 27.23],
  "contextDays": 180,
  "weight": 0.435
}
```

**Does it help?** Backtested on Kolkata with 25 independent 180-day windows
(archive observations, lead times from the forecast date):

| Lead | Chronos MAE | Persistence MAE | 30-day mean MAE |
|---|---|---|---|
| +1 day | **0.63 °C** | 0.65 °C | 1.38 °C |
| +3 days | **1.23 °C** | 1.41 °C | 1.86 °C |
| +7 days | **1.87 °C** | 1.96 °C | 2.04 °C |

It beats persistence and climatology at every lead, modestly. Because the
provider forecast still carries most of the top-level weight at short range,
Chronos acts as an independent correction that matters more as lead time grows
rather than overriding the NWP.

**Operational behaviour**: torch and the pipeline are imported/loaded lazily on
the first prediction that needs them (≈ 2–5 s), then reused. The checkpoint is
read from `CHRONOS_MODEL_PATH` (default `backend/models/chronos-bolt-mini`).
When the weights, package or torch are absent — as in the lean Docker image —
the feature disables itself silently; it needs ~0.5 GB RSS, so it is not part
of the 512 MB deployment budget.

| Variable | Default | Meaning |
|---|---|---|
| `CHRONOS_ENABLED` | `true` | Master switch; `false` skips the model entirely |
| `CHRONOS_MODEL_PATH` | `backend/models/chronos-bolt-mini` | Local checkpoint directory |
| `CHRONOS_CONTEXT_DAYS` | `180` | Days of history fed to the model (32–1024) |
| `CHRONOS_WEIGHT` | `0.45` | Share of the learned temperature term; decays with lead time |

---

## 4. The trained model (`ml_model.py`)

This is the custom-trained machine-learning component of the project: a
fully-connected neural network implemented **from scratch in stdlib Python**
(only `math` and `random`), trained on demand against real reanalysis data.
The pretrained Chronos-Bolt model in § 3.6 is a separate, optional signal.

### 4.1 The task

**Supervised non-linear regression:**

> Given a day's weather drivers (daily max/min temperature, mean humidity,
> max wind speed, total precipitation) and the season (day-of-year encoded as
> a sin/cos pair), **predict that day's mean temperature** in °C.

At inference the drivers come from the provider's forecast row for the target
date (or, in outlook mode, from the climatology means) — so the network acts as
a **learned non-linear calibration of the provider forecast against ten years
of reanalysis data**.

### 4.2 Features (7 inputs)

| # | Feature | Encoding |
|---|---|---|
| 1 | `doy_sin` | sin(2π·doy / 365.25) — circular season position |
| 2 | `doy_cos` | cos(2π·doy / 365.25) — circular season position |
| 3 | `t_max` | daily max temperature (°C) |
| 4 | `t_min` | daily min temperature (°C) |
| 5 | `humidity` | mean relative humidity (%) — imputed from training mean if missing |
| 6 | `wind` | max 10 m wind speed (km/h) — imputed if missing |
| 7 | `precip` | daily precipitation sum (mm) — imputed if missing |

Season is encoded as a **sine/cosine pair** so December 31 and January 1 are
neighbours on the ring, not 364 days apart — the network can learn smooth
seasonal behaviour. Training samples are restricted to a **±20-day season
window** around the target's day-of-year (`circular_doy_distance` handles the
year wrap), so each model specialises in the season being predicted.

### 4.3 Architecture

```
input (7) ──► dense 7×8 ──► tanh (8 hidden units) ──► dense 8×1 ──► linear ──► ŷ (°C)
```

**MLP 7×8 tanh**: one hidden layer of 8 tanh units, linear output, ~80
parameters. Weights are a few KB in memory. The network is deliberately tiny:
it must train in well under a second on the few-hundred-sample window using
only CPU, inside a 512 MB RAM / 0.1 vCPU deployment target.

Standardisation (computed from the training set, stored with the model):

- features: z-score with mean and **mean-absolute-deviation** (robust to
  outliers, cheap to compute)
- target: same, with a floor of 1.0 to avoid division by zero
- inference: missing features are imputed from the stored training means

### 4.4 Training procedure

```
1. Data: ONE contiguous archive request = the last 10 years of daily
   reanalysis rows for this exact location (single HTTP call).
2. Sample selection: keep rows whose day-of-year is within ±20 days of the
   target's day-of-year (circular distance); drop rows with missing
   mean/max/min temperature or max < min. Typically a few hundred samples.
   Fewer than 40 samples → model refused (returns None).
3. Shuffle-free holdout: the MOST RECENT 20 % of samples (time-ordered)
   are held out for validation; the earlier 80 % train. This gives an
   honest generalisation MAE on unseen future-like data, not random-split
   optimism across neighbouring days.
4. Optimisation: full-batch gradient descent on MSE
     • 300 epochs
     • learning rate 0.08 / N  (mean-scaled → stable for any sample count)
     • init: N(0, 0.4/√7) for W1, zeros elsewhere, fixed seed 42
     • exact hand-derived backprop through linear output + tanh hidden layer
5. Guard: if any epoch's loss is non-finite, training aborts → no model.
```

Training runs off the event loop (`asyncio.to_thread`) so the API stays
responsive, and the trained model is cached per `location + calendar-day`
(`mlp:{lat}:{lon}:{month}:{day}`) so repeated views of the same date reuse it.

### 4.5 Validation and quality gates

The model reports itself to the UI:

```json
"aiModel": {
  "type": "MLP 7x8 tanh",
  "trainedOn": "212 archive days (10-year window)",
  "validationMae": 1.34,
  "prediction": 24.87,
  "weight": 0.6
}
```

Three gates keep a bad model from hurting predictions:

1. **Sample gate** — < 40 training samples → no model.
2. **MAE gate** — validation MAE > 6.0 °C → model weight 0 (ignored).
3. **Weight gate** — even a good model only *shares* the climatology term
   (max 0.6); it can never override the provider forecast on its own.

The validation MAE is also surfaced in the user-facing insight text
("Trained neural model (10-year archive, MAE ±1.34 °C) estimates 24.9 °C"),
so the user always sees how much the ML component trusts itself.

### 4.6 Why pure Python?

The free deployment target allows **512 MB RAM / 0.1 vCPU**. Importing
scikit-learn alone measured +116 MB on the dev machine — not viable. The same
network in stdlib Python trains in well under a second on this data size and
costs kilobytes of memory. This is a deliberate, documented trade-off:
at 7×8×1 scale, NumPy brings no meaningful speed advantage, and the dependency
budget buys headroom for everything else the service does.

---

## 5. The LLM layers

Three distinct, deliberately sandboxed LLM roles. In every one the LLM
**explains and nudges — it never invents numbers**.

| Role | Where | What it does | Guardrails |
|---|---|---|---|
| **Comparing agent** | `/climate/predict` | Reads provider forecast + climatology + trained-model output and returns strict JSON: `{insight, anomalies[], adjustments{temperature, humidity, wind_speed, rainfall_probability}}` | Hard clamps: ΔT ≤ ±3 °C, Δhumidity ≤ ±15, Δwind ≤ ±10 km/h, Δrain-prob ≤ ±20; reply re-parsed and re-validated; any failure → deterministic fallback insight |
| **Chat assistant** | `/ai/chat` | General-purpose chat grounded in a live-data JSON snapshot (current weather + modelled AQI) injected into the prompt | "Never invent weather or AQI values; if the DATA does not cover something, say so" — plus Markdown-safe rendering, no raw HTML to `innerHTML` |
| **Recommendation advisor** | `llm.py` (opt-in, not on the weather path) | Turns verified measurements + detected risks into concise advice text | Receives only verified numbers; 5 s timeout; failure → rule-based output |

If no LLM key is configured (or the provider is down), every feature still
works: the prediction falls back to a **deterministic insight** built from the
climatology stats, and chat falls back to a factual numbers summary that openly
says real conversation needs the key configured. The system never pretends to
be an AI it cannot be.

---

## 6. The deterministic rule engine

Recommendations come from transparent threshold rules, not from AI — the same
philosophy on both sides of the stack.

**Backend** (`services.py → build_recommendations`): temperature/humidity/rain/
wind/visibility/AQI thresholds (configurable via `Settings`) produce typed
risks `{type, severity: Low|Moderate|High|Severe, message}` plus an overall
severity.

**Frontend** (`frontend/js/engine.js`): a richer rule catalog with explicit
priorities **P0–P4** (from "Extreme heat risk" P1 down to "Comfortable
weather" P4), classification ladders for each variable (e.g. temperature:
Cold → Cool → Comfortable → Warm → Hot → Very hot → Extreme heat), an activity
engine that maps risk sets onto plan advice, and a **null-safe comparison
design**: missing data never matches a rule — it can never read as "safe" or
"zero".

Every rule fires from measured values with a machine-readable trigger list
(e.g. `["visibility_km", "weather_code"]`), which makes the output auditable —
exactly the property you want to defend in a paper.

---

## 7. The interactive map subsystem

`MapService` + `ForecastService` + `AirQualityService` + `HistoricalService` +
`map_grid` + `map_cache` serve viewport-based data grids:

- **One weather-grid request returns every scalar variable** (temperature,
  apparent temp, humidity, precipitation, cloud cover, wind speed/direction,
  surface pressure) — switching layers never costs another provider call.
- **Air-quality grids** honour the CAMS native lattice (~0.4° global, ~0.1°
  European domain): sampling points sit on a fixed degree lattice matching the
  model resolution, and when a viewport is too wide for the point budget the
  grid is **honestly coarser** — `resolution_limited: true`, a warning naming
  the effective spacing, real sampled values (never blank, interpolated or
  hidden). Colours blend only between neighbouring *real* sample points.
- **Antimeridian splitting, latitude clamping to Web-Mercator-safe −85..85**,
  a fixed grid-step ladder so nearby viewports share cache entries, batched
  point fetching, request coalescing, per-family TTLs (weather 300 s,
  AQI 900 s, historical 3600 s), stale-on-failure (`stale: true`), and HTTP 503
  + `Retry-After` on provider rate limits.
- **WAQI live stations** are fetched uncached (per WAQI terms) and rendered
  separately — never mixed into the model grid.
- Frontend renderers under `frontend/js/weather-map/`: colour palettes,
  scalar heatmaps, wind particle rendering, legends and popup enrichment on
  top of the existing Leaflet map.

---

## 8. AI chat

The Weather Chat page (`POST /api/v1/ai/chat`) is a conversational assistant
that answers general questions while knowing the user's live weather and AQI:

1. On load, `POST /ai/chat/intro` produces a grounded opening overview
   (temperature + sky, one notable factor, US AQI with health meaning, one tip)
   — composed by the LLM when configured, otherwise deterministic.
2. Each question is sent to the LLM with the last 20 turns of history plus a
   `DATA:` JSON snapshot (current weather keys + US AQI + status).
3. Replies are rendered with a safe Markdown subset — no raw HTML from the
   model can reach `innerHTML`.
4. Without a key: first turn returns the factual summary plus a notice; later
   turns just point at the notice instead of replaying canned text. The notice
   distinguishes "key not configured" from "LLM briefly unreachable".

---

## 9. API reference

Base path `/api/v1`. Coordinates accept `lat`/`lon` or `latitude`/`longitude`.

| Endpoint | Purpose |
|---|---|
| `GET /health` | Service status + provider configuration status |
| `GET /weather/current` | Normalised current conditions + next forecast points |
| `GET /weather/forecast` | Normalised 5-day / 3-hourly forecast |
| `GET /weather/air-quality` | Modelled US AQI + pollutants, with optional WAQI/OpenAQ station validation |
| `GET /climate/predict?date=…` | **The prediction pipeline** (§ 3): blended forecast or climate outlook, trained-model block (`forecast.aiModel`), optional Chronos block (`forecast.chronosModel`), hourly series, insight, confidence |
| `POST /ai/chat` | LLM chat grounded in live dashboard data |
| `POST /ai/chat/intro` | Automatic grounded opening message |
| `GET /map/weather?bbox=…&zoom=…&time=…` | Viewport weather grid (all variables in one call) with forecast-timeline slicing |
| `GET /map/air-quality?bbox=…` | Viewport US AQI grid on the CAMS lattice |
| `GET /map/air-quality/stations[/{id}]` | Live WAQI stations / station detail (uncached) |
| `GET /map/point?lat=…&lon=…` | Combined live weather + AQI point for map popups |
| `GET /map/historical?bbox=…&date=…` | Historical archive grid for a past date |
| `GET /location/search?q=…` / `GET /location/reverse` | Geocoding / reverse geocoding |
| `GET /recommendations` | Rule-based risks + recommendations |
| `GET /weather/summary` | Weather + air quality + intelligence in one response |

Error contract: provider failures → HTTP 502 with a safe `detail`; missing
configuration → 503; rate limits → 503 with `Retry-After`. Full details in
[docs/api.md](docs/api.md).

---

## 10. Project structure

```
air_sense/
├── run.py                       ★ one-command launcher: venv + backend + frontend
├── backend/
│   ├── app/
│   │   ├── main.py              FastAPI app, lifespan wiring, CORS
│   │   ├── config.py            pydantic-settings env configuration
│   │   ├── routes.py            HTTP layer: validation, status codes, shapes
│   │   ├── services.py          WeatherClient (OpenWeather/Open-Meteo), caches,
│   │   │                        normalisers, EPA AQI calc, recommendations
│   │   ├── climate_predict.py   ★ prediction pipeline: climatology + blend + LLM agent
│   │   ├── ml_model.py          ★ the pure-Python MLP: features, training, inference
│   │   ├── chronos_model.py     optional Chronos-Bolt-mini wrapper (lazy, zero-shot)
│   │   ├── ai_chat.py           chat service (LLM + grounded fallback)
│   │   ├── llm.py               optional LLM recommendation adapter (isolated)
│   │   ├── openmeteo.py         Open-Meteo HTTP client (batched locations)
│   │   ├── forecast.py          ForecastService (forecast + GFS fallback)
│   │   ├── air_quality.py       AirQualityService (CAMS + WAQI stations)
│   │   ├── historical.py        historical archive service
│   │   ├── map_service.py       viewport grid orchestration
│   │   ├── map_grid.py          grid geometry: antimeridian, lat clamp, step ladder
│   │   └── map_cache.py         per-family TTL grid cache + coalescing
│   ├── scripts/
│   │   └── download_chronos.py  fetch the Chronos checkpoint from Hugging Face
│   ├── models/                  Chronos weights (gitignored, ~82 MB)
│   ├── requirements.txt         six lean runtime dependencies
│   ├── requirements-ml.txt      optional torch + chronos extras
│   └── tests/                   pytest: API, ML models, climate predict, map, chat…
├── frontend/                    static SPA (no build step)
│   ├── index.html               dashboard
│   ├── climate-analysis/        prediction / AQI outlook / climate trend pages
│   ├── AI-recommendation.html   Weather Chat page
│   ├── history-analysis.html    historical analysis page
│   ├── js/
│   │   ├── engine.js            ★ deterministic rule engine (P0–P4) + activities
│   │   ├── weather.js / app.js  dashboard data wiring
│   │   ├── weather-background.js ★ condition + day/night background video
│   │   ├── ai-app.js            chat UI (Markdown-safe rendering)
│   │   └── weather-map/         map renderers: palettes, scalar, wind, legends, popups
│   └── assets/                  icons, weather images, background clips, vendored Leaflet
├── docs/                        api.md (endpoint handbook), architecture.md
├── docker-compose.yml           backend service
├── Dockerfile                   repo-root image building the FastAPI app
└── README.md                    this document
```

---

## 11. Tech stack

- **Backend**: Python 3, FastAPI, pydantic-settings, httpx (async), Uvicorn —
  six lean runtime dependencies; the MLP needs **zero** of them and runs on
  the 512 MB deployment target.
- **ML**: hand-written MLP (7×8×1, tanh), full-batch gradient descent, exact
  backprop — no ML framework. Optionally, Chronos-Bolt-mini (48 M params,
  zero-shot, `torch` CPU + `chronos-forecasting`) as a separate extras
  install; it is lazy-loaded and not part of the lean deployment image.
- **Frontend**: vanilla HTML/CSS/JS, Leaflet + vendored plugins, no bundler,
  no framework, no build step.
- **Testing**: pytest with mocked providers (tests for the API contract, the
  MLP training/invariants, the climate pipeline, map grids, chat fallbacks).
- **Deployment**: Docker (repo-root Dockerfile builds `backend/`), compose
  file, hosted at 512 MB RAM / 0.1 vCPU; frontend on Vercel
  (`air-sense-web.vercel.app` is whitelisted in CORS).

---

## 12. Running, testing and deployment

### Quick start (one command, frontend + backend)

```bash
# one-time: create an environment with the lean runtime deps
python3 -m venv .venv && .venv/bin/pip install -r backend/requirements.txt
# (on Debian/Ubuntu without python3-venv:)
# uv venv --python 3.13 .venv && uv pip install --python .venv/bin/python -r backend/requirements.txt

# then, from the repo root:
python3 run.py
# frontend: http://127.0.0.1:5500
# backend:  http://127.0.0.1:8000 (docs at /docs)
```

`run.py` detects `.venv` (even when the system Python cannot import the
dependencies), serves `frontend/` statically and runs uvicorn for
`app.main:app` in the same process group. Ctrl+C stops both.

| Flag | Effect |
|---|---|
| `--install` | install `backend/requirements.txt` (uses `uv pip` when available) |
| `--reload` | backend auto-reload on code changes |
| `--open` | open the frontend in the default browser |
| `--backend-port` / `--frontend-port` | override defaults `8000` / `5500` |

Environment variables (`PORT`, `FRONTEND_URL`, provider keys) are read from
`backend/.env`; `run.py` changes into `backend/` before starting uvicorn, so
relative paths in that file behave as usual.

### Chronos-Bolt-mini (optional forecaster)

The climate prediction endpoint can blend in a pretrained zero-shot
time-series model, [autogluon/chronos-bolt-mini](https://huggingface.co/autogluon/chronos-bolt-mini)
(see § 3.6). It reads the last months of archived daily temperatures and
forecasts the target day; the result appears as `forecast.chronosModel` and in
the insight.

```bash
# inside the project venv (adds torch CPU ~200 MB + chronos)
uv pip install --python .venv/bin/python -r backend/requirements-ml.txt

python3 backend/scripts/download_chronos.py
# -> backend/models/chronos-bolt-mini (82 MB, gitignored)
```

With `run.py` already running, verify it on a live prediction:

```bash
curl 'http://127.0.0.1:8000/api/v1/climate/predict?lat=22.5726&lon=88.3639'
# "chronosModel": {"model": "chronos-bolt-mini", "prediction": ...}
```

It is lazy-loaded on the first prediction (≈ 2–5 s once) and skipped entirely
when the weights, torch or the package are missing — the deployment image
therefore stays lean and within its 512 MB budget (the model needs ~0.5 GB
RAM). Tune with `CHRONOS_ENABLED`, `CHRONOS_MODEL_PATH`,
`CHRONOS_CONTEXT_DAYS` and `CHRONOS_WEIGHT` (see `backend/.env.example`).

### Backend (manual, without `run.py`)

```bash
cd backend
python3 -m venv .venv && . .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env          # set OPENWEATHER_API_KEY and FRONTEND_URL
uvicorn app.main:app --reload --host 127.0.0.1 --port 8000
```

Optional server-side integrations go in `.env` (never in frontend JS or git):
`LLM_API_KEY`, `LLM_BASE_URL`, `LLM_MODEL` (OpenRouter-compatible), and
`WAQI_API_TOKEN` / `OPENAQ_API_KEY` for station validation.

### Frontend (manual, without `run.py`)

```bash
cd frontend
python3 -m http.server 5500 --bind 127.0.0.1
# open http://127.0.0.1:5500/index.html — localhost automatically targets the local API
```

### Weather-aware background video

The dashboard, climate, history and chat pages share one fixed full-screen
background clip that follows the live weather at the selected location.
`frontend/js/weather-background.js` maps the backend `condition` to a clip in
`frontend/assets/video/` and picks a day or night variant:

| Condition | Day clip | Night clip |
| --- | --- | --- |
| `clear` | `sunny.mp4` | `clear_night_sky.mp4` |
| `partly_cloudy` | `partly_cloud.mp4` | `night_cloudy.mp4` |
| `cloudy` / `unknown` | `cloudy.mp4` | `night_cloudy.mp4` |
| `overcast` | `overcast.mp4` | `night_cloudy.mp4` |
| `fog` | `fog_sky.mp4` | `fog_sky.mp4` + night filter |
| `drizzle` / `rain` | `rain_shower.mp4` | `dark_rain_clouds.mp4` |
| `snow` | `snow_fall.mp4` | `snow_fall.mp4` + night filter |
| `thunderstorm` | `thunderstorm.mp4` | `thunderstorm.mp4` + night filter |

Day/night comes from `is_day` when the provider supplies it, then from the
provider's `sunrise`/`sunset`, and otherwise from the sun's actual elevation
at the selected coordinates (NOAA approximation) — not a fixed 06:00–18:00
window, which would be wrong in winter and at high latitudes. Pages driven by
`app.js` call `AirSenseBackground.update(weather)`;
standalone pages set `data-weather-background="auto"` on their container and
the script fetches `/weather/current` itself and follows
`weatherly:location-change` events. A missing clip logs a warning and falls
back to `cloudy.mp4` (`Overcast.jpg` poster). If device location is denied,
`app.js` seeds both the Current Weather card and the background from
`airsense:selected-location` (or `AIREC_CONFIG.DEFAULT_LOCATION`), so the two
stay consistent; geolocation errors no longer reset an already-resolved clip
back to the cloudy fallback.

To add or replace a clip, drop an `.mp4` (H.264, 720p, 10–30 s loop) into
`frontend/assets/video/` and add or edit its entry in the `CLIPS` map. Videos
are muted, looped and `playsinline`; `prefers-reduced-motion` hides them
entirely. Keep clips short and compressed: most shipped clips are 20–30 s
(a few short loops are 4–12 s) and the whole folder is about 28 MB, down from
145 MB before compression. Re-encode a heavy clip with:

```bash
ffmpeg -ss 0 -t 24 -i frontend/assets/video/snow_fall.mp4 \
  -an -vf "fps=24,scale=1280:-2" -c:v libx264 -crf 29 -preset slow \
  -pix_fmt yuv420p -profile:v high -movflags +faststart /tmp/snow_fall.mp4
```

The clips are served with a `?v=` asset version (`ASSET_VERSION` in
`weather-background.js`); bump that and the `<video src>` query when replacing
a file so returning visitors do not keep a stale cached copy.

### Tests

```bash
cd backend && pytest
```

The suite covers the API contract, MLP training/invariants, the Chronos
wrapper, the climate pipeline, map grids and chat fallbacks. A network-free
run is fully green; on a machine with internet access `test_missing_api_key`
can report a failure because the Open-Meteo fallback succeeds where the test
expects a provider failure — that is not a regression in the prediction code.

### Docker

```bash
cd backend && docker build -t air-sense-backend .
docker run --rm -p 8000:8000 --env-file .env air-sense-backend
# or from the repo root:
docker compose up --build
```

The container reads `PORT` and listens on `0.0.0.0`; health check path is
`/api/v1/health`. The Chronos model weights are excluded from the build
context (`backend/.dockerignore`), and `chronos_model.py` disables itself when
torch/weights are absent, so the image stays inside the deployment budget.

---

## 13. Design decisions and honest limitations

**Why blend instead of trust one source?** A single NWP forecast is often
biased for a given location; a single climatology is blind to the current
synoptic situation. The blend uses the NWP where it is trustworthy (short lead
times) and climatology where it is not (long lead times), with a neural
calibration in between — and every weight is derived from *measured* spread in
the historical record rather than tuned by hand per city.

**Why train per request instead of a global model?** One archive HTTP call
yields a location- and season-specific dataset for free; the model then
describes *this place at this time of year*, which is exactly the question the
user asked. The result is cached, so the cost is one training run per
location+date view.

**Why keep the LLM out of the numbers?** LLMs hallucinate; regressions don't.
The architecture makes the deterministic stack the source of truth and the LLM
a narrator/verifier whose every numeric suggestion passes a hard clamp. The
same rule protects chat ("never invent weather or AQI values").

**Known limitations (stated honestly):**

- The MLP is trained on ~±20-day windows around the target season (a few
  hundred samples) — it is a season calibration, not a general climate model.
- In outlook mode (>15 days ahead) there is no day-specific forecast; results
  are labelled `climate-outlook` and confidence-capped at 45 %.
- AQI is *modelled* (CAMS) at its native resolution; WAQI/OpenAQ stations are
  shown for comparison only and are never merged into the model field.
- The archive host is occasionally overloaded (503); the system falls back to
  the ERA5 historical-forecast host and, failing that, degrades gracefully.
- Chronos-Bolt is a univariate temperature model: it sees only past daily
  means, not pressure/wind/humidity, so it cannot anticipate a synoptic change.
  It is used only in `provider-forecast` mode, its weight decays with lead
  time, and it is disabled automatically on the lean deployment (≈ 0.5 GB RAM
  with torch).
- Free-tier provider weight caps bound how many grid points can be fetched per
  request; the grid therefore becomes coarser rather than failing on wide views.

**Data attribution shown in the product:** weather data © Open-Meteo.com
(CC BY 4.0); air quality based on CAMS data distributed by Open-Meteo; station
data from WAQI and OpenAQ.
