/* ==========================================================================
   AirSense — frontend logic
   Dynamic, location-aware weather background + Current Weather Hero Card
   ========================================================================== */

const apiBaseMeta = document.querySelector('meta[name="airsense-api-base"]');
const DEFAULT_API_BASE_URL = "https://airsense-backend-docker.getvoroa.com/api/v1";
const LOCAL_API_BASE_URL = "http://127.0.0.1:8000/api/v1";
const isLocalFrontend =
  window.location.hostname === "localhost" ||
  window.location.hostname === "127.0.0.1";
const API_BASE_URL = (
  window.AIRSENSE_API_BASE_URL ||
  // A localhost frontend automatically calls the local API; the meta tag only
  // pins the deployed API for hosted (non-local) frontends.
  (isLocalFrontend ? LOCAL_API_BASE_URL : (apiBaseMeta?.content || DEFAULT_API_BASE_URL))
).replace(/\/+$/, "");

const WEATHER_ASSET_ROOT = "./assets/images/weather/";
const WEATHER_ILLUSTRATION_ROOT = "./assets/images/weather-illustrations/";
const WEATHER_ICON_ROOT = "./assets/icons/weather/";
const DEFAULT_BACKGROUND = "Clear_day.jpg";
const NIGHT_BACKGROUND = "Clear_night.jpg";
const DEFAULT_ILLUSTRATION = "cloudy.png";
const DEFAULT_CONDITION_ICON = "default.svg";
const WEATHER_REFRESH_MS = 10 * 60 * 1000;
const WEATHER_REQUEST_TIMEOUT_MS = 12 * 1000;
const GEOLOCATION_TIMEOUT_MS = 20000;
const GEOLOCATION_MAXIMUM_AGE_MS = 0;
const GEOLOCATION_STALE_AFTER_MS = WEATHER_REFRESH_MS;
// A kilometre can cross several neighbourhood boundaries; warn earlier so a
// coarse browser fix is never presented as a confidently identified locality.
const GEOLOCATION_ACCURACY_WARNING_METERS = 250;
const WEATHER_CACHE_TTL_MS = 5 * 60 * 1000;
const WEATHER_CACHE_KEY = "airsense:weather:v2";
const HERO_WEATHER_CACHE_KEY = "airsense:hero-weather:v4";
const UNITS_STORAGE_KEY = "airsense:units";

/* Keep this in sync with backend/app/services.py. */
const CONDITION_BACKGROUNDS = {
  clear: "Clear_day.jpg",
  partly_cloudy: "Partly_cloudy_day.jpg",
  cloudy: "Overcast.jpg",
  overcast: "Overcast.jpg",
  fog: "Dense_fog.jpg",
  drizzle: "Drizzle.jpg",
  rain: "Moderate_rain.jpg",
  snow: "Moderate_snow.jpg",
  rain_showers: "Heavy_rain.jpg",
  snow_showers: "Snow_showers.jpg",
  thunderstorm: "Thunder_storm.jpg",
  unknown: DEFAULT_BACKGROUND,
};

const CONDITION_ILLUSTRATIONS = {
  clear: "sunny.png",
  partly_cloudy: "partly-cloudy.png",
  cloudy: "cloudy.png",
  overcast: "cloudy.png",
  fog: "fog.png",
  drizzle: "rain.png",
  rain: "rain.png",
  snow: "snow.png",
  rain_showers: "rain.png",
  snow_showers: "snow.png",
  thunderstorm: "storm.png",
  unknown: DEFAULT_ILLUSTRATION,
};

const backgroundRoot = document.querySelector("#weather-background");
const backgroundLayers = backgroundRoot
  ? Array.from(backgroundRoot.querySelectorAll("[data-weather-layer]"))
  : [];

let activeLayerIndex = 0;
let currentBackground = null;
let weatherBackgroundRevision = 0;
let backgroundUpdateToken = 0;
let refreshTimer = null;
let lastPosition = null;
const preloadedImages = new Map();

const currentWeatherCard = document.querySelector(".current-weather");
const currentLocationEl = document.querySelector("[data-current-location]");
const currentCountryEl = document.querySelector("[data-current-country]");
const currentDatetimeEl = document.querySelector("[data-current-datetime]");
const currentStatusEl = document.querySelector("[data-current-status]");
const currentTempEl = document.querySelector("[data-current-temp]");
const currentTempUnitEl = document.querySelector("[data-current-temp-unit]");
const currentFeelsEl = document.querySelector("[data-current-feels]");
const currentFeelsMetricEl = document.querySelector("[data-current-feels-metric]");
const currentConditionEl = document.querySelector("[data-current-condition]");
const currentHighEl = document.querySelector("[data-current-high]");
const currentLowEl = document.querySelector("[data-current-low]");
const currentHumidityEl = document.querySelector("[data-current-humidity]");
const currentWindEl = document.querySelector("[data-current-wind]");
const currentWindUnitEl = document.querySelector("[data-current-wind-unit]");
const currentWindDirEl = document.querySelector("[data-current-wind-dir]");
const currentVisibilityEl = document.querySelector("[data-current-visibility]");
const currentVisibilityUnitEl = document.querySelector("[data-current-visibility-unit]");
const currentIllustrationEl = document.querySelector("[data-current-illustration]");
const currentConditionIconEl = document.querySelector("[data-current-condition-icon]");
const uvIconEl = document.querySelector("[data-uv-icon]");
const uvLabelEl = document.querySelector("[data-uv-label]");
const uvValueEl = document.querySelector("[data-uv-value]");
const airQualityIndexEl = document.querySelector("[data-air-quality-index]");
const airQualityStatusEl = document.querySelector("[data-air-quality-status]");
const airQualityPm25El = document.querySelector("[data-air-quality-pm25]");
const airQualityPm10El = document.querySelector("[data-air-quality-pm10]");
const airQualityRecommendationEl = document.querySelector("[data-air-quality-recommendation]");
const airQualityProvidersEl = document.querySelector("[data-air-quality-providers]");
const airQualityScaleEl = document.querySelector("[data-air-quality-scale]");
const uvScaleMarkerEl = document.querySelector("[data-uv-scale-marker]");
const uvScaleValueEl = document.querySelector("[data-uv-scale-value]");
const aqiScaleMarkerEl = document.querySelector("[data-aqi-scale-marker]");
const aqiScaleValueEl = document.querySelector("[data-aqi-scale-value]");
const UV_SCALE_MAX = 11;
const AQI_SCALE_MAX = 500;
let airQualityRequestRevision = 0;
const feelsUnitEls = document.querySelectorAll("[data-feels-unit]");
const feelsMetricUnitEls = document.querySelectorAll("[data-feels-metric-unit]");
const rangeUnitHighEls = document.querySelectorAll("[data-range-unit-high]");
const rangeUnitLowEls = document.querySelectorAll("[data-range-unit-low]");
const currentStateText = document.querySelector("[data-current-state-text]");
const currentRetryBtn = document.querySelector("[data-current-retry]");
const hourlyCards = document.querySelectorAll(".hourly-cards .hour-card");
const hourlyCardsContainer = document.querySelector(".hourly-cards");
const weekCardsEl = document.querySelector("[data-week-cards]");
const weekMessageEl = document.querySelector("[data-week-message]");
const weekStatusEl = document.querySelector("[data-week-status]");

let currentHeroWeather = null;
let heroPosition = null;
let heroRefreshTimer = null;
let currentDatetimeTimer = null;
let temperatureUnit = "c"; // "c" or "f"

function isDaytimeAtTimestamp(timestamp, timezoneOffset) {
  if (!Number.isFinite(timestamp) || !Number.isFinite(timezoneOffset)) {
    return null;
  }
  const localSeconds =
    (((Math.floor(timestamp) + timezoneOffset) % 86400) + 86400) % 86400;
  const localHour = localSeconds / 3600;
  return localHour >= 6 && localHour < 18;
}

function isLocationDaytime(weather, nowMilliseconds = Date.now()) {
  const timezoneOffset = weather?.timezone_offset;
  return isDaytimeAtTimestamp(nowMilliseconds / 1000, timezoneOffset);
}

function uvRiskCategory(value) {
  if (value <= 2) return "Low";
  if (value <= 5) return "Moderate";
  if (value <= 7) return "High";
  if (value <= 10) return "Very High";
  return "Extreme";
}

function setMoonUvIcon() {
  if (!uvIconEl) return;
  uvIconEl.innerHTML =
    '<path d="M20 5.5a8.5 8.5 0 0 0-8.5 8.5A8.5 8.5 0 0 0 20 5.5Z"/>' +
    '<path d="M4 19c4.5-1.5 7.5-4.5 9-9"/>';
}

function setIndexScaleMarker(markerEl, valueEl, value, max, labelPrefix) {
  if (valueEl) {
    valueEl.textContent = Number.isFinite(value)
      ? `${labelPrefix}: ${Math.round(value)}`
      : `${labelPrefix}: --`;
  }
  if (!markerEl) return;
  if (!Number.isFinite(value) || max <= 0) {
    markerEl.hidden = true;
    return;
  }
  const percent = Math.max(0, Math.min(value, max)) / max * 100;
  markerEl.style.left = `${percent}%`;
  markerEl.hidden = false;
}

