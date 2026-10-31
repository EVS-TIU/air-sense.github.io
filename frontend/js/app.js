/* ==========================================================================
   AirSense — frontend logic
   Dynamic, location-aware weather background + Current Weather Hero Card
   ========================================================================== */

const DEFAULT_API_BASE_URL = "http://localhost:8000/api/v1";
const apiBaseMeta = document.querySelector('meta[name="airsense-api-base"]');
const API_BASE_URL = (
  window.AIRSENSE_API_BASE_URL ||
  apiBaseMeta?.content ||
  DEFAULT_API_BASE_URL
).replace(/\/+$/, "");

const WEATHER_ASSET_ROOT = "./assets/images/weather/";
const WEATHER_ILLUSTRATION_ROOT = "./assets/images/weather-illustrations/";
const DEFAULT_BACKGROUND = "cloudy.jpg";
const NIGHT_BACKGROUND = "night.jpg";
const DEFAULT_ILLUSTRATION = "cloudy.png";
const WEATHER_REFRESH_MS = 10 * 60 * 1000;
const WEATHER_REQUEST_TIMEOUT_MS = 12 * 1000;
const WEATHER_CACHE_TTL_MS = 5 * 60 * 1000;
const WEATHER_CACHE_KEY = "airsense:weather:v2";
const HERO_WEATHER_CACHE_KEY = "airsense:hero-weather:v2";
const UNITS_STORAGE_KEY = "airsense:units";

/* Keep this in sync with backend/app/services.py. It is only used when the
   API response does not already include a background filename. */
const CONDITION_BACKGROUNDS = {
  clear: "cloudy.jpg",
  partly_cloudy: "partly-cloudy.jpg",
  overcast: "cloudy.jpg",
  fog: "fog.jpg",
  drizzle: "rain.jpg",
  rain: "rain.jpg",
  snow: "snow.jpg",
  rain_showers: "rain.jpg",
  snow_showers: "snow.jpg",
  thunderstorm: "storm.jpg",
  unknown: DEFAULT_BACKGROUND,
};

