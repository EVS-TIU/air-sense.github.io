import logging
import os
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from .config import get_settings
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
    await app.state.weather.startup()
    yield
    await app.state.weather.shutdown()


app = FastAPI(title="AIR_SENSE Weather Intelligence API", version="1.0.0", lifespan=lifespan)
settings = get_settings()
allowed_origins = [settings.frontend_url]
if settings.environment == "development":
    allowed_origins.extend(
        origin for origin in ("http://localhost:5500", "http://127.0.0.1:5500")
        if origin not in allowed_origins
    )
app.add_middleware(CORSMiddleware, allow_origins=allowed_origins, allow_credentials=False,
                   allow_methods=["GET"], allow_headers=["Accept", "Content-Type"])
app.include_router(router)


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("app.main:app", host="0.0.0.0", port=int(os.getenv("PORT", settings.port)))