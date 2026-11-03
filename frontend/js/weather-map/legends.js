/* ==========================================================================
   AirSense — map legends
   ========================================================================== */
(function () {
    'use strict';

    function escapeHtml(value) {
        return String(value ?? '').replace(/[&<>"']/g, (character) => ({
            '&': '&amp;',
            '<': '&lt;',
            '>': '&gt;',
            '"': '&quot;',
            "'": '&#39;'
        }[character]));
    }

    function formatDataTime(value) {
        if (!value) return '—';
        const date = new Date(value);
        return Number.isNaN(date.getTime()) ? '—' : `${date.toISOString().replace('T', ' ').replace(/\.\d+Z$/, ' UTC')}`;
    }

    function createControl(map, mapId) {
        const L = window.L;
        const control = L.control({ position: 'bottomleft' });
        control.onAdd = function () {
            const container = L.DomUtil.create('div', 'airsense-legend');
            L.DomEvent.disableClickPropagation(container);
            L.DomEvent.disableScrollPropagation(container);
            this.container = container;
            this.update({ mode: 'standard' });
            return container;
        };
        control.update = function (state) {
            const container = this.container;
            if (!container) return;
            const palettes = window.AirSensePalettes;
            const mode = state.mode;
            const meta = palettes.MODES[mode];
            if (mode === 'satellite') {
                container.innerHTML = `
                    <div class="airsense-legend__title"><span>Satellite Imagery</span></div>
                    <div class="airsense-legend__status">Real imagery · roads, boundaries and place labels</div>
                    <div class="airsense-legend__meta"><div>Imagery date varies by location and tile</div></div>
                    <div class="airsense-legend__attribution">
                        <a href="https://www.esri.com/en-us/arcgis/products/arcgis-imagery" target="_blank" rel="noopener">Imagery and reference layers by Esri</a>
                    </div>
                `;
                return;
            }

            if (mode === 'radar') {
                const time = state.radarTime ? new Date(state.radarTime * 1000) : null;
                const timeLabel = time && !Number.isNaN(time.getTime()) ? `${time.toISOString().replace('T', ' ').slice(0, 19)} UTC` : '—';
                const generated = state.radarGenerated ? new Date(state.radarGenerated * 1000) : null;
                const generatedLabel = generated && !Number.isNaN(generated.getTime()) ? `${generated.toISOString().replace('T', ' ').slice(0, 19)} UTC` : '—';
                container.innerHTML = `
                    <div class="airsense-legend__title"><span>Weather Radar</span><span class="airsense-legend__unit">dBZ</span></div>
                    <div class="airsense-legend__bar" style="background:linear-gradient(90deg,#8ee9ff,#43b8ff,#3057e8,#a43ac4,#e63e6a,#ffd44a)"></div>
                    <div class="airsense-legend__ticks"><span>Light</span><span>Moderate</span><span>Heavy</span></div>
                    ${state.status === 'loading' ? '<div class="airsense-legend__status is-loading">Loading latest radar frame…</div>' : ''}
                    ${state.status === 'error' ? `<div class="airsense-legend__status is-error">${escapeHtml(state.error)}</div>` : ''}
                    <div class="airsense-legend__meta"><div>Frame: ${timeLabel}</div><div>Manifest updated: ${generatedLabel}</div><div>Coverage varies by radar · native zoom 7 · past frames only</div><div>10 minute steps · no nowcast</div></div>
                    <div class="airsense-legend__attribution"><a href="https://www.rainviewer.com/api.html" target="_blank" rel="noopener">Weather data by RainViewer</a></div>
                    <label class="airsense-opacity">Overlay opacity <input data-map-opacity type="range" min="0.15" max="1" step="0.05" value="0.72"></label>`;
                return;
            }

            if (meta?.provider === 'weatherapi') {
                const validTime = state.tileTime ? new Date(state.tileTime) : null;
                const timeLabel = validTime && !Number.isNaN(validTime.getTime())
                    ? `${validTime.toISOString().replace('T', ' ').slice(0, 16)} UTC`
                    : '—';
                container.innerHTML = `
                    <div class="airsense-legend__title"><span>${meta.label}</span><span class="airsense-legend__unit">${meta.unit}</span></div>
                    <div class="airsense-legend__status">${mode === 'wind' ? 'WeatherAPI speed tile · Open-Meteo wind field' : 'Provider-rendered map colors · units shown above'}</div>
                    ${state.status === 'loading' ? '<div class="airsense-legend__status is-loading">Loading latest map tiles…</div>' : ''}
                    ${state.warning ? `<div class="airsense-legend__status">${escapeHtml(state.warning)}</div>` : ''}
                    ${state.payload?.stale ? '<div class="airsense-legend__status">Using last valid wind field · stale</div>' : ''}
                    ${state.status === 'error' ? `<div class="airsense-legend__status is-error">${escapeHtml(state.error)}</div>` : ''}
                    <div class="airsense-legend__meta"><div>Tile valid: ${timeLabel}</div>${mode === 'wind' ? `<div>Flow data: ${escapeHtml(formatDataTime(state.payload?.data_time))} · grid ≈ ${state.payload?.resolution_deg ?? '—'}°</div>` : ''}<div>Hourly map tiles · global coverage</div><div>Source: ${mode === 'wind' ? 'WeatherAPI + Open-Meteo' : 'WeatherAPI.com'}</div></div>
                    <div class="airsense-legend__attribution"><a href="https://www.weatherapi.com/docs/weather-maps/" target="_blank" rel="noopener">WeatherAPI map tiles · free, no key</a>${mode === 'wind' ? ' · <a href="https://open-meteo.com/" target="_blank" rel="noopener">Open-Meteo</a>' : ''}</div>
                    <label class="airsense-opacity">Overlay opacity <input data-map-opacity type="range" min="0.15" max="1" step="0.05" value="${state.opacity ?? meta.opacity}"></label>`;
                return;
            }

            if (mode === 'standard' || !meta || meta.family === 'none') {
                container.innerHTML = `
                    <div class="airsense-legend__title">
                        <span>Standard Map</span>
                    </div>
                    <div class="airsense-legend__status">OpenStreetMap base layer</div>
                    <div class="airsense-legend__attribution">
                        <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">© OpenStreetMap</a> ·
                        <a href="https://www.esri.com/" target="_blank" rel="noopener">© Esri</a> ·
                        <a href="https://open-meteo.com/" target="_blank" rel="noopener">Open-Meteo (CC BY 4.0)</a>
                    </div>
                `;
                return;
            }

            const ticks = meta.ticks || [];
            const gradient = palettes.gradientCss(mode);
            const time = state.payload?.data_time ? new Date(state.payload.data_time) : null;
            const timeLabel = time && !Number.isNaN(time.getTime())
                ? time.toISOString().replace('T', ' ').replace(/\..+$/, ' UTC')
                : '--';
            const segment = state.payload?.segments?.[0];
            const resolution = segment?.resolution_deg;
            const resolutionKm = resolution ? Math.round(resolution * 111) : null;
            const gridLabel = resolution
                ? `~${resolution}°${resolutionKm ? ` (~${resolutionKm} km)` : ''}`
                : '--';
            const sourceNote = meta.family === 'air'
                ? `${state.payload?.model || 'Open-Meteo · CAMS'} · nominal native grid ${state.payload?.native_resolution_deg ?? '—'}° (~${state.payload?.native_resolution_km ?? '—'} km)`
                : 'Open-Meteo forecast model (~11–25 km)';
            const pointCount = state.payload?.point_count || '--';
            const aqiCategories = [
                ['#00e400', '0–50', 'Good'],
                ['#ffff00', '51–100', 'Moderate'],
                ['#ff7e00', '101–150', 'USG sensitive'],
                ['#ff0000', '151–200', 'Unhealthy'],
                ['#8f3f97', '201–300', 'Very unhealthy'],
                ['#7e0023', '301+', 'Hazardous']
            ];
            const stationStatus = state.stationStatus === 'available'
                ? `${state.stationCount} live WAQI station${state.stationCount === 1 ? '' : 's'} shown · click a marker for its station AQI`
                : state.stationStatus === 'loading' ? 'Loading live monitor stations…'
                    : state.stationStatus === 'not-configured' ? 'Live city monitors require WAQI_API_TOKEN'
                        : state.stationStatus === 'unavailable' ? 'Live monitor stations unavailable'
                            : state.stationStatus === 'zoom-in' ? 'Zoom in to see available monitor stations' : '';
            const cityStatus = state.cityStatus === 'available'
                ? `${state.cityCount} city indicator${state.cityCount === 1 ? '' : 's'} · values from the nearest CAMS cell · click for PM2.5/PM10`
                : state.cityStatus === 'zoom-in' ? 'Zoom in for city-level AQI indicators' : '';

            container.innerHTML = `
                <div class="airsense-legend__title">
                    <span>${meta.label}</span>
                    <span class="airsense-legend__unit">${meta.unit}</span>
                </div>
                ${mode === 'aqi' ? `<div class="airsense-legend__aqi-categories">${aqiCategories.map(([color, range, category]) => `<div><i style="background:${color}"></i><b>${range}</b><span>${category}</span></div>`).join('')}</div>` : `<div class="airsense-legend__bar" style="background:${gradient}"></div><div class="airsense-legend__ticks">${ticks.map((tick) => `<span>${tick}</span>`).join('')}</div>`}
                ${state.status === 'loading' ? '<div class="airsense-legend__status is-loading">Loading Open-Meteo data…</div>' : ''}
                ${state.status === 'error' ? `<div class="airsense-legend__status is-error">${escapeHtml(state.error)}${typeof state.onRetry === 'function' ? ' <button type="button" class="airsense-legend__retry">Retry</button>' : ''}</div>` : ''}
                ${state.payload?.stale ? '<div class="airsense-legend__status">Cached data</div>' : ''}
                ${state.warning ? `<div class="airsense-legend__status">${escapeHtml(state.warning)}</div>` : ''}
                ${mode === 'aqi' && stationStatus ? `<div class="airsense-legend__status">${escapeHtml(stationStatus)}</div>` : ''}
                ${mode === 'aqi' && cityStatus ? `<div class="airsense-legend__status">${escapeHtml(cityStatus)}</div>` : ''}
                <label class="airsense-opacity">Overlay opacity <input data-map-opacity type="range" min="0.15" max="1" step="0.05" value="${state.opacity ?? meta.opacity ?? 0.6}"></label>
                <div class="airsense-legend__meta">
                    <div>Data: ${timeLabel}</div>
                    <div>${state.payload?.point_count ? `${pointCount} sample${state.payload.point_count === 1 ? '' : 's'} at ≈ ${gridLabel}` : 'No samples for this view'}</div>
                    <div>Source: ${sourceNote}</div>
                    ${state.warning ? `<div>${escapeHtml(state.warning)}</div>` : ''}
                </div>
                <div class="airsense-legend__attribution">
                    <a href="https://open-meteo.com/" target="_blank" rel="noopener">Weather data by Open-Meteo.com (CC BY 4.0)</a><br>
                    <a href="https://open-meteo.com/en/docs/air-quality-api" target="_blank" rel="noopener">Air quality by Open-Meteo / CAMS</a>${mode === 'aqi' ? '<br><a href="https://waqi.info/" target="_blank" rel="noopener">Live monitoring stations by WAQI</a>' : ''}
                </div>
            `;

            const retry = container.querySelector('.airsense-legend__retry');
            if (retry && typeof state.onRetry === 'function') {
                retry.addEventListener('click', state.onRetry);
            }
        };
        control.addTo(map);
        return control;
    }

    window.AirSenseLegends = { createControl };
})();
