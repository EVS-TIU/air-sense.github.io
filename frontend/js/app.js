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
const HERO_WEATHER_CACHE_KEY = "airsense:hero-weather:v4";
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
const uvIconEl = document.querySelector("[data-uv-icon]");
const uvLabelEl = document.querySelector("[data-uv-label]");
const uvValueEl = document.querySelector("[data-uv-value]");
const airQualityValueEl = document.querySelector("[data-air-quality-value]");
const tempUnitToggle = document.querySelector("[data-temp-unit-toggle]");
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

function isLocationDaytime(weather, nowMilliseconds = Date.now()) {
  const sunrise = weather?.sunrise;
  const sunset = weather?.sunset;
  const timezoneOffset = weather?.timezone_offset;
  if (
    typeof sunrise !== "number" ||
    !Number.isFinite(sunrise) ||
    typeof sunset !== "number" ||
    !Number.isFinite(sunset) ||
    typeof timezoneOffset !== "number" ||
    !Number.isFinite(timezoneOffset)
  ) {
    return null;
  }
  const localNow = Math.floor(nowMilliseconds / 1000) + timezoneOffset;
  return localNow >= sunrise + timezoneOffset && localNow < sunset + timezoneOffset;
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

function renderAirQuality(weather) {
  if (!airQualityValueEl) return;
  const air = weather?.air_quality;
  if (Number.isFinite(air?.epa_aqi?.value)) {
    airQualityValueEl.textContent = `${air.epa_aqi.value} · ${air.epa_aqi.category}`;
    airQualityValueEl.title = "US EPA AQI";
    return;
  }
  if (Number.isFinite(air?.provider_index)) {
    airQualityValueEl.textContent = `${air.provider_index} · OpenWeather (1–5)`;
    airQualityValueEl.title = "OpenWeather air pollution index; not US EPA AQI";
    return;
  }
  airQualityValueEl.textContent = "Unavailable";
  airQualityValueEl.title = "Air-quality index unavailable";
}

function renderUvIndex(weather) {
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
  const weatherCode = Number(code);
  if (weatherCode === 800) {
    return "clear";
  }
  if (weatherCode === 801 || weatherCode === 802) {
    return "partly-cloudy";
  }
  if (weatherCode === 803 || weatherCode === 804) {
    return "cloudy";
  }
  if (weatherCode >= 200 && weatherCode <= 232) {
    return "storm";
  }
  if (weatherCode >= 300 && weatherCode <= 321) {
    return "rain";
  }
  if (weatherCode >= 500 && weatherCode <= 531) {
    return "rain";
  }
  if (weatherCode >= 600 && weatherCode <= 622) {
    return "snow";
  }
  if (weatherCode >= 700 && weatherCode <= 781) {
    return "fog";
  }
  if (weatherCode >= 95 && weatherCode <= 99) {
    return "storm";
  }
  return "cloudy";
}

function forecastConditionLabel(point) {
  const code = Number(point?.weather_code);
  if (code === 800) {
    return "Sunny";
  }
  if (code >= 801 && code <= 804) {
    return "Cloudy";
  }
  if (code >= 200 && code <= 232) {
    return "Thunderstorm";
  }
  if (code >= 300 && code <= 321) {
    return "Drizzle";
  }
  if (code >= 500 && code <= 531) {
    return "Rain";
  }
  if (code >= 600 && code <= 622) {
    return "Snow";
  }
  if (code >= 700 && code <= 781) {
    return "Foggy";
  }
  if (typeof point?.description === "string" && point.description.trim()) {
    return point.description.trim().replace(/\b\w/g, (letter) => letter.toUpperCase());
  }
  return "Weather unavailable";
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

function renderHourlyForecast(weather) {
  if (!hourlyCards.length) {
    return;
  }

  const availableForecast = Array.isArray(weather?.hourly)
    ? weather.hourly
      .filter((point) => point && typeof point.time === "string")
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
    const moonEl = card.querySelector(".moon-icon");
    const temperatureEl = card.querySelector("h3");
    const probabilityEl = card.querySelector(".humidity");
    const conditionLabel = forecastConditionLabel(point);

    if (hourEl) {
      hourEl.textContent = formatForecastHour(
        point.time,
        point.timestamp,
        Number(weather.timezone_offset) || 0,
      );
    }
    if (temperatureEl) {
      temperatureEl.textContent = `${Math.round(point.temperature)}°`;
    }
    if (probabilityEl) {
      probabilityEl.textContent = conditionLabel;
      probabilityEl.setAttribute(
        "aria-label",
        Number.isFinite(point.precipitation_probability)
          ? `Chance of rain: ${point.precipitation_probability}%`
          : "Chance of rain unavailable",
      );
    }
    if (iconEl) {
      const iconClass = forecastConditionClass(point.weather_code);
      iconEl.className = `weather-icon ${iconClass}`;
      iconEl.innerHTML = forecastIconMarkup(point.weather_code);
      iconEl.hidden = !point.is_day && Boolean(moonEl);
    }
    if (moonEl) {
      moonEl.hidden = Boolean(point.is_day);
    }
  });
}

