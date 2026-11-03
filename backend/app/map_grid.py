from __future__ import annotations

import math
from dataclasses import dataclass

# Degree steps are a ladder rather than arbitrary values so adjacent viewports
# produce identical grids and can share the backend cache.
STEP_LADDER = (0.02, 0.05, 0.1, 0.2, 0.25, 0.4, 0.5, 0.8, 1.0, 2.0, 2.5, 5.0, 10.0, 15.0, 30.0)
MIN_LATITUDE = -85.0
MAX_LATITUDE = 85.0
MAX_GRID_SIZE = 64


@dataclass(frozen=True)
class GridSegment:
    bbox: tuple[float, float, float, float]
    latitudes: tuple[float, ...]
    longitudes: tuple[float, ...]
    resolution_deg: float

    @property
    def columns(self) -> int:
        return len(self.longitudes)

    @property
    def rows(self) -> int:
        return len(self.latitudes)

    @property
    def points(self) -> list[tuple[float, float]]:
        return [(lat, lon) for lat in self.latitudes for lon in self.longitudes]


def _normalize_longitude(lon: float) -> float:
    return ((lon + 180.0) % 360.0) - 180.0


def _target_columns(zoom: int) -> int:
    if zoom <= 2:
        return 12
    if zoom <= 5:
        return 16
    if zoom <= 8:
        return 20
    return 28


def _normalize_bbox(
    west: float, south: float, east: float, north: float
) -> list[tuple[float, float, float, float]]:
    values = (west, south, east, north)
    if not all(math.isfinite(value) for value in values):
        raise ValueError("bbox values must be finite numbers")

    if south > north:
        south, north = north, south
    south = max(MIN_LATITUDE, south)
    north = min(MAX_LATITUDE, north)
    if north - south <= 0:
        raise ValueError("bbox latitude span must be greater than zero")

    span = east - west
    if span < 0:
        # A Leaflet viewport that crosses the antimeridian can arrive as
        # west=170, east=-170.
        span += 360.0
    if span <= 0:
        raise ValueError("bbox longitude span must be greater than zero")
    span = min(span, 360.0)

    west = _normalize_longitude(west)
    east = west + span
    if span >= 360.0:
        return [(-180.0, south, 180.0, north)]
    if east > 180.0:
        return [
            (west, south, 180.0, north),
            (-180.0, south, east - 360.0, north),
        ]
    return [(west, south, east, north)]


def _choose_step(
    lon_span: float,
    lat_span: float,
    zoom: int,
    max_points: int,
    minimum_step: float = STEP_LADDER[0],
) -> float:
    target_columns = _target_columns(zoom)
    desired = lon_span / max(1, target_columns - 1)
    step = next(
        (candidate for candidate in STEP_LADDER if candidate >= max(desired, minimum_step)),
        STEP_LADDER[-1],
    )

    while True:
        columns = max(2, min(MAX_GRID_SIZE, math.ceil(lon_span / step) + 1))
        rows = max(2, min(MAX_GRID_SIZE, math.ceil(lat_span / step) + 1))
        if columns * rows <= max_points:
            return step
        larger = [candidate for candidate in STEP_LADDER if candidate > step]
        if not larger:
            return step
        step = larger[0]


def _lattice_counts(
    step: float,
    west: float,
    south: float,
    east: float,
    north: float,
) -> tuple[int, int, int, int]:
    """Lattice indices and counts for one step over a viewport.

    Returns ``(columns, rows, first_lon_index, first_lat_index)`` so callers
    can reproduce the exact sample coordinates without recomputing bounds.
    """
    first_lon = math.floor(west / step)
    last_lon = math.ceil(east / step)
    first_lat = max(math.ceil(MIN_LATITUDE / step), math.floor(south / step))
    last_lat = min(math.floor(MAX_LATITUDE / step), math.ceil(north / step))
    columns = max(1, last_lon - first_lon + 1)
    rows = max(1, last_lat - first_lat + 1)
    return columns, rows, first_lon, first_lat


