/* ================= climateTypes.js ================= */
/**
 * Data contract for the climate forecast response.
 * Both the mock data and the real backend response MUST match this shape.
 *
 * @typedef {Object} ClimateLocation
 * @property {string} city
 * @property {string} country
 *
 * @typedef {Object} ClimateForecast
 * @property {string} date                 ISO date, e.g. "2026-11-15"
 * @property {string} condition            e.g. "Partly Cloudy"
 * @property {number} temperature          °C
 * @property {number} feelsLike            °C
 * @property {number} confidence           0-100
 * @property {number} humidity             %
 * @property {number} windSpeed            km/h
 * @property {string} windDirection        e.g. "NW"
 * @property {number} rainfallProbability  %
 * @property {string} rainfallIntensity    e.g. "Light"
 * @property {number} aqi
 * @property {string} aqiStatus            e.g. "Unhealthy"
 * @property {number} snowfall             %
 * @property {number} maxTemperature       °C
 * @property {number} minTemperature       °C
 *
 * @typedef {Object} TemperatureTrendPoint
 * @property {string} date                 Label like "11 Nov"
 * @property {number} max
 * @property {number} min
 *
 * @typedef {Object} ClimateData
 * @property {ClimateLocation} location
 * @property {ClimateForecast} forecast
 * @property {TemperatureTrendPoint[]} temperatureTrend
 * @property {string} aiInsight
 */

/* ================= mockClimateData.js ================= */
/** Temporary test data. Same shape as ClimateData (see climateTypes.js). */
window.MOCK_CLIMATE_DATA = {
  location: { city: "Delhi", country: "India" },
  forecast: {
    date: "2026-11-15",
    condition: "Partly Cloudy",
    temperature: 28,
    feelsLike: 29,
    confidence: 87,
    humidity: 62,
    windSpeed: 8.4,
    windDirection: "NW",
    rainfallProbability: 20,
    rainfallIntensity: "Light",
    aqi: 142,
    aqiStatus: "Unhealthy",
    snowfall: 0,
    maxTemperature: 32,
    minTemperature: 24
  },
  temperatureTrend: [
    { date: "11 Nov", max: 32, min: 24 },
    { date: "12 Nov", max: 32, min: 25 },
    { date: "13 Nov", max: 31, min: 25 },
    { date: "14 Nov", max: 30, min: 24 },
    { date: "15 Nov", max: 32, min: 24 },
    { date: "16 Nov", max: 31, min: 25 },
    { date: "17 Nov", max: 31, min: 25 }
  ],
  aiInsight:
    "Conditions are likely to be partly cloudy with a low chance of light rainfall. Temperatures will range between 24°C and 32°C, with air quality in the unhealthy range. This aligns with historical trends for mid-November in Delhi."
};

/* ================= climateApi.js ================= */
/**
 * Climate API service layer.
 * The UI only ever calls ClimateApi.getClimateForecast() and receives a ClimateData object.
 *
 * TO GO LIVE: set USE_MOCK to false and fill in BASE_URL / ENDPOINT below.
 * Nothing else in the UI needs to change, as long as the response matches climateTypes.js.
 */