function renderUvScale(weather) {
  const uv = weather?.uv_index;
  setIndexScaleMarker(
    uvScaleMarkerEl,
    uvScaleValueEl,
    typeof uv === "number" && Number.isFinite(uv) ? uv : null,
    UV_SCALE_MAX,
    "Current UV"
  );
}

function renderAqiScale(aqi) {
  setIndexScaleMarker(
    aqiScaleMarkerEl,
    aqiScaleValueEl,
    Number.isFinite(aqi) ? aqi : null,
    AQI_SCALE_MAX,
    "Current AQI"
  );
}

function renderUvIndex(weather) {
  renderUvScale(weather);
  if (!uvLabelEl || !uvValueEl) return;
  const daytime = isLocationDaytime(weather);
  if (daytime === false) {
    uvLabelEl.textContent = "Nighttime";
    uvValueEl.textContent = "UV Index unavailable";
    setMoonUvIcon();
    return;
  }

  if (
    daytime !== true ||
    typeof weather?.uv_index !== "number" ||
    !Number.isFinite(weather.uv_index)
  ) {
    uvLabelEl.textContent = "UV Index";
    uvValueEl.textContent = "UV Index unavailable";
    return;
  }
  const uv = weather.uv_index;
  uvLabelEl.textContent = "UV Index";
  uvValueEl.textContent = `${uv} · ${uvRiskCategory(uv)}`;
}

function classifyAirQuality(aqi) {
  if (!Number.isFinite(aqi) || aqi < 0) return null;
  if (aqi <= 50) {
    return {
      key: "good",
      category: "Good",
      recommendation: "Air is clean. Enjoy outdoor activities.",
    };
  }
  if (aqi <= 100) {
    return {
      key: "moderate",
      category: "Moderate",
      recommendation: "Most people can enjoy outdoor activities. Sensitive individuals should take care.",
    };
  }
  if (aqi <= 150) {
    return {
      key: "sensitive",
      category: "Unhealthy for Sensitive Groups",
      recommendation: "Sensitive individuals should limit prolonged outdoor exertion.",
    };
  }
  if (aqi <= 200) {
    return {
      key: "unhealthy",
      category: "Unhealthy",
      recommendation: "Limit outdoor activities. Consider an N95 mask outdoors.",
    };
  }
  if (aqi <= 300) {
    return {
      key: "very-unhealthy",
      category: "Very Unhealthy",
      recommendation: "Avoid outdoor exertion. Use an N95 mask if going outside.",
    };
  }
  return {
    key: "hazardous",
    category: "Hazardous",
    recommendation: "Avoid outdoor exposure. Stay indoors.",
  };
}

function renderAirQualityStatus(aqi) {
  if (!airQualityStatusEl || !airQualityRecommendationEl) return;
  const classification = classifyAirQuality(aqi);
  if (!classification) {
    airQualityStatusEl.textContent = "Unavailable";
    airQualityStatusEl.removeAttribute("data-aqi-level");
    airQualityRecommendationEl.textContent = "";
    airQualityRecommendationEl.hidden = true;
    return;
  }

  airQualityStatusEl.textContent = classification.category;
  airQualityStatusEl.dataset.aqiLevel = classification.key;
  airQualityRecommendationEl.textContent = classification.recommendation;
  airQualityRecommendationEl.hidden = false;
}

function renderAirQualityProviderStatus(text, tooltip = "") {
  if (!airQualityProvidersEl) return;
  if (!text) {
    airQualityProvidersEl.textContent = "";
    airQualityProvidersEl.title = "";
    airQualityProvidersEl.hidden = true;
    return;
  }
  airQualityProvidersEl.textContent = text;
  airQualityProvidersEl.title = tooltip || text;
  airQualityProvidersEl.hidden = false;
}

async function updateUvIndexFromOpenMeteo(latitude, longitude) {
  try {
    const lat = Number(latitude);
    const lon = Number(longitude);
    const url = new URL("https://api.open-meteo.com/v1/forecast");
    url.searchParams.set("latitude", String(lat));
    url.searchParams.set("longitude", String(lon));
    url.searchParams.set("current", "uv_index");
    url.searchParams.set("timezone", "auto");

    const response = await fetch(url, { headers: { Accept: "application/json" } });
    if (!response.ok) throw new Error(`UV request failed (${response.status})`);
    const payload = await response.json();
    const uv = payload?.current?.uv_index;
    if (!Number.isFinite(uv)) throw new Error("UV is unavailable");
    if (currentHeroWeather) {
      currentHeroWeather.uv_index = uv;
      renderUvIndex(currentHeroWeather);
      renderUvScale(currentHeroWeather);
    } else if (uvLabelEl && uvValueEl) {
      uvLabelEl.textContent = "UV Index";
      uvValueEl.textContent = `${uv} · ${uvRiskCategory(uv)}`;
      renderUvScale({ uv_index: uv });
    }
    return uv;
  } catch (error) {
    console.warn("UV index unavailable:", error.message);
    return null;
  }
}

function updateCurrentConditionDisplay(weather) {
  if (!weather) {
    return;
  }

  const resolved = resolveCurrentCondition(weather);
  const isClear = resolved.key === "sunny" || resolved.key === "clear-night";

  if (currentConditionEl) {
    currentConditionEl.textContent = isClear
      ? resolved.label
      : typeof weather.description === "string" && weather.description.trim()
        ? weather.description.trim()
        : typeof weather.condition === "string"
          ? weather.condition.replace(/_/g, " ")
          : "--";
  }

  updateConditionIcon(resolved);

  if (currentStatusEl) {
    const isDay = isLocationDaytime(weather);
    currentStatusEl.textContent =
      isDay === false || (isDay === null && weather.is_day === false)
        ? "Night"
        : "Live";
    currentStatusEl.removeAttribute("title");
  }

  if (currentIllustrationEl) {
    const illustration = resolveIllustration(weather);
    const url = `${WEATHER_ILLUSTRATION_ROOT}${illustration}`;
    currentIllustrationEl.alt =
      currentConditionEl?.textContent || "Current weather illustration";
    currentIllustrationEl.onerror = () => {
      currentIllustrationEl.onerror = null;
      currentIllustrationEl.src = `${WEATHER_ILLUSTRATION_ROOT}cloudy.png`;
    };
    try {
      const fullUrl = new URL(url, window.location.href).href;
      if (currentIllustrationEl.src !== fullUrl) {
        loadIllustrationImage(illustration).catch(() => {});
        currentIllustrationEl.src = url;
      }
    } catch {
      currentIllustrationEl.src = url;
    }
  }
}

async function updateAirQualityIndex(latitude, longitude) {
  if (!airQualityIndexEl || !airQualityStatusEl) return;
  const requestRevision = ++airQualityRequestRevision;
  renderAirQualityStatus(null);
  renderAqiScale(null);
  renderAirQualityProviderStatus(null);
  if (airQualityIndexEl) airQualityIndexEl.textContent = "--";
  if (airQualityPm25El) airQualityPm25El.textContent = "-- μg/m³";
  if (airQualityPm10El) airQualityPm10El.textContent = "-- μg/m³";
  const url = new URL(`${API_BASE_URL}/weather/air-quality`, window.location.href);
  url.searchParams.set("latitude", String(Number(latitude)));
  url.searchParams.set("longitude", String(Number(longitude)));

  try {
    const response = await fetch(url, { headers: { Accept: "application/json" } });
    if (!response.ok) throw new Error(`Air-quality request failed (${response.status})`);
    const payload = await response.json();
    if (requestRevision !== airQualityRequestRevision) return;
    const modelled = payload?.modelled;
    const aqi = modelled?.aqi?.value;
    if (!Number.isFinite(aqi)) throw new Error("Modelled AQI is unavailable");
    airQualityIndexEl.textContent = String(Math.round(aqi));
    renderAirQualityStatus(aqi);
    renderAqiScale(aqi);
    if (airQualityScaleEl) airQualityScaleEl.textContent = `${modelled.provider || "Open-Meteo/CAMS"} · ${modelled.aqi.scale || "US AQI"}`;
    const modelTimestamp = modelled.timestamp
      ? `${modelled.timestamp}${modelled.timezone ? ` ${modelled.timezone}` : ""}`
      : "time unavailable";
    const classification = classifyAirQuality(aqi);
    if (airQualityStatusEl) {
      airQualityStatusEl.textContent = `${classification?.category || "Unavailable"} · Modelled`;
      airQualityStatusEl.title = `${modelled.aqi.scale || "US AQI"}; as of ${modelTimestamp}`;
    }
    if (airQualityPm25El) {
      const pollutant = modelled.pollutants?.["PM2.5"];
      airQualityPm25El.textContent = Number.isFinite(pollutant?.value)
        ? `${pollutant.value} ${pollutant.unit || "μg/m³"}`
        : "-- μg/m³";
    }
    if (airQualityPm10El) {
      const pollutant = modelled.pollutants?.PM10;
      airQualityPm10El.textContent = Number.isFinite(pollutant?.value)
        ? `${pollutant.value} ${pollutant.unit || "μg/m³"}`
        : "-- μg/m³";
    }
    const stationRows = [];
    const waqi = payload?.stations?.waqi;
    if (waqi?.status === "available") {
      stationRows.push(`WAQI ${waqi.station || "station"}: ${waqi.aqi.value} ${waqi.aqi.scale}`);
    } else {
      stationRows.push(`WAQI ${waqi?.status === "not_configured" ? "token not configured" : "unavailable"}`);
    }
    const openaq = payload?.stations?.openaq;
    const nearestStation = openaq?.stations?.[0];
    if (nearestStation) {
      const measured = (nearestStation.measurements || []).filter((item) => {
        const parameter = String(item.parameter || "").toLowerCase().replace(/[._\s]/g, "");
        return parameter === "pm25" || parameter === "pm10";
      });
      const values = measured.map((item) => `${item.parameter} ${item.value} ${item.unit || ""}`.trim());
      stationRows.push(values.length
        ? `OpenAQ ${nearestStation.station || "station"}${Number.isFinite(nearestStation.distance_m) ? ` ${nearestStation.distance_m} m` : ""}: ${values.join(", ")}`
        : `OpenAQ ${nearestStation.station || "station"}: no PM measurements`);
    } else {
      stationRows.push(`OpenAQ ${openaq?.status === "not_configured" ? "API key not configured" : "no nearby data"}`);
    }
    const stationTimestamps = [waqi?.timestamp, ...(nearestStation?.measurements || []).map((item) => item.timestamp)]
      .filter(Boolean);
    const sourceAttributions = (waqi?.attributions || []).map((source) => source.name).filter(Boolean);
    sourceAttributions.push(...(nearestStation?.attributions || []).map((source) => source.name).filter(Boolean));
    if (currentHeroWeather) currentHeroWeather.air_quality = payload;
  } catch (error) {
    if (requestRevision !== airQualityRequestRevision) return;
    console.warn("Air quality unavailable:", error.message);
    airQualityIndexEl.textContent = "--";
    renderAirQualityStatus(null);
    renderAqiScale(null);
    if (airQualityPm25El) airQualityPm25El.textContent = "-- μg/m³";
    if (airQualityPm10El) airQualityPm10El.textContent = "-- μg/m³";
    if (airQualityScaleEl) airQualityScaleEl.textContent = "US AQI · Open-Meteo/CAMS";
    // Keep the health recommendation slot empty when nothing can be computed.
    if (airQualityRecommendationEl) {
      airQualityRecommendationEl.textContent = "";
      airQualityRecommendationEl.hidden = true;
    }
  }
}

