/* ==========================================================================
   AirSense — popular cities sidebar section
   Searchable country picker + a compact 3 x 3 grid of popular cities.
   ========================================================================== */
(function () {
    'use strict';

    const dataset = window.AIRSENSE_POPULAR_CITIES;
    const root = document.getElementById('popular-cities');

    if (!dataset || !Array.isArray(dataset.countries) || !root) {
        if (root) root.hidden = true;
        return;
    }

    const countries = dataset.countries
        .filter((country) => country && country.code && Array.isArray(country.cities) && country.cities.length)
        .slice()
        .sort((a, b) => a.name.localeCompare(b.name));

    if (!countries.length) {
        root.hidden = true;
        return;
    }

    const countryByCode = new Map(countries.map((country) => [country.code.toUpperCase(), country]));

    // Common alternative names so the country search feels natural.
    const COUNTRY_ALIASES = {
        AE: ['uae'],
        CI: ['cote d ivoire'],
        CV: ['cape verde'],
        CZ: ['czech republic'],
        GB: ['uk', 'britain', 'great britain'],
        KR: ['korea'],
        KP: ['korea'],
        MM: ['burma'],
        NL: ['holland'],
        SZ: ['swaziland'],
        TL: ['east timor'],
        TR: ['turkiye'],
        US: ['usa', 'america', 'united states of america']
    };

    const trigger = document.getElementById('popular-country-trigger');
    const triggerName = document.getElementById('popular-country-name');
    const triggerFlag = document.getElementById('popular-country-flag');
    const panel = document.getElementById('popular-country-panel');
    const search = document.getElementById('popular-country-search');
    const list = document.getElementById('popular-country-list');
    const empty = document.getElementById('popular-country-empty');
    const grid = document.getElementById('popular-cities-grid');
    const count = document.getElementById('popular-cities-count');

    if (!trigger || !panel || !search || !list || !grid) return;

    let selectedCountry = null;
    let currentLocation = null;
    let filteredCountries = countries.slice();
    let activeIndex = -1;
    let optionNodes = [];

    function normalise(value) {
        return String(value ?? '')
            .toLowerCase()
            .normalize('NFD')
            .replace(/[\u0300-\u036f]/g, '')
            .trim();
    }

    function flagFor(code) {
        if (!code || code.length !== 2) return '🌍';
        try {
            return String.fromCodePoint(
                ...code.toUpperCase().split('').map((character) => 127397 + character.charCodeAt(0))
            );
        } catch {
            return '🌍';
        }
    }

    function isFiniteCoordinate(value) {
        return value !== null && value !== undefined && Number.isFinite(Number(value));
    }

    function locationCoordinates(location) {
        if (!location || !isFiniteCoordinate(location.lat) || !isFiniteCoordinate(location.lon)) {
            return null;
        }
        return { lat: Number(location.lat), lon: Number(location.lon) };
    }

    function locationBelongsToCountry(location, country) {
        const code = String(location?.countryCode || '').trim().toUpperCase();
        return !code || code === country.code;
    }

    function findActiveCityIndex(country, location) {
        if (!locationBelongsToCountry(location, country)) return -1;

        const locationName = normalise(location?.name);
        if (locationName) {
            const namedIndex = country.cities.findIndex((city) => normalise(city[0]) === locationName);
            if (namedIndex >= 0) {
                const coordinates = locationCoordinates(location);
                if (!coordinates) return namedIndex;
                const namedCity = country.cities[namedIndex];
                // Guard against same-named cities in different countries.
                if (
                    Math.abs(Number(namedCity[1]) - coordinates.lat) <= 3 &&
                    Math.abs(Number(namedCity[2]) - coordinates.lon) <= 3
                ) {
                    return namedIndex;
                }
            }
        }

        const coordinates = locationCoordinates(location);
        if (!coordinates) return -1;

        let nearestIndex = -1;
        let nearestDistance = Infinity;
        country.cities.forEach((city, index) => {
            const dLat = Number(city[1]) - coordinates.lat;
            const dLon = Number(city[2]) - coordinates.lon;
            const distance = dLat * dLat + dLon * dLon;
            if (distance < nearestDistance) {
                nearestDistance = distance;
                nearestIndex = index;
            }
        });

        // Roughly 28 km; only highlight a city the selected point is inside.
        return nearestDistance <= 0.25 * 0.25 ? nearestIndex : -1;
    }

    function findCountryForLocation(location) {
        const coordinates = locationCoordinates(location);
        if (!coordinates) return null;

        const code = String(location.countryCode || '').trim().toUpperCase();
        if (code && countryByCode.has(code)) return countryByCode.get(code);

        // Reverse geocoding can omit the country code; fall back to the
        // nearest city in the bundled dataset.
        let nearestCountry = null;
        let nearestDistance = Infinity;
        const latitudeScale = Math.cos((coordinates.lat * Math.PI) / 180);

        countries.forEach((country) => {
            country.cities.forEach((city) => {
                const dLat = Number(city[1]) - coordinates.lat;
                const dLon = (Number(city[2]) - coordinates.lon) * latitudeScale;
                const distance = dLat * dLat + dLon * dLon;
                if (distance < nearestDistance) {
                    nearestDistance = distance;
                    nearestCountry = country;
                }
            });
        });

        // Roughly 150 km; avoids snapping a remote click to an unrelated city.
        return nearestDistance <= 1.5 ? nearestCountry : null;
    }

    function readCurrentLocation() {
        const topbarLocation = window.WeatherlyTopbar?.getLocation?.();
        if (locationCoordinates(topbarLocation)) return topbarLocation;

        const mapCoordinates = window.WeatherlyMap?.getCoordinates?.();
        if (mapCoordinates && isFiniteCoordinate(mapCoordinates.lat) && isFiniteCoordinate(mapCoordinates.lon)) {
            return {
                lat: Number(mapCoordinates.lat),
                lon: Number(mapCoordinates.lon),
                name: document.getElementById('sidebar-city')?.textContent.trim() || '',
                region: document.getElementById('sidebar-region')?.textContent.trim() || ''
            };
        }
        return null;
    }

    function updateTrigger() {
        if (!selectedCountry) return;
        triggerName.textContent = selectedCountry.name;
        triggerFlag.textContent = flagFor(selectedCountry.code);
        trigger.setAttribute('aria-label', `Country: ${selectedCountry.name}. Change country`);
    }

    function renderCities(location) {
        if (!selectedCountry) return;
        grid.replaceChildren();

        const activeCityIndex = findActiveCityIndex(selectedCountry, location);

        selectedCountry.cities.forEach((city, index) => {
            const name = String(city[0]);
            const latitude = Number(city[1]);
            const longitude = Number(city[2]);
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'sidebar__city';
            button.textContent = name;
            button.title = `${name}, ${selectedCountry.name}`;
            button.setAttribute('aria-label', `${name}, ${selectedCountry.name}`);

            if (index === activeCityIndex) {
                button.classList.add('is-active');
                button.setAttribute('aria-current', 'true');
            }

            button.addEventListener('click', () => {
                selectCity(name, latitude, longitude);
            });

            grid.append(button);
        });

        if (count) {
            count.textContent = `${selectedCountry.cities.length} ${
                selectedCountry.cities.length === 1 ? 'city' : 'cities'
            }`;
        }
    }

    function selectCity(name, lat, lon) {
        if (!selectedCountry) return;

        const city = {
            id: `${lat},${lon}`,
            name,
            region: selectedCountry.name,
            country: selectedCountry.name,
            countryCode: selectedCountry.code,
            lat,
            lon
        };

        currentLocation = city;
        renderCities(city);
        if (!panel.hidden) closePanel(false);

        if (window.WeatherlyTopbar?.setLocation) {
            window.WeatherlyTopbar.setLocation(city);
        } else {
            document.dispatchEvent(new CustomEvent('weatherly:location-change', { detail: city }));
        }
    }

    function setCountry(country, location) {
        if (!country) return;
        selectedCountry = country;
        updateTrigger();
        renderCities(location);
    }

    /* ----------------------------------------------------------------------
       Searchable country dropdown
       ---------------------------------------------------------------------- */
    function optionId(country) {
        return `popular-country-option-${country.code}`;
    }

    function setActiveOption(index, scroll) {
        if (!filteredCountries.length) {
            activeIndex = -1;
            search.removeAttribute('aria-activedescendant');
            optionNodes.forEach((node) => node.classList.remove('is-active'));
            return;
        }

        activeIndex = ((index % filteredCountries.length) + filteredCountries.length) % filteredCountries.length;
        optionNodes.forEach((node, nodeIndex) => {
            node.classList.toggle('is-active', nodeIndex === activeIndex);
        });
        search.setAttribute('aria-activedescendant', optionId(filteredCountries[activeIndex]));

        if (scroll) {
            optionNodes[activeIndex]?.scrollIntoView({ block: 'nearest' });
        }
    }

    function renderOptions() {
        list.replaceChildren();
        optionNodes = [];

        filteredCountries.forEach((country, index) => {
            const option = document.createElement('li');
            option.className = 'sidebar__country-option';
            option.id = optionId(country);
            option.setAttribute('role', 'option');
            option.setAttribute('aria-selected', String(country === selectedCountry));
            option.dataset.code = country.code;

            const flag = document.createElement('span');
            flag.className = 'sidebar__country-option-flag';
            flag.setAttribute('aria-hidden', 'true');
            flag.textContent = flagFor(country.code);

            const name = document.createElement('span');
            name.className = 'sidebar__country-option-name';
            name.textContent = country.name;

            const code = document.createElement('span');
            code.className = 'sidebar__country-option-code';
            code.textContent = country.code;

            option.append(flag, name, code);
            if (country === selectedCountry) option.classList.add('is-selected');

            option.addEventListener('mouseenter', () => setActiveOption(index, false));
            option.addEventListener('click', () => chooseCountry(country));

            list.append(option);
            optionNodes.push(option);
        });

        if (empty) empty.hidden = filteredCountries.length > 0;
        list.hidden = filteredCountries.length === 0;
    }

    function filterCountries(query) {
        const needle = normalise(query);
        filteredCountries = needle
            ? countries.filter((country) => {
                const aliases = COUNTRY_ALIASES[country.code] || [];
                return (
                    normalise(country.name).includes(needle) ||
                    country.code.toLowerCase().includes(needle) ||
                    aliases.some((alias) => normalise(alias).includes(needle))
                );
            })
            : countries.slice();

        renderOptions();

        if (!filteredCountries.length) {
            setActiveOption(-1, false);
            return;
        }

        const selectedIndex = filteredCountries.indexOf(selectedCountry);
        setActiveOption(selectedIndex >= 0 ? selectedIndex : 0, true);
    }

    function openPanel() {
        if (!panel.hidden) return;
        panel.hidden = false;
        trigger.setAttribute('aria-expanded', 'true');
        search.setAttribute('aria-expanded', 'true');
        root.classList.add('is-open');
        search.value = '';
        filterCountries('');
        search.focus({ preventScroll: true });
    }

    function closePanel(returnFocus) {
        if (panel.hidden) return;
        panel.hidden = true;
        trigger.setAttribute('aria-expanded', 'false');
        search.setAttribute('aria-expanded', 'false');
        search.removeAttribute('aria-activedescendant');
        root.classList.remove('is-open');
        if (returnFocus) trigger.focus({ preventScroll: true });
    }

    function chooseCountry(country) {
        setCountry(country, currentLocation);
        closePanel(true);
    }

    trigger.addEventListener('click', () => {
        if (panel.hidden) openPanel();
        else closePanel(true);
    });

    search.addEventListener('input', () => filterCountries(search.value));

    search.addEventListener('keydown', (event) => {
        if (event.key === 'ArrowDown') {
            event.preventDefault();
            setActiveOption(activeIndex + 1, true);
        } else if (event.key === 'ArrowUp') {
            event.preventDefault();
            setActiveOption(activeIndex - 1, true);
        } else if (event.key === 'Enter') {
            event.preventDefault();
            if (activeIndex >= 0 && filteredCountries[activeIndex]) {
                chooseCountry(filteredCountries[activeIndex]);
            }
        } else if (event.key === 'Escape') {
            event.preventDefault();
            closePanel(true);
        } else if (event.key === 'Tab') {
            closePanel(false);
        }
    });

    document.addEventListener('click', (event) => {
        if (!root.contains(event.target)) closePanel(false);
    });

    /* ----------------------------------------------------------------------
       Synchronisation with the rest of the dashboard
       ---------------------------------------------------------------------- */
    document.addEventListener('weatherly:location-change', (event) => {
        const location = event.detail;
        if (!locationCoordinates(location)) return;

        currentLocation = location;
        const country = findCountryForLocation(location);

        if (country && country !== selectedCountry && locationBelongsToCountry(location, country)) {
            setCountry(country, location);
        } else if (selectedCountry) {
            renderCities(location);
        }
    });

    // Initial state: use the current dashboard location when possible.
    currentLocation = readCurrentLocation();
    const initialCountry =
        findCountryForLocation(currentLocation) ||
        countryByCode.get('AE') ||
        countries[0];

    setCountry(initialCountry, currentLocation);
})();
