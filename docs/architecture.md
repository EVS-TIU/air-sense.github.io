# Architecture

```
Browser (frontend/)
   │  fetch() JSON
   ▼
FastAPI (backend/app/)
   ├── routes.py    → validates requests
   ├── services.py  → calls weather / AQI providers
   └── config.py    → reads .env
```

The frontend is plain HTML/CSS/JS and can be served by any static server.
The backend exposes JSON under `/api` and a `/health` check.

## Next steps

1. Pick providers (e.g. OpenWeatherMap for weather, OpenAQ for air quality).
2. Implement `backend/app/services.py`.
3. Replace the placeholder cards in `frontend/js/app.js` with real UI.
