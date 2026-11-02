/* ==========================================================================
   AirSense - Interactive World Map Component
   One Leaflet instance is used for both the compact sidebar map and the
   expanded modal. The map element is moved between the two hosts so center,
   zoom, marker, popup and weather layers are preserved.
   ========================================================================== */

(function () {
    'use strict';

    if (typeof window.L === 'undefined') {
        console.warn('Leaflet library not loaded.');
        return;
    }

    const isLocalFrontend =
        window.location.hostname === 'localhost' ||
        window.location.hostname === '127.0.0.1';
    const apiBase = (
        window.AIRSENSE_API_BASE_URL ||
        (isLocalFrontend
            ? 'http://127.0.0.1:8000/api/v1'
            : document.querySelector('meta[name="airsense-api-base"]')?.content ||
              'https://airsense-backend-docker.getvoroa.com/api/v1')
    ).replace(/\/+$/, '');

    function getCountryFlag(countryCode) {
        if (!countryCode || countryCode.length !== 2) return '📍';
        try {
            const codePoints = countryCode
                .toUpperCase()
                .split('')
                .map((c) => 127397 + c.charCodeAt(0));
            return String.fromCodePoint(...codePoints);
        } catch {
            return '📍';
        }
    }

    function escapeHtml(text) {
        if (!text) return '';
        return String(text).replace(/[&<>"']/g, (m) => ({
            '&': '&amp;',
            '<': '&lt;',
            '>': '&gt;',
            '"': '&quot;',
            "'": '&#39;'
        }[m]));
    }

    function announceMap(id, map) {
        document.dispatchEvent(new CustomEvent('weatherly:map-ready', {
            detail: { id, map }
        }));
    }

    function enhancePopup(mapId, marker, lat, lon, name, region) {
        if (!window.AirSenseLocationPopup || typeof window.AirSenseLocationPopup.enhance !== 'function') {
            return;
        }
        window.AirSenseLocationPopup.enhance({
            mapId,
            marker,
            lat,
            lon,
            name,
            region
        });
    }

    // Custom pinpoint marker icon with radar pulse
    const pinpointIcon = window.L.divIcon({
        className: 'custom-map-pinpoint',
        html: '<div class="map-marker-pulse"></div><div class="map-marker-pin"></div>',
        iconSize: [30, 42],
        iconAnchor: [15, 36],
        popupAnchor: [0, -34]
    });

    // Tile options: Esri Dark Canvas with OSM fallback (no API key required)
    const esriDarkUrl = 'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}';
    const osmUrl = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';

    function createTileLayer() {
        return window.L.tileLayer(esriDarkUrl, {
            maxZoom: 16,
            minZoom: 2,
            attribution: '&copy; <a href="https://www.esri.com/">Esri</a> &copy; <a href="https://www.openstreetmap.org/copyright">OSM</a>'
        });
    }

    const sidebarMapEl = document.getElementById('interactive-map');
    const modalMapHost = document.getElementById('modal-map');
    const modalDialog = document.getElementById('map-modal');
    const expandBtn = document.getElementById('map-expand-btn');
    const modalCloseBtn = document.getElementById('map-modal-close');
    const modalBackdrop = document.getElementById('map-modal-backdrop');
    const modalDoneBtn = document.getElementById('modal-map-done');
    const modalStatus = document.getElementById('modal-map-status');
    const sidebarMapParent = sidebarMapEl ? sidebarMapEl.parentNode : null;
    const sidebarMapNext = sidebarMapEl ? sidebarMapEl.nextSibling : null;

    // Sidebar UI elements
    const sidebarCityEl = document.getElementById('sidebar-city');
    const sidebarRegionEl = document.getElementById('sidebar-region');
    const sidebarCoordsEl = document.getElementById('sidebar-coords');
    const sidebarFlagEl = null; // removed from UI

    let currentLat = null;
    let currentLon = null;
    let currentAccuracy = null;
    let currentPositionTimestamp = null;
    let currentName = 'Finding your location';
    let currentRegion = '';
    let currentCountryCode = '';
    let selectionSequence = 0;

    let sidebarMap = null;
    let sidebarMarker = null;
    let mapMaximized = false;
    let mapResizeFrame = null;

    function isMaximized() {
        return mapMaximized;
    }

    function scheduleMapResize() {
        if (!sidebarMap) return;
        if (mapResizeFrame !== null) cancelAnimationFrame(mapResizeFrame);
        mapResizeFrame = requestAnimationFrame(() => {
            mapResizeFrame = null;
            if (!sidebarMap) return;
            const view = { center: sidebarMap.getCenter(), zoom: sidebarMap.getZoom() };
            sidebarMap.invalidateSize({ animate: false, pan: false });
            sidebarMap.setView(view.center, view.zoom, { animate: false });
        });
    }

    function locationChipHtml(name, countryCode) {
        const code = String(countryCode || '').trim().toUpperCase();
        return `
            <svg class="airsense-location-chip__icon" viewBox="0 0 24 24" aria-hidden="true">
                <path d="M12 21s-6-5.33-6-10a6 6 0 1 1 12 0c0 4.67-6 10-6 10z"/>
                <circle cx="12" cy="11" r="2.5"/>
            </svg>
            <span class="airsense-location-chip__name">${escapeHtml(name || 'Selected Location')}</span>
            ${code ? `<span class="airsense-location-chip__country">${escapeHtml(code)}</span>` : ''}
        `;
    }

    function updateLocationChip(name, countryCode) {
        if (!sidebarMarker) return;
        const content = locationChipHtml(name, countryCode);
        if (!sidebarMarker.getTooltip()) {
            sidebarMarker.bindTooltip(content, {
                permanent: true,
                direction: 'top',
                offset: [0, -38],
                className: 'airsense-location-chip',
                opacity: 1,
                interactive: false
            });
            sidebarMarker.openTooltip();
        } else {
            sidebarMarker.setTooltipContent(content);
        }
    }

    function popupHtml(name, region) {
        return `<b>${escapeHtml(name || 'Selected Location')}</b>${region ? `<br><small>${escapeHtml(region)}</small>` : ''}`;
    }

    function syncLocationPopup(enrich) {
        if (!sidebarMarker || !sidebarMap) return;
        sidebarMarker.bindPopup(popupHtml(currentName, currentRegion), { autoPan: false });

        if (isMaximized()) {
            sidebarMarker.openPopup();
            if (enrich) {
                enhancePopup('map', sidebarMarker, currentLat, currentLon, currentName, currentRegion);
            }
        } else {
            sidebarMap.closePopup();
        }
    }

    function updateSidebarBadge(name, region, countryCode, lat, lon) {
        if (sidebarCityEl) sidebarCityEl.textContent = name || 'Selected Location';
        if (sidebarRegionEl) {
            sidebarRegionEl.textContent = region || 'Worldwide';
            sidebarRegionEl.title = region || '';
        }
        if (sidebarFlagEl) sidebarFlagEl.textContent = getCountryFlag(countryCode);
        if (sidebarCoordsEl && Number.isFinite(lat) && Number.isFinite(lon)) {
            const latDir = lat >= 0 ? 'N' : 'S';
            const lonDir = lon >= 0 ? 'E' : 'W';
            sidebarCoordsEl.textContent = `${Math.abs(lat).toFixed(6)}° ${latDir}, ${Math.abs(lon).toFixed(6)}° ${lonDir}`;
        } else if (sidebarCoordsEl) {
            sidebarCoordsEl.textContent = 'Waiting for device location';
        }
        if (modalStatus) {
            modalStatus.textContent = Number.isFinite(lat) && Number.isFinite(lon)
                ? `Selected: ${name} (${region || 'Selected location'})`
                : name === 'Location unavailable' ? region : 'Waiting for device location';
        }
        updateLocationChip(name, countryCode);
    }

    async function reverseGeocode(lat, lon) {
        const url = new URL(`${apiBase}/location/reverse`, window.location.href);
        url.searchParams.set('latitude', String(lat));
        url.searchParams.set('longitude', String(lon));

        const resp = await fetch(url, { headers: { Accept: 'application/json' } });
        if (!resp.ok) throw new Error(`Reverse geocode failed (${resp.status})`);
        const data = await resp.json();
        return Array.isArray(data.results) && data.results.length ? data.results[0] : null;
    }

    async function handleMapSelection(lat, lon, zoomLevel, skipReverse, locationMeta) {
        const selectionId = ++selectionSequence;
        currentLat = Number(lat);
        currentLon = Number(lon);

        if (!sidebarMarker && sidebarMap) {
            sidebarMarker = window.L.marker([currentLat, currentLon], { icon: pinpointIcon }).addTo(sidebarMap);
        } else if (sidebarMarker) {
            sidebarMarker.setLatLng([currentLat, currentLon]);
        }
        if (sidebarMap) {
            if (zoomLevel) {
                sidebarMap.flyTo([currentLat, currentLon], zoomLevel, { duration: 1.0 });
            } else {
                sidebarMap.panTo([currentLat, currentLon]);
            }
        }

        if (skipReverse && locationMeta) {
            currentName = locationMeta.name || 'Selected Location';
            currentRegion = locationMeta.region || locationMeta.country || '';
            currentCountryCode = locationMeta.countryCode || '';
            updateSidebarBadge(currentName, currentRegion, currentCountryCode, currentLat, currentLon);
            syncLocationPopup(true);
            return;
        }

        // Method B: Reverse-geocode coordinates captured from interactive map
        try {
            const place = await reverseGeocode(currentLat, currentLon);
            if (selectionId !== selectionSequence) return;
            if (place) {
                currentName = place.name || 'Selected Location';
                const parts = [];
                if (place.district && place.district.toLowerCase() !== currentName.toLowerCase()) {
                    parts.push(place.district);
                }
                if (place.state && place.state.toLowerCase() !== currentName.toLowerCase()) {
                    parts.push(place.state);
                }
                if (place.country && place.country.toLowerCase() !== currentName.toLowerCase()) {
                    parts.push(place.country);
                }
                currentRegion = parts.join(', ');
                currentCountryCode = place.country_code || '';
            } else {
                const latDir = currentLat >= 0 ? 'N' : 'S';
                const lonDir = currentLon >= 0 ? 'E' : 'W';
                currentName = `${Math.abs(currentLat).toFixed(6)}° ${latDir}, ${Math.abs(currentLon).toFixed(6)}° ${lonDir}`;
                currentRegion = 'Selected Geographical Point';
                currentCountryCode = '';
            }
        } catch (err) {
            if (selectionId !== selectionSequence) return;
            console.warn('Reverse geocode error:', err.message);
            const latDir = currentLat >= 0 ? 'N' : 'S';
            const lonDir = currentLon >= 0 ? 'E' : 'W';
            currentName = `${Math.abs(currentLat).toFixed(6)}° ${latDir}, ${Math.abs(currentLon).toFixed(6)}° ${lonDir}`;
            currentRegion = 'Selected Location';
            currentCountryCode = '';
        }

        updateSidebarBadge(currentName, currentRegion, currentCountryCode, currentLat, currentLon);
        syncLocationPopup(true);

        // Synchronize search input field
        const searchInput = document.getElementById('location-search');
        if (searchInput) {
            searchInput.value = currentName;
        }

        // Synchronize state and trigger weather dashboard updates
        const selectedCity = {
            id: `${currentLat},${currentLon}`,
            name: currentName,
            region: currentRegion,
            country: currentRegion,
            countryCode: currentCountryCode,
            lat: currentLat,
            lon: currentLon
        };

        if (window.WeatherlyTopbar?.setLocation) {
            window.WeatherlyTopbar.setLocation(selectedCity);
        } else {
            document.dispatchEvent(new CustomEvent('weatherly:location-change', { detail: selectedCity }));
        }
    }

    /* ----------------------------------------------------------------------
       Map Initialization
       ---------------------------------------------------------------------- */
    function initSidebarMap() {
        if (!sidebarMapEl) return;

        sidebarMap = window.L.map(sidebarMapEl, {
            zoomControl: true,
            scrollWheelZoom: true,
            attributionControl: true
        });
        sidebarMap.fitWorld();

        const tileLayer = createTileLayer();
        tileLayer.addTo(sidebarMap);

        sidebarMap.on('click', (e) => {
            handleMapSelection(e.latlng.lat, e.latlng.lng, null, false);
        });

        setTimeout(() => {
            if (sidebarMap) sidebarMap.invalidateSize();
        }, 150);

        // Keep Leaflet in sync with viewport, orientation, and container changes.
        window.addEventListener('resize', scheduleMapResize);
        window.addEventListener('orientationchange', scheduleMapResize);
        if (window.visualViewport) {
            window.visualViewport.addEventListener('resize', scheduleMapResize);
        }
        if (typeof ResizeObserver === 'function') {
            new ResizeObserver(scheduleMapResize).observe(sidebarMapEl);
        }

        updateSidebarBadge(currentName, currentRegion, currentCountryCode, currentLat, currentLon);
        announceMap('map', sidebarMap);
    }

    /* ----------------------------------------------------------------------
       Modal (Maximized) Map
       The existing Leaflet element is moved into the modal rather than
       creating a second map instance.
       ---------------------------------------------------------------------- */
    function openModalMap() {
        if (!modalDialog || !sidebarMap || !modalMapHost || mapMaximized) return;

        const view = {
            center: sidebarMap.getCenter(),
            zoom: sidebarMap.getZoom()
        };

        mapMaximized = true;
        modalDialog.hidden = false;
        modalDialog.setAttribute('aria-hidden', 'false');

        // Lock the page behind the full-screen map.
        document.documentElement.classList.add('map-maximized');
        document.body.classList.add('map-maximized');

        modalMapHost.appendChild(sidebarMapEl);
        sidebarMapEl.classList.add('is-maximized');

        document.dispatchEvent(new CustomEvent('weatherly:map-modal-open'));

        scheduleMapResize();
        setTimeout(scheduleMapResize, 80);
        setTimeout(scheduleMapResize, 200);
        setTimeout(scheduleMapResize, 400);

        setTimeout(() => {
            if (!sidebarMap) return;
            sidebarMap.invalidateSize({ animate: false });
            sidebarMap.setView(view.center, view.zoom, { animate: false });
            syncLocationPopup(true);
        }, 120);
    }

    function closeModalMap() {
        if (!modalDialog || !mapMaximized) return;

        const view = {
            center: sidebarMap.getCenter(),
            zoom: sidebarMap.getZoom()
        };

        document.dispatchEvent(new CustomEvent('weatherly:map-modal-close'));
        sidebarMap.closePopup();

        if (sidebarMapEl && sidebarMapParent && sidebarMapEl.parentNode === modalMapHost) {
            const before = sidebarMapNext && sidebarMapNext.parentNode === sidebarMapParent
                ? sidebarMapNext
                : null;
            sidebarMapParent.insertBefore(sidebarMapEl, before);
        }
        sidebarMapEl.classList.remove('is-maximized');

        document.documentElement.classList.remove('map-maximized');
        document.body.classList.remove('map-maximized');

        mapMaximized = false;
        modalDialog.hidden = true;
        modalDialog.setAttribute('aria-hidden', 'true');

        scheduleMapResize();
        setTimeout(() => {
            if (sidebarMap) {
                sidebarMap.invalidateSize({ animate: false });
                sidebarMap.setView(view.center, view.zoom, { animate: false });
                syncLocationPopup(false);
            }
        }, 80);
    }

    if (expandBtn) {
        expandBtn.addEventListener('click', openModalMap);
    }
    if (modalCloseBtn) {
        modalCloseBtn.addEventListener('click', closeModalMap);
    }
    if (modalBackdrop) {
        modalBackdrop.addEventListener('click', closeModalMap);
    }
    if (modalDoneBtn) {
        modalDoneBtn.addEventListener('click', closeModalMap);
    }

    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && modalDialog && !modalDialog.hidden) {
            closeModalMap();
        }
    });

    /* ----------------------------------------------------------------------
       Synchronization Listeners: Method A (Search Selection)
       ---------------------------------------------------------------------- */
    document.addEventListener('weatherly:location-change', (e) => {
        const city = e.detail;
        if (!city || !Number.isFinite(Number(city.lat)) || !Number.isFinite(Number(city.lon))) {
            return;
        }

        const lat = Number(city.lat);
        const lon = Number(city.lon);
        currentAccuracy = null;
        currentPositionTimestamp = null;

        // Avoid re-triggering if coordinates are essentially unchanged
        if (Math.abs(lat - currentLat) < 0.0001 && Math.abs(lon - currentLon) < 0.0001) {
            currentName = city.name || currentName;
            currentRegion = city.region || currentRegion;
            currentCountryCode = city.countryCode || currentCountryCode;
            updateSidebarBadge(currentName, currentRegion, currentCountryCode, lat, lon);
            syncLocationPopup(true);
            return;
        }

        handleMapSelection(lat, lon, 10, true, {
            name: city.name,
            region: city.region,
            country: city.country,
            countryCode: city.countryCode
        });
    });

    document.addEventListener('weatherly:device-location-active', (e) => {
        const detail = e.detail;
        if (detail && Number.isFinite(detail.latitude) && Number.isFinite(detail.longitude)) {
            currentAccuracy = Number.isFinite(detail.accuracy) ? detail.accuracy : null;
            currentPositionTimestamp = Number.isFinite(detail.timestamp) ? detail.timestamp : null;
            const deviceCountry = String(detail.country || '').trim();
            const countryCode = String(detail.countryCode || '').trim().toUpperCase() ||
                (/^[A-Za-z]{2}$/.test(deviceCountry) ? deviceCountry.toUpperCase() : '');
            const accuracy = Number.isFinite(detail.accuracy) ? detail.accuracy : null;
            const needsAccuracyNotice = detail.approximate || !Number.isFinite(accuracy) || accuracy > 1000;
            const accuracyLabel = Number.isFinite(accuracy)
                ? accuracy >= 1000 ? `±${(accuracy / 1000).toFixed(1)} km` : `±${Math.round(accuracy)} m`
                : 'unavailable';
            const baseRegion = detail.region || [detail.district, detail.state, detail.country].filter(Boolean).join(', ') || 'Device location';
            const locationNotices = [];
            if (needsAccuracyNotice) {
                locationNotices.push(`Approximate GPS accuracy ${accuracyLabel}; tap Current Location to retry`);
            }
            if (detail.approximateName) {
                locationNotices.push('Place name could not be verified by reverse geocoding');
            }
            const region = [baseRegion, ...locationNotices].filter(Boolean).join(' · ');
            handleMapSelection(detail.latitude, detail.longitude, 10, true, {
                name: detail.name || 'Current Device Location',
                region,
                country: detail.country || '',
                countryCode
            });
        }
    });

    document.addEventListener('weatherly:location-unavailable', () => {
        if (Number.isFinite(currentLat) && Number.isFinite(currentLon)) return;
        currentName = 'Location unavailable';
        currentRegion = 'Allow location access or select a map point';
        updateSidebarBadge(currentName, currentRegion, '', null, null);
    });

    // Sidebar navigation active state handler
    document.querySelectorAll('.sidebar__nav a').forEach((link) => {
        link.addEventListener('click', (e) => {
            e.preventDefault();
            document.querySelectorAll('.sidebar__nav a').forEach((l) => l.classList.remove('is-active'));
            link.classList.add('is-active');

            // Open the sidebar map in its maximized modal state.
            if (link.dataset.nav === 'hotspot-map' || link.dataset.view === 'hotspot-map') {
                openModalMap();
            }

            document.dispatchEvent(new CustomEvent('weatherly:navigate', {
                detail: { view: link.dataset.view || link.dataset.nav },
            }));
        });
    });

    // Initialize the only map instance when DOM is ready
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initSidebarMap);
    } else {
        initSidebarMap();
    }

    window.WeatherlyMap = {
        getCoordinates: () => ({ lat: currentLat, lon: currentLon }),
        selectCoordinates: (lat, lon, zoom) => handleMapSelection(lat, lon, zoom, false),
        openModal: openModalMap,
        closeModal: closeModalMap,
        isMaximized,
        getMaps: () => ({ map: sidebarMap }),
        getApiBase: () => apiBase
    };
})();
