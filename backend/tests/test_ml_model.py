"""Unit tests for the tiny pure-Python MLP (no network, no deps)."""

import math
from datetime import date

from app.ml_model import (
    build_samples,
    circular_doy_distance,
    day_of_year,
    train,
)


def _synthetic_rows(years: int = 10, step_days: int = 5) -> list[dict]:
    """Seasonal temperature: 25 °C annual mean with an 8 °C sine amplitude."""
    rows = []
    for year in range(2026 - years, 2026):
        for day in range(1, 366, step_days):
            doy = day
            mean = 25.0 + 8.0 * math.sin(2 * math.pi * (doy - 105) / 365)
            rows.append({
                "date": date(year, 1, 1).fromordinal(date(year, 1, 1).toordinal() + day - 1).isoformat(),
                "temperature_2m_mean": mean,
                "temperature_2m_max": mean + 4.0,
                "temperature_2m_min": mean - 4.0,
                "relative_humidity_2m_mean": 60.0 + (doy % 7),
                "wind_speed_10m_max": 8.0 + (doy % 5),
                "precipitation_sum": 1.0 if doy % 10 == 0 else 0.0,
            })
    return rows


def test_circular_doy_distance_wraps():
    assert circular_doy_distance(100, 110) == 10
    assert circular_doy_distance(1, 366) == 1
    assert circular_doy_distance(360, 10) == 16


def test_day_of_year():
    assert day_of_year(date(2026, 1, 1)) == 1
    assert day_of_year(date(2026, 11, 13)) == 317


def test_build_samples_filters_window_and_invalid_rows():
    rows = _synthetic_rows(years=2)
    samples = build_samples(rows, target_doy=105, window_days=10)
    # Only days within ±10 of the target day-of-year survive, and every
    # sample has a valid label.
    assert samples
    for sample in samples:
        assert -1 <= circular_doy_distance(
            date.fromisoformat(sample["date"]).timetuple().tm_yday, 105) <= 10
        assert sample["target"] is not None
    # Missing mean or inverted min/max rows are dropped.
    assert build_samples([{"date": "2025-06-01", "temperature_2m_mean": None,
                           "temperature_2m_max": 30.0, "temperature_2m_min": 20.0}],
                         150, 30) == []
    assert build_samples([{"date": "2025-06-01", "temperature_2m_mean": 25.0,
                           "temperature_2m_max": 20.0, "temperature_2m_min": 30.0}],
                         150, 30) == []


def test_train_learns_synthetic_season():
    samples = build_samples(_synthetic_rows(), target_doy=105, window_days=25)
    assert len(samples) >= 40
    model = train(samples)
    assert model is not None
    # Validation MAE in real °C units must beat the naive mean baseline
    # (which would sit at ~5.7 °C on a ±8 °C sine).
    assert model.validation_mae < 2.0
    assert model.sample_count == len(samples)
    # Prediction near the seasonal peak of the window must be close.
    truth = 25.0 + 8.0 * math.sin(2 * math.pi * (105 - 105) / 365)
    estimate = model.predict(105, {"t_max": truth + 4.0, "t_min": truth - 4.0,
                                   "humidity": 60.0, "wind": 8.0, "precip": 0.0})
    assert abs(estimate - truth) < 3.0


def test_train_handles_constant_data():
    assert train([]) is None  # nothing to fit
    assert train([{"date": f"20{y:02d}-06-01", "temperature_2m_mean": 25.0,
                   "temperature_2m_max": 29.0, "temperature_2m_min": 21.0}
                  for y in range(10, 26)]) is None  # below the sample floor
    constant = [{"date": f"{y}-06-01", "temperature_2m_mean": 25.0,
                 "temperature_2m_max": 29.0, "temperature_2m_min": 21.0}
                for y in range(1966, 2026)]
    model = train(build_samples(constant, 152, 30))
    # Constant labels still train (std guard) and must predict ~25 °C.
    assert model is not None
    assert abs(model.predict(152, {"t_max": 29.0, "t_min": 21.0}) - 25.0) < 1.0


def test_predict_imputes_missing_drivers():
    samples = build_samples(_synthetic_rows(), target_doy=105, window_days=25)
    model = train(samples)
    assert model is not None
    estimate = model.predict(105, {})  # no drivers at all
    assert math.isfinite(estimate)
