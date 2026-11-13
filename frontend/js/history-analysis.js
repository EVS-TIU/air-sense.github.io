/* ==========================================================================
   AirSense - History Analysis
   Dynamic trend charts from real Open-Meteo data:
   - Weather variables: Open-Meteo Archive API (ERA5, daily, back to 1940)
   - Air-quality variables: Open-Meteo Air Quality API (CAMS, hourly -> daily
     mean, back to Jul 2022)
   The chart, stats and date range all react to the selected variable,
   location and custom start/end dates. Default range: latest full year.
   ========================================================================== */

(function () {
    'use strict';

    const els = {
        metric: document.getElementById('history-metric'),
        start: document.getElementById('history-start'),
        end: document.getElementById('history-end'),
        apply: document.getElementById('history-apply'),
        applyLabel: document.getElementById('history-apply-label'),
        locationName: document.getElementById('history-location-name'),
        locationBox: document.getElementById('history-location'),
        avg: document.getElementById('history-average'),
        avgLabel: document.getElementById('history-average-label'),
        peak: document.getElementById('history-peak'),
        peakLabel: document.getElementById('history-peak-label'),
        peakDate: document.getElementById('history-peak-date'),
        low: document.getElementById('history-low'),
        lowLabel: document.getElementById('history-low-label'),
        lowDate: document.getElementById('history-low-date'),
        trend: document.getElementById('history-trend'),
        chart: document.getElementById('history-chart'),
        chartWrap: document.getElementById('history-chart-wrap'),
        chartTitle: document.getElementById('history-chart-title'),
        chartMeta: document.getElementById('history-range-meta'),
        tooltip: document.getElementById('history-tooltip'),
        status: document.getElementById('history-status'),
        source: document.getElementById('history-source'),
        chips: Array.from(document.querySelectorAll('.history__range-chip'))
    };
    if (!els.metric || !els.chart) return;

    /* ------------------------------------------------------------------
       Variable registry. Air-quality values are hourly and aggregated to
       a daily mean; weather variables are available as daily aggregates.
       ------------------------------------------------------------------ */
    const ARCHIVE_URL = 'https://archive-api.open-meteo.com/v1/archive';
    const AIR_URL = 'https://air-quality-api.open-meteo.com/v1/air-quality';
    // CAMS-based air quality series starts on 2022-07-28.
    const AIR_MIN_DATE = '2022-07-28';
    // The ERA5 archive lags a few days behind real time; keep a safe margin.
    const ARCHIVE_LAG_DAYS = 5;

    const METRICS = {
        temp_mean: { name: 'Temperature (mean)', unit: '°C', source: 'archive', daily: 'temperature_2m_mean', decimals: 1 },
        temp_max: { name: 'Temperature (max)', unit: '°C', source: 'archive', daily: 'temperature_2m_max', decimals: 1 },
        temp_min: { name: 'Temperature (min)', unit: '°C', source: 'archive', daily: 'temperature_2m_min', decimals: 1 },
        humidity: { name: 'Relative Humidity', unit: '%', source: 'archive', daily: 'relative_humidity_2m_mean', decimals: 0 },
        wind: { name: 'Wind Speed (max)', unit: 'km/h', source: 'archive', daily: 'wind_speed_10m_max', decimals: 1 },
        precip: { name: 'Precipitation', unit: 'mm', source: 'archive', daily: 'precipitation_sum', decimals: 1 },
        pressure: { name: 'Surface Pressure', unit: 'hPa', source: 'archive', daily: 'surface_pressure_mean', decimals: 0 },
        cloud: { name: 'Cloud Cover', unit: '%', source: 'archive', daily: 'cloud_cover_mean', decimals: 0 },
        uv_archive: { name: 'UV Index (max)', unit: '', source: 'archive', daily: 'uv_index_max', decimals: 1 },

        us_aqi: { name: 'US AQI', unit: '', source: 'air', hourly: 'us_aqi', agg: 'mean', decimals: 0 },
        eu_aqi: { name: 'European AQI', unit: '', source: 'air', hourly: 'european_aqi', agg: 'mean', decimals: 0 },
        pm25: { name: 'PM2.5', unit: ' µg/m³', source: 'air', hourly: 'pm2_5', agg: 'mean', decimals: 1 },
        pm10: { name: 'PM10', unit: ' µg/m³', source: 'air', hourly: 'pm10', agg: 'mean', decimals: 1 },
        ozone: { name: 'Ozone (O₃)', unit: ' µg/m³', source: 'air', hourly: 'ozone', agg: 'mean', decimals: 0 },
        no2: { name: 'Nitrogen Dioxide (NO₂)', unit: ' µg/m³', source: 'air', hourly: 'nitrogen_dioxide', agg: 'mean', decimals: 0 },
        so2: { name: 'Sulphur Dioxide (SO₂)', unit: ' µg/m³', source: 'air', hourly: 'sulphur_dioxide', agg: 'mean', decimals: 0 },
        co: { name: 'Carbon Monoxide (CO)', unit: ' µg/m³', source: 'air', hourly: 'carbon_monoxide', agg: 'mean', decimals: 0 },
        dust: { name: 'Dust', unit: ' µg/m³', source: 'air', hourly: 'dust', agg: 'mean', decimals: 1 },
        uv_air: { name: 'UV Index (mean)', unit: '', source: 'air', hourly: 'uv_index', agg: 'mean', decimals: 2 }
    };

    /* ------------------------------------------------------------------
       Location: the shared selection saved by map.js / topbar.js.
       ------------------------------------------------------------------ */
    const LOCATION_KEY = 'airsense:selected-location';
    const DEFAULT_LOCATION = { name: 'Dubai', lat: 25.2048, lon: 55.2708 };

    function readLocation() {
        try {
            const raw = window.localStorage.getItem(LOCATION_KEY);
            if (!raw) return null;
            const saved = JSON.parse(raw);
            const lat = Number(saved.lat), lon = Number(saved.lon);
            if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
            return { name: saved.name || 'Selected Location', lat, lon };
        } catch {
            return null;
        }
    }

    let location = readLocation() || DEFAULT_LOCATION;
    renderLocation();

    function renderLocation() {
        els.locationName.textContent = location.name;
        els.locationBox.title = `${location.name} (${location.lat.toFixed(3)}, ${location.lon.toFixed(3)})`;
    }

    document.addEventListener('weatherly:location-change', (e) => {
        const city = e.detail;
        if (!city || !Number.isFinite(Number(city.lat)) || !Number.isFinite(Number(city.lon))) return;
        location = { name: city.name || 'Selected Location', lat: Number(city.lat), lon: Number(city.lon) };
        renderLocation();
        load(true);
    });

    /* ------------------------------------------------------------------
       Date helpers. "Latest possible" end date = yesterday (the last full
       local day that both APIs provide).
       ------------------------------------------------------------------ */
    const DAY_MS = 86400000;

    function isoDate(d) {
        const y = d.getFullYear(), m = String(d.getMonth() + 1).padStart(2, '0'), day = String(d.getDate()).padStart(2, '0');
        return `${y}-${m}-${day}`;
    }

    function addDays(iso, days) {
        const d = new Date(iso + 'T00:00:00');
        d.setDate(d.getDate() + days);
        return isoDate(d);
    }

    function yesterdayIso() {
        const d = new Date();
        d.setDate(d.getDate() - 1);
        return isoDate(d);
    }

    function prettyDate(iso) {
        const d = new Date(iso + 'T00:00:00');
        return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
    }

    function prettyDateShort(iso) {
        const d = new Date(iso + 'T00:00:00');
        return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    }

    // Default: end = latest possible, start = one year earlier.
    els.end.value = yesterdayIso();
    els.start.value = addDays(els.end.value, -365);

    function clampDates() {
        const meta = METRICS[els.metric.value];
        const maxYest = yesterdayIso();
        let changed = false;

        if (!els.start.value) { els.start.value = addDays(els.end.value, -365); changed = true; }
        if (!els.end.value) { els.end.value = maxYest; changed = true; }

        // Auto-swap an inverted range.
        if (els.start.value > els.end.value) {
            const t = els.start.value;
            els.start.value = els.end.value;
            els.end.value = t;
            changed = true;
        }

        // Archive end: yesterday at the latest.
        if (meta.source === 'archive' && els.end.value > addDays(maxYest, 0)) {
            els.end.value = maxYest;
            changed = true;
        }
        // Air-quality history starts in Jul 2022.
        if (meta.source === 'air' && els.start.value < AIR_MIN_DATE) {
            els.start.value = AIR_MIN_DATE;
            changed = true;
        }
        if (els.end.value > maxYest) {
            els.end.value = maxYest;
            changed = true;
        }
        if (changed) setStatus('Range adjusted to the newest data available for this variable.', 'muted');
        return changed;
    }

    /* ------------------------------------------------------------------
       Data loading
       ------------------------------------------------------------------ */
    let activeRequest = 0;
    let controller = null;

    function setStatus(msg, kind) {
        els.status.textContent = msg || '';
        els.status.className = 'history__status' + (kind ? ' is-' + kind : '');
    }

    async function fetchData(metric, startIso, endIso) {
        const url = new URL(metric.source === 'archive' ? ARCHIVE_URL : AIR_URL);
        url.searchParams.set('latitude', location.lat.toFixed(4));
        url.searchParams.set('longitude', location.lon.toFixed(4));
        url.searchParams.set('start_date', startIso);
        url.searchParams.set('end_date', endIso);
        url.searchParams.set('timezone', 'auto');
        if (metric.source === 'archive') {
            url.searchParams.set('daily', metric.daily);
        } else {
            url.searchParams.set('hourly', metric.hourly);
        }

        const res = await fetch(url.toString(), { signal: controller.signal });
        const body = await res.json();
        if (body.error) throw new Error(body.reason || 'Open-Meteo request failed');

        let times, values;
        if (metric.source === 'archive') {
            times = body.daily.time;
            values = body.daily[metric.daily];
        } else {
            // Aggregate hourly values into daily means (local calendar days).
            const sums = new Map();
            const counts = new Map();
            const hTimes = body.hourly.time;
            const hVals = body.hourly[metric.hourly];
            for (let i = 0; i < hTimes.length; i++) {
                const v = hVals[i];
                if (v === null || v === undefined) continue;
                const day = hTimes[i].slice(0, 10);
                sums.set(day, (sums.get(day) || 0) + v);
                counts.set(day, (counts.get(day) || 0) + 1);
            }
            times = Array.from(sums.keys()).sort();
            values = times.map((day) => sums.get(day) / counts.get(day));
        }

        const series = [];
        for (let i = 0; i < times.length; i++) {
            const v = values[i];
            if (v === null || v === undefined || !Number.isFinite(v)) continue;
            series.push({ date: times[i], value: v });
        }
        if (!series.length) throw new Error('No data returned for this variable and range.');
        return series;
    }

    async function load(manual) {
        const meta = METRICS[els.metric.value];
        if (!meta) return;
        clampDates();
        const startIso = els.start.value, endIso = els.end.value;
        if (!startIso || !endIso) return;

        // Cancel any in-flight request.
        if (controller) controller.abort();
        controller = new AbortController();
        const myRequest = ++activeRequest;

        els.apply.disabled = true;
        els.applyLabel.textContent = 'Loading…';
        setStatus(`Loading ${meta.name} for ${location.name} (${startIso} → ${endIso})…`, 'loading');

        try {
            let series = await fetchData(meta, startIso, endIso);
            if (myRequest !== activeRequest) return;

            // Downsample very long ranges so the SVG stays light and the
            // hover readout stays meaningful.
            if (series.length > 400) series = downsample(series, 400);

            drawChart(meta, series, startIso, endIso);
            renderStats(meta, series, startIso, endIso);
            setStatus('');
        } catch (err) {
            if (err && err.name === 'AbortError') return;
            console.warn('History load failed:', err);
            setStatus(`Could not load data: ${err.message || err}`, 'error');
        } finally {
            if (myRequest === activeRequest) {
                els.apply.disabled = false;
                els.applyLabel.textContent = 'Show trend';
            }
        }
    }

    function downsample(series, targetPoints) {
        const bucketSize = Math.ceil(series.length / targetPoints);
        if (bucketSize <= 1) return series;
        const out = [];
        for (let i = 0; i < series.length; i += bucketSize) {
            const slice = series.slice(i, i + bucketSize);
            const sum = slice.reduce((acc, p) => acc + p.value, 0);
            out.push({ date: slice[0].date, value: sum / slice.length, span: bucketSize });
        }
        return out;
    }

    /* ------------------------------------------------------------------
       Chart rendering (vanilla SVG, app design tokens)
       ------------------------------------------------------------------ */
    const CHART = { w: 900, h: 320, left: 64, right: 20, top: 22, bottom: 36 };

    function niceScale(min, max) {
        if (!Number.isFinite(min) || !Number.isFinite(max)) return { lo: 0, hi: 1, step: 1 };
        if (min === max) { min -= 1; max += 1; }
        const pad = (max - min) * 0.06;
        let lo = min - pad, hi = max + pad;
        if (lo < 0 && min >= 0) lo = 0;
        const targetTicks = 6;
        const rawStep = (hi - lo) / targetTicks;
        const mag = Math.pow(10, Math.floor(Math.log10(rawStep)));
        const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= rawStep) || 10 * mag;
        lo = Math.floor(lo / step) * step;
        hi = Math.ceil(hi / step) * step;
        return { lo, hi, step };
    }

    function fmt(meta, v) {
        return Number(v).toFixed(meta.decimals) + meta.unit;
    }

    function drawChart(meta, series, startIso, endIso) {
        const { w, h, left, right, top, bottom } = CHART;
        const plotW = w - left - right, plotH = h - top - bottom;
        const values = series.map((p) => p.value);
        const scale = niceScale(Math.min(...values), Math.max(...values));
        const x = (i) => left + (series.length === 1 ? plotW / 2 : (i / (series.length - 1)) * plotW);
        const y = (v) => top + plotH - ((v - scale.lo) / (scale.hi - scale.lo)) * plotH;

        let svg = `<defs><linearGradient id="history-area-grad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stop-color="rgba(41,182,255,0.34)"/>
            <stop offset="100%" stop-color="rgba(41,182,255,0.02)"/>
        </linearGradient></defs>`;

        // Y grid + labels
        let grid = '<g class="history__grid">';
        for (let v = scale.lo; v <= scale.hi + 1e-9; v += scale.step) {
            const gy = y(v);
            grid += `<line x1="${left}" y1="${gy}" x2="${left + plotW}" y2="${gy}"/>`;
            grid += `<text x="${left - 8}" y="${gy + 3}" text-anchor="end">${Number(v.toFixed(scale.step < 1 ? 2 : 0))}</text>`;
        }
        grid += '</g>';
        svg += grid;

        // Area + line
        const linePts = series.map((p, i) => `${x(i).toFixed(1)},${y(p.value).toFixed(1)}`);
        const areaD = `M ${left},${y(scale.lo)} L ${linePts.join(' L ')} L ${left + plotW},${y(scale.lo)} Z`;
        svg += `<path class="history__series-area" d="${areaD}" fill="url(#history-area-grad)"/>`;
        svg += `<polyline class="history__series-line" points="${linePts.join(' ')}"/>`;

        // X labels: ~6 evenly spaced
        let axis = '<g class="history__axis">';
        const ticks = Math.min(6, series.length);
        for (let t = 0; t < ticks; t++) {
            const i = Math.round((t / (ticks - 1 || 1)) * (series.length - 1));
            axis += `<text x="${x(i)}" y="${h - 10}" text-anchor="${t === 0 ? 'start' : t === ticks - 1 ? 'end' : 'middle'}">${prettyDateShort(series[i].date)}</text>`;
        }
        axis += '</g>';
        svg += axis;

        // Hover layer
        svg += `<line class="history__hover-line" id="history-hover-line" x1="0" y1="${top}" x2="0" y2="${top + plotH}" visibility="hidden"/>`;
        svg += `<circle class="history__hover-dot" id="history-hover-dot" r="4.5" visibility="hidden"/>`;
        svg += `<rect id="history-hover-capture" x="0" y="0" width="${w}" height="${h}" fill="transparent"/>`;

        els.chart.innerHTML = svg;
        els.chartTitle.textContent = `${meta.name} · ${location.name}`;
        const rangeDays = Math.round((new Date(endIso + 'T00:00:00') - new Date(startIso + 'T00:00:00')) / DAY_MS) + 1;
        const note = series.length < rangeDays ? ' (downsampled for display)' : '';
        els.chartMeta.textContent = `${prettyDate(startIso)} → ${prettyDate(endIso)} · ${rangeDays} ${rangeDays === 1 ? 'day' : 'days'}${note}`;

        // Hover behaviour
        const capture = els.chart.querySelector('#history-hover-capture');
        const hoverLine = els.chart.querySelector('#history-hover-line');
        const hoverDot = els.chart.querySelector('#history-hover-dot');
        capture.addEventListener('mousemove', (e) => {
            const rect = els.chart.getBoundingClientRect();
            const mx = ((e.clientX - rect.left) / rect.width) * CHART.w;
            const ratio = (mx - left) / plotW;
            const idx = Math.max(0, Math.min(series.length - 1, Math.round(ratio * (series.length - 1))));
            const p = series[idx];
            const px = x(idx), py = y(p.value);
            hoverLine.setAttribute('x1', px);
            hoverLine.setAttribute('x2', px);
            hoverLine.setAttribute('visibility', 'visible');
            hoverDot.setAttribute('cx', px);
            hoverDot.setAttribute('cy', py);
            hoverDot.setAttribute('visibility', 'visible');
            els.tooltip.innerHTML = `<strong>${fmt(meta, p.value)}</strong><br><span class="history__tooltip-date">${prettyDate(p.date)}</span>`;
            const leftPct = (px / CHART.w) * 100;
            els.tooltip.style.left = leftPct + '%';
            els.tooltip.style.top = (py / CHART.h) * 100 + '%';
            els.tooltip.style.opacity = '1';
            els.tooltip.setAttribute('aria-hidden', 'false');
        });
        capture.addEventListener('mouseleave', () => {
            hoverLine.setAttribute('visibility', 'hidden');
            hoverDot.setAttribute('visibility', 'hidden');
            els.tooltip.style.opacity = '0';
            els.tooltip.setAttribute('aria-hidden', 'true');
        });
    }

    function renderStats(meta, series, startIso, endIso) {
        const vals = series.map((p) => p.value);
        const avg = vals.reduce((a, b) => a + b, 0) / vals.length;
        let peak = series[0], low = series[0];
        for (const p of series) {
            if (p.value > peak.value) peak = p;
            if (p.value < low.value) low = p;
        }

        els.avgLabel.textContent = `Average ${meta.name}`;
        els.avg.textContent = fmt(meta, avg);
        els.peakLabel.textContent = `Peak ${meta.name}`;
        els.peak.textContent = fmt(meta, peak.value);
        els.peakDate.textContent = prettyDate(peak.date);
        els.lowLabel.textContent = `Lowest ${meta.name}`;
        els.low.textContent = fmt(meta, low.value);
        els.lowDate.textContent = prettyDate(low.date);

        // Trend: compare the mean of the most recent half against the
        // earlier half of the series (percentage change).
        const half = Math.floor(series.length / 2);
        const earlier = series.slice(0, half);
        const recent = series.slice(series.length - half);
        const mean = (arr) => arr.reduce((a, p) => a + p.value, 0) / (arr.length || 1);
        const before = mean(earlier), after = mean(recent);
        const change = before === 0 ? (after > 0 ? 100 : 0) : ((after - before) / Math.abs(before)) * 100;
        const sign = change > 0.5 ? '▲' : change < -0.5 ? '▼' : '≈';
        els.trend.textContent = `${sign} ${Math.abs(change).toFixed(1)}%`;
        els.trend.className = 'history__stat-value' + (change > 0.5 ? ' is-up' : change < -0.5 ? ' is-down' : '');
    }

    /* ------------------------------------------------------------------
       Quick range chips
       ------------------------------------------------------------------ */
    function activeChip(range) {
        els.chips.forEach((c) => c.classList.toggle('is-active', c.dataset.range === range));
    }

    els.chips.forEach((chip) => {
        chip.addEventListener('click', () => {
            const meta = METRICS[els.metric.value];
            const end = yesterdayIso();
            let start;
            if (chip.dataset.range === 'max') {
                start = meta.source === 'air' ? AIR_MIN_DATE : addDays(end, -365 * 5);
            } else {
                start = addDays(end, -(Number(chip.dataset.range) - 1));
            }
            els.start.value = start;
            els.end.value = end;
            activeChip(chip.dataset.range);
            load();
        });
    });

    /* ------------------------------------------------------------------
       Events
       ------------------------------------------------------------------ */
    els.apply.addEventListener('click', () => load(true));
    els.metric.addEventListener('change', () => { activeChip('custom'); clampDates(); load(); });
    els.start.addEventListener('change', () => { activeChip('custom'); load(); });
    els.end.addEventListener('change', () => { activeChip('custom'); load(); });

    // Initial load
    load();
})();
