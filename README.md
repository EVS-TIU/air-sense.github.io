# AIR_SENSE

AIR_SENSE is a location-aware weather dashboard with a small FastAPI backend.
The backend uses Open-Meteo as the primary weather and modelled air-quality
source, keeps OpenWeather as the existing weather fallback, and can validate
modelled AQI against separate WAQI and OpenAQ station readings.

See [docs/api.md](docs/api.md) for setup, endpoint examples, tests, Docker, and
deployment instructions. Start the backend locally with:

```bash
cd backend
python3 -m venv .venv && . .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env
uvicorn app.main:app --reload --port 8000
```

Set `OPENWEATHER_API_KEY` in the environment; never put credentials in
frontend JavaScript or source control.

For local frontend testing, set a real `OPENWEATHER_API_KEY` in
`backend/.env`, then start the backend and frontend manually in two terminals.
A localhost frontend automatically calls the local API on port 8000.

Terminal 1 — backend API:

```bash
cd backend
. .venv/bin/activate
uvicorn app.main:app --reload --host 127.0.0.1 --port 8000
```

Terminal 2 — frontend server:

```bash
cd frontend
python3 -m http.server 5500 --bind 127.0.0.1
```

Open [http://127.0.0.1:5500/index.html](http://127.0.0.1:5500/index.html) in
your browser. Stop either server with `Ctrl+C`.
