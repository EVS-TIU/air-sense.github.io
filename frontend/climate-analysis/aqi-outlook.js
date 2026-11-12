(function () {
    'use strict';

    var host = document.getElementById('ca-aqi-outlook');
    if (!host) return;

    var ranges = [
        { id: '10', years: 11, label: '2016 – 2026 (Historical)' },
        { id: '5', years: 6, label: '2021 – 2026 (Recent)' },
        { id: '3', years: 4, label: '2023 – 2026 (Recent)' }
    ];
    var location = { city: 'Delhi', region: 'India' };
    var activeRange = ranges[0].id;
    var profile = null;
    var svgNS = 'http://www.w3.org/2000/svg';

    var knownProfiles = {
        delhi: { startAqi: 113, aqiChange: 29, avgAqiChange: 18.4, pm25Change: 12.6, no2Change: 8.1, cleanDaysChange: -34, pm25: 45, pm10: 48, no2: 39 },
        kolkata: { startAqi: 101, aqiChange: 22, avgAqiChange: 14.2, pm25Change: 10.4, no2Change: 6.7, cleanDaysChange: -27, pm25: 39, pm10: 45, no2: 34 },
        mumbai: { startAqi: 92, aqiChange: 15, avgAqiChange: 9.6, pm25Change: 7.8, no2Change: 5.2, cleanDaysChange: -18, pm25: 31, pm10: 38, no2: 27 },
        bengaluru: { startAqi: 76, aqiChange: 11, avgAqiChange: 7.1, pm25Change: 6.3, no2Change: 4.1, cleanDaysChange: -12, pm25: 24, pm10: 31, no2: 21 },
        chennai: { startAqi: 83, aqiChange: 13, avgAqiChange: 8.4, pm25Change: 7.1, no2Change: 4.6, cleanDaysChange: -14, pm25: 27, pm10: 34, no2: 23 },
        serampore: { startAqi: 106, aqiChange: 24, avgAqiChange: 15.5, pm25Change: 11.2, no2Change: 7.3, cleanDaysChange: -29, pm25: 42, pm10: 47, no2: 36 }
    };

    host.innerHTML =
        '<div class="ao">' +
            '<header class="ao__head">' +
                '<svg class="ao__head-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M3 9h8a3 3 0 1 0-3-3"/><path d="M3 14h13a4 4 0 1 0-4-4"/><path d="M3 19h7a3 3 0 1 1-3 3"/></svg>' +
                '<div class="ao__head-text"><h3 class="ao__title">AQI Outlook</h3><p class="ao__subtitle" data-ao-subtitle></p></div>' +
                '<span class="ao__demo-badge">DEMO DATA</span>' +
                '<select class="ao__range" id="ao-range" aria-label="Historical range">' +
                    ranges.map(function (range) { return '<option value="' + range.id + '">' + range.label + '</option>'; }).join('') +
                '</select>' +
            '</header>' +
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
        range: host.querySelector('#ao-range')
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

    function seededProfile(city) {
        var hash = 0;
        for (var i = 0; i < city.length; i += 1) hash = ((hash * 31) + city.charCodeAt(i)) | 0;
        var seed = Math.abs(hash);
        var startAqi = 65 + (seed % 61);
        return {
            startAqi: startAqi,
            aqiChange: 8 + (seed % 24),
            avgAqiChange: Math.round((8 + (seed % 24)) * 0.64 * 10) / 10,
            pm25Change: 4 + ((seed >>> 3) % 12) / 10,
            no2Change: 3 + ((seed >>> 5) % 8) / 10,
            cleanDaysChange: -(8 + (seed % 31)),
            pm25: 18 + (seed % 34),
            pm10: 25 + ((seed >>> 2) % 39),
            no2: 16 + ((seed >>> 4) % 30)
        };
    }

    function profileFor(city) {
        var normalized = city.trim().toLowerCase();
        return knownProfiles[normalized] || seededProfile(city);
    }

    function rangeData() {
        var range = ranges.find(function (item) { return item.id === activeRange; }) || ranges[0];
        var allYears = [];
        for (var year = 2016; year <= 2026; year += 1) allYears.push(year);
        var progress = allYears.map(function (_, index) { return index / (allYears.length - 1); });
        var allAqi = progress.map(function (point, index) {
            var wave = Math.sin((index + 1) * 1.7 + profile.startAqi) * 3;
            return Math.max(15, Math.round(profile.startAqi + profile.aqiChange * point + wave));
        });
        var allPm25 = progress.map(function (point, index) {
            return Math.max(5, profile.pm25 * (1 + profile.pm25Change / 100 * point) + Math.sin(index * 1.3) * 1.5);
        });
        var allPm10 = progress.map(function (point, index) {
            return Math.max(8, profile.pm10 * (1 + profile.pm25Change / 130 * point) + Math.cos(index * 1.1) * 2);
        });
        var no2Start = profile.no2;
        var no2End = no2Start * (1 + profile.no2Change / 100);
        var from = allYears.length - range.years;
        var years = allYears.slice(from);
        var aqi = allAqi.slice(from);
        var pm25 = allPm25.slice(from);
        var pm10 = allPm10.slice(from);
        return {
            range: range,
            years: years,
            aqi: aqi,
            pm25: pm25,
            pm10: pm10,
            aqiChange: profile.avgAqiChange * (range.years - 1) / 10,
            pm25Change: profile.pm25Change * (range.years - 1) / 10,
            no2Change: ((no2End / no2Start) - 1) * 100 * (range.years - 1) / 10,
            cleanDaysChange: Math.round(profile.cleanDaysChange * (range.years - 1) / 10)
        };
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
            stat('<svg class="ao-stat__icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3a9 9 0 1 0 9 9"/><path d="M12 7v5l3 2"/><path d="M16 3h5v5"/></svg>', 'aqi', 'Avg. AQI Change', sign + Math.abs(data.aqiChange).toFixed(1), '(vs. ' + data.years[0] + ' baseline)') +
            stat('<svg class="ao-stat__icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M20 4c-9 0-15 4-15 10a6 6 0 0 0 6 6c6 0 9-6 9-16z"/><path d="M4 21c2-5 6-8 11-10"/></svg>', 'pm25', 'PM2.5 Trend', pmSign + Math.abs(data.pm25Change).toFixed(1) + '%', '(annual average)') +
            stat('<svg class="ao-stat__icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M3 9h8a3 3 0 1 0-3-3"/><path d="M3 14h13a4 4 0 1 0-4-4"/><path d="M3 19h7a3 3 0 1 1-3 3"/></svg>', 'no2', 'NO\u2082 Trend', no2Sign + Math.abs(data.no2Change).toFixed(1) + '%', '(annual average)') +
            stat('<svg class="ao-stat__icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M3 12c3-7 15-7 18 0-3 7-15 7-18 0z"/><circle cx="12" cy="12" r="3"/></svg>', 'clean', 'Clean Air Days', cleanSign + Math.abs(data.cleanDaysChange) + ' days', '(per year)');
    }

    function renderAqiChart(data) {
        var width = 560, height = 220, margin = { top: 16, right: 12, bottom: 32, left: 44 };
        var plotWidth = width - margin.left - margin.right;
        var plotHeight = height - margin.top - margin.bottom;
        var min = 0, max = 200;
        var x = function (index) { return margin.left + (data.years.length === 1 ? plotWidth / 2 : plotWidth * index / (data.years.length - 1)); };
        var y = function (value) { return margin.top + plotHeight * (1 - (value - min) / (max - min)); };
        var svg = svgElement('svg', { viewBox: '0 0 ' + width + ' ' + height, role: 'img', 'aria-label': 'Demo annual average AQI trend for ' + location.city });
        svg.appendChild(svgElement('title')).textContent = 'Demo annual average AQI for ' + location.city;
        [0, 50, 100, 150, 200].forEach(function (tick) {
            var yy = y(tick);
            svg.appendChild(svgElement('line', { x1: margin.left, y1: yy, x2: width - margin.right, y2: yy, 'class': 'ao-chart__grid' }));
            svgText(svg, margin.left - 8, yy + 4, String(tick), 'end');
        });
        var points = data.aqi.map(function (value, index) { return x(index) + ',' + y(value); });
        var areaPath = 'M' + x(0) + ',' + y(min) + ' L' + points.join(' L') + ' L' + x(data.aqi.length - 1) + ',' + y(min) + ' Z';
        svg.appendChild(svgElement('path', { d: areaPath, fill: 'rgba(255, 129, 75, 0.18)' }));
        svg.appendChild(svgElement('polyline', { points: points.join(' '), fill: 'none', stroke: '#ff814b', 'stroke-width': 3, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }));
        data.aqi.forEach(function (value, index) {
            var point = svgElement('circle', { cx: x(index), cy: y(value), r: data.years.length > 8 ? 3.5 : 4.5, 'class': 'ao-chart__point' });
            point.appendChild(svgElement('title')).textContent = data.years[index] + ': AQI ' + value + ' (demo)';
            svg.appendChild(point);
            if (data.years.length <= 6 || index % 2 === 0 || index === data.years.length - 1) svgText(svg, x(index), height - 9, String(data.years[index]));
        });
        els.aqiChart.replaceChildren(svg);
    }

    function renderPollutantChart(data) {
        var width = 560, height = 220, margin = { top: 16, right: 12, bottom: 32, left: 54 };
        var plotWidth = width - margin.left - margin.right;
        var plotHeight = height - margin.top - margin.bottom;
        var max = 100;
        var groupWidth = plotWidth / data.years.length;
        var barWidth = Math.min(15, groupWidth * 0.28);
        var svg = svgElement('svg', { viewBox: '0 0 ' + width + ' ' + height, role: 'img', 'aria-label': 'Demo annual average PM2.5 and PM10 trends for ' + location.city + ', micrograms per cubic meter' });
        svg.appendChild(svgElement('title')).textContent = 'Demo annual average PM2.5 and PM10 for ' + location.city;
        [0, 20, 40, 60, 80, 100].forEach(function (tick) {
            var yy = margin.top + plotHeight * (1 - tick / max);
            svg.appendChild(svgElement('line', { x1: margin.left, y1: yy, x2: width - margin.right, y2: yy, 'class': 'ao-chart__grid' }));
            svgText(svg, margin.left - 8, yy + 4, tick + ' \u00b5g/m\u00b3', 'end');
        });
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
                bar.appendChild(svgElement('title')).textContent = year + ': ' + series.label + ' ' + value.toFixed(1) + ' \u00b5g/m\u00b3 (demo)';
                svg.appendChild(bar);
            });
            if (data.years.length <= 6 || index % 2 === 0 || index === data.years.length - 1) svgText(svg, center, height - 9, String(year));
        });
        els.pollutantChart.replaceChildren(svg);
    }

    function render() {
        profile = profile || profileFor(location.city);
        var data = rangeData();
        els.subtitle.textContent = 'Historical air quality patterns and long-term changes for ' + location.city + (location.region ? ', ' + location.region : '') + '.';
        renderStats(data);
        renderAqiChart(data);
        renderPollutantChart(data);
        els.insight.textContent = location.city + "'s demo average AQI changes by about " + data.aqiChange.toFixed(1) +
            ' points from ' + data.years[0] + ' to ' + data.years[data.years.length - 1] +
            '. PM2.5 changes by ' + (data.pm25Change >= 0 ? '+' : '\u2212') + Math.abs(data.pm25Change).toFixed(1) +
            '% and NO\u2082 by ' + (data.no2Change >= 0 ? '+' : '\u2212') + Math.abs(data.no2Change).toFixed(1) +
            '%. The clean-air-day estimate changes by ' + Math.abs(data.cleanDaysChange) + ' days per year. Demo data only; values are illustrative, not live readings or an official forecast.';
    }

    function setLocation(detail) {
        if (!detail || typeof detail !== 'object') return;
        var city = String(detail.name || detail.city || '').trim();
        if (!city || /^(current location|device location)$/i.test(city)) return;
        var region = String(detail.region || detail.country || '').trim();
        if (city === location.city && region === location.region) return;
        location = { city: city, region: region };
        profile = profileFor(city);
        render();
    }

    els.range.addEventListener('change', function () {
        activeRange = els.range.value;
        render();
    });

    document.addEventListener('weatherly:location-change', function (event) { setLocation(event.detail); });
    document.addEventListener('weatherly:device-location-active', function (event) { setLocation(event.detail); });

    var currentLocation = window.WeatherlyTopbar && window.WeatherlyTopbar.getLocation();
    if (currentLocation) {
        setLocation(currentLocation);
    } else {
        var sidebarCity = document.getElementById('sidebar-city');
        if (sidebarCity && sidebarCity.textContent.trim() && !/^(finding your location|current location)$/i.test(sidebarCity.textContent.trim())) {
            setLocation({ name: sidebarCity.textContent.trim(), region: document.getElementById('sidebar-region')?.textContent.trim() });
        }
    }

    render();
})();
