/* Chains the steps: location -> weather API -> validation -> rule engine -> AI explanation -> UI. */
(function () {
  const C = window.AIREC_CONFIG, Wx = window.AIREC_WEATHER, E = window.AIREC_ENGINE, L = window.AIREC_LLM;
  const $ = s => document.querySelector(s);
  const esc = s => String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const searchInput = $("#searchInput");
  const suggestions = $("#citySuggestions");

  const PLABEL = { P0: "P0 Critical", P1: "P1 High", P2: "P2 Moderate", P3: "P3 Low", P4: "P4 Info" };
  const SLABEL = { SUITABLE: "Suitable", CAUTION: "Caution", NOT_RECOMMENDED: "Not recommended", INSUFFICIENT_DATA: "Insufficient data" };
  const TILES = [
    ["temperature_c", "Temperature", "°C"], ["feels_like_c", "Feels like", "°C"], ["humidity_percent", "Humidity", "%"],
    ["uv_index", "UV index", ""], ["rain_mm_hr", "Rain now", "mm/hr"], ["rain_probability_percent", "Rain chance", "%"],
    ["wind_speed_kmh", "Wind", "km/h"], ["wind_gust_kmh", "Gusts", "km/h"], ["cloud_percent", "Cloud cover", "%"],
    ["visibility_km", "Visibility", "km"], ["us_aqi", "US AQI", ""]
  ];

  let current = null, busy = false, pendingPlace = null;
  let searchTimer = null, searchRequest = 0, activeSuggestion = -1;
  let suggestedPlaces = [];

  const setStep = (name, state) => { const li = $(`#pipeline [data-step="${name}"]`); if (li) li.dataset.state = state; };
  const resetSteps = () => document.querySelectorAll("#pipeline li").forEach(li => (li.dataset.state = ""));
  const notice = msg => { const n = $("#notice"); n.hidden = !msg; n.textContent = msg || ""; };
  const setPlace = (name, sub) => { $("#locName").textContent = name; $("#locSub").textContent = sub; };
  const fmtTime = iso => (iso ? iso.slice(0, 10) + " " + iso.slice(11, 16) + " (UTC" + iso.slice(19) + ")" : "n/a");

  function render(res, ai) {
    const s = res.weather_summary;
    $("#condition").textContent = s.condition;
    $("#updated").textContent = "Observed " + fmtTime(res.observed_at) + " · rules v" + res.rule_version;
    $("#tiles").innerHTML = TILES.map(([k, label, unit]) => {
      const v = s[k], cls = s.labels[k];
      return `<div class="tile${v == null ? " na" : ""}"><span class="t-label">${label}</span>` +
        `<strong>${v == null ? "Unavailable" : esc(v) + (unit ? "<small> " + unit + "</small>" : "")}</strong>` +
        `<span class="t-class">${cls ? esc(cls) : ""}</span></div>`;
    }).join("");

    const badge = $("#riskBadge");
    badge.textContent = res.overall_risk; badge.dataset.risk = res.overall_risk;
    const top = res.recommendations[0];
    $("#summaryText").textContent = (ai && ai.summary) || (top ? `Top priority: ${top.title}. ${top.reason}.` : "Not enough valid, current data to give a recommendation.");
    $("#summaryNote").textContent = ai && ai.summary ? "Written by the AI from the approved results below." : (L.enabled() ? "AI summary unavailable; showing the rule-engine result." : "Rule-engine result. Add an LLM key in js/config.js for written explanations.");

    $("#recList").innerHTML = res.recommendations.length ? res.recommendations.map(r => {
      const exp = ai && ai.byId && ai.byId[r.id];
      return `<article class="glass rec" data-p="${r.priority}">
        <header><span class="chip">${PLABEL[r.priority]}</span><h3>${esc(r.title)}</h3></header>
        <p class="reason">${esc(r.reason)}</p>
        <p class="action">${esc(r.action)}</p>
        ${exp ? `<p class="ai"><b>AI explanation</b>${esc(exp)}</p>` : ""}
        <footer><span class="tag">${esc(r.id)}</span>${r.triggered_by.map(t => `<span class="tag">${esc(t)}</span>`).join("")}<span>Valid until ${esc(fmtTime(r.valid_until))}</span></footer>
      </article>`;
    }).join("") : `<p class="glass empty">No recommendations could be produced from the valid, current data. See data limitations below.</p>`;

    $("#actGrid").innerHTML = res.activities.map(a => `<div class="glass act"><h3>${esc(a.activity)}</h3><span class="status" data-s="${a.status}">${SLABEL[a.status]}</span><p>${esc(a.note)}</p></div>`).join("");
    $("#limList").innerHTML = res.data_limitations.map(l => `<li>${esc(l)}</li>`).join("");
  }

  async function go(place, force) {
    if (busy) {
      pendingPlace = { place, force };
      return;
    }
    busy = true; resetSteps(); notice("");
    document.querySelectorAll(".search .btn").forEach(b => (b.disabled = true));
    const { lat, lon } = place;
    current = place;
    setPlace(place.name || `${lat.toFixed(2)}, ${lon.toFixed(2)}`, `${lat.toFixed(3)}, ${lon.toFixed(3)}`);
    const key = `airec-v2:${lat.toFixed(2)},${lon.toFixed(2)}`;

    try {
      if (!force) {
        try {
          const c = JSON.parse(localStorage.getItem(key));
          if (c && Date.now() - c.t < C.CACHE_MINUTES * 60000) {
            render(c.res, c.ai);
            ["fetch", "validate", "rules", "ai", "ui"].forEach(s => setStep(s, "done"));
            if (c.name) setPlace(c.name, `${lat.toFixed(3)}, ${lon.toFixed(3)}`);
            return;
          }
        } catch (e) { /* ignore bad cache */ }
      }

      const namePromise = place.name ? Promise.resolve(place.name) : Wx.reverse(lat, lon).catch(() => null);
      setStep("fetch", "active");
      let raw;
      try { raw = await Wx.fetchWeather(lat, lon); }
      catch (e) { setStep("fetch", "error"); notice(e.message + ". Check your connection and try Refresh."); return; }
      setStep("fetch", "done"); setStep("validate", "done");

      const name = (await namePromise) || place.name;
      if (name) setPlace(name, `${lat.toFixed(3)}, ${lon.toFixed(3)}`);

      setStep("rules", "active");
      const res = E.evaluate(raw);
      setStep("rules", "done");
      render(res, null); setStep("ui", "done");

      let ai = null;
      if (L.enabled()) {
        setStep("ai", "active");
        try { ai = await L.explain(res); setStep("ai", "done"); render(res, ai); }
        catch (e) { setStep("ai", "error"); notice("AI explanation unavailable (" + e.message + "). Showing the approved rule-engine wording."); }
      } else setStep("ai", "skipped");

      try { localStorage.setItem(key, JSON.stringify({ t: Date.now(), res, ai, name })); } catch (e) { /* storage full or blocked */ }
    } finally {
      busy = false;
      document.querySelectorAll(".search .btn").forEach(b => (b.disabled = false));
      if (pendingPlace) {
        const next = pendingPlace;
        pendingPlace = null;
        go(next.place, next.force);
      }
    }
  }

  function fallback(msg) {
    const d = C.DEFAULT_LOCATION;
    go({ lat: d.latitude, lon: d.longitude, name: d.name });
    notice(msg + " Showing " + d.name + ". Search a city to change it.");
  }

  function useGPS() {
    setPlace("Finding your location", "Waiting for device location");
    if (!navigator.geolocation) return fallback("Location is not supported in this browser.");
    navigator.geolocation.getCurrentPosition(
      p => go({ lat: p.coords.latitude, lon: p.coords.longitude }),
      () => fallback("Location permission was denied or unavailable."),
      { timeout: 10000, maximumAge: 600000 }
    );
  }

  function closeSuggestions() {
    suggestions.hidden = true;
    searchInput.setAttribute("aria-expanded", "false");
    searchInput.removeAttribute("aria-activedescendant");
    activeSuggestion = -1;
  }

  function renderSuggestions(places) {
    suggestedPlaces = places;
    activeSuggestion = -1;
    suggestions.innerHTML = places.map((place, index) =>
      `<li role="presentation"><button id="city-suggestion-${index}" class="city-suggestion" type="button" role="option" aria-selected="false" data-index="${index}">${esc(place.name)}</button></li>`
    ).join("");
    suggestions.hidden = places.length === 0;
    searchInput.setAttribute("aria-expanded", String(places.length > 0));
  }

  function setActiveSuggestion(index) {
    const options = suggestions.querySelectorAll('[role="option"]');
    if (!options.length) return;
    activeSuggestion = (index + options.length) % options.length;
    options.forEach((option, optionIndex) => {
      const active = optionIndex === activeSuggestion;
      option.setAttribute("aria-selected", String(active));
      if (active) {
        searchInput.setAttribute("aria-activedescendant", option.id);
        option.scrollIntoView({ block: "nearest" });
      }
    });
  }

  function chooseSuggestion(index) {
    const place = suggestedPlaces[index];
    if (!place) return;
    clearTimeout(searchTimer);
    searchRequest++;
    searchInput.value = place.name;
    closeSuggestions();
    go(place);
  }

  searchInput.addEventListener("input", () => {
    clearTimeout(searchTimer);
    const query = searchInput.value.trim();
    suggestedPlaces = [];
    closeSuggestions();
    suggestions.replaceChildren();
    if (query.length < 2) return;

    const request = ++searchRequest;
    searchTimer = setTimeout(async () => {
      try {
        const places = await Wx.suggest(query);
        if (request !== searchRequest || searchInput.value.trim() !== query) return;
        renderSuggestions(places);
      } catch (error) {
        if (request !== searchRequest) return;
        closeSuggestions();
        notice("City suggestions are unavailable. You can still submit your search.");
      }
    }, 250);
  });

  searchInput.addEventListener("keydown", event => {
    if (event.key === "ArrowDown" && !suggestions.hidden) {
      event.preventDefault();
      setActiveSuggestion(activeSuggestion + 1);
    } else if (event.key === "ArrowUp" && !suggestions.hidden) {
      event.preventDefault();
      setActiveSuggestion(activeSuggestion < 0 ? suggestedPlaces.length - 1 : activeSuggestion - 1);
    } else if (event.key === "Enter" && activeSuggestion >= 0 && !suggestions.hidden) {
      event.preventDefault();
      chooseSuggestion(activeSuggestion);
    } else if (event.key === "Escape" && !suggestions.hidden) {
      closeSuggestions();
    }
  });

  suggestions.addEventListener("click", event => {
    const option = event.target.closest("[data-index]");
    if (option) chooseSuggestion(Number(option.dataset.index));
  });
  document.addEventListener("click", event => {
    if (!event.target.closest(".city-search")) closeSuggestions();
  });

  $("#searchForm").addEventListener("submit", async e => {
    e.preventDefault();
    const q = $("#searchInput").value.trim();
    if (!q) return;
    if (activeSuggestion >= 0 && !suggestions.hidden) {
      chooseSuggestion(activeSuggestion);
      return;
    }
    closeSuggestions();
    try { const p = await Wx.geocode(q); go({ lat: p.lat, lon: p.lon, name: p.name }); }
    catch (err) { notice(err.message); }
  });
  $("#gpsBtn").addEventListener("click", useGPS);
  $("#refreshBtn").addEventListener("click", () => current ? go(current, true) : useGPS());

  // Optional: the main page can link here with ?lat=..&lon=..&name=..
  const q = new URLSearchParams(location.search);
  if (q.get("lat") && q.get("lon") && isFinite(+q.get("lat")) && isFinite(+q.get("lon"))) go({ lat: +q.get("lat"), lon: +q.get("lon"), name: q.get("name") || null });
  else useGPS();
})();