def _choose_lattice_step(
    west: float,
    south: float,
    east: float,
    north: float,
    max_points: int,
    minimum_step: float,
) -> float:
    """Choose the finest fixed-lattice step that fits the viewport budget.

    Native-grid callers (AQI) want every real model cell the sampling budget
    can afford: zoom alone must not thin the lattice. The chosen step only
    coarsens when the raw viewport span genuinely exceeds the budget.
    """
    start = next(
        (index for index, candidate in enumerate(STEP_LADDER) if candidate >= minimum_step),
        len(STEP_LADDER) - 1,
    )
    for index in range(start, len(STEP_LADDER)):
        candidate = STEP_LADDER[index]
        columns, rows, _, _ = _lattice_counts(candidate, west, south, east, north)
        if columns * rows <= max_points and max(columns, rows) <= MAX_GRID_SIZE:
            return candidate
    return STEP_LADDER[-1]


def build_grid_segments(
    west: float,
    south: float,
    east: float,
    north: float,
    zoom: int,
    max_points: int = 400,
    minimum_step: float = STEP_LADDER[0],
) -> list[GridSegment]:
    """Build a zoom-aware coordinate grid for a visible map viewport.

    Longitude spans that cross the antimeridian are split into two segments so
    every coordinate remains within [-180, 180]. Latitude is clamped to the
    Web-Mercator-safe range.
    """
    boxes = _normalize_bbox(west, south, east, north)
    segments: list[GridSegment] = []

    # Divide the point budget between the two antimeridian segments.
    per_box_max = max(4, max_points // max(1, len(boxes)))
    for box_west, box_south, box_east, box_north in boxes:
        lon_span = box_east - box_west
        lat_span = box_north - box_south
        step = _choose_step(lon_span, lat_span, zoom, per_box_max, minimum_step)
        columns = max(2, min(MAX_GRID_SIZE, math.ceil(lon_span / step) + 1))
        rows = max(2, min(MAX_GRID_SIZE, math.ceil(lat_span / step) + 1))

        longitudes = tuple(
            box_west + lon_span * index / (columns - 1) for index in range(columns)
        )
        latitudes = tuple(
            box_south + lat_span * index / (rows - 1) for index in range(rows)
        )
        segments.append(
            GridSegment(
                bbox=(box_west, box_south, box_east, box_north),
                latitudes=latitudes,
                longitudes=longitudes,
                resolution_deg=step,
            )
        )

    return segments


def build_native_grid_segments(
    west: float,
    south: float,
    east: float,
    north: float,
    zoom: int,
    max_points: int = 400,
    minimum_step: float = 0.4,
) -> list[GridSegment]:
    """Build a viewport grid whose sample coordinates follow a fixed degree lattice.

    AQI callers set ``minimum_step`` to the provider's native CAMS spacing so
    zooming never requests or displays invented sub-grid detail.
    """
    boxes = _normalize_bbox(west, south, east, north)
    per_box_max = max(4, max_points // max(1, len(boxes)))
    segments: list[GridSegment] = []

    for box_west, box_south, box_east, box_north in boxes:
        step = _choose_lattice_step(
            box_west, box_south, box_east, box_north, per_box_max, minimum_step
        )

        while True:
            longitude_count, latitude_count, first_lon, first_lat = _lattice_counts(
                step, box_west, box_south, box_east, box_north
            )
            if longitude_count * latitude_count <= per_box_max and max(longitude_count, latitude_count) <= MAX_GRID_SIZE:
                break
            larger = next((candidate for candidate in STEP_LADDER if candidate > step), None)
            if larger is None:
                break
            step = larger

        longitudes = tuple((first_lon + index) * step for index in range(longitude_count))
        latitudes = tuple((first_lat + index) * step for index in range(latitude_count))
        segments.append(
            GridSegment(
                bbox=(
                    max(-180.0, longitudes[0] - step / 2),
                    max(MIN_LATITUDE, latitudes[0] - step / 2),
                    min(180.0, longitudes[-1] + step / 2),
                    min(MAX_LATITUDE, latitudes[-1] + step / 2),
                ),
                latitudes=latitudes,
                longitudes=longitudes,
                resolution_deg=step,
            )
        )

    return segments
