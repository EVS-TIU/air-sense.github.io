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

    /* ----------------------------------------------------------------------
       Mock location service (Phase 1).
       Keep the same method signatures when this is swapped for the real API
       client in services/api - the UI below only talks to LocationService.
       ---------------------------------------------------------------------- */
    const CITIES = [
        { id: 'oklahoma-city', name: 'Oklahoma City', region: 'Oklahoma, United States', lat: 35.4676, lon: -97.5164 },
        { id: 'new-york', name: 'New York', region: 'New York, United States', lat: 40.7128, lon: -74.006 },
        { id: 'london', name: 'London', region: 'England, United Kingdom', lat: 51.5072, lon: -0.1276 },
        { id: 'paris', name: 'Paris', region: 'Île-de-France, France', lat: 48.8566, lon: 2.3522 },
        { id: 'berlin', name: 'Berlin', region: 'Berlin, Germany', lat: 52.52, lon: 13.405 },
        { id: 'delhi', name: 'New Delhi', region: 'Delhi, India', lat: 28.6139, lon: 77.209 },
        { id: 'mumbai', name: 'Mumbai', region: 'Maharashtra, India', lat: 19.076, lon: 72.8777 },
        { id: 'dubai', name: 'Dubai', region: 'Dubai, United Arab Emirates', lat: 25.2048, lon: 55.2708 },
        { id: 'singapore', name: 'Singapore', region: 'Singapore', lat: 1.3521, lon: 103.8198 },
        { id: 'tokyo', name: 'Tokyo', region: 'Tokyo, Japan', lat: 35.6762, lon: 139.6503 },
        { id: 'sydney', name: 'Sydney', region: 'New South Wales, Australia', lat: -33.8688, lon: 151.2093 },
        { id: 'toronto', name: 'Toronto', region: 'Ontario, Canada', lat: 43.6532, lon: -79.3832 }
    ];

    const LocationService = {
        /** Suggested / recent locations for the location dropdown. */
        popular() {
            return Promise.resolve(CITIES.slice(0, 6));
        },

        /** Search locations by name or region. */
        search(query) {
            const q = query.trim().toLowerCase();
            const results = CITIES
                .filter((c) => (c.name + ' ' + c.region).toLowerCase().includes(q))
                .slice(0, 6);
            return new Promise((resolve) => setTimeout(() => resolve(results), 120));
        },

        getById(id) {
            return CITIES.find((c) => c.id === id) || null;
        }
    };

    /* ----------------------------------------------------------------------
       Helpers
       ---------------------------------------------------------------------- */
    const STORAGE_KEYS = { location: 'weatherly.location', unit: 'weatherly.unit' };
    const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

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
        location: LocationService.getById(readStorage(STORAGE_KEYS.location)) || CITIES[0],
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
       Location selector
       ---------------------------------------------------------------------- */
    const locationRoot = topbar.querySelector('.location-select');
    const locationLabel = document.getElementById('location-label');
    const locationMenu = document.getElementById('location-menu');

    const locationDropdown = createDropdown(locationRoot, (id) => {
        const city = LocationService.getById(id);
        if (city) setLocation(city);
    });

    function renderLocationMenu(cities) {
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
        locationDropdown.setSelected(state.location.id);
    }

    function setLocation(city) {
        state.location = city;
        locationLabel.textContent = city.name;
        writeStorage(STORAGE_KEYS.location, city.id);

        // Make sure a searched city is available (and ticked) in the dropdown.
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

        emit('location-change', city);
    }

    /* ----------------------------------------------------------------------
       Search (ARIA combobox)
       ---------------------------------------------------------------------- */
    const searchInput = document.getElementById('location-search');
    const searchList = document.getElementById('search-results');
    let searchResults = [];
    let activeIndex = -1;
    let requestId = 0;
    let debounceTimer = null;

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
        searchResults = results;
        searchList.replaceChildren();

        if (!results.length) {
            const empty = el('li', 'search-box__empty', 'No locations found for \u201C' + query + '\u201D');
            empty.setAttribute('role', 'presentation');
            searchList.append(empty);
        } else {
            results.forEach((city, i) => {
                const li = el('li', 'search-box__option');
                li.id = 'search-option-' + i;
                li.setAttribute('role', 'option');
                li.append(el('strong', null, city.name), el('span', null, city.region));
                li.addEventListener('click', () => chooseSearchResult(city));
                searchList.append(li);
            });
        }

        searchList.hidden = false;
        searchInput.setAttribute('aria-expanded', 'true');
        setActiveResult(results.length ? 0 : -1);
    }

    function chooseSearchResult(city) {
        setLocation(city);
        searchInput.value = '';
        closeSearchResults();
        searchInput.blur();
    }

    function runSearch() {
        const query = searchInput.value.trim();
        if (!query) { closeSearchResults(); return; }

        const thisRequest = ++requestId;
        LocationService.search(query).then((results) => {
            if (thisRequest !== requestId) return;  // a newer search superseded this one
            renderSearchResults(results, query);
        });
    }

    searchInput.addEventListener('input', () => {
        clearTimeout(debounceTimer);
        debounceTimer = setTimeout(runSearch, 150);
    });

    searchInput.addEventListener('focus', () => closeAllDropdowns(null));

    searchInput.addEventListener('keydown', (e) => {
        const open = !searchList.hidden && searchResults.length > 0;
        switch (e.key) {
            case 'ArrowDown':
                if (open) { e.preventDefault(); setActiveResult((activeIndex + 1) % searchResults.length); }
                break;
            case 'ArrowUp':
                if (open) { e.preventDefault(); setActiveResult((activeIndex - 1 + searchResults.length) % searchResults.length); }
                break;
            case 'Enter':
                if (open && searchResults[activeIndex]) {
                    e.preventDefault();
                    chooseSearchResult(searchResults[activeIndex]);
                }
                break;
            case 'Escape':
                if (!searchList.hidden || searchInput.value) {
                    e.preventDefault();
                    searchInput.value = '';
                    closeSearchResults();
                }
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
        writeStorage(STORAGE_KEYS.unit, state.unit);
        emit('unit-change', { unit: state.unit });
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
    createDropdown(profileRoot, (action) => emit('profile-action', { action: action }));

    /* ----------------------------------------------------------------------
       Init + public API
       ---------------------------------------------------------------------- */
    LocationService.popular().then((cities) => {
        renderLocationMenu(cities);
        setLocation(state.location);   // sync label and announce initial location
    });
    setUnit(state.unit);

    window.WeatherlyTopbar = {
        getLocation: () => state.location,
        getUnit: () => state.unit,
        toDisplayTemp: toDisplayTemp
    };
})();