function loadTemperatureUnitPreference() {
  try {
    const stored = localStorage.getItem(UNITS_STORAGE_KEY);
    if (stored === "f" || stored === "c") {
      temperatureUnit = stored;
    }
  } catch {
    // Ignore storage errors.
  }
}

function saveTemperatureUnitPreference() {
  try {
    localStorage.setItem(UNITS_STORAGE_KEY, temperatureUnit);
  } catch {
    // Ignore storage errors.
  }
}

function celsiusToFahrenheit(value) {
  if (typeof value !== "number" || Number.isNaN(value)) {
    return null;
  }
  return (value * 9) / 5 + 32;
}

function formatTemperature(value) {
  if (typeof value !== "number" || Number.isNaN(value)) {
    return "--";
  }
  const converted = temperatureUnit === "f" ? celsiusToFahrenheit(value) : value;
  const rounded = Math.round(converted);
  return String(rounded);
}

function updateTemperatureDisplay(element) {
  const rawValue = element.dataset.temperatureCelsius;
  const value = rawValue === "" ? null : Number(rawValue);
  element.textContent =
    `${formatTemperature(value)}${element.dataset.temperatureSuffix || ""}`;
}

function setTemperatureDisplay(element, value, suffix = "") {
  if (!element) {
    return;
  }
  element.dataset.temperatureCelsius = Number.isFinite(value) ? String(value) : "";
  element.dataset.temperatureSuffix = suffix;
  updateTemperatureDisplay(element);
}

function updateTemperatureDisplays() {
  document.querySelectorAll("[data-temperature-celsius]").forEach((element) => {
    updateTemperatureDisplay(element);
  });
}

function getTemperatureUnitSymbol() {
  return temperatureUnit === "f" ? "F" : "C";
}

function updateTemperatureUnitUI() {
  const symbol = getTemperatureUnitSymbol();
  if (currentTempUnitEl) {
    currentTempUnitEl.textContent = `°${symbol}`;
  }
  if (feelsUnitEls.length) {
    feelsUnitEls.forEach((el) => {
      el.textContent = symbol;
    });
  }
  if (feelsMetricUnitEls.length) {
    feelsMetricUnitEls.forEach((el) => {
      el.textContent = symbol;
    });
  }
  if (rangeUnitHighEls.length) {
    rangeUnitHighEls.forEach((el) => {
      el.textContent = symbol;
    });
  }
  if (rangeUnitLowEls.length) {
    rangeUnitLowEls.forEach((el) => {
      el.textContent = symbol;
    });
  }
}

function normaliseBackgroundName(name) {
  const filename = String(name || "")
    .trim()
    .replace(/^.*[\\/]/, "");

  return filename || DEFAULT_BACKGROUND;
}

function normaliseIllustrationName(name) {
  const filename = String(name || "")
    .trim()
    .replace(/^.*[\\/]/, "");

  return filename || DEFAULT_ILLUSTRATION;
}

function resolveBackground(weather) {
  return null;
}

function resolveIllustration(weather) {
  if (!weather || typeof weather !== "object") {
    return DEFAULT_ILLUSTRATION;
  }

  const isDay = resolveIsDaytime(weather);
  const condition =
    typeof weather.condition === "string" ? weather.condition : "unknown";

  if (condition === "clear") {
    return isDay ? "sunny.png" : "night.png";
  }

  if (typeof weather.illustration === "string" && weather.illustration.trim()) {
    return normaliseIllustrationName(weather.illustration);
  }

  return CONDITION_ILLUSTRATIONS[condition] || DEFAULT_ILLUSTRATION;
}

/* Central forecast/current mapping: one key owns both label and icon. */
const FORECAST_CONDITION_META = {
  sunny: { label: "Sunny", icon: "sunny.svg" },
  "clear-night": { label: "Clear", icon: "clear-night.svg" },
  "partly-cloudy": { label: "Partly Cloudy", icon: "partly-cloudy.svg" },
  "partly-cloudy-night": { label: "Partly Cloudy", icon: "partly-cloudy-night.svg" },
  cloudy: { label: "Cloudy", icon: "cloudy.svg" },
  overcast: { label: "Overcast", icon: "overcast.svg" },
  fog: { label: "Fog", icon: "fog.svg" },
  drizzle: { label: "Drizzle", icon: "drizzle.svg" },
  rain: { label: "Rain", icon: "rain.svg" },
  "heavy-rain": { label: "Heavy Rain", icon: "heavy-rain.svg" },
  thunderstorm: { label: "Thunderstorm", icon: "thunderstorm.svg" },
  snow: { label: "Snow", icon: "snow.svg" },
  sleet: { label: "Sleet", icon: "sleet.svg" },
  windy: { label: "Windy", icon: "windy.svg" },
  default: { label: "Weather unavailable", icon: DEFAULT_CONDITION_ICON },
};

function forecastPointCode(point) {
  if (!point || typeof point !== "object") {
    return NaN;
  }
  const raw = point.weather_code ?? point.condition_code ?? point.weathercode;
  return typeof raw === "number" || typeof raw === "string" ? Number(raw) : NaN;
}

/**
 * Day/night for THIS forecast item only.
 * Uses the item's local timestamp first, with API day/night metadata as fallback.
 * Never borrows current-weather is_day/icon.
 * Moon is applied later only for clear-sky codes — not for every night hour.
 */
function resolveForecastIsDaytime(point, weather = null) {
  const source = point && typeof point === "object" ? point : {};
  const timestamp = Number(source.timestamp ?? source.observed_at);
  const context = weather && typeof weather === "object" ? weather : {};
  const timezoneOffset =
    typeof context.timezone_offset === "number" &&
    Number.isFinite(context.timezone_offset)
      ? context.timezone_offset
      : NaN;

  const daytimeAtTimestamp = isDaytimeAtTimestamp(timestamp, timezoneOffset);
  if (daytimeAtTimestamp !== null) {
    return daytimeAtTimestamp;
  }

  if (source.is_day === true) {
    return true;
  }
  if (source.is_day === false) {
    return false;
  }

  if (typeof source.icon === "string") {
    if (/[dn]$/i.test(source.icon)) {
      return source.icon.toLowerCase().endsWith("d");
    }
  }

  const sunrise = Number(context.sunrise);
  const sunset = Number(context.sunset);

  if (
    Number.isFinite(timestamp) &&
    Number.isFinite(sunrise) &&
    Number.isFinite(sunset)
  ) {
    const pointTod = ((timestamp % 86400) + 86400) % 86400;
    const sunriseTod = ((sunrise % 86400) + 86400) % 86400;
    const sunsetTod = ((sunset % 86400) + 86400) % 86400;
    if (sunsetTod > sunriseTod) {
      return pointTod >= sunriseTod && pointTod < sunsetTod;
    }
    return pointTod >= sunriseTod || pointTod < sunsetTod;
  }

  return true;
}

/**
 * Map a numeric API condition code → condition key.
 * Supports OpenWeather IDs (200–804) and WMO codes (0–99).
 * Day/night variants exist only for clear sky.
 */
