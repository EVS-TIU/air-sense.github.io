/* ==========================================================================
   AirSense — scalar weather layer renderer
   Converts the backend's regular lat/lon value grid into a smoothly upscaled
   Canvas image and places it on the existing Leaflet map as an image overlay.
   ========================================================================== */
(function () {
    'use strict';

    const MAX_CANVAS = 384;

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

    function buildSegmentCanvas(segment, mode) {
        const variable = window.AirSensePalettes.MODES[mode]?.variable;
        const matrix = segment.values?.[variable];
        if (!matrix || !matrix.length) return null;

        const rows = segment.rows;
        const columns = segment.columns;
        const small = document.createElement('canvas');
        small.width = columns;
        small.height = rows;
        const smallContext = small.getContext('2d');
        const image = smallContext.createImageData(columns, rows);

        let hasValue = false;
        for (let row = 0; row < rows; row += 1) {
            for (let column = 0; column < columns; column += 1) {
                const value = matrix[row]?.[column];
                const color = window.AirSensePalettes.colorFor(mode, value);
                const offset = (row * columns + column) * 4;
                if (!color) {
                    image.data[offset + 3] = 0;
                    continue;
                }
                hasValue = true;
                image.data[offset] = color[0];
                image.data[offset + 1] = color[1];
                image.data[offset + 2] = color[2];
                image.data[offset + 3] = Math.round(
                    window.AirSensePalettes.alphaFor(mode, value) * 255
                );
            }
        }
        if (!hasValue) return null;
        smallContext.putImageData(image, 0, 0);

        const [west, south, east, north] = segment.bbox;
        const lonSpan = Math.max(0.0001, east - west);
        const latSpan = Math.max(0.0001, north - south);
        const aspect = lonSpan / latSpan;
        let width = MAX_CANVAS;
        let height = MAX_CANVAS;
        if (aspect > 1) {
            height = Math.max(48, Math.round(MAX_CANVAS / aspect));
        } else {
            width = Math.max(48, Math.round(MAX_CANVAS * aspect));
        }

        const display = document.createElement('canvas');
        display.width = width;
        display.height = height;
        const displayContext = display.getContext('2d');
        displayContext.imageSmoothingEnabled = true;
        displayContext.imageSmoothingQuality = 'high';
        displayContext.drawImage(small, 0, 0, width, height);
        return { canvas: display, bbox: segment.bbox };
    }

    function render(map, payload, mode, opacityOverride) {
        const L = window.L;
        ensureWeatherPane(map);
        const group = L.layerGroup();
        if (!payload?.segments || mode === 'standard') return group;

        const meta = window.AirSensePalettes.MODES[mode];
        const opacity = opacityOverride ?? meta?.opacity ?? 0.6;

        payload.segments.forEach((segment) => {
            const rendered = buildSegmentCanvas(segment, mode);
            if (!rendered) return;
            const [west, south, east, north] = rendered.bbox;
            const image = rendered.canvas.toDataURL('image/png');
            // Leaflet repeats the base world horizontally at low zoom. An
            // ImageOverlay does not repeat automatically, so add adjacent
            // longitude copies of the same measured field. This fixes the
            // half-covered global AQI/weather view without changing values.
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
