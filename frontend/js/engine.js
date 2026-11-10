/* Step 3: deterministic rule engine + priority resolver + activity engine (PDF sections 2-6).
   The AI never decides anything here. Thresholds are app-level starting points: edit them in this file. */
(function () {
  const VERSION = "1.0.0";
  const W = window.AIREC_WEATHER;
  const PR = { P0: 0, P1: 1, P2: 2, P3: 3, P4: 4 };

  // null-safe comparisons: missing data never matches a rule (never "safe", never "zero")
  const gt = (v, n) => v != null && v > n;
  const ge = (v, n) => v != null && v >= n;
  const lt = (v, n) => v != null && v < n;
  const bt = (v, lo, hi) => v != null && v >= lo && v < hi; // [lo, hi)
  const f1 = v => Math.round(v * 10) / 10;

  const lab = (v, steps, last) => { for (const [lim, name] of steps) if (v < lim) return name; return last; };
  const CLASSIFY = {
    temperature_c: v => lab(v, [[10, "Cold"], [20, "Cool"], [28, "Comfortable"], [33, "Warm"], [38, "Hot"], [41.01, "Very hot"]], "Extreme heat"),
    humidity_percent: v => lab(v, [[30, "Very dry"], [40, "Dry"], [60.01, "Comfortable"], [70.01, "Moderately humid"], [80.01, "High humidity"], [90.01, "Very humid"]], "Extremely humid"),
    uv_index: v => lab(v, [[3, "Low"], [6, "Moderate"], [8, "High"], [11, "Very high"]], "Extreme"),
    rain_mm_hr: v => v < 0.1 ? "No rain" : lab(v, [[2.51, "Light rain"], [7.51, "Moderate rain"], [15.01, "Heavy rain"], [30.01, "Very heavy rain"]], "Intense rainfall"),
    wind_speed_kmh: v => lab(v, [[10, "Calm/light"], [21, "Light breeze"], [31, "Moderate breeze"], [41, "Strong breeze"], [51, "Strong wind"], [61, "Very strong wind"], [75.01, "Gale-force"]], "Dangerous wind"),
    cloud_percent: v => lab(v, [[11, "Clear sky"], [26, "Mostly clear"], [51, "Partly cloudy"], [76, "Mostly cloudy"], [91, "Cloudy"]], "Overcast"),
    visibility_km: v => v > 5 ? "Good" : v >= 2 ? "Moderate" : v >= 1 ? "Low" : v >= 0.5 ? "Poor" : "Very poor",
    us_aqi: v => lab(v, [[51, "Good"], [101, "Moderate"], [151, "Unhealthy for Sensitive Groups"], [201, "Unhealthy"], [301, "Very Unhealthy"]], "Hazardous")
  };

  const KEYMAP = {
    t: "temp_c", f: "feels_like_c", rh: "humidity_percent", uv: "uv_index", rain: "rain_mm_hr",
    pop: "rain_probability_percent", cloud: "cloud_percent", w: "wind_speed_kmh", g: "wind_gust_kmh",
    vis: "visibility_km", aqi: "us_aqi", wc: "weather_code"
  };
  const usable = m => !!(m && m.valid && !m.stale);

  // ---------- rules ----------
  const R = [];
  const add = (id, group, category, pr, title, action, test) => R.push({ id, group, category, pr, title, action, test });

  // Heat (2.1, 2.2, section 3)
  add("HEAT_001", "heat", "heat", "P1", "Extreme heat risk", "Stay in a cool indoor place and avoid unnecessary time outside.", x => {
    const t = []; if (gt(x.f, 46)) t.push("feels_like_c"); if (gt(x.t, 41)) t.push("temp_c");
    return t.length ? { triggers: t, reason: t.map(k => k === "feels_like_c" ? `Feels-like temperature is ${x.f}°C` : `Temperature is ${x.t}°C`).join("; ") } : null;
  });
  add("HEAT_002", "heat", "heat", "P1", "High heat risk", "Avoid strenuous outdoor activity during peak heat, seek shade and drink water regularly.",
    x => bt(x.f, 40, 46.0001) ? { triggers: ["feels_like_c"], reason: `Feels-like temperature is ${x.f}°C` } : null);
  add("HEAT_005", "heat", "heat", "P2", "Very hot", "Reduce strenuous activity, stay in shade and keep hydrated.",
    x => bt(x.t, 38, 41.0001) ? { triggers: ["temp_c"], reason: `Temperature is ${x.t}°C` } : null);
  add("HEAT_003", "heat", "heat", "P3", "Heat caution", "Wear breathable clothing, drink water and take breaks in the shade.", x => {
    const t = []; if (bt(x.f, 32, 40)) t.push("feels_like_c"); if (bt(x.t, 33, 38)) t.push("temp_c");
    return t.length ? { triggers: t, reason: t.map(k => k === "feels_like_c" ? `Feels-like temperature is ${x.f}°C` : `Temperature is ${x.t}°C`).join("; ") } : null;
  });
  add("HEAT_HUM_001", "heat_humid", "heat", "P2", "Heat-stress caution", "Humid air limits how well sweat cools you. Rest in shade or air conditioning and drink water.",
    x => ge(x.t, 33) && gt(x.rh, 70) ? { triggers: ["temp_c", "humidity_percent"], reason: `Temperature is ${x.t}°C with ${x.rh}% humidity` } : null);
  add("HEAT_DRY_001", "heat_dry", "heat", "P3", "Heat and dehydration caution", "Drink water regularly and limit long exposure in hot, dry air.",
    x => ge(x.t, 33) && lt(x.rh, 40) ? { triggers: ["temp_c", "humidity_percent"], reason: `Temperature is ${x.t}°C with ${x.rh}% humidity` } : null);
  add("HUM_001", "humidity", "humidity", "P3", "High humidity", "Wear light, breathable clothing.",
    x => gt(x.rh, 70) && !ge(x.t, 33) ? { triggers: ["humidity_percent"], reason: `Relative humidity is ${x.rh}% (${CLASSIFY.humidity_percent(x.rh)}); humidity alone does not raise a heat warning` } : null);

  // Cold and wind chill
  add("COLD_002", "cold", "cold", "P2", "Cold exposure and wind chill", "Cover exposed skin and limit time outdoors.",
    x => lt(x.t, 10) && ge(x.w, 31) && x.f != null ? { triggers: ["temp_c", "wind_speed_kmh", "feels_like_c"], reason: `Temperature is ${x.t}°C with sustained wind of ${x.w} km/h; feels-like is ${x.f}°C` } : null);
  add("COLD_001", "cold", "cold", "P3", "Cold weather", "Wear warm layers.",
    x => lt(x.t, 10) ? { triggers: ["temp_c"], reason: `Temperature is ${x.t}°C` } : null);

  // UV (2.3): cloud never suppresses UV advice
  const UVB = [
    [3, "UV_001", "P3", "Moderate UV", "Use SPF 30+ sunscreen, sunglasses and protective clothing as appropriate."],
    [6, "UV_002", "P2", "High UV", "Use SPF 30+ sunscreen, shade and protective clothing."],
    [8, "UV_003", "P2", "Very high UV", "Minimize midday sun exposure and use shade and sun protection."],
    [11, "UV_004", "P1", "Extreme UV", "Avoid prolonged direct sunlight and follow local health guidance."]
  ];
  UVB.forEach(([lo, id, pr, title, act], i) => {
    const hi = i < UVB.length - 1 ? UVB[i + 1][0] : Infinity;
    add(id, "uv", "uv", pr, title, act + " Reapply sunscreen about every 2 hours outdoors.", x => {
      if (!bt(x.uv, lo, hi)) return null;
      const c = ge(x.cloud, 76);
      return { triggers: c ? ["uv_index", "cloud_percent"] : ["uv_index"], reason: `UV index is ${x.uv}` + (c ? `; cloud cover of ${x.cloud}% does not remove UV exposure` : "") };
    });
  });

  // Rain (2.4): intensity, probability kept separate
  const RAINB = [
    [0.1, "RAIN_001", "P3", "Light rain", "Carry an umbrella if you are outdoors."],
    [2.51, "RAIN_002", "P3", "Moderate rain", "Carry an umbrella or raincoat."],
    [7.51, "RAIN_003", "P2", "Heavy rain", "Postpone unnecessary outdoor activities."],
    [15.01, "RAIN_004", "P1", "Very heavy rain", "Expect waterlogging and travel disruption; check official local alerts."],
    [30.01, "RAIN_005", "P1", "Intense rainfall", "Expect waterlogging and travel disruption; check official local alerts."]
  ];
  RAINB.forEach(([lo, id, pr, title, act], i) => {
    const hi = i < RAINB.length - 1 ? RAINB[i + 1][0] : Infinity;
    add(id, "rain", "rain", pr, title, act, x => bt(x.rain, lo, hi) ? {
      triggers: x.pop != null ? ["rain_mm_hr", "rain_probability_percent"] : ["rain_mm_hr"],
      reason: `Rainfall intensity is ${x.rain} mm/hr` + (x.pop != null ? `; chance of rain is ${x.pop}%` : "")
    } : null);
  });
  add("RAIN_006", "rain", "rain", "P3", "Rain likely", "Carry an umbrella if you are heading out.",
    x => ge(x.pop, 61) && !ge(x.rain, 0.1) ? { triggers: ["rain_probability_percent"], reason: `Chance of rain is ${x.pop}%` } : null);

  // Thunderstorm (2.5): forecast only. Lightning is never inferred.
  add("STORM_002", "storm", "storm", "P2", "Thunderstorm with strong gusts", "Avoid exposed areas and follow official alerts. Lightning is not confirmed by the current data.",
    x => [95, 96, 99].includes(x.wc) && ge(x.g, 41) ? { triggers: ["weather_code", "wind_gust_kmh"], reason: `Thunderstorm in the forecast with gusts of ${x.g} km/h` } : null);
  add("STORM_001", "storm", "storm", "P2", "Thunderstorm in forecast", "Be ready to move indoors and check official alerts. Lightning is not confirmed by the current data.",
    x => [95, 96, 99].includes(x.wc) ? { triggers: ["weather_code"], reason: "The weather condition reports a thunderstorm" } : null);

  // Wind (2.6): sustained and gusts evaluated separately
  const WINDB = [
    [21, "WIND_001", "GUST_000", "P3", "Moderate breeze", "Secure light objects if you are outdoors."],
    [31, "WIND_002", "GUST_000", "P3", "Strong breeze", "Take care if cycling and secure light objects."],
    [41, "WIND_003", "GUST_001", "P2", "Strong wind", "Avoid exposed activities."],
    [51, "WIND_004", "GUST_002", "P2", "Very strong wind", "Secure loose objects and follow official alerts."],
    [61, "WIND_005", "GUST_003", "P1", "Gale-force wind", "Avoid unnecessary outdoor exposure."],
    [75.01, "WIND_006", "GUST_004", "P0", "Dangerous wind", "Avoid unnecessary outdoor exposure and follow official instructions."]
  ];
  WINDB.forEach(([lo, id, gid, pr, title, act], i) => {
    const hi = i < WINDB.length - 1 ? WINDB[i + 1][0] : Infinity;
    add(id, "wind", "wind", pr, title, act, x => bt(x.w, lo, hi) ? { triggers: ["wind_speed_kmh"], reason: `Sustained wind is ${x.w} km/h` } : null);
    if (lo >= 41) add(gid, "gust", "wind", pr, "Gusty wind: " + title.toLowerCase(), act, x => bt(x.g, lo, hi) ? {
      triggers: ["wind_gust_kmh"], reason: `Gusts reach ${x.g} km/h` + (x.w != null ? ` (sustained wind ${x.w} km/h)` : "")
    } : null);
  });

  // Cloud (2.7): cloud never implies rain
  add("CLOUD_001", "cloud", "cloud", "P3", "Cloudy sky", "Cloud cover alone does not indicate rain.", x => {
    if (!ge(x.cloud, 76)) return null;
    const dry = x.rain === 0;
    return { triggers: dry ? ["cloud_percent", "rain_mm_hr"] : ["cloud_percent"], reason: `Cloud cover is ${x.cloud}% (${CLASSIFY.cloud_percent(x.cloud)})` + (dry ? "; no rainfall is reported" : "") };
  });

  // Visibility (2.8): fog is only named when the condition reports fog
  const visReason = x => `Visibility is ${f1(x.vis)} km` + (x.fog ? "; the condition reports fog" : "");
  add("VIS_003", "vis", "visibility", "P1", "Very poor visibility", "Avoid unnecessary driving and check official advisories.", x => lt(x.vis, 0.5) ? { triggers: x.fog ? ["visibility_km", "weather_code"] : ["visibility_km"], reason: visReason(x) } : null);
  add("VIS_002", "vis", "visibility", "P2", "Poor visibility", "Reduce speed and increase following distance.", x => bt(x.vis, 0.5, 1) ? { triggers: x.fog ? ["visibility_km", "weather_code"] : ["visibility_km"], reason: visReason(x) } : null);
  add("VIS_001", "vis", "visibility", "P3", "Low visibility", "Drive with caution.", x => bt(x.vis, 1, 2) ? { triggers: x.fog ? ["visibility_km", "weather_code"] : ["visibility_km"], reason: visReason(x) } : null);

  // US AQI (section 6): category is never altered by heat, humidity or wind
  const AQIB = [
    [0, 51, "AQI_001", "P4", "Good air quality", "Normal outdoor activities are fine."],
    [51, 101, "AQI_002", "P3", "Moderate air quality", "Generally suitable; unusually sensitive people should monitor symptoms."],
    [101, 151, "AQI_003", "P2", "Unhealthy for sensitive groups", "Sensitive groups should reduce prolonged or heavy outdoor exertion."],
    [151, 201, "AQI_004", "P1", "Unhealthy air quality", "Everyone should reduce prolonged or heavy outdoor exertion; sensitive groups should avoid prolonged outdoor exertion."],
    [201, 301, "AQI_005", "P1", "Very unhealthy air quality", "Avoid outdoor exertion; sensitive groups should avoid outdoor activity."],
    [301, Infinity, "AQI_006", "P0", "Hazardous air quality", "Avoid outdoor exposure and follow public health guidance."]
  ];
  AQIB.forEach(([lo, hi, id, pr, title, act]) =>
    add(id, "aqi", "air_quality", pr, title, act, x => bt(x.aqi, lo, hi) ? { triggers: ["us_aqi"], reason: `US AQI is ${x.aqi} (${CLASSIFY.us_aqi(x.aqi)})` } : null));

  // Pleasant weather (P4): listed last, never cancels a warning
  add("COMF_001", "comfort", "comfort", "P4", "Comfortable weather", "Pleasant for outdoor plans, subject to any warnings above.",
    x => bt(x.t, 20, 28) && bt(x.rh, 40, 60.01) ? { triggers: ["temp_c", "humidity_percent"], reason: `Temperature is ${x.t}°C with ${x.rh}% humidity` } : null);

  // ---------- priority resolver ----------
  function resolve(fired) {
    const byGroup = new Map();
    for (const r of fired) {
      const cur = byGroup.get(r.group);
      if (!cur) { byGroup.set(r.group, r); continue; }
      const keep = PR[r.priority] < PR[cur.priority] ? r : cur, other = keep === r ? cur : r;
      keep.triggered_by = [...new Set([...keep.triggered_by, ...other.triggered_by])];
      byGroup.set(r.group, keep);
    }
    return [...byGroup.values()].sort((a, b) => PR[a.priority] - PR[b.priority] || a.id.localeCompare(b.id));
  }

  // ---------- activity engine (section 5) ----------
  const GM = {
    heat: ["temp_c", "feels_like_c"], heat_humid: ["humidity_percent"], heat_dry: ["humidity_percent"], humidity: ["humidity_percent"],
    uv: ["uv_index"], rain: ["rain_mm_hr"], storm: ["weather_code"], wind: ["wind_speed_kmh"], gust: ["wind_gust_kmh"],
    aqi: ["us_aqi"], vis: ["visibility_km"], cloud: ["cloud_percent"], cold: ["temp_c"]
  };
  const H = ["heat", "heat_humid", "heat_dry"];
  const ACT = {
    "Walking": [...H, "cold", "aqi", "uv", "rain", "storm", "wind", "gust"],
    "Running": [...H, "aqi", "uv", "rain", "storm"],
    "Cycling": ["gust", "wind", "rain", "vis", "aqi", "storm"],
    "Outdoor sports": [...H, "uv", "storm", "aqi", "wind", "gust", "rain"],
    "Driving": ["rain", "vis", "wind", "gust", "storm"],
    "Travel": ["rain", "wind", "gust", "vis", "storm"],
    "Outdoor events": Object.keys(GM)
  };

  function activities(recs, M) {
    return Object.entries(ACT).map(([name, groups]) => {
      const need = [...new Set(groups.flatMap(g => GM[g]))];
      const missing = need.filter(k => !usable(M[k]));
      if (missing.length) return { activity: name, status: "INSUFFICIENT_DATA", note: "Needs: " + missing.map(k => W.LABEL[k].toLowerCase()).join(", ") + "." };
      const rel = recs.filter(r => groups.includes(r.group) && r.priority !== "P4");
      if (!rel.length) return { activity: name, status: "SUITABLE", note: "No restrictions found in the available metrics. This is not a guarantee of safety." };
      const worst = Math.min(...rel.map(r => PR[r.priority]));
      return { activity: name, status: worst <= 1 ? "NOT_RECOMMENDED" : "CAUTION", note: rel.slice(0, 2).map(r => r.title).join("; ") + "." };
    });
  }

  // ---------- main ----------
  const SPECIAL = {
    us_aqi: "Air quality is unavailable or not current; it is not assumed to be good.",
    uv_index: "UV index is unavailable or not current; no UV conclusion is made.",
    wind_gust_kmh: "Wind gusts are unavailable; gusts are not assumed to equal sustained wind.",
    rain_probability_percent: "Rain probability is unavailable; it is not estimated.",
    visibility_km: "Visibility is unavailable; it is not assumed to be good."
  };

  function evaluate(raw) {
    const M = raw.metrics, x = {};
    for (const [a, k] of Object.entries(KEYMAP)) x[a] = usable(M[k]) ? M[k].value : null;
    x.fog = [45, 48].includes(x.wc);

    const fired = [];
    for (const r of R) {
      const o = r.test(x);
      if (o) fired.push({ id: r.id, group: r.group, category: r.category, priority: r.pr, title: r.title, reason: o.reason, action: r.action, triggered_by: o.triggers });
    }
    const recs = resolve(fired).map(r => {
      const ms = Math.min(...r.triggered_by.map(k => M[k] ? M[k].valid_until_ms : Infinity));
      return { ...r, valid_until: isFinite(ms) ? W.iso(ms, raw.meta.offset) : null };
    });

    const limitations = [];
    for (const k of Object.keys(W.LABEL)) {
      const m = M[k];
      if (usable(m)) continue;
      if (!m || m.missing) limitations.push(SPECIAL[k] || `${W.LABEL[k]} is unavailable; no conclusion is drawn from it.`);
      else if (!m.valid) limitations.push(`${W.LABEL[k]} failed validation and was ignored.`);
      else limitations.push(SPECIAL[k] || `${W.LABEL[k]} is stale (${m.observed_at || m.forecast_for}) and is not used as current.`);
    }
    limitations.push("Lightning detection data is not available from this provider; lightning is never inferred from rain, cloud or wind.");
    limitations.push("Official alerts (for example from IMD) are not included; check official sources.");
    raw.meta.errors.forEach(e => limitations.push(e));

    const top = recs.length ? PR[recs[0].priority] : null;
    const overall = !Object.values(x).some(v => v != null && typeof v === "number") ? "unknown"
      : top === 0 ? "critical" : top === 1 ? "high" : top === 2 ? "moderate" : "low";

    const summary = {
      condition: raw.meta.condition, temperature_c: x.t, feels_like_c: x.f, humidity_percent: x.rh, uv_index: x.uv,
      rain_mm_hr: x.rain, rain_probability_percent: x.pop, wind_speed_kmh: x.w, wind_gust_kmh: x.g,
      cloud_percent: x.cloud, visibility_km: x.vis == null ? null : f1(x.vis), us_aqi: x.aqi, labels: {}
    };
    for (const k of Object.keys(CLASSIFY)) if (summary[k] != null) summary.labels[k] = CLASSIFY[k](summary[k]);

    return {
      weather_summary: summary, overall_risk: overall, recommendations: recs, activities: activities(recs, M),
      data_limitations: limitations, generated_at: raw.meta.generated_at, observed_at: raw.meta.observed_at, rule_version: VERSION
    };
  }

  window.AIREC_ENGINE = { evaluate, VERSION };
})();