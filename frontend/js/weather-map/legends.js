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
                ? 'Open-Meteo · CAMS ENSEMBLE global model (~40 km)'
                : 'Open-Meteo forecast model (~11–25 km)';
            const pointCount = state.payload?.point_count || '--';

            container.innerHTML = `
                <div class="airsense-legend__title">
                    <span>${meta.label}</span>
                    <span class="airsense-legend__unit">${meta.unit}</span>
                </div>
                <div class="airsense-legend__bar" style="background:${gradient}"></div>
                <div class="airsense-legend__ticks">
                    ${ticks.map((tick) => `<span>${tick}</span>`).join('')}
                </div>
                ${state.status === 'loading' ? '<div class="airsense-legend__status is-loading">Loading Open-Meteo data…</div>' : ''}
                ${state.status === 'error' ? `<div class="airsense-legend__status is-error">${escapeHtml(state.error)}${typeof state.onRetry === 'function' ? ' <button type="button" class="airsense-legend__retry">Retry</button>' : ''}</div>` : ''}
                ${state.payload?.stale ? '<div class="airsense-legend__status">Cached data</div>' : ''}
                <div class="airsense-legend__meta">
                    <div>Data: ${timeLabel}</div>
                    <div>Grid ≈ ${gridLabel} · ${pointCount} pts</div>
                    <div>Source: ${sourceNote}</div>
                </div>
                <div class="airsense-legend__attribution">
                    <a href="https://open-meteo.com/" target="_blank" rel="noopener">Weather data by Open-Meteo.com (CC BY 4.0)</a><br>
                    <a href="https://open-meteo.com/en/docs/air-quality-api" target="_blank" rel="noopener">Air quality by Open-Meteo / CAMS</a>
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