function conditionKeyFromWeatherCode(code, isDay = true) {
  if (!Number.isFinite(code)) {
    return null;
  }

  // WMO Weather interpretation codes (e.g. Open-Meteo weathercode).
  if (code >= 0 && code <= 99) {
    if (code === 0) {
      return isDay ? "sunny" : "clear-night";
    }
    if (code === 1 || code === 2) {
      return isDay ? "partly-cloudy" : "partly-cloudy-night";
    }
    if (code === 3) {
      return "overcast";
    }
    if (code === 45 || code === 48) {
      return "fog";
    }
    if (code >= 51 && code <= 57) {
      return "drizzle";
    }
    if (code === 66 || code === 67) {
      return "sleet";
    }
    if (code >= 61 && code <= 65) {
      return code >= 65 ? "heavy-rain" : "rain";
    }
    if (code >= 71 && code <= 77) {
      return "snow";
    }
    if (code >= 80 && code <= 82) {
      return code === 82 ? "heavy-rain" : "rain";
    }
    if (code === 85 || code === 86) {
      return "snow";
    }
    if (code >= 95 && code <= 99) {
      return "thunderstorm";
    }
    return null;
  }

  // OpenWeather condition IDs.
  if (code >= 200 && code <= 232) {
    return "thunderstorm";
  }
  if (code >= 300 && code <= 321) {
    return "drizzle";
  }
  if (
    code === 511 ||
    code === 611 ||
    code === 612 ||
    code === 613 ||
    code === 615 ||
    code === 616
  ) {
    return "sleet";
  }
  if (code === 502 || code === 503 || code === 504 || code === 522) {
    return "heavy-rain";
  }
  if (code >= 500 && code <= 531) {
    return "rain";
  }
  if (code >= 600 && code <= 622) {
    return "snow";
  }
  if (code === 771 || code === 781) {
    return "windy";
  }
  if (code >= 700 && code <= 781) {
    return "fog";
  }
  if (code === 800) {
    return isDay ? "sunny" : "clear-night";
  }
  if (code === 801 || code === 802) {
    return isDay ? "partly-cloudy" : "partly-cloudy-night";
  }
  if (code === 803) {
    return "cloudy";
  }
  if (code === 804) {
    return "overcast";
  }

  return null;
}

/** Fallback when a numeric weather code is absent — API condition group only. */
function conditionKeyFromConditionGroup(condition, isDay = true) {
  switch (String(condition || "").toLowerCase()) {
    case "clear":
      return isDay ? "sunny" : "clear-night";
    case "partly_cloudy":
    case "partly-cloudy":
      return isDay ? "partly-cloudy" : "partly-cloudy-night";
    case "cloudy":
      return "cloudy";
    case "overcast":
      return "overcast";
    case "fog":
      return "fog";
    case "drizzle":
      return "drizzle";
    case "rain":
    case "rain_showers":
      return "rain";
    case "heavy_rain":
    case "heavy-rain":
      return "heavy-rain";
    case "thunderstorm":
      return "thunderstorm";
    case "snow":
    case "snow_showers":
      return "snow";
    case "sleet":
      return "sleet";
    case "windy":
      return "windy";
    default:
      return null;
  }
}

function resolveForecastConditionKey(point, { isDay = true } = {}) {
  if (!point || typeof point !== "object") {
    return "default";
  }

  const fromCode = conditionKeyFromWeatherCode(forecastPointCode(point), isDay);
  if (fromCode) {
    return fromCode;
  }

  const fromGroup = conditionKeyFromConditionGroup(point.condition, isDay);
  if (fromGroup) {
    return fromGroup;
  }

  return "default";
}

function resolveForecastCondition(point, context = {}) {
  const weatherContext = context.weather ?? null;
  const isDay =
    typeof context.isDay === "boolean"
      ? context.isDay
      : resolveForecastIsDaytime(point, weatherContext);
  const key = resolveForecastConditionKey(point, { isDay });
  const meta = FORECAST_CONDITION_META[key] || FORECAST_CONDITION_META.default;
  return {
    key,
    label: meta.label,
    icon: meta.icon,
  };
}

function resolveIsDaytime(weather) {
  return isLocationDaytime(weather) ?? resolveForecastIsDaytime(weather, weather);
}

function resolveCurrentCondition(weather) {
  if (!weather || typeof weather !== "object") {
    return FORECAST_CONDITION_META.default;
  }

  const point = {
    weather_code: weather.condition_code,
    condition_code: weather.condition_code,
    condition: weather.condition,
    is_day: weather.is_day,
    icon: weather.icon,
    timestamp: weather.observed_at,
    observed_at: weather.observed_at,
  };
  const isDay =
    isLocationDaytime(weather) ??
    resolveForecastIsDaytime(point, weather);
  return resolveForecastCondition(point, {
    weather,
    isDay,
  });
}

function updateConditionIcon(resolved) {
  if (!currentConditionIconEl) {
    return;
  }

  const filename = resolved.icon || DEFAULT_CONDITION_ICON;
  const url = `${WEATHER_ICON_ROOT}${filename}`;
  currentConditionIconEl.alt = resolved.label || "Current weather";
  currentConditionIconEl.onerror = () => {
    currentConditionIconEl.onerror = null;
    currentConditionIconEl.src = `${WEATHER_ICON_ROOT}${DEFAULT_CONDITION_ICON}`;
  };

  try {
    const fullUrl = new URL(url, window.location.href).href;
    if (currentConditionIconEl.src !== fullUrl) {
      currentConditionIconEl.src = url;
    }
  } catch {
    currentConditionIconEl.src = url;
  }
}

function loadBackgroundImage(filename) {
  const url = `${WEATHER_ASSET_ROOT}${filename}`;

  if (!preloadedImages.has(url)) {
    preloadedImages.set(
      url,
      new Promise((resolve, reject) => {
        const image = new Image();
        image.onload = () => resolve(url);
        image.onerror = () =>
          reject(new Error(`Missing weather background asset: ${filename}`));
        image.src = url;
      }),
    );
  }

  return preloadedImages.get(url);
}

function loadIllustrationImage(filename) {
  const url = `${WEATHER_ILLUSTRATION_ROOT}${filename}`;

  if (!preloadedImages.has(url)) {
    preloadedImages.set(
      url,
      new Promise((resolve, reject) => {
        const image = new Image();
        image.onload = () => resolve(url);
        image.onerror = () =>
          reject(new Error(`Missing weather illustration asset: ${filename}`));
        image.src = url;
      }),
    );
  }

  return preloadedImages.get(url);
}

function applyFallbackBackground() {
  backgroundUpdateToken += 1;
  currentBackground = null;

  if (!backgroundRoot) {
    return;
  }

  backgroundRoot.classList.add("is-fallback");
  backgroundLayers.forEach((layer) => layer.classList.remove("is-active"));
}

async function applyWeatherBackground(filename) {
  if (!backgroundRoot || backgroundLayers.length < 2) {
    return;
  }

  const safeName = normaliseBackgroundName(filename);

  // Temperature or other data may change without changing the visual
  // category. Do not reload the same image in that case.
  if (safeName === currentBackground) {
    return;
  }

  const token = ++backgroundUpdateToken;

  try {
    const url = await loadBackgroundImage(safeName);

    // A newer update or a fallback may have happened while this image loaded.
    if (token !== backgroundUpdateToken) {
      return;
    }

    const nextLayerIndex = activeLayerIndex === 0 ? 1 : 0;
    const nextLayer = backgroundLayers[nextLayerIndex];
    const currentLayer = backgroundLayers[activeLayerIndex];

    nextLayer.style.backgroundImage = `url("${url}")`;

    // Force a style flush so the opacity transition runs.
    void nextLayer.offsetWidth;

    nextLayer.classList.add("is-active");
    currentLayer.classList.remove("is-active");

    activeLayerIndex = nextLayerIndex;
    currentBackground = safeName;
    backgroundRoot.classList.remove("is-fallback");
  } catch (error) {
    console.warn(error.message);
    applyFallbackBackground();
  }
}

function setHeroLoading(isLoading) {
  if (!currentWeatherCard) {
    return;
  }
  currentWeatherCard.classList.toggle("is-loading", isLoading);
  if (isLoading) {
    renderHourlyForecast(null);
    currentWeatherCard.classList.remove("is-error");
    if (currentStateText) {
      currentStateText.textContent = "Fetching weather...";
    }
    if (currentRetryBtn) {
      currentRetryBtn.hidden = true;
    }
  }
}

function setHeroError(message) {
  if (!currentWeatherCard) {
    return;
  }
  currentWeatherCard.classList.remove("is-loading");
  currentWeatherCard.classList.add("is-error");
  if (currentStateText) {
    currentStateText.textContent =
      message || "Unable to load weather data. Please try again.";
  }
  if (currentRetryBtn) {
    currentRetryBtn.hidden = false;
  }
  renderHourlyForecast(null);
}

function clearHeroState() {
  if (!currentWeatherCard) {
    return;
  }
  currentWeatherCard.classList.remove("is-loading");
  currentWeatherCard.classList.remove("is-error");
  if (currentStateText) {
    currentStateText.textContent = "Weather updated";
  }
  if (currentRetryBtn) {
    currentRetryBtn.hidden = true;
  }
}

