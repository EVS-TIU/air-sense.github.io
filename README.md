# AIR_SENSE

AIR_SENSE is a location-aware weather dashboard with a small FastAPI backend.
The backend uses OpenWeather for current conditions, forecasts, geocoding, and
air quality, then generates transparent rule-based recommendations.

See [docs/api.md](docs/api.md) for setup, endpoint examples, tests, Docker, and
deployment instructions. Start the backend locally with:

```bash
cd backend
python -m venv .venv && . .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env
uvicorn app.main:app --reload --port 8000
```

Set `OPENWEATHER_API_KEY` in the environment; never put credentials in
frontend JavaScript or source control.