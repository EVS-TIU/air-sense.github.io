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

    function gridKey(family, bbox, zoom) {
        return `${family}:${zoom}:${roundedBbox(bbox)}`;
    }

    async function requestJson(url, signal) {
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
            if (!response.ok) {
                let detail = '';
                try {
                    const body = await response.json();
                    detail = typeof body.detail === 'string' ? body.detail : '';
                } catch {
                    // Non-JSON error body.
                }
                throw new Error(detail || `Weather map request failed (${response.status})`);
            }
            return await response.json();
        } finally {
            clearTimeout(timeout);
        }
    }

    async function getGrid(family, bbox, zoom, signal) {
        const key = gridKey(family, bbox, zoom);
        const ttl = family === 'air' ? AIR_TTL_MS : WEATHER_TTL_MS;
        const cached = entries.get(key);
        if (cached && Date.now() - cached.savedAt < ttl) {
            return cached.payload;
        }

        if (inflight.has(key)) return inflight.get(key);

        const endpoint = family === 'air' ? 'map/air-quality' : 'map/weather';
        const url = new URL(`${apiBase()}/${endpoint}`);
        url.searchParams.set('bbox', bbox.map((value) => Number(value).toFixed(4)).join(','));
        url.searchParams.set('zoom', String(zoom));

        const task = requestJson(url.toString(), signal)
            .then((payload) => {
                entries.set(key, { payload, savedAt: Date.now() });
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
        const key = `${Number(latitude).toFixed(4)}:${Number(longitude).toFixed(4)}`;
        const cached = points.get(key);
        if (cached && Date.now() - cached.savedAt < POINT_TTL_MS) {
            return cached.payload;
        }

        const url = new URL(`${apiBase()}/map/point`);
        url.searchParams.set('lat', Number(latitude).toFixed(5));
        url.searchParams.set('lon', Number(longitude).toFixed(5));
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
