"""Tiny pure-Python MLP that learns temperature from weather drivers.

The project requires a genuine non-linear regression model, but the free
deployment target is limited to 512 MB RAM / 0.1 vCPU, where importing
scikit-learn (+116 MB measured on the dev machine) is not viable. This
module implements a small fully-connected network (tanh hidden layer,
linear output) in stdlib Python only; it trains in well under a second on
the few-hundred-sample window the climate service fetches from the archive.

The supervised task: given a day's weather drivers (daily max/min
temperature, humidity, wind, precipitation) and the season (day-of-year as
a sin/cos pair), predict that day's mean temperature. At inference the
drivers come from the provider's forecast row for the target date, so the
model acts as a learned non-linear calibration of the forecast against ten
years of reanalysis data.
"""

from __future__ import annotations

import math
import random
from datetime import date as date_type

FEATURES: tuple[str, ...] = (
    "doy_sin", "doy_cos", "t_max", "t_min", "humidity", "wind", "precip",
)
HIDDEN_UNITS = 8
EPOCHS = 300
LEARNING_RATE = 0.08
SEED = 42
MIN_TRAIN_SAMPLES = 40
HOLDOUT_FRACTION = 0.2
SEASON_DAYS = 365.25


def day_of_year(value: date_type) -> int:
    return value.timetuple().tm_yday


def circular_doy_distance(a: int, b: int) -> int:
    """Days between two day-of-year values on the 366-day ring."""
    diff = abs(a - b) % 366
    return min(diff, 366 - diff)


def build_samples(rows: list[dict], target_doy: int,
                  window_days: int = 20) -> list[dict]:
    """Turn archive rows into regression samples near the target season.

    Each row is a dict with a "date" key plus the daily archive variables.
    A sample keeps that day's drivers and label (observed mean temperature);
    humidity/wind/precipitation may be missing and are imputed later from
    the training-set mean.
    """
    samples: list[dict] = []
    for row in rows:
        try:
            day = date_type.fromisoformat(str(row.get("date")))
        except (ValueError, TypeError):
            continue
        if circular_doy_distance(day.timetuple().tm_yday, target_doy) > window_days:
            continue
        t_max = row.get("temperature_2m_max")
        t_min = row.get("temperature_2m_min")
        mean = row.get("temperature_2m_mean")
        if mean is None or t_max is None or t_min is None or t_max < t_min:
            continue
        angle = 2.0 * math.pi * day.timetuple().tm_yday / SEASON_DAYS
        samples.append({
            "doy_sin": math.sin(angle),
            "doy_cos": math.cos(angle),
            "t_max": float(t_max),
            "t_min": float(t_min),
            "humidity": _finite_or_none(row.get("relative_humidity_2m_mean")),
            "wind": _finite_or_none(row.get("wind_speed_10m_max")),
            "precip": _finite_or_none(row.get("precipitation_sum")),
            "target": float(mean),
            "date": str(row.get("date")),
        })
    samples.sort(key=lambda sample: sample["date"])
    return samples


def _finite_or_none(value: object) -> float | None:
    if isinstance(value, (int, float)) and math.isfinite(float(value)):
        return float(value)
    return None


class MLPModel:
    """7 -> HIDDEN -> 1 network plus its feature/target standardisation."""

    def __init__(self, w1: list[list[float]], b1: list[float],
                 w2: list[float], b2: float,
                 feature_mean: list[float], feature_std: list[float],
                 target_mean: float, target_std: float,
                 sample_count: int, validation_mae: float,
                 training_mae: float):
        self.w1 = w1
        self.b1 = b1
        self.w2 = w2
        self.b2 = b2
        self.feature_mean = feature_mean
        self.feature_std = feature_std
        self.target_mean = target_mean
        self.target_std = target_std
        self.sample_count = sample_count
        self.validation_mae = validation_mae
        self.training_mae = training_mae

    # ------------------------------------------------------------------ use

    def predict(self, doy: int, features: dict[str, object]) -> float | None:
        """Mean temperature in °C for a day-of-year plus raw driver values."""
        angle = 2.0 * math.pi * doy / SEASON_DAYS
        raw = {"doy_sin": math.sin(angle), "doy_cos": math.cos(angle),
               **{name: features.get(name) for name in FEATURES[2:]}}
        vector = []
        for index, name in enumerate(FEATURES):
            value = _finite_or_none(raw.get(name))
            if value is None:
                value = self.feature_mean[index]
            vector.append((value - self.feature_mean[index]) / self.feature_std[index])
        hidden = []
        for unit in range(HIDDEN_UNITS):
            acc = self.b1[unit]
            for index, x in enumerate(vector):
                acc += self.w1[unit][index] * x
            hidden.append(math.tanh(acc))
        output = self.b2 + sum(w * h for w, h in zip(self.w2, hidden))
        return output * self.target_std + self.target_mean


