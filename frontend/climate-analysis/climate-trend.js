/* ==========================================================================
   Climate Trend tab — renders into #ca-climate-trend
   Real Open-Meteo Archive API data (ERA5, same source as History Analysis):
   - Annual average temperature  (mean of daily means)
   - Annual rainfall             (sum of daily precipitation)
   - Hot days (≥ 35 °C)          (count of daily maxima)
   - Seasonal variation          (warmest vs coldest month of the year)
   Only complete calendar years are shown; the running year is skipped.
   The chart, KPI cards and insight react to the selected location.
   ========================================================================== */
(function () {
    'use strict';
    var host = document.getElementById('ca-climate-trend');
    if (!host) { return; }
    /* ------------------------------------------------------------------
       Data layer
       ------------------------------------------------------------------ */
    var ARCHIVE_URL = 'https://archive-api.open-meteo.com/v1/archive';
    // The ERA5 archive lags a few days behind real time; keep a safe margin.
    var ARCHIVE_LAG_DAYS = 5;
    var HISTORY_YEARS = 21;   // complete years to show
    var HOT_DAY_C = 35;       // a day with max ≥ this counts as a "hot day"
    var LOCATION_KEY = 'airsense:selected-location';

    var locationName = 'Selected Location';
    var loc = null;           // { lat, lon }
    var data = null;          // { years, temps, rain, hotDays, seasonal, ranges }
    var activeRange = null;
    var fetchId = 0;
    /* ------------------------------------------------------------------
       Icons (inline SVG, stroke-based to match the existing UI)
       ------------------------------------------------------------------ */
    var ICON = {
        bars:   '<svg class="ct-head__icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M3 21h18"/><rect x="5" y="12" width="3" height="7" rx="0.8"/><rect x="10.5" y="7" width="3" height="12" rx="0.8"/><rect x="16" y="3" width="3" height="16" rx="0.8"/></svg>',
        cal:    '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3.5" y="5" width="17" height="15" rx="2.5"/><path d="M8 3v4M16 3v4M3.5 10h17"/></svg>',
        chev:   '<svg class="ct-range__chev" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg>',
        thermo: '<svg class="ct-stat__icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M14 14.8V5a2 2 0 0 0-4 0v9.8a4 4 0 1 0 4 0z"/><path d="M12 9v7"/></svg>',
        rain:   '<svg class="ct-stat__icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M17.5 15H8a5 5 0 1 1 4.8-6.4h.7a3.7 3.7 0 0 1 4 3.7 3.2 3.2 0 0 1-.1 2.7z"/><path d="M8 18l-1 2.5M12 18l-1 2.5M16 18l-1 2.5"/></svg>',
        sun:    '<svg class="ct-stat__icon" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2.5v2.2M12 19.3v2.2M2.5 12h2.2M19.3 12h2.2M5.3 5.3l1.6 1.6M17.1 17.1l1.6 1.6M18.7 5.3l-1.6 1.6M6.9 17.1l-1.6 1.6"/></svg>',
        layers: '<svg class="ct-stat__icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3l9 4.8-9 4.8-9-4.8z"/><path d="M3 12.2l9 4.8 9-4.8"/><path d="M3 16.6l9 4.8 9-4.8"/></svg>',
        up:     '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 19V5M6 11l6-6 6 6"/></svg>',
        down:   '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M6 13l6 6 6-6"/></svg>',
        thermoS:'<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 14.8V5a2 2 0 0 0-4 0v9.8a4 4 0 1 0 4 0z"/></svg>',
        cloud:  '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M17.5 15H8a5 5 0 1 1 4.8-6.4h.7a3.7 3.7 0 0 1 4 3.7 3.2 3.2 0 0 1-.1 2.7z"/><path d="M8 18l-1 2.5M12 18l-1 2.5M16 18l-1 2.5"/></svg>',
        leaf:   '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 4c-9 0-15 4-15 10a6 6 0 0 0 6 6c6 0 9-6 9-16z"/><path d="M4 21c2-5 6-8 11-10"/></svg>'
    };
    /* ------------------------------------------------------------------
       Markup
       ------------------------------------------------------------------ */
    host.innerHTML =
        '<div class="ct">' +
            '<header class="ct-head">' +
                ICON.bars +
                '<div class="ct-head__text">' +
                    '<h3 class="ct-head__title">Climate Trends</h3>' +
                    '<p class="ct-head__sub" id="ct-sub"></p>' +
                '</div>' +
                '<div class="ct-range">' +
                    '<button class="ct-range__btn" id="ct-range-btn" type="button" aria-haspopup="listbox" aria-expanded="false" aria-controls="ct-range-menu">' +
                        ICON.cal + '<span id="ct-range-label"></span>' + ICON.chev +
                    '</button>' +
                    '<ul class="ct-range__menu" id="ct-range-menu" role="listbox" aria-label="Time range" hidden></ul>' +
                '</div>' +
            '</header>' +
            '<p class="ct-status" id="ct-status" hidden></p>' +
            '<div class="ct-stats" id="ct-stats"></div>' +
            '<div class="ct-charts">' +
                '<article class="ct-chart">' +
                    '<div class="ct-chart__head">' + ICON.thermoS + '<h4 class="ct-chart__title">Temperature Trend</h4></div>' +
                    '<div class="ct-chart__plot" id="ct-temp-plot"></div>' +
                    '<div class="ct-legend"><span class="ct-legend__item"><i class="ct-legend__dot"></i>Avg. Temperature</span></div>' +
                '</article>' +
                '<article class="ct-chart">' +
                    '<div class="ct-chart__head">' + ICON.cloud + '<h4 class="ct-chart__title">Annual Rainfall Trend</h4><span class="ct-chip" id="ct-rain-avg"></span></div>' +
                    '<div class="ct-chart__plot" id="ct-rain-plot"></div>' +
                    '<div class="ct-legend">' +
                        '<span class="ct-legend__item"><i class="ct-legend__sq"></i>Annual Rainfall</span>' +
                        '<span class="ct-legend__item"><i class="ct-legend__dash"></i><span id="ct-trend-label"></span></span>' +
                    '</div>' +
                '</article>' +
            '</div>' +
            '<div class="ct-insight">' +
                '<div class="ct-insight__title">' + ICON.leaf + 'Trend Insight</div>' +
                '<p class="ct-insight__text" id="ct-insight-text"></p>' +
            '</div>' +
        '</div>';
    var els = {
        sub:      host.querySelector('#ct-sub'),
        rangeBtn: host.querySelector('#ct-range-btn'),
        rangeLbl: host.querySelector('#ct-range-label'),
        rangeMenu:host.querySelector('#ct-range-menu'),
        stats:    host.querySelector('#ct-stats'),
        tempPlot: host.querySelector('#ct-temp-plot'),
        rainPlot: host.querySelector('#ct-rain-plot'),
        rainAvg:  host.querySelector('#ct-rain-avg'),
        trendLbl: host.querySelector('#ct-trend-label'),
        insight:  host.querySelector('#ct-insight-text'),
        status:   host.querySelector('#ct-status')
    };
    /* ------------------------------------------------------------------
       Helpers
       ------------------------------------------------------------------ */
    var SVGNS = 'http://www.w3.org/2000/svg';
    function fmt(n) { return Math.round(n).toLocaleString('en-US'); }
    function signed(n, digits, suffix) {
        var s = (n >= 0 ? '+' : '\u2212') + Math.abs(n).toFixed(digits);
        return s + (suffix || '');
    }
    function current() {
        var range = data.ranges.filter(function (r) { return r.id === activeRange; })[0] || data.ranges[0];
        var n = Math.min(range.years, data.years.length);
        var from = data.years.length - n;
        return {
            range: range,
            years: data.years.slice(from),
            temps: data.temps.slice(from),
            rain:  data.rain.slice(from)
        };
    }
    function svgEl(name, attrs) {
        var el = document.createElementNS(SVGNS, name);
        Object.keys(attrs || {}).forEach(function (k) { el.setAttribute(k, attrs[k]); });
        return el;
    }
    function text(svg, x, y, str, anchor) {
        var t = svgEl('text', { x: x, y: y, 'text-anchor': anchor || 'middle', 'class': 'ct-svg-text' });
        t.textContent = str;
        svg.appendChild(t);
        return t;
    }
    function niceTemp(min, max) {
        return { lo: Math.floor((min - 1) / 2) * 2, hi: Math.ceil((max + 1) / 2) * 2 };
    }
    function makeTip(plot, extraClass) {
        var tip = document.createElement('div');
        tip.className = 'ct-tip ' + (extraClass || '');
        tip.innerHTML = '<span class="ct-tip__year"></span><span class="ct-tip__val"></span>';
        plot.appendChild(tip);
        return {
            el: tip,
            show: function (x, y, year, val, w) {
                var half = 36;
                tip.style.left = Math.max(half, Math.min(w - half, x)) + 'px';
                tip.style.top = (y - 10) + 'px';
                tip.firstChild.textContent = year;
                tip.lastChild.textContent = val;
                tip.hidden = false;
            },
            hide: function () { tip.hidden = true; }
        };
    }
    function setStatus(msg, kind) {
        els.status.hidden = !msg;
        els.status.textContent = msg || '';
        els.status.className = 'ct-status' + (kind ? ' is-' + kind : '');
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
            return { name: saved.name || 'Selected Location', lat: lat, lon: lon };
        } catch (e) { return null; }
    }
    function labelFor(locObj) {
        var region = locObj.region || locObj.country || '';
        return locObj.name + (region ? ', ' + region : '');
    }
    /* ------------------------------------------------------------------
       Fetch + aggregate: daily values → complete calendar years
       ------------------------------------------------------------------ */
    function isoToday() { return new Date().toISOString().slice(0, 10); }
    function isoShift(iso, days) {
        var d = new Date(iso + 'T00:00:00Z');
        d.setUTCDate(d.getUTCDate() + days);
        return d.toISOString().slice(0, 10);
    }
    function aggregate(body) {
        var tMean = body.daily.temperature_2m_mean;
        var tMax = body.daily.temperature_2m_max;
        var rain = body.daily.precipitation_sum;
        var days = body.daily.time;
        var buckets = {};   // year → { days:n, tSum, tN, rainSum, hot, monthMeans }
        for (var i = 0; i < days.length; i++) {
            var day = days[i];
            var vT = tMean[i], vX = tMax[i], vR = rain[i];
            var year = day.slice(0, 4);
            var month = Number(day.slice(5, 7));
            var b = buckets[year];
            if (!b) { b = buckets[year] = { days: 0, tSum: 0, tN: 0, rainSum: 0, hot: 0, months: {} }; }
            b.days += 1;
            if (vT !== null && vT !== undefined) { b.tSum += vT; b.tN += 1; }
            if (vR !== null && vR !== undefined) { b.rainSum += vR; }
            if (vX !== null && vX !== undefined && vX >= HOT_DAY_C) { b.hot += 1; }
            if (vT !== null && vT !== undefined) {
                var m = b.months[month] || (b.months[month] = { sum: 0, n: 0 });
                m.sum += vT; m.n += 1;
            }
        }
        var years = [], temps = [], rainY = [], hot = [], seasonal = [];
        Object.keys(buckets).sort().forEach(function (year) {
            var b = buckets[year];
            // Keep only complete calendar years (~330+ days of data).
            if (b.days < 330 || b.tN === 0) return;
            var monthMeans = Object.keys(b.months).map(function (mo) { return b.months[mo].sum / b.months[mo].n; });
            if (monthMeans.length < 6) return; // not enough months for a seasonal read
            years.push(Number(year));
            temps.push(b.tSum / b.tN);
            rainY.push(b.rainSum);
            hot.push(b.hot);
            seasonal.push(Math.max.apply(null, monthMeans) - Math.min.apply(null, monthMeans));
        });
        if (years.length < 2) return null;
        return { years: years, temps: temps, rain: rainY, hotDays: hot, seasonal: seasonal };
    }
    // Half-mean comparison (same logic as History Analysis trend stat).
    function halfMeanChange(values) {
        var half = Math.floor(values.length / 2);
        var mean = function (arr) { return arr.reduce(function (a, b) { return a + b; }, 0) / (arr.length || 1); };
        var before = mean(values.slice(0, half));
        var after = mean(values.slice(values.length - half));
        return { change: after - before, before: before, after: after };
    }
    function pct(before, after) {
        if (!before) return 0;
        return ((after - before) / Math.abs(before)) * 100;
    }
    function buildData(agg) {
        var years = agg.years;
        var total = years.length;
        function rangeDef(trailing, label) {
            var n = Math.min(trailing, total);
            var from = total - n;
            var slice = function (arr) { return arr.slice(from); };
            var t = halfMeanChange(slice(agg.temps));
            var r = halfMeanChange(slice(agg.rain));
            var h = halfMeanChange(slice(agg.hotDays));
            return {
                id: 'y' + trailing,
                years: n,
                label: years[from] + ' \u2013 ' + years[total - 1] + ' (' + label + ')',
                summary: {
                    tempChange: t.change,
                    rainTrend: pct(r.before, r.after),
                    hotDays: h.change,
                    seasonal: slice(agg.seasonal).reduce(function (a, b) { return a + b; }, 0) / n
                }
            };
        }
        return {
            years: years,
            temps: agg.temps,
            rain: agg.rain,
            ranges: [rangeDef(total, 'Long term'), rangeDef(11, 'Historical'), rangeDef(6, 'Recent')]
        };
    }
    async function fetchClimate() {
        if (!loc) return;
        var myId = ++fetchId;
        setStatus('Loading climate data for ' + locationName + '\u2026');
        try {
            var end = isoShift(isoToday(), -ARCHIVE_LAG_DAYS);
            var startYear = new Date().getUTCFullYear() - HISTORY_YEARS;
            var url = new URL(ARCHIVE_URL);
            url.searchParams.set('latitude', loc.lat.toFixed(4));
            url.searchParams.set('longitude', loc.lon.toFixed(4));
            url.searchParams.set('start_date', startYear + '-01-01');
            url.searchParams.set('end_date', end);
            url.searchParams.set('daily', 'temperature_2m_mean,temperature_2m_max,precipitation_sum');
            url.searchParams.set('timezone', 'auto');
            var res = await fetch(url.toString());
            var body = await res.json();
            if (myId !== fetchId) return;
            if (body.error) throw new Error(body.reason || 'Open-Meteo request failed');
            var agg = aggregate(body);
            if (!agg) throw new Error('Not enough historical data for this location');
            data = buildData(agg);
            activeRange = data.ranges[0].id;
            els.rangeBtn.disabled = false;
            buildMenu();
            renderAll();
            setStatus('');
        } catch (err) {
            if (myId !== fetchId) return;
            console.warn('Climate Trend load failed:', err);
            setStatus('Could not load climate data: ' + (err.message || err), 'error');
        }
    }
    function setLocation(detail) {
        if (!detail || typeof detail !== 'object') return;
        var lat = Number(detail.lat !== undefined ? detail.lat : detail.latitude);
        var lon = Number(detail.lon !== undefined ? detail.lon : detail.longitude);
        var name = String(detail.name || detail.city || '').trim();
        if (!name || /^(current location|device location)$/i.test(name)) return;
        var nextName = labelFor(detail);
        var nextLoc = Number.isFinite(lat) && Number.isFinite(lon) ? { lat: lat, lon: lon } : null;
        if (nextName === locationName && (!nextLoc || (loc && nextLoc.lat === loc.lat && nextLoc.lon === loc.lon))) return;
        locationName = nextName;
        loc = nextLoc || readLocation();
        data = null;
        els.rangeBtn.disabled = true;
        els.stats.innerHTML = '';
        els.tempPlot.innerHTML = '';
        els.rainPlot.innerHTML = '';
        els.rainAvg.textContent = '';
        els.trendLbl.textContent = '';
        els.insight.textContent = '';
        if (!loc) {
            setStatus('No coordinates for ' + locationName + ' yet — pick a location first.', 'error');
            return;
        }
        fetchClimate();
    }
    /* ------------------------------------------------------------------
       Render: header, KPI cards, insight
       ------------------------------------------------------------------ */
    function renderText() {
        var c = current();
        var s = c.range.summary;
        els.sub.textContent = 'Real climate history (Open-Meteo ERA5 archive) for ' + locationName + '.';
        els.rangeLbl.textContent = c.range.label;
        var cards = [
            { cls: 'heat',   icon: ICON.thermo, label: 'Avg. Temp Change',     value: signed(s.tempChange, 2, '\u00B0C'),  badge: s.tempChange >= 0 ? ICON.up : ICON.down },
            { cls: 'rain',   icon: ICON.rain,   label: 'Annual Rainfall Trend', value: signed(s.rainTrend, 1, '%'),         badge: s.rainTrend < 0 ? ICON.down : ICON.up },
            { cls: 'hot',    icon: ICON.sun,    label: 'Hot Days (\u2265 35\u00B0C)', value: signed(s.hotDays, 0, ' days'), badge: s.hotDays >= 0 ? ICON.up : ICON.down },
            { cls: 'season', icon: ICON.layers, label: 'Seasonal Variation',    value: '\u00B1' + s.seasonal.toFixed(1) + '\u00B0C', badge: '' }
        ];
        els.stats.innerHTML = cards.map(function (k) {
            return '<div class="ct-stat ct-stat--' + k.cls + '">' + k.icon +
                '<div class="ct-stat__body"><span class="ct-stat__label">' + k.label + '</span>' +
                '<span class="ct-stat__value">' + k.value + '</span></div>' +
                (k.badge ? '<span class="ct-stat__badge">' + k.badge + '</span>' : '') +
                '</div>';
        }).join('');
        var avg = c.rain.reduce(function (a, b) { return a + b; }, 0) / c.rain.length;
        els.rainAvg.textContent = 'Avg: ' + fmt(avg) + ' mm';
        els.trendLbl.textContent = 'Trend (' + signed(s.rainTrend, 1, '%').replace('+', '') + ')';
        els.insight.textContent =
            locationName.split(',')[0] + ' has ' + (s.tempChange >= 0 ? 'warmed' : 'cooled') + ' by ~' +
            Math.abs(s.tempChange).toFixed(2) + '\u00B0C over this period, with a ~' +
            Math.abs(s.rainTrend).toFixed(1) + '% ' + (s.rainTrend < 0 ? 'decline' : 'increase') +
            ' in annual rainfall. The number of hot days (\u2265 35\u00B0C) has ' +
            (s.hotDays >= 0 ? 'increased' : 'decreased') + ' by ~' + Math.abs(Math.round(s.hotDays)) +
            ' days. Source: Open-Meteo ERA5 archive, complete years ' + c.years[0] + '\u2013' + c.years[c.years.length - 1] + '.';
    }
    /* ------------------------------------------------------------------
       Render: temperature area chart
       ------------------------------------------------------------------ */
    function renderTemp() {
        var plot = els.tempPlot;
        var W = plot.clientWidth, H = plot.clientHeight;
        if (W < 60 || H < 60) { return; }   // hidden tab — redrawn when shown
        var c = current();
        var n = c.years.length;
        var m = { l: 46, r: 16, t: 22, b: 24 };
        var pw = W - m.l - m.r, ph = H - m.t - m.b;
        var sc = niceTemp(Math.min.apply(null, c.temps), Math.max.apply(null, c.temps));
        function X(i) { return m.l + (n === 1 ? pw / 2 : (i / (n - 1)) * pw); }
        function Y(v) { return m.t + ph - ((v - sc.lo) / (sc.hi - sc.lo)) * ph; }
        plot.innerHTML = '';
        var svg = svgEl('svg', { viewBox: '0 0 ' + W + ' ' + H, role: 'img',
            'aria-label': 'Average temperature by year, ' + c.years[0] + ' to ' + c.years[n - 1] });
        plot.appendChild(svg);
        var defs = svgEl('defs');
        var grad = svgEl('linearGradient', { id: 'ct-grad-temp', x1: 0, y1: 0, x2: 0, y2: 1 });
        grad.appendChild(svgEl('stop', { offset: '0%',   'stop-color': '#ff7a3d', 'stop-opacity': 0.55 }));
        grad.appendChild(svgEl('stop', { offset: '100%', 'stop-color': '#ff7a3d', 'stop-opacity': 0.02 }));
        defs.appendChild(grad);
        svg.appendChild(defs);
        // Grid + y labels
        for (var v = sc.lo; v <= sc.hi; v += 2) {
            svg.appendChild(svgEl('line', { x1: m.l, x2: m.l + pw, y1: Y(v), y2: Y(v), 'class': 'ct-grid-line' }));
            text(svg, m.l - 8, Y(v) + 4, v + '\u00B0C', 'end');
        }
        // X labels
        var step = pw / Math.max(n - 1, 1) < 30 ? 2 : 1;
        c.years.forEach(function (yr, i) {
            if ((n - 1 - i) % step === 0) { text(svg, X(i), H - 6, yr); }
        });
        // Area + line
        var pts = c.temps.map(function (t, i) { return X(i) + ',' + Y(t); });
        svg.appendChild(svgEl('polygon', {
            points: X(0) + ',' + (m.t + ph) + ' ' + pts.join(' ') + ' ' + X(n - 1) + ',' + (m.t + ph),
            fill: 'url(#ct-grad-temp)'
        }));
        svg.appendChild(svgEl('polyline', {
            points: pts.join(' '), fill: 'none', stroke: '#ff7a3d',
            'stroke-width': 2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round'
        }));
        // Points
        var dots = c.temps.map(function (t, i) {
            var d = svgEl('circle', { cx: X(i), cy: Y(t), r: 3.6, fill: '#ff8a4f', stroke: '#2a1308', 'stroke-width': 1 });
            svg.appendChild(d);
            return d;
        });
        // Tooltip: pinned to latest year, follows hover
        var tip = makeTip(plot, '');
        function pin() {
            var last = n - 1;
            tip.show(X(last), Y(c.temps[last]), c.years[last], c.temps[last].toFixed(1) + '\u00B0C', W);
            dots.forEach(function (d, i) { d.setAttribute('r', i === last ? 5 : 3.6); });
        }
        pin();
        var band = pw / Math.max(n - 1, 1);
        c.years.forEach(function (yr, i) {
            var hit = svgEl('rect', { x: X(i) - band / 2, y: m.t, width: band, height: ph, 'class': 'ct-hit' });
            hit.addEventListener('pointerenter', function () {
                tip.show(X(i), Y(c.temps[i]), yr, c.temps[i].toFixed(1) + '\u00B0C', W);
                dots.forEach(function (d, j) { d.setAttribute('r', j === i ? 5 : 3.6); });
            });
            svg.appendChild(hit);
        });
        svg.addEventListener('pointerleave', pin);
    }
    /* ------------------------------------------------------------------
       Render: rainfall bar chart + dashed regression trend line
       ------------------------------------------------------------------ */
    function renderRain() {
        var plot = els.rainPlot;
        var W = plot.clientWidth, H = plot.clientHeight;
        if (W < 60 || H < 60) { return; }
        var c = current();
        var n = c.years.length;
        var m = { l: 62, r: 10, t: 22, b: 24 };
        var pw = W - m.l - m.r, ph = H - m.t - m.b;
        // Scale to the data (any city, wet or dry) instead of a fixed max.
        var max = Math.ceil(Math.max.apply(null, c.rain.concat([100])) / 200) * 200;
        var stepV = Math.ceil(max / 5 / 50) * 50;
        var band = pw / n;
        var bw = Math.min(band * 0.62, 30);
        function CX(i) { return m.l + band * i + band / 2; }
        function Y(v) { return m.t + ph - (v / max) * ph; }
        plot.innerHTML = '';
        var svg = svgEl('svg', { viewBox: '0 0 ' + W + ' ' + H, role: 'img',
            'aria-label': 'Annual rainfall by year, ' + c.years[0] + ' to ' + c.years[n - 1] });
        plot.appendChild(svg);
        var defs = svgEl('defs');
        var grad = svgEl('linearGradient', { id: 'ct-grad-rain', x1: 0, y1: 0, x2: 0, y2: 1 });
        grad.appendChild(svgEl('stop', { offset: '0%',   'stop-color': '#3ec1ff' }));
        grad.appendChild(svgEl('stop', { offset: '100%', 'stop-color': '#0b6fc4' }));
        defs.appendChild(grad);
        svg.appendChild(defs);
        for (var v = 0; v <= max; v += stepV) {
            svg.appendChild(svgEl('line', { x1: m.l, x2: m.l + pw, y1: Y(v), y2: Y(v), 'class': 'ct-grid-line' }));
            text(svg, m.l - 8, Y(v) + 4, fmt(v) + ' mm', 'end');
        }
        var step = band < 28 ? 2 : 1;
        var tip = makeTip(plot, 'ct-tip--rain');
        tip.hide();
        var bars = c.rain.map(function (r, i) {
            var b = svgEl('rect', {
                x: CX(i) - bw / 2, y: Y(r), width: bw, height: Math.max(0, Y(0) - Y(r)),
                rx: 2.5, fill: 'url(#ct-grad-rain)'
            });
            svg.appendChild(b);
            if ((n - 1 - i) % step === 0) { text(svg, CX(i), H - 6, c.years[i]); }
            return b;
        });
        // Least-squares trend line
        var sx = 0, sy = 0, sxy = 0, sxx = 0;
        c.rain.forEach(function (y, x) { sx += x; sy += y; sxy += x * y; sxx += x * x; });
        var slope = (n * sxy - sx * sy) / (n * sxx - sx * sx || 1);
        var icpt = (sy - slope * sx) / n;
        svg.appendChild(svgEl('line', {
            x1: CX(0), y1: Y(icpt), x2: CX(n - 1), y2: Y(icpt + slope * (n - 1)),
            stroke: '#2ee59d', 'stroke-width': 2, 'stroke-dasharray': '6 5', 'stroke-linecap': 'round'
        }));
        // Hover
        c.years.forEach(function (yr, i) {
            var hit = svgEl('rect', { x: m.l + band * i, y: m.t, width: band, height: ph, 'class': 'ct-hit' });
            hit.addEventListener('pointerenter', function () {
                bars.forEach(function (b, j) { b.style.opacity = j === i ? 1 : 0.55; });
                tip.show(CX(i), Y(c.rain[i]), yr, fmt(c.rain[i]) + ' mm', W);
            });
            svg.appendChild(hit);
        });
        svg.addEventListener('pointerleave', function () {
            bars.forEach(function (b) { b.style.opacity = ''; });
            tip.hide();
        });
    }
    function renderCharts() { if (!data) return; renderTemp(); renderRain(); }
    function renderAll() { renderText(); renderCharts(); }
    /* ------------------------------------------------------------------
       Range dropdown
       ------------------------------------------------------------------ */
    function buildMenu() {
        els.rangeMenu.innerHTML = data.ranges.map(function (r) {
            return '<li class="ct-range__item" role="option" tabindex="0" data-id="' + r.id +
                '" aria-selected="' + (r.id === activeRange) + '">' + r.label + '</li>';
        }).join('');
    }
    function setMenu(open) {
        els.rangeMenu.hidden = !open;
        els.rangeBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
        if (open) {
            var sel = els.rangeMenu.querySelector('[aria-selected="true"]');
            if (sel) { sel.focus(); }
        }
    }
    function pick(item) {
        if (!item || !data) { return; }
        activeRange = item.dataset.id;
        buildMenu();
        setMenu(false);
        els.rangeBtn.focus();
        renderAll();
    }
    els.rangeBtn.addEventListener('click', function () { if (data) setMenu(els.rangeMenu.hidden); });
    els.rangeMenu.addEventListener('click', function (e) { pick(e.target.closest('.ct-range__item')); });
    els.rangeMenu.addEventListener('keydown', function (e) {
        var item = e.target.closest('.ct-range__item');
        if (!item) { return; }
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(item); }
        if (e.key === 'ArrowDown' && item.nextElementSibling) { e.preventDefault(); item.nextElementSibling.focus(); }
        if (e.key === 'ArrowUp' && item.previousElementSibling) { e.preventDefault(); item.previousElementSibling.focus(); }
    });
    document.addEventListener('click', function (e) {
        if (!els.rangeMenu.hidden && !e.target.closest('.ct-range')) { setMenu(false); }
    });
    document.addEventListener('keydown', function (e) {
        if (e.key === 'Escape' && !els.rangeMenu.hidden) { setMenu(false); els.rangeBtn.focus(); }
    });
    /* ------------------------------------------------------------------
       Redraw whenever the plots get a real size (tab shown / window resized)
       ------------------------------------------------------------------ */
    if ('ResizeObserver' in window) {
        var ro = new ResizeObserver(function () { renderCharts(); });
        ro.observe(els.tempPlot);
        ro.observe(els.rainPlot);
    } else {
        window.addEventListener('resize', renderCharts);
    }
    /* ------------------------------------------------------------------
       Public API (kept for external callers)
       ------------------------------------------------------------------ */
    window.ClimateTrend = {
        setLocation: setLocation,
        setData: function (next) {
            if (!next || !next.years || !next.temps || !next.rain || !next.ranges || !next.ranges.length) { return; }
            data = next;
            activeRange = data.ranges[0].id;
            buildMenu();
            renderAll();
            setStatus('');
        }
    };
    /* ------------------------------------------------------------------
       Live location + initial load
       ------------------------------------------------------------------ */
    document.addEventListener('weatherly:location-change', function (e) { setLocation(e.detail); });
    document.addEventListener('weatherly:device-location-active', function (e) { setLocation(e.detail); });
    var initial = window.WeatherlyTopbar && window.WeatherlyTopbar.getLocation();
    if (initial && Number.isFinite(Number(initial.lat)) && Number.isFinite(Number(initial.lon))) {
        setLocation(initial);
    } else {
        var saved = readLocation();
        if (saved) {
            setLocation({ name: saved.name, lat: saved.lat, lon: saved.lon });
        } else {
            setStatus('Pick a location to load its climate history.');
        }
    }
})();
