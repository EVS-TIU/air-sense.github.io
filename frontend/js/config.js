/* ============================================================
   AirSense - AI Recommendation config. Put your keys here.
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