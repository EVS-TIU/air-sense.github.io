import logging
import os
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from .ai_chat import AiChatService
from .climate_predict import ClimatePredictService
from .config import get_settings
from .map_service import MapService
from .routes import router
from .services import WeatherClient

logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")
# HTTPX request logs include query parameters, which may contain provider API keys.
logging.getLogger("httpx").setLevel(logging.WARNING)
logging.getLogger("httpcore").setLevel(logging.WARNING)


@asynccontextmanager
async def lifespan(app: FastAPI):
    settings = get_settings()
    app.state.settings = settings
    app.state.weather = WeatherClient(settings)
    app.state.map_service = MapService(settings)
    app.state.climate_predict = ClimatePredictService(settings)
    app.state.ai_chat = AiChatService(settings, weather=app.state.weather,
                                      predictor=app.state.climate_predict)
    await app.state.weather.startup()
    await app.state.map_service.startup()
    await app.state.climate_predict.startup()
    yield
    await app.state.climate_predict.shutdown()
    await app.state.map_service.shutdown()
    await app.state.weather.shutdown()


app = FastAPI(title="AIR_SENSE Weather Intelligence API", version="1.0.0", lifespan=lifespan)
settings = get_settings()
allowed_origins = [settings.frontend_url]
deployed_frontend_origin = "https://air-sense-web.vercel.app"
if deployed_frontend_origin not in allowed_origins:
    allowed_origins.append(deployed_frontend_origin)
if settings.environment == "development":
    allowed_origins.extend(
        origin for origin in ("http://localhost:5500", "http://127.0.0.1:5500")
        if origin not in allowed_origins
    )
app.add_middleware(CORSMiddleware, allow_origins=allowed_origins, allow_credentials=False,
                   allow_origin_regex=r"https?://(localhost|127\.0\.0\.1)(:\d+)?$",
                   allow_methods=["GET", "POST"], allow_headers=["Accept", "Content-Type"])
app.include_router(router)


@app.get("/health")
async def root_health():
    return {"status": "ok"}


@app.get("/")
async def root():
    return {"status": "ok", "service": "AIR_SENSE Weather Intelligence API"}


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("app.main:app", host="0.0.0.0", port=int(os.getenv("PORT", settings.port)))