const CONDITION_ILLUSTRATIONS = {
  clear: "cloudy.png",
  partly_cloudy: "partly-cloudy.png",
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
const tempUnitToggle = document.querySelector("[data-temp-unit-toggle]");
const feelsUnitEls = document.querySelectorAll("[data-feels-unit]");
const feelsMetricUnitEls = document.querySelectorAll("[data-feels-metric-unit]");
const rangeUnitHighEls = document.querySelectorAll("[data-range-unit-high]");
const rangeUnitLowEls = document.querySelectorAll("[data-range-unit-low]");
const currentStateText = document.querySelector("[data-current-state-text]");
const currentRetryBtn = document.querySelector("[data-current-retry]");
const hourlyCards = document.querySelectorAll(".hourly-cards .hour-card");

let currentHeroWeather = null;
let heroPosition = null;
let heroRefreshTimer = null;
let currentDatetimeTimer = null;
let temperatureUnit = "c"; // "c" or "f"

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

function getTemperatureUnitSymbol() {
  return temperatureUnit === "f" ? "F" : "C";
}

function updateTemperatureUnitUI() {
  const symbol = getTemperatureUnitSymbol();
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

  if (weather.condition === "clear") {
    return CONDITION_ILLUSTRATIONS.clear;
  }

  if (typeof weather.illustration === "string" && weather.illustration.trim()) {
    return normaliseIllustrationName(weather.illustration);
  }

  const condition =
    typeof weather.condition === "string" ? weather.condition : "unknown";

  return CONDITION_ILLUSTRATIONS[condition] || DEFAULT_ILLUSTRATION;
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

function formatDateTime(isoString, timezone) {
  try {
    const date = isoString ? new Date(isoString) : new Date();
    const options = {
      weekday: "long",
      month: "long",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
    };
    if (timezone) {
      options.timeZone = timezone;
    }
    return date.toLocaleString("en-US", options);
  } catch {
    return new Date().toLocaleString("en-US");
  }
}

function updateCurrentDatetime() {
  if (currentDatetimeEl) {
    currentDatetimeEl.textContent = formatDateTime(
      null,
      currentHeroWeather?.timezone,
    );
  }
}

function formatLocation(weather) {
  if (typeof weather?.location_label === "string" && weather.location_label.trim()) {
    return weather.location_label.trim();
  }
  if (typeof weather?.location_name === "string" && weather.location_name.trim()) {
    const name = weather.location_name.trim();
    if (typeof weather?.location_country === "string" && weather.location_country.trim()) {
      return `${name}, ${weather.location_country.trim()}`;
    }
    return name;
  }
  if (typeof weather?.timezone === "string" && weather.timezone) {
    return weather.timezone.replace(/_/g, " ");
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

function formatForecastHour(time) {
  const match = typeof time === "string" ? time.match(/T(\d{2}):(\d{2})/) : null;
  if (!match) {
    return "--";
  }
  const hour = Number(match[1]);
  const suffix = hour >= 12 ? "PM" : "AM";
  const displayHour = hour % 12 || 12;
  return `${displayHour} ${suffix}`;
}

function forecastConditionClass(code) {
  if (code === 0) {
    return "clear";
  }
  if (code === 1 || code === 2) {
    return "partly-cloudy";
  }
  if (code === 3 || (code >= 45 && code <= 48)) {
    return "cloudy";
  }
  if (code >= 51 && code <= 67) {
    return "rain";
  }
  if (code >= 71 && code <= 77) {
    return "snow";
  }
  if (code >= 80 && code <= 82) {
    return "rain";
  }
  if (code >= 95) {
    return "storm";
  }
  return "cloudy";
}

function renderHourlyForecast(weather) {
  if (!hourlyCards.length || !Array.isArray(weather?.hourly)) {
    return;
  }

  const availableForecast = weather.hourly
    .filter((point) => point && typeof point.time === "string")
  const startIndex = weather.observed_at
    ? availableForecast.findIndex((point) => point.time >= weather.observed_at)
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
    const hourEl = card.querySelector(".hour");
    const iconEl = card.querySelector(".weather-icon");
    const moonEl = card.querySelector(".moon-icon");
    const temperatureEl = card.querySelector("h3");
    const probabilityEl = card.querySelector(".humidity");
    const probability = Number.isFinite(point.precipitation_probability)
      ? `${point.precipitation_probability}%`
      : "--";

    if (hourEl) {
      hourEl.textContent = formatForecastHour(point.time);
    }
    if (temperatureEl) {
      temperatureEl.textContent = `${Math.round(point.temperature)}°`;
    }
    if (probabilityEl) {
      probabilityEl.innerHTML = `<span>♢</span> ${probability}`;
    }
    if (iconEl) {
      iconEl.className = `weather-icon ${forecastConditionClass(point.weather_code)}`;
      iconEl.hidden = !point.is_day && Boolean(moonEl);
    }
    if (moonEl) {
      moonEl.hidden = Boolean(point.is_day);
    }
  });
}

function renderCurrentWeather(weather) {
  if (!weather) {
    return;
  }

  currentHeroWeather = weather;
  updateTemperatureUnitUI();
  renderHourlyForecast(weather);

  if (currentLocationEl) {
    currentLocationEl.textContent = formatLocation(weather);
  }
  if (currentCountryEl) {
    currentCountryEl.textContent =
      typeof weather.location_country === "string"
        ? weather.location_country
        : "";
  }

  if (currentDatetimeEl) {
    updateCurrentDatetime();
  }

  if (currentStatusEl) {
    currentStatusEl.textContent = weather.is_day === false ? "Night" : "Live";
  }

  if (currentTempEl) {
    currentTempEl.textContent = formatTemperature(weather.temperature);
  }

  if (currentFeelsEl) {
    currentFeelsEl.textContent = formatTemperature(weather.apparent_temperature);
  }

  if (currentFeelsMetricEl) {
    currentFeelsMetricEl.textContent = formatTemperature(weather.apparent_temperature);
  }

  if (currentConditionEl) {
    currentConditionEl.textContent =
      typeof weather.description === "string" && weather.description.trim()
        ? weather.description.trim()
        : typeof weather.condition === "string"
          ? weather.condition.replace(/_/g, " ")
          : "--";
  }

  if (currentHighEl) {
    currentHighEl.textContent = formatTemperature(weather.temperature_max);
  }

  if (currentLowEl) {
    currentLowEl.textContent = formatTemperature(weather.temperature_min);
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

  if (currentIllustrationEl) {
    const illus = resolveIllustration(weather);
    const url = `${WEATHER_ILLUSTRATION_ROOT}${illus}`;
    currentIllustrationEl.alt = currentConditionEl?.textContent || "Current weather illustration";
    currentIllustrationEl.onerror = () => {
      currentIllustrationEl.onerror = null;
      currentIllustrationEl.src = `${WEATHER_ILLUSTRATION_ROOT}cloudy.png`;
    };
    try {
      const fullUrl = new URL(url, window.location.href).href;
      if (currentIllustrationEl.src !== fullUrl) {
        loadIllustrationImage(illus).catch(() => {});
        currentIllustrationEl.src = url;
      }
    } catch {
      currentIllustrationEl.src = url;
    }
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
      Math.abs(cached.latitude - latitude) < 0.02 &&
      Math.abs(cached.longitude - longitude) < 0.02;
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
  url.searchParams.set("latitude", Number(latitude).toFixed(4));
  url.searchParams.set("longitude", Number(longitude).toFixed(4));
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

  const { latitude, longitude } = position;

  let weather = readCachedWeatherHero(latitude, longitude);

  if (!weather) {
    setHeroLoading(true);
    try {
      weather = await fetchCurrentWeatherHero(latitude, longitude);
      writeCachedWeatherHero(latitude, longitude, weather);
    } catch (error) {
      console.warn("Current weather card unavailable:", error.message);
      setHeroError("Unable to load weather data. Check your connection or try again.");
      applyFallbackBackground();
      throw error;
    }
  }

  renderCurrentWeather(weather);

  applyFallbackBackground();
}

async function initialiseCurrentWeatherHero() {
  if (!currentWeatherCard) {
    return;
  }

  loadTemperatureUnitPreference();
  updateTemperatureUnitUI();

  if (tempUnitToggle) {
    tempUnitToggle.addEventListener("click", () => {
      temperatureUnit = temperatureUnit === "c" ? "f" : "c";
      saveTemperatureUnitPreference();
      updateTemperatureUnitUI();
      if (currentHeroWeather) {
        renderCurrentWeather(currentHeroWeather);
      }
    });
  }

  if (currentRetryBtn) {
    currentRetryBtn.addEventListener("click", () => {
      if (heroPosition) {
        sessionStorage.removeItem(HERO_WEATHER_CACHE_KEY);
        updateCurrentWeatherHero(heroPosition);
      } else {
        initialiseCurrentWeatherHero();
      }
    });
  }

  const permission = await getGeolocationPermissionState();

  if (permission === "denied") {
    // Try default location instead of showing error
    heroPosition = { latitude: 28.6139, longitude: 77.2090 };
    lastPosition = heroPosition;
    try {
      await updateCurrentWeatherHero(heroPosition);
      return;
    } catch (error) {
      console.error(error);
      setHeroError("Unable to load weather data. Check your connection or try again.");
      applyFallbackBackground();
      return;
    }
  }

  try {
    const position = await getBrowserPosition();
    heroPosition = {
      latitude: position.coords.latitude,
      longitude: position.coords.longitude,
    };
    lastPosition = heroPosition;

    await updateCurrentWeatherHero(heroPosition);
  } catch (error) {
    console.info("Using fallback weather for hero card:", error.message);
    // Try default location
    heroPosition = { latitude: 28.6139, longitude: 77.2090 };
    lastPosition = heroPosition;
    try {
      await updateCurrentWeatherHero(heroPosition);
    } catch (err) {
      console.error(err);
      setHeroError("Unable to load weather data. Check your connection or try again.");
      applyFallbackBackground();
    }
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
    sessionStorage.removeItem(HERO_WEATHER_CACHE_KEY);
    updateCurrentWeatherHero(heroPosition);
  }, WEATHER_REFRESH_MS);
}

function scheduleCurrentDatetimeRefresh() {
  if (currentDatetimeTimer) {
    clearInterval(currentDatetimeTimer);
  }
  currentDatetimeTimer = setInterval(updateCurrentDatetime, 30 * 1000);
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
      Math.abs(cached.latitude - latitude) < 0.02 &&
      Math.abs(cached.longitude - longitude) < 0.02;

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
  url.searchParams.set("latitude", latitude.toFixed(4));
  url.searchParams.set("longitude", longitude.toFixed(4));

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

function getBrowserPosition() {
  return new Promise((resolve, reject) => {
    if (!("geolocation" in navigator)) {
      reject(new Error("Geolocation is not supported by this browser."));
      return;
    }

    navigator.geolocation.getCurrentPosition(resolve, reject, {
      enableHighAccuracy: false,
      timeout: 10 * 1000,
      maximumAge: 15 * 60 * 1000,
    });
  });
}

async function initialiseWeatherBackground() {
  if (!backgroundRoot) {
    return;
  }

  const permission = await getGeolocationPermissionState();

  if (permission === "denied") {
    applyFallbackBackground();
    return;
  }

  try {
    const position = await getBrowserPosition();
    lastPosition = {
      latitude: position.coords.latitude,
      longitude: position.coords.longitude,
    };

    await updateWeatherForPosition(lastPosition);
  } catch (error) {
    console.info("Using fallback weather background:", error.message);
    applyFallbackBackground();
  }
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
    sessionStorage.removeItem(HERO_WEATHER_CACHE_KEY);
    updateCurrentWeatherHero(heroPosition);
  }
});

loadTemperatureUnitPreference();
initialiseCurrentWeatherHero();
scheduleHeroWeatherRefresh();
scheduleCurrentDatetimeRefresh();
initialiseWeatherBackground();
scheduleWeatherRefresh();
/* ------------------------------------------------------------------
   1) STRICT ICON RULES  (first match wins, order matters)
   Input: WMO weather code (Open-Meteo), rain chance %, rain amount mm
   Output: one of  storm | snow | rain | fog | partly | cloud | sun
------------------------------------------------------------------- */
const RAIN_CODES  = [51,53,55,56,57,61,63,65,66,67,80,81,82];
const SNOW_CODES  = [71,73,75,77,85,86];
const STORM_CODES = [95,96,99];
const FOG_CODES   = [45,48];

function pickIcon(code, rainChance, rainMm) {
  // 1. Thunderstorm codes always show the storm icon
  if (STORM_CODES.includes(code)) return 'storm';
  // 2. Snow codes
  if (SNOW_CODES.includes(code)) return 'snow';
  // 3. Rain: rain code with chance >= 40%, OR any sky with chance >= 60% and >= 1 mm expected
  if (RAIN_CODES.includes(code) && rainChance >= 40) return 'rain';
  if (rainChance >= 60 && rainMm >= 1) return 'rain';
  // 4. Fog
  if (FOG_CODES.includes(code)) return 'fog';
  // 5. Clear / mainly clear -> matching illustration (only if rain chance is low)
  if (code === 0) return rainChance < 30 ? 'clear' : 'partly';
  if (code === 1) return rainChance < 30 ? 'sun' : 'partly';
  // 6. Partly cloudy
  if (code === 2) return 'partly';
  // 7. Overcast (and any leftover weak-drizzle/rain code with low chance)
  return 'cloud';
}

/* ------------------------------------------------------------------
   2) ICONS (SVG style shared with the hourly forecast)
------------------------------------------------------------------- */
const WEEK_CLOUD = '<path class="cloud" d="M18 39 C5 39 4 22 16 17 C18 5 37 3 43 17 C58 9 73 22 69 35 C67 41 62 43 55 43 H18Z"/>';
const WEEK_SUN = '<g class="ww-sun-rays"><line x1="54" y1="5" x2="54" y2="11"/><line x1="54" y1="37" x2="54" y2="43"/><line x1="35" y1="24" x2="41" y2="24"/><line x1="67" y1="24" x2="73" y2="24"/><line x1="41" y1="11" x2="45" y2="15"/><line x1="63" y1="33" x2="67" y2="37"/><line x1="41" y1="37" x2="45" y2="33"/><line x1="63" y1="15" x2="67" y2="11"/></g><circle class="ww-sun" cx="54" cy="24" r="10"/>';
const WEEK_RAIN = '<path class="rain-drop" d="M22 48 L17 58"/><path class="rain-drop" d="M39 48 L34 60"/><path class="rain-drop" d="M56 48 L51 58"/>';
const ICONS = {
  clear: { alt: 'Clear', content: WEEK_SUN },
  sun: { alt: 'Sunny', content: WEEK_SUN },
  partly: { alt: 'Partly cloudy', content: `${WEEK_SUN}${WEEK_CLOUD}` },
  cloud: { alt: 'Cloudy', content: WEEK_CLOUD },
  rain: { alt: 'Rain', content: `${WEEK_CLOUD}${WEEK_RAIN}` },
  storm: { alt: 'Thunderstorm', content: `${WEEK_CLOUD}<path class="ww-lightning" d="M41 43 33 53h7l-4 9 13-15h-8l5-4Z"/>` },
  snow: { alt: 'Snow', content: `${WEEK_CLOUD}<g class="ww-snow"><circle cx="23" cy="52" r="2.5"/><circle cx="39" cy="56" r="2.5"/><circle cx="55" cy="52" r="2.5"/></g>` },
  fog: { alt: 'Fog', content: `${WEEK_CLOUD}<g class="ww-fog"><path d="M16 50h48M21 57h42"/></g>` }
};

/* Bar colour by rain chance: low = yellow, mid = orange, high = red */
function barColor(p) { return p < 30 ? '#ffd23f' : p < 60 ? '#ff9a3c' : '#ff4d4d'; }

/* ------------------------------------------------------------------
   3) RENDER  (takes data in Open-Meteo "daily" shape, so mock and
      real API data go through exactly the same code)
------------------------------------------------------------------- */
function renderWeek(d) {
  const grid = document.getElementById('wwGrid');
  grid.innerHTML = d.time.map((t, i) => {
    const date   = new Date(t + 'T12:00:00');            // noon avoids timezone date shifts
    const chance = Math.round(d.precipitation_probability_max[i] ?? 0);
    const icon   = pickIcon(d.weather_code[i], chance, d.precipitation_sum[i] ?? 0);
    return `<div class="ww-day${i === 0 ? ' today' : ''}">
      <div class="ww-name">${date.toLocaleDateString('en-US', { weekday: 'short' })}</div>
      <div class="ww-date">${date.getDate()} ${date.toLocaleDateString('en-US', { month: 'short' })}</div>
      <svg class="weather-icon ww-icon" viewBox="0 0 80 65" role="img" aria-label="${ICONS[icon].alt}">${ICONS[icon].content}</svg>
      <div class="ww-temp">${Math.round(d.temperature_2m_max[i])}° <span>/ ${Math.round(d.temperature_2m_min[i])}°</span></div>
      <div class="ww-rain">💧 ${chance}%</div>
      <div class="ww-bar"><i style="width:${chance}%;background:${barColor(chance)}"></i></div>
    </div>`;
  }).join('');
}

/* ==================================================================
   4) TEMPORARY MOCK DATA  – random 7 days starting 31 Oct 2026
      DELETE this whole section once the API is connected.
================================================================== */
const MOCK_START = '2026-10-31';
function getMockDaily() {
  const codes = [0, 1, 2, 3, 45, 61, 63, 80, 95, 71];       // sun, clear, partly, cloud, fog, rain, rain, showers, storm, snow
  const rnd = (a, b) => Math.floor(Math.random() * (b - a + 1)) + a;
  const d = { time: [], weather_code: [], temperature_2m_max: [], temperature_2m_min: [],
              precipitation_probability_max: [], precipitation_sum: [] };
  const start = new Date(MOCK_START + 'T12:00:00');
  for (let i = 0; i < 7; i++) {
    const day = new Date(start); day.setDate(start.getDate() + i);
    const code = codes[rnd(0, codes.length - 1)];
    const wet  = [61, 63, 80, 95, 71].includes(code);
    const max  = rnd(14, 28);
    d.time.push(day.toISOString().slice(0, 10));
    d.weather_code.push(code);
    d.temperature_2m_max.push(max);
    d.temperature_2m_min.push(max - rnd(5, 10));
    d.precipitation_probability_max.push(wet ? rnd(50, 95) : rnd(0, 35));
    d.precipitation_sum.push(wet ? rnd(2, 15) : 0);
  }
  return d;
}

/* ==================================================================
   5) REAL API  – Open-Meteo (free, no key)
      >>> API DATA GOES HERE <<<
      Set USE_MOCK = false to switch over. Call loadWeekWeather(lat, lon)
      again whenever the city changes (search box / dropdown).
================================================================== */
const USE_MOCK = true;                                       // <-- flip to false for live data

async function loadWeekWeather(lat = 35.4676, lon = -97.5164, unit = 'celsius') {
  // ---- MOCK MODE ----
  if (USE_MOCK) { renderWeek(getMockDaily()); return; }

  // ---- LIVE MODE ----
  const url = 'https://api.open-meteo.com/v1/forecast'
    + `?latitude=${lat}&longitude=${lon}`
    + '&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,precipitation_sum'
    + `&temperature_unit=${unit}&timezone=auto&forecast_days=7`;
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(res.status);
    renderWeek((await res.json()).daily);                   // <-- API response lands here
  } catch (e) {
    document.getElementById('wwGrid').innerHTML =
      '<div class="ww-msg">Could not load the forecast. Check your connection and try again.</div>';
    console.error('Weekly weather error:', e);
  }
}

loadWeekWeather();   // default city: Oklahoma City