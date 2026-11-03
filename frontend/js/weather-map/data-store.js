/* ==========================================================================
   AirSense — shared Open-Meteo map data store
   Fetches viewport grids through the backend, caches them, and shares the same
   payload between the sidebar and expanded maps.
   ========================================================================== */
(function () {
    'use strict';

    const DEFAULT_API_BASE = 'https://airsense-backend-docker.getvoroa.com/api/v1';
    const LOCAL_API_BASE = 'http://127.0.0.1:8000/api/v1';
    const WEATHER_TTL_MS = 5 * 60 * 1000;
    const AIR_TTL_MS = 15 * 60 * 1000;
    const POINT_TTL_MS = 5 * 60 * 1000;
    const REQUEST_TIMEOUT_MS = 20000;

    const entries = new Map();
    const points = new Map();
    const inflight = new Map();
    const STORAGE_PREFIX = 'airsense:weather-grid:';

    function readStored(key) {
        try {
            const raw = window.localStorage.getItem(STORAGE_PREFIX + key);
            if (!raw) return null;
            const entry = JSON.parse(raw);
            return entry && entry.payload ? entry : null;
        } catch { return null; }
    }

    function writeStored(key, payload) {
        try {
            window.localStorage.setItem(STORAGE_PREFIX + key, JSON.stringify({
                savedAt: Date.now(), payload
            }));
        } catch { /* storage quota/private mode: memory cache still works */ }
    }

    function apiBase() {
        if (typeof window.WeatherlyMap?.getApiBase === 'function') {
            return window.WeatherlyMap.getApiBase();
        }
        const local = window.location.hostname === 'localhost' ||
            window.location.hostname === '127.0.0.1';
        const configured = window.AIRSENSE_API_BASE_URL ||
            document.querySelector('meta[name="airsense-api-base"]')?.content;
        return (configured || (local ? LOCAL_API_BASE : DEFAULT_API_BASE)).replace(/\/+$/, '');
    }

    function roundedBbox(bbox) {
        return bbox.map((value) => Number(value).toFixed(2)).join(',');
    }

    function gridKey(family, bbox, zoom, variables, forecastTime) {
        return `${family}:${zoom}:${roundedBbox(bbox)}:${variables || ''}:${forecastTime || 'current'}`;
    }

    async function requestJson(url, signal) {
        let lastError = null;
        for (let attempt = 0; attempt < 3; attempt += 1) {
            if (signal?.aborted) throw new DOMException('Request cancelled', 'AbortError');
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
            const signals = [controller.signal];
            if (signal) signals.push(signal);
            const combined = typeof AbortSignal !== 'undefined' && AbortSignal.any
                ? AbortSignal.any(signals)
                : controller.signal;
            try {
                const response = await fetch(url, {
                    headers: { Accept: 'application/json' },
                    signal: combined
                });
                if (response.ok) return await response.json();
                let detail = '';
                try {
                    const body = await response.json();
                    detail = typeof body.detail === 'string' ? body.detail : '';
                } catch { /* provider may return an empty gateway body */ }
                lastError = new Error(detail || `Weather map request failed (${response.status})`);
                if (response.status < 500 && response.status !== 429) throw lastError;
            } catch (error) {
                if (error?.name === 'AbortError' && signal?.aborted) throw error;
                lastError = error;
            } finally {
                clearTimeout(timeout);
            }
            if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 350 * (2 ** attempt)));
        }
        throw lastError || new Error('Weather map request failed');
    }

    async function getGrid(family, bbox, zoom, variables, signal, forecastTime) {
        if (variables && typeof variables.aborted === 'boolean') {
            signal = variables;
            variables = null;
        }
        const variableList = Array.isArray(variables) ? variables : [];
        const key = gridKey(family, bbox, zoom, variableList.join(','), forecastTime);
        const ttl = family === 'air' ? AIR_TTL_MS : WEATHER_TTL_MS;
        const cached = entries.get(key) || readStored(key);
        if (cached && Date.now() - cached.savedAt < ttl) {
            return cached.payload;
        }

        if (inflight.has(key)) return inflight.get(key);

        const endpoint = family === 'air' ? 'map/air-quality' : 'map/weather';
        const url = new URL(`${apiBase()}/${endpoint}`);
        url.searchParams.set('bbox', bbox.map((value) => Number(value).toFixed(4)).join(','));
        url.searchParams.set('zoom', String(zoom));
        if (variableList.length) url.searchParams.set('variables', variableList.join(','));
        if (forecastTime) url.searchParams.set('time', forecastTime);

        const task = requestJson(url.toString(), signal)
            .then((payload) => {
                entries.set(key, { payload, savedAt: Date.now() });
                writeStored(key, payload);
                return payload;
            })
            .catch((error) => {
                if (cached?.payload) {
                    const stale = { ...cached.payload, stale: true };
                    stale.warnings = [...(stale.warnings || []), 'Showing cached map data'];
                    return stale;
                }
                throw error;
            })
            .finally(() => inflight.delete(key));

        inflight.set(key, task);
        return task;
    }

    async function getPoint(latitude, longitude, signal) {
        const lat = Number(latitude);
        const lon = Number(longitude);
        const key = `${lat}:${lon}`;
        const cached = points.get(key);
        if (cached && Date.now() - cached.savedAt < POINT_TTL_MS) {
            return cached.payload;
        }

        const url = new URL(`${apiBase()}/map/point`);
        url.searchParams.set('lat', String(lat));
        url.searchParams.set('lon', String(lon));
        const payload = await requestJson(url.toString(), signal);
        points.set(key, { payload, savedAt: Date.now() });
        return payload;
    }

    function clear() {
        entries.clear();
        points.clear();
        inflight.clear();
    }

    window.AirSenseMapData = {
        getGrid,
        getPoint,
        clear,
        apiBase,
        roundedBbox
    };
})();
