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
 * Climate API service layer — calls the backend's MLP-powered prediction
 * endpoint (GET /api/v1/climate/predict). The backend blends the provider
 * forecast with climatology and the trained neural model (ml_model.py),
 * and returns the same ClimateData contract the UI was built on, plus
 * forecast.aiModel describing the trained model's contribution.
 * The prediction target date comes from the calendar's picked day.
 */
(function () {
  /* Same base-URL resolution as the dashboard (js/app.js): localhost
     frontends hit the local API, hosted ones use the meta tag default. */
  var API_BASE = (
    window.AIRSENSE_API_BASE_URL ||
    (["localhost", "127.0.0.1"].indexOf(window.location.hostname) !== -1
      ? "http://127.0.0.1:8000/api/v1"
      : (document.querySelector('meta[name="airsense-api-base"]') || {}).content ||
        "https://airsense-backend-docker.getvoroa.com/api/v1")
  ).replace(/\/+$/, "");

  /**
   * @param {{city?: string, country?: string, lat: number, lon: number}} params
   * @param {string} targetDate YYYY-MM-DD picked in the calendar
   * @returns {Promise<ClimateData>} backend prediction incl. trained model
   */
  function getClimateForecast(params, targetDate) {
    params = params || {};
    var lat = Number(params.lat), lon = Number(params.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
      return Promise.reject(new Error("ClimateApi: coordinates missing for the selected location"));
    }
    if (!targetDate) {
      return Promise.reject(new Error("ClimateApi: no prediction date picked"));
    }
    var url = new URL(API_BASE + "/climate/predict", window.location.href);
    url.searchParams.set("latitude", lat.toFixed(4));
    url.searchParams.set("longitude", lon.toFixed(4));
    if (params.city) url.searchParams.set("city", params.city);
    if (params.country) url.searchParams.set("country", params.country);
    url.searchParams.set("date", targetDate);
    return fetch(url.toString()).then(function (res) {
      if (!res.ok) {
        return res.json().catch(function () { return null; }).then(function (detail) {
          throw new Error((detail && detail.detail) ? String(detail.detail)
            : "Prediction request failed (HTTP " + res.status + ")");
        });
      }
      return res.json();
    }).then(function (data) {
      if (!data || !data.forecast) throw new Error("Prediction response was incomplete");
      return data;
    });
  }
  window.ClimateApi = { API_BASE: API_BASE, getClimateForecast: getClimateForecast };
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
          '<h2 class="cl-title">Predicted Conditions</h2><span class="cl-badge">AI Forecast</span>' +
          (f.aiModel ? '<span class="cl-badge cl-badge-mlp" title="Trained neural model contribution">' +
            'MLP · MAE ±' + esc(String(f.aiModel.validationMae)) + '°C</span>' : "") + '</div>' +
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
          metric("snow", "is-cyan", "Snowfall", f.snowfall + " cm") +
        "</div></div></article>";
  }

  /* ---------- B. Temperature Trend ---------- */
  function temperatureTrendShell() {
    return '<article class="cl-card cl-trend" aria-label="Hourly temperature">' +
      '<header class="cl-card-head"><h3>' + icon("thermo", "cl-title-ic") + "Hourly Temperature</h3>" +
      "</header>" +
      '<div class="cl-chart"></div>' +
      '<div class="cl-legend"><span class="mx"><i></i>Temperature</span></div>' +
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

  function drawChart(wrap, data) {
    var pts = data.hourlyTemperatures || [];
    var n = pts.length;

    var W = Math.max(1, wrap.clientWidth || 560), H = W < 420 ? 220 : 250;
    var pl = 46, pr = 16, pt = 66, pb = 34;

    if (n < 2) {
      wrap.innerHTML =
        '<div class="cl-chart-empty">No hourly curve for this day yet — run the prediction again.</div>';
      return;
    }

    /* Y axis starts at 0 ("no data = zero"), scaled up past the day's peak. */
    var hi = Math.max.apply(null, pts.map(function (p) { return p.c; }));
    var yMin = 0;
    var yMax = Math.ceil((hi * 1.15 + 2) / 5) * 5;
    if (yMax < 10) yMax = 10;
    var yStep = yMax > 40 ? 10 : yMax > 20 ? 5 : 2;
    var x = function (i) { return pl + i * (W - pl - pr) / (n - 1); };
    var y = function (v) { v = Math.max(yMin, Math.min(yMax, v)); return pt + (yMax - v) / (yMax - yMin) * (H - pt - pb); };
    var bottom = y(yMin), step = x(1) - x(0);

    var linePts = pts.map(function (p, i) { return [x(i), y(p.c)]; });
    var svg = '<svg viewBox="0 0 ' + W + " " + H + '" role="slider" tabindex="0" aria-label="Hourly temperature for the selected day. Use left and right arrow keys to select an hour." aria-valuemin="0" aria-valuemax="' + (n - 1) + '">' +
      '<defs><linearGradient id="clArea" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ff7a3d" stop-opacity=".55"/><stop offset="1" stop-color="#ff7a3d" stop-opacity=".12"/></linearGradient></defs>';

    for (var v = yMin; v <= yMax; v += yStep) {
      svg += '<line x1="' + pl + '" x2="' + (W - pr) + '" y1="' + y(v).toFixed(1) + '" y2="' + y(v).toFixed(1) + '" stroke="rgba(130,170,230,.16)"/>' +
        '<text x="' + (pl - 10) + '" y="' + y(v).toFixed(1) + '" text-anchor="end" dominant-baseline="middle">' + v + "°C</text>";
    }
    svg += '<rect class="cl-selected-band" y="' + pt + '" height="' + (bottom - pt).toFixed(1) + '" fill="rgba(33,169,255,.08)"/>';
    svg += '<path d="' + smoothPath(linePts) + " L" + linePts[n - 1][0].toFixed(1) + " " + bottom.toFixed(1) + " L" + linePts[0][0].toFixed(1) + " " + bottom.toFixed(1) + ' Z" fill="url(#clArea)"/>';
    svg += '<path d="' + smoothPath(linePts) + '" fill="none" stroke="#ff7a3d" stroke-width="2"/>';
    svg += '<line class="cl-pointer" y1="' + (pt - 6) + '" y2="' + bottom.toFixed(1) + '" stroke="#21a9ff" stroke-width="1.5"/>';

    /* X axis: the 24 hours of the predicted day, labelled every 3 hours. */
    pts.forEach(function (p, i) {
      var label = (i % 3 === 0) ? p.hour.slice(0, 2) : "";
      svg += '<circle class="cl-max-point" cx="' + linePts[i][0].toFixed(1) + '" cy="' + linePts[i][1].toFixed(1) + '" r="3" fill="#ff7a3d" stroke="#ffc29a" stroke-width="1"/>';
      if (label) {
        svg += '<text class="cl-date-label" x="' + linePts[i][0].toFixed(1) + '" y="' + (H - 14) +
          '" text-anchor="middle" dominant-baseline="middle">' + esc(label) + "</text>";
      }
    });
    svg += '<text x="' + (W - pr) + '" y="' + (H - 14) + '" text-anchor="end" dominant-baseline="middle" fill="rgba(160,200,240,.7)">24h</text>';
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
        point.setAttribute("r", j === i ? "5" : "3");
        point.setAttribute("stroke", j === i ? "#fff" : "#ffc29a");
      });
      tip.style.left = left.toFixed(1) + "px";
      dateLabel.textContent = selected.hour + " · " + longDate(data.forecast.date);
      maxLabel.textContent = "Temp: " + selected.c + "°C";
      minLabel.textContent = "Day: " + shortDate(data.forecast.date);
    }

    /* Start the cursor at the warmest hour (or noon for a flat line). */
    var warmest = 12;
    pts.forEach(function (p, i) { if (p.c > pts[warmest].c) warmest = i; });
    selectPoint(warmest);
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
    var wrap = root.querySelector(".cl-chart");
    var draw = function () { drawChart(wrap, data); };
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

  var lastData = null;
  /* ---------- Default (no-data) dataset ------------------------------
     The tab starts with the full layout but every value at zero / "No
     data", until a prediction date is picked in the calendar. ---------- */
  function defaultData(loc) {
    var base = loc || { city: "Selected Location", country: "" };
    var now = new Date();
    var pad = function (x) { return x < 10 ? "0" + x : "" + x; };
    var iso = now.getFullYear() + "-" + pad(now.getMonth() + 1) + "-" + pad(now.getDate());
    var trend = [];
    for (var i = 0; i < 7; i++) {
      var d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + i);
      trend.push({ date: d.getDate() + " " + MONTHS[d.getMonth()], max: 0, min: 0 });
    }
    var hourly = [];
    for (var h = 0; h < 24; h++) {
      hourly.push({ hour: (h < 10 ? "0" + h : "" + h) + ":00", c: 0 });
    }
    return {
      location: { city: base.city, country: base.country || "" },
      forecast: {
        date: iso,
        condition: "No data",
        temperature: 0,
        feelsLike: 0,
        confidence: 0,
        humidity: 0,
        windSpeed: 0,
        windDirection: "–",
        rainfallProbability: 0,
        rainfallIntensity: "No",
        aqi: 0,
        aqiStatus: "No data",
        snowfall: 0,
        maxTemperature: 0,
        minTemperature: 0
      },
      temperatureTrend: trend,
      hourlyTemperatures: hourly,
      aiInsight: "No prediction yet — pick a prediction date in the calendar and the trained MLP will fill every card in."
    };
  }

  window.ClimateDashboard = {
    mount: function (root, data) {
      lastData = data;
      root.innerHTML = predictedConditions(data) + temperatureTrendShell() + weatherOutlook(data) + aiInsight(data);
      mountTrend(root.querySelector(".cl-trend"), data);
    },
    defaultData: defaultData,
    /* Overview feed for the Generate Analysis pipeline. */
    getSeries: function () {
      if (!lastData) return { tab: "Weather Prediction", ready: false, location: "" };
      var l = lastData.location || {};
      return {
        tab: "Weather Prediction",
        ready: true,
        location: l.city + (l.country ? ", " + l.country : ""),
        forecast: lastData.forecast,
        temperatureTrend: lastData.temperatureTrend
      };
    }
  };
})();