function aggregateDailyForecast(weather) {
  const points = Array.isArray(weather?.hourly) ? weather.hourly : [];
  const timezoneOffset = Number(weather?.timezone_offset) || 0;
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
      representative: point,
    };
    day.temperatures.push(point.temperature);
    if (Number.isFinite(point.precipitation_probability)) {
      day.precipitation.push(point.precipitation_probability);
    }
    day.rain += Number(point.rain_3h) || 0;
    if (point.timestamp < day.representative.timestamp ||
        (point.weather_code >= 200 && point.weather_code <= 804 &&
         !(day.representative.weather_code >= 200 && day.representative.weather_code <= 804))) {
      day.representative = point;
    }
    days.set(dateKey, day);
  });

  return [...days.values()].slice(0, 5).map((day) => ({
    ...day,
    high: Math.max(...day.temperatures),
    low: Math.min(...day.temperatures),
    precipitation: day.precipitation.length ? Math.max(...day.precipitation) : null,
  }));
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
  days.slice(0, 5).forEach((day, index) => {
    const date = new Date(`${day.dateKey}T12:00:00Z`);
    const card = document.createElement("article");
    card.className = `week-card${index === 0 ? " active" : ""}`;
    const dayName = index === 0
      ? "Today"
      : date.toLocaleDateString("en-US", { weekday: "short", timeZone: "UTC" });
    const condition = forecastConditionLabel(day.representative);
    const icon = createForecastIcon(day.representative.weather_code, "week-card__icon");
    icon.setAttribute("aria-label", condition);
    icon.setAttribute("role", "img");

    const dayEl = document.createElement("p");
    dayEl.className = "week-card__day";
    dayEl.textContent = dayName;
    const conditionEl = document.createElement("p");
    conditionEl.className = "week-card__condition";
    conditionEl.textContent = condition;
    const tempsEl = document.createElement("div");
    tempsEl.className = "week-card__temps";
    tempsEl.innerHTML = `<span class="week-card__high">${formatTemperature(day.high)}°</span>` +
      `<span class="week-card__low">${formatTemperature(day.low)}°</span>`;
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
  if (weekStatusEl) weekStatusEl.textContent = "Live forecast";
}

function renderCurrentWeather(weather) {
  if (!weather) {
    return;
  }

  currentHeroWeather = weather;
  renderUvIndex(weather);
  renderAirQuality(weather);
  updateTemperatureUnitUI();
  renderHourlyForecast(weather);
  renderDailyForecast(weather);

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
    setHeroError("Location permission is required to load live weather.");
    return;
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
    console.info("Live weather background unavailable:", error.message);
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

document.addEventListener("weatherly:location-change", (event) => {
  const location = event.detail;
  if (
    !Number.isFinite(Number(location?.lat)) ||
    !Number.isFinite(Number(location?.lon))
  ) {
    return;
  }
  heroPosition = {
    latitude: Number(location.lat),
    longitude: Number(location.lon),
  };
  lastPosition = heroPosition;
  sessionStorage.removeItem(HERO_WEATHER_CACHE_KEY);
  updateCurrentWeatherHero(heroPosition).catch((error) => {
    console.warn("Selected location weather unavailable:", error.message);
  });
});

loadTemperatureUnitPreference();
initialiseCurrentWeatherHero();
scheduleHeroWeatherRefresh();
scheduleCurrentDatetimeRefresh();
initialiseWeatherBackground();
scheduleWeatherRefresh();
