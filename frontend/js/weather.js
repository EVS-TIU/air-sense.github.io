/* Steps 1-2: fetch from the weather API, then validate every metric (PDF sections 7 and 8). */
(function () {
  const C = window.AIREC_CONFIG;
  const wxHost = C.WEATHER_API_KEY ? "https://customer-api.open-meteo.com" : "https://api.open-meteo.com";
  const aqHost = C.WEATHER_API_KEY ? "https://customer-air-quality-api.open-meteo.com" : "https://air-quality-api.open-meteo.com";
  const keyQ = C.WEATHER_API_KEY ? "&apikey=" + encodeURIComponent(C.WEATHER_API_KEY) : "";

  const pad = n => String(n).padStart(2, "0");
  const offStr = s => { const a = Math.abs(s) / 60; return (s < 0 ? "-" : "+") + pad(Math.floor(a / 60)) + ":" + pad(a % 60); };
  const toMs = (t, off) => Date.parse(t + ":00Z") - off * 1000;
  const iso = (ms, off) => new Date(ms + off * 1000).toISOString().slice(0, 19) + offStr(off);

  const RANGE = {
    temp_c: [-90, 60], feels_like_c: [-120, 80], humidity_percent: [0, 100], uv_index: [0, 25],
    rain_mm_hr: [0, 500], rain_probability_percent: [0, 100], cloud_percent: [0, 100],
    wind_speed_kmh: [0, 450], wind_gust_kmh: [0, 500], visibility_km: [0, 200],
    us_aqi: [0, 500], weather_code: [0, 99], pm2_5: [0, 2000], pm10: [0, 2000]
  };
  const UNIT = {
    temp_c: "°C", feels_like_c: "°C", humidity_percent: "%", uv_index: "", rain_mm_hr: "mm/hr",
    rain_probability_percent: "%", cloud_percent: "%", wind_speed_kmh: "km/h", wind_gust_kmh: "km/h",
    visibility_km: "km", us_aqi: "US AQI", weather_code: "WMO code", pm2_5: "µg/m³", pm10: "µg/m³"
  };
  const LABEL = {
    temp_c: "Temperature", feels_like_c: "Feels-like temperature", humidity_percent: "Humidity", uv_index: "UV index",
    rain_mm_hr: "Rainfall intensity", rain_probability_percent: "Rain probability", cloud_percent: "Cloud cover",
    wind_speed_kmh: "Sustained wind", wind_gust_kmh: "Wind gusts", visibility_km: "Visibility",
    us_aqi: "US AQI", weather_code: "Weather condition"
  };

  // kind "obs": observation with a staleness limit. kind "fc": value for the current forecast hour.
  function mk(key, value, source, off, o) {
    const [lo, hi] = RANGE[key];
    const missing = value === null || value === undefined;
    const ok = typeof value === "number" && isFinite(value) && value >= lo && value <= hi;
    const m = { value: ok ? value : null, unit: UNIT[key], source, valid: ok, missing, stale: false };
    if (o.kind === "obs") {
      m.observed_at = iso(o.ms, off);
      m.valid_until_ms = o.ms + o.staleMin * 60000;
      m.stale = Date.now() > m.valid_until_ms;
    } else {
      m.forecast_for = iso(o.ms, off);
      m.valid_until_ms = o.ms + 3600000;
      m.stale = Date.now() > m.valid_until_ms;
    }
    if (key === "us_aqi") m.standard = "US EPA AQI";
    if (key === "pm2_5" || key === "pm10") m.averaging_period = "provider-defined";
    m.valid_until = iso(m.valid_until_ms, off);
    return m;
  }

  async function getJSON(url) {
    const r = await fetch(url);
    if (!r.ok) throw new Error("HTTP " + r.status);
    return r.json();
  }

  function describe(code) {
    if (code === null || code === undefined) return "Unavailable";
    if (code === 0) return "Clear sky";
    if (code <= 2) return code === 1 ? "Mainly clear" : "Partly cloudy";
    if (code === 3) return "Overcast";
    if (code === 45 || code === 48) return "Fog";
    if (code <= 57) return "Drizzle";
    if (code <= 67) return "Rain";
    if (code <= 77) return "Snow";
    if (code <= 82) return "Rain showers";
    if (code <= 86) return "Snow showers";
    return "Thunderstorm";
  }

  async function fetchWeather(lat, lon) {
    const wxUrl = `${wxHost}/v1/forecast?latitude=${lat}&longitude=${lon}` +
      `&current=temperature_2m,relative_humidity_2m,apparent_temperature,precipitation,weather_code,cloud_cover,wind_speed_10m,wind_gusts_10m` +
      `&hourly=uv_index,visibility,precipitation_probability&forecast_days=2&timezone=auto&wind_speed_unit=kmh&precipitation_unit=mm${keyQ}`;
    const aqUrl = `${aqHost}/v1/air-quality?latitude=${lat}&longitude=${lon}&current=us_aqi,pm2_5,pm10&timezone=auto${keyQ}`;
    const [w, a] = await Promise.allSettled([getJSON(wxUrl), getJSON(aqUrl)]);
    if (w.status !== "fulfilled") throw new Error("Weather API request failed (" + w.reason.message + ")");

    const W = w.value, off = W.utc_offset_seconds, cur = W.current, errors = [];
    const curMs = toMs(cur.time, off);
    const hourKey = cur.time.slice(0, 13) + ":00";
    const idx = W.hourly.time.indexOf(hourKey);
    const hourMs = toMs(hourKey, off);
    const hv = name => (idx >= 0 ? W.hourly[name][idx] : undefined);
    const src = "Open-Meteo forecast";
    const obs = { kind: "obs", ms: curMs, staleMin: 30 };
    const fc = { kind: "fc", ms: hourMs };
    const vis = hv("visibility");

    const metrics = {
      temp_c: mk("temp_c", cur.temperature_2m, src, off, obs),
      feels_like_c: mk("feels_like_c", cur.apparent_temperature, src, off, obs),
      humidity_percent: mk("humidity_percent", cur.relative_humidity_2m, src, off, obs),
      rain_mm_hr: mk("rain_mm_hr", cur.precipitation, src, off, obs),
      cloud_percent: mk("cloud_percent", cur.cloud_cover, src, off, obs),
      wind_speed_kmh: mk("wind_speed_kmh", cur.wind_speed_10m, src, off, obs),
      wind_gust_kmh: mk("wind_gust_kmh", cur.wind_gusts_10m, src, off, obs),
      weather_code: mk("weather_code", cur.weather_code, src, off, obs),
      uv_index: mk("uv_index", hv("uv_index"), src, off, fc),
      rain_probability_percent: mk("rain_probability_percent", hv("precipitation_probability"), src, off, fc),
      visibility_km: mk("visibility_km", vis === null || vis === undefined ? vis : vis / 1000, src, off, fc)
    };

    if (a.status === "fulfilled" && a.value.current) {
      const A = a.value, aq = { kind: "obs", ms: toMs(A.current.time, A.utc_offset_seconds), staleMin: 60 };
      const asrc = "Open-Meteo Air Quality (CAMS)";
      metrics.us_aqi = mk("us_aqi", A.current.us_aqi, asrc, off, aq);
      metrics.pm2_5 = mk("pm2_5", A.current.pm2_5, asrc, off, aq);
      metrics.pm10 = mk("pm10", A.current.pm10, asrc, off, aq);
    } else {
      metrics.us_aqi = mk("us_aqi", undefined, "Open-Meteo Air Quality (CAMS)", off, obs);
      errors.push("Air quality request failed; air quality is not assumed to be good.");
    }
    if (idx < 0) errors.push("Hourly forecast did not include the current hour; UV, rain probability and visibility are unavailable.");

    return {
      metrics,
      meta: {
        offset: off, timezone: W.timezone, condition: describe(cur.weather_code),
        generated_at: iso(Date.now(), off), observed_at: iso(curMs, off), errors
      }
    };
  }

  async function suggest(name) {
    const d = await getJSON(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(name)}&count=5&language=en&format=json`);
    return (d.results || []).map(r => ({
      lat: r.latitude,
      lon: r.longitude,
      name: [r.name, r.admin1, r.country].filter(Boolean).join(", ")
    }));
  }

  async function geocode(name) {
    const results = await suggest(name);
    const r = results[0];
    if (!r) throw new Error("No place found for \"" + name + "\"");
    return r;
  }

  async function reverse(lat, lon) {
    const d = await getJSON(`https://api.bigdatacloud.net/data/reverse-geocode-client?latitude=${lat}&longitude=${lon}&localityLanguage=en`);
    return [d.city || d.locality, d.principalSubdivision, d.countryName].filter(Boolean).join(", ") || null;
  }

  window.AIREC_WEATHER = { fetchWeather, geocode, suggest, reverse, iso, LABEL, UNIT };
})();