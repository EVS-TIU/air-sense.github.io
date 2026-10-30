# AIR SENSE

Weather + air quality app.

## Structure

```
AIR_SENSE/
├── frontend/
│   ├── index.html          # page layout
│   ├── css/
│   │   └── style.css       # styling
│   ├── js/
│   │   └── app.js          # frontend logic
│   └── assets/
│       ├── images/         # photos, illustrations
│       ├── icons/          # favicon, UI icons
│       └── fonts/          # custom fonts
├── backend/
│   ├── app/
│   │   ├── main.py         # FastAPI app + CORS
│   │   ├── config.py       # environment settings
│   │   ├── routes.py       # API endpoints
│   │   └── services.py     # weather / AQI providers
│   ├── tests/
│   ├── requirements.txt
│   ├── Dockerfile
│   └── .env.example
├── docs/
├── docker-compose.yml
├── .gitignore
└── README.md
```

## Frontend

Open `frontend/index.html` in a browser, or serve the folder:

```bash
cd frontend
python -m http.server 5500
```

Then visit <http://localhost:5500>.

## Backend

```bash
cd backend
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env        # add your API keys
uvicorn app.main:app --reload
```

API docs: <http://localhost:8000/docs> — health check: <http://localhost:8000/health>.

## Docker

```bash
cp backend/.env.example backend/.env
docker compose up --build
```
