/* ==========================================================================
   AirSense — scalar weather layer renderer
   Converts the backend's regular lat/lon value grid into a smooth Canvas
   image and places it on the existing Leaflet map as an image overlay.

   Rendering model (Ventusky-style continuous fields, honest values):
   - One measured source value per real model cell. Colours come only from
     `AirSensePalettes.colorFor` of the actual sample values.
   - The overlay bbox is the sample lattice expanded by half a cell on every
     side, so a sample's colour sits at its pixel *centre* and bilinear
     upscaling interpolates exactly between measured sample centres — never
     beyond the data.
   - Rows are resampled onto Mercator y (Leaflet's projection) so the field
     stays geographically aligned at every zoom, including the world view.
   - The API matrix is `values[variable][row][column]` with row 0 at the
     southern edge, while Canvas row 0 is the northern edge — the renderer
     samples in geographic (south-up) space, which fixes that implicitly.
   - AQI alpha fades out across the half-cell margin at the outer coverage
     edge only, so the layer ends where the data ends without rectangle
     borders at interior seams (e.g. the antimeridian split).
   ========================================================================== */
(function () {
    'use strict';

    const MAX_CANVAS = 384;
    const MERCATOR_LAT_MAX = 85.0511287798066;

    function ensureWeatherPane(map) {
        let pane = map.getPane('weatherPane');
        if (!pane) {
            pane = map.createPane('weatherPane');
            pane.style.zIndex = '350';
            pane.style.pointerEvents = 'none';
        }
        return pane;
    }

    function hasData(payload, mode) {
        const variable = window.AirSensePalettes.MODES[mode]?.variable;
        if (!variable || !payload?.segments) return false;
        return payload.segments.some((segment) => {
            const rows = segment.values?.[variable];
            if (!Array.isArray(rows)) return false;
            return rows.some((row) => Array.isArray(row) &&
                row.some((value) => value !== null && value !== undefined && Number.isFinite(Number(value))));
        });
    }

    function toFiniteNumber(value) {
        const numeric = Number(value);
        return Number.isFinite(numeric) ? numeric : null;
    }

    function normalizeLongitude(lon) {
        let normalized = lon % 360;
        if (normalized > 180) normalized -= 360;
        if (normalized < -180) normalized += 360;
        return normalized;
    }

    function normalizedMercatorY(lat) {
        const clamped = Math.max(-MERCATOR_LAT_MAX, Math.min(MERCATOR_LAT_MAX, lat));
        return Math.log(Math.tan(Math.PI / 4 + (clamped * Math.PI / 180) / 2)) / (2 * Math.PI);
    }

    function latitudeFromNormalizedMercatorY(y) {
        const angle = y * 2 * Math.PI;
        return (Math.atan(Math.exp(angle)) * 2 - Math.PI / 2) * 180 / Math.PI;
    }

    /* Bilinear sample of the lattice in fractional row/column coordinates.
       Returns null when any contributing sample is missing so a hole in the
       data stays transparent instead of borrowing a neighbour's value. */
    function sampleBilinear(matrix, rows, columns, fy, fx) {
        const y = Math.max(0, Math.min(rows - 1, fy));
        const x = Math.max(0, Math.min(columns - 1, fx));
        const y0 = Math.floor(y);
        const x0 = Math.floor(x);
        const y1 = Math.min(rows - 1, y0 + 1);
        const x1 = Math.min(columns - 1, x0 + 1);
        const ty = y - y0;
        const tx = x - x0;

        const a = matrix[y0]?.[x0];
        const b = matrix[y0]?.[x1];
        const c = matrix[y1]?.[x0];
        const d = matrix[y1]?.[x1];
        if (![a, b, c, d].every(toFiniteNumber)) return null;

        return (a * (1 - ty) * (1 - tx)) + (b * (1 - ty) * tx) +
               (c * ty * (1 - tx)) + (d * ty * tx);
    }

    /* True when data continues beyond `edgeLon` (another segment or the
       segment's own wrap-around), so the edge is an interior seam and must
       not be feathered. `edgeLon` is a longitude edge of `segment`. */
    function longitudeEdgeIsInterior(edgeLon, delta, segments) {
        const probe = normalizeLongitude(edgeLon + (delta > 0 ? 0.25 : -0.25));
        return segments.some((other) => {
            const west = normalizeLongitude(Number(other.bbox?.[0]));
            const east = normalizeLongitude(Number(other.bbox?.[2]));
            if (east < west) return probe >= west || probe <= east;
            return probe >= west && probe <= east;
        });
    }

    function buildScalarCanvas(segment, mode, allSegments) {
        const variable = window.AirSensePalettes.MODES[mode]?.variable;
        const matrix = segment.values?.[variable];
        if (!matrix || !matrix.length) return null;

        const rows = Number(segment.rows);
        const columns = Number(segment.columns);
        if (!rows || !columns) return null;
        if (matrix.length !== rows || matrix[0]?.length !== columns) return null;

        const [rawWest, rawSouth, rawEast, rawNorth] =
            [segment.bbox?.[0], segment.bbox?.[1], segment.bbox?.[2], segment.bbox?.[3]].map(Number);
        if (![rawWest, rawSouth, rawEast, rawNorth].every(Number.isFinite)) return null;

        const west = rawWest;
        const east = rawEast;
        // Leaflet's Web-Mercator projection ends at ±85.05°; clamp the
        // overlay there so the image corners are projectable.
        const south = Math.max(-MERCATOR_LAT_MAX, rawSouth);
        const north = Math.min(MERCATOR_LAT_MAX, rawNorth);
        const latSpan = Math.max(0.0001, north - south);
        const lonSpan = Math.max(0.0001, east - west);
        const aspect = lonSpan / latSpan;

        let displayWidth = MAX_CANVAS;
        let displayHeight = MAX_CANVAS;
        if (aspect > 1) {
            displayHeight = Math.max(48, Math.round(MAX_CANVAS / aspect));
        } else {
            displayWidth = Math.max(48, Math.round(MAX_CANVAS * aspect));
        }

        // Step between lattice samples, and the fractional lattice
        // coordinates of the sample centres.
        const latStep = latSpan / rows;
        const lonStep = lonSpan / columns;
        const lat0 = south + latStep / 2;
        const lon0 = west + lonStep / 2;

        // Resample the source matrix rows onto Web-Mercator y so the image
        // is linear in Leaflet's projection (the overlay is stretched
        // linearly between its corner points). One warp row per display
        // row keeps a single interpolation in latitude.
        const warped = document.createElement('canvas');
        warped.width = columns;
        warped.height = displayHeight;
        const warpedContext = warped.getContext('2d');
        const warpImage = warpedContext.createImageData(columns, displayHeight);
        const palettes = window.AirSensePalettes;

        let hasValue = false;
        const ySouthMerc = normalizedMercatorY(south);
        const yNorthMerc = normalizedMercatorY(north);

        for (let row = 0; row < displayHeight; row += 1) {
            // Display row r is at constant mercator y; convert to latitude,
            // then to the fractional south-up lattice row index.
            const frac = (row + 0.5) / displayHeight;
            const lat = latitudeFromNormalizedMercatorY(
                ySouthMerc + frac * (yNorthMerc - ySouthMerc)
            );
            const latIndex = (lat - lat0) / latStep;
            for (let column = 0; column < columns; column += 1) {
                const value = sampleBilinear(matrix, rows, columns, latIndex, column);
                const color = palettes.colorFor(mode, value);
                const offset = (row * columns + column) * 4;
                if (!color) {
                    warpImage.data[offset + 3] = 0;
                    continue;
                }
                hasValue = true;
                warpImage.data[offset] = color[0];
                warpImage.data[offset + 1] = color[1];
                warpImage.data[offset + 2] = color[2];
                warpImage.data[offset + 3] = Math.round(palettes.alphaFor(mode, value) * 255);
            }
        }
        if (!hasValue) return null;
        warpedContext.putImageData(warpImage, 0, 0);

        // Smooth bilinear upscale to display size. Pixel centres map
        // linearly between the lattices, so each interpolated display pixel
        // is a blend of measured neighbouring samples only.
        const display = document.createElement('canvas');
        display.width = displayWidth;
        display.height = displayHeight;
        const displayContext = display.getContext('2d');
        displayContext.imageSmoothingEnabled = true;
        displayContext.imageSmoothingQuality = 'high';
        displayContext.drawImage(warped, 0, 0, displayWidth, displayHeight);

        if (mode === 'aqi') {
            // Feather only the outer coverage edges: worldview segments that
            // wrap onto themselves or abut neighbouring segments keep clean
            // seams; genuinely limited edges fade out over the half-cell
            // margin the bbox extends past the last sample.
            const halfX = displayWidth / columns / 2;
            const halfY = displayHeight / rows / 2;
            const featherWest = !longitudeEdgeIsInterior(west, -1, allSegments);
            const featherEast = !longitudeEdgeIsInterior(east, 1, allSegments);
            // Latitude does not wrap: a north edge is interior only when
            // another segment starts exactly where this one ends.
            const featherSouth = !allSegments.some((other) => other !== segment &&
                Math.abs(Number(other.bbox?.[3]) - rawSouth) < 1e-3);
            const featherNorth = !allSegments.some((other) => other !== segment &&
                Math.abs(Number(other.bbox?.[1]) - rawNorth) < 1e-3);

            displayContext.globalCompositeOperation = 'destination-out';
            const fade = (x0, y0, x1, y1) => {
                const gradient = displayContext.createLinearGradient(x0, y0, x1, y1);
                gradient.addColorStop(0, 'rgba(0, 0, 0, 1)');
                gradient.addColorStop(1, 'rgba(0, 0, 0, 0)');
                displayContext.fillStyle = gradient;
                displayContext.fillRect(0, 0, displayWidth, displayHeight);
            };
            if (featherWest) fade(0, 0, halfX, 0);
            if (featherEast) fade(displayWidth, 0, displayWidth - halfX, 0);
            if (featherSouth) fade(0, displayHeight, 0, displayHeight - halfY);
            if (featherNorth) fade(0, 0, 0, halfY);
            displayContext.globalCompositeOperation = 'source-over';
        }

        return { canvas: display, bbox: [west, south, east, north] };
    }

    function render(map, payload, mode, opacityOverride) {
        const L = window.L;
        ensureWeatherPane(map);
        const group = L.layerGroup();
        if (!payload?.segments || mode === 'standard') return group;

        const meta = window.AirSensePalettes.MODES[mode];
        const opacity = opacityOverride ?? meta?.opacity ?? 0.6;

        payload.segments.forEach((segment) => {
            const rendered = buildScalarCanvas(segment, mode, payload.segments);
            if (!rendered) return;
            const [west, south, east, north] = rendered.bbox;
            const image = rendered.canvas.toDataURL('image/png');
            // Leaflet repeats the base world horizontally at low zoom. An
            // ImageOverlay does not repeat automatically, so add adjacent
            // longitude copies of the same measured field. This keeps the
            // overlays aligned with the wrapped world tiles without
            // changing any values.
            [-360, 0, 360].forEach((offset) => {
                const overlay = L.imageOverlay(
                    image,
                    L.latLngBounds([south, west + offset], [north, east + offset]),
                    {
                        opacity,
                        interactive: false,
                        pane: 'weatherPane',
                        className: 'weather-layer-image',
                        attribution: 'Weather data by Open-Meteo.com (CC BY 4.0)'
                    }
                );
                group.addLayer(overlay);
            });
        });
        return group;
    }

    window.AirSenseScalarRenderer = {
        ensureWeatherPane,
        hasData,
        render
    };
})();