def train(samples: list[dict]) -> MLPModel | None:
    """Fit the MLP with full-batch gradient descent; None when unusable."""
    if len(samples) < MIN_TRAIN_SAMPLES:
        return None

    features = [[sample[name] for name in FEATURES] for sample in samples]
    targets = [sample["target"] for sample in samples]

    feature_mean, feature_std = _standardise_features(features)
    target_mean = sum(targets) / len(targets)
    spread = sum(abs(t - target_mean) for t in targets) / len(targets)
    target_std = spread if spread > 1e-6 else 1.0

    vectors = []
    for row in features:
        vector = []
        for index, value in enumerate(row):
            if value is None:
                value = feature_mean[index]
            vector.append((value - feature_mean[index]) / feature_std[index])
        vectors.append(vector)
    standard_targets = [(t - target_mean) / target_std for t in targets]

    # Hold out the most recent slice of time for an honest validation MAE.
    holdout = max(1, int(len(vectors) * HOLDOUT_FRACTION))
    train_x, train_y = vectors[:-holdout], standard_targets[:-holdout]
    valid_x, valid_y = vectors[-holdout:], standard_targets[-holdout:]

    rng = random.Random(SEED)
    w1 = [[rng.gauss(0.0, 0.4 / math.sqrt(len(FEATURES))) for _ in FEATURES]
          for _ in range(HIDDEN_UNITS)]
    b1 = [0.0] * HIDDEN_UNITS
    w2 = [0.0] * HIDDEN_UNITS
    b2 = 0.0

    for _ in range(EPOCHS):
        grad_w1 = [[0.0] * len(FEATURES) for _ in range(HIDDEN_UNITS)]
        grad_b1 = [0.0] * HIDDEN_UNITS
        grad_w2 = [0.0] * HIDDEN_UNITS
        grad_b2 = 0.0
        loss = 0.0
        for x, t in zip(train_x, train_y):
            hidden = []
            for unit in range(HIDDEN_UNITS):
                acc = b1[unit] + sum(w * xi for w, xi in zip(w1[unit], x))
                hidden.append(math.tanh(acc))
            output = b2 + sum(w * h for w, h in zip(w2, hidden))
            error = output - t
            loss += error * error
            # Backprop through the linear output and tanh hidden layer.
            grad_b2 += error
            for unit in range(HIDDEN_UNITS):
                grad_w2[unit] += error * hidden[unit]
                dh = error * w2[unit] * (1.0 - hidden[unit] ** 2)
                grad_b1[unit] += dh
                for index, xi in enumerate(x):
                    grad_w1[unit][index] += dh * xi
        if not math.isfinite(loss):
            return None
        scale = LEARNING_RATE / len(train_x)
        for unit in range(HIDDEN_UNITS):
            b1[unit] -= scale * grad_b1[unit]
            w2[unit] -= scale * grad_w2[unit]
            for index in range(len(FEATURES)):
                w1[unit][index] -= scale * grad_w1[unit][index]
        b2 -= scale * grad_b2

    def mae(xs: list[list[float]], ys: list[float]) -> float:
        total = 0.0
        for x, t in zip(xs, ys):
            hidden = [math.tanh(b1[u] + sum(w * xi for w, xi in zip(w1[u], x)))
                      for u in range(HIDDEN_UNITS)]
            output = b2 + sum(w * h for w, h in zip(w2, hidden))
            total += abs((output - t) * target_std)
        return total / len(xs)

    training_mae = mae(train_x, train_y)
    validation_mae = mae(valid_x, valid_y)
    if not (math.isfinite(training_mae) and math.isfinite(validation_mae)):
        return None
    return MLPModel(w1, b1, w2, b2, feature_mean, feature_std,
                    target_mean, target_std, len(samples),
                    validation_mae, training_mae)


def _standardise_features(features: list[list[float | None]]
                          ) -> tuple[list[float], list[float]]:
    means: list[float] = []
    stds: list[float] = []
    for column in range(len(FEATURES)):
        values = [row[column] for row in features if row[column] is not None]
        mean = sum(values) / len(values) if values else 0.0
        spread = (sum(abs(v - mean) for v in values) / len(values)) if values else 1.0
        means.append(mean)
        stds.append(spread if spread > 1e-6 else 1.0)
    return means, stds
