/* ==========================================================================
   AirSense — colour scales and layer metadata
   One source of truth for value domains, colour stops and legend labels.
   ========================================================================== */
(function () {
    'use strict';

    const STOPS = {
        temperature: [
            [-40, [49, 54, 149]],
            [-20, [69, 117, 180]],
            [0, [116, 173, 209]],
            [10, [171, 217, 233]],
            [20, [255, 255, 191]],
            [30, [253, 174, 97]],
            [40, [244, 109, 67]],
            [50, [165, 0, 38]]
        ],
        humidity: [
            [0, [255, 190, 54]],
            [20, [255, 220, 90]],
            [40, [255, 244, 170]],
            [60, [117, 235, 226]],
            [80, [44, 184, 224]],
            [100, [31, 91, 190]]
        ],
        rainfall: [
            [0, [198, 231, 255]],
            [0.1, [198, 231, 255]],
            [0.5, [110, 198, 255]],
            [1, [30, 136, 229]],
            [2.5, [21, 101, 192]],
            [5, [106, 27, 154]],
            [10, [56, 0, 107]]
        ],
        clouds: [
            [0, [255, 255, 255]],
            [25, [255, 255, 255]],
            [50, [245, 248, 252]],
            [75, [230, 238, 246]],
            [100, [210, 222, 235]]
        ],
        aqi: [
            [0, [0, 228, 0]],
            [50, [0, 228, 0]],
            [51, [255, 255, 0]],
            [100, [255, 255, 0]],
            [101, [255, 126, 0]],
            [150, [255, 126, 0]],
            [151, [255, 0, 0]],
            [200, [255, 0, 0]],
            [201, [143, 63, 151]],
            [300, [143, 63, 151]],
            [301, [126, 0, 35]],
            [500, [126, 0, 35]]
        ],
        wind: [
            [0, [31, 104, 232]],
            [10, [42, 158, 245]],
            [20, [70, 130, 242]],
            [30, [94, 103, 233]],
            [50, [135, 75, 221]],
            [80, [195, 66, 214]]
        ]
    };

    const MODES = {
        standard: {
            label: 'Standard Map',
            family: 'none',
            variable: null,
            unit: '',
            domain: [0, 1],
            ticks: []
        },
        satellite: {
            label: 'Satellite',
            family: 'none',
            basemap: 'satellite',
            variable: null,
            unit: '',
            domain: [0, 1],
            ticks: []
        },
        temperature: {
            label: 'Temperature',
            family: 'weather',
            variable: 'temperature_2m',
            unit: '°C',
            domain: [-40, 50],
            ticks: [-40, -20, 0, 20, 40, 50],
            opacity: 0.62
        },
        wind: {
            label: 'Wind',
            family: 'weather',
            variable: 'wind_speed_10m',
            unit: 'km/h',
            domain: [0, 80],
            ticks: [0, 10, 20, 30, 50, 80],
            opacity: 0.9
        },
        humidity: {
            label: 'Humidity',
            family: 'weather',
            variable: 'relative_humidity_2m',
            unit: '%',
            domain: [0, 100],
            ticks: [0, 25, 50, 75, 100],
            opacity: 0.5
        },
        rainfall: {
            label: 'Rainfall',
            family: 'weather',
            variable: 'precipitation',
            unit: 'mm',
            domain: [0, 10],
            ticks: [0, 0.5, 1, 2.5, 5, 10],
            opacity: 0.65
        },
        clouds: {
            label: 'Clouds',
            family: 'weather',
            variable: 'cloud_cover',
            unit: '%',
            domain: [0, 100],
            ticks: [0, 25, 50, 75, 100],
            opacity: 0.7
        },
        aqi: {
            label: 'Air Quality',
            family: 'air',
            variable: 'us_aqi',
            unit: 'US AQI',
            domain: [0, 500],
            ticks: [0, 50, 100, 150, 200, 300, 500],
            opacity: 0.6
        }
    };

    function clamp(value, minimum, maximum) {
        return Math.min(maximum, Math.max(minimum, value));
    }

    function mix(from, to, ratio) {
        const amount = clamp(ratio, 0, 1);
        return [
            Math.round(from[0] + (to[0] - from[0]) * amount),
            Math.round(from[1] + (to[1] - from[1]) * amount),
            Math.round(from[2] + (to[2] - from[2]) * amount)
        ];
    }

    function colorFor(mode, value) {
        if (value === null || value === undefined || !Number.isFinite(Number(value))) {
            return null;
        }
        const numeric = Number(value);
        if (mode === 'rainfall' && numeric <= 0.05) return null;

        const stops = STOPS[mode];
        if (!stops) return null;
        if (numeric <= stops[0][0]) return stops[0][1];
        if (numeric >= stops[stops.length - 1][0]) return stops[stops.length - 1][1];

        for (let index = 1; index < stops.length; index += 1) {
            const [rightValue, rightColor] = stops[index];
            const [leftValue, leftColor] = stops[index - 1];
            if (numeric <= rightValue) {
                if (rightValue === leftValue) return rightColor;
                return mix(leftColor, rightColor, (numeric - leftValue) / (rightValue - leftValue));
            }
        }
        return stops[stops.length - 1][1];
    }

    function alphaFor(mode, value) {
        if (value === null || value === undefined || !Number.isFinite(Number(value))) return 0;
        if (mode === 'rainfall') {
            if (Number(value) <= 0.05) return 0;
            return clamp(0.28 + Number(value) / 12, 0.28, 0.9);
        }
        if (mode === 'clouds') {
            return clamp(0.04 + Number(value) / 100 * 0.4, 0, 0.45);
        }
        if (mode === 'aqi') {
            return Number(value) > 0 ? 0.62 : 0;
        }
        return 0.68;
    }

    function gradientCss(mode) {
        const stops = STOPS[mode];
        if (!stops) return 'transparent';
        const domain = MODES[mode]?.domain || [stops[0][0], stops[stops.length - 1][0]];
        const span = domain[1] - domain[0] || 1;
        const parts = stops.map(([value, color]) => {
            const percentage = clamp(((value - domain[0]) / span) * 100, 0, 100);
            return `rgb(${color[0]}, ${color[1]}, ${color[2]}) ${percentage.toFixed(1)}%`;
        });
        return `linear-gradient(90deg, ${parts.join(', ')})`;
    }

    function formatValue(mode, value) {
        if (value === null || value === undefined || !Number.isFinite(Number(value))) return '--';
        const numeric = Number(value);
        if (mode === 'aqi') return String(Math.round(numeric));
        if (mode === 'rainfall') return numeric < 1 ? numeric.toFixed(2) : numeric.toFixed(1);
        if (mode === 'temperature') return numeric.toFixed(1);
        return String(Math.round(numeric));
    }

    window.AirSensePalettes = {
        MODES,
        STOPS,
        colorFor,
        alphaFor,
        gradientCss,
        formatValue
    };
})();