function formatDateTime(isoString, timezone, timezoneOffset) {
  try {
    const date = isoString ? new Date(isoString) : new Date();
    if (typeof timezone === "string" && timezone.trim()) {
      return date.toLocaleString("en-US", {
        weekday: "long",
        month: "long",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
        hour12: true,
        timeZone: timezone,
      });
    }
    if (typeof timezoneOffset === "number" && Number.isFinite(timezoneOffset)) {
      const utcTime = date.getTime() + date.getTimezoneOffset() * 60000;
      const targetTime = new Date(utcTime + timezoneOffset * 1000);
      return targetTime.toLocaleString("en-US", {
        weekday: "long",
        month: "long",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
        hour12: true,
      });
    }
    return date.toLocaleString("en-US", {
      weekday: "long",
      month: "long",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
    });
  } catch {
    return new Date().toLocaleString("en-US");
  }
}

function updateCurrentDatetime() {
  if (currentDatetimeEl) {
    currentDatetimeEl.textContent = formatDateTime(
      null,
      currentHeroWeather?.timezone,
      currentHeroWeather?.timezone_offset,
    );
  }
}

function formatLocation(weather) {
  if (typeof weather?.location_name === "string" && weather.location_name.trim()) {
    return weather.location_name.trim();
  }
  if (typeof weather?.location_label === "string" && weather.location_label.trim()) {
    return weather.location_label.trim();
  }
  return "Current Location";
}

function formatWindDirection(degrees, cardinal) {
  if (typeof cardinal === "string" && cardinal.trim()) {
    return cardinal.trim();
  }
  if (typeof degrees !== "number" || Number.isNaN(degrees)) {
    return "";
  }
  const dirs = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"];
  const index = Math.round(degrees / 22.5) % 16;
  return dirs[index];
}

function formatVisibility(meters) {
  if (typeof meters !== "number" || Number.isNaN(meters)) {
    return { value: "--", unit: "km" };
  }
  if (meters >= 1000) {
    return { value: (meters / 1000).toFixed(1), unit: "km" };
  }
  return { value: Math.round(meters).toString(), unit: "m" };
}

function formatForecastHour(time, timestamp, timezoneOffset = 0) {
  if (Number.isFinite(timestamp)) {
    const localDate = new Date((timestamp + timezoneOffset) * 1000);
    const hours = localDate.getUTCHours();
    const minutes = String(localDate.getUTCMinutes()).padStart(2, "0");
    const suffix = hours >= 12 ? "PM" : "AM";
    return `${hours % 12 || 12}:${minutes} ${suffix}`;
  }
  const match =
    typeof time === "string" ? time.match(/[T ](\d{2}):(\d{2})/) : null;
  if (!match) {
    return "--";
  }
  const hour = Number(match[1]);
  const suffix = hour >= 12 ? "PM" : "AM";
  const displayHour = hour % 12 || 12;
  return `${displayHour} ${suffix}`;
}

function forecastConditionClass(code) {
  const key = conditionKeyFromWeatherCode(Number(code), true);
  if (key === "sunny" || key === "clear-night") {
    return "clear";
  }
  if (key === "partly-cloudy" || key === "partly-cloudy-night") {
    return "partly-cloudy";
  }
  if (key === "thunderstorm") {
    return "storm";
  }
  if (key === "drizzle" || key === "rain" || key === "heavy-rain" || key === "sleet") {
    return "rain";
  }
  if (key === "snow") {
    return "snow";
  }
  if (key === "fog") {
    return "fog";
  }
  return "cloudy";
}

function forecastConditionLabel(point, context = {}) {
  return resolveForecastCondition(point, context).label;
}

function forecastIconMarkup(code) {
  const conditionClass = forecastConditionClass(code);
  if (conditionClass === "clear") {
    return '<circle class="sun" cx="40" cy="28" r="13"></circle><g class="sun-rays"><path d="M40 6v8M40 42v8M18 28h8M54 28h8M24 12l6 6M50 38l6 6M56 12l-6 6M30 38l-6 6"></path></g>';
  }
  const cloud = '<path class="cloud" d="M18 42C5 42 4 26 16 20C18 8 37 6 43 20C58 12 73 25 69 38C67 44 62 46 55 46H18Z"></path>';
  if (conditionClass === "partly-cloudy") {
    return '<circle class="sun" cx="27" cy="20" r="11"></circle>' + cloud;
  }
  if (conditionClass === "rain") {
    return cloud + '<path class="rain-drop" d="M24 50l-5 9M40 50l-5 9M56 50l-5 9"></path>';
  }
  if (conditionClass === "snow") {
    return cloud + '<g class="snow-flake"><circle cx="24" cy="55" r="2"></circle><circle cx="40" cy="55" r="2"></circle><circle cx="56" cy="55" r="2"></circle></g>';
  }
  if (conditionClass === "storm") {
    return cloud + '<path class="lightning" d="M42 47l-8 10h7l-4 9 11-13h-7z"></path>';
  }
  return cloud;
}

function createForecastIcon(code, extraClass = "") {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 80 64");
  svg.setAttribute("focusable", "false");
  svg.setAttribute("class", `weather-icon ${forecastConditionClass(code)} ${extraClass}`.trim());
  svg.innerHTML = forecastIconMarkup(code);
  return svg;
}

function setForecastConditionIcon(iconEl, resolved, className = "weather-icon") {
  if (!iconEl) {
    return;
  }

  const meta =
    resolved && typeof resolved === "object"
      ? resolved
      : FORECAST_CONDITION_META.default;
  const filename = meta.icon || DEFAULT_CONDITION_ICON;
  const label = meta.label || FORECAST_CONDITION_META.default.label;
  const url = `${WEATHER_ICON_ROOT}${filename}`;

  iconEl.hidden = false;
  iconEl.className = className;
  if ("alt" in iconEl) {
    iconEl.alt = label;
  }
  iconEl.dataset.conditionKey = meta.key || "";
  iconEl.dataset.conditionIcon = filename;
  iconEl.onerror = () => {
    iconEl.onerror = null;
    iconEl.src = `${WEATHER_ICON_ROOT}${DEFAULT_CONDITION_ICON}`;
  };

  try {
    const fullUrl = new URL(url, window.location.href).href;
    if (iconEl.src !== fullUrl) {
      iconEl.src = url;
    }
  } catch {
    iconEl.src = url;
  }
}

function renderHourlyForecast(weather) {
  if (!hourlyCards.length) {
    return;
  }

  const availableForecast = Array.isArray(weather?.hourly)
    ? weather.hourly
      .filter((point) => point && typeof point.time === "string" &&
        (!Number.isFinite(point.timestamp) || point.timestamp <= Math.floor(Date.now() / 1000) + 24 * 3600))
    : [];
  if (hourlyCardsContainer) {
    hourlyCardsContainer.setAttribute("aria-busy", "false");
  }
  const startIndex =
    Number.isFinite(weather?.observed_at) &&
    availableForecast.some((point) => Number.isFinite(point.timestamp))
      ? availableForecast.findIndex(
          (point) => Number(point.timestamp) >= Math.floor(Date.now() / 1000),
        )
      : 0;
  const forecast = availableForecast.slice(
    startIndex >= 0 ? startIndex : 0,
    (startIndex >= 0 ? startIndex : 0) + hourlyCards.length,
  );

  hourlyCards.forEach((card, index) => {
    const point = forecast[index];
    if (!point) {
      card.hidden = true;
      return;
    }

    card.hidden = false;
    card.classList.toggle("active", index === 0);
    const hourEl = card.querySelector(".hour");
    const iconEl = card.querySelector(".weather-icon");
    const temperatureEl = card.querySelector("h3");
    const probabilityEl = card.querySelector(".humidity");
    const resolved = resolveForecastCondition(point, {
      weather,
      isDay: resolveForecastIsDaytime(point, weather),
    });

    if (hourEl) {
      hourEl.textContent = formatForecastHour(
        point.time,
        point.timestamp,
        Number(weather.timezone_offset) || 0,
      );
    }
    if (temperatureEl) {
      setTemperatureDisplay(temperatureEl, point.temperature, "°");
    }
    if (probabilityEl) {
      probabilityEl.textContent = resolved.label;
      probabilityEl.setAttribute(
        "aria-label",
        Number.isFinite(point.precipitation_probability)
          ? `Chance of rain: ${point.precipitation_probability}%`
          : "Chance of rain unavailable",
      );
    }
    // Label + icon come from the same resolved mapping for this hour's weather_code.
    setForecastConditionIcon(iconEl, resolved);
  });
}

function forecastPointLocalHour(point, timezoneOffset) {
  const timestamp = Number(point?.timestamp);
  if (!Number.isFinite(timestamp)) {
    return null;
  }
  return ((((timestamp + timezoneOffset) % 86400) + 86400) % 86400) / 3600;
}

function forecastPointIsDaytime(point, weather) {
  return resolveForecastIsDaytime(point, weather);
}

