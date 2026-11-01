/* ==========================================================================
   AirSense - Interactive World Map Component
   Method A (Search): Search updates map position and marker
   Method B (Interactive Map): User clicks map -> coordinates captured ->
   reverse geocoded -> search bar & weather dashboard update in sync.
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
    const modalMapEl = document.getElementById('modal-map');
    const modalDialog = document.getElementById('map-modal');
    const expandBtn = document.getElementById('map-expand-btn');
    const modalCloseBtn = document.getElementById('map-modal-close');
    const modalBackdrop = document.getElementById('map-modal-backdrop');
    const modalDoneBtn = document.getElementById('modal-map-done');
    const modalStatus = document.getElementById('modal-map-status');

    // Sidebar UI elements
    const sidebarCityEl = document.getElementById('sidebar-city');
    const sidebarRegionEl = document.getElementById('sidebar-region');
    const sidebarCoordsEl = document.getElementById('sidebar-coords');
    const sidebarFlagEl = document.getElementById('sidebar-flag');

    let currentLat = 25.2647;
    let currentLon = 55.2924;
    let currentName = 'Dubai';
    let currentRegion = 'Dubai, United Arab Emirates';
    let currentCountryCode = 'AE';

    let sidebarMap = null;
    let sidebarMarker = null;
    let modalMap = null;
    let modalMarker = null;

    function updateSidebarBadge(name, region, countryCode, lat, lon) {
        if (sidebarCityEl) sidebarCityEl.textContent = name || 'Selected Location';
        if (sidebarRegionEl) sidebarRegionEl.textContent = region || 'Worldwide';
        if (sidebarFlagEl) sidebarFlagEl.textContent = getCountryFlag(countryCode);
        if (sidebarCoordsEl) {
            const latDir = lat >= 0 ? 'N' : 'S';
            const lonDir = lon >= 0 ? 'E' : 'W';
            sidebarCoordsEl.textContent = `${Math.abs(lat).toFixed(2)}° ${latDir}, ${Math.abs(lon).toFixed(2)}° ${lonDir}`;
        }
        if (modalStatus) {
            modalStatus.textContent = `Selected: ${name} (${region || 'Worldwide'})`;
        }
    }

    async function reverseGeocode(lat, lon) {
        const url = new URL(`${apiBase}/location/reverse`, window.location.href);
        url.searchParams.set('latitude', lat.toFixed(5));
        url.searchParams.set('longitude', lon.toFixed(5));

        const resp = await fetch(url, { headers: { Accept: 'application/json' } });
        if (!resp.ok) throw new Error(`Reverse geocode failed (${resp.status})`);
        const data = await resp.json();
        return Array.isArray(data.results) && data.results.length ? data.results[0] : null;
    }

    async function handleMapSelection(lat, lon, zoomLevel, skipReverse, locationMeta) {
        currentLat = Number(lat);
        currentLon = Number(lon);

        if (sidebarMarker) {
            sidebarMarker.setLatLng([currentLat, currentLon]);
        }
        if (sidebarMap) {
            if (zoomLevel) {
                sidebarMap.flyTo([currentLat, currentLon], zoomLevel, { duration: 1.0 });
            } else {
                sidebarMap.panTo([currentLat, currentLon]);
            }
        }

        if (modalMarker) {
            modalMarker.setLatLng([currentLat, currentLon]);
        }
        if (modalMap) {
            if (zoomLevel) {
                modalMap.flyTo([currentLat, currentLon], zoomLevel, { duration: 1.0 });
            } else {
                modalMap.panTo([currentLat, currentLon]);
            }
        }

        if (skipReverse && locationMeta) {
            currentName = locationMeta.name || 'Selected Location';
            currentRegion = locationMeta.region || locationMeta.country || '';
            currentCountryCode = locationMeta.countryCode || '';
            updateSidebarBadge(currentName, currentRegion, currentCountryCode, currentLat, currentLon);

            const popupContent = `<b>${escapeHtml(currentName)}</b>${currentRegion ? `<br><small>${escapeHtml(currentRegion)}</small>` : ''}`;
            if (sidebarMarker) {
                sidebarMarker.bindPopup(popupContent).openPopup();
            }
            if (modalMarker) {
                modalMarker.bindPopup(popupContent).openPopup();
            }
            return;
        }

        // Method B: Reverse-geocode coordinates captured from interactive map
        const tempPopup = '<span>Fetching location details...</span>';
        if (sidebarMarker) sidebarMarker.bindPopup(tempPopup).openPopup();
        if (modalMarker) modalMarker.bindPopup(tempPopup).openPopup();

        try {
            const place = await reverseGeocode(currentLat, currentLon);
            if (place) {
                currentName = place.name || `${Math.abs(currentLat).toFixed(2)}°, ${Math.abs(currentLon).toFixed(2)}°`;
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
                currentName = `${Math.abs(currentLat).toFixed(2)}° ${latDir}, ${Math.abs(currentLon).toFixed(2)}° ${lonDir}`;
                currentRegion = 'Selected Geographical Point';
                currentCountryCode = '';
            }
        } catch (err) {
            console.warn('Reverse geocode error:', err.message);
            const latDir = currentLat >= 0 ? 'N' : 'S';
            const lonDir = currentLon >= 0 ? 'E' : 'W';
            currentName = `${Math.abs(currentLat).toFixed(2)}° ${latDir}, ${Math.abs(currentLon).toFixed(2)}° ${lonDir}`;
            currentRegion = 'Selected Location';
            currentCountryCode = '';
        }

        updateSidebarBadge(currentName, currentRegion, currentCountryCode, currentLat, currentLon);

        const popupHtml = `<b>${escapeHtml(currentName)}</b>${currentRegion ? `<br><small>${escapeHtml(currentRegion)}</small>` : ''}`;
        if (sidebarMarker) sidebarMarker.bindPopup(popupHtml).openPopup();
        if (modalMarker) modalMarker.bindPopup(popupHtml).openPopup();

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
       Sidebar Map Initialization
       ---------------------------------------------------------------------- */
    function initSidebarMap() {
        if (!sidebarMapEl) return;

        sidebarMap = window.L.map(sidebarMapEl, {
            center: [currentLat, currentLon],
            zoom: 10,
            zoomControl: true,
            scrollWheelZoom: true,
            attributionControl: false
        });

        const tileLayer = createTileLayer();
        tileLayer.addTo(sidebarMap);

        sidebarMarker = window.L.marker([currentLat, currentLon], { icon: pinpointIcon }).addTo(sidebarMap);
        sidebarMarker.bindPopup(`<b>${escapeHtml(currentName)}</b><br><small>${escapeHtml(currentRegion)}</small>`);

        sidebarMap.on('click', (e) => {
            handleMapSelection(e.latlng.lat, e.latlng.lng, null, false);
        });

        setTimeout(() => {
            if (sidebarMap) sidebarMap.invalidateSize();
        }, 150);

        updateSidebarBadge(currentName, currentRegion, currentCountryCode, currentLat, currentLon);
    }

    /* ----------------------------------------------------------------------
       Modal (Expanded) World Map Initialization
       ---------------------------------------------------------------------- */
    function openModalMap() {
        if (!modalDialog) return;
        modalDialog.hidden = false;
        modalDialog.setAttribute('aria-hidden', 'false');

        if (!modalMap && modalMapEl) {
            modalMap = window.L.map(modalMapEl, {
                center: [currentLat, currentLon],
                zoom: Math.max(sidebarMap ? sidebarMap.getZoom() : 10, 5),
                zoomControl: true,
                scrollWheelZoom: true
            });

            createTileLayer().addTo(modalMap);

            modalMarker = window.L.marker([currentLat, currentLon], { icon: pinpointIcon }).addTo(modalMap);
            modalMarker.bindPopup(`<b>${escapeHtml(currentName)}</b><br><small>${escapeHtml(currentRegion)}</small>`);

            modalMap.on('click', (e) => {
                handleMapSelection(e.latlng.lat, e.latlng.lng, null, false);
            });
        }

        setTimeout(() => {
            if (modalMap) {
                modalMap.invalidateSize();
                modalMap.setView([currentLat, currentLon], sidebarMap ? sidebarMap.getZoom() : 10);
                if (modalMarker) {
                    modalMarker.setLatLng([currentLat, currentLon]).openPopup();
                }
            }
        }, 150);
    }

    function closeModalMap() {
        if (!modalDialog) return;
        modalDialog.hidden = true;
        modalDialog.setAttribute('aria-hidden', 'true');
        if (sidebarMap) {
            setTimeout(() => sidebarMap.invalidateSize(), 100);
        }
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

        // Avoid re-triggering if coordinates are essentially unchanged
        if (Math.abs(lat - currentLat) < 0.0001 && Math.abs(lon - currentLon) < 0.0001) {
            currentName = city.name || currentName;
            currentRegion = city.region || currentRegion;
            currentCountryCode = city.countryCode || currentCountryCode;
            updateSidebarBadge(currentName, currentRegion, currentCountryCode, lat, lon);
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
            handleMapSelection(detail.latitude, detail.longitude, 10, true, {
                name: detail.name || 'Current Device Location',
                region: detail.country || 'Device GPS',
                country: detail.country || '',
                countryCode: ''
            });
        }
    });

    // Sidebar navigation active state handler
    document.querySelectorAll('.sidebar__nav a').forEach((link) => {
        link.addEventListener('click', (e) => {
            e.preventDefault();
            document.querySelectorAll('.sidebar__nav a').forEach((l) => l.classList.remove('is-active'));
            link.classList.add('is-active');
        });
    });

    // Initialize sidebar map when DOM is ready
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initSidebarMap);
    } else {
        initSidebarMap();
    }

    window.WeatherlyMap = {
        getCoordinates: () => ({ lat: currentLat, lon: currentLon }),
        selectCoordinates: (lat, lon, zoom) => handleMapSelection(lat, lon, zoom, false),
        openModal: openModalMap,
        closeModal: closeModalMap
    };
})();
