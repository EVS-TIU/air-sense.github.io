/* ==========================================================================
   AirSense — weather map layer orchestration
   Owns the selected layer mode, viewport fetching, overlay swapping, loading
   and error state, and keeps the sidebar map and expanded modal map in sync.
   ========================================================================== */
(function () {
    'use strict';

    const STORAGE_KEY = 'airsense:map-layer';
    const VIEWPORT_DEBOUNCE_MS = 450;
    const MODAL_OPEN_DELAY_MS = 350;
    const INITIAL_DELAY_MS = 300;
    const FORECAST_MODES = new Set(['wind', 'humidity', 'rainfall', 'clouds']);

    const palettes = window.AirSensePalettes;
    const dataStore = window.AirSenseMapData;
    const scalarRenderer = window.AirSenseScalarRenderer;
    const windRenderer = window.AirSenseWindRenderer;
    const legends = window.AirSenseLegends;

    if (!palettes || !dataStore || !scalarRenderer || !windRenderer || !legends) {
        console.warn('Weather map layer modules are unavailable.');
        return;
    }

    const controllers = new Map();
    let radarManifestCache = null;
    let radarManifestFetchedAt = 0;
    const selects = [
        document.getElementById('sidebar-map-layer'),
        document.getElementById('modal-map-layer')
    ].filter(Boolean);
    const layerButtons = [...document.querySelectorAll('[data-layer-mode]')];
    const timeSlider = document.querySelector('[data-map-time-slider]');
    const timeLabel = document.querySelector('[data-map-time-label]');
    const timeStatus = document.querySelector('[data-map-time-status]');
    const timeTicks = document.querySelector('[data-map-time-ticks]');
    const timePlay = document.querySelector('[data-map-time-play]');
    const timePrev = document.querySelector('[data-map-time-prev]');
    const timeNext = document.querySelector('[data-map-time-next]');
    const timelineStart = new Date();
    timelineStart.setUTCMinutes(0, 0, 0);
    const timelineTimes = Array.from({ length: 25 }, (_, index) =>
        new Date(timelineStart.getTime() + index * 60 * 60 * 1000).toISOString()
    );
    let currentForecastTime = null;
    let timelineTimer = null;

    function isKnownMode(mode) {
        return Object.prototype.hasOwnProperty.call(palettes.MODES, mode);
    }

    function readStoredMode() {
        try {
            const stored = window.localStorage.getItem(STORAGE_KEY);
            if (stored && isKnownMode(stored) && stored !== 'standard') return stored;
        } catch {
            // Storage can be unavailable in privacy modes.
        }
        return 'satellite';
    }

    function storeMode(mode) {
        try {
            window.localStorage.setItem(STORAGE_KEY, mode);
        } catch {
            // Ignore storage failures; the in-memory mode still works.
        }
    }

    let currentMode = readStoredMode();

    function updateSelects(mode) {
        selects.forEach((select) => {
            if (select.value !== mode) select.value = mode;
        });
    }

    function isMapVisible(controller) {
        const container = controller.map.getContainer?.();
        if (!container) return false;
        // The same Leaflet instance moves between the sidebar and full-screen
        // modal. Weather layers must work in both places; only skip a map that
        // is genuinely hidden or has not been laid out yet.
        const bounds = container.getBoundingClientRect();
        return bounds.width > 20 && bounds.height > 20 &&
            getComputedStyle(container).visibility !== 'hidden';
    }

    function viewportBbox(map) {
        const bounds = map.getBounds?.();
        if (!bounds) return null;
        const west = Number(bounds.getWest());
        const south = Number(bounds.getSouth());
        const east = Number(bounds.getEast());
        const north = Number(bounds.getNorth());
        if (![west, south, east, north].every(Number.isFinite)) return null;
        if (!(north > south)) return null;
        return [west, south, east, north];
    }

    function viewportZoom(map) {
        const zoom = Number(map.getZoom());
        return Math.max(0, Math.min(19, Math.round(Number.isFinite(zoom) ? zoom : 5)));
    }

    function viewportKey(family, bbox, zoom, mode, forecastTime) {
        return `${family}:${mode || ''}:${zoom}:${dataStore.roundedBbox(bbox)}:${forecastTime || 'current'}`;
    }

    function isForecastMode(mode) {
        return FORECAST_MODES.has(mode);
    }

    function formatTimelineTime(value) {
        if (!value) return 'Now';
        const date = new Date(value);
        return Number.isNaN(date.getTime()) ? 'Now' : date.toLocaleString([], {
            weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false, timeZoneName: 'short'
        });
    }

    function updateTimeline() {
        const enabled = isForecastMode(currentMode);
        if (timeSlider) {
            timeSlider.disabled = !enabled;
            timeSlider.max = String(timelineTimes.length - 1);
            timeSlider.value = currentForecastTime ? String(Math.max(0, timelineTimes.indexOf(currentForecastTime))) : '0';
        }
        if (timeLabel) timeLabel.textContent = currentForecastTime ? formatTimelineTime(currentForecastTime) : 'Now';
        if (timeStatus) timeStatus.textContent = enabled
            ? (currentForecastTime ? 'Forecast hour' : 'Current conditions')
            : 'Available for forecast layers';
        if (timeTicks) {
            timeTicks.innerHTML = [0, 6, 12, 18, 24].map((index) => `<span>${index === 0 ? 'Now' : `+${index}h`}</span>`).join('');
        }
        layerButtons.forEach((button) => {
            button.classList.toggle('is-active', button.dataset.layerMode === currentMode);
            button.setAttribute('aria-pressed', button.dataset.layerMode === currentMode ? 'true' : 'false');
        });
    }

    function stopTimeline() {
        if (timelineTimer) window.clearInterval(timelineTimer);
        timelineTimer = null;
        if (timePlay) {
            timePlay.classList.remove('is-playing');
            timePlay.textContent = '▶';
        }
    }

    function setForecastTime(index) {
        const numeric = Math.max(0, Math.min(timelineTimes.length - 1, Number(index) || 0));
        currentForecastTime = numeric === 0 ? null : timelineTimes[numeric];
        updateTimeline();
        controllers.forEach((controller) => {
            if (isForecastMode(controller.mode)) scheduleUpdate(controller, 80);
        });
    }

    function stepTimeline(amount) {
        const currentIndex = currentForecastTime ? Math.max(0, timelineTimes.indexOf(currentForecastTime)) : 0;
        const next = currentIndex + amount;
        if (next >= timelineTimes.length || next < 0) {
            stopTimeline();
            return;
        }
        setForecastTime(next);
    }

    function updateLegend(controller, state) {
        if (!controller.legend) return;
        const mode = controller.mode;
        controller.legendState = {
            ...(controller.legendState || {}),
            mode,
            status: 'ready',
            opacity: controller.opacities[controller.mode] ?? palettes.MODES[controller.mode]?.opacity ?? 0.6,
            ...state
        };
        controller.legend.update(controller.legendState);
    }

    function removeScalar(controller) {
        if (controller.overlay) {
            controller.map.removeLayer(controller.overlay);
            controller.overlay = null;
        }
    }

    function removeAqiStations(controller) {
        controller.stationRequestId = (controller.stationRequestId || 0) + 1;
        if (controller.stationOverlay && controller.map.hasLayer(controller.stationOverlay)) {
            controller.map.removeLayer(controller.stationOverlay);
        }
        controller.stationOverlay = null;
    }

    function removeAqiCities(controller) {
        if (controller.cityOverlay && controller.map.hasLayer(controller.cityOverlay)) {
            controller.map.removeLayer(controller.cityOverlay);
        }
        controller.cityOverlay = null;
        controller.cityCount = 0;
        controller.cityState = 'none';
    }

    function escapeHtml(value) {
        return String(value ?? '').replace(/[&<>"']/g, (character) => ({
            '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
        }[character]));
    }

    function refreshAqiStations(controller, bbox, zoom) {
        removeAqiStations(controller);
        if (zoom < 7) {
            updateLegend(controller, { stationStatus: 'zoom-in', stationCount: 0 });
            return;
        }
        const requestId = controller.stationRequestId;
        const viewportRequestId = controller.requestId;
        updateLegend(controller, { stationStatus: 'loading', stationCount: 0 });
        dataStore.getStations(bbox)
            .then((result) => {
                if (controller.mode !== 'aqi' || requestId !== controller.stationRequestId ||
                    viewportRequestId !== controller.requestId) return;
                const stations = Array.isArray(result?.stations) ? result.stations : [];
                if (result?.status !== 'available' || !stations.length) {
                    updateLegend(controller, {
                        stationStatus: result?.status === 'not_configured' ? 'not-configured' : 'unavailable',
                        stationCount: 0
                    });
                    return;
                }
                const group = window.L.layerGroup();
                const stationRenderer = window.L.canvas({ padding: 0.5 });
                stations.forEach((station) => {
                    const lat = Number(station.latitude);
                    const lon = Number(station.longitude);
                    const value = Number(station.aqi);
                    if (![lat, lon, value].every(Number.isFinite)) return;
                    const rgb = palettes.colorFor('aqi', value) || [150, 150, 150];
                    const color = `rgb(${rgb[0]}, ${rgb[1]}, ${rgb[2]})`;
                    const marker = window.L.circleMarker([lat, lon], {
                        radius: zoom >= 10 ? 8 : 6,
                        renderer: stationRenderer,
                        color: '#f5f9fc',
                        weight: 1.5,
                        opacity: 1,
                        fillColor: color,
                        fillOpacity: 0.96
                    });
                    const link = /^https?:\/\//i.test(station.url)
                        ? `<br><a href="${escapeHtml(station.url)}" target="_blank" rel="noopener">WAQI station</a>`
                        : '';
                    marker.bindPopup(`<strong>${escapeHtml(station.name)}</strong><br>WAQI station AQI: <b>${Math.round(value)}</b><br>Loading PM readings…${link}`);
                    marker.on('popupopen', () => {
                        if (marker.stationDetailsLoaded) return;
                        marker.stationDetailsLoaded = true;
                        dataStore.getStation(station.id)
                            .then((details) => {
                                if (!marker.isPopupOpen()) return;
                                const pm25 = Number(details?.pm2_5);
                                const pm10 = Number(details?.pm10);
                                const detailLink = /^https?:\/\//i.test(details?.url)
                                    ? `<br><a href="${escapeHtml(details.url)}" target="_blank" rel="noopener">WAQI source</a>` : link;
                                const time = details?.timestamp ? `<br><small>${escapeHtml(details.timestamp)} · WAQI</small>` : '';
                                marker.setPopupContent(
                                    `<strong>${escapeHtml(details?.name || station.name)}</strong>` +
                                    `<br>WAQI station AQI: <b>${Number.isFinite(Number(details?.aqi)) ? Math.round(Number(details.aqi)) : Math.round(value)}</b>` +
                                    `<br>PM2.5: ${Number.isFinite(pm25) ? pm25.toFixed(1) : '—'} µg/m³` +
                                    `<br>PM10: ${Number.isFinite(pm10) ? pm10.toFixed(1) : '—'} µg/m³${time}${detailLink}`
                                );
                            })
                            .catch(() => {
                                if (marker.isPopupOpen()) marker.setPopupContent(
                                    `<strong>${escapeHtml(station.name)}</strong><br>WAQI station AQI: <b>${Math.round(value)}</b><br>PM readings unavailable${link}`
                                );
                            });
                    });
                    marker.bindTooltip(`${escapeHtml(station.name)} · AQI ${Math.round(value)}`, { direction: 'top' });
                    group.addLayer(marker);
                });
                controller.stationOverlay = group.addTo(controller.map);
                updateLegend(controller, { stationStatus: 'available', stationCount: stations.length });
            })
            .catch(() => {
                if (controller.mode === 'aqi' && requestId === controller.stationRequestId &&
                    viewportRequestId === controller.requestId) {
                    updateLegend(controller, { stationStatus: 'unavailable', stationCount: 0 });
                }
            });
    }

    /* -------------------------------------------------------------------
       City AQI indicators (maximized AQI view)
       The most populated city per country is labeled with the US AQI of the
       nearest real CAMS grid cell — the cell IS the displayed value, so no
       interpolation or invented city detail is introduced.
       ------------------------------------------------------------------- */
    const AQI_CITY_ZOOM_MIN = 4;
    const AQI_CITY_MAX_MARKERS = 110;

    function nearestSampleValue(payload, latitude, longitude) {
        let best = null;
        let bestDistance = Infinity;
        payload.segments.forEach((segment) => {
            const matrix = segment.values?.us_aqi;
            if (!Array.isArray(matrix)) return;
            let latIndex = -1;
            let latDistance = Infinity;
            segment.latitudes.forEach((sample, index) => {
                const delta = Math.abs(sample - latitude);
                if (delta < latDistance) {
                    latDistance = delta;
                    latIndex = index;
                }
            });
            let lonIndex = -1;
            let lonDistance = Infinity;
            segment.longitudes.forEach((sample, index) => {
                const delta = Math.abs(sample - longitude);
                if (delta < lonDistance) {
                    lonDistance = delta;
                    lonIndex = index;
                }
            });
            const value = Number(matrix[latIndex]?.[lonIndex]);
            if (!Number.isFinite(value)) return;
            const maxDistance = Math.max(latDistance, lonDistance);
            if (maxDistance < bestDistance) {
                bestDistance = maxDistance;
                // Attribute the value only when the city lies inside that
                // segment's real sampling cell; otherwise nothing is shown.
                const step = segment.resolution_deg || 1;
                best = maxDistance <= step * 0.5 ? value : null;
            }
        });
        return best;
    }

    function refreshAqiCities(controller) {
        removeAqiCities(controller);
        const zoom = viewportZoom(controller.map);
        if (zoom < AQI_CITY_ZOOM_MIN) {
            controller.cityState = 'zoom-in';
            return;
        } else if (controller.cityState === 'zoom-in') {
            controller.cityState = 'available';
        }
        const payload = controller.payload;
        if (!payload?.segments?.length) return;
        const countries = window.AIRSENSE_POPULAR_CITIES;
        if (!Array.isArray(countries)) return;
        const bounds = controller.map.getBounds();
        const group = window.L.layerGroup();

        cities:
        for (const country of countries) {
            const city = country?.cities?.[0];
            if (!city) continue;
            const [name, rawLat, rawLon] = city;
            const lat = Number(rawLat);
            const lon = Number(rawLon);
            if (![lat, lon].every(Number.isFinite)) continue;
            if (!bounds.contains([lat, lon])) continue;
            const value = nearestSampleValue(payload, lat, lon);
            if (value === null) continue;
            const rgb = palettes.colorFor('aqi', value) || [160, 160, 160];
            // Keep the city label readable on every category colour band.
            const luminance = rgb[0] * 0.299 + rgb[1] * 0.587 + rgb[2] * 0.114;
            const nameColor = luminance > 145 ? '#0b1a28' : '#f2f7fc';
            const marker = window.L.marker([lat, lon], {
                icon: window.L.divIcon({
                    className: 'airsense-aqi-chip-host',
                    html:
                        `<span class="airsense-aqi-chip" style="background:rgb(${rgb[0]}, ${rgb[1]}, ${rgb[2]})">` +
                        `<b>${Math.round(value)}</b><i style="color:${nameColor}">${escapeHtml(name)}</i></span>`,
                    iconSize: [0, 0],
                    iconAnchor: [0, 0]
                }),
                pane: 'aqiCityPane',
                keyboard: false,
                title: `${name} — CAMS US AQI ≈ ${Math.round(value)}`
            });
            marker.bindPopup(
                `<div class="airsense-popup"><div class="airsense-popup__heading"><b>${escapeHtml(name)}</b></div>` +
                `<div class="airsense-popup__loading">Loading live air-quality details…</div></div>`
            );
            marker.on('popupopen', () => {
                window.AirSenseLocationPopup?.enhance?.({
                    mapId: `${controller.id}-cities`,
                    marker,
                    lat,
                    lon,
                    name
                });
            });
            group.addLayer(marker);
            if (group.getLayers().length >= AQI_CITY_MAX_MARKERS) break cities;
        }

        if (group.getLayers().length) {
            controller.cityOverlay = group.addTo(controller.map);
            controller.cityCount = group.getLayers().length;
            controller.cityState = 'available';
        } else {
            controller.cityState = 'none';
        }
    }

    function removeWind(controller) {
        if (controller.wind && controller.map.hasLayer(controller.wind)) {
            controller.map.removeLayer(controller.wind);
        }
    }

    function removeOpenWeatherWindTile(controller) {
        if (controller.openWeatherWindTile && controller.map.hasLayer(controller.openWeatherWindTile)) {
            controller.map.removeLayer(controller.openWeatherWindTile);
        }
    }

    function showOpenWeatherWindTile(controller) {
        // The vector renderer normally creates this pane. The fallback can
        // run before any vector payload exists, so create it explicitly.
        scalarRenderer.ensureWeatherPane(controller.map);
        if (!controller.openWeatherWindTile) {
            controller.openWeatherWindTile = window.L.tileLayer(
                `${dataStore.apiBase()}/map/wind-tile/{z}/{x}/{y}.png`,
                {
                    minZoom: 2,
                    maxZoom: 19,
                    opacity: 0.62,
                    pane: 'weatherPane',
                    attribution: 'Wind tiles by <a href="https://openweathermap.org/">OpenWeather</a>'
                }
            );
        }
        if (!controller.map.hasLayer(controller.openWeatherWindTile)) {
            controller.openWeatherWindTile.addTo(controller.map);
        }
    }

    function ensureAqiCityPane(map) {
        let pane = map.getPane('aqiCityPane');
        if (!pane) {
            pane = map.createPane('aqiCityPane');
            pane.style.zIndex = '640';
        }
        return pane;
    }

    function clearVisuals(controller) {
        removeAqiStations(controller);
        removeAqiCities(controller);
        removeScalar(controller);
        removeWind(controller);
        removeOpenWeatherWindTile(controller);
        if (controller.radar && controller.map.hasLayer(controller.radar)) controller.map.removeLayer(controller.radar);
        if (controller.weatherApiTile && controller.map.hasLayer(controller.weatherApiTile)) controller.map.removeLayer(controller.weatherApiTile);
    }

    function applyPayload(controller, payload, mode, key) {
        const meta = palettes.MODES[mode];
        if (!payload || !Array.isArray(payload.segments)) {
            removeAqiCities(controller);
            updateLegend(controller, {
                status: 'error',
                error: 'Weather data is unavailable for this view.'
            });
            return;
        }

        controller.payload = payload;
        controller.payloadKey = key;

        if (mode === 'aqi') {
            ensureAqiCityPane(controller.map);
            refreshAqiStations(controller, viewportBbox(controller.map), viewportZoom(controller.map));
            refreshAqiCities(controller);
        }

        if (mode === 'wind') {
            removeOpenWeatherWindTile(controller);
            const field = windRenderer.buildField(payload);
            if (!field) {
                updateLegend(controller, {
                    status: 'error',
                    error: 'No wind data was returned for this view.'
                });
                return;
            }
            if (!scalarRenderer.hasData(payload, mode)) {
                updateLegend(controller, {
                    status: 'error',
                    error: 'No wind intensity data was returned for this view.'
                });
                return;
            }
            removeScalar(controller);
            // Wind is rendered by the bounded Canvas particle field. Keep the
            // base map visible underneath it while the vector data loads.
            if (!controller.wind) {
                controller.wind = windRenderer.createLayer(controller.map);
            }
            if (!controller.map.hasLayer(controller.wind)) {
                controller.map.addLayer(controller.wind);
            }
            controller.wind.setData(payload);
            controller.wind.setOpacity(controller.opacities[mode] ?? meta.opacity);
            updateLegend(controller, { payload });
            return;
        }

        removeWind(controller);
        if (!scalarRenderer.hasData(payload, mode)) {
            removeScalar(controller);
            updateLegend(controller, {
                status: 'error',
                error: `No ${meta.label.toLowerCase()} data was returned for this view.`
            });
            return;
        }
        removeScalar(controller);
        controller.overlay = scalarRenderer.render(controller.map, payload, mode, controller.opacities[mode]);
        controller.overlay.addTo(controller.map);
        updateLegend(controller, {
            payload,
            warning: mode === 'aqi' && payload.resolution_limited
                ? 'This view is sampled coarser than the CAMS native grid; zoom in for source-cell detail.'
                : null,
            cityStatus: controller.cityState || 'none',
            cityCount: controller.cityCount || 0
        });
    }

    function updateController(controller) {
        const mode = controller.mode;
        const meta = palettes.MODES[mode];

        if (mode === 'radar') {
            loadRadar(controller);
            return;
        }
        if (mode === 'standard' || mode === 'satellite' || !meta || meta.family === 'none') {
            clearVisuals(controller);
            updateLegend(controller, { mode });
            return;
        }

        if (!isMapVisible(controller)) return;

        if (meta.provider === 'weatherapi') {
            loadWeatherApiTile(controller, mode);
            if (mode !== 'wind') return;
        }

        const bbox = viewportBbox(controller.map);
        if (!bbox) return;

        const zoom = viewportZoom(controller.map);
        const family = meta.family;
        const forecastTime = isForecastMode(mode) ? currentForecastTime : null;
        const key = viewportKey(family, bbox, zoom, mode, forecastTime);

        if (controller.payload && controller.payloadKey === key) {
            applyPayload(controller, controller.payload, mode, key);
            return;
        }

        const requestId = controller.requestId;
        updateLegend(controller, { status: 'loading' });

        const variables = mode === 'wind'
            ? ['wind_speed_10m', 'wind_direction_10m']
            : (family === 'weather' && meta.variable ? [meta.variable] : null);
        dataStore.getGrid(family, bbox, zoom, variables, undefined, forecastTime)
            .then((payload) => {
                if (requestId !== controller.requestId || controller.mode !== mode) return;
                applyPayload(controller, payload, mode, key);
            })
            .catch((error) => {
                if (requestId !== controller.requestId || controller.mode !== mode) return;
                // A WeatherAPI tile is an independent, valid layer. An
                // Open-Meteo failure only removes the optional wind field;
                // it must never turn a working speed tile into a layer error.
                if (meta.provider === 'weatherapi' && controller.weatherApiTile) {
                    updateLegend(controller, {
                        status: 'ready',
                        warning: mode === 'wind'
                            ? 'Animated flow temporarily unavailable; WeatherAPI speed tile is current.'
                            : 'WeatherAPI map tile is current; secondary point data is unavailable.',
                        warningTimestamp: new Date().toISOString(),
                        payload: controller.payload || null
                    });
                    return;
                }
                if (mode === 'wind') {
                    // Keep Wind usable when the gridded Open-Meteo request is
                    // rate-limited: the backend tile is still real wind data.
                    // Remove any stale vector layer before showing the tile.
                    removeWind(controller);
                    removeScalar(controller);
                    showOpenWeatherWindTile(controller);
                    updateLegend(controller, {
                        status: 'ready',
                        warning: 'Live vector wind unavailable; showing the real-time wind tile fallback.'
                    });
                    return;
                }
                if (controller.overlay) {
                    updateLegend(controller, {
                        status: 'ready',
                        warning: 'Provider unavailable; keeping the last valid field with its original timestamp.',
                        warningTimestamp: new Date().toISOString()
                    });
                    return;
                }
                updateLegend(controller, {
                    status: 'error',
                    error: error?.message || 'Unable to load weather data. Please try again.',
                    onRetry: () => scheduleUpdate(controller, 0)
                });
            });
    }

    function loadWeatherApiTile(controller, mode) {
        const layerPaths = {
            temperature: 'tmp2m', rainfall: 'precip', pressure: 'pressure', wind: 'wind'
        };
        const path = layerPaths[mode];
        if (!path) return;
        scalarRenderer.ensureWeatherPane(controller.map);
        const validTime = new Date();
        validTime.setUTCMinutes(0, 0, 0);
        const stamp = validTime.toISOString().replace(/[-:T]/g, '').slice(0, 10);
        const opacity = controller.opacities[mode] ?? (mode === 'wind' ? 0.16 : palettes.MODES[mode].opacity);
        if (controller.weatherApiTile && controller.weatherApiTileMode === mode && controller.weatherApiStamp === stamp) {
            controller.weatherApiTile.setOpacity(opacity);
            if (!controller.map.hasLayer(controller.weatherApiTile)) controller.weatherApiTile.addTo(controller.map);
            updateLegend(controller, { tileTime: validTime.toISOString(), tileSource: 'WeatherAPI' });
            return;
        }
        if (controller.weatherApiTile && controller.map.hasLayer(controller.weatherApiTile)) controller.map.removeLayer(controller.weatherApiTile);
        controller.weatherApiTileMode = mode;
        controller.weatherApiStamp = stamp;
        controller.weatherApiTile = window.L.tileLayer(
            `https://weathermaps.weatherapi.com/${path}/tiles/${stamp}/{z}/{x}/{y}.png`,
            { minZoom: 0, maxZoom: 19, opacity, pane: 'weatherPane', attribution: 'Weather map tiles by <a href="https://www.weatherapi.com/docs/weather-maps/">WeatherAPI.com</a>' }
        ).addTo(controller.map);
        controller.weatherApiTile.on('tileerror', () => {
            controller.weatherApiTileErrors = (controller.weatherApiTileErrors || 0) + 1;
            if (controller.weatherApiTileErrors >= 3 && controller.mode === mode) {
                updateLegend(controller, {
                    status: 'ready',
                    warning: 'Some WeatherAPI tiles could not be loaded; retrying on the next map move.'
                });
            }
        });
        controller.weatherApiTile.on('load', () => {
            controller.weatherApiTileErrors = 0;
            if (controller.mode === mode) updateLegend(controller, { status: 'ready', warning: null });
        });
        updateLegend(controller, { status: 'ready', tileTime: validTime.toISOString(), tileSource: 'WeatherAPI' });
    }

    async function loadRadar(controller) {
        if (!isMapVisible(controller)) return;
        scalarRenderer.ensureWeatherPane(controller.map);
        const requestId = controller.requestId;
        updateLegend(controller, { status: 'loading' });
        try {
            let manifest = radarManifestCache;
            if (!manifest || Date.now() - radarManifestFetchedAt > 120000) {
                const response = await fetch('https://api.rainviewer.com/public/weather-maps.json', { cache: 'no-store' });
                if (!response.ok) throw new Error(`Radar metadata unavailable (${response.status})`);
                manifest = await response.json();
                radarManifestCache = manifest;
                radarManifestFetchedAt = Date.now();
            }
            if (requestId !== controller.requestId || controller.mode !== 'radar') return;
            const frames = manifest?.radar?.past;
            const frame = Array.isArray(frames) && frames.length ? frames[frames.length - 1] : null;
            if (!frame?.path || !manifest.host) throw new Error('No recent radar frame is available for this view.');
            if (controller.radar) controller.map.removeLayer(controller.radar);
            controller.radar = window.L.tileLayer(`${manifest.host}${frame.path}/256/{z}/{x}/{y}/2/1_1.png`, {
                minZoom: 0, maxNativeZoom: 7, maxZoom: 19, opacity: controller.opacities.radar ?? palettes.MODES.radar.opacity,
                pane: 'weatherPane', attribution: 'Weather data by <a href="https://www.rainviewer.com/">RainViewer</a>'
            }).addTo(controller.map);
            updateLegend(controller, { status: 'ready', radarTime: frame.time, radarGenerated: manifest.generated });
        } catch (error) {
            if (requestId !== controller.requestId) return;
            updateLegend(controller, { status: 'error', error: error?.message || 'Radar data unavailable. Check again shortly.' });
        }
    }

    function scheduleUpdate(controller, delay) {
        if (!controller) return;
        clearTimeout(controller.timer);
        // Invalidate any in-flight response as soon as a newer viewport or
        // mode arrives, even while the debounce timer is still running.
        controller.requestId += 1;
        controller.timer = setTimeout(() => {
            controller.timer = null;
            updateController(controller);
        }, delay);
    }

    function prepareModeChange(controller, mode) {
        clearTimeout(controller.timer);
        controller.timer = null;
        controller.mode = mode;
        controller.legendState = {};
        controller.requestId += 1;
        clearVisuals(controller);

        if (mode === 'standard' || mode === 'satellite') {
            updateLegend(controller, { mode });
            return;
        }

        updateLegend(controller, { status: 'loading' });
        // Put the real wind tile on screen immediately. If the gridded
        // Open-Meteo request succeeds, applyPayload removes this tile and
        // replaces it with the static wind field; if it is rate-limited,
        // the tile remains visible instead of leaving the user with no layer.
        if (mode === 'wind') {
            showOpenWeatherWindTile(controller);
        }
        updateController(controller);
    }

    function setMode(mode) {
        if (!isKnownMode(mode) || mode === currentMode) {
            updateSelects(currentMode);
            updateTimeline();
            return;
        }
        currentMode = mode;
        storeMode(mode);
        if (!isForecastMode(mode)) stopTimeline();
        updateSelects(mode);
        controllers.forEach((controller) => prepareModeChange(controller, mode));
        updateTimeline();
        document.dispatchEvent(new CustomEvent('weatherly:layer-change', {
            detail: { mode }
        }));
    }

    function createController(id, map) {
        if (!map || controllers.has(id)) return controllers.get(id) || null;

        const legend = legends.createControl(map, id);
        const controller = {
            id,
            map,
            legend,
            mode: currentMode,
            payload: null,
            payloadKey: null,
            overlay: null,
            wind: null,
            radar: null,
            weatherApiTile: null,
            openWeatherWindTile: null,
            weatherApiTileMode: null,
            weatherApiStamp: null,
            legendState: {},
            opacities: {},
            requestId: 0,
            timer: null
        };

        updateLegend(controller, controller.mode === 'standard'
            ? { mode: 'standard' }
            : { status: 'loading' });

        map.on('moveend', () => {
            if (controller.mode !== 'standard') {
                scheduleUpdate(controller, VIEWPORT_DEBOUNCE_MS);
            }
        });

        controllers.set(id, controller);

        if (currentMode !== 'standard') {
            scheduleUpdate(controller, INITIAL_DELAY_MS);
        }

        return controller;
    }

    function registerExistingMaps() {
        const maps = window.WeatherlyMap?.getMaps?.();
        if (!maps) return;
        if (maps.map) createController('map', maps.map);
    }

    document.addEventListener('weatherly:map-ready', (event) => {
        const detail = event.detail || {};
        if (detail.id && detail.map) {
            createController(detail.id, detail.map);
        }
    });

    document.addEventListener('weatherly:map-modal-open', () => {
        const controller = controllers.get('map');
        if (controller) {
            scheduleUpdate(controller, MODAL_OPEN_DELAY_MS);
        }
    });

    document.addEventListener('weatherly:map-modal-close', () => {
        const controller = controllers.get('map');
        if (!controller) return;
        clearTimeout(controller.timer);
        controller.timer = null;
        controller.requestId += 1;
        // Keep the same Canvas layer alive while the map element moves back
        // to the sidebar. The renderer pauses during the move and resumes
        // after Leaflet reports the new viewport, avoiding a blank/flickering
        // wind layer and avoiding a second data fetch.
    });

    selects.forEach((select) => {
        select.addEventListener('change', () => {
            setMode(select.value);
        });
    });

    layerButtons.forEach((button) => {
        button.addEventListener('click', () => setMode(button.dataset.layerMode));
    });

    timeSlider?.addEventListener('input', () => setForecastTime(timeSlider.value));
    timePrev?.addEventListener('click', () => stepTimeline(-1));
    timeNext?.addEventListener('click', () => stepTimeline(1));
    timePlay?.addEventListener('click', () => {
        if (!isForecastMode(currentMode)) return;
        if (timelineTimer) {
            stopTimeline();
            return;
        }
        timePlay.classList.add('is-playing');
        timePlay.textContent = '❚❚';
        timelineTimer = window.setInterval(() => stepTimeline(1), 1400);
    });

    document.addEventListener('input', (event) => {
        if (!event.target.matches('[data-map-opacity]')) return;
        const value = Number(event.target.value);
        controllers.forEach((controller) => {
            controller.opacities[controller.mode] = value;
            if (controller.overlay?.eachLayer) controller.overlay.eachLayer((layer) => layer.setOpacity?.(value));
            else controller.overlay?.setOpacity?.(value);
            controller.radar?.setOpacity(value);
            controller.weatherApiTile?.setOpacity(value);
            controller.wind?.setOpacity?.(value);
            updateLegend(controller, { opacity: value });
        });
    });

    function init() {
        updateSelects(currentMode);
        updateTimeline();
        registerExistingMaps();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

    window.AirSenseWeatherMap = {
        setMode,
        getMode: () => currentMode,
        getControllers: () => controllers
    };
})();