function pickDailyRepresentative(points, weather, timezoneOffset) {
  if (!points.length) {
    return null;
  }

  let best = points[0];
  let bestScore = Number.POSITIVE_INFINITY;

  points.forEach((point) => {
    const localHour = forecastPointLocalHour(point, timezoneOffset);
    const noonDistance =
      localHour === null ? 12 : Math.abs(localHour - 12);
    const isDay = forecastPointIsDaytime(point, weather);
    // Prefer daytime API slots near local noon so daily icons match daytime conditions.
    const score = (isDay ? 0 : 100) + noonDistance;
    if (score < bestScore) {
      best = point;
      bestScore = score;
    }
  });

  return best;
}

function aggregateDailyForecast(weather) {
  const timezoneOffset = Number(weather?.timezone_offset) || 0;
  const today = new Date(Date.now() + timezoneOffset * 1000);
  today.setUTCHours(12, 0, 0, 0);
  const dateKeys = Array.from({ length: 7 }, (_, index) => {
    const date = new Date(today);
    date.setUTCDate(date.getUTCDate() + index);
    return date.toISOString().slice(0, 10);
  });

  if (Array.isArray(weather?.daily) && weather.daily.length) {
    const dailyByDate = new Map(weather.daily.map((day) => [day.date, day]));
    return dateKeys.map((dateKey) => {
      const day = dailyByDate.get(dateKey);
      if (!day) return { dateKey, unavailable: true };
      return {
        dateKey,
        high: day.temperature_max,
        low: day.temperature_min,
        precipitation: day.precipitation_probability,
        representative: { weather_code: day.weather_code, condition: day.condition, time: `${day.date}T12:00`, timestamp: Date.parse(`${day.date}T12:00:00Z`) / 1000 },
      };
    });
  }

  const points = Array.isArray(weather?.hourly) ? weather.hourly : [];
  const days = new Map();

  points.forEach((point) => {
    if (!Number.isFinite(point?.timestamp) || !Number.isFinite(point?.temperature)) {
      return;
    }
    const localDate = new Date((point.timestamp + timezoneOffset) * 1000);
    const dateKey = localDate.toISOString().slice(0, 10);
    const day = days.get(dateKey) || {
      dateKey,
      temperatures: [],
      precipitation: [],
      rain: 0,
      points: [],
    };
    day.temperatures.push(point.temperature);
    day.points.push(point);
    if (Number.isFinite(point.precipitation_probability)) {
      day.precipitation.push(point.precipitation_probability);
    }
    day.rain += Number(point.rain_3h) || 0;
    days.set(dateKey, day);
  });

  return dateKeys.map((dateKey) => {
    const day = days.get(dateKey);
    if (!day) return { dateKey, unavailable: true };
    const representative = pickDailyRepresentative(
      day.points,
      weather,
      timezoneOffset,
    );
    return {
      ...day,
      representative,
      high: Math.max(...day.temperatures),
      low: Math.min(...day.temperatures),
      precipitation: day.precipitation.length
        ? Math.max(...day.precipitation)
        : null,
    };
  });
}

function renderDailyForecast(weather) {
  if (!weekCardsEl) return;
  const days = aggregateDailyForecast(weather);
  if (!days.length) {
    weekCardsEl.replaceChildren();
    const message = document.createElement("p");
    message.className = "week-forecast__message";
    message.textContent = "Live forecast unavailable";
    weekCardsEl.append(message);
    if (weekStatusEl) weekStatusEl.textContent = "Unavailable";
    return;
  }

  weekCardsEl.replaceChildren();
  days.slice(0, 7).forEach((day, index) => {
    const date = new Date(`${day.dateKey}T12:00:00Z`);
    const card = document.createElement("article");
    card.className = `week-card${index === 0 ? " active" : ""}`;
    const dayName = index === 0
      ? "Today"
      : date.toLocaleDateString("en-US", { weekday: "short", timeZone: "UTC" });
    const resolved = resolveForecastCondition(day.representative, {
      weather,
      isDay: resolveForecastIsDaytime(day.representative, weather),
    });
    const icon = document.createElement("img");
    icon.width = 54;
    icon.height = 44;
    icon.decoding = "async";
    setForecastConditionIcon(icon, resolved, "weather-icon week-card__icon");

    const dayEl = document.createElement("p");
    dayEl.className = "week-card__day";
    dayEl.textContent = dayName;
    if (day.unavailable) {
      card.classList.add("week-card--unavailable");
      const unavailable = document.createElement("p");
      unavailable.className = "week-card__condition";
      unavailable.textContent = "Forecast unavailable";
      card.append(dayEl, unavailable);
      weekCardsEl.append(card);
      return;
    }
    const conditionEl = document.createElement("p");
    conditionEl.className = "week-card__condition";
    conditionEl.textContent = resolved.label;
    const tempsEl = document.createElement("div");
    tempsEl.className = "week-card__temps";
    const highEl = document.createElement("span");
    highEl.className = "week-card__high";
    setTemperatureDisplay(highEl, day.high, "°");
    const lowEl = document.createElement("span");
    lowEl.className = "week-card__low";
    setTemperatureDisplay(lowEl, day.low, "°");
    tempsEl.append(highEl, lowEl);
    const meta = document.createElement("div");
    meta.className = "week-card__meta";
    meta.append(conditionEl, tempsEl);
    const row = document.createElement("div");
    row.className = "week-card__row";
    row.append(icon, meta);
    card.append(dayEl, row);
    if (day.precipitation !== null) {
      card.title = `Maximum precipitation probability: ${day.precipitation}%`;
    }
    weekCardsEl.append(card);
  });
  if (weekStatusEl) {
    weekStatusEl.textContent = days.some((day) => day.unavailable)
      ? "Partial forecast"
      : "Live forecast";
  }
}

function renderCurrentWeather(weather) {
  if (!weather) {
    return;
  }

  currentHeroWeather = weather;
  renderUvIndex(weather);
  if (Number.isFinite(weather.latitude) && Number.isFinite(weather.longitude)) {
    updateAirQualityIndex(weather.latitude, weather.longitude);
    if (!Number.isFinite(weather.uv_index)) {
      updateUvIndexFromOpenMeteo(weather.latitude, weather.longitude);
    }
  }
  updateTemperatureUnitUI();
  renderHourlyForecast(weather);
  renderDailyForecast(weather);

  if (currentLocationEl) {
    currentLocationEl.textContent = formatLocation(weather);
  }
  if (currentCountryEl) {
    const parts = [];
    if (typeof weather.location_district === "string" && weather.location_district.trim()) {
      parts.push(weather.location_district.trim());
    }
    if (
      typeof weather.location_state === "string" &&
      weather.location_state.trim() &&
      weather.location_state.trim().toLowerCase() !==
        (weather.location_name || "").trim().toLowerCase()
    ) {
      parts.push(weather.location_state.trim());
    }
    if (
      typeof weather.location_country === "string" &&
      weather.location_country.trim()
    ) {
      parts.push(weather.location_country.trim());
    }
    currentCountryEl.textContent = parts.join(", ");
  }

  if (currentDatetimeEl) {
    updateCurrentDatetime();
  }

  if (currentTempEl) {
    setTemperatureDisplay(currentTempEl, weather.temperature);
  }

  if (currentFeelsEl) {
    setTemperatureDisplay(currentFeelsEl, weather.apparent_temperature);
  }

  if (currentFeelsMetricEl) {
    setTemperatureDisplay(currentFeelsMetricEl, weather.apparent_temperature);
  }

  updateCurrentConditionDisplay(weather);

  if (currentHighEl) {
    setTemperatureDisplay(currentHighEl, weather.temperature_max);
  }

  if (currentLowEl) {
    setTemperatureDisplay(currentLowEl, weather.temperature_min);
  }

  if (currentHumidityEl) {
    currentHumidityEl.textContent =
      typeof weather.humidity === "number" ? String(weather.humidity) : "--";
  }

  if (currentWindEl) {
    currentWindEl.textContent =
      typeof weather.wind_speed === "number"
        ? weather.wind_speed.toFixed(1).replace(/\.0$/, "")
        : "--";
  }

  if (currentWindUnitEl) {
    currentWindUnitEl.textContent = "km/h";
  }

  if (currentWindDirEl) {
    const dir = formatWindDirection(weather.wind_direction, weather.wind_direction_cardinal);
    currentWindDirEl.textContent = dir ? `· ${dir}` : "";
  }

  const visibility = formatVisibility(weather.visibility);
  if (currentVisibilityEl) {
    currentVisibilityEl.textContent = visibility.value;
  }
  if (currentVisibilityUnitEl) {
    currentVisibilityUnitEl.textContent = visibility.unit;
  }

  clearHeroState();
}

function readCachedWeatherHero(latitude, longitude) {
  try {
    const raw = sessionStorage.getItem(HERO_WEATHER_CACHE_KEY);
    if (!raw) {
      return null;
    }
    const cached = JSON.parse(raw);
    const isFresh = Date.now() - cached.savedAt < WEATHER_CACHE_TTL_MS;
    const sameLocation =
      cached.latitude === latitude && cached.longitude === longitude;
    return isFresh && sameLocation && cached.weather ? cached.weather : null;
  } catch {
    return null;
  }
}

function writeCachedWeatherHero(latitude, longitude, weather) {
  try {
    sessionStorage.setItem(
      HERO_WEATHER_CACHE_KEY,
      JSON.stringify({
        latitude,
        longitude,
        weather,
        savedAt: Date.now(),
      }),
    );
  } catch {
    // Ignore storage errors.
  }
}

