/* ==========================================================================
   AirSense — location popup enrichment
   Adds live Open-Meteo point conditions to the existing marker popup without
   changing its location, marker, or the map's click-to-select behaviour.
   ========================================================================== */
(function () {
    'use strict';

    const tokens = new Map();
    const controllers = new Map();

    function escapeHtml(value) {
        return String(value ?? '').replace(/[&<>"']/g, (character) => ({
            '&': '&amp;',
            '<': '&lt;',
            '>': '&gt;',
            '"': '&quot;',
            "'": '&#39;'
        }[character]));
    }

    function isFiniteNumber(value) {
        return value !== null && value !== undefined && Number.isFinite(Number(value));
    }

    function formatCoordinate(value, positive, negative) {
        if (!Number.isFinite(Number(value))) return '--';
        const numeric = Number(value);
        return `${Math.abs(numeric).toFixed(6)}° ${numeric >= 0 ? positive : negative}`;
    }

    function formatNumber(value, digits) {
        if (!isFiniteNumber(value)) return null;
        return Number(value).toFixed(digits);
    }

    function formatTime(value) {
        if (!value) return null;
        const date = new Date(value);
        if (Number.isNaN(date.getTime())) return escapeHtml(value);
        return `${date.toISOString().replace('T', ' ').replace(/\..+$/, '')} UTC`;
    }

    function windDirection(degrees) {
        if (!isFiniteNumber(degrees)) return null;
        const labels = [
            'N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE',
            'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'
        ];
        const normalized = ((Number(degrees) % 360) + 360) % 360;
        return labels[Math.round(normalized / 22.5) % 16];
    }

    function aqiCategory(value) {
        if (!isFiniteNumber(value)) return { label: 'Unavailable', color: null };
        const numeric = Number(value);
        if (numeric <= 50) return { label: 'Good', color: [0, 228, 0] };
        if (numeric <= 100) return { label: 'Moderate', color: [255, 255, 0] };
        if (numeric <= 150) return { label: 'Unhealthy for sensitive groups', color: [255, 126, 0] };
        if (numeric <= 200) return { label: 'Unhealthy', color: [255, 0, 0] };
        if (numeric <= 300) return { label: 'Very unhealthy', color: [143, 63, 151] };
        return { label: 'Hazardous', color: [126, 0, 35] };
    }

    function readableTextColor(color) {
        if (!color) return '#f2f7fc';
        const luminance = color[0] * 0.299 + color[1] * 0.587 + color[2] * 0.114;
        return luminance > 145 ? '#06131d' : '#ffffff';
    }

    function unitFor(units, key, fallback) {
        const value = units?.[key];
        return typeof value === 'string' && value.length ? value : fallback;
    }

    function setMarkerContent(marker, content) {
        if (!marker || typeof marker.setPopupContent !== 'function') return;
        try {
            marker.setPopupContent(content);
        } catch (error) {
            console.warn('Unable to update location popup:', error);
        }
    }

    function createShell(params) {
        const element = document.createElement('div');
        element.className = 'airsense-popup';
        const region = params.region
            ? `<br><small>${escapeHtml(params.region)}</small>`
            : '';
        element.innerHTML = `
            <div class="airsense-popup__heading">
                <b>${escapeHtml(params.name || 'Selected Location')}</b>${region}
            </div>
            <span class="airsense-popup__coords">
                ${formatCoordinate(params.lat, 'N', 'S')}, ${formatCoordinate(params.lon, 'E', 'W')}
            </span>
        `;
        return element;
    }

    function appendSection(element, title, rows) {
        if (!rows.length) return;
        const section = document.createElement('div');
        section.className = 'airsense-popup__section';
        const heading = document.createElement('div');
        heading.className = 'airsense-popup__section-title';
        heading.textContent = title;
        section.appendChild(heading);

        const grid = document.createElement('div');
        grid.className = 'airsense-popup__grid';
        rows.forEach(({ label, value }) => {
            const item = document.createElement('div');
            item.className = 'airsense-popup__item';
            const labelElement = document.createElement('span');
            labelElement.className = 'airsense-popup__label';
            labelElement.textContent = label;
            const valueElement = document.createElement('span');
            valueElement.className = 'airsense-popup__value';
            valueElement.innerHTML = value;
            item.append(labelElement, valueElement);
            grid.appendChild(item);
        });
        section.appendChild(grid);
        element.appendChild(section);
    }

    function renderLoading(params) {
        const element = createShell(params);
        const loading = document.createElement('div');
        loading.className = 'airsense-popup__loading';
        loading.textContent = 'Loading live Open-Meteo conditions…';
        element.appendChild(loading);
        return element;
    }

    function renderError(params, message) {
        const element = createShell(params);
        const error = document.createElement('div');
        error.className = 'airsense-popup__error';
        error.innerHTML = `${escapeHtml(message || 'Weather details are unavailable.')}
            <button type="button" class="airsense-popup__retry">Retry</button>`;
        const retry = error.querySelector('.airsense-popup__retry');
        if (retry) {
            retry.addEventListener('click', () => {
                enhance(params);
            });
        }
        element.appendChild(error);
        return element;
    }

    function renderPayload(params, payload) {
        const values = payload?.values || {};
        const units = payload?.units || {};
        const element = createShell(params);

        const temperatureUnit = unitFor(units, 'temperature_2m', '°C');
        const windUnit = unitFor(units, 'wind_speed_10m', 'km/h');
        const precipitationUnit = unitFor(units, 'precipitation', 'mm');
        const weatherRows = [
            {
                label: 'Temperature',
                value: `${formatNumber(values.temperature_2m, 1) ?? '--'} ${escapeHtml(temperatureUnit)}`
            },
            {
                label: 'Feels like',
                value: `${formatNumber(values.apparent_temperature, 1) ?? '--'} ${escapeHtml(temperatureUnit)}`
            },
            {
                label: 'Humidity',
                value: isFiniteNumber(values.relative_humidity_2m)
                    ? `${Math.round(Number(values.relative_humidity_2m))} ${escapeHtml(unitFor(units, 'relative_humidity_2m', '%'))}`
                    : '--'
            }
        ];

        if (isFiniteNumber(values.wind_speed_10m)) {
            const direction = windDirection(values.wind_direction_10m);
            const speed = `${formatNumber(values.wind_speed_10m, 1)} ${escapeHtml(windUnit)}`;
            weatherRows.push({
                label: 'Wind',
                value: direction
                    ? `${speed} ${direction} (${Math.round(Number(values.wind_direction_10m))}°)`
                    : speed
            });
        } else {
            weatherRows.push({ label: 'Wind', value: '--' });
        }

        weatherRows.push(
            {
                label: 'Precipitation',
                value: `${formatNumber(values.precipitation, 1) ?? '--'} ${escapeHtml(precipitationUnit)}`
            },
            {
                label: 'Cloud cover',
                value: isFiniteNumber(values.cloud_cover)
                    ? `${Math.round(Number(values.cloud_cover))} ${escapeHtml(unitFor(units, 'cloud_cover', '%'))}`
                    : '--'
            },
            {
                label: 'Pressure',
                value: isFiniteNumber(values.surface_pressure)
                    ? `${Math.round(Number(values.surface_pressure))} ${escapeHtml(unitFor(units, 'surface_pressure', 'hPa'))}`
                    : '--'
            }
        );

        appendSection(element, 'Current conditions', weatherRows);

        const aqi = values.us_aqi;
        const category = aqiCategory(aqi);
        const aqiBackground = category.color
            ? `rgb(${category.color[0]}, ${category.color[1]}, ${category.color[2]})`
            : 'rgba(255, 255, 255, 0.12)';
        const airRows = [
            {
                label: 'US AQI',
                value: `<span class="airsense-popup__aqi" style="background:${aqiBackground};color:${readableTextColor(category.color)}">${isFiniteNumber(aqi) ? Math.round(Number(aqi)) : '--'}</span>`
            },
            { label: 'Category', value: escapeHtml(category.label) },
            {
                label: 'PM2.5',
                value: `${formatNumber(values.pm2_5, 1) ?? '--'} ${escapeHtml(unitFor(units, 'pm2_5', 'µg/m³'))}`
            },
            {
                label: 'PM10',
                value: `${formatNumber(values.pm10, 1) ?? '--'} ${escapeHtml(unitFor(units, 'pm10', 'µg/m³'))}`
            }
        ];
        appendSection(element, 'Air quality', airRows);

        const time = formatTime(payload?.data_time);
        const warnings = Array.isArray(payload?.warnings) ? payload.warnings.filter(Boolean) : [];
        const metaParts = [];
        if (time) metaParts.push(`Data: ${time}`);
        if (payload?.stale) metaParts.push('Cached data');
        if (warnings.length) metaParts.push(escapeHtml(warnings.join(' · ')));
        if (metaParts.length) {
            const meta = document.createElement('div');
            meta.className = 'airsense-popup__meta';
            meta.innerHTML = metaParts.join('<br>');
            element.appendChild(meta);
        }

        return element;
    }

    async function enhance(params) {
        if (!params || !Number.isFinite(Number(params.lat)) || !Number.isFinite(Number(params.lon))) {
            return;
        }

        const key = params.mapId || 'sidebar';
        const token = (tokens.get(key) || 0) + 1;
        tokens.set(key, token);

        const previous = controllers.get(key);
        if (previous) previous.abort();
        const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
        if (controller) controllers.set(key, controller);

        const normalized = {
            ...params,
            lat: Number(params.lat),
            lon: Number(params.lon)
        };

        setMarkerContent(params.marker, renderLoading(normalized));

        try {
            const payload = await window.AirSenseMapData.getPoint(
                normalized.lat,
                normalized.lon,
                controller?.signal
            );
            if (tokens.get(key) !== token) return;
            setMarkerContent(params.marker, renderPayload(normalized, payload));
        } catch (error) {
            if (tokens.get(key) !== token) return;
            if (error?.name === 'AbortError') return;
            setMarkerContent(
                params.marker,
                renderError(normalized, error?.message || 'Weather details are unavailable.')
            );
        } finally {
            if (controllers.get(key) === controller) controllers.delete(key);
        }
    }

    window.AirSenseLocationPopup = { enhance };
})();
