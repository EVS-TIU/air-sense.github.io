/* ==========================================================================
   Climate Analysis — "Generate Analysis" overview
   --------------------------------------------------------------------------
   Flow (per the plan in local-plans/CLIMATE_ANALYSIS_AI_OVERVIEW_PLAN.md):
   1. Click "Generate Analysis" -> the active tab's series is collected
      through each tab's public getSeries() API (no DOM scraping).
   2. A lightweight non-linear regression (quadratic least squares, O(n),
      a few KB of floats — far below the 512 MB cap) runs in the browser.
   3. The compact stats go to OpenRouter (Gemma 4 31B) for a 2–3 sentence
      overview, which renders in the AI Summary card under the calendar.
   4. If the key is missing or the call fails, the locally computed
      regression summary is shown instead — the card is never empty.
   ========================================================================== */
(function () {
    'use strict';
    /* ------------------------------------------------------------------
       Config — paste your OpenRouter key here (sk-or-…). A localStorage
       override exists so the key can be added without a code change:
       localStorage.setItem('airsense:openrouter-key', 'sk-or-…')
       ------------------------------------------------------------------ */
    var CFG = window.CLIMATE_ANALYSIS_AI = {
        PROVIDER: 'openrouter',
        BASE_URL: 'https://openrouter.ai/api/v1',
        MODEL: 'google/gemma-4-31b-it:free',   // verified on the OpenRouter catalog
        API_KEY: '',
        TIMEOUT_MS: 25000
    };
    var section = document.getElementById('climate-analysis-section');
    if (!section) return;
    var btn = section.querySelector('.ca-generate-btn');
    var card = document.getElementById('ca-summary');
    var body = document.getElementById('ca-summary-body');
    if (!btn || !card || !body) return;
    var TAB_NAMES = {
        'ca-weather-prediction': 'Weather Prediction',
        'ca-climate-trend': 'Climate Trend',
        'ca-aqi-outlook': 'AQI Outlook'
    };
    /* ------------------------------------------------------------------
       Math: quadratic least-squares fit y = a + b·x + c·x²
       Normal equations on a centred variable u = x - mean(x) keep the
       3×3 system well conditioned. O(n) time, O(1) extra memory.
       ------------------------------------------------------------------ */
    function mean(arr) {
        var s = 0;
        for (var i = 0; i < arr.length; i++) s += arr[i];
        return s / (arr.length || 1);
    }
    function pairs(xs, ys) {
        var outX = [], outY = [];
        for (var i = 0; i < xs.length; i++) {
            var x = Number(xs[i]), y = Number(ys[i]);
            if (Number.isFinite(x) && Number.isFinite(y)) { outX.push(x); outY.push(y); }
        }
        return { xs: outX, ys: outY };
    }
    function solve3(m, r) {
        // Gaussian elimination on a 3×3 system; returns [c0, c1, c2].
        var a = [
            [m[0][0], m[0][1], m[0][2], r[0]],
            [m[1][0], m[1][1], m[1][2], r[1]],
            [m[2][0], m[2][1], m[2][2], r[2]]
        ];
        for (var col = 0; col < 3; col++) {
            var piv = col;
            for (var row = col + 1; row < 3; row++) {
                if (Math.abs(a[row][col]) > Math.abs(a[piv][col])) piv = row;
            }
            if (Math.abs(a[piv][col]) < 1e-12) return null;
            var tmp = a[col]; a[col] = a[piv]; a[piv] = tmp;
            for (row = 0; row < 3; row++) {
                if (row === col) continue;
                var f = a[row][col] / a[col][col];
                for (var k = col; k < 4; k++) a[row][k] -= f * a[col][k];
            }
        }
        return [a[0][3] / a[0][0], a[1][3] / a[1][1], a[2][3] / a[2][2]];
    }
    // Fits in centred space: y ≈ A + B·u + C·u², u = x - mean(x).
    // Returns coefficients in original space plus R², slope and direction.
    function quadraticFit(xs, ys) {
        var n = xs.length;
        var mx = mean(xs), my = mean(ys);
        var m = [[0, 0, 0], [0, 0, 0], [0, 0, 0]], rhs = [0, 0, 0];
        var ssTot = 0;
        for (var i = 0; i < n; i++) {
            var u = xs[i] - mx, dy = ys[i] - my;
            var u1 = u, u2 = u * u;
            var basis = [1, u1, u2];
            for (var r = 0; r < 3; r++) {
                // X^T y uses the RAW y — centering here corrupts the intercept.
                rhs[r] += basis[r] * ys[i];
                for (var c = 0; c < 3; c++) m[r][c] += basis[r] * basis[c];
            }
            ssTot += dy * dy;
        }
        var sol = solve3(m, rhs);
        if (!sol) return null;   // degenerate series (e.g. all x equal)
        var A = sol[0], B = sol[1], C = sol[2];
        var ssRes = 0;
        for (i = 0; i < n; i++) {
            var ui = xs[i] - mx;
            var pred = A + B * ui + C * ui * ui;
            var d = ys[i] - pred;
            ssRes += d * d;
        }
        // Back to original coordinates: a + b·x + c·x²
        var a0 = A - B * mx + C * mx * mx;
        var b0 = B - 2 * C * mx;
        var c0 = C;
        // Linear slope (plain up/down read) through the same points.
        var sxx = 0, sxy = 0;
        for (i = 0; i < n; i++) { sxx += (xs[i] - mx) * (xs[i] - mx); sxy += (xs[i] - mx) * (ys[i] - my); }
        var slope = sxx ? sxy / sxx : 0;
        var r2 = ssTot > 1e-12 ? Math.max(0, Math.min(1, 1 - ssRes / ssTot)) : 0;
        var curvature = Math.abs(C) > 1e-9 ? (C > 0 ? 'accelerating' : 'decelerating') : 'steady';
        return {
            type: 'quadratic',
            a: a0, b: b0, c: c0,
            slope: slope,
            r2: r2,
            curvature: curvature,
            direction: slope > 0 ? 'upward' : slope < 0 ? 'downward' : 'flat',
            n: n,
            mean: my,
            first: ys[0],
            last: ys[n - 1],
            min: Math.min.apply(null, ys),
            max: Math.max.apply(null, ys)
        };
    }
    // Same halves logic the History Analysis trend stat uses.
    function halfMeans(ys) {
        var half = Math.floor(ys.length / 2);
        if (!half) return null;
        var before = mean(ys.slice(0, half));
        var after = mean(ys.slice(ys.length - half));
        return { before: before, after: after, change: after - before,
                 changePct: before ? ((after - before) / Math.abs(before)) * 100 : 0 };
    }
    /* ------------------------------------------------------------------
       Collect + shape the active tab's data
       ------------------------------------------------------------------ */
    function activeTabId() {
        var p = section.querySelector('.ca-tab-panel.is-active');
        return p ? p.id : 'ca-weather-prediction';
    }
    function collect(tabId) {
        var api = tabId === 'ca-climate-trend' ? window.ClimateTrend
            : tabId === 'ca-aqi-outlook' ? window.AqiOutlook
            : window.ClimateDashboard;
        if (!api || typeof api.getSeries !== 'function') return null;
        var s = api.getSeries();
        if (!s || !s.ready) return null;
        return s;
    }
    function buildPayload(tabId, s) {
        var payload = { tab: TAB_NAMES[tabId] || tabId, location: s.location || '', stats: {} };
        if (tabId === 'ca-climate-trend' && window.ClimateTrend) {
            payload.range = s.range || '';
            var t = pairs(s.years, s.temps);
            var r = pairs(s.years, s.rain);
            var tFit = quadraticFit(t.xs, t.ys);
            var rFit = quadraticFit(r.xs, r.ys);
            var h = pairs(s.years, s.hotDays);
            payload.stats = {
                unit: '°C',
                temp: tFit && {
                    firstYear: s.years[0], lastYear: s.years[s.years.length - 1],
                    first: tFit.first, last: tFit.last, min: tFit.min, max: tFit.max,
                    mean: tFit.mean, slopePerYear: tFit.slope, r2: tFit.r2,
                    curvature: tFit.curvature
                },
                rain: rFit && {
                    annualMean: rFit.mean, firstYearValue: rFit.first, lastYearValue: rFit.last,
                    slopePerYear: rFit.slope, r2: rFit.r2, curvature: rFit.curvature,
                    halfChangePct: halfMeans(r.ys) && halfMeans(r.ys).changePct
                },
                hotDaysChange: halfMeans(h.ys) && halfMeans(h.ys).change,
                seasonalAmp: s.summary && s.summary.seasonal
            };
        } else if (tabId === 'ca-aqi-outlook' && window.AqiOutlook) {
            payload.range = s.range || '';
            var q = pairs(s.years, s.aqi);
            var qFit = quadraticFit(q.xs, q.ys);
            var pm = pairs(s.years, s.pm25);
            var p10 = pairs(s.years, s.pm10);
            var no2 = pairs(s.years, s.no2);
            var cl = pairs(s.years, s.clean);
            payload.stats = {
                unit: 'US AQI',
                aqi: qFit && {
                    firstYear: s.years[0], lastYear: s.years[s.years.length - 1],
                    first: qFit.first, last: qFit.last, min: qFit.min, max: qFit.max,
                    mean: qFit.mean, slopePerYear: qFit.slope, r2: qFit.r2,
                    curvature: qFit.curvature
                },
                pm25Latest: pm.ys[pm.ys.length - 1],
                pm10Latest: p10.ys[p10.ys.length - 1],
                no2ChangePct: halfMeans(no2.ys) && halfMeans(no2.ys).changePct,
                cleanDaysChange: halfMeans(cl.ys) && Math.round(halfMeans(cl.ys).change),
                cleanDaysLatest: cl.ys[cl.ys.length - 1]
            };
        } else if (tabId === 'ca-weather-prediction' && window.ClimateDashboard) {
            var f = s.forecast || {};
            var trend = s.temperatureTrend || [];
            var maxes = pairs(trend.map(function (_, i) { return i; }), trend.map(function (p) { return p.max; }));
            var fit = quadraticFit(maxes.xs, maxes.ys);
            payload.range = 'next-day forecast + 7-day trend';
            payload.stats = {
                unit: '°C',
                forecast: {
                    date: f.date, condition: f.condition, temperature: f.temperature,
                    minTemperature: f.minTemperature, maxTemperature: f.maxTemperature,
                    humidity: f.humidity, windSpeed: f.windSpeed,
                    rainfallProbability: f.rainfallProbability, rainfallIntensity: f.rainfallIntensity,
                    aqi: f.aqi, aqiStatus: f.aqiStatus, confidence: f.confidence
                },
                weekTrend: fit && {
                    days: trend.length, min: fit.min, max: fit.max, mean: fit.mean,
                    slopePerDay: fit.slope, r2: fit.r2, curvature: fit.curvature
                }
            };
        }
        return payload;
    }
    /* ------------------------------------------------------------------
       Fallback: overview written from the regression alone (no LLM).
       Real fallback writer — full sentences, only numbers from stats.
       ------------------------------------------------------------------ */
    function round(v, d) { return Number(v).toFixed(d === undefined ? 1 : d); }
    function fallbackText(tabId, s, payload) {
        var st = payload.stats || {};
        var loc = s.location || 'The selected location';
        if (tabId === 'ca-climate-trend' && st.temp && st.rain) {
            var t = st.temp;
            var dir = t.slopePerYear >= 0 ? 'warmed' : 'cooled';
            var rainPct = st.rain.halfChangePct;
            return loc + ' ' + dir + ' at about ' + round(Math.abs(t.slopePerYear), 2) +
                '°C per year across ' + t.firstYear + '–' + t.lastYear +
                ' (quadratic fit, R² ' + round(t.r2, 2) + '), with annual temperatures between ' +
                round(t.min) + '°C and ' + round(t.max) + '°C.' +
                ' Rainfall averages about ' + round(st.rain.annualMean) + ' mm per year and moved ' +
                (rainPct >= 0 ? 'up' : 'down') + ' ~' + round(Math.abs(rainPct)) + '% between the earlier and recent half of the range.';
        }
        if (tabId === 'ca-aqi-outlook' && st.aqi) {
            var q = st.aqi;
            return 'Across ' + q.firstYear + '–' + q.lastYear + ', ' + loc +
                ' averaged US AQI ' + round(q.mean) + ' (range ' + round(q.min) + '–' + round(q.max) +
                '), moving ' + (q.slopePerYear >= 0 ? 'up' : 'down') + ' about ' +
                round(Math.abs(q.slopePerYear)) + ' points per year (R² ' + round(q.r2, 2) + ').' +
                ' Latest-year PM2.5 is ~' + round(st.pm25Latest) + ' µg/m³ and clean-air days ' +
                (st.cleanDaysChange >= 0 ? 'gained' : 'lost') + ' ~' + Math.abs(st.cleanDaysChange) +
                ' days per year between the two halves of the range.';
        }
        if (tabId === 'ca-weather-prediction' && st.forecast && st.weekTrend) {
            var f = st.forecast, w = st.weekTrend;
            var rainTxt = (f.rainfallIntensity || '').toLowerCase() === 'no'
                ? 'no rain expected (0% chance)'
                : (f.rainfallProbability || 0) + '% chance of ' + (f.rainfallIntensity || '').toLowerCase() + ' rain';
            return 'For ' + (f.date || 'the forecast day') + ' in ' + loc + ': ' +
                (f.condition || 'conditions unavailable') + ', about ' + round(f.temperature) + '°C ' +
                '(day range ' + round(f.minTemperature) + '–' + round(f.maxTemperature) + '°C), ' +
                rainTxt + ' and US AQI ' + (f.aqi != null ? f.aqi : 'n/a') + ' (' + (f.aqiStatus || 'n/a') + ').' +
                ' The 7-day highs ' + (w.slopePerDay >= 0 ? 'rise' : 'fall') + ' ~' +
                round(Math.abs(w.slopePerDay), 2) + '°C per day (R² ' + round(w.r2, 2) + ').';
        }
        return '';
    }
    /* ------------------------------------------------------------------
       OpenRouter (Gemma 4 31B) — strict numbers-only overview
       ------------------------------------------------------------------ */
    var SYSTEM =
        'You write short overviews of pre-computed climate and air-quality statistics for a weather dashboard.\n' +
        'You are not a forecaster and never invent data.\n' +
        'Use ONLY the numbers present in the user payload. If a value is missing or null, do not mention it.\n' +
        'Do not add units, years, locations or claims that are not in the payload.\n' +
        'Describe the fitted trend using the supplied regression stats (slope sign, R2, curvature, percent change).\n' +
        'Output: plain text only, 2-3 sentences, at most 60 words. No markdown, no headings, no lists, no disclaimers.';
    function apiKey() {
        if (CFG.API_KEY) return CFG.API_KEY;
        try { return window.localStorage.getItem('airsense:openrouter-key') || ''; }
        catch (e) { return ''; }
    }
    async function askGemma(payload) {
        var key = apiKey();
        if (!key) { var e = new Error('NO_KEY'); e.code = 'NO_KEY'; throw e; }
        var ctl = new AbortController();
        var timer = setTimeout(function () { ctl.abort(); }, CFG.TIMEOUT_MS);
        try {
            var res = await fetch(CFG.BASE_URL + '/chat/completions', {
                method: 'POST',
                headers: {
                    'content-type': 'application/json',
                    'Authorization': 'Bearer ' + key,
                    'HTTP-Referer': window.location.origin,
                    'X-Title': 'AirSense'
                },
                body: JSON.stringify({
                    model: CFG.MODEL,
                    temperature: 0.3,
                    max_tokens: 220,
                    messages: [
                        { role: 'system', content: SYSTEM },
                        { role: 'user', content: JSON.stringify(payload) }
                    ]
                }),
                signal: ctl.signal
            });
            if (!res.ok) throw new Error('OpenRouter request failed (HTTP ' + res.status + ')');
            var d = await res.json();
            var text = d && d.choices && d.choices[0] && d.choices[0].message && d.choices[0].message.content;
            if (typeof text !== 'string' || !text.trim()) throw new Error('Empty model response');
            return text.replace(/```[a-z]*|```/g, '').trim();
        } finally { clearTimeout(timer); }
    }
    /* ------------------------------------------------------------------
       Render into #ca-summary
       ------------------------------------------------------------------ */
    function showCard() { card.style.display = ''; card.hidden = false; }
    function renderBox(inner, isError) {
        showCard();
        body.innerHTML = inner;
        card.classList.toggle('is-error', !!isError);
        card.classList.toggle('is-loading', !isError && inner.indexOf('Analyzing') === 0);
    }
    function esc(s) {
        return String(s).replace(/[&<>"']/g, function (c) {
            return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
        });
    }
    function renderLoading(tabName) {
        showCard();
        body.innerHTML = '<p class="ca-summary__text is-loading">Analyzing ' + esc(tabName) + ' in the background…</p>';
        card.classList.add('is-loading');
        card.classList.remove('is-error');
    }
    function renderResult(overview, meta) {
        renderBox(
            '<p class="ca-summary__text">' + esc(overview) + '</p>' +
            '<p class="ca-summary__meta">' + esc(meta) + '</p>'
        );
    }
    function renderFallback(text, reason) {
        renderBox(
            '<p class="ca-summary__text">' + esc(text) + '</p>' +
            '<p class="ca-summary__meta">Local quadratic-regression overview — ' + esc(reason) + '</p>'
        );
    }
    /* ------------------------------------------------------------------
       Click flow (runs in the background; button just flips to busy)
       ------------------------------------------------------------------ */
    var running = false;
    async function run() {
        if (running) return;
        var tabId = activeTabId();
        var tabName = TAB_NAMES[tabId] || tabId;
        var s = collect(tabId);
        if (!s) {
            renderBox('<p class="ca-summary__text">This tab has no data yet. Wait for its data to load, then run the analysis again.</p>', true);
            return;
        }
        running = true;
        btn.classList.add('is-busy');
        btn.disabled = true;
        renderLoading(tabName);
        // Yield so the loading state paints before the regression starts.
        await new Promise(function (r) { setTimeout(r, 30); });
        try {
            var st = buildPayload(tabId, s);
            var payload = { tab: st.tab, location: st.location, range: st.range, stats: st.stats };
            try {
                var text = await askGemma(payload);
                renderResult(text, 'Quadratic regression · Gemma 4 31B via OpenRouter');
            } catch (err) {
                var local = fallbackText(tabId, s, st);
                if (!local) throw err;
                var reason = err.code === 'NO_KEY'
                    ? 'add an OpenRouter key (window.CLIMATE_ANALYSIS_AI.API_KEY) for the AI-written overview'
                    : err.name === 'AbortError' ? 'model request timed out' : err.message;
                renderFallback(local, reason);
            }
        } catch (err) {
            console.warn('Generate Analysis failed:', err);
            renderBox('<p class="ca-summary__text">Could not build the overview: ' + esc(err.message || err) + '</p>', true);
        } finally {
            running = false;
            btn.classList.remove('is-busy');
            btn.disabled = false;
        }
    }
    btn.addEventListener('click', run);
})();