async function fetchCurrentWeatherHero(latitude, longitude) {
  const url = new URL(`${API_BASE_URL}/weather/current`, window.location.origin || window.location.href);
  url.searchParams.set("latitude", String(Number(latitude)));
  url.searchParams.set("longitude", String(Number(longitude)));
  url.searchParams.set("include_location", "true");

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), WEATHER_REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(url.toString(), {
      headers: { Accept: "application/json" },
      signal: controller.signal,
      mode: "cors",
    });

    if (!response.ok) {
      let detail = "";
      try {
        const body = await response.json();
        detail = typeof body.detail === "string" ? body.detail : "";
      } catch {
        // Ignore non-JSON bodies.
      }
      throw new Error(detail || `Weather request failed (${response.status})`);
    }

    return await response.json();
  } finally {
    clearTimeout(timeoutId);
  }
}

async function updateCurrentWeatherHero(position) {
  if (!currentWeatherCard) {
    return;
  }

  const locationRevisionAtRequest = selectedLocationRevision;
  const { latitude, longitude } = position;

  let weather = readCachedWeatherHero(latitude, longitude);

  if (!weather) {
    setHeroLoading(true);
    try {
      weather = await fetchCurrentWeatherHero(latitude, longitude);
    } catch (error) {
      console.warn("Current weather card unavailable:", error.message);
      setHeroError("Unable to load weather data. Check your connection or try again.");
      applyFallbackBackground();
      throw error;
    }
  }

  if (locationRevisionAtRequest !== selectedLocationRevision) return;
  weather = {
    ...weather,
    latitude,
    longitude,
    ...(position.source === "device" ? {
      device_accuracy_meters: position.accuracy,
      device_location_timestamp: position.timestamp,
    } : {}),
  };
  writeCachedWeatherHero(latitude, longitude, weather);
  renderCurrentWeather(weather);
  applyFallbackBackground();
}

function formatGeolocationAccuracy(accuracy) {
  if (!Number.isFinite(accuracy) || accuracy < 0) return "accuracy unavailable";
  return accuracy >= 1000
    ? `±${(accuracy / 1000).toFixed(1)} km`
    : `±${Math.round(accuracy)} m`;
}

function updateGeolocationAccuracyStatus(position, weather) {
  const accuracy = position?.accuracy;
  const unknown = !Number.isFinite(accuracy) || accuracy < 0;
  const lowAccuracy = unknown || accuracy > GEOLOCATION_ACCURACY_WARNING_METERS;
  const approximateName = Boolean(weather?.location_is_approximate);
  const accuracyText = formatGeolocationAccuracy(accuracy);
  if (currentStatusEl) {
    currentStatusEl.textContent = approximateName
      ? `Approximate place · GPS ${accuracyText}`
      : unknown
        ? "GPS accuracy unavailable"
        : lowAccuracy
          ? `Approximate location ${accuracyText}`
          : `GPS ${accuracyText}`;
    currentStatusEl.title = [
      lowAccuracy ? `Device location may be inaccurate (${accuracyText}). Click Current Location to retry.` : `Device location accuracy: ${accuracyText}.`,
      approximateName ? "Reverse geocoding could not verify the displayed place name." : "",
    ].filter(Boolean).join(" ");
  }
  return { accuracyText, lowAccuracy, unknown, approximateName };
}

async function fetchDeviceLocationWeather(options = {}) {
  const isExplicitClick = Boolean(options.explicitClick);
  const locationRevisionAtRequest = selectedLocationRevision;
  const locationBtn = document.getElementById("current-location-btn");
  const locationLabel = document.getElementById("location-label");

  if (locationBtn) {
    locationBtn.classList.add("is-loading");
    locationBtn.setAttribute("aria-busy", "true");
  }
  if (locationLabel && isExplicitClick) {
    locationLabel.textContent = "Locating...";
  }

  try {
    const position = await getBrowserPosition({
      enableHighAccuracy: true,
      timeout: GEOLOCATION_TIMEOUT_MS,
      maximumAge: GEOLOCATION_MAXIMUM_AGE_MS,
      forceFresh: isExplicitClick,
    });
    if (locationRevisionAtRequest !== selectedLocationRevision) {
      if (locationBtn) {
        locationBtn.classList.remove("is-loading");
        locationBtn.removeAttribute("aria-busy");
      }
      return null;
    }
    const accuracy = Number.isFinite(position.coords.accuracy) && position.coords.accuracy >= 0
      ? position.coords.accuracy
      : null;
    const devicePosition = {
      latitude: position.coords.latitude,
      longitude: position.coords.longitude,
      accuracy,
      timestamp: Number.isFinite(position.timestamp) && position.timestamp > 0
        ? position.timestamp
        : Date.now(),
      source: "device",
    };
    heroPosition = devicePosition;
    lastPosition = { ...devicePosition };

    if (isExplicitClick) {
      sessionStorage.removeItem(HERO_WEATHER_CACHE_KEY);
    }

    setHeroLoading(true);
    let weather = !isExplicitClick
      ? readCachedWeatherHero(devicePosition.latitude, devicePosition.longitude)
      : null;

    if (!weather) {
      weather = await fetchCurrentWeatherHero(
        devicePosition.latitude,
        devicePosition.longitude
      );
    }
    if (locationRevisionAtRequest !== selectedLocationRevision) return null;

    weather = {
      ...weather,
      latitude: devicePosition.latitude,
      longitude: devicePosition.longitude,
      device_accuracy_meters: devicePosition.accuracy,
      device_location_timestamp: devicePosition.timestamp,
    };
    writeCachedWeatherHero(devicePosition.latitude, devicePosition.longitude, weather);
    renderCurrentWeather(weather);
    const accuracyStatus = updateGeolocationAccuracyStatus(devicePosition, weather);
    updateWeatherForPosition(devicePosition).catch(() => {});

    if (locationBtn) {
      locationBtn.classList.remove("is-loading");
      locationBtn.classList.add("is-active");
      locationBtn.removeAttribute("aria-busy");
      const label = formatLocation(weather);
      const retryHint = accuracyStatus.lowAccuracy
        ? ` · ${accuracyStatus.unknown ? "GPS accuracy unavailable" : `low GPS accuracy ${accuracyStatus.accuracyText}`} — click to retry`
        : " · click to refresh";
      locationBtn.setAttribute("title", `Current Location: ${label}${retryHint}`);
    }
    if (locationLabel) {
      locationLabel.textContent =
        weather.location_name || weather.location_label || "Current Location";
    }

    document.dispatchEvent(
      new CustomEvent("weatherly:device-location-active", {
        detail: {
          latitude: devicePosition.latitude,
          longitude: devicePosition.longitude,
          accuracy: devicePosition.accuracy,
          timestamp: devicePosition.timestamp,
          source: "device",
          approximate: accuracyStatus.lowAccuracy,
          approximateName: accuracyStatus.approximateName,
          name: weather.location_name || weather.location_label || "Current Location",
          district: weather.location_district || "",
          state: weather.location_state || "",
          country: weather.location_country || "",
          countryCode: weather.location_country_code || "",
          region: [weather.location_district, weather.location_state, weather.location_country].filter(Boolean).join(", "),
        },
      })
    );

    return weather;
  } catch (error) {
    if (locationRevisionAtRequest !== selectedLocationRevision) return null;
    console.warn("Device location weather error:", error.message || error);
    if (locationBtn) {
      locationBtn.classList.remove("is-loading");
      locationBtn.removeAttribute("aria-busy");
    }
    if (locationLabel) {
      locationLabel.textContent = "Current Location";
    }
    document.dispatchEvent(new CustomEvent("weatherly:location-unavailable"));

    if (isExplicitClick) {
      let message = "Unable to fetch device location weather.";
      if (error?.code === 1) {
        message =
          "Location permission was denied. Please allow location access in your browser settings to fetch device weather.";
      } else if (error?.code === 2) {
        message =
          "Device location is currently unavailable. Please check your network or GPS.";
      } else if (error?.code === 3) {
        message = "Location request timed out. Please try again.";
      } else if (error?.message) {
        message = error.message;
      }
      alert(message);
    }

    if (!currentHeroWeather) {
      setHeroError("Location permission or network connection is required to load live weather.");
    }
    throw error;
  }
}

async function initialiseCurrentWeatherHero() {
  if (!currentWeatherCard) {
    return;
  }

  loadTemperatureUnitPreference();
  updateTemperatureUnitUI();

  if (currentRetryBtn) {
    currentRetryBtn.addEventListener("click", () => {
      if (heroPosition?.source === "device") {
        fetchDeviceLocationWeather({ explicitClick: true }).catch(() => {});
      } else if (heroPosition) {
        sessionStorage.removeItem(HERO_WEATHER_CACHE_KEY);
        updateCurrentWeatherHero(heroPosition);
      } else {
        fetchDeviceLocationWeather({ explicitClick: true }).catch(() => {});
      }
    });
  }

  if (navigator.permissions?.query) {
    navigator.permissions
      .query({ name: "geolocation" })
      .then((status) => {
        status.addEventListener("change", () => {
          if (status.state === "granted") {
            fetchDeviceLocationWeather({ explicitClick: false }).catch(() => {});
          } else if (status.state === "denied") {
            setHeroError("Location permission is required to load live weather.");
          }
        });
      })
      .catch(() => {});
  }

  const permission = await getGeolocationPermissionState();

  if (permission === "denied") {
    setHeroError("Location permission is required to load live weather.");
    document.dispatchEvent(new CustomEvent("weatherly:location-unavailable"));
    return;
  }

  try {
    await fetchDeviceLocationWeather({ explicitClick: false });
  } catch (error) {
    console.error("Live weather unavailable:", error);
    setHeroError("Unable to load live weather. Check your connection or try again.");
    applyFallbackBackground();
  }
}

