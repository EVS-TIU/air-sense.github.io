/* ==========================================================================
   AQI Outlook tab — renders into #ca-aqi-outlook
   One-custom-date view driven by the backend MLP prediction (no direct
   external API calls): the Weather Prediction tab fans the prediction for
   the picked calendar day out to this tab via the
   weatherly:prediction-data / -blank / -error events, and this tab shows
   that day's hourly US AQI and pollutant values in the same layout.
   ========================================================================== */
(function () {
    'use strict';
    var host = document.getElementById('ca-aqi-outlook');
    if (!host) return;
    /* ------------------------------------------------------------------
       Data layer
       ------------------------------------------------------------------ */
    var LOCATION_KEY = 'airsense:selected-location';

    var location = { city: 'Selected Location', region: '' };
    var records = null;             // { years (hour labels), aqi[], pm25[], pm10[], no2[] } for the picked day
    var ranges = [];
    var activeRange = null;
    var meta = null;                // { date, aqi, aqiStatus, peakHour, peakAqi }
    var svgNS = 'http://www.w3.org/2000/svg';
    host.innerHTML =
        '<div class="ao">' +
            '<header class="ao__head">' +
                '<svg class="ao__head-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M3 9h8a3 3 0 1 0-3-3"/><path d="M3 14h13a4 4 0 1 0-4-4"/><path d="M3 19h7a3 3 0 1 1-3 3"/></svg>' +
                '<div class="ao__head-text"><h3 class="ao__title">AQI Outlook</h3><p class="ao__subtitle" data-ao-subtitle></p></div>' +
                '<span class="ao__demo-badge">MLP PREDICTION</span>' +
                '<select class="ao__range" id="ao-range" aria-label="Historical range"></select>' +
            '</header>' +
            '<p class="ao__status" data-ao-status hidden></p>' +
            '<div class="ao__stats" data-ao-stats></div>' +
            '<div class="ao__charts">' +
                '<article class="ao-chart"><h4 class="ao-chart__title"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 20V4M4 20h17M6 16l4-4 3 2 6-7"/><path d="M15 7h4v4"/></svg>AQI Trend</h4><div class="ao-chart__plot" data-ao-aqi-chart></div><div class="ao-chart__legend"><span class="ao-legend-item"><i class="ao-legend-item__swatch ao-legend-item__swatch--aqi"></i>Annual Avg. AQI</span></div></article>' +
                '<article class="ao-chart"><h4 class="ao-chart__title"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M17.5 15H8a5 5 0 1 1 4.8-6.4h.7a3.7 3.7 0 0 1 4 3.7 3.2 3.2 0 0 1-.1 2.7z"/><path d="M8 18l-1 2.5M12 18l-1 2.5M16 18l-1 2.5"/></svg>Pollutant Trend (Annual Avg.)</h4><div class="ao-chart__plot" data-ao-pollutant-chart></div><div class="ao-chart__legend"><span class="ao-legend-item"><i class="ao-legend-item__swatch ao-legend-item__swatch--pm25"></i>PM2.5</span><span class="ao-legend-item"><i class="ao-legend-item__swatch ao-legend-item__swatch--pm10"></i>PM10</span></div></article>' +
            '</div>' +
        '</div>';
    var els = {
        subtitle: host.querySelector('[data-ao-subtitle]'),
        stats: host.querySelector('[data-ao-stats]'),
        aqiChart: host.querySelector('[data-ao-aqi-chart]'),
        pollutantChart: host.querySelector('[data-ao-pollutant-chart]'),
        range: host.querySelector('#ao-range'),
        status: host.querySelector('[data-ao-status]'),
        badge: host.querySelector('.ao__demo-badge')
    };
    function svgElement(name, attrs) {
        var element = document.createElementNS(svgNS, name);
        Object.keys(attrs || {}).forEach(function (key) { element.setAttribute(key, attrs[key]); });
        return element;
    }
    function svgText(svg, x, y, value, anchor, className) {
        var element = svgElement('text', { x: x, y: y, 'text-anchor': anchor || 'middle', 'class': className || 'ao-chart__axis-label' });
        element.textContent = value;
        svg.appendChild(element);
        return element;
    }
    // Render at the plot's real pixel size so the SVG viewBox matches the box
    // exactly. A fixed viewBox (e.g. 560x220) gets letterboxed by the browser
    // inside a tall/narrow panel, leaving large empty gaps above and below.
    function chartSize(el, fallbackW, fallbackH) {
        return {
            w: el.clientWidth > 40 ? el.clientWidth : fallbackW,
            h: el.clientHeight > 40 ? el.clientHeight : fallbackH
        };
    }
    function labelEvery(count, plotWidth) {
        return Math.max(1, Math.ceil(count / Math.max(1, Math.floor(plotWidth / 46))));
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
       Data: fed from the backend MLP prediction (the Weather Prediction
       tab fans it out) — no direct external API calls here.
       ------------------------------------------------------------------ */
    function hourly(list, key) {
        return (list || []).map(function (p) {
            var v = p[key];
            return v === null || v === undefined ? null : v;
        });
    }
    // The air-quality provider has no hourly PM2.5/PM10 for far-future dates.
    // When that happens, derive an approximate concentration from the hourly
    // AQI using the US EPA PM2.5 breakpoint table so the chart is not blank.
    // Any such values are explicitly labelled as estimates in the chart.
    function aqiToPm25(aqi) {
        var bands = [
            [0, 50, 0, 12], [51, 100, 12.1, 35.4], [101, 150, 35.5, 55.4],
            [151, 200, 55.5, 150.4], [201, 300, 150.5, 250.4],
            [301, 400, 250.5, 350.4], [401, 500, 350.5, 500.4]
        ];
        var a = Math.max(0, Math.min(500, aqi));
        for (var i = 0; i < bands.length; i++) {
            var b = bands[i];
            if (a <= b[1] || i === bands.length - 1) {
                return b[2] + (a - b[0]) / (b[1] - b[0]) * (b[3] - b[2]);
            }
        }
        return 0;
    }
    function resolvePollutants(data) {
        var hasReal = (data.pm25 || []).some(function (v) { return v !== null && v !== undefined; });
        if (hasReal) return { pm25: data.pm25 || [], pm10: data.pm10 || [], estimated: false };
        var pm25 = (data.aqi || []).map(function (v) {
            return v === null || v === undefined ? null : aqiToPm25(v);
        });
        return {
            pm25: pm25,
            pm10: pm25.map(function (v) { return v === null ? null : v * 1.6; }),
            estimated: pm25.some(function (v) { return v !== null; })
        };
    }
    function mountPrediction(detail) {
        detail = detail || {};
        var f = detail.forecast || {};
        var aqi = hourly(detail.hourlyAqi, 'v');
        if (aqi.filter(function (v) { return v !== null; }).length < 2) { resetToBlank(); return; }
        var hours = (detail.hourlyAqi || []).map(function (p) { return p.hour; });
        records = {
            years: hours,
            aqi: aqi,
            pm25: hourly(detail.hourlyPm25, 'v'),
            pm10: hourly(detail.hourlyPm10, 'v'),
            no2: hourly(detail.hourlyNo2, 'v')
        };
        var peak = null;
        aqi.forEach(function (v, i) {
            if (v !== null && (!peak || v > peak.v)) peak = { v: v, hour: hours[i] };
        });
        meta = {
            date: f.date,
            aqi: f.aqi,
            aqiStatus: f.aqiStatus,
            peakHour: peak ? peak.hour : null,
            peakAqi: peak ? peak.v : null
        };
        ranges = [{ id: 'day', label: f.date || 'picked day', data: {
            years: hours, aqi: aqi, pm25: records.pm25, pm10: records.pm10
        } }];
        activeRange = 'day';
        els.range.innerHTML = '<option value="day">' + (f.date || 'picked day') + '</option>';
        els.range.value = 'day';
        els.range.disabled = true;
        render();
        setStatus('');
    }
    function resetToBlank() {
        records = null;
        ranges = [];
        activeRange = null;
        meta = null;
        els.stats.innerHTML = '';
        els.aqiChart.replaceChildren();
        els.pollutantChart.replaceChildren();
        els.range.innerHTML = '';
        els.range.disabled = true;
        els.subtitle.textContent = 'Pick a prediction date in the calendar to see its air-quality outlook.';
        setStatus('');
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
    function renderStats() {
        var day = meta || {};
        var poll = resolvePollutants(activeData());
        function meanOf(arr) {
            var ok = (arr || []).filter(function (v) { return v !== null && v !== undefined; });
            return ok.length ? ok.reduce(function (a, b) { return a + b; }, 0) / ok.length : null;
        }
        function num(v, digits) {
            return v === null || v === undefined ? 'n/a' : v.toFixed(digits);
        }
        els.stats.innerHTML =
            stat('<svg class="ao-stat__icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3a9 9 0 1 0 9 9"/><path d="M12 7v5l3 2"/><path d="M16 3h5v5"/></svg>', 'aqi', 'Day AQI (US)', day.aqi !== null && day.aqi !== undefined ? String(Math.round(day.aqi)) : 'n/a', '(MLP prediction)') +
            stat('<svg class="ao-stat__icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M20 4c-9 0-15 4-15 10a6 6 0 0 0 6 6c6 0 9-6 9-16z"/><path d="M4 21c2-5 6-8 11-10"/></svg>', 'pm25', 'PM2.5 (Day Avg)' + (poll.estimated ? ' *' : ''), num(meanOf(poll.pm25), 1), '\u00b5g/m\u00b3' + (poll.estimated ? ' (est. from AQI)' : '')) +
            stat('<svg class="ao-stat__icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M3 9h8a3 3 0 1 0-3-3"/><path d="M3 14h13a4 4 0 1 0-4-4"/><path d="M3 19h7a3 3 0 1 1-3 3"/></svg>', 'no2', 'NO\u2082 (Day Avg)', num(meanOf(records && records.no2), 1), '\u00b5g/m\u00b3') +
            stat('<svg class="ao-stat__icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M3 12c3-7 15-7 18 0-3 7-15 7-18 0z"/><circle cx="12" cy="12" r="3"/></svg>', 'clean', 'Peak AQI Hour', day.peakHour ? day.peakHour + ' \u00b7 AQI ' + Math.round(day.peakAqi) : 'n/a', '(worst hour of the day)');
    }
    function renderAqiChart(data) {
        var size = chartSize(els.aqiChart, 560, 220);
        var width = size.w, height = size.h;
        var margin = { top: 16, right: 12, bottom: 32, left: 44 };
        var plotWidth = width - margin.left - margin.right;
        var plotHeight = height - margin.top - margin.bottom;
        var every = labelEvery(data.years.length, plotWidth);
        // Fixed US AQI scale: 0-500 for every picked day. AQI can exceed 400,
        // so a data-derived axis would either clip the peak or keep rescaling.
        var max = 500;
        var min = 0;
        var x = function (index) { return margin.left + (data.years.length === 1 ? plotWidth / 2 : plotWidth * index / (data.years.length - 1)); };
        var y = function (value) {
            var v = Math.max(min, Math.min(max, value || 0));
            return margin.top + plotHeight * (1 - (v - min) / (max - min));
        };
        var svg = svgElement('svg', { viewBox: '0 0 ' + width + ' ' + height, role: 'img', 'aria-label': 'Hourly US AQI for the picked day in ' + location.city });
        svg.appendChild(svgElement('title')).textContent = 'Hourly US AQI for ' + location.city;
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
            if (data.years.length <= 6 || index % every === 0 || index === data.years.length - 1) svgText(svg, x(index), height - 9, String(data.years[index]));
        });
        els.aqiChart.replaceChildren(svg);
    }
    function renderPollutantChart(data) {
        var size = chartSize(els.pollutantChart, 560, 220);
        var width = size.w, height = size.h;
        var poll = resolvePollutants(data);
        var flat = poll.pm25.concat(poll.pm10).filter(function (v) { return v !== null && v !== undefined; });
        if (!flat.length) {
            var empty = svgElement('svg', { viewBox: '0 0 ' + width + ' ' + height, role: 'img', 'aria-label': 'No hourly pollutant data for this day' });
            svgText(empty, width / 2, height / 2, 'No hourly pollutant data for this day');
            els.pollutantChart.replaceChildren(empty);
            return;
        }
        var margin = { top: poll.estimated ? 30 : 16, right: 12, bottom: 32, left: 54 };
        var plotWidth = width - margin.left - margin.right;
        var plotHeight = height - margin.top - margin.bottom;
        var every = labelEvery(data.years.length, plotWidth);
        var max = Math.max(50, Math.ceil(Math.max.apply(null, flat) / 20) * 20);
        var stepV = Math.ceil(max / 5 / 10) * 10;
        var groupWidth = plotWidth / data.years.length;
        var barWidth = Math.max(3, Math.min(15, groupWidth * 0.36));
        var svg = svgElement('svg', { viewBox: '0 0 ' + width + ' ' + height, role: 'img', 'aria-label': 'Hourly PM2.5 and PM10 for the picked day in ' + location.city + ', micrograms per cubic meter' + (poll.estimated ? ' (estimated from AQI)' : '') });
        svg.appendChild(svgElement('title')).textContent = 'Hourly PM2.5 and PM10 for ' + location.city + (poll.estimated ? ' (estimated from AQI)' : '');
        if (poll.estimated) {
            svgText(svg, width - margin.right, 18, 'Estimates derived from AQI', 'end', 'ao-chart__note');
        }
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
                var value = poll[series.key][index];
                if (value === null || value === undefined) return;   // no hourly value for this hour
                var barHeight = plotHeight * Math.min(value, max) / max;
                var bar = svgElement('rect', {
                    x: center + series.dx - barWidth / 2,
                    y: margin.top + plotHeight - barHeight,
                    width: barWidth,
                    height: barHeight,
                    rx: 2,
                    'class': series.className
                });
                bar.appendChild(svgElement('title')).textContent = year + ': ' + series.label + ' ' + value.toFixed(1) + ' \u00b5g/m\u00b3' + (poll.estimated ? ' (est.)' : '');
                svg.appendChild(bar);
            });
            if (data.years.length <= 6 || index % every === 0 || index === data.years.length - 1) svgText(svg, center, height - 9, String(year));
        });
        els.pollutantChart.replaceChildren(svg);
    }
    function render() {
        if (!records || !ranges.length) return;
        var data = activeData();
        els.subtitle.textContent = 'MLP-model air-quality prediction for ' + location.city +
            (location.region ? ', ' + location.region : '') +
            (meta && meta.date ? ' \u00b7 ' + meta.date : '') + '.';
        renderStats();
        renderAqiChart(data);
        renderPollutantChart(data);
    }
    function setLocation(detail) {
        if (!detail || typeof detail !== 'object') return;
        var city = String(detail.name || detail.city || '').trim();
        if (!city || /^(current location|device location)$/i.test(city)) return;
        var region = String(detail.region || detail.country || '').trim();
        if (city === location.city && region === location.region) return;
        location = { city: city, region: region };
        /* No fetching here: the Weather Prediction tab owns the prediction
           and fans the data out — clear the day until its next fan-out. */
        resetToBlank();
        els.subtitle.textContent = location.city + (location.region ? ', ' + location.region : '') +
            ' — pick a prediction date in the calendar.';
    }
    /* Overview feed for the Generate Analysis pipeline. */
    window.AqiOutlook = {
        getSeries: function () {
            if (!records || !ranges.length) return { tab: 'AQI Outlook', ready: false, location: location.city };
            return {
                tab: 'AQI Outlook',
                ready: true,
                location: location.city,
                date: meta && meta.date,
                years: records.years,   // hour labels (00:00–23:00)
                aqi: records.aqi,       // hourly US AQI
                pm25: records.pm25,
                pm10: records.pm10,
                no2: records.no2,
                stats: {
                    aqi: meta && meta.aqi,
                    aqiStatus: meta && meta.aqiStatus,
                    peakHour: meta && meta.peakHour,
                    peakAqi: meta && meta.peakAqi
                }
            };
        }
    };
    els.range.addEventListener('change', function () {
        activeRange = els.range.value;
        render();
    });
    /* Re-render at the new pixel size when the panel resizes or a hidden tab
       becomes visible; otherwise the viewBox would go back to being letterboxed. */
    var lastChartSize = { w: 0, h: 0 };
    function onChartResize(entries) {
        if (!records) return;
        var box = entries[0].contentRect;
        if (Math.abs(box.width - lastChartSize.w) < 1 && Math.abs(box.height - lastChartSize.h) < 1) return;
        lastChartSize = { w: box.width, h: box.height };
        render();
    }
    if (typeof ResizeObserver !== 'undefined') {
        new ResizeObserver(onChartResize).observe(els.aqiChart);
    } else {
        window.addEventListener('resize', function () { if (records) render(); });
    }
    /* Prediction fan-out from the Weather Prediction tab. */
    document.addEventListener('weatherly:prediction-data', function (e) { mountPrediction(e.detail); });
    document.addEventListener('weatherly:prediction-blank', resetToBlank);
    document.addEventListener('weatherly:prediction-error', resetToBlank);
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
            // Same app default the dashboard uses (js/config.js), so a fresh
            // visitor still sees data instead of an empty tab. config.js is
            // not loaded on the standalone page, hence the literal.
            var dflt = (window.AIREC_CONFIG && window.AIREC_CONFIG.DEFAULT_LOCATION) ||
                { name: "Kolkata", latitude: 22.5726, longitude: 88.3639 };
            if (dflt && Number.isFinite(Number(dflt.latitude))) {
                setLocation({ name: dflt.name, lat: Number(dflt.latitude), lon: Number(dflt.longitude) });
            } else {
                setStatus('Pick a prediction date in the calendar to see its air-quality outlook.');
            }
        }
    }
})();
