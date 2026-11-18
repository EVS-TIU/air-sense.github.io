import sys
import types

from app.chronos_model import ChronosForecaster, clean_series


def test_clean_series_fills_gaps():
    values = [None, 1.0, None, 3.0] + [4.0] * 40
    series = clean_series(values)
    assert len(series) == len(values)
    assert series[0] == 1.0  # leading gap back-filled from the first value
    assert series[2] == 1.0  # inner gap forward-filled
    assert series[-1] == 4.0


def test_clean_series_rejects_sparse_input():
    assert clean_series([1.0, None] * 10) == []
    assert clean_series([]) == []


def test_forecast_without_checkpoint_is_skipped(tmp_path):
    forecaster = ChronosForecaster(tmp_path / "missing-model")
    assert forecaster.available is False
    assert forecaster.forecast_point([10.0] * 60, 1) is None


def test_forecast_point_with_stub_pipeline(tmp_path, monkeypatch):
    class FakeTensor:
        def __init__(self, value):
            self.value = value

        def __getitem__(self, _index):
            return self

        def __float__(self):
            return self.value

    class FakePipeline:
        def predict_quantiles(self, inputs, prediction_length, quantile_levels):
            quantiles = FakeTensor(2.0)
            mean = FakeTensor(3.0)
            return quantiles, mean

    fake_torch = types.SimpleNamespace(
        tensor=lambda data, dtype=None: data, float32="float32"
    )
    monkeypatch.setitem(sys.modules, "torch", fake_torch)

    forecaster = ChronosForecaster(tmp_path)
    forecaster._pipeline = FakePipeline()
    result = forecaster.forecast_point([10.0 + index * 0.1 for index in range(60)], 3)

    assert result is not None
    assert result["prediction"] == 2.0
    assert result["low"] == 2.0
    assert result["high"] == 2.0
    assert result["contextDays"] == 60
    assert result["stepsAhead"] == 3
