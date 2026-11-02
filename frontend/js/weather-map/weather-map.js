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
            if (stored && isKnownMode(stored)) return stored;
        } catch {
            // Storage can be unavailable in privacy modes.
        }
        return 'standard';
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
        if (!window.WeatherlyMap?.isMaximized?.()) return false;
        const container = controller.map.getContainer?.();
        if (!container) return false;
        return container.offsetWidth > 20 && container.offsetHeight > 20;
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

    function viewportKey(family, bbox, zoom) {
        return `${family}:${zoom}:${dataStore.roundedBbox(bbox)}`;
    }

    function updateLegend(controller, state) {
        if (!controller.legend) return;
        const mode = controller.mode;
        controller.legend.update({
            mode,
            status: 'ready',
            ...state
        });
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

    function clearVisuals(controller) {
        removeScalar(controller);
        removeWind(controller);
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
            controller.overlay = scalarRenderer.render(controller.map, payload, mode);
            controller.overlay.addTo(controller.map);
            if (!controller.wind) {
                controller.wind = windRenderer.createLayer(controller.map);
            }
            if (!controller.map.hasLayer(controller.wind)) {
                controller.map.addLayer(controller.wind);
            }
            controller.wind.setData(payload);
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
        controller.overlay = scalarRenderer.render(controller.map, payload, mode);
        controller.overlay.addTo(controller.map);
        updateLegend(controller, { payload });
    }

    function updateController(controller) {
        const mode = controller.mode;
        const meta = palettes.MODES[mode];

        if (mode === 'standard' || mode === 'satellite' || !meta || meta.family === 'none') {
            clearVisuals(controller);
            updateLegend(controller, { mode });
            return;
        }

        if (!isMapVisible(controller)) return;

        const bbox = viewportBbox(controller.map);
        if (!bbox) return;

        const zoom = viewportZoom(controller.map);
        const family = meta.family;
        const key = viewportKey(family, bbox, zoom);

        if (controller.payload && controller.payloadKey === key) {
            applyPayload(controller, controller.payload, mode, key);
            return;
        }

        const requestId = controller.requestId;
        updateLegend(controller, { status: 'loading' });

        dataStore.getGrid(family, bbox, zoom)
            .then((payload) => {
                if (requestId !== controller.requestId || controller.mode !== mode) return;
                applyPayload(controller, payload, mode, key);
            })
            .catch((error) => {
                if (requestId !== controller.requestId || controller.mode !== mode) return;
                updateLegend(controller, {
                    status: 'error',
                    error: error?.message || 'Unable to load weather data. Please try again.',
                    onRetry: () => scheduleUpdate(controller, 0)
                });
            });
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
        controller.requestId += 1;
        clearVisuals(controller);

        if (mode === 'standard' || mode === 'satellite') {
            updateLegend(controller, { mode });
            return;
        }

        updateLegend(controller, { status: 'loading' });
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
        // Stop the wind animation while the map is compact; it is restored
        // from the cached payload the next time the modal opens.
        removeWind(controller);
    });

    selects.forEach((select) => {
        select.addEventListener('change', () => {
            setMode(select.value);
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
