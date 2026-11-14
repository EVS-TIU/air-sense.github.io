/* ==========================================================================
   Climate Trend tab — renders into #ca-climate-trend
   One-custom-date view driven by the backend MLP prediction (no direct
   external API calls): the Weather Prediction tab fans the prediction for
   the picked calendar day out to this tab via the
   weatherly:prediction-data / -blank / -error events, and this tab shows
   that day's hourly temperature and rainfall in the same layout.
   ========================================================================== */
(function () {
    'use strict';
    var host = document.getElementById('ca-climate-trend');
    if (!host) { return; }
    /* ------------------------------------------------------------------
       Data layer
       ------------------------------------------------------------------ */
    var LOCATION_KEY = 'airsense:selected-location';

    var locationName = 'Selected Location';
    var data = null;          // { years (hour labels), temps, rain, ranges } for the picked day
    var meta = null;          // { date, temperature, tempMax, humidity[], insight }
    var activeRange = null;
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
                    '<div class="ct-chart__head">' + ICON.thermoS + '<h4 class="ct-chart__title">Temperature by Hour</h4></div>' +
                    '<div class="ct-chart__plot" id="ct-temp-plot"></div>' +
                    '<div class="ct-legend"><span class="ct-legend__item"><i class="ct-legend__dot"></i>Temperature (°C)</span></div>' +
                '</article>' +
                '<article class="ct-chart">' +
                    '<div class="ct-chart__head">' + ICON.cloud + '<h4 class="ct-chart__title">Rainfall by Hour</h4><span class="ct-chip" id="ct-rain-avg"></span></div>' +
                    '<div class="ct-chart__plot" id="ct-rain-plot"></div>' +
                    '<div class="ct-legend">' +
                        '<span class="ct-legend__item"><i class="ct-legend__sq"></i>Rainfall (mm)</span>' +
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
       Data: fed from the backend MLP prediction (the Weather Prediction
       tab fans it out) — no direct external API calls here.
       ------------------------------------------------------------------ */
    function hourlyValues(list, key) {
        return (list || []).map(function (p) {
            var v = p[key];
            return v === null || v === undefined ? 0 : v;
        });
    }
    function mountPrediction(detail) {
        detail = detail || {};
        var f = detail.forecast || {};
        var hours = (detail.hourlyTemperatures || []).map(function (p) { return p.hour; });
        if (hours.length < 2) { resetToBlank(); return; }
        data = {
            years: hours,
            temps: hourlyValues(detail.hourlyTemperatures, 'c'),
            rain: hourlyValues(detail.hourlyRainfall, 'v'),
            ranges: [{ id: 'day', years: hours.length, label: f.date || 'picked day', summary: {} }]
        };
        meta = {
            date: f.date,
            temperature: f.temperature,
            tempMax: f.max_temperature,
            humidity: detail.hourlyHumidity || [],
            insight: detail.aiInsight || ''
        };
        activeRange = 'day';
        els.rangeBtn.disabled = true;
        buildMenu();
        renderAll();
        setStatus('');
    }
    function resetToBlank() {
        data = null;
        meta = null;
        activeRange = null;
        els.rangeBtn.disabled = true;
        els.rangeLbl.textContent = '';
        els.stats.innerHTML = '';
        els.tempPlot.innerHTML = '';
        els.rainPlot.innerHTML = '';
        els.rainAvg.textContent = '';
        els.trendLbl.textContent = '';
        els.insight.textContent = '';
        els.sub.textContent = 'Pick a prediction date in the calendar to see its climate.';
        setStatus('');
    }
    function setLocation(detail) {
        if (!detail || typeof detail !== 'object') return;
        var name = String(detail.name || detail.city || '').trim();
        if (!name || /^(current location|device location)$/i.test(name)) return;
        var nextName = labelFor(detail);
        if (nextName === locationName) return;
        locationName = nextName;
        /* No fetching here: the Weather Prediction tab owns the prediction
           and fans the data out — clear the day until its next fan-out. */
        resetToBlank();
        els.sub.textContent = locationName + ' — pick a prediction date in the calendar.';
    }
    /* ------------------------------------------------------------------
       Render: header, KPI cards, insight
       ------------------------------------------------------------------ */
    function renderText() {
        var c = current();
        els.sub.textContent = 'MLP-model prediction for ' + locationName +
            (meta && meta.date ? ' \u00B7 ' + meta.date : '') + '.';
        els.rangeLbl.textContent = (meta && meta.date) || '';
        var humMean = null;
        if (meta) {
            var hum = meta.humidity.map(function (p) { return p.v; })
                .filter(function (v) { return v !== null && v !== undefined; });
            if (hum.length) humMean = hum.reduce(function (a, b) { return a + b; }, 0) / hum.length;
        }
        var rainTotal = c.rain.reduce(function (a, b) { return a + b; }, 0);
        var cards = [
            { cls: 'heat',   icon: ICON.thermo, label: 'Day Temperature',  value: meta && meta.temperature != null ? meta.temperature.toFixed(1) + '\u00B0C' : 'n/a', badge: '' },
            { cls: 'rain',   icon: ICON.rain,   label: 'Rainfall Total',   value: fmt(rainTotal) + ' mm', badge: '' },
            { cls: 'hot',    icon: ICON.sun,    label: 'Peak Temperature', value: meta && meta.tempMax != null ? meta.tempMax.toFixed(1) + '\u00B0C' : 'n/a', badge: '' },
            { cls: 'season', icon: ICON.layers, label: 'Avg Humidity',     value: humMean !== null ? Math.round(humMean) + '%' : 'n/a', badge: '' }
        ];
        els.stats.innerHTML = cards.map(function (k) {
            return '<div class="ct-stat ct-stat--' + k.cls + '">' + k.icon +
                '<div class="ct-stat__body"><span class="ct-stat__label">' + k.label + '</span>' +
                '<span class="ct-stat__value">' + k.value + '</span></div>' +
                (k.badge ? '<span class="ct-stat__badge">' + k.badge + '</span>' : '') +
                '</div>';
        }).join('');
        els.rainAvg.textContent = 'Total: ' + fmt(rainTotal) + ' mm';
        els.trendLbl.textContent = 'hourly';
        if (meta && meta.insight) {
            els.insight.textContent = meta.insight;
        } else {
            els.insight.textContent = locationName.split(',')[0] + ' on ' +
                ((meta && meta.date) || 'the picked day') + ': about ' +
                (meta && meta.temperature != null ? meta.temperature.toFixed(1) : 'n/a') + '\u00B0C on average, peaking near ' +
                (meta && meta.tempMax != null ? meta.tempMax.toFixed(1) : 'n/a') + '\u00B0C, with ' +
                fmt(rainTotal) + ' mm of rain across the 24 hours. Source: trained MLP prediction model.';
        }
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
            'aria-label': 'Hourly temperature for the picked day' });
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
            'aria-label': 'Hourly rainfall for the picked day' });
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
        // Overview feed for the Generate Analysis pipeline.
        getSeries: function () {
            if (!data || !meta) return { tab: 'Climate Trend', ready: false, location: locationName };
            var hum = meta.humidity.map(function (p) { return p.v; })
                .filter(function (v) { return v !== null && v !== undefined; });
            return {
                tab: 'Climate Trend',
                ready: true,
                location: locationName,
                date: meta.date,
                years: data.years,     // hour labels (00:00–23:00)
                temps: data.temps,     // hourly °C
                rain: data.rain,       // hourly mm
                humidity: meta.humidity,
                stats: {
                    temperature: meta.temperature,
                    tempMax: meta.tempMax,
                    rainfallTotal: Math.round(data.rain.reduce(function (a, b) { return a + b; }, 0) * 10) / 10,
                    avgHumidity: hum.length ? Math.round(hum.reduce(function (a, b) { return a + b; }, 0) / hum.length) : null
                }
            };
        },
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
       Prediction fan-out + live location
       ------------------------------------------------------------------ */
    document.addEventListener('weatherly:prediction-data', function (e) { mountPrediction(e.detail); });
    document.addEventListener('weatherly:prediction-blank', resetToBlank);
    document.addEventListener('weatherly:prediction-error', resetToBlank);
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
            // Same app default the dashboard uses (js/config.js), so a fresh
            // visitor still sees data instead of an empty tab. config.js is
            // not loaded on the standalone page, hence the literal.
            var dflt = (window.AIREC_CONFIG && window.AIREC_CONFIG.DEFAULT_LOCATION) ||
                { name: "Kolkata", latitude: 22.5726, longitude: 88.3639 };
            if (dflt && Number.isFinite(Number(dflt.latitude))) {
                setLocation({ name: dflt.name, lat: Number(dflt.latitude), lon: Number(dflt.longitude) });
            } else {
                setStatus('Pick a prediction date in the calendar to see its climate.');
            }
        }
    }
})();
