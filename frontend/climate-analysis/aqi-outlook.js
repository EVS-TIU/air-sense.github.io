/* ==========================================================================
   AQI Outlook tab — renders into #ca-aqi-outlook
   Real Open-Meteo Air Quality API data (CAMS, same source as History
   Analysis air metrics, available since Jul 2022):
   - Annual average AQI (US AQI, mean of hourly values)
   - Annual average PM2.5, PM10 and NO2
   - Clean air days (days whose mean US AQI ≤ 50, i.e. "Good")
   The running year is kept once it has ~6 months of data (labelled);
   earlier partial years are skipped. Charts/stats react to the location.
   ========================================================================== */
(function () {
    'use strict';
    var host = document.getElementById('ca-aqi-outlook');
    if (!host) return;
    /* ------------------------------------------------------------------
       Data layer
       ------------------------------------------------------------------ */
    var AIR_URL = 'https://air-quality-api.open-meteo.com/v1/air-quality';
    // CAMS-based air quality series starts on 2022-07-28.
    var AIR_MIN_DATE = '2022-07-28';
    // The CAMS archive trails real time by a couple of days; keep a margin.
    var AIR_LAG_DAYS = 3;
    var MIN_HOURS_PER_YEAR = 4200;  // ~6 months of hourly data
    var CLEAN_AQI = 50;             // US AQI "Good" threshold
    var LOCATION_KEY = 'airsense:selected-location';

    var location = { city: 'Selected Location', region: '' };
    var loc = null;                 // { lat, lon }
    var records = null;             // { minYear, maxYear, years[], aqi[], pm25[], pm10[], no2[], clean[] }
    var ranges = [];
    var activeRange = null;
    var fetchId = 0;
    var svgNS = 'http://www.w3.org/2000/svg';
    host.innerHTML =
        '<div class="ao">' +
            '<header class="ao__head">' +
                '<svg class="ao__head-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M3 9h8a3 3 0 1 0-3-3"/><path d="M3 14h13a4 4 0 1 0-4-4"/><path d="M3 19h7a3 3 0 1 1-3 3"/></svg>' +
                '<div class="ao__head-text"><h3 class="ao__title">AQI Outlook</h3><p class="ao__subtitle" data-ao-subtitle></p></div>' +
                '<span class="ao__demo-badge">LIVE DATA</span>' +
                '<select class="ao__range" id="ao-range" aria-label="Historical range"></select>' +
            '</header>' +
            '<p class="ao__status" data-ao-status hidden></p>' +
            '<div class="ao__stats" data-ao-stats></div>' +
            '<div class="ao__charts">' +
                '<article class="ao-chart"><h4 class="ao-chart__title"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 20V4M4 20h17M6 16l4-4 3 2 6-7"/><path d="M15 7h4v4"/></svg>AQI Trend</h4><div class="ao-chart__plot" data-ao-aqi-chart></div><div class="ao-chart__legend"><span class="ao-legend-item"><i class="ao-legend-item__swatch ao-legend-item__swatch--aqi"></i>Annual Avg. AQI</span></div></article>' +
                '<article class="ao-chart"><h4 class="ao-chart__title"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M17.5 15H8a5 5 0 1 1 4.8-6.4h.7a3.7 3.7 0 0 1 4 3.7 3.2 3.2 0 0 1-.1 2.7z"/><path d="M8 18l-1 2.5M12 18l-1 2.5M16 18l-1 2.5"/></svg>Pollutant Trend (Annual Avg.)</h4><div class="ao-chart__plot" data-ao-pollutant-chart></div><div class="ao-chart__legend"><span class="ao-legend-item"><i class="ao-legend-item__swatch ao-legend-item__swatch--pm25"></i>PM2.5</span><span class="ao-legend-item"><i class="ao-legend-item__swatch ao-legend-item__swatch--pm10"></i>PM10</span></div></article>' +
            '</div>' +
            '<aside class="ao__insight"><div class="ao__insight-title"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 4c-9 0-15 4-15 10a6 6 0 0 0 6 6c6 0 9-6 9-16z"/><path d="M4 21c2-5 6-8 11-10"/></svg>Outlook Insight</div><p class="ao__insight-text" data-ao-insight></p></aside>' +
        '</div>';
    var els = {
        subtitle: host.querySelector('[data-ao-subtitle]'),
        stats: host.querySelector('[data-ao-stats]'),
        aqiChart: host.querySelector('[data-ao-aqi-chart]'),
        pollutantChart: host.querySelector('[data-ao-pollutant-chart]'),
        insight: host.querySelector('[data-ao-insight]'),
        range: host.querySelector('#ao-range'),
        status: host.querySelector('[data-ao-status]'),
        badge: host.querySelector('.ao__demo-badge')
    };
    function svgElement(name, attrs) {
        var element = document.createElementNS(svgNS, name);
        Object.keys(attrs || {}).forEach(function (key) { element.setAttribute(key, attrs[key]); });
        return element;
    }
    function svgText(svg, x, y, value, anchor) {
        var element = svgElement('text', { x: x, y: y, 'text-anchor': anchor || 'middle', 'class': 'ao-chart__axis-label' });
        element.textContent = value;
        svg.appendChild(element);
        return element;
    }
    function setStatus(msg, kind) {
        els.status.hidden = !msg;
        els.status.textContent = msg || '';
        els.status.className = 'ao__status' + (kind ? ' is-' + kind : '');
    }
    /* ------------------------------------------------------------------
       Location: the shared selection saved by map.js / topbar.js
       ------------------------------------------------------------------ */
    function readLocation() {
        try {
            var raw = window.localStorage.getItem(LOCATION_KEY);
            if (!raw) return null;
            var saved = JSON.parse(raw);
            var lat = Number(saved.lat), lon = Number(saved.lon);
            if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
            return { name: saved.name, region: saved.region || '', lat: lat, lon: lon };
        } catch (e) { return null; }
    }
    /* ------------------------------------------------------------------
       Fetch + aggregate: hourly values → calendar-year means
       ------------------------------------------------------------------ */
    function isoToday() { return new Date().toISOString().slice(0, 10); }
    function isoShift(iso, days) {
        var d = new Date(iso + 'T00:00:00Z');
        d.setUTCDate(d.getUTCDate() + days);
        return d.toISOString().slice(0, 10);
    }
    function aggregate(body) {
        var times = body.hourly.time;
        var aqiV = body.hourly.us_aqi;
        var pm25V = body.hourly.pm2_5;
        var pm10V = body.hourly.pm10;
        var no2V = body.hourly.nitrogen_dioxide;
        // Daily means first (local calendar days), then annual means.
        var days = {};   // 'YYYY-MM-DD' → { aqiSum, aqiN, pm25Sum, pm25N, pm10Sum, pm10N, no2Sum, no2N }
        for (var i = 0; i < times.length; i++) {
            var day = days[times[i]];
            if (!day) { day = days[times[i]] = { aqiSum: 0, aqiN: 0, pm25Sum: 0, pm25N: 0, pm10Sum: 0, pm10N: 0, no2Sum: 0, no2N: 0 }; }
            var a = aqiV[i], p25 = pm25V[i], p10 = pm10V[i], n2 = no2V[i];
            if (a !== null && a !== undefined) { day.aqiSum += a; day.aqiN += 1; }
            if (p25 !== null && p25 !== undefined) { day.pm25Sum += p25; day.pm25N += 1; }
            if (p10 !== null && p10 !== undefined) { day.pm10Sum += p10; day.pm10N += 1; }
            if (n2 !== null && n2 !== undefined) { day.no2Sum += n2; day.no2N += 1; }
        }
        var buckets = {};   // year → { hours, aqiSum, aqiN, pm25Sum, pm25N, pm10Sum, pm10N, no2Sum, no2N, clean }
        Object.keys(days).sort().forEach(function (day) {
            var d = days[day];
            var year = day.slice(0, 4);
            var b = buckets[year];
            if (!b) { b = buckets[year] = { hours: 0, aqiSum: 0, aqiN: 0, pm25Sum: 0, pm25N: 0, pm10Sum: 0, pm10N: 0, no2Sum: 0, no2N: 0, clean: 0, days: 0 }; }
            b.days += 1;
            b.hours += d.aqiN;
            if (d.aqiN) { b.aqiSum += d.aqiSum / d.aqiN; b.aqiN += 1; if ((d.aqiSum / d.aqiN) <= CLEAN_AQI) { b.clean += 1; } }
            if (d.pm25N) { b.pm25Sum += d.pm25Sum / d.pm25N; b.pm25N += 1; }
            if (d.pm10N) { b.pm10Sum += d.pm10Sum / d.pm10N; b.pm10N += 1; }
            if (d.no2N) { b.no2Sum += d.no2Sum / d.no2N; b.no2N += 1; }
        });
        var years = [], aqi = [], pm25 = [], pm10 = [], no2 = [], clean = [];
        Object.keys(buckets).sort().forEach(function (year) {
            var b = buckets[year];
            // Skip years with too little data (record start / running year).
            if (b.hours < MIN_HOURS_PER_YEAR) return;
            years.push(Number(year));
            aqi.push(b.aqiN ? b.aqiSum / b.aqiN : null);
            pm25.push(b.pm25N ? b.pm25Sum / b.pm25N : null);
            pm10.push(b.pm10N ? b.pm10Sum / b.pm10N : null);
            no2.push(b.no2N ? b.no2Sum / b.no2N : null);
            clean.push(b.clean);
        });
        if (years.length < 2) return null;
        return { minDate: AIR_MIN_DATE, years: years, aqi: aqi, pm25: pm25, pm10: pm10, no2: no2, clean: clean };
    }
    // Half-mean comparison (same logic as History Analysis trend stat).
    function halfMeanChange(values) {
        var half = Math.floor(values.length / 2);
        var mean = function (arr) { return arr.reduce(function (a, b) { return a + b; }, 0) / (arr.length || 1); };
        var before = mean(values.slice(0, half));
        var after = mean(values.slice(values.length - half));
        return { before: before, after: after, change: after - before };
    }
    function pct(before, after) {
        if (!before) return 0;
        return ((after - before) / Math.abs(before)) * 100;
    }
    function buildRanges(rec) {
        var total = rec.years.length;
        function def(trailing, label) {
            var n = Math.min(trailing, total);
            var from = total - n;
            var slice = function (arr) { return arr.slice(from); };
            var a = halfMeanChange(slice(rec.aqi));
            var p25 = halfMeanChange(slice(rec.pm25));
            var n2 = halfMeanChange(slice(rec.no2));
            var cl = halfMeanChange(slice(rec.clean));
            return {
                id: 'y' + trailing,
                years: n,
                label: rec.years[from] + ' \u2013 ' + rec.years[total - 1] + ' (' + label + ')',
                data: {
                    years: rec.years.slice(from),
                    aqi: slice(rec.aqi),
                    pm25: slice(rec.pm25),
                    pm10: slice(rec.pm10),
                    no2: slice(rec.no2),
                    clean: slice(rec.clean),
                    aqiChange: a.change,
                    pm25Change: pct(p25.before, p25.after),
                    no2Change: pct(n2.before, n2.after),
                    cleanDaysChange: Math.round(cl.change),
                    firstYear: rec.years[from],
                    lastYear: rec.years[total - 1]
                }
            };
        }
        var opts = [def(total, 'Full record'), def(5, 'Recent'), def(3, 'Recent')];
        // Drop duplicate trailing windows when the record is short.
        return opts.filter(function (opt, i) { return i === 0 || opt.years !== opts[i - 1].years; });
    }
    async function fetchAqi() {
        if (!loc) return;
        var myId = ++fetchId;
        setStatus('Loading air-quality history for ' + location.city + '\u2026');
        try {
            var url = new URL(AIR_URL);
            url.searchParams.set('latitude', loc.lat.toFixed(4));
            url.searchParams.set('longitude', loc.lon.toFixed(4));
            url.searchParams.set('start_date', AIR_MIN_DATE);
            url.searchParams.set('end_date', isoShift(isoToday(), -AIR_LAG_DAYS));
            url.searchParams.set('hourly', 'us_aqi,pm2_5,pm10,nitrogen_dioxide');
            url.searchParams.set('timezone', 'auto');
            var res = await fetch(url.toString());
            var body = await res.json();
            if (myId !== fetchId) return;
            if (body.error) throw new Error(body.reason || 'Open-Meteo request failed');
            var rec = aggregate(body);
            if (!rec) throw new Error('Not enough air-quality history for this location');
            records = rec;
            ranges = buildRanges(rec);
            activeRange = ranges[0].id;
            els.range.innerHTML = ranges.map(function (r) {
                return '<option value="' + r.id + '">' + r.label + '</option>';
            }).join('');
            els.range.value = activeRange;
            els.range.disabled = ranges.length < 2;
            render();
            setStatus('');
        } catch (err) {
            if (myId !== fetchId) return;
            console.warn('AQI Outlook load failed:', err);
            setStatus('Could not load air-quality data: ' + (err.message || err), 'error');
        }
    }
    function activeData() {
        var range = ranges.find(function (r) { return r.id === activeRange; }) || ranges[0];
        return range.data;
    }
    function stat(icon, tone, label, value, note) {
        return '<article class="ao-stat ao-stat--' + tone + '">' + icon +
            '<div class="ao-stat__body"><span class="ao-stat__label">' + label + '</span>' +
            '<strong class="ao-stat__value">' + value + '</strong><span class="ao-stat__note">' + note + '</span></div></article>';
    }
    function renderStats(data) {
        var sign = data.aqiChange >= 0 ? '+' : '\u2212';
        var pmSign = data.pm25Change >= 0 ? '+' : '\u2212';
        var no2Sign = data.no2Change >= 0 ? '+' : '\u2212';
        var cleanSign = data.cleanDaysChange > 0 ? '+' : '\u2212';
        els.stats.innerHTML =
            stat('<svg class="ao-stat__icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3a9 9 0 1 0 9 9"/><path d="M12 7v5l3 2"/><path d="M16 3h5v5"/></svg>', 'aqi', 'Avg. AQI Change', sign + Math.abs(data.aqiChange).toFixed(1), '(vs. ' + data.firstYear + ' baseline)') +
            stat('<svg class="ao-stat__icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M20 4c-9 0-15 4-15 10a6 6 0 0 0 6 6c6 0 9-6 9-16z"/><path d="M4 21c2-5 6-8 11-10"/></svg>', 'pm25', 'PM2.5 Trend', pmSign + Math.abs(data.pm25Change).toFixed(1) + '%', '(annual average)') +
            stat('<svg class="ao-stat__icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M3 9h8a3 3 0 1 0-3-3"/><path d="M3 14h13a4 4 0 1 0-4-4"/><path d="M3 19h7a3 3 0 1 1-3 3"/></svg>', 'no2', 'NO\u2082 Trend', no2Sign + Math.abs(data.no2Change).toFixed(1) + '%', '(annual average)') +
            stat('<svg class="ao-stat__icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M3 12c3-7 15-7 18 0-3 7-15 7-18 0z"/><circle cx="12" cy="12" r="3"/></svg>', 'clean', 'Clean Air Days', cleanSign + Math.abs(data.cleanDaysChange) + ' days', '(per year)');
    }
    function renderAqiChart(data) {
        var width = 560, height = 220, margin = { top: 16, right: 12, bottom: 32, left: 44 };
        var plotWidth = width - margin.left - margin.right;
        var plotHeight = height - margin.top - margin.bottom;
        var max = Math.max(200, Math.ceil(Math.max.apply(null, data.aqi.filter(function (v) { return v !== null; })) / 50) * 50);
        var min = 0;
        var x = function (index) { return margin.left + (data.years.length === 1 ? plotWidth / 2 : plotWidth * index / (data.years.length - 1)); };
        var y = function (value) { return margin.top + plotHeight * (1 - (value - min) / (max - min)); };
        var svg = svgElement('svg', { viewBox: '0 0 ' + width + ' ' + height, role: 'img', 'aria-label': 'Annual average US AQI trend for ' + location.city });
        svg.appendChild(svgElement('title')).textContent = 'Annual average US AQI for ' + location.city;
        for (var tick = 0; tick <= max; tick += 50) {
            var yy = y(tick);
            svg.appendChild(svgElement('line', { x1: margin.left, y1: yy, x2: width - margin.right, y2: yy, 'class': 'ao-chart__grid' }));
            svgText(svg, margin.left - 8, yy + 4, String(tick), 'end');
        }
        var points = data.aqi.map(function (value, index) { return x(index) + ',' + y(value); });
        var areaPath = 'M' + x(0) + ',' + y(min) + ' L' + points.join(' L') + ' L' + x(data.aqi.length - 1) + ',' + y(min) + ' Z';
        svg.appendChild(svgElement('path', { d: areaPath, fill: 'rgba(255, 129, 75, 0.18)' }));
        svg.appendChild(svgElement('polyline', { points: points.join(' '), fill: 'none', stroke: '#ff814b', 'stroke-width': 3, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }));
        data.aqi.forEach(function (value, index) {
            var point = svgElement('circle', { cx: x(index), cy: y(value), r: data.years.length > 8 ? 3.5 : 4.5, 'class': 'ao-chart__point' });
            point.appendChild(svgElement('title')).textContent = data.years[index] + ': AQI ' + Math.round(value);
            svg.appendChild(point);
            if (data.years.length <= 6 || index % 2 === 0 || index === data.years.length - 1) svgText(svg, x(index), height - 9, String(data.years[index]));
        });
        els.aqiChart.replaceChildren(svg);
    }
    function renderPollutantChart(data) {
        var width = 560, height = 220, margin = { top: 16, right: 12, bottom: 32, left: 54 };
        var plotWidth = width - margin.left - margin.right;
        var plotHeight = height - margin.top - margin.bottom;
        var flat = data.pm25.concat(data.pm10).filter(function (v) { return v !== null; });
        var max = Math.max(50, Math.ceil(Math.max.apply(null, flat) / 20) * 20);
        var stepV = Math.ceil(max / 5 / 10) * 10;
        var groupWidth = plotWidth / data.years.length;
        var barWidth = Math.min(15, groupWidth * 0.28);
        var svg = svgElement('svg', { viewBox: '0 0 ' + width + ' ' + height, role: 'img', 'aria-label': 'Annual average PM2.5 and PM10 trends for ' + location.city + ', micrograms per cubic meter' });
        svg.appendChild(svgElement('title')).textContent = 'Annual average PM2.5 and PM10 for ' + location.city;
        for (var tick = 0; tick <= max; tick += stepV) {
            var yy = margin.top + plotHeight * (1 - tick / max);
            svg.appendChild(svgElement('line', { x1: margin.left, y1: yy, x2: width - margin.right, y2: yy, 'class': 'ao-chart__grid' }));
            svgText(svg, margin.left - 8, yy + 4, tick + ' \u00b5g/m\u00b3', 'end');
        }
        data.years.forEach(function (year, index) {
            var center = margin.left + groupWidth * (index + 0.5);
            [
                { key: 'pm25', className: 'ao-chart__bar--pm25', dx: -barWidth / 2, label: 'PM2.5' },
                { key: 'pm10', className: 'ao-chart__bar--pm10', dx: barWidth / 2, label: 'PM10' }
            ].forEach(function (series) {
                var value = data[series.key][index];
                var barHeight = plotHeight * Math.min(value, max) / max;
                var bar = svgElement('rect', {
                    x: center + series.dx - barWidth / 2,
                    y: margin.top + plotHeight - barHeight,
                    width: barWidth,
                    height: barHeight,
                    rx: 2,
                    'class': series.className
                });
                bar.appendChild(svgElement('title')).textContent = year + ': ' + series.label + ' ' + value.toFixed(1) + ' \u00b5g/m\u00b3';
                svg.appendChild(bar);
            });
            if (data.years.length <= 6 || index % 2 === 0 || index === data.years.length - 1) svgText(svg, center, height - 9, String(year));
        });
        els.pollutantChart.replaceChildren(svg);
    }
    function render() {
        if (!records || !ranges.length) return;
        var data = activeData();
        els.subtitle.textContent = 'Real air-quality history (Open-Meteo CAMS archive, since Jul 2022) for ' + location.city + (location.region ? ', ' + location.region : '') + '.';
        renderStats(data);
        renderAqiChart(data);
        renderPollutantChart(data);
        var first = data.aqi[0], last = data.aqi[data.aqi.length - 1];
        els.insight.textContent = location.city + "'s annual average US AQI was about " + Math.round(first) +
            ' in ' + data.firstYear + ' and ' + Math.round(last) + ' in ' + data.lastYear +
            '. PM2.5 averages ' + data.pm25[data.pm25.length - 1].toFixed(1) + ' \u00b5g/m\u00b3 and PM10 ' +
            data.pm10[data.pm10.length - 1].toFixed(1) + ' \u00b5g/m\u00b3 in the latest year. About ' +
            data.clean[data.clean.length - 1] + ' days per year stay in the "Good" AQI band (\u2264 50). Source: Open-Meteo CAMS air-quality archive.';
    }
    function setLocation(detail) {
        if (!detail || typeof detail !== 'object') return;
        var city = String(detail.name || detail.city || '').trim();
        if (!city || /^(current location|device location)$/i.test(city)) return;
        var lat = Number(detail.lat !== undefined ? detail.lat : detail.latitude);
        var lon = Number(detail.lon !== undefined ? detail.lon : detail.longitude);
        var region = String(detail.region || detail.country || '').trim();
        var nextLoc = Number.isFinite(lat) && Number.isFinite(lon) ? { lat: lat, lon: lon } : null;
        if (city === location.city && region === location.region && (!nextLoc || (loc && nextLoc.lat === loc.lat && nextLoc.lon === loc.lon))) return;
        location = { city: city, region: region };
        loc = nextLoc || readLocation();
        records = null;
        ranges = [];
        els.stats.innerHTML = '';
        els.aqiChart.replaceChildren();
        els.pollutantChart.replaceChildren();
        els.insight.textContent = '';
        els.range.disabled = true;
        if (!loc) {
            setStatus('No coordinates for ' + city + ' yet — pick a location first.', 'error');
            return;
        }
        fetchAqi();
    }
    /* Overview feed for the Generate Analysis pipeline. */
    window.AqiOutlook = {
        getSeries: function () {
            if (!records || !ranges.length) return { tab: 'AQI Outlook', ready: false, location: location.city };
            var range = ranges.find(function (r) { return r.id === activeRange; }) || ranges[0];
            return {
                tab: 'AQI Outlook',
                ready: true,
                location: location.city,
                range: range.label,
                years: range.data.years,
                aqi: range.data.aqi,
                pm25: range.data.pm25,
                pm10: range.data.pm10,
                no2: range.data.no2,
                clean: range.data.clean
            };
        }
    };
    els.range.addEventListener('change', function () {
        activeRange = els.range.value;
        render();
    });
    document.addEventListener('weatherly:location-change', function (event) { setLocation(event.detail); });
    document.addEventListener('weatherly:device-location-active', function (event) { setLocation(event.detail); });
    var currentLocation = window.WeatherlyTopbar && window.WeatherlyTopbar.getLocation();
    if (currentLocation && Number.isFinite(Number(currentLocation.lat))) {
        setLocation(currentLocation);
    } else {
        var saved = readLocation();
        if (saved) {
            setLocation({ name: saved.name, region: saved.region, lat: saved.lat, lon: saved.lon });
        } else {
            setStatus('Pick a location to load its air-quality history.');
        }
    }
})();
