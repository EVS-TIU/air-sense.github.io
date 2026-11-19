/* ============================================================
   AirSense - Weather Chat config. Put your keys here.
   Keys in browser JS are visible to every visitor. Before going
   live, move the LLM call behind your own server / serverless route.
   ============================================================ */
window.AIREC_CONFIG = {
  // Weather: Open-Meteo is free for non-commercial use with no key.
  // For commercial use, paste your Open-Meteo API key here.
  WEATHER_API_KEY: "",

  // LLM explanation layer: "anthropic" | "gemini" | "openai"
  // ("openai" = any OpenAI-compatible API such as Groq, OpenRouter or Together)
  LLM_PROVIDER: "anthropic",
  LLM_API_KEY: "",                 // <-- paste your LLM key here
  LLM_MODEL: "claude-haiku-5-5",   // gemini example: "gemini-2.5-flash-lite"; verify the model name with your provider
  LLM_BASE_URL: "",                // only for "openai", e.g. "https://api.groq.com/openai/v1"

  CACHE_MINUTES: 30,               // reuse the last result for the same place (spec: current weather goes stale after 30 min)

  // Used when the user denies location access
  DEFAULT_LOCATION: { name: "Kolkata", latitude: 22.5726, longitude: 88.3639 }
};

/* Several widgets on a page ask for /weather/current at the same time with
   the same coordinates. Share one in-flight request so a page load doesn't
   fire the same network call two or three times. */
window.WeatherlyCurrent = (function () {
  var inFlight = Object.create(null);

  return {
    fetch: function (apiBase, latitude, longitude, includeLocation, timeoutMs) {
      var base = String(apiBase).replace(/\/+$/, "");
      var lat = Number(latitude), lon = Number(longitude);
      var key = [base, lat.toFixed(4), lon.toFixed(4), includeLocation ? "1" : "0"].join("|");
      if (inFlight[key]) return inFlight[key];

      var url = new URL(base + "/weather/current", window.location.href);
      url.searchParams.set("latitude", String(lat));
      url.searchParams.set("longitude", String(lon));
      if (includeLocation) url.searchParams.set("include_location", "true");

      var controller = typeof AbortController !== "undefined" ? new AbortController() : null;
      var timer = controller && timeoutMs ? setTimeout(function () { controller.abort(); }, timeoutMs) : null;
      var init = { headers: { Accept: "application/json" }, mode: "cors" };
      if (controller) init.signal = controller.signal;

      var request = fetch(url.toString(), init).then(function (response) {
        if (!response.ok) {
          return response.json().then(function (body) {
            throw new Error((body && body.detail) || "Weather request failed (" + response.status + ")");
          }).catch(function () {
            throw new Error("Weather request failed (" + response.status + ")");
          });
        }
        return response.json();
      }).finally(function () {
        if (timer) clearTimeout(timer);
      });

      inFlight[key] = request;
      request.then(function () { delete inFlight[key]; }, function () { delete inFlight[key]; });
      return request;
    }
  };
})();