"""Optional Chronos-Bolt-mini zero-shot forecaster for daily temperature.

Chronos-Bolt (autogluon/chronos-bolt-mini, ~48M parameters) is a pretrained
time-series model: it needs no training on our data, only a context window
of recent observations. We feed it the last few months of daily mean
temperature from the Open-Meteo archive and read the quantiles it predicts
for the target day.

The model is optional. On the small deployment target importing torch is not
viable, so the pipeline is loaded lazily, only when the weights exist on
disk, and any failure degrades to the deterministic climatology blend.
"""

from __future__ import annotations

import logging
import math
import threading
from pathlib import Path
from typing import Sequence

logger = logging.getLogger(__name__)

MODEL_NAME = "chronos-bolt-mini"
DEFAULT_MODEL_DIR = Path(__file__).resolve().parents[1] / "models" / MODEL_NAME
DEFAULT_QUANTILES = (0.1, 0.5, 0.9)
MIN_CONTEXT_POINTS = 32
MAX_CONTEXT_POINTS = 1024


def clean_series(values: Sequence[object]) -> list[float]:
    """Return a gap-filled float series, or [] when too much data is missing.

    Missing values are forward-filled (then back-filled at the start) so the
    daily spacing Chronos expects is preserved.
    """
    numbers: list[float | None] = []
    for value in values:
        if isinstance(value, (int, float)) and math.isfinite(float(value)):
            numbers.append(float(value))
        else:
            numbers.append(None)
    if not numbers:
        return []
    present = sum(1 for value in numbers if value is not None)
    if present < max(MIN_CONTEXT_POINTS, int(len(numbers) * 0.6)):
        return []
    first_real = next(value for value in numbers if value is not None)
    last = first_real
    filled: list[float] = []
    for value in numbers:
        if value is not None:
            last = value
        filled.append(last)
    return filled


class ChronosForecaster:
    """Lazy wrapper around a local Chronos-Bolt checkpoint."""

    def __init__(self, model_path: str | Path | None = None, device: str = "cpu"):
        self.model_path = Path(model_path) if model_path else DEFAULT_MODEL_DIR
        self.device = device
        self._pipeline = None
        self._failed = False
        self._lock = threading.Lock()

    @property
    def available(self) -> bool:
        """True when the checkpoint exists and loading has not failed yet."""
        return not self._failed and self.model_path.exists()

    def _load(self):
        with self._lock:
            if self._pipeline is not None or self._failed:
                return self._pipeline
            try:
                import torch  # noqa: PLC0415 - optional heavy dependency
                from chronos import BaseChronosPipeline  # noqa: PLC0415

                self._pipeline = BaseChronosPipeline.from_pretrained(
                    str(self.model_path), device_map=self.device, torch_dtype=torch.float32
                )
                logger.info("Chronos-Bolt loaded from %s", self.model_path)
            except Exception as exc:  # missing torch/chronos or bad checkpoint
                self._failed = True
                logger.warning("Chronos-Bolt unavailable (%s); continuing without it", exc)
            return self._pipeline

    def forecast_point(
        self,
        history: Sequence[float],
        steps_ahead: int,
        quantiles: Sequence[float] = DEFAULT_QUANTILES,
    ) -> dict | None:
        """Predict the value `steps_ahead` days after the end of `history`.

        Returns the median, the low/high quantiles and the model mean, or
        None when the model cannot run. Never raises.
        """
        if not self.available:
            return None
        context = [float(value) for value in history if math.isfinite(float(value))]
        if len(context) < MIN_CONTEXT_POINTS:
            return None
        context = context[-MAX_CONTEXT_POINTS:]
        horizon = max(1, int(steps_ahead))
        pipeline = self._load()
        if pipeline is None:
            return None
        try:
            import torch  # noqa: PLC0415

            tensor = torch.tensor([context], dtype=torch.float32)
            levels = list(quantiles)
            predicted, mean = pipeline.predict_quantiles(
                inputs=tensor, prediction_length=horizon, quantile_levels=levels
            )
            index = horizon - 1
            median = float(predicted[0, index, levels.index(0.5)]) if 0.5 in levels else float(mean[0, index])
            low = float(predicted[0, index, levels.index(min(levels))])
            high = float(predicted[0, index, levels.index(max(levels))])
            if not all(math.isfinite(value) for value in (median, low, high)):
                return None
            return {
                "model": MODEL_NAME,
                "prediction": round(median, 2),
                "low": round(low, 2),
                "high": round(high, 2),
                "mean": round(float(mean[0, index]), 2),
                "contextDays": len(context),
                "stepsAhead": horizon,
            }
        except Exception as exc:  # inference must never break a prediction
            logger.warning("Chronos-Bolt inference failed: %s", exc)
            return None
