# API reference

Base URL: `http://localhost:8000`

| Method | Path               | Query        | Description                    |
| ------ | ------------------ | ------------ | ------------------------------ |
| GET    | `/health`          | —            | Liveness check                 |
| GET    | `/api/weather`     | `city`       | Current weather for a city     |
| GET    | `/api/air-quality` | `city`       | Current air quality for a city |

Interactive docs: `/docs` (Swagger UI) and `/redoc`.
