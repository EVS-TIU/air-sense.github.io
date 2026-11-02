/* ==========================================================================
   Climate Trend tab — renders into #ca-climate-trend
   --------------------------------------------------------------------------
   • Self-contained: no libraries, no changes to existing files.
   • Uses DEMO data below. To plug in your backend later, call
         ClimateTrend.setData({ years, temps, rain, ranges })
     (same shape as DEMO) and optionally
         ClimateTrend.setLocation('Delhi, India')
   ========================================================================== */

(function () {
    'use strict';

    var host = document.getElementById('ca-climate-trend');
    if (!host) { return; }

    /* ------------------------------------------------------------------
       Demo data  (2006 – 2026, one value per year)
       ------------------------------------------------------------------ */

    var DEMO = {
        years: [2006, 2007, 2008, 2009, 2010, 2011, 2012, 2013, 2014, 2015, 2016,
                2017, 2018, 2019, 2020, 2021, 2022, 2023, 2024, 2025, 2026],
        // Average annual temperature, °C
        temps: [24.9, 25.1, 24.8, 25.4, 25.2, 25.0, 25.5, 25.3, 25.7, 25.9, 25.8,
                26.3, 27.0, 27.3, 27.8, 28.0, 28.9, 29.0, 29.8, 30.5, 32.0],
        // Annual rainfall, mm
        rain:  [980, 940, 1010, 900, 960, 930, 990, 910, 950, 920, 930,
                900, 1010, 920, 940, 880, 910, 820, 760, 810, 850],
        // Range presets: `years` = how many trailing years to show.
        // `summary` values are the headline numbers for that range.
        ranges: [
            { id: '10', years: 11, label: '2016 – 2026 (Historical)',
              summary: { tempChange: 1.48, rainTrend: -6.2, hotDays: 24, seasonal: 7.8 } },
            { id: '5',  years: 6,  label: '2021 – 2026 (Recent)',
              summary: { tempChange: 0.92, rainTrend: -3.1, hotDays: 11, seasonal: 7.5 } },
            { id: '20', years: 21, label: '2006 – 2026 (Long term)',
              summary: { tempChange: 2.14, rainTrend: -8.4, hotDays: 41, seasonal: 7.9 } }
        ]
    };

    var data = DEMO;
    var locationName = 'Delhi, India';
    var activeRange = data.ranges[0].id;

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
        insight:  host.querySelector('#ct-insight-text')
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

    /* ------------------------------------------------------------------
       Render: header, KPI cards, insight
       ------------------------------------------------------------------ */

    function renderText() {
        var c = current();
        var s = c.range.summary;

        els.sub.textContent = 'Historical climate patterns and long-term changes for ' + locationName + '.';
        els.rangeLbl.textContent = c.range.label;

        var cards = [
            { cls: 'heat',   icon: ICON.thermo, label: 'Avg. Temp Change',     value: signed(s.tempChange, 2, '\u00B0C'),  badge: ICON.up },
            { cls: 'rain',   icon: ICON.rain,   label: 'Annual Rainfall Trend', value: signed(s.rainTrend, 1, '%'),         badge: s.rainTrend < 0 ? ICON.down : ICON.up },
            { cls: 'hot',    icon: ICON.sun,    label: 'Hot Days (\u2265 35\u00B0C)', value: signed(s.hotDays, 0, ' days'), badge: ICON.up },
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
            locationName.split(',')[0] + ' has warmed by ~' + s.tempChange.toFixed(2) + '\u00B0C over this period, with a ~' +
            Math.abs(s.rainTrend).toFixed(1) + '% ' + (s.rainTrend < 0 ? 'decline' : 'increase') +
            ' in annual rainfall. The number of hot days (\u2265 35\u00B0C) has increased by ~' + s.hotDays +
            ' days, indicating a clear warming trend.';
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
        var max = 1200;
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

        for (var v = 0; v <= max; v += 200) {
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

    function renderCharts() { renderTemp(); renderRain(); }

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
        if (!item) { return; }
        activeRange = item.dataset.id;
        buildMenu();
        setMenu(false);
        els.rangeBtn.focus();
        renderAll();
    }

    els.rangeBtn.addEventListener('click', function () { setMenu(els.rangeMenu.hidden); });

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
       Public API (for wiring to the real backend later)
       ------------------------------------------------------------------ */

    window.ClimateTrend = {
        setLocation: function (name) { locationName = name || locationName; renderText(); },
        setData: function (next) {
            if (!next || !next.years || !next.temps || !next.rain || !next.ranges || !next.ranges.length) { return; }
            data = next;
            activeRange = data.ranges[0].id;
            buildMenu();
            renderAll();
        }
    };

    buildMenu();
    renderAll();
})();
