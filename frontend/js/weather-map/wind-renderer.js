/* ==========================================================================
   AirSense — bounded Canvas wind-flow renderer
   --------------------------------------------------------------------------
   Wind vectors are sampled from the Open-Meteo speed/direction grid. The
   renderer keeps a fixed pool of particles, samples a small screen-space
   vector field once per viewport change, and only performs cheap arithmetic
   plus one short line segment per particle during animation.

   Meteorological directions describe where wind comes from. A direction of
   0° therefore moves a particle south, while 90° moves it west.
   ========================================================================== */
(function () {
    'use strict';

    const MAX_DPR = 2;
    const MIN_PARTICLES = 700;
    const MAX_PARTICLES = 3600;
    const FIELD_COLUMNS = 32;
    const FIELD_ROWS = 20;
    const MIN_SPEED_KMH = 0.35;
    const MAX_FRAME_DELTA = 0.05;
    const KM_PER_DEGREE = 111.32;

    function ensureWeatherPane(map) {
        let pane = map.getPane('weatherPane');
        if (!pane) {
            pane = map.createPane('weatherPane');
            pane.style.zIndex = '350';
            pane.style.pointerEvents = 'none';
        }
        return pane;
    }

    function finite(value) {
        if (value === null || value === undefined || value === '') return null;
        const number = Number(value);
        return Number.isFinite(number) ? number : null;
    }

    function wrapLongitude(lon) {
        return ((lon + 180) % 360 + 360) % 360 - 180;
    }

    function buildSegmentField(segment) {
        const speedGrid = segment?.values?.wind_speed_10m;
        const directionGrid = segment?.values?.wind_direction_10m;
        const rows = Number(segment?.rows);
        const columns = Number(segment?.columns);
        const bbox = segment?.bbox;
        if (!Array.isArray(speedGrid) || !Array.isArray(directionGrid) ||
            !(rows > 1 && columns > 1) || !Array.isArray(bbox) || bbox.length !== 4) {
            return null;
        }

        const [west, south, east, north] = bbox.map(Number);
        if (![west, south, east, north].every(Number.isFinite) || east <= west || north <= south) {
            return null;
        }

        const size = rows * columns;
        const speeds = new Float32Array(size);
        const eastVectors = new Float32Array(size);
        const northVectors = new Float32Array(size);
        const valid = new Uint8Array(size);
        let maxSpeed = 0;

        for (let row = 0; row < rows; row += 1) {
            for (let column = 0; column < columns; column += 1) {
                const index = row * columns + column;
                const speed = finite(speedGrid[row]?.[column]);
                const direction = finite(directionGrid[row]?.[column]);
                if (speed === null || direction === null || speed < 0) continue;

                // Meteorological direction is the source direction. Convert
                // to the direction the air travels in east/north coordinates.
                const radians = direction * Math.PI / 180;
                speeds[index] = speed;
                eastVectors[index] = -speed * Math.sin(radians);
                northVectors[index] = -speed * Math.cos(radians);
                valid[index] = 1;
                maxSpeed = Math.max(maxSpeed, speed);
            }
        }

        return { west, south, east, north, rows, columns, speeds, eastVectors, northVectors, valid, maxSpeed: maxSpeed || 1 };
    }

    function buildField(payload) {
        const segments = (payload?.segments || []).map(buildSegmentField).filter(Boolean);
        if (!segments.length) return null;
        return {
            segments,
            maxSpeed: Math.max(...segments.map((segment) => segment.maxSpeed)),
            unit: payload?.units?.wind_speed_10m || 'km/h'
        };
    }

    // Writes into out to avoid allocating an object for every particle.
    function sampleSegment(segment, lat, lon, out) {
        const wrappedLon = wrapLongitude(lon);
        if (lat < segment.south || lat > segment.north || wrappedLon < segment.west || wrappedLon > segment.east) return false;

        const x = ((wrappedLon - segment.west) / (segment.east - segment.west)) * (segment.columns - 1);
        const y = ((segment.north - lat) / (segment.north - segment.south)) * (segment.rows - 1);
        const x0 = Math.max(0, Math.min(segment.columns - 1, Math.floor(x)));
        const y0 = Math.max(0, Math.min(segment.rows - 1, Math.floor(y)));
        const x1 = Math.min(x0 + 1, segment.columns - 1);
        const y1 = Math.min(y0 + 1, segment.rows - 1);
        const tx = x - x0;
        const ty = y - y0;
        const i00 = y0 * segment.columns + x0;
        const i10 = y0 * segment.columns + x1;
        const i01 = y1 * segment.columns + x0;
        const i11 = y1 * segment.columns + x1;
        const w00 = (1 - tx) * (1 - ty);
        const w10 = tx * (1 - ty);
        const w01 = (1 - tx) * ty;
        const w11 = tx * ty;

        let totalWeight = 0;
        let east = 0;
        let north = 0;
        let speed = 0;
        if (segment.valid[i00]) { east += segment.eastVectors[i00] * w00; north += segment.northVectors[i00] * w00; speed += segment.speeds[i00] * w00; totalWeight += w00; }
        if (segment.valid[i10]) { east += segment.eastVectors[i10] * w10; north += segment.northVectors[i10] * w10; speed += segment.speeds[i10] * w10; totalWeight += w10; }
        if (segment.valid[i01]) { east += segment.eastVectors[i01] * w01; north += segment.northVectors[i01] * w01; speed += segment.speeds[i01] * w01; totalWeight += w01; }
        if (segment.valid[i11]) { east += segment.eastVectors[i11] * w11; north += segment.northVectors[i11] * w11; speed += segment.speeds[i11] * w11; totalWeight += w11; }
        if (!totalWeight) return false;

        out.east = east / totalWeight;
        out.north = north / totalWeight;
        out.speed = speed / totalWeight;
        return true;
    }

    function sample(field, lat, lon, out) {
        for (let index = 0; index < field.segments.length; index += 1) {
            if (sampleSegment(field.segments[index], lat, lon, out)) return true;
        }
        out.east = 0;
        out.north = 0;
        out.speed = 0;
        return false;
    }

    function particleCount(width, height) {
        const area = Math.max(1, width * height);
        const cores = Number(navigator.hardwareConcurrency) || 4;
        const deviceScale = cores <= 2 ? 0.55 : cores <= 4 ? 0.75 : 1;
        return Math.max(MIN_PARTICLES, Math.min(MAX_PARTICLES, Math.round(area / 650 * deviceScale)));
    }

    function createLayer(map) {
        const L = window.L;
        ensureWeatherPane(map);
        const container = L.DomUtil.create('div', 'airsense-wind-layer');
        Object.assign(container.style, { position: 'absolute', top: '0', left: '0', width: '100%', height: '100%', pointerEvents: 'none' });
        const canvas = L.DomUtil.create('canvas', 'airsense-wind-canvas');
        container.appendChild(canvas);
        const context = canvas.getContext('2d', { alpha: true, desynchronized: true });
        if (!context) return L.layerGroup();

        const layer = L.Layer.extend({
            onAdd: function (parentMap) {
                this._map = parentMap;
                this._running = false;
                this._interacting = false;
                this._paused = document.visibilityState === 'hidden';
                this._field = null;
                this._particles = [];
                this._screenField = null;
                this._lastTime = 0;
                parentMap.getPane('weatherPane').appendChild(container);
                this._resize();
                this._bindEvents();
                this._visibilityHandler = () => {
                    this._paused = document.visibilityState === 'hidden';
                    if (this._paused) this._stopFrame();
                    else this._resume();
                };
                document.addEventListener('visibilitychange', this._visibilityHandler);
                this._resume();
            },

            onRemove: function () {
                this._running = false;
                this._stopFrame();
                this._unbindEvents();
                if (this._visibilityHandler) document.removeEventListener('visibilitychange', this._visibilityHandler);
                if (this._resizeObserver) this._resizeObserver.disconnect();
                if (container.parentNode) container.parentNode.removeChild(container);
                context.clearRect(0, 0, canvas.width, canvas.height);
                this._particles.length = 0;
                this._field = null;
                this._screenField = null;
                this._map = null;
            },

            setData: function (payload) {
                this._field = buildField(payload);
                this._rebuildScreenField();
                this._resetParticles(true);
                this._clearCanvas();
                this._resume();
            },

            setOpacity: function (value) {
                const numeric = Number(value);
                this._opacity = Number.isFinite(numeric) ? Math.max(0, Math.min(1, numeric)) : 0.9;
            },

            _bindEvents: function () {
                this._map.on('resize', this._resize, this);
                this._map.on('movestart zoomstart', this._interactionStart, this);
                this._map.on('moveend zoomend', this._interactionEnd, this);
                this._resizeObserver = typeof ResizeObserver === 'function' ? new ResizeObserver(() => this._resize()) : null;
                this._resizeObserver?.observe(container);
            },

            _unbindEvents: function () {
                if (!this._map) return;
                this._map.off('resize', this._resize, this);
                this._map.off('movestart zoomstart', this._interactionStart, this);
                this._map.off('moveend zoomend', this._interactionEnd, this);
            },

            _interactionStart: function () {
                this._interacting = true;
                this._stopFrame();
            },

            _interactionEnd: function () {
                this._interacting = false;
                this._rebuildScreenField();
                this._resetParticles(false);
                this._clearCanvas();
                this._resume();
            },

            _resize: function () {
                if (!this._map) return;
                const size = this._map.getSize();
                const dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR);
                canvas.width = Math.max(1, Math.floor(size.x * dpr));
                canvas.height = Math.max(1, Math.floor(size.y * dpr));
                canvas.style.width = `${size.x}px`;
                canvas.style.height = `${size.y}px`;
                context.setTransform(dpr, 0, 0, dpr, 0, 0);
                this._particleTotal = particleCount(size.x, size.y);
                this._rebuildScreenField();
                this._resetParticles(false);
                this._clearCanvas();
                this._resume();
            },

            _rebuildScreenField: function () {
                if (!this._map || !this._field) return;
                const size = this._map.getSize();
                if (size.x < 20 || size.y < 20) return;
                const columns = FIELD_COLUMNS;
                const rows = FIELD_ROWS;
                const total = columns * rows;
                const east = new Float32Array(total);
                const down = new Float32Array(total);
                const speeds = new Float32Array(total);
                const valid = new Uint8Array(total);
                const sampleResult = { east: 0, north: 0, speed: 0 };
                const zoom = this._map.getZoom();
                const project = (lat, lon) => this._map.project([lat, lon], zoom);

                for (let row = 0; row < rows; row += 1) {
                    const y = (row + 0.5) / rows * size.y;
                    for (let column = 0; column < columns; column += 1) {
                        const x = (column + 0.5) / columns * size.x;
                        const latLng = this._map.containerPointToLatLng([x, y]);
                        const index = row * columns + column;
                        if (!sample(this._field, latLng.lat, latLng.lng, sampleResult)) continue;

                        const delta = 0.02;
                        const eastA = project(latLng.lat, latLng.lng);
                        const eastB = project(latLng.lat, latLng.lng + delta);
                        const northA = project(latLng.lat, latLng.lng);
                        const northB = project(Math.min(85, latLng.lat + delta), latLng.lng);
                        const eastPixelsPerKm = Math.max(0.0001, Math.abs(eastB.x - eastA.x) /
                            (delta * KM_PER_DEGREE * Math.max(0.1, Math.cos(latLng.lat * Math.PI / 180))));
                        const northPixelsPerKm = Math.max(0.0001, Math.abs(northB.y - northA.y) / (delta * KM_PER_DEGREE));
                        east[index] = sampleResult.east * eastPixelsPerKm;
                        // Screen y increases downwards, so northward movement
                        // is the negative of the geographic north vector.
                        down[index] = -sampleResult.north * northPixelsPerKm;
                        speeds[index] = sampleResult.speed;
                        valid[index] = 1;
                    }
                }
                this._screenField = { columns, rows, width: size.x, height: size.y, east, down, speeds, valid };
            },

            _sampleScreen: function (x, y, out) {
                const field = this._screenField;
                if (!field || x < 0 || y < 0 || x >= field.width || y >= field.height) return false;
                const gx = x / field.width * (field.columns - 1);
                const gy = y / field.height * (field.rows - 1);
                const x0 = Math.floor(gx);
                const y0 = Math.floor(gy);
                const x1 = Math.min(x0 + 1, field.columns - 1);
                const y1 = Math.min(y0 + 1, field.rows - 1);
                const tx = gx - x0;
                const ty = gy - y0;
                const i00 = y0 * field.columns + x0;
                const i10 = y0 * field.columns + x1;
                const i01 = y1 * field.columns + x0;
                const i11 = y1 * field.columns + x1;
                const w00 = (1 - tx) * (1 - ty);
                const w10 = tx * (1 - ty);
                const w01 = (1 - tx) * ty;
                const w11 = tx * ty;
                let weight = 0;
                out.east = 0;
                out.down = 0;
                out.speed = 0;
                if (field.valid[i00]) { out.east += field.east[i00] * w00; out.down += field.down[i00] * w00; out.speed += field.speeds[i00] * w00; weight += w00; }
                if (field.valid[i10]) { out.east += field.east[i10] * w10; out.down += field.down[i10] * w10; out.speed += field.speeds[i10] * w10; weight += w10; }
                if (field.valid[i01]) { out.east += field.east[i01] * w01; out.down += field.down[i01] * w01; out.speed += field.speeds[i01] * w01; weight += w01; }
                if (field.valid[i11]) { out.east += field.east[i11] * w11; out.down += field.down[i11] * w11; out.speed += field.speeds[i11] * w11; weight += w11; }
                if (!weight) return false;
                out.east /= weight;
                out.down /= weight;
                out.speed /= weight;
                return true;
            },

            _resetParticles: function (randomAge) {
                if (!this._map) return;
                const size = this._map.getSize();
                const total = this._particleTotal || particleCount(size.x, size.y);
                while (this._particles.length < total) this._particles.push({ x: 0, y: 0, age: 0, maxAge: 0, speed: 0 });
                this._particles.length = total;
                for (let index = 0; index < total; index += 1) {
                    const particle = this._particles[index];
                    particle.x = Math.random() * size.x;
                    particle.y = Math.random() * size.y;
                    particle.age = randomAge ? Math.random() * 50 : 0;
                    particle.maxAge = 45 + Math.random() * 90;
                    particle.speed = 0;
                }
            },

            _clearCanvas: function () {
                if (!this._map) return;
                context.save();
                context.setTransform(1, 0, 0, 1, 0, 0);
                context.clearRect(0, 0, canvas.width, canvas.height);
                context.restore();
            },

            _isVisible: function () {
                if (!this._map || document.visibilityState === 'hidden') return false;
                const rect = container.getBoundingClientRect();
                return rect.width > 20 && rect.height > 20;
            },

            _stopFrame: function () {
                if (this._frame) cancelAnimationFrame(this._frame);
                this._frame = 0;
            },

            _resume: function () {
                if (!this._running) this._running = true;
                if (this._paused || this._interacting || !this._field || !this._isVisible() || this._frame) return;
                this._lastTime = performance.now();
                this._frame = requestAnimationFrame((time) => this._tick(time));
            },

            _tick: function (time) {
                this._frame = 0;
                if (!this._running || this._paused || this._interacting || !this._field || !this._isVisible()) return;
                const delta = Math.min(MAX_FRAME_DELTA, Math.max(0.001, (time - this._lastTime) / 1000));
                this._lastTime = time;
                this._draw(delta);
                this._frame = requestAnimationFrame((nextTime) => this._tick(nextTime));
            },

            _draw: function (delta) {
                const size = this._map.getSize();
                const palette = window.AirSensePalettes;
                const sampleResult = { east: 0, down: 0, speed: 0 };
                const fade = Math.min(0.24, Math.max(0.08, delta * 5.5));
                context.globalCompositeOperation = 'destination-out';
                context.globalAlpha = fade;
                context.fillStyle = '#000';
                context.fillRect(0, 0, size.x, size.y);
                context.globalCompositeOperation = 'source-over';
                context.lineCap = 'round';
                context.globalAlpha = Math.max(0.15, Math.min(1, this._opacity ?? 0.9));

                for (let index = 0; index < this._particles.length; index += 1) {
                    const particle = this._particles[index];
                    const oldX = particle.x;
                    const oldY = particle.y;
                    if (!this._sampleScreen(oldX, oldY, sampleResult) || sampleResult.speed < MIN_SPEED_KMH) {
                        particle.x = Math.random() * size.x;
                        particle.y = Math.random() * size.y;
                        particle.age = 0;
                        continue;
                    }

                    // The screen field contains local projection scale. This
                    // multiplier converts km/h into readable pixels per frame.
                    const motionScale = 0.19 * delta;
                    particle.x += sampleResult.east * motionScale;
                    particle.y += sampleResult.down * motionScale;
                    particle.speed = sampleResult.speed;
                    particle.age += delta * 60;

                    if (particle.age > particle.maxAge || particle.x < -4 || particle.x > size.x + 4 || particle.y < -4 || particle.y > size.y + 4) {
                        particle.x = Math.random() * size.x;
                        particle.y = Math.random() * size.y;
                        particle.age = 0;
                        continue;
                    }

                    const color = palette?.colorFor?.('wind', particle.speed);
                    context.strokeStyle = color ? `rgb(${color[0]}, ${color[1]}, ${color[2]})` : 'rgb(130, 205, 255)';
                    context.lineWidth = 0.7 + Math.min(1.15, particle.speed / 45);
                    context.beginPath();
                    context.moveTo(oldX, oldY);
                    context.lineTo(particle.x, particle.y);
                    context.stroke();
                }
                context.globalAlpha = 1;
            }
        });

        return new layer();
    }

    window.AirSenseWindRenderer = { createLayer, buildField };
})();
