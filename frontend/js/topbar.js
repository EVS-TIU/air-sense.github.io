/* ==========================================================================
   TOP NAVIGATION (AKSHAT)
   Search + location selector + section nav + temperature unit + profile.

   Integration contract (other modules listen on `document`):
     weatherly:location-change  detail: { id, name, region, lat, lon }
     weatherly:unit-change      detail: { unit: 'C' | 'F' }
     weatherly:navigate         detail: { view: 'now' | 'today' | 'weekly' | 'history' }
     weatherly:profile-action   detail: { action: 'profile' | 'settings' | 'signout' }

   Pull the current state at any time (e.g. when your module loads):
     WeatherlyTopbar.getLocation()      -> current location object
     WeatherlyTopbar.getUnit()          -> 'C' | 'F'
     WeatherlyTopbar.toDisplayTemp(c)   -> rounded number in the chosen unit
   ========================================================================== */

(function () {
    'use strict';

    const isLocalFrontend =
        window.location.hostname === 'localhost' ||
        window.location.hostname === '127.0.0.1';
    const apiBase = (
        window.AIRSENSE_API_BASE_URL ||
        // Local frontend always talks to the local API; the meta tag pins the
        // deployed API only for hosted (non-local) frontends.
        (isLocalFrontend
            ? 'http://127.0.0.1:8000/api/v1'
            : (document.querySelector('meta[name="airsense-api-base"]')?.content ||
               'https://airsense-backend-docker.getvoroa.com/api/v1'))
    ).replace(/\/+$/, '');

    const LocationService = {
        search(query) {
            const url = new URL(`${apiBase}/location/search`, window.location.href);
            url.searchParams.set('q', query.trim());
            return fetch(url, { headers: { Accept: 'application/json' } })
                .then((response) => {
                    if (!response.ok) throw new Error(`Location search failed (${response.status})`);
                    return response.json();
                })
                .then((payload) => (Array.isArray(payload.results) ? payload.results : []))
                .then((results) => results.map((item) => {
                    const name = item.name || 'Unknown location';
                    const parts = [];
                    if (item.district && item.district.toLowerCase() !== name.toLowerCase()) {
                        parts.push(item.district);
                    }
                    if (item.state && item.state.toLowerCase() !== name.toLowerCase() && (!item.district || item.state.toLowerCase() !== item.district.toLowerCase())) {
                        parts.push(item.state);
                    }
                    if (item.country && item.country.toLowerCase() !== name.toLowerCase()) {
                        parts.push(item.country);
                    }
                    return {
                        id: `${item.latitude},${item.longitude}`,
                        name: name,
                        region: parts.join(', '),
                        country: item.country || '',
                        countryCode: item.country_code || '',
                        lat: Number(item.latitude),
                        lon: Number(item.longitude),
                        type: item.type || 'place',
                    };
                }));
        }
    };

    /* ----------------------------------------------------------------------
       Helpers
       ---------------------------------------------------------------------- */
    const STORAGE_KEYS = { location: 'weatherly.location', unit: 'weatherly.unit' };
    const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

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

    function highlightMatches(text, query) {
        if (!text) return '';
        if (!query) return escapeHtml(text);
        const tokens = query.trim().split(/[, \t]+/).filter((t) => t.length > 0);
        if (!tokens.length) return escapeHtml(text);

        const escapedTokens = tokens.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
        const pattern = new RegExp(`(${escapedTokens.join('|')})`, 'gi');
        const parts = text.split(pattern);

        return parts.map((part) => {
            if (tokens.some((t) => t.toLowerCase() === part.toLowerCase())) {
                return `<mark class="search-box__match">${escapeHtml(part)}</mark>`;
            }
            return escapeHtml(part);
        }).join('');
    }

    function readStorage(key) {
        try { return window.localStorage.getItem(key); } catch (e) { return null; }
    }

    function writeStorage(key, value) {
        try { window.localStorage.setItem(key, value); } catch (e) { /* storage unavailable */ }
    }

    function emit(name, detail) {
        document.dispatchEvent(new CustomEvent('weatherly:' + name, { detail: detail }));
    }

    function el(tag, className, text) {
        const node = document.createElement(tag);
        if (className) node.className = className;
        if (text !== undefined) node.textContent = text;
        return node;
    }

    /* ----------------------------------------------------------------------
       State
       ---------------------------------------------------------------------- */
    const topbar = document.querySelector('.topbar');
    if (!topbar) return;

    const state = {
        location: null,
        searchResults: [],
        unit: readStorage(STORAGE_KEYS.unit) === 'F' ? 'F' : 'C'
    };

    /* ----------------------------------------------------------------------
       Generic dropdown (location, unit, profile) with keyboard support
       ---------------------------------------------------------------------- */
    const dropdowns = [];

    function closeAllDropdowns(except) {
        dropdowns.forEach((d) => { if (d !== except) d.close(false); });
    }

    function createDropdown(root, onSelect) {
        const trigger = root.querySelector('.dropdown__trigger');
        const menu = root.querySelector('.dropdown__menu');
        const items = () => Array.from(menu.querySelectorAll('[data-value]'));

        const api = {
            root: root,
            open(index) {
                closeAllDropdowns(api);
                closeSearchResults();
                menu.hidden = false;
                trigger.setAttribute('aria-expanded', 'true');
                const list = items();
                const selected = list.findIndex((i) => i.getAttribute('aria-selected') === 'true');
                focusItem(index !== undefined ? index : Math.max(selected, 0));
            },
            close(returnFocus) {
                menu.hidden = true;
                trigger.setAttribute('aria-expanded', 'false');
                if (returnFocus) trigger.focus();
            },
            isOpen() { return !menu.hidden; },
            setSelected(value) {
                items().forEach((i) => i.setAttribute('aria-selected', String(i.dataset.value === value)));
            }
        };

        function focusItem(index) {
            const list = items();
            if (!list.length) return;
            list[(index + list.length) % list.length].focus();
        }

        function choose(item) {
            onSelect(item.dataset.value, item);
            api.close(true);
        }

        trigger.addEventListener('click', () => (api.isOpen() ? api.close(false) : api.open()));

        trigger.addEventListener('keydown', (e) => {
            if (e.key === 'ArrowDown') { e.preventDefault(); api.open(0); }
            if (e.key === 'ArrowUp') { e.preventDefault(); api.open(-1); }
        });

        menu.addEventListener('click', (e) => {
            const item = e.target.closest('[data-value]');
            if (item) choose(item);
        });

        menu.addEventListener('keydown', (e) => {
            const list = items();
            const current = list.indexOf(document.activeElement);
            switch (e.key) {
                case 'ArrowDown': e.preventDefault(); focusItem(current + 1); break;
                case 'ArrowUp': e.preventDefault(); focusItem(current - 1); break;
                case 'Home': e.preventDefault(); focusItem(0); break;
                case 'End': e.preventDefault(); focusItem(-1); break;
                case 'Enter':
                case ' ':
                    e.preventDefault();
                    if (current >= 0) choose(list[current]);
                    break;
                case 'Escape': e.preventDefault(); api.close(true); break;
                case 'Tab': api.close(false); break;
            }
        });

        dropdowns.push(api);
        return api;
    }

    document.addEventListener('click', (e) => {
        if (!e.target.closest('.dropdown')) closeAllDropdowns(null);
        if (!e.target.closest('.search-box')) closeSearchResults();
    });

    /* ----------------------------------------------------------------------
       Location selector / Current device location button
       ---------------------------------------------------------------------- */
    const locationBtn = topbar.querySelector('#current-location-btn, .location-btn');
    const locationLabel = document.getElementById('location-label');
    const locationMenu = document.getElementById('location-menu');
    const locationRoot = topbar.querySelector('.location-select.dropdown');

    let locationDropdown = null;
    if (locationRoot && locationMenu) {
        locationDropdown = createDropdown(locationRoot, (id) => {
            const city = state.searchResults.find((item) => item.id === id);
            if (city) setLocation(city);
        });
    }

    if (locationBtn) {
        locationBtn.addEventListener('click', () => {
            if (locationBtn.classList.contains('is-loading')) return;
            if (window.AirSense?.fetchDeviceLocationWeather) {
                window.AirSense.fetchDeviceLocationWeather({ explicitClick: true }).catch(() => {});
            } else {
                document.dispatchEvent(new CustomEvent('weatherly:request-device-location'));
            }
        });
    }

    document.addEventListener('weatherly:device-location-active', (event) => {
        state.location = {
            id: `${event.detail.latitude},${event.detail.longitude}`,
            name: event.detail.name,
            region: event.detail.region || [event.detail.district, event.detail.state, event.detail.country].filter(Boolean).join(', '),
            country: event.detail.country || '',
            countryCode: event.detail.countryCode || '',
            lat: event.detail.latitude,
            lon: event.detail.longitude,
            accuracy: Number.isFinite(event.detail.accuracy) ? event.detail.accuracy : null,
            timestamp: Number.isFinite(event.detail.timestamp) ? event.detail.timestamp : Date.now(),
            source: 'device'
        };
        writeStorage(STORAGE_KEYS.location, state.location.id);
        if (locationBtn) {
            locationBtn.classList.add('is-active');
            const accuracy = state.location.accuracy;
            const accuracyLabel = Number.isFinite(accuracy)
                ? accuracy >= 1000 ? `±${(accuracy / 1000).toFixed(1)} km` : `±${Math.round(accuracy)} m`
                : 'accuracy unavailable';
            const locationHints = [];
            if (event.detail.approximate || !Number.isFinite(accuracy) || accuracy > 1000) {
                locationHints.push(`GPS may be inaccurate (${accuracyLabel}). Click to retry.`);
            } else {
                locationHints.push(`GPS accuracy ${accuracyLabel}. Click to refresh.`);
            }
            if (event.detail.approximateName) {
                locationHints.push('The place name could not be verified by reverse geocoding.');
            }
            locationBtn.setAttribute('title', `${event.detail.name || 'Device location'} · ${locationHints.join(' ')}`);
        }
        if (locationLabel) {
            locationLabel.textContent = event.detail.name || 'Current Location';
        }
    });

    function renderLocationMenu(cities) {
        if (!locationMenu || !locationDropdown) return;
        locationMenu.replaceChildren();
        cities.forEach((city) => {
            const li = el('li', 'dropdown__item');
            li.setAttribute('role', 'option');
            li.tabIndex = -1;
            li.dataset.value = city.id;

            const text = el('div');
            text.append(el('span', null, city.name), el('small', null, city.region));
            li.append(text);
            locationMenu.append(li);
        });
        if (state.location?.id) {
            locationDropdown.setSelected(state.location.id);
        }
    }

    function setLocation(city) {
        state.location = { ...city, accuracy: null, timestamp: Date.now(), source: 'manual' };
        if (locationLabel) {
            locationLabel.textContent = city.name || 'Current Location';
        }
        if (searchInput && document.activeElement !== searchInput) {
            searchInput.value = city.name || '';
        }
        if (locationBtn) {
            locationBtn.classList.remove('is-active');
            locationBtn.setAttribute('title', 'Fetch current device location weather');
        }
        writeStorage(STORAGE_KEYS.location, city.id);

        if (locationMenu && locationDropdown) {
            if (!locationMenu.querySelector('[data-value="' + city.id + '"]')) {
                const li = el('li', 'dropdown__item');
                li.setAttribute('role', 'option');
                li.tabIndex = -1;
                li.dataset.value = city.id;
                const text = el('div');
                text.append(el('span', null, city.name), el('small', null, city.region));
                li.append(text);
                locationMenu.prepend(li);
            }
            locationDropdown.setSelected(city.id);
        }

        emit('location-change', city);
    }

    /* ----------------------------------------------------------------------
       Search (ARIA combobox)
       ---------------------------------------------------------------------- */
    const searchInput = document.getElementById('location-search');
    const searchList = document.getElementById('search-results');
    const searchSpinner = document.getElementById('search-spinner');
    let searchResults = [];
    let activeIndex = -1;
    let requestId = 0;
    let debounceTimer = null;
    const DEBOUNCE_DELAY_MS = 350;

    function setSearching(loading) {
        if (searchSpinner) {
            searchSpinner.hidden = !loading;
        }
    }

    function closeSearchResults() {
        searchList.hidden = true;
        searchInput.setAttribute('aria-expanded', 'false');
        searchInput.removeAttribute('aria-activedescendant');
        activeIndex = -1;
    }

    function setActiveResult(index) {
        const options = searchList.querySelectorAll('[role="option"]');
        options.forEach((o) => o.classList.remove('is-active'));
        activeIndex = index;
        if (index >= 0 && options[index]) {
            options[index].classList.add('is-active');
            options[index].scrollIntoView({ block: 'nearest' });
            searchInput.setAttribute('aria-activedescendant', options[index].id);
        } else {
            searchInput.removeAttribute('aria-activedescendant');
        }
    }

    function renderSearchResults(results, query) {
        searchResults = results.slice(0, 7);
        state.searchResults = searchResults;
        searchList.replaceChildren();

        if (!searchResults.length) {
            const empty = el('li', 'search-box__empty');
            empty.setAttribute('role', 'presentation');
            empty.textContent = query ? `No locations found for \u201C${query}\u201D` : 'No locations found';
            searchList.append(empty);
        } else {
            searchResults.forEach((city, i) => {
                const li = el('li', 'search-box__option');
                li.id = 'search-option-' + i;
                li.setAttribute('role', 'option');

                const flag = el('span', 'search-box__option-flag', getCountryFlag(city.countryCode));
                flag.setAttribute('aria-hidden', 'true');

                const content = el('div', 'search-box__option-content');
                const title = el('div', 'search-box__option-title');
                title.innerHTML = highlightMatches(city.name, query);

                const sub = el('div', 'search-box__option-sub');
                sub.innerHTML = highlightMatches(city.region || city.country, query);

                content.append(title, sub);
                li.append(flag, content);
                li.addEventListener('click', () => chooseSearchResult(city));
                searchList.append(li);
            });
        }

        searchList.hidden = false;
        searchInput.setAttribute('aria-expanded', 'true');
        setActiveResult(searchResults.length ? 0 : -1);
    }

    function chooseSearchResult(city) {
        setLocation(city);
        searchInput.value = city.name;
        closeSearchResults();
        setSearching(false);
        searchInput.blur();
    }

    function runSearch() {
        const query = searchInput.value.trim();
        if (query.length < 2) {
            setSearching(false);
            closeSearchResults();
            return;
        }

        setSearching(true);
        const thisRequest = ++requestId;
        LocationService.search(query).then((results) => {
            if (thisRequest !== requestId) return; // a newer search superseded this one
            setSearching(false);
            renderSearchResults(results, query);
        }).catch(() => {
            if (thisRequest !== requestId) return;
            setSearching(false);
            renderSearchResults([], query);
        });
    }

    searchInput.addEventListener('input', () => {
        const query = searchInput.value.trim();
        if (query.length < 2) {
            clearTimeout(debounceTimer);
            setSearching(false);
            closeSearchResults();
            return;
        }
        setSearching(true);
        clearTimeout(debounceTimer);
        debounceTimer = setTimeout(runSearch, DEBOUNCE_DELAY_MS);
    });

    searchInput.addEventListener('focus', () => {
        closeAllDropdowns(null);
        if (searchInput.value.trim().length >= 2 && searchResults.length > 0) {
            searchList.hidden = false;
            searchInput.setAttribute('aria-expanded', 'true');
        }
    });

    searchInput.addEventListener('keydown', (e) => {
        const open = !searchList.hidden && searchResults.length > 0;
        switch (e.key) {
            case 'ArrowDown':
                if (open) {
                    e.preventDefault();
                    setActiveResult((activeIndex + 1) % searchResults.length);
                } else if (searchInput.value.trim().length >= 2) {
                    runSearch();
                }
                break;
            case 'ArrowUp':
                if (open) {
                    e.preventDefault();
                    setActiveResult((activeIndex - 1 + searchResults.length) % searchResults.length);
                }
                break;
            case 'Enter':
                e.preventDefault();
                if (open) {
                    const target = activeIndex >= 0 ? searchResults[activeIndex] : searchResults[0];
                    if (target) chooseSearchResult(target);
                } else {
                    const query = searchInput.value.trim();
                    if (query.length >= 2) {
                        clearTimeout(debounceTimer);
                        setSearching(true);
                        LocationService.search(query).then((results) => {
                            setSearching(false);
                            if (results.length > 0) {
                                chooseSearchResult(results[0]);
                            } else {
                                renderSearchResults([], query);
                            }
                        }).catch(() => setSearching(false));
                    }
                }
                break;
            case 'Escape':
                e.preventDefault();
                clearTimeout(debounceTimer);
                setSearching(false);
                closeSearchResults();
                if (state.location?.name) {
                    searchInput.value = state.location.name;
                }
                searchInput.blur();
                break;
        }
    });

    // "/" focuses the search box from anywhere (unless already typing).
    document.addEventListener('keydown', (e) => {
        if (e.key !== '/' || e.ctrlKey || e.metaKey || e.altKey) return;
        const t = e.target;
        const typing = t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));
        if (typing) return;
        e.preventDefault();
        searchInput.focus();
    });

    /* ----------------------------------------------------------------------
       Temperature unit
       ---------------------------------------------------------------------- */
    const unitRoot = topbar.querySelector('.unit-select');
    const unitLabel = document.getElementById('unit-label');

    const unitDropdown = createDropdown(unitRoot, (value) => setUnit(value));

    function setUnit(unit) {
        state.unit = unit === 'F' ? 'F' : 'C';
        unitLabel.textContent = '\u00B0' + state.unit;
        document.documentElement.dataset.unit = state.unit;
        unitDropdown.setSelected(state.unit);
        const mobileUnitOptions = topbar.querySelectorAll('.mobile-nav-menu [role="menuitemradio"]');
        mobileUnitOptions.forEach((option) => {
            option.setAttribute('aria-checked', String(option.dataset.value === state.unit));
        });
        writeStorage(STORAGE_KEYS.unit, state.unit);
        emit('unit-change', { unit: state.unit });
    }

    const mobileMenuRoot = topbar.querySelector('.mobile-nav-menu');
    if (mobileMenuRoot) {
        createDropdown(mobileMenuRoot, (action) => {
            if (action === 'C' || action === 'F') {
                setUnit(action);
            } else if (action === 'login') {
                const loginItem = mobileMenuRoot.querySelector('[data-value="login"]');
                if (!loginItem?.dataset.href) {
                    console.error('The mobile login link is missing its destination.');
                    return;
                }
                window.location.assign(loginItem.dataset.href);
            } else if (action === 'climate-analysis') {
                emit('navigate', { view: action });
                window.location.assign('./climate-analysis/climate-analysis-2.html');
            } else {
                const sidebarLink = document.querySelector(`.sidebar__nav a[data-nav="${action}"]`);
                if (sidebarLink) {
                    sidebarLink.click();
                    mobileMenuRoot.querySelectorAll('[data-nav]').forEach((item) => {
                        item.removeAttribute('aria-current');
                    });
                    const mobileNavItem = mobileMenuRoot.querySelector(`[data-value="${action}"]`);
                    if (mobileNavItem) mobileNavItem.setAttribute('aria-current', 'page');
                } else {
                    console.error(`Mobile navigation target "${action}" is missing from the sidebar.`);
                }
            }
        });
    }

    function toDisplayTemp(celsius) {
        return Math.round(state.unit === 'F' ? (celsius * 9) / 5 + 32 : celsius);
    }

    /* ----------------------------------------------------------------------
       Section navigation
       ---------------------------------------------------------------------- */
    const navLinks = Array.from(topbar.querySelectorAll('.topbar-nav a'));

    navLinks.forEach((link) => {
        link.addEventListener('click', (e) => {
            e.preventDefault();

            navLinks.forEach((l) => {
                const active = l === link;
                l.classList.toggle('is-active', active);
                if (active) l.setAttribute('aria-current', 'page');
                else l.removeAttribute('aria-current');
            });

            // Sections that are not built yet (e.g. history) simply have no target.
            const target = link.dataset.target ? document.querySelector(link.dataset.target) : null;
            if (target) {
                target.scrollIntoView({ behavior: prefersReducedMotion ? 'auto' : 'smooth', block: 'start' });
            }

            emit('navigate', { view: link.dataset.view });
        });
    });

    /* ----------------------------------------------------------------------
       Profile menu
       ---------------------------------------------------------------------- */
    const profileRoot = topbar.querySelector('.profile');
    if (profileRoot) {
        createDropdown(profileRoot, (action) => emit('profile-action', { action: action }));
    }

    /* ----------------------------------------------------------------------
       Init + public API
       ---------------------------------------------------------------------- */
    if (locationMenu && locationDropdown) {
        renderLocationMenu([]);
    }
    setUnit(state.unit);

    window.WeatherlyTopbar = {
        getLocation: () => state.location,
        setLocation: setLocation,
        getUnit: () => state.unit,
        toDisplayTemp: toDisplayTemp
    };
})();
