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

    function viewportKey(family, bbox, zoom, mode) {
        return `${family}:${mode || ''}:${zoom}:${dataStore.roundedBbox(bbox)}`;
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

    function clearVisuals(controller) {
        removeScalar(controller);
        removeWind(controller);
        removeOpenWeatherWindTile(controller);
        if (controller.radar && controller.map.hasLayer(controller.radar)) controller.map.removeLayer(controller.radar);
        if (controller.weatherApiTile && controller.map.hasLayer(controller.weatherApiTile)) controller.map.removeLayer(controller.weatherApiTile);
    }

    function applyPayload(controller, payload, mode, key) {
        const meta = palettes.MODES[mode];
        if (!payload || !Array.isArray(payload.segments)) {
            updateLegend(controller, {
                status: 'error',
                error: 'Weather data is unavailable for this view.'
            });
            return;
        }

        controller.payload = payload;
        controller.payloadKey = key;

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
            // Wind is rendered as a static speed field, not as a blurry
            // provider tile. Keep the base map visible underneath it.
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
        updateLegend(controller, { payload });
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
        const key = viewportKey(family, bbox, zoom, mode);

        if (controller.payload && controller.payloadKey === key) {
            applyPayload(controller, controller.payload, mode, key);
            return;
        }

        const requestId = controller.requestId;
        updateLegend(controller, { status: 'loading' });

        const variables = mode === 'wind'
            ? ['wind_speed_10m', 'wind_direction_10m']
            : (family === 'weather' && meta.variable ? [meta.variable] : null);
        dataStore.getGrid(family, bbox, zoom, variables)
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
            return;
        }
        currentMode = mode;
        storeMode(mode);
        updateSelects(mode);
        controllers.forEach((controller) => prepareModeChange(controller, mode));
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
        // Remove the wind layer while the map is compact; it is restored
        // from the cached payload the next time the modal opens.
        removeWind(controller);
    });

    selects.forEach((select) => {
        select.addEventListener('change', () => {
            setMode(select.value);
        });
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