(function () {
  // Same local-detection rule as js/app.js: serve from localhost/127.0.0.1 (or the
  // filesystem) and we hit the local backend; anything else uses the deployed one.
  var isLocalFrontend = window.location.hostname === "localhost" ||
    window.location.hostname === "127.0.0.1" ||
    window.location.protocol === "file:";
  var CONFIG = {
    USE_MOCK: false,         // live prediction from the backend /climate/predict
    BASE_URL: isLocalFrontend
      ? "http://127.0.0.1:8000/api/v1"
      : "https://airsense-backend-docker.getvoroa.com/api/v1",
    ENDPOINT: "/climate/predict",
    HEADERS: { Accept: "application/json" }
  };

  /** API INTEGRATION PLACEHOLDER – runs only when USE_MOCK is false. */
  function fetchFromBackend(params) {
    if (!CONFIG.ENDPOINT) {
      return Promise.reject(new Error("ClimateApi: set CONFIG.BASE_URL and CONFIG.ENDPOINT to connect the backend."));
    }
    var qs = new URLSearchParams(params || {}).toString();
    var url = CONFIG.BASE_URL + CONFIG.ENDPOINT + (qs ? "?" + qs : "");
    return fetch(url, { headers: CONFIG.HEADERS }).then(function (res) {
      if (!res.ok) throw new Error("ClimateApi: request failed (" + res.status + ")");
      return res.json(); // must match ClimateData; add a mapper here if the backend differs
    });
  }

  /**
   * Resolve a city name to coordinates through the existing /location/search
   * endpoint, so /climate/predict can be called with lat/lon like every
   * other weather route.
   * @param {{city?: string, lat?: number, lon?: number}} params
   * @returns {Promise<typeof params>}
   */
  function resolveLocation(params) {
    if (params.lat != null && params.lon != null) return Promise.resolve(params);
    var url = CONFIG.BASE_URL + "/location/search?q=" + encodeURIComponent(params.city || "");
    return fetch(url, { headers: CONFIG.HEADERS }).then(function (res) {
      if (!res.ok) throw new Error("ClimateApi: location lookup failed (" + res.status + ")");
      return res.json();
    }).then(function (out) {
      var hit = out && out.results && out.results[0];
      if (!hit) throw new Error("ClimateApi: no coordinates found for " + params.city);
      params.lat = hit.latitude;
      params.lon = hit.longitude;
      if (!params.country && hit.country) params.country = hit.country;
      return params;
    });
  }
  /**
   * @param {{city?: string, lat?: number, lon?: number, date?: string}} [params]
   * @returns {Promise<ClimateData>}
   */
  function getClimateForecast(params) {
    if (CONFIG.USE_MOCK) {
      return Promise.resolve(JSON.parse(JSON.stringify(window.MOCK_CLIMATE_DATA)));
    }
    params = params || {};
    return resolveLocation(params).then(function (resolved) {
      return fetchFromBackend(resolved);
    });
  }

  window.ClimateApi = { CONFIG: CONFIG, getClimateForecast: getClimateForecast };
})();

/* ================= icons.js ================= */
/** Consistent stroke icon set (24x24, currentColor). */
(function () {
  var P = {
    calendar: '<rect x="3" y="4.5" width="18" height="16" rx="3"/><path d="M3 9.5h18M8 2.5v4M16 2.5v4"/><path d="M8 14h2M14 14h2M8 17.5h2"/>',
    pin: '<path d="M12 21s7-6.2 7-11.5A7 7 0 0 0 5 9.5C5 14.8 12 21 12 21z"/><circle cx="12" cy="9.5" r="2.5"/>',
    thermo: '<path d="M10 14.8V5a2 2 0 1 1 4 0v9.8a4 4 0 1 1-4 0z"/><path d="M12 9v7"/>',
    drop: '<path d="M12 3s6 6.4 6 11a6 6 0 0 1-12 0c0-4.6 6-11 6-11z"/><path d="M9.5 14.5a2.7 2.7 0 0 0 2.2 2.4"/>',
    wind: '<path d="M3 8h11a3 3 0 1 0-3-3"/><path d="M3 12h16a3 3 0 1 1-3 3"/><path d="M3 16h8a2.5 2.5 0 1 1-2.5 2.5"/>',
    rain: '<path d="M7 15a4.5 4.5 0 0 1-.6-8.9A6 6 0 0 1 18 7.5a3.8 3.8 0 0 1-.5 7.5"/><path d="M8 18l-1 3M12 18l-1 3M16 18l-1 3"/>',
    aqi: '<path d="M20 12a8 8 0 1 1-3-6.2"/><path d="M8 12.5c2.5-.5 4-2 5-4.5 1.8 1.2 2.8 2.8 2.8 4.8 0 2.4-1.6 4-3.9 4-1.8 0-3-1-3.9-2.3z"/><path d="M12 15.5l-3 3"/>',
    snow: '<path d="M12 3v18M4.2 7.5l15.6 9M19.8 7.5l-15.6 9"/><path d="M9.5 4.5L12 6.5l2.5-2M9.5 19.5l2.5-2 2.5 2"/>',
    cloud: '<path d="M7 18a4.5 4.5 0 0 1-.6-8.9A6 6 0 0 1 18 10a4 4 0 0 1-.5 8z"/>',
    sun: '<circle cx="12" cy="12" r="4.2"/><path d="M12 2.5v2.3M12 19.2v2.3M2.5 12h2.3M19.2 12h2.3M5.3 5.3l1.6 1.6M17.1 17.1l1.6 1.6M18.7 5.3l-1.6 1.6M6.9 17.1l-1.6 1.6"/>',
    leaf: '<path d="M20 4C10 4 4.5 8.5 4.5 14.5c0 2 1 3.8 2.6 4.8C14.5 19.5 20 15 20 4z"/><path d="M4 21c2.5-5 5.5-8 9.5-10.5"/>',
    chevron: '<path d="M6 9l6 6 6-6"/>'
  };
  window.icon = function (name, cls) {
    return '<svg class="ic ' + (cls || '') + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + (P[name] || '') + '</svg>';
  };

  /** Partly-cloudy hero illustration (sun behind a cloud). */
  window.heroIllustration = function () {
    var rays = '';
    for (var i = 0; i < 12; i++) {
      var a = (i * 30) * Math.PI / 180, cx = 82, cy = 40;
      rays += '<line x1="' + (cx + Math.cos(a) * 31).toFixed(1) + '" y1="' + (cy + Math.sin(a) * 31).toFixed(1) +
        '" x2="' + (cx + Math.cos(a) * 41).toFixed(1) + '" y2="' + (cy + Math.sin(a) * 41).toFixed(1) + '"/>';
    }
    return '<svg class="cl-hero-art" viewBox="0 0 150 120" role="img" aria-label="Partly cloudy">' +
      '<defs>' +
      '<radialGradient id="clSun" cx="40%" cy="35%" r="70%"><stop offset="0" stop-color="#ffe27a"/><stop offset="1" stop-color="#ff9f1c"/></radialGradient>' +
      '<linearGradient id="clCloud" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ffffff"/><stop offset="1" stop-color="#a9c7ee"/></linearGradient>' +
      '<filter id="clGlow" x="-40%" y="-40%" width="180%" height="180%"><feGaussianBlur stdDeviation="6"/></filter>' +
      '</defs>' +
      '<circle cx="82" cy="40" r="30" fill="#ffb627" opacity=".45" filter="url(#clGlow)"/>' +
      '<g stroke="#ffc83d" stroke-width="4" stroke-linecap="round">' + rays + '</g>' +
      '<circle cx="82" cy="40" r="25" fill="url(#clSun)"/>' +
      '<g fill="url(#clCloud)" stroke="#d8e6fa" stroke-width="1">' +
      '<circle cx="40" cy="88" r="20"/><circle cx="68" cy="76" r="26"/><circle cx="100" cy="90" r="18"/>' +
      '<rect x="40" y="88" width="62" height="20" rx="10"/></g>' +
      '</svg>';
  };
})();