function scheduleHeroWeatherRefresh() {
  if (heroRefreshTimer) {
    clearInterval(heroRefreshTimer);
  }

  heroRefreshTimer = setInterval(() => {
    if (document.visibilityState === "hidden" || !heroPosition) {
      return;
    }
    if (heroPosition.source === "device" &&
        Date.now() - heroPosition.timestamp >= GEOLOCATION_STALE_AFTER_MS) {
      fetchDeviceLocationWeather({ explicitClick: false }).catch(() => {});
      return;
    }
    sessionStorage.removeItem(HERO_WEATHER_CACHE_KEY);
    updateCurrentWeatherHero(heroPosition);
  }, WEATHER_REFRESH_MS);
}

function scheduleCurrentDatetimeRefresh() {
  if (currentDatetimeTimer) {
    clearInterval(currentDatetimeTimer);
  }
  currentDatetimeTimer = setInterval(() => {
    updateCurrentDatetime();
    updateCurrentConditionDisplay(currentHeroWeather);
    renderUvIndex(currentHeroWeather);
  }, 30 * 1000);
}

/* --------------------------------------------------------------------------
   API and short-lived browser cache
   -------------------------------------------------------------------------- */

function readCachedWeather(latitude, longitude) {
  try {
    const raw = sessionStorage.getItem(WEATHER_CACHE_KEY);
    if (!raw) {
      return null;
    }

    const cached = JSON.parse(raw);
    const isFresh = Date.now() - cached.savedAt < WEATHER_CACHE_TTL_MS;
    const sameLocation =
      cached.latitude === latitude && cached.longitude === longitude;

    return isFresh && sameLocation && cached.weather ? cached.weather : null;
  } catch {
    return null;
  }
}

function writeCachedWeather(latitude, longitude, weather) {
  try {
    sessionStorage.setItem(
      WEATHER_CACHE_KEY,
      JSON.stringify({
        latitude,
        longitude,
        weather,
        savedAt: Date.now(),
      }),
    );
  } catch {
    // Session storage can be unavailable in private browsing modes.
  }
}

async function fetchCurrentWeather(latitude, longitude) {
  const url = new URL(`${API_BASE_URL}/weather/current`, window.location.href);
  url.searchParams.set("latitude", String(latitude));
  url.searchParams.set("longitude", String(longitude));

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), WEATHER_REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      headers: { Accept: "application/json" },
      signal: controller.signal,
    });

    if (!response.ok) {
      let detail = "";
      try {
        const body = await response.json();
        detail = typeof body.detail === "string" ? body.detail : "";
      } catch {
        // Ignore non-JSON error bodies.
      }

      throw new Error(detail || `Weather request failed (${response.status})`);
    }

    return await response.json();
  } finally {
    clearTimeout(timeoutId);
  }
}

async function updateWeatherForPosition(position) {
  const requestRevision = ++weatherBackgroundRevision;
  const { latitude, longitude } = position;

  let weather = readCachedWeather(latitude, longitude);

  if (!weather) {
    try {
      weather = await fetchCurrentWeather(latitude, longitude);
      writeCachedWeather(latitude, longitude, weather);
    } catch (error) {
      console.warn("Weather background unavailable:", error.message);
      applyFallbackBackground();
      return;
    }
  }

  if (requestRevision !== weatherBackgroundRevision) return;

  const background = resolveBackground(weather);
  if (background) {
    await applyWeatherBackground(background);
  }
}

/* --------------------------------------------------------------------------
   Geolocation
   -------------------------------------------------------------------------- */

async function getGeolocationPermissionState() {
  if (!navigator.permissions?.query) {
    return "prompt";
  }

  try {
    const permission = await navigator.permissions.query({ name: "geolocation" });
    return permission.state;
  } catch {
    return "prompt";
  }
}

let pendingPositionPromise = null;
let selectedLocationRevision = 0;

function getBrowserPosition(options = {}) {
  if (pendingPositionPromise) {
    return pendingPositionPromise;
  }

  const timeout = typeof options.timeout === "number" ? options.timeout : GEOLOCATION_TIMEOUT_MS;
  const maxAge = typeof options.maximumAge === "number"
    ? options.maximumAge
    : GEOLOCATION_MAXIMUM_AGE_MS;

  pendingPositionPromise = new Promise((resolve, reject) => {
    if (!("geolocation" in navigator)) {
      pendingPositionPromise = null;
      reject(new Error("Geolocation is not supported by this browser."));
      return;
    }

    navigator.geolocation.getCurrentPosition(
      (position) => {
        pendingPositionPromise = null;
        const latitude = position?.coords?.latitude;
        const longitude = position?.coords?.longitude;
        if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90 ||
            !Number.isFinite(longitude) || longitude < -180 || longitude > 180) {
          reject(new Error("The browser returned invalid device coordinates."));
          return;
        }
        resolve(position);
      },
      (error) => {
        pendingPositionPromise = null;
        reject(error);
      },
      {
        enableHighAccuracy: options.enableHighAccuracy !== false,
        timeout,
        maximumAge: maxAge,
      },
    );
  });

  return pendingPositionPromise;
}

async function initialiseWeatherBackground() {
  if (!backgroundRoot) {
    return;
  }
  if (!heroPosition) applyFallbackBackground();
}

function scheduleWeatherRefresh() {
  if (refreshTimer) {
    clearInterval(refreshTimer);
  }

  refreshTimer = setInterval(() => {
    if (document.visibilityState === "hidden" || !lastPosition) {
      return;
    }

    updateWeatherForPosition(lastPosition);
  }, WEATHER_REFRESH_MS);
}

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && lastPosition) {
    updateWeatherForPosition(lastPosition);
  }
  if (document.visibilityState === "visible" && heroPosition) {
    if (heroPosition.source === "device" &&
        Date.now() - heroPosition.timestamp >= GEOLOCATION_STALE_AFTER_MS) {
      fetchDeviceLocationWeather({ explicitClick: false }).catch(() => {});
      return;
    }
    sessionStorage.removeItem(HERO_WEATHER_CACHE_KEY);
    updateCurrentWeatherHero(heroPosition);
  }
});

document.addEventListener("weatherly:location-change", (event) => {
  const location = event.detail;
  if (
    !Number.isFinite(Number(location?.lat)) ||
    !Number.isFinite(Number(location?.lon))
  ) {
    return;
  }
  const locationBtn = document.getElementById("current-location-btn");
  if (locationBtn) {
    locationBtn.classList.remove("is-active");
    locationBtn.classList.remove("is-loading");
    locationBtn.removeAttribute("aria-busy");
  }
  selectedLocationRevision += 1;
  heroPosition = {
    latitude: Number(location.lat),
    longitude: Number(location.lon),
    accuracy: null,
    timestamp: Date.now(),
    source: "manual",
  };
  lastPosition = heroPosition;
  if (currentLocationEl && location.name) {
    currentLocationEl.textContent = location.name;
  }
  if (currentCountryEl && (location.region || location.country)) {
    currentCountryEl.textContent = location.region || location.country;
  }
  sessionStorage.removeItem(HERO_WEATHER_CACHE_KEY);
  updateCurrentWeatherHero(heroPosition).catch((error) => {
    console.warn("Selected location weather unavailable:", error.message);
  });
  updateWeatherForPosition(heroPosition).catch(() => {});
});

document.addEventListener("weatherly:unit-change", (event) => {
  temperatureUnit = event.detail?.unit === "F" ? "f" : "c";
  saveTemperatureUnitPreference();
  updateTemperatureUnitUI();
  updateTemperatureDisplays();
});

document.addEventListener("weatherly:request-device-location", () => {
  fetchDeviceLocationWeather({ explicitClick: true }).catch(() => {});
});

window.AirSense = window.AirSense || {};
window.AirSense.fetchDeviceLocationWeather = fetchDeviceLocationWeather;

const bgVideo = document.getElementById("bg-video");
if (bgVideo) {
  bgVideo.muted = true;
  bgVideo.defaultMuted = true;
  bgVideo.playsInline = true;
  try {
    bgVideo.playbackRate = 0.55;
  } catch (error) {
    // Some browsers may reject custom rates; keep default playback.
  }
  const tryPlay = () => {
    const playPromise = bgVideo.play();
    if (playPromise && typeof playPromise.catch === "function") {
      playPromise.catch(() => {});
    }
  };
  if (bgVideo.readyState >= 2) {
    tryPlay();
  } else {
    bgVideo.addEventListener("loadeddata", tryPlay, { once: true });
  }
}

loadTemperatureUnitPreference();
initialiseCurrentWeatherHero();
scheduleHeroWeatherRefresh();
scheduleCurrentDatetimeRefresh();
initialiseWeatherBackground();
scheduleWeatherRefresh();
