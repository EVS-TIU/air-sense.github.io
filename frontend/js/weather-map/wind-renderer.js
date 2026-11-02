/* ==========================================================================
   AirSense — geographic wind particle renderer
   ========================================================================== */
(function () {
    'use strict';

    const PAUSE_EVENTS = ['weatherly:map-modal-close'];
    const MIN_PARTICLES = 700;
    const MAX_PARTICLES = 14000;

    function ensureWeatherPane(map) {
        let pane = map.getPane('weatherPane');
        if (!pane) {
            pane = map.createPane('weatherPane');
            pane.style.zIndex = '350';
            pane.style.pointerEvents = 'none';
        }
        return pane;
    }

    function buildField(payload) {
        const segment = payload?.segments?.[0];
        if (!segment) return null;
        const speedGrid = segment.values?.wind_speed_10m;
        const dirGrid = segment.values?.wind_direction_10m;
        if (!Array.isArray(speedGrid) || !Array.isArray(dirGrid)) return null;
        const rows = Number(segment.rows);
        const columns = Number(segment.columns);
        const [west, south, east, north] = segment.bbox;
        if (!(rows > 1 && columns > 1) || ![west, south, east, north].every(Number.isFinite)) return null;

        const speeds = new Float32Array(rows * columns);
        const dirs = new Float32Array(rows * columns);
        let maxSpeed = 0;
        for (let row = 0; row < rows; row += 1) {
            for (let column = 0; column < columns; column += 1) {
                const index = row * columns + column;
                const speed = Number(speedGrid[row]?.[column]);
                const direction = Number(dirGrid[row]?.[column]);
                speeds[index] = Number.isFinite(speed) ? speed : 0;
                dirs[index] = Number.isFinite(direction) ? direction : 0;
                maxSpeed = Math.max(maxSpeed, speeds[index]);
            }
        }
        return { speeds, dirs, rows, columns, west, south, east, north, maxSpeed: maxSpeed || 1 };
    }

    function wrapLongitude(lon) {
        return ((lon + 180) % 360 + 360) % 360 - 180;
    }

    function sample(field, lat, lon) {
        if (!field) return { u: 0, v: 0, speed: 0 };
        const wrappedLon = wrapLongitude(lon);
        const clampedLat = Math.max(field.south, Math.min(field.north, lat));
        const x = ((wrappedLon - field.west) / ((field.east - field.west) || 1)) * (field.columns - 1);
        const y = ((field.north - clampedLat) / ((field.north - field.south) || 1)) * (field.rows - 1);
        if (x < 0 || x > field.columns - 1 || y < 0 || y > field.rows - 1) return { u: 0, v: 0, speed: 0 };

        const x0 = Math.floor(x);
        const y0 = Math.floor(y);
        const x1 = Math.min(x0 + 1, field.columns - 1);
        const y1 = Math.min(y0 + 1, field.rows - 1);
        const tx = x - x0;
        const ty = y - y0;
        const read = (gx, gy) => ({
            speed: field.speeds[gy * field.columns + gx],
            direction: field.dirs[gy * field.columns + gx]
        });
        const values = [
            [read(x0, y0), (1 - tx) * (1 - ty)],
            [read(x1, y0), tx * (1 - ty)],
            [read(x0, y1), (1 - tx) * ty],
            [read(x1, y1), tx * ty]
        ];
        let speed = 0;
        let u = 0;
        let v = 0;
        values.forEach(([value, amount]) => {
            speed += value.speed * amount;
            const radians = value.direction * Math.PI / 180;
            // Meteorological direction is where wind comes from.
            u += -value.speed * Math.sin(radians) * amount;
            v += -value.speed * Math.cos(radians) * amount;
        });
        return { u, v, speed };
    }

    function deviceQuality() {
        const memory = Number(navigator.deviceMemory || 4);
        const cores = Number(navigator.hardwareConcurrency || 4);
        if (memory <= 2 || cores <= 2) return 0.45;
        if (memory <= 4 || cores <= 4) return 0.7;
        return 1;
    }

    function createLayer(map) {
        const L = window.L;
        ensureWeatherPane(map);
        const container = L.DomUtil.create('div', 'airsense-wind-layer');
        Object.assign(container.style, { position: 'absolute', top: '0', left: '0', width: '100%', height: '100%', pointerEvents: 'none' });
        const thermalCanvas = L.DomUtil.create('canvas', 'airsense-wind-thermal-canvas');
        const canvas = L.DomUtil.create('canvas', 'airsense-wind-canvas');
        container.appendChild(thermalCanvas);
        container.appendChild(canvas);
        const thermalContext = thermalCanvas.getContext('2d', { alpha: true, desynchronized: true });
        const context = canvas.getContext('2d', { alpha: true, desynchronized: true });
        const baseQuality = deviceQuality();

        const layer = L.Layer.extend({
            onAdd: function (parentMap) {
                this._map = parentMap;
                parentMap.getPane('weatherPane').appendChild(container);
                this._particles = [];
                this._field = null;
                this._running = true;
                this._paused = false;
                this._interacting = false;
                this._quality = baseQuality;
                this._opacity = 0.9;
                this._resize();
                this._bindEvents();
                this._resizeObserver = typeof ResizeObserver === 'function' ? new ResizeObserver(() => this._resize()) : null;
                this._resizeObserver?.observe(container);
                this._start();
            },
            onRemove: function () {
                this._running = false;
                if (this._frame) cancelAnimationFrame(this._frame);
                this._unbindEvents();
                this._resizeObserver?.disconnect();
                if (container.parentNode) container.parentNode.removeChild(container);
                this._particles.length = 0;
                this._field = null;
            },
            _bindEvents: function () {
                this._map.on('resize', this._resize, this);
                this._map.on('movestart zoomstart dragstart', this._interactionStart, this);
                this._map.on('moveend zoomend dragend', this._interactionEnd, this);
                document.addEventListener('visibilitychange', this._handleVisibility = () => { this._paused = document.hidden; });
                PAUSE_EVENTS.forEach((event) => document.addEventListener(event, this._handleVisibility));
            },
            _unbindEvents: function () {
                this._map.off('resize', this._resize, this);
                this._map.off('movestart zoomstart dragstart', this._interactionStart, this);
                this._map.off('moveend zoomend dragend', this._interactionEnd, this);
                document.removeEventListener('visibilitychange', this._handleVisibility);
                PAUSE_EVENTS.forEach((event) => document.removeEventListener(event, this._handleVisibility));
            },
            _interactionStart: function () { this._interacting = true; this._quality = Math.min(this._quality, 0.35); },
            _interactionEnd: function () { this._interacting = false; this._quality = Math.max(this._quality, baseQuality); this._renderThermal(); this._reprojectTrails(); },
            _resize: function () {
                if (!this._map) return;
                const size = this._map.getSize();
                const dpr = Math.min(window.devicePixelRatio || 1, 2);
                canvas.width = Math.max(1, Math.floor(size.x * dpr));
                canvas.height = Math.max(1, Math.floor(size.y * dpr));
                thermalCanvas.width = canvas.width;
                thermalCanvas.height = canvas.height;
                canvas.style.width = `${size.x}px`;
                canvas.style.height = `${size.y}px`;
                thermalCanvas.style.width = `${size.x}px`;
                thermalCanvas.style.height = `${size.y}px`;
                thermalContext.setTransform(dpr, 0, 0, dpr, 0, 0);
                context.setTransform(dpr, 0, 0, dpr, 0, 0);
                this._renderThermal();
                this._reprojectTrails();
                this._fitParticlePool();
            },
            _particleTarget: function () {
                const size = this._map.getSize();
                return Math.max(MIN_PARTICLES, Math.min(MAX_PARTICLES, Math.round(size.x * size.y / 260 * this._quality)));
            },
            _randomPosition: function () {
                const bounds = this._map.getBounds();
                const south = Math.max(-85, bounds.getSouth());
                const north = Math.min(85, bounds.getNorth());
                return { lat: south + Math.random() * Math.max(0.01, north - south), lon: bounds.getWest() + Math.random() * (bounds.getEast() - bounds.getWest()) };
            },
            _newParticle: function () {
                const position = this._randomPosition();
                return { lat: position.lat, lon: position.lon, age: Math.random() * 120, maxAge: 100 + Math.random() * 160, trail: [] };
            },
            _fitParticlePool: function () {
                const target = this._particleTarget();
                while (this._particles.length < target) this._particles.push(this._newParticle());
                if (this._particles.length > target) this._particles.length = target;
                this._reprojectTrails();
            },
            _reprojectTrails: function () {
                if (!this._map) return;
                this._particles.forEach((particle) => {
                    const point = this._map.latLngToContainerPoint([particle.lat, particle.lon]);
                    particle.trail = [{ x: point.x, y: point.y }];
                });
            },
            _renderThermal: function () {
                if (!this._map || !this._field) return;
                const size = this._map.getSize();
                thermalContext.clearRect(0, 0, size.x, size.y);
                thermalContext.globalAlpha = Math.min(0.72, this._opacity * 0.7);
                thermalContext.globalCompositeOperation = 'source-over';
                thermalContext.filter = 'blur(5px)';

                // A coarse, interpolated screen-space field keeps the thermal
                // pass cheap while the browser smooths the colour transitions.
                // Every sample is taken from the real Open-Meteo speed grid.
                const columns = Math.min(96, Math.max(24, Math.ceil(size.x / 18)));
                const rows = Math.min(54, Math.max(14, Math.ceil(size.y / 18)));
                const bounds = this._map.getBounds();
                const west = bounds.getWest();
                const east = bounds.getEast();
                const south = Math.max(-85, bounds.getSouth());
                const north = Math.min(85, bounds.getNorth());
                const colorFor = window.AirSensePalettes?.colorFor;
                if (typeof colorFor !== 'function') return;

                for (let row = 0; row < rows; row += 1) {
                    const lat0 = south + (north - south) * row / rows;
                    const lat1 = south + (north - south) * (row + 1) / rows;
                    for (let column = 0; column < columns; column += 1) {
                        const lon0 = west + (east - west) * column / columns;
                        const lon1 = west + (east - west) * (column + 1) / columns;
                        const value = sample(this._field, (lat0 + lat1) / 2, (lon0 + lon1) / 2).speed;
                        const color = colorFor('wind', value);
                        if (!color) continue;
                        const topLeft = this._map.latLngToContainerPoint([lat1, lon0]);
                        const topRight = this._map.latLngToContainerPoint([lat1, lon1]);
                        const bottomRight = this._map.latLngToContainerPoint([lat0, lon1]);
                        const bottomLeft = this._map.latLngToContainerPoint([lat0, lon0]);
                        thermalContext.fillStyle = `rgb(${color[0]}, ${color[1]}, ${color[2]})`;
                        thermalContext.beginPath();
                        thermalContext.moveTo(topLeft.x, topLeft.y);
                        thermalContext.lineTo(topRight.x, topRight.y);
                        thermalContext.lineTo(bottomRight.x, bottomRight.y);
                        thermalContext.lineTo(bottomLeft.x, bottomLeft.y);
                        thermalContext.closePath();
                        thermalContext.fill();
                    }
                }
                thermalContext.filter = 'none';
                thermalContext.globalAlpha = 1;
            },
            _respawn: function (particle) {
                const position = this._randomPosition();
                particle.lat = position.lat;
                particle.lon = position.lon;
                particle.age = 0;
                particle.maxAge = 100 + Math.random() * 160;
                particle.trail.length = 0;
            },
            setData: function (payload) {
                this._field = buildField(payload);
                if (!this._field) return;
                this._renderThermal();
                this._fitParticlePool();
                this._particles.forEach((particle) => { particle.age = Math.random() * particle.maxAge; });
            },
            setOpacity: function (value) {
                this._opacity = Math.max(0, Math.min(1, Number(value)));
                this._renderThermal();
            },
            _start: function () {
                const tick = () => {
                    if (!this._running) return;
                    this._frame = requestAnimationFrame(tick);
                    if (this._paused || !this._field) return;
                    this._draw();
                };
                this._frame = requestAnimationFrame(tick);
            },
            _draw: function () {
                const size = this._map.getSize();
                context.globalCompositeOperation = 'destination-in';
                context.fillStyle = `rgba(0, 0, 0, ${this._interacting ? 0.76 : 0.9})`;
                context.fillRect(0, 0, size.x, size.y);
                context.globalCompositeOperation = 'source-over';
                context.lineCap = 'round';
                context.lineJoin = 'round';
                context.lineWidth = this._interacting ? 0.55 : 0.8;
                context.globalAlpha = this._opacity;
                const stepScale = this._interacting ? 0.00012 : 0.00024;

                this._particles.forEach((particle) => {
                    const wind = sample(this._field, particle.lat, particle.lon);
                    if (wind.speed < 0.2) { this._respawn(particle); return; }
                    const latitudeScale = Math.max(0.35, Math.cos(particle.lat * Math.PI / 180));
                    particle.lon = wrapLongitude(particle.lon + wind.u * stepScale / latitudeScale);
                    particle.lat = Math.max(-85, Math.min(85, particle.lat + wind.v * stepScale));
                    const point = this._map.latLngToContainerPoint([particle.lat, particle.lon]);
                    particle.trail.push({ x: point.x, y: point.y });
                    if (particle.trail.length > (this._interacting ? 8 : 26)) particle.trail.shift();
                    if (particle.age > particle.maxAge || point.x < -80 || point.x > size.x + 80 || point.y < -80 || point.y > size.y + 80) { this._respawn(particle); return; }

                    context.strokeStyle = wind.speed > 24 ? 'rgba(195, 241, 255, 0.84)' : 'rgba(220, 247, 255, 0.7)';
                    context.beginPath();
                    particle.trail.forEach((trailPoint, index) => index ? context.lineTo(trailPoint.x, trailPoint.y) : context.moveTo(trailPoint.x, trailPoint.y));
                    context.stroke();
                    particle.age += 1 + Math.min(2, wind.speed / 25);
                });
            }
        });
        return new layer();
    }

    window.AirSenseWindRenderer = { createLayer, buildField };
})();