/* ================= components.js ================= */
/**
 * UI components. Every component receives the same ClimateData object
 * (see climateTypes.js) and renders from it – nothing is hardcoded here.
 */
(function () {
  var MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  var DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function parseISO(iso) { var p = iso.split("-"); return new Date(Date.UTC(+p[0], +p[1] - 1, +p[2])); }
  function shortDate(iso) { var d = parseISO(iso); return d.getUTCDate() + " " + MONTHS[d.getUTCMonth()]; }
  function fullDate(iso) { return shortDate(iso) + " " + parseISO(iso).getUTCFullYear(); }
  function longDate(iso) { return DAYS[parseISO(iso).getUTCDay()] + ", " + fullDate(iso); }

  /* ---------- A. Predicted Conditions ---------- */
  function predictedConditions(d) {
    var f = d.forecast, C = 2 * Math.PI * 16;
    var conf = Math.max(0, Math.min(100, f.confidence));
    function metric(ic, tone, label, value, valTone) {
      return '<div class="cl-metric">' + icon(ic, tone) +
        '<div class="txt"><div class="lbl">' + esc(label) + '</div><div class="val ' + (valTone || "") + '">' + esc(value) + "</div></div></div>";
    }
    return '<article class="cl-card cl-pred" aria-label="Predicted conditions">' +
      '<header class="cl-pred-head"><div>' +
        '<div class="cl-title-row">' + icon("calendar", "cl-title-ic") +
          '<h2 class="cl-title">Predicted Conditions</h2><span class="cl-badge">AI Forecast</span></div>' +
        '<div class="cl-sub"><span>' + icon("pin") + esc(d.location.city + ", " + d.location.country) + "</span>" +
          "<span>" + icon("calendar") + esc(longDate(f.date)) + "</span></div></div>" +
        '<div class="cl-confidence"><svg class="cl-ring" viewBox="0 0 40 40" aria-hidden="true">' +
          '<circle class="track" cx="20" cy="20" r="16" fill="none" stroke-width="4"/>' +
          '<circle class="bar" cx="20" cy="20" r="16" fill="none" stroke-width="4" stroke-linecap="round" transform="rotate(-90 20 20)" stroke-dasharray="' + (C * conf / 100).toFixed(1) + " " + C.toFixed(1) + '"/></svg>' +
          '<div><div class="cl-conf-label">Prediction Confidence</div><div class="cl-conf-value">' + conf + "%</div></div></div>" +
      "</header>" +
      '<div class="cl-pred-body"><div class="cl-hero">' + heroIllustration() +
        '<div><div class="cl-temp">' + esc(f.temperature) + "<small>°C</small></div>" +
        '<div class="cl-cond">' + esc(f.condition) + "</div></div></div>" +
        '<div class="cl-metrics">' +
          metric("thermo", "is-cyan", "Feels Like", f.feelsLike + "°C") +
          metric("drop", "is-cyan", "Humidity", f.humidity + "%") +
          metric("wind", "is-cyan", "Wind", f.windSpeed + " km/h · " + f.windDirection) +
          metric("rain", "is-blue", "Rainfall (Prob.)", f.rainfallProbability + "% (" + f.rainfallIntensity + ")") +
          metric("aqi", "is-green", "AQI (Predicted)", f.aqi + " · " + f.aqiStatus, "is-amber") +
          metric("snow", "is-cyan", "Snowfall", f.snowfall + "%") +
        "</div></div></article>";
  }

  /* ---------- B. Temperature Trend ---------- */
  var RANGES = [[7, "Next 7 Days"], [5, "Next 5 Days"], [3, "Next 3 Days"]];

  function temperatureTrendShell() {
    return '<article class="cl-card cl-trend" aria-label="Temperature trend">' +
      '<header class="cl-card-head"><h3>' + icon("thermo", "cl-title-ic") + "Temperature Trend</h3>" +
      '<select class="cl-select" aria-label="Forecast range">' +
      RANGES.map(function (r) { return '<option value="' + r[0] + '">' + r[1] + "</option>"; }).join("") +
      "</select></header>" +
      '<div class="cl-chart"></div>' +
      '<div class="cl-legend"><span class="mx"><i></i>Max Temperature</span><span class="mn"><i></i>Min Temperature</span></div>' +
      "</article>";
  }

  function smoothPath(pts) {
    var d = "M" + pts[0][0].toFixed(1) + " " + pts[0][1].toFixed(1);
    for (var i = 0; i < pts.length - 1; i++) {
      var p0 = pts[i - 1] || pts[i], p1 = pts[i], p2 = pts[i + 1], p3 = pts[i + 2] || p2;
      d += " C" + (p1[0] + (p2[0] - p0[0]) / 6).toFixed(1) + " " + (p1[1] + (p2[1] - p0[1]) / 6).toFixed(1) +
        " " + (p2[0] - (p3[0] - p1[0]) / 6).toFixed(1) + " " + (p2[1] - (p3[1] - p1[1]) / 6).toFixed(1) +
        " " + p2[0].toFixed(1) + " " + p2[1].toFixed(1);
    }
    return d;
  }

  function drawChart(wrap, data, count) {
    var trend = data.temperatureTrend, selLabel = shortDate(data.forecast.date);
    var n = Math.min(count, trend.length);
    var idx = trend.findIndex(function (t) { return t.date === selLabel; });
    if (idx < 0) idx = 0;
    var start = Math.max(0, Math.min(idx - Math.floor(n / 2), trend.length - n));
    var pts = trend.slice(start, start + n);
    var selI = idx - start;

    var W = Math.max(1, wrap.clientWidth || 560), H = W < 420 ? 220 : 250;
    var pl = 46, pr = 16, pt = 66, pb = 34, yMin = 22, yMax = 34;
    var inset = Math.min(18, (W - pl - pr) / (n * 2));
    var x = function (i) { return n === 1 ? pl + (W - pl - pr) / 2 : pl + inset + i * (W - pl - pr - 2 * inset) / (n - 1); };
    var y = function (v) { v = Math.max(yMin, Math.min(yMax, v)); return pt + (yMax - v) / (yMax - yMin) * (H - pt - pb); };
    var bottom = y(yMin), step = n > 1 ? x(1) - x(0) : 0;

    var maxPts = pts.map(function (p, i) { return [x(i), y(p.max)]; });
    var minPts = pts.map(function (p, i) { return [x(i), y(p.min)]; });
    var svg = '<svg viewBox="0 0 ' + W + " " + H + '" role="slider" tabindex="0" aria-label="Temperature forecast. Use left and right arrow keys to select a date." aria-valuemin="0" aria-valuemax="' + (n - 1) + '">' +
      '<defs><linearGradient id="clArea" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ff7a3d" stop-opacity=".55"/><stop offset="1" stop-color="#ff7a3d" stop-opacity=".12"/></linearGradient></defs>';

    for (var v = yMin; v <= yMax; v += 2) {
      svg += '<line x1="' + pl + '" x2="' + (W - pr) + '" y1="' + y(v).toFixed(1) + '" y2="' + y(v).toFixed(1) + '" stroke="rgba(130,170,230,.16)"/>' +
        '<text x="' + (pl - 10) + '" y="' + y(v).toFixed(1) + '" text-anchor="end" dominant-baseline="middle">' + v + "°C</text>";
    }
    svg += '<rect class="cl-selected-band" y="' + pt + '" height="' + (bottom - pt).toFixed(1) + '" fill="rgba(33,169,255,.08)"/>';
    svg += '<path d="' + smoothPath(maxPts) + " L" + maxPts[n - 1][0].toFixed(1) + " " + bottom.toFixed(1) + " L" + maxPts[0][0].toFixed(1) + " " + bottom.toFixed(1) + ' Z" fill="url(#clArea)"/>';
    svg += '<path d="' + smoothPath(maxPts) + '" fill="none" stroke="#ff7a3d" stroke-width="2"/>';
    svg += '<path d="' + smoothPath(minPts) + '" fill="none" stroke="#3ec1ff" stroke-width="2"/>';
    svg += '<line class="cl-pointer" y1="' + (pt - 6) + '" y2="' + bottom.toFixed(1) + '" stroke="#21a9ff" stroke-width="1.5"/>';

    pts.forEach(function (p, i) {
      svg += '<circle class="cl-max-point" cx="' + maxPts[i][0].toFixed(1) + '" cy="' + maxPts[i][1].toFixed(1) + '" r="3.6" fill="#ff7a3d" stroke="#ffc29a" stroke-width="1"/>' +
        '<circle class="cl-min-point" cx="' + minPts[i][0].toFixed(1) + '" cy="' + minPts[i][1].toFixed(1) + '" r="3.6" fill="#3ec1ff" stroke="#a5e5ff" stroke-width="1"/>';
      svg += '<text class="cl-date-label' + (W < 340 && i % 2 === 1 && i !== selI ? " is-compact-hidden" : "") +
        '" x="' + x(i).toFixed(1) + '" y="' + (H - 14) + '" text-anchor="middle" dominant-baseline="middle">' + esc(p.date) + "</text>";
    });
    svg += '<rect class="cl-hit" x="' + pl + '" y="' + pt + '" width="' + (W - pl - pr) + '" height="' + (bottom - pt) + '"/>';
    svg += "</svg>";

    wrap.innerHTML = svg +
      '<div class="cl-tip"><b></b><span class="mx"></span><br><span class="mn"></span></div>';

    var chart = wrap.querySelector("svg");
    var pointer = chart.querySelector(".cl-pointer");
    var band = chart.querySelector(".cl-selected-band");
    var tip = wrap.querySelector(".cl-tip");
    var dateLabel = tip.querySelector("b");
    var maxLabel = tip.querySelector(".mx");
    var minLabel = tip.querySelector(".mn");

    function selectPoint(i) {
      i = Math.max(0, Math.min(n - 1, i));
      var selected = pts[i], sx = x(i);
      var left = Math.max(58, Math.min(W - 58, sx));
      pointer.setAttribute("x1", sx.toFixed(1));
      pointer.setAttribute("x2", sx.toFixed(1));
      band.setAttribute("x", Math.max(pl, sx - step / 2).toFixed(1));
      band.setAttribute("width", Math.min(step || W - pl - pr, W - pr - Math.max(pl, sx - step / 2)).toFixed(1));
      chart.querySelectorAll(".cl-max-point").forEach(function (point, j) {
        point.setAttribute("r", j === i ? "5" : "3.6");
        point.setAttribute("stroke", j === i ? "#fff" : "#ffc29a");
      });
      chart.querySelectorAll(".cl-min-point").forEach(function (point, j) {
        point.setAttribute("r", j === i ? "5" : "3.6");
        point.setAttribute("stroke", j === i ? "#fff" : "#a5e5ff");
      });
      chart.querySelectorAll(".cl-date-label").forEach(function (label, j) {
        label.classList.toggle("sel-label", j === i);
        label.classList.toggle("is-compact-hidden", W < 340 && j % 2 === 1 && j !== i);
      });
      chart.setAttribute("aria-valuenow", i);
      chart.setAttribute("aria-valuetext", selected.date + ", max " + selected.max + " degrees, min " + selected.min + " degrees");
      tip.style.left = left.toFixed(1) + "px";
      dateLabel.textContent = selected.date + " " + parseISO(data.forecast.date).getUTCFullYear();
      maxLabel.textContent = "Max: " + selected.max + "°C";
      minLabel.textContent = "Min: " + selected.min + "°C";
    }

    selectPoint(selI);
    chart.addEventListener("pointermove", function (event) {
      var bounds = chart.getBoundingClientRect();
      var pointerX = (event.clientX - bounds.left) * W / bounds.width;
      var nearest = 0;
      for (var i = 1; i < n; i++) {
        if (Math.abs(x(i) - pointerX) < Math.abs(x(nearest) - pointerX)) nearest = i;
      }
      selectPoint(nearest);
    });
    chart.addEventListener("keydown", function (event) {
      var current = Number(chart.getAttribute("aria-valuenow"));
      if (event.key === "ArrowLeft" || event.key === "ArrowDown") {
        event.preventDefault();
        selectPoint(current - 1);
      } else if (event.key === "ArrowRight" || event.key === "ArrowUp") {
        event.preventDefault();
        selectPoint(current + 1);
      } else if (event.key === "Home") {
        event.preventDefault();
        selectPoint(0);
      } else if (event.key === "End") {
        event.preventDefault();
        selectPoint(n - 1);
      }
    });
  }

  function mountTrend(root, data) {
    var wrap = root.querySelector(".cl-chart"), sel = root.querySelector(".cl-select");
    var count = 7, draw = function () { drawChart(wrap, data, count); };
    sel.addEventListener("change", function () { count = parseInt(sel.value, 10); draw(); });
    draw();
    if (window.ResizeObserver) {
      var last = wrap.clientWidth;
      new ResizeObserver(function () { if (wrap.clientWidth !== last) { last = wrap.clientWidth; draw(); } }).observe(wrap);
    } else { window.addEventListener("resize", draw); }
  }

  /* ---------- C. Weather Outlook ---------- */
  function weatherOutlook(d) {
    var f = d.forecast;
    function row(ic, tone, label, value) {
      return '<li class="cl-row">' + icon(ic, tone) + '<div><div class="lbl">' + esc(label) + '</div><div class="val">' + esc(value) + "</div></div></li>";
    }
    return '<article class="cl-card cl-outlook" aria-label="Weather outlook">' +
      '<header class="cl-card-head"><h3>' + icon("cloud", "cl-title-ic") + "Weather Outlook</h3></header>" +
      '<ul class="cl-rows">' +
        row("sun", "is-yellow", "Condition", f.condition) +
        row("rain", "is-blue", "Rainfall", f.rainfallIntensity + " rain possible (~" + f.rainfallProbability + "%)") +
        row("wind", "is-cyan", "Wind", f.windSpeed + " km/h from " + f.windDirection) +
        row("leaf", "is-green", "Air Quality", f.aqiStatus + " (AQI " + f.aqi + ")") +
      "</ul></article>";
  }

  /* ---------- D. AI Insight ---------- */
  function aiInsight(d) {
    return '<article class="cl-card cl-insight" aria-label="AI insight">' +
      '<div class="head">' + icon("leaf") + "<h3>AI Insight</h3></div>" +
      '<span class="sep" aria-hidden="true"></span><p>' + esc(d.aiInsight) + "</p></article>";
  }

  window.ClimateDashboard = {
    mount: function (root, data) {
      root.innerHTML = predictedConditions(data) + temperatureTrendShell() + weatherOutlook(data) + aiInsight(data);
      mountTrend(root.querySelector(".cl-trend"), data);
    }
  };
})();

/* ================= main.js ================= */
/** Entry point: fetch data through the service layer, then render. */
(function () {
  var root = document.getElementById("climate-dashboard");
  if (!root) return;
  ClimateApi.getClimateForecast({
      city: "Delhi",
      date: new Date(Date.now() + 864e5).toISOString().slice(0, 10) // default: tomorrow
    })
    .then(function (data) { ClimateDashboard.mount(root, data); })
    .catch(function (err) {
      console.error(err);
      root.innerHTML = '<div class="cl-card cl-error">Forecast unavailable. Check the API configuration in js/climateApi.js.</div>';
    });
})();