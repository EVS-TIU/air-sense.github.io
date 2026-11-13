/* ==========================================================================
   AirSense — map legends / per-layer information panel
   One source of truth for value domains, legend visuals, interpretation
   text, data details and data status. Each layer gets its own accurate
   legend: provider-rendered tile layers never display the front-end's own
   colour scale, and every "live/cached/stale" statement is derived from the
   actual payload or tile timestamp.
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

    /* ------------------------------------------------------------------
       Interpretation copy per layer (requirement: meaning + ranges).
       `bands` rows are either derived from our own palette stops (only
       where the front-end paints the colours itself) or omitted for
       provider-rendered tiles whose internal colour map we cannot claim.
       ------------------------------------------------------------------ */
    const LAYER_INFO = {
        temperature: {
            about: 'Air temperature measured ~2 m above the surface. Cool colours are colder, warm colours hotter. Cold masses often sit north of warm fronts; sharp colour changes along a front mark tighter gradients.',
            boundaryNote: 'colours come from WeatherAPI\'s fixed temperature map tile (°C); the front-end does not repaint them.'
        },
        wind: {
            about: 'The animated streaks show the 10 m wind field from Open-Meteo: they stream downwind, and their colour is wind speed at ground level on the scale below. Use the speed colours for intensity; the streak curvature reveals how weather systems rotate.',
            fallbackNote: 'When the live vector field cannot load, the layer falls back to a real-time OpenWeather wind tile (no streaks or speed colours).'
        },
        humidity: {
            about: 'Relative humidity — how close the air is to saturation at its current temperature. High values (>80%) mean fog or heavy dew is likely when air cools; very low values (<30%) raise dry-skin, static and fire risk.'
        },
        pressure: {
            about: 'Air pressure reduced to sea level, in hectopascals (hPa). Lows ≈ rising air, clouds, unsettled weather; highs ≈ sinking air, clearance and calmer conditions. Tight spacing of extremes marks windy frontal zones.',
            boundaryNote: 'colours come from WeatherAPI\'s fixed pressure map tile (hPa); L/H areas matter more than exact hues.'
        },
        radar: {
            about: 'Rainfall echoes from ground radar stations. Stronger echoes (higher reflectivity, dBZ) mean heavier rainfall: light showers read pale, intense storm cells read dark/red. Frames are past observations, in 10-minute steps — no forecast sweep.'
        },
        satellite: {
            about: 'True-colour satellite imagery of the ground surface: what the sky-free surface physically looks like. It shows terrain, cities and vegetation but carries no weather value ranges; overlay a weather layer to map atmospheric data.',
            boundaryNote: 'imagery is a static reference basemap, not a data layer.'
        },
        aqi: {
            about: 'Composite pollution index combining PM2.5, PM10, ozone, NO₂, SO₂ and CO into one US-EPA-style number. Higher = more pollution. Colours blend smoothly between real CAMS model samples (never inventing readings) and follow official US-AQI category colours below.'
        },
        standard: {
            about: 'Basic map with no data overlay — for choosing a location and reading the terrain. Select a layer above to map temperature, wind, air quality and more.'
        }
    };

    /* Colour bands shown under the gradient bar, derived from the palette
       anchors so swatches exactly match what the map paints. */
    const LAYER_BANDS = {
        wind: [
            ['0–10', 'Very light air', null],
            ['10–20', 'Light breeze', null],
            ['20–35', 'Moderate wind', null],
            ['35–50', 'Fresh wind', null],
            ['50–65', 'Strong wind', null],
            ['65–80+', 'Storm force', null]
        ],
        humidity: [
            ['0–20', 'Very dry air', null],
            ['20–40', 'Dry air', null],
            ['40–60', 'Comfortable', null],
            ['60–80', 'Humid', null],
            ['80–100%', 'Near saturation', null]
        ],
    };

    /* Official US-AQI categories with EPA-style health guidance. */
    const AQI_CATEGORIES = [
        ['#00e400', '0–50', 'Good — little or no risk', 'Air quality is satisfactory; pollution poses little or no risk.'],
        ['#ffff00', '51–100', 'Moderate', 'Acceptable; unusually sensitive people should limit prolonged outdoor exertion.'],
        ['#ff7e00', '101–150', 'Unhealthy for sensitive groups', 'Sensitive groups (children, elderly, lung or heart conditions) cut back outdoor exertion.'],
        ['#ff0000', '151–200', 'Unhealthy', 'Everyone may experience effects; reduce prolonged outdoor activity.'],
        ['#8f3f97', '201–300', 'Very unhealthy', 'Health alert; the risk of effects is increased for everyone.'],
        ['#7e0023', '301+', 'Hazardous', 'Emergency conditions; everyone should avoid outdoor exposure.']
    ];

    function statusChip(state, label, className) {
        if (!label) return '';
        return `<div class="airsense-legend__status is-${className || 'info'}">${escapeHtml(label)}</div>`;
    }

    /* Live / cached / unavailable statements derived from real timestamps. */
    function dataStatusLine(state, dataTime) {
        if (state.status === 'error') return null; // rendered as an error row
        if (state.payload?.stale) {
            return { label: `Cached · last successful fetch ${formatDataTime(dataTime)} (stale, may be older)`, className: 'stale' };
        }
        const time = dataTime ? new Date(dataTime) : null;
        if (!time || Number.isNaN(time.getTime())) return null;
        const ageMinutes = Math.round((Date.now() - time.getTime()) / 60000);
        if (ageMinutes <= 90) {
            return { label: `Live data · model time ${formatDataTime(dataTime)} (≈${Math.max(0, ageMinutes)} min ago)`, className: 'live' };
        }
        return { label: `Latest available · model time ${formatDataTime(dataTime)} (≈${Math.max(0, Math.round(ageMinutes / 60))} h ago)`, className: 'stale' };
    }

    function renderBands(bands, colors) {
        // colors: optional map row index -> css colour; otherwise swatches
        // come from the gradient stops themselves when provided.
        const rows = bands.map(([range, meaning], index) => {
            const color = Array.isArray(colors?.[index]) ? colors[index] : colors?.[index];
            return `<div>${color ? `<i style="background:${color}"></i>` : '<i class="is-spacer"></i>'}` +
                `<b>${range}</b><span>${meaning}</span></div>`;
        });
        return `<div class="airsense-legend__bands">${rows.join('')}</div>`;
    }

    /* Band swatches sampled from the palette gradient at the band midpoints
       so tiles/legend always agree with the painted field. */
    function sampleGradientForBands(mode, bands) {
        const gradients = window.AirSensePalettes.gradientCss(mode);
        // Parse `linear-gradient(90deg, rgb(r, g, b) 0.0%, ...)`
        const stops = [...gradients.matchAll(/rgb\((\d+), (\d+), (\d+)\) ([\d.]+)%/g)]
            .map((match) => ({
                value: Number(match[4]),
                css: `rgb(${match[1]}, ${match[2]}, ${match[3]})`
            }));
        if (!stops.length) return null;
        const low = stops[0].value;
        const high = stops[stops.length - 1].value;
        const span = (high - low) || 1;
        return bands.map((band, index) => {
            const fraction = (index < bands.length - 1) ? (index + 0.5) / bands.length : 1;
            const target = low + fraction * span;
            const color = stops.reduce((best, stop) =>
                Math.abs(stop.value - target) < Math.abs(best.value - target) ? stop : best, stops[0]);
            return color.css;
        });
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

            let html = '';

            /* ---------------------------------------------------------- */
            if (mode === 'satellite') {
                html = `
                    <div class="airsense-legend__title"><span>Satellite</span></div>
                    ${statusChip({ status: state.status }, 'True-colour imagery basemap · no weather values', 'info')}
                    <div class="airsense-legend__about">${LAYER_INFO.satellite.about}</div>
                    <div class="airsense-legend__meta"><div>Visible-light satellite photos · data sources vary by region</div><div>Not a data layer — pick a weather layer to see measured values</div></div>
                    <div class="airsense-legend__attribution">
                        <a href="https://www.esri.com/en-us/arcgis/products/arcgis-imagery" target="_blank" rel="noopener">Imagery and reference layers by Esri</a>
                    </div>`;
                container.innerHTML = html;
                return;
            }

            /* ---------------------------------------------------------- */
            if (mode === 'radar') {
                const time = state.radarTime ? new Date(state.radarTime * 1000) : null;
                const timeLabel = time && !Number.isNaN(time.getTime()) ? `${time.toISOString().replace('T', ' ').slice(0, 19)} UTC` : '—';
                const generated = state.radarGenerated ? new Date(state.radarGenerated * 1000) : null;
                const generatedLabel = generated && !Number.isNaN(generated.getTime()) ? `${generated.toISOString().replace('T', ' ').slice(0, 19)} UTC` : '—';
                const radarStatus = state.status === 'loading'
                    ? { label: 'Loading latest radar frame…', className: 'loading' }
                    : state.status === 'error'
                        ? null // rendered as error row below
                        : time ? { label: `Live radar frame · ${timeLabel} · 10-minute past frames only, no nowcast`, className: 'live' } : null;
                html = `
                    <div class="airsense-legend__title"><span>Rainfall</span><span class="airsense-legend__unit">dBZ reflectivity</span></div>
                    <div class="airsense-legend__bar" style="background:linear-gradient(90deg,#8ee9ff,#43b8ff,#3057e8,#a43ac4,#e63e6a,#ffd44a)"></div>
                    <div class="airsense-legend__ticks"><span>Light</span><span>Moderate</span><span>Heavy</span></div>
                    <div class="airsense-legend__about">${LAYER_INFO.radar.about}</div>
                    ${state.status === 'error' ? `<div class="airsense-legend__status is-error">${escapeHtml(state.error)} — radar frames are unavailable right now, the map keeps the clear basemap.</div>` : ''}
                    ${statusChip(state, radarStatus?.label, radarStatus?.className)}
                    <div class="airsense-legend__meta"><div>Frame: ${timeLabel}</div><div>Manifest updated: ${generatedLabel}</div><div>Coverage varies by radar · native zoom 7 · past frames only</div></div>
                    <div class="airsense-legend__attribution"><a href="https://www.rainviewer.com/api.html" target="_blank" rel="noopener">Weather data by RainViewer</a></div>
                    <label class="airsense-opacity">Overlay opacity <input data-map-opacity type="range" min="0.15" max="1" step="0.05" value="0.72"></label>`;
                container.innerHTML = html;
                return;
            }

            /* ---------------------------------------------------------- */
            if (meta?.provider === 'weatherapi') {
                const validTime = state.tileTime ? new Date(state.tileTime) : null;
                const timeLabel = validTime && !Number.isNaN(validTime.getTime())
                    ? `${validTime.toISOString().replace('T', ' ').slice(0, 16)} UTC`
                    : '—';
                const tileStatus = state.status === 'loading'
                    ? { label: 'Loading latest WeatherAPI map tile…', className: 'loading' }
                    : state.status === 'error'
                        ? null
                        : { label: `Live tile · valid ${timeLabel} · hourly WeatherAPI tile`, className: 'live' };
                html = `
                    <div class="airsense-legend__title"><span>${meta.label}</span><span class="airsense-legend__unit">${meta.unit}</span></div>
                    ${state.status === 'error' ? `<div class="airsense-legend__status is-error">${escapeHtml(state.error)} — the provider tile is unavailable, so no ${escapeHtml(meta.label.toLowerCase())} field is shown.</div>` : ''}
                    ${statusChip(state, tileStatus?.label, tileStatus?.className)}
                    <div class="airsense-legend__about">${LAYER_INFO[mode]?.about || ''}</div>
                    <div class="airsense-legend__meta"><div>${LAYER_INFO[mode]?.boundaryNote || ''}</div><div>Tile source: WeatherAPI.com map tiles (free, no key), hourly · global coverage</div></div>
                    ${state.warning ? `<div class="airsense-legend__status">${escapeHtml(state.warning)}</div>` : ''}
                    <div class="airsense-legend__attribution"><a href="https://www.weatherapi.com/docs/weather-maps/" target="_blank" rel="noopener">WeatherAPI map tiles</a>${mode === 'wind' ? ' · <a href="https://open-meteo.com/" target="_blank" rel="noopener">Open-Meteo</a>' : ''}</div>
                    <label class="airsense-opacity">Overlay opacity <input data-map-opacity type="range" min="0.15" max="1" step="0.05" value="${state.opacity ?? meta.opacity}"></label>`;
                container.innerHTML = html;
                return;
            }

            /* ---------------------------------------------------------- */
            if (mode === 'standard' || !meta || meta.family === 'none') {
                html = `
                    <div class="airsense-legend__title"><span>Standard Map</span></div>
                    ${statusChip(state, 'Reference basemap · no data layer', 'info')}
                    <div class="airsense-legend__about">${LAYER_INFO.standard.about}</div>
                    <div class="airsense-legend__attribution">
                        <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">© OpenStreetMap</a> ·
                        <a href="https://www.esri.com/" target="_blank" rel="noopener">© Esri</a> ·
                        <a href="https://open-meteo.com/" target="_blank" rel="noopener">Open-Meteo (CC BY 4.0)</a>
                    </div>`;
                container.innerHTML = html;
                return;
            }

            /* ----------------------------------------------------------
               Open-Meteo powered scalar + air layers (wind payload part is
               handled inside the provider branch above when a tile exists).
               ---------------------------------------------------------- */
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
            const live = dataStatusLine(state, state.payload?.data_time);

            let legendVisual = '';
            if (mode === 'aqi') {
                legendVisual = AQI_CATEGORIES.map(([color, range, category, guidance]) =>
                    `<div><i style="background:${color}"></i><b>${range}</b><span><em>${category}</em>${guidance ? ` — ${guidance}` : ''}</span></div>`).join('');
                legendVisual = `<div class="airsense-legend__bands is-single">${legendVisual}</div>`;
            } else if (meta.family === 'weather' && LAYER_BANDS[mode]) {
                legendVisual = `<div class="airsense-legend__bar" style="background:${gradient}"></div>` +
                    `<div class="airsense-legend__ticks">${ticks.map((tick) => `<span>${tick}</span>`).join('')}</div>` +
                    renderBands(LAYER_BANDS[mode], sampleGradientForBands(mode, LAYER_BANDS[mode]));
            } else {
                legendVisual = `<div class="airsense-legend__bar" style="background:${gradient}"></div>` +
                    `<div class="airsense-legend__ticks">${ticks.map((tick) => `<span>${tick}</span>`).join('')}</div>`;
            }

            const stationStatus = state.stationStatus === 'available'
                ? `${state.stationCount} live WAQI station${state.stationCount === 1 ? '' : 's'} shown · click a marker for its station AQI`
                : state.stationStatus === 'loading' ? 'Loading live monitor stations…'
                    : state.stationStatus === 'not-configured' ? 'Live city monitors require WAQI_API_TOKEN, so no station dots are shown'
                        : state.stationStatus === 'unavailable' ? 'Live monitor stations unavailable right now — the model field is still live'
                            : state.stationStatus === 'zoom-in' ? 'Zoom in to see available monitor stations' : '';
            const cityStatus = state.cityStatus === 'available'
                ? `${state.cityCount} city indicator${state.cityCount === 1 ? '' : 's'} · values from the nearest CAMS cell · click for PM2.5/PM10`
                : state.cityStatus === 'zoom-in' ? 'Zoom in for city-level AQI indicators' : '';

            html = `
                <div class="airsense-legend__title">
                    <span>${meta.label}</span>
                    <span class="airsense-legend__unit">${meta.unit}</span>
                </div>
                ${legendVisual}
                ${state.status === 'loading' ? '<div class="airsense-legend__status is-loading">Loading Open-Meteo data…</div>' : ''}
                ${state.status === 'error' ? `<div class="airsense-legend__status is-error">${escapeHtml(state.error)}${typeof state.onRetry === 'function' ? ' <button type="button" class="airsense-legend__retry">Retry</button>' : ''} — no data can be shown until it loads.</div>` : ''}
                ${statusChip(state, live?.label, live?.className)}
                <div class="airsense-legend__about">${LAYER_INFO[mode]?.about || ''}</div>
                ${state.warning ? `<div class="airsense-legend__status">${escapeHtml(state.warning)}</div>` : ''}
                ${mode === 'aqi' && stationStatus ? `<div class="airsense-legend__status">${escapeHtml(stationStatus)}</div>` : ''}
                ${mode === 'aqi' && cityStatus ? `<div class="airsense-legend__status">${escapeHtml(cityStatus)}</div>` : ''}
                <label class="airsense-opacity">Overlay opacity <input data-map-opacity type="range" min="0.15" max="1" step="0.05" value="${state.opacity ?? meta.opacity ?? 0.6}"></label>
                <div class="airsense-legend__meta">
                    <div>Data time: ${timeLabel}</div>
                    <div>${state.payload?.point_count ? `${pointCount} real sample${state.payload.point_count === 1 ? '' : 's'} · resolution ≈ ${gridLabel}` : 'No samples for this view'}</div>
                    <div>Source: ${sourceNote}</div>
                </div>
                <div class="airsense-legend__attribution">
                    <a href="https://open-meteo.com/" target="_blank" rel="noopener">Weather data by Open-Meteo.com (CC BY 4.0)</a><br>
                    ${mode === 'aqi' ? '<a href="https://open-meteo.com/en/docs/air-quality-api" target="_blank" rel="noopener">Air quality by Open-Meteo / CAMS</a><br><a href="https://waqi.info/" target="_blank" rel="noopener">Live monitoring stations by WAQI</a>' : ''}
                </div>
            `;

            container.innerHTML = html;
            const retry = container.querySelector('.airsense-legend__retry');
            if (retry && typeof state.onRetry === 'function') {
                retry.addEventListener('click', state.onRetry);
            }
        };
        control.addTo(map);
        return control;
    }

    window.AirSenseLegends = { createControl, LAYER_INFO, AQI_CATEGORIES };
})();
