/* ==========================================================================
   AirSense — frontend logic
   ========================================================================== */

const API_BASE_URL = "http://localhost:8000/api";

const searchForm = document.querySelector("#search-form");
const cityInput = document.querySelector("#city-input");
const results = document.querySelector("#results");
const year = document.querySelector("#year");

year.textContent = new Date().getFullYear();

/**
 * Fetch JSON from the backend and throw a readable error on failure.
 * @param {string} path
 * @returns {Promise<unknown>}
 */
async function apiGet(path) {
  const response = await fetch(`${API_BASE_URL}${path}`);

  if (!response.ok) {
    const message = await response.text();
    throw new Error(message || `Request failed (${response.status})`);
  }

  return response.json();
}

/**
 * Render a simple card into the results area.
 * @param {string} title
 * @param {string} body
 */
function renderCard(title, body) {
  const card = document.createElement("article");
  card.className = "card";

  const heading = document.createElement("h2");
  heading.textContent = title;

  const paragraph = document.createElement("p");
  paragraph.textContent = body;

  card.append(heading, paragraph);
  results.append(card);
}

searchForm.addEventListener("submit", async (event) => {
  event.preventDefault();

  const city = cityInput.value.trim();
  if (!city) return;

  results.replaceChildren();
  renderCard(city, "Loading…");

  try {
    const [weather, airQuality] = await Promise.all([
      apiGet(`/weather?city=${encodeURIComponent(city)}`),
      apiGet(`/air-quality?city=${encodeURIComponent(city)}`),
    ]);

    results.replaceChildren();
    renderCard("Weather", JSON.stringify(weather, null, 2));
    renderCard("Air quality", JSON.stringify(airQuality, null, 2));
  } catch (error) {
    results.replaceChildren();
    renderCard("Something went wrong", error.message);
  }
});
