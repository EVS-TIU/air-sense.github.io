/* ==========================================================================
   AirSense — weather-aware background video
   Picks a looping clip from frontend/assets/video based on the current
   condition and whether it is day or night at the selected location.

   Used in two ways:
   - dashboard / climate pages: app.js calls AirSenseBackground.update(weather)
   - history / AI pages: set data-weather-background="auto" on the
     .weather-background container; this script fetches the weather itself
     and follows `weatherly:location-change` events.
   ========================================================================== */

(function () {
  "use strict";

  const FALLBACK_VIDEO = "cloudy.mp4";
  const FALLBACK_POSTER = "Overcast.jpg";
  const LOCATION_STORAGE_KEY = "airsense:selected-location";
  const WEATHER_CACHE_KEY = "airsense:bg-weather:v1";
  const WEATHER_CACHE_MS = 10 * 60 * 1000;
  const WEATHER_REQUEST_TIMEOUT_MS = 12000;

  /* condition -> clips. A missing `night` clip reuses the day clip and gets
     the .is-night filter, so rain/storm/snow still read as nighttime. */
  const CLIPS = {
    clear: {
      day: "sunny.mp4", night: "clear_night_sky.mp4",
      dayPoster: "Clear_day.jpg", nightPoster: "Clear_night.jpg",
    },
    partly_cloudy: {
      day: "partly_cloud.mp4", night: "night_cloudy.mp4",
      dayPoster: "Partly_cloudy_day.jpg", nightPoster: "Partly_cloudy_night.jpg",
    },
    cloudy: {
      day: "cloudy.mp4", night: "night_cloudy.mp4",
      dayPoster: "Mostly_cloudy.jpg", nightPoster: "Mostly_cloudy.jpg",
    },
    overcast: {
      day: "overcast.mp4", night: "night_cloudy.mp4",
      dayPoster: "Overcast.jpg", nightPoster: "Overcast.jpg",
    },
    fog: {
      day: "fog_sky.mp4", night: "fog_sky.mp4",
      dayPoster: "Dense_fog.jpg", nightPoster: "Dense_fog.jpg",
    },
    drizzle: {
      day: "rain_shower.mp4", night: "dark_rain_clouds.mp4",
      dayPoster: "Drizzle.jpg", nightPoster: "Drizzle.jpg",
    },
    rain: {
      day: "rain_shower.mp4", night: "dark_rain_clouds.mp4",
      dayPoster: "Moderate_rain.jpg", nightPoster: "Moderate_rain.jpg",
    },
    rain_showers: {
      day: "rain_shower.mp4", night: "dark_rain_clouds.mp4",
      dayPoster: "Heavy_rain.jpg", nightPoster: "Heavy_rain.jpg",
    },
    snow: {
      day: "snow_fall.mp4", night: "snow_fall.mp4",
      dayPoster: "Moderate_snow.jpg", nightPoster: "Moderate_snow.jpg",
    },
    snow_showers: {
      day: "snow_fall.mp4", night: "snow_fall.mp4",
      dayPoster: "Snow_showers.jpg", nightPoster: "Snow_showers.jpg",
    },
    thunderstorm: {
      day: "thunderstorm.mp4", night: "thunderstorm.mp4",
      dayPoster: "Thunder_storm.jpg", nightPoster: "Thunder_storm.jpg",
    },
    unknown: {
      day: FALLBACK_VIDEO, night: "night_cloudy.mp4",
      dayPoster: FALLBACK_POSTER, nightPoster: FALLBACK_POSTER,
    },
  };

  const video = document.querySelector(".weather-background__video");
  if (!video) {
    return;
  }

  // Resolve clip and poster directories from the video's own src, so the same
  // script works at the site root and inside climate-analysis/.
  const startUrl = new URL(
    video.getAttribute("src") || `./assets/video/${FALLBACK_VIDEO}`,
    document.baseURI,
  );
  const videoDir = new URL(".", startUrl);
  const posterDir = new URL("../images/weather/", videoDir);

  const failed = new Set();
  let current = { file: null, filter: false };
  let lastRequest = null;
  let requestSequence = 0;

  function isNightTime(weather) {
    const flag = weather?.is_day;
    if (flag === true || flag === 1) return false;
    if (flag === false || flag === 0) return true;

    const offset = Number(weather?.timezone_offset);
    if (Number.isFinite(offset)) {
      const seconds = ((Math.floor(Date.now() / 1000) + offset) % 86400 + 86400) % 86400;
      const hour = seconds / 3600;
      return hour < 6 || hour >= 18;
    }

    const hour = new Date().getHours();
    return hour < 6 || hour >= 18;
  }

  function resolve(weather, isDayOverride) {
    const condition =
      typeof weather?.condition === "string" ? weather.condition : "unknown";
    const clip = CLIPS[condition] || CLIPS.unknown;
    const isDay =
      typeof isDayOverride === "boolean" ? isDayOverride : !isNightTime(weather);
    const nightClip = clip.night || clip.day;
    return {
      file: isDay ? clip.day : nightClip,
      poster: isDay ? clip.dayPoster : (clip.nightPoster || clip.dayPoster),
      nightFilter: !isDay && nightClip === clip.day,
    };
  }

  function setVideo(selection) {
    if (!selection) return;

    const wanted = selection.file;
    const usingFallback = failed.has(wanted);
    const file = usingFallback ? FALLBACK_VIDEO : wanted;
    const filter = usingFallback ? false : selection.nightFilter;
    const poster = usingFallback ? FALLBACK_POSTER : selection.poster;

    if (file === current.file && filter === current.filter) {
      return;
    }
    current = { file, filter };

    video.poster = new URL(poster, posterDir).href;
    video.classList.toggle("is-night", filter);

    const url = new URL(file, videoDir).href;
    if (video.src !== url) {
      video.src = url;
      video.load();
    }
    const playback = video.play();
    if (playback && typeof playback.catch === "function") {
      playback.catch(() => {
        // Autoplay can be blocked by the browser; the poster stays visible.
      });
    }
  }

  function fallback() {
    current = { file: null, filter: false };
    setVideo({ file: FALLBACK_VIDEO, poster: FALLBACK_POSTER, nightFilter: false });
  }

  function update(weather, options) {
    setVideo(resolve(weather, options?.isDay));
  }

  video.addEventListener("error", () => {
    const attempted = current.file;
    if (!attempted || attempted === FALLBACK_VIDEO) {
      return;
    }
    failed.add(attempted);
    console.warn(`Background clip missing: ${attempted}; using ${FALLBACK_VIDEO}`);
    current = { file: null, filter: false };
    setVideo({ file: FALLBACK_VIDEO, poster: FALLBACK_POSTER, nightFilter: false });
  });

  /* ----------------------------------------------------------- auto mode */

  function apiBaseUrl() {
    if (window.AIRSENSE_API_BASE_URL) {
      return String(window.AIRSENSE_API_BASE_URL).replace(/\/+$/, "");
    }
    const meta = document.querySelector('meta[name="airsense-api-base"]');
    const host = window.location.hostname;
    if (host === "localhost" || host === "127.0.0.1") {
      return "http://127.0.0.1:8000/api/v1";
    }
    return (
      meta?.content || "https://airsense-backend-docker.getvoroa.com/api/v1"
    ).replace(/\/+$/, "");
  }

  function readSavedLocation() {
    try {
      const saved = JSON.parse(localStorage.getItem(LOCATION_STORAGE_KEY) || "null");
      const lat = Number(saved?.lat);
      const lon = Number(saved?.lon);
      if (Number.isFinite(lat) && Number.isFinite(lon)) return { lat, lon };
    } catch {
      // Ignore unreadable storage.
    }
    const fallbackLocation = window.AIREC_CONFIG?.DEFAULT_LOCATION;
    if (fallbackLocation) {
      return {
        lat: Number(fallbackLocation.latitude),
        lon: Number(fallbackLocation.longitude),
      };
    }
    return null;
  }

  function readWeatherCache(lat, lon) {
    try {
      const cached = JSON.parse(sessionStorage.getItem(WEATHER_CACHE_KEY) || "null");
      if (!cached || Date.now() - cached.savedAt > WEATHER_CACHE_MS) return null;
      if (Math.abs(cached.lat - lat) > 0.01 || Math.abs(cached.lon - lon) > 0.01) {
        return null;
      }
      return cached.weather;
    } catch {
      return null;
    }
  }

  function writeWeatherCache(lat, lon, weather) {
    try {
      sessionStorage.setItem(
        WEATHER_CACHE_KEY,
        JSON.stringify({ lat, lon, weather, savedAt: Date.now() }),
      );
    } catch {
      // Session storage can be unavailable in private browsing modes.
    }
  }

  async function loadWeather(lat, lon, { force = false } = {}) {
    lastRequest = { lat, lon };
    if (!force) {
      const cached = readWeatherCache(lat, lon);
      if (cached) {
        update(cached);
        return;
      }
    }

    const sequence = ++requestSequence;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), WEATHER_REQUEST_TIMEOUT_MS);
    try {
      const url = new URL(`${apiBaseUrl()}/weather/current`, window.location.href);
      url.searchParams.set("latitude", String(lat));
      url.searchParams.set("longitude", String(lon));
      const response = await fetch(url, {
        headers: { Accept: "application/json" },
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new Error(`Weather request failed (${response.status})`);
      }
      const weather = await response.json();
      if (sequence !== requestSequence) return;
      writeWeatherCache(lat, lon, weather);
      update(weather);
    } catch (error) {
      if (sequence === requestSequence) {
        console.warn("Weather background unavailable:", error.message);
      }
    } finally {
      clearTimeout(timeout);
    }
  }

  function startAutoMode() {
    const container = video.closest(".weather-background");
    if (container?.dataset.weatherBackground !== "auto") {
      return;
    }

    document.addEventListener("weatherly:location-change", (event) => {
      const detail = event.detail || {};
      const lat = Number(detail.lat ?? detail.latitude);
      const lon = Number(detail.lon ?? detail.longitude);
      if (Number.isFinite(lat) && Number.isFinite(lon)) {
        loadWeather(lat, lon);
      }
    });

    const saved = readSavedLocation();
    if (saved) {
      loadWeather(saved.lat, saved.lon);
    }

    setInterval(() => {
      if (document.visibilityState !== "hidden" && lastRequest) {
        loadWeather(lastRequest.lat, lastRequest.lon, { force: true });
      }
    }, WEATHER_CACHE_MS);
  }

  window.AirSenseBackground = { update, fallback };
  startAutoMode();
})();
