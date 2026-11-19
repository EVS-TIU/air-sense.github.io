/* ============================================================
   AirSense - AI Recommendation (today only)
   ------------------------------------------------------------
   A self-contained, deterministic day briefing. It never calls an
   LLM and never depends on the chat backend: all text is produced
   by local rules from Open-Meteo weather + air-quality data, so the
   page cannot fall back to a "provider unavailable" message.

   Timeline = the current calendar day at the location, 00:00-01:00
   through 23:00-00:00 (24 slots), in the location's local timezone.
   ============================================================ */
(function () {
  "use strict";

  const CFG = window.AIREC_CONFIG || {};
  const WX_URL = "https://api.open-meteo.com/v1/forecast";
  const AQ_URL = "https://air-quality-api.open-meteo.com/v1/air-quality";
  const TIMEOUT_MS = 15000;

  const $ = (s) => document.querySelector(s);
  const esc = (v) => String(v == null ? "" : v).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  })[c]);
  const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
  const num = (v) => (typeof v === "number" && isFinite(v)) ? v : null;
  const round1 = (v) => (v == null ? null : Math.round(v * 10) / 10);

  /* ---------- location ---------- */
  function readStoredLocation() {
    try {
      const s = JSON.parse(localStorage.getItem("airsense:selected-location") || "null");
      if (s && isFinite(+s.lat) && isFinite(+s.lon)) {
        return { name: s.name || "Your location", region: s.region || "", country: s.countryCode || "", lat: +s.lat, lon: +s.lon };
      }
    } catch (e) { /* storage unavailable */ }
    return null;
  }

  function queryLocation() {
    const q = new URLSearchParams(location.search);
    if (q.get("lat") && q.get("lon") && isFinite(+q.get("lat")) && isFinite(+q.get("lon"))) {
      return { name: q.get("name") || "Your location", region: "", country: "", lat: +q.get("lat"), lon: +q.get("lon") };
    }
    return null;
  }

  function defaultLocation() {
    const d = CFG.DEFAULT_LOCATION || { name: "Kolkata", latitude: 22.5726, longitude: 88.3639 };
    return { name: d.name || "Kolkata", region: "", country: "", lat: +d.latitude, lon: +d.longitude };
  }

  let activeLocation = queryLocation() || readStoredLocation() || defaultLocation();

  function locationLabel(loc) {
    const bits = [loc.name, loc.region, loc.country].filter(Boolean);
    return bits.join(", ");
  }

  /* ---------- network ---------- */
  async function fetchJson(url) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(url, { signal: ctrl.signal, headers: { Accept: "application/json" } });
      if (!res.ok) throw new Error("HTTP " + res.status);
      return await res.json();
    } finally {
      clearTimeout(timer);
    }
  }

  function weatherUrl(loc) {
    const u = new URL(WX_URL);
    u.search = new URLSearchParams({
      latitude: loc.lat, longitude: loc.lon,
      hourly: "temperature_2m,relative_humidity_2m,apparent_temperature,precipitation_probability,precipitation,weather_code,wind_speed_10m,wind_direction_10m,uv_index",
      current: "temperature_2m,weather_code",
      timezone: "auto", forecast_days: "1"
    }).toString();
    return u.toString();
  }

  function airUrl(loc) {
    const u = new URL(AQ_URL);
    u.search = new URLSearchParams({
      latitude: loc.lat, longitude: loc.lon,
      hourly: "us_aqi,pm2_5", timezone: "auto", forecast_days: "1"
    }).toString();
    return u.toString();
  }

  /* ---------- WMO weather codes ---------- */
  function wmo(code) {
    const c = num(code);
    if (c === 0) return { label: "Clear sky", icon: "☀️" };
    if (c === 1 || c === 2) return { label: "Partly cloudy", icon: "🌤️" };
    if (c === 3) return { label: "Overcast", icon: "☁️" };
    if (c === 45 || c === 48) return { label: "Fog", icon: "🌫️" };
    if (c >= 51 && c <= 57) return { label: "Drizzle", icon: "🌦️" };
    if ((c >= 61 && c <= 67) || (c >= 80 && c <= 82)) return { label: "Rain", icon: "🌧️" };
    if ((c >= 71 && c <= 77) || c === 85 || c === 86) return { label: "Snow", icon: "🌨️" };
    if (c >= 95) return { label: "Thunderstorm", icon: "⛈️" };
    return { label: "Variable", icon: "🌡️" };
  }

  /* ---------- severity helpers ---------- */
  const SEV = ["low", "moderate", "high", "severe"];
  const SEV_LABEL = { low: "Low", moderate: "Moderate", high: "High", severe: "Severe" };
  const sevIndex = (name) => SEV.indexOf(name);

  function aqiInfo(aqi) {
    if (aqi == null) return { label: "—", sev: "low", note: "" };
    if (aqi >= 301) return { label: "Hazardous " + Math.round(aqi), sev: "severe", note: "Hazardous air — stay indoors, run an air purifier, avoid all outdoor exertion." };
    if (aqi >= 201) return { label: "Very poor " + Math.round(aqi), sev: "severe", note: "Very poor air — avoid outdoor activity and keep windows closed." };
    if (aqi >= 151) return { label: "Unhealthy " + Math.round(aqi), sev: "high", note: "Unhealthy air — limit time outdoors; wear a mask if you must go out." };
    if (aqi >= 101) return { label: "Sensitive " + Math.round(aqi), sev: "moderate", note: "Sensitive groups should reduce prolonged outdoor exertion." };
    if (aqi >= 51) return { label: "Moderate " + Math.round(aqi), sev: "low", note: "Air quality is acceptable for most people." };
    return { label: "Good " + Math.round(aqi), sev: "low", note: "Air quality is good — a great time to be outdoors." };
  }

  /* Deterministic "what could happen in this hour". Returns the single
     highest-priority driver so each line stays short and actionable. */
  function hourNote(h, aqi) {
    const t = num(h.temperature), pop = num(h.pop), pr = num(h.precipitation);
    const wind = num(h.wind), uv = num(h.uv), code = h.code;
    const a = aqiInfo(aqi);
    const hour = h.hour;
    const night = hour <= 5 || hour >= 22;

    const candidates = [];
    const push = (sev, text) => candidates.push({ sev, text });

    if (num(code) >= 95) push("severe", "Thunderstorms likely — stay indoors and avoid exposed or high places.");
    if (a.sev === "severe") push("severe", a.note);
    if (t != null && t >= 40) push("severe", "Extreme heat — stay in the shade, hydrate, and avoid outdoor work.");
    if (t != null && t <= 4) push("severe", "Biting cold — layer up and limit time outdoors.");

    if (a.sev === "high") push("high", a.note);
    if (pop != null && pop >= 70 || (pr != null && pr >= 4)) push("high", "Heavy rain likely — expect slippery roads and waterlogging in low areas.");
    if (wind != null && wind >= 40) push("high", "Strong gusts — secure loose items and take care on two-wheelers.");
    if (t != null && t >= 35) push("high", "Hot hour — plan strenuous activity for earlier or later in the day.");
    if (uv != null && uv >= 8 && !night) push("high", "High UV — use sunscreen, a hat and seek shade.");

    if (a.sev === "moderate") push("moderate", a.note);
    if (pop != null && pop >= 40 || (pr != null && pr > 0)) push("moderate", "Showers possible — keep a rain cover handy.");
    if (t != null && t <= 10) push("moderate", "Chilly — a light jacket will be comfortable outside.");
    if (night && (pop != null && pop >= 40)) push("moderate", "Overnight rain — roads may be slick for the early commute.");

    if (!candidates.length) {
      return { sev: "low", text: night ? "Quiet conditions — good for rest." : "Conditions look manageable — a good window for outdoor plans." };
    }
    candidates.sort((x, y) => sevIndex(y.sev) - sevIndex(x.sev));
    return candidates[0];
  }

  /* ---------- build the day model ---------- */
  function buildDay(wx, aq) {
    const hourly = (wx && wx.hourly && Array.isArray(wx.hourly.time)) ? wx.hourly.time : [];
    if (!hourly.length) throw new Error("No hourly forecast returned for this location.");

    const hourOf = (iso) => { const m = /T(\d{2}):/.exec(iso || ""); return m ? +m[1] : null; };
    const datePart = String(hourly[0]).slice(0, 10);
    const [y, mo, d] = datePart.split("-").map(Number);
    const dateObj = (y && mo && d) ? new Date(y, mo - 1, d) : new Date();

    // Map air-quality by hour of day (optional feed).
    const aqByHour = new Array(24).fill(null);
    if (aq && aq.hourly && Array.isArray(aq.hourly.time) && Array.isArray(aq.hourly.us_aqi)) {
      aq.hourly.time.forEach((iso, i) => {
        const h = hourOf(iso);
        if (h != null && h >= 0 && h < 24) aqByHour[h] = num(aq.hourly.us_aqi[i]);
      });
    }

    const hours = new Array(24).fill(null);
    wx.hourly.time.forEach((iso, i) => {
      const h = hourOf(iso);
      if (h == null || h < 0 || h > 23) return;
      hours[h] = {
        hour: h,
        time: iso,
        temperature: wx.hourly.temperature_2m ? num(wx.hourly.temperature_2m[i]) : null,
        feels: wx.hourly.apparent_temperature ? num(wx.hourly.apparent_temperature[i]) : null,
        humidity: wx.hourly.relative_humidity_2m ? num(wx.hourly.relative_humidity_2m[i]) : null,
        pop: wx.hourly.precipitation_probability ? num(wx.hourly.precipitation_probability[i]) : null,
        precipitation: wx.hourly.precipitation ? num(wx.hourly.precipitation[i]) : null,
        code: wx.hourly.weather_code ? wx.hourly.weather_code[i] : null,
        wind: wx.hourly.wind_speed_10m ? num(wx.hourly.wind_speed_10m[i]) : null,
        uv: wx.hourly.uv_index ? num(wx.hourly.uv_index[i]) : null,
        aqi: aqByHour[h]
      };
    });

    const present = hours.filter(Boolean);
    if (!present.length) throw new Error("No usable hours in today's forecast.");

    present.forEach((h) => {
      const n = hourNote(h, h.aqi);
      h.sev = n.sev;
      h.note = n.text;
      h.wmo = wmo(h.code);
    });

    const vals = (key) => present.map((h) => h[key]).filter((v) => v != null);
    const temps = vals("temperature"), pops = vals("pop"), winds = vals("wind");
    const aqs = vals("aqi"), uvs = vals("uv");
    const maxOf = (a) => a.length ? Math.max.apply(null, a) : null;
    const minOf = (a) => a.length ? Math.min.apply(null, a) : null;
    const avgOf = (a) => a.length ? a.reduce((x, y) => x + y, 0) / a.length : null;
    const stats = {
      tempNow: wx.current && wx.current.temperature_2m != null ? num(wx.current.temperature_2m) : null,
      tempMax: maxOf(temps), tempMin: minOf(temps),
      rainMax: maxOf(pops), windMax: maxOf(winds),
      aqiMax: maxOf(aqs), uvMax: maxOf(uvs), humidityAvg: avgOf(vals("humidity"))
    };

    // Day-level precautions from the most severe hours of the day.
    const prec = [];
    const addP = (title, sev, text) => prec.push({ title, sev, text });
    if (stats.aqiMax != null && stats.aqiMax >= 101) addP("Air quality", aqiInfo(stats.aqiMax).sev, aqiInfo(stats.aqiMax).note + " Peak US AQI today: " + Math.round(stats.aqiMax) + ".");
    if (stats.rainMax != null && stats.rainMax >= 70) addP("Heavy rain", "high", "Rain chance peaks at " + Math.round(stats.rainMax) + "% today — expect slippery roads and local waterlogging.");
    else if (stats.rainMax != null && stats.rainMax >= 40) addP("Showers", "moderate", "Rain chance up to " + Math.round(stats.rainMax) + "% — carry an umbrella or rain cover.");
    if (stats.tempMax != null && stats.tempMax >= 35) addP("Heat", stats.tempMax >= 40 ? "severe" : "high", "Temperature peaks around " + round1(stats.tempMax) + "°C — stay hydrated and avoid strenuous outdoor activity at midday.");
    if (stats.tempMin != null && stats.tempMin <= 10) addP("Cold", stats.tempMin <= 4 ? "severe" : "moderate", "Temperature drops to around " + round1(stats.tempMin) + "°C — wear warm layers, especially early morning and late night.");
    if (stats.windMax != null && stats.windMax >= 40) addP("Strong wind", "high", "Wind gusts up to " + round1(stats.windMax) + " km/h — secure loose items and take care outdoors.");
    if (stats.uvMax != null && stats.uvMax >= 8) addP("UV exposure", "high", "UV index reaches " + round1(stats.uvMax) + " — use sunscreen and seek shade around midday.");
    if (present.some((h) => num(h.code) >= 95)) addP("Thunderstorm", "severe", "Thunderstorms are possible today — stay indoors during storms and avoid high or exposed places.");
    if (!prec.length) addP("All clear", "low", "No significant weather or air-quality hazards today. It's a good day for outdoor plans.");

    const overall = prec.reduce((top, p) => (sevIndex(p.sev) > sevIndex(top) ? p.sev : top), "low");
    const summary = overall === "severe" ? "A hazardous day in places — plan around the peak-risk hours below."
      : overall === "high" ? "Several risky hours today — take the precautions below seriously."
      : overall === "moderate" ? "A few conditions to watch — check the hourly guide before heading out."
      : "A calm day overall — the hourly guide has the details.";

    // Current hour (location local time) for highlighting.
    let currentHour = -1;
    if (wx.current && wx.current.time) {
      const m = /T(\d{2}):/.exec(wx.current.time);
      if (m) currentHour = +m[1];
    } else if (wx.utc_offset_seconds != null) {
      currentHour = new Date(Date.now() + num(wx.utc_offset_seconds) * 1000).getUTCHours();
    }

    return {
      date: dateObj, datePart, hours, stats, precautions: prec,
      overall, summary, currentHour, timezone: wx.timezone || "", dateLabel:
        dateObj.toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", year: "numeric" })
    };
  }

  /* ---------- temperature curve (inline SVG, no library) ---------- */
  function tempCurve(day) {
    const pts = day.hours.map((h, i) => (h && h.temperature != null) ? { i, t: h.temperature } : null).filter(Boolean);
    if (pts.length < 2) return "";
    const W = 720, H = 96, pad = 8;
    const ts = pts.map((p) => p.t);
    const lo = Math.min.apply(null, ts), hi = Math.max.apply(null, ts);
    const span = (hi - lo) || 1;
    const xy = pts.map((p) => ({
      x: pad + p.i * (W - pad * 2) / 23,
      y: H - pad - ((p.t - lo) / span) * (H - pad * 2)
    }));
    const line = xy.map((p, i) => (i ? "L" : "M") + p.x.toFixed(1) + " " + p.y.toFixed(1)).join(" ");
    const area = line + " L" + xy[xy.length - 1].x.toFixed(1) + " " + H + " L" + xy[0].x.toFixed(1) + " " + H + " Z";
    return '<svg class="rec-curve" viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="none" role="img" aria-label="Temperature across the day">' +
      '<defs><linearGradient id="recCurveFill" x1="0" y1="0" x2="0" y2="1">' +
      '<stop offset="0" stop-color="#7fd0ff" stop-opacity=".38"/><stop offset="1" stop-color="#7fd0ff" stop-opacity="0"/>' +
      '</linearGradient></defs>' +
      '<path d="' + area + '" fill="url(#recCurveFill)"/>' +
      '<path d="' + line + '" fill="none" stroke="#7fd0ff" stroke-width="2.4" stroke-linejoin="round" stroke-linecap="round"/>' +
      '</svg>';
  }

  const hh = (h) => String(h).padStart(2, "0") + ":00";
  const nh = (h) => String((h + 1) % 24).padStart(2, "0") + ":00";

  /* ---------- render ---------- */
  function render(day) {
    $("#rec-tz").textContent = day.timezone ? day.timezone.replace(/_/g, " ") + " time" : "local time";

    const s = day.stats;
    const metric = (label, value) => '<div class="rec-metric"><span>' + esc(label) + '</span><strong>' + esc(value) + '</strong></div>';
    $("#rec-metrics").innerHTML =
      '<div class="rec-metrics__grid">' +
        metric("Rain chance", s.rainMax != null ? "up to " + Math.round(s.rainMax) + "%" : "—") +
        metric("Peak AQI", s.aqiMax != null ? Math.round(s.aqiMax) : "—") +
        metric("Peak wind", s.windMax != null ? round1(s.windMax) + " km/h" : "—") +
      '</div>' + tempCurve(day) +
      '<div class="rec-curve-axis"><span>00:00</span><span>06:00</span><span>12:00</span><span>18:00</span><span>23:00</span></div>';

    $("#rec-precautions").innerHTML = day.precautions.map((p) =>
      '<article class="rec-card" data-sev="' + p.sev + '">' +
        '<div class="rec-card__top"><span class="rec-card__icon" aria-hidden="true">' +
          (p.sev === "severe" ? "⛔" : p.sev === "high" ? "⚠️" : p.sev === "moderate" ? "🟡" : "✅") +
        '</span><h3>' + esc(p.title) + '</h3><span class="rec-card__sev">' + SEV_LABEL[p.sev] + '</span></div>' +
        '<p>' + esc(p.text) + '</p>' +
      '</article>').join("");

    const strip = day.hours.map((h, i) =>
      '<span class="rec-strip__cell' + (i === day.currentHour ? " is-now" : "") + '" data-sev="' + (h ? h.sev : "low") + '" title="' + esc(hh(i) + " – " + nh(i)) + '"></span>').join("");

    const rows = day.hours.map((h, i) => {
      const range = hh(i) + "–" + nh(i);
      if (!h) {
        return '<div class="rec-hour"><div class="rec-hour__time">' + range + '</div><div class="rec-hour__note muted">No data for this hour.</div></div>';
      }
      const cls = "rec-hour" + (i === day.currentHour ? " is-now" : "");
      return '<article class="' + cls + '" data-sev="' + h.sev + '">' +
        '<div class="rec-hour__time"><strong>' + range + '</strong>' + (i === day.currentHour ? '<span class="rec-now-tag">NOW</span>' : "") + '</div>' +
        '<div class="rec-hour__cond"><span class="rec-hour__icon" aria-hidden="true">' + h.wmo.icon + '</span><span>' + esc(h.wmo.label) + '</span></div>' +
        '<div class="rec-hour__temp">' + (h.temperature != null ? round1(h.temperature) + "°C" : "—") + '</div>' +
        '<div class="rec-hour__rain">' + (h.pop != null ? h.pop + "%" : "—") + '</div>' +
        '<div class="rec-hour__aqi">' + (h.aqi != null ? "AQI " + Math.round(h.aqi) : "AQI —") + '</div>' +
        '<div class="rec-hour__wind">' + (h.wind != null ? round1(h.wind) + " km/h" : "—") + '</div>' +
        '<div class="rec-hour__note"><span class="rec-hour__dot" aria-hidden="true"></span>' + esc(h.note) + '</div>' +
      '</article>';
    }).join("");

    $("#rec-timeline").innerHTML =
      '<div class="rec-strip" aria-hidden="true">' + strip + '</div>' +
      '<div class="rec-hour rec-hour--head" aria-hidden="true">' +
        '<div>Time range</div><div>Condition</div><div>Temp</div><div>Rain</div><div>Air</div><div>Wind</div><div>What could happen</div>' +
      '</div>' + rows;

    $("#rec-foot").textContent = "Computed from live Open-Meteo weather and air-quality data. Rules-based — no chat or AI model required. " +
      (day.timezone ? "Times shown in " + day.timezone.replace(/_/g, " ") + "." : "All times local to the location.");
  }

  /* ---------- state ---------- */
  function setState(kind, message) {
    const box = $("#rec-state");
    const retry = $("#rec-retry");
    box.hidden = false;
    box.setAttribute("data-kind", kind);
    $("#rec-state-text").textContent = message;
    retry.hidden = kind !== "error";
    document.body.classList.toggle("is-loading", kind === "loading");
  }

  function clearState() {
    $("#rec-state").hidden = true;
    document.body.classList.remove("is-loading");
  }

  let loadToken = 0;
  async function load() {
    const token = ++loadToken;
    const loc = activeLocation;
    setState("loading", "Building today's recommendation for " + locationLabel(loc) + "…");

    try {
      const [wxRes, aqRes] = await Promise.allSettled([
        fetchJson(weatherUrl(loc)),
        fetchJson(airUrl(loc))
      ]);
      if (token !== loadToken) return; // a newer location request superseded this one

      if (wxRes.status !== "fulfilled") {
        throw new Error("Weather data could not be loaded" + (wxRes.reason ? " (" + wxRes.reason.message + ")" : "") + ".");
      }
      const aq = aqRes.status === "fulfilled" ? aqRes.value : null;
      const day = buildDay(wxRes.value, aq);
      render(day);
      clearState();
    } catch (err) {
      if (token !== loadToken) return;
      setState("error", (err && err.message) || "Something went wrong while building today's recommendation.");
    }
  }

  $("#rec-retry").addEventListener("click", load);

  // React to location changes made anywhere in the app (search, map, GPS).
  document.addEventListener("weatherly:location-change", (e) => {
    const c = e && e.detail;
    if (c && isFinite(+c.lat) && isFinite(+c.lon)) {
      activeLocation = {
        name: c.name || "Your location", region: c.region || "",
        country: c.countryCode || c.country || "", lat: +c.lat, lon: +c.lon
      };
      load();
    }
  });

  // The sidebar card is the canonical display; keep it in sync on this page.
  const sideCity = $("#sidebar-city"), sideRegion = $("#sidebar-region");
  if (sideCity) sideCity.textContent = activeLocation.name;
  if (sideRegion) sideRegion.textContent = locationLabel(activeLocation).slice(activeLocation.name.length + 2) || "Today's location";

  load();
})();