/* ================= main.js ================= */
/**
 * Entry point. The tab starts BLANK: no data is fetched until a prediction
 * date is picked in the calendar. Picking a day runs the backend's
 * MLP-powered prediction for that exact date and the visuals render from
 * its output; the raw model output is also written as JSON under the
 * calendar (.ca-mlp-json) as human-readable text.
 */
(function () {
  var root = document.getElementById("climate-dashboard");
  if (!root) return;
  var LOCATION_KEY = "airsense:selected-location";
  var DEFAULT_LOCATION = (window.AIREC_CONFIG && window.AIREC_CONFIG.DEFAULT_LOCATION) ||
    { name: "Kolkata", latitude: 22.5726, longitude: 88.3639 };
  var fetchId = 0;
  var currentLocation = null;
  var currentDate = null;

  function readLocation() {
    try {
      var raw = window.localStorage.getItem(LOCATION_KEY);
      if (!raw) return null;
      var saved = JSON.parse(raw);
      var lat = Number(saved.lat), lon = Number(saved.lon);
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
      return { city: saved.name || "Selected Location", country: saved.region || "", lat: lat, lon: lon };
    } catch (e) { return null; }
  }

  /* ---------- Prediction overview, human-readable text under the calendar ---------- */
  function writeJsonOverview(data, err) {
    var pre = document.querySelector(".ca-mlp-json");
    if (!pre) return;
    if (err) {
      pre.textContent = "Prediction failed: " + (err.message || err);
      return;
    }
    if (!data) {
      pre.textContent = "No prediction yet — pick a date in the calendar above.";
      return;
    }
    var f = data.forecast || {};
    var when = f.date;
    try {
      var p = String(f.date).split("-");
      when = new Date(+p[0], +p[1] - 1, +p[2]).toLocaleDateString(undefined,
        { weekday: "short", day: "numeric", month: "short", year: "numeric" });
    } catch (e) { /* keep ISO date */ }
    var city = (data.location || {}).city || "your location";
    var rain = (f.rainfallProbability || 0) > 0
      ? (f.rainfallIntensity === "No" ? "a slight " + f.rainfallProbability + "% chance"
         : f.rainfallProbability + "% chance, " + String(f.rainfallIntensity || "").toLowerCase())
      : "no rain expected";
    var lines = [
      when + " · " + city,
      f.condition + " — around " + Math.round(f.temperature) + "°C" +
        (f.feelsLike ? " (feels like " + Math.round(f.feelsLike) + "°C)" : "") + ".",
      rain + " · Humidity " + Math.round(f.humidity) + "%" +
        " · Wind " + Math.round(f.windSpeed) + " km/h " + (f.windDirection || ""),
      "Air quality: " + (f.aqiStatus || "n/a") +
        (f.aqi ? " (AQI " + f.aqi + ")" : "") +
        " · Confidence: " + (f.confidence || "—") + "%",
      f.aiModel
        ? "🧠 Trained AI model — learned from " + f.aiModel.trainedOn +
          " · accuracy ±" + f.aiModel.validationMae + "°C"
        : "🧠 Trained AI model — warming up; it joins the prediction once the training data unlocks."
    ];
    if (data.aiInsight) {
      lines.push("", "Why: " + data.aiInsight);
    }
    pre.textContent = lines.join("\n");
  }

  function blankState() {
    /* Full layout, zero values — data arrives when a date is picked. */
    ClimateDashboard.mount(root, ClimateDashboard.defaultData(currentLocation));
    writeJsonOverview(null);
    fanOut("blank");
  }

  function status(msg) {
    root.innerHTML = '<div class="cl-card ' + (msg.indexOf("Loading") === 0 || msg.indexOf("Running") === 0 ? "" : "cl-error") + '">' + msg + "</div>";
  }

  /* Fan the prediction out to the other Climate Analysis tabs — Climate
     Trend and AQI Outlook render their date views from this same data. */
  function fanOut(kind, detail) {
    document.dispatchEvent(new CustomEvent("weatherly:prediction-" + kind,
      { detail: detail }));
  }

  function load(date) {
    if (!currentLocation) { blankState(); return; }
    var myId = ++fetchId;
    status("Running trained-MLP prediction for " + date + "…");
    ClimateApi.getClimateForecast(currentLocation, date)
      .then(function (data) {
        if (myId !== fetchId) return;
        ClimateDashboard.mount(root, data);
        writeJsonOverview(data);
        fanOut("data", data);
      })
      .catch(function (err) {
        if (myId !== fetchId) return;
        console.warn("Weather Prediction load failed:", err);
        status("Prediction unavailable: " + (err.message || err));
        writeJsonOverview(null, err);
        fanOut("error", { message: err.message || String(err) });
      });
  }

  /* Calendar → prediction date */
  document.addEventListener("weatherly:prediction-date", function (e) {
    var date = (e.detail || {}).date;
    if (date) {
      currentDate = date;
      load(currentDate);
    }
  });
  /* Location change: reload only if a date was already picked */
  function setLocation(loc) {
    currentLocation = loc;
    if (currentDate) {
      load(currentDate);
    } else {
      blankState();
    }
  }
  document.addEventListener("weatherly:location-change", function (e) {
    var d = e.detail || {};
    var lat = Number(d.lat !== undefined ? d.lat : d.latitude);
    var lon = Number(d.lon !== undefined ? d.lon : d.longitude);
    if (Number.isFinite(lat) && Number.isFinite(lon)) {
      setLocation({ city: d.name || "Selected Location", country: d.region || d.country || "", lat: lat, lon: lon });
    }
  });
  document.addEventListener("weatherly:device-location-active", function (e) {
    var d = e.detail || {};
    if (Number.isFinite(Number(d.latitude)) && Number.isFinite(Number(d.longitude))) {
      setLocation({ city: d.name || "Current Location", country: d.region || d.country || "", lat: Number(d.latitude), lon: Number(d.longitude) });
    }
  });

  /* Start blank: resolve the location but fetch nothing. */
  var initial = window.WeatherlyTopbar && window.WeatherlyTopbar.getLocation();
  if (initial && Number.isFinite(Number(initial.lat)) && Number.isFinite(Number(initial.lon))) {
    currentLocation = { city: initial.name || "Selected Location", country: initial.region || "", lat: Number(initial.lat), lon: Number(initial.lon) };
  } else {
    currentLocation = readLocation() ||
      { city: DEFAULT_LOCATION.name, country: "", lat: DEFAULT_LOCATION.latitude, lon: DEFAULT_LOCATION.longitude };
  }
  blankState();
})();