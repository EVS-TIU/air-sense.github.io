/* ==========================================================================
   AirSense — wind particle field
   Renders animated particles driven by wind_speed_10m and wind_direction_10m
   with streamlines, reduced-motion support, and automatic pause/resume.
   ========================================================================== */
(function () {
    'use strict';

    const PAUSE_EVENTS = ['weatherly:map-modal-close'];

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

        const rows = segment.rows;
        const columns = segment.columns;
        const [west, south, east, north] = segment.bbox;
        const lonStep = (segment.longitudes?.[1] - segment.longitudes?.[0]) || 0;
        const latStep = (segment.latitudes?.[1] - segment.latitudes?.[0]) || 0;

        const speeds = new Float32Array(rows * columns);
        const dirs = new Float32Array(rows * columns);
        let maxSpeed = 0;

        for (let row = 0; row < rows; row += 1) {
            for (let column = 0; column < columns; column += 1) {
                const index = row * columns + column;
                const speed = speedGrid[row]?.[column];
                const direction = dirGrid?.[row]?.[column];
                const numericSpeed = (speed === null || speed === undefined || !Number.isFinite(Number(speed)))
                    ? 0 : Number(speed);
                speeds[index] = numericSpeed;
                if (numericSpeed > maxSpeed) maxSpeed = numericSpeed;
                dirs[index] = (direction === null || direction === undefined || !Number.isFinite(Number(direction)))
                    ? 0 : Number(direction);
            }
        }

        return {
            segment,
            speeds,
            dirs,
            rows,
            columns,
            west,
            south,
            east,
            north,
            lonStep,
            latStep,
            maxSpeed
        };
    }

    function sample(field, lat, lon) {
        if (!field) return { u: 0, v: 0, speed: 0 };
        const lonRatio = (lon - field.west) / ((field.east - field.west) || 1);
        const latRatio = (field.north - lat) / ((field.north - field.south) || 1);
        const column = lonRatio * (field.columns - 1);
        const row = latRatio * (field.rows - 1);
        if (column < 0 || column >= field.columns || row < 0 || row >= field.rows) {
            return { u: 0, v: 0, speed: 0 };
        }

        const x0 = Math.floor(column);
        const y0 = Math.floor(row);
        const x1 = Math.min(x0 + 1, field.columns - 1);
        const y1 = Math.min(y0 + 1, field.rows - 1);
        const tx = column - x0;
        const ty = row - y0;

        function read(gx, gy) {
            return field.speeds[gy * field.columns + gx];
        }

        function readDir(gx, gy) {
            return field.dirs[gy * field.columns + gx];
        }

        const speed = (
            read(x0, y0) * (1 - tx) * (1 - ty) +
            read(x1, y0) * tx * (1 - ty) +
            read(x0, y1) * (1 - tx) * ty +
            read(x1, y1) * tx * ty
        );
        const weights = [
            [readDir(x0, y0), (1 - tx) * (1 - ty)],
            [readDir(x1, y0), tx * (1 - ty)],
            [readDir(x0, y1), (1 - tx) * ty],
            [readDir(x1, y1), tx * ty]
        ];
        const directionVector = weights.reduce((vector, [degrees, weight]) => {
            const radians = (degrees * Math.PI) / 180;
            vector.x += Math.sin(radians) * weight;
            vector.y += Math.cos(radians) * weight;
            return vector;
        }, { x: 0, y: 0 });
        const direction = (Math.atan2(directionVector.x, directionVector.y) * 180 / Math.PI + 360) % 360;

        const radians = (direction * Math.PI) / 180;
        return {
            u: -speed * Math.sin(radians),
            v: -speed * Math.cos(radians),
            speed
        };
    }

    function createLayer(map) {
        const L = window.L;
        ensureWeatherPane(map);
        const container = L.DomUtil.create('div', 'airsense-wind-layer');
        container.style.position = 'absolute';
        container.style.top = '0';
        container.style.left = '0';
        container.style.width = '100%';
        container.style.height = '100%';
        container.style.pointerEvents = 'none';

        const canvas = L.DomUtil.create('canvas', 'airsense-wind-canvas');
        canvas.width = 256;
        canvas.height = 256;
        container.appendChild(canvas);
        const context = canvas.getContext('2d');

        const layer = L.Layer.extend({
            onAdd: function (parentMap) {
                this._map = parentMap;
                parentMap.getPane('weatherPane').appendChild(container);
                this._particles = [];
                this._paused = false;
                this._reducedMotion = window.matchMedia &&
                    window.matchMedia('(prefers-reduced-motion: reduce)').matches;
                this._resize();
                this._map.on('resize move zoom', this._resize, this);
                this._handleVisibility = () => {
                    this._paused = document.hidden;
                };
                document.addEventListener('visibilitychange', this._handleVisibility);
                PAUSE_EVENTS.forEach((event) => {
                    document.addEventListener(event, this._handleVisibility);
                });
                this._start();
            },
            onRemove: function () {
                this._running = false;
                if (this._frame) cancelAnimationFrame(this._frame);
                this._map.off('resize move zoom', this._resize, this);
                document.removeEventListener('visibilitychange', this._handleVisibility);
                PAUSE_EVENTS.forEach((event) => {
                    document.removeEventListener(event, this._handleVisibility);
                });
                if (container.parentNode) container.parentNode.removeChild(container);
                this._particles = [];
            },
            setData: function (payload) {
                this._field = buildField(payload);
                this._staticDrawn = false;
                this._respawn(true);
            },
            setOpacity: function (value) {
                this._opacity = Math.max(0, Math.min(1, Number(value)));
            },
            _resize: function () {
                const size = this._map.getSize();
                const dpr = Math.min(window.devicePixelRatio || 1, 2);
                canvas.width = Math.max(1, Math.floor(size.x * dpr));
                canvas.height = Math.max(1, Math.floor(size.y * dpr));
                canvas.style.width = size.x + 'px';
                canvas.style.height = size.y + 'px';
                context.setTransform(dpr, 0, 0, dpr, 0, 0);
                this._staticDrawn = false;
            },
            _respawn: function (reset) {
                const size = this._map.getSize();
                const count = Math.min(1100, Math.max(320, Math.round((size.x * size.y) / 9000)));
                this._particles = [];
                for (let index = 0; index < count; index += 1) {
                    this._particles.push({
                        x: Math.random() * size.x,
                        y: Math.random() * size.y,
                        age: reset ? Math.random() * 80 : Math.random() * 40,
                        maxAge: 60 + Math.random() * 60
                    });
                }
            },
            _start: function () {
                this._running = true;
                const tick = () => {
                    if (!this._running) return;
                    this._frame = requestAnimationFrame(tick);
                    if (this._paused || !this._field) {
                        return;
                    }
                    if (this._reducedMotion) {
                        if (!this._staticDrawn) {
                            this._drawStatic();
                            this._staticDrawn = true;
                        }
                        return;
                    }
                    this._draw();
                };
                tick();
            },
            _drawStatic: function () {
                const size = this._map.getSize();
                context.clearRect(0, 0, size.x, size.y);
                const palette = window.AirSensePalettes;
                context.lineCap = 'round';
                context.globalAlpha = this._opacity ?? 0.9;
                for (let index = 0; index < 60; index += 1) {
                    const lat = this._field.south + Math.random() * (this._field.north - this._field.south);
                    const lon = this._field.west + Math.random() * (this._field.east - this._field.west);
                    const point = this._map.latLngToContainerPoint(L.latLng(lat, lon));
                    const windSample = sample(this._field, lat, lon);
                    if (windSample.speed < 2) continue;
                    const color = palette.colorFor('wind', windSample.speed);
                    context.strokeStyle = color
                        ? `rgba(${color[0]}, ${color[1]}, ${color[2]}, 0.7)`
                        : 'rgba(150, 210, 255, 0.7)';
                    context.lineWidth = 1.5;
                    context.beginPath();
                    context.moveTo(point.x, point.y);
                    context.lineTo(point.x + windSample.u * 0.7, point.y - windSample.v * 0.7);
                    context.stroke();
                }
            },
            _draw: function () {
                const size = this._map.getSize();
                // Fade only existing particle trails; never paint over the map.
                context.globalCompositeOperation = 'destination-in';
                context.fillStyle = 'rgba(0, 0, 0, 0.9)';
                context.fillRect(0, 0, size.x, size.y);
                context.globalCompositeOperation = 'source-over';
                const palette = window.AirSensePalettes;
                context.lineCap = 'round';
                context.lineJoin = 'round';
                context.globalAlpha = this._opacity ?? 0.9;

                this._particles.forEach((particle) => {
                    const point = this._map.containerPointToLatLng(L.point(particle.x, particle.y));
                    const windSample = sample(this._field, point.lat, point.lng);
                    if (windSample.speed < 0.4) {
                        particle.x = Math.random() * size.x;
                        particle.y = Math.random() * size.y;
                        particle.age = 0;
                        return;
                    }

                    const color = palette.colorFor('wind', windSample.speed);
                    context.strokeStyle = color
                        ? `rgba(${color[0]}, ${color[1]}, ${color[2]}, ${0.25 + Math.min(0.5, windSample.speed / 40)})`
                        : 'rgba(120, 200, 255, 0.4)';
                    context.lineWidth = 0.8 + Math.min(1.6, windSample.speed / 30);
                    const px = point.lng;
                    const py = point.lat;
                    const nx = this._map.latLngToContainerPoint(L.latLng(py + windSample.v * 0.0025, px + windSample.u * 0.0025));
                    context.beginPath();
                    context.moveTo(particle.x, particle.y);
                    context.lineTo(nx.x, nx.y);
                    context.stroke();
                    particle.x = nx.x;
                    particle.y = nx.y;
                    particle.age += 1;
                    if (particle.age > particle.maxAge || particle.x < 0 || particle.x > size.x || particle.y < 0 || particle.y > size.y) {
                        particle.x = Math.random() * size.x;
                        particle.y = Math.random() * size.y;
                        particle.age = 0;
                        particle.maxAge = 60 + Math.random() * 60;
                    }
                });

                if (this._reducedMotion) {
                    this._staticDrawn = false;
                }
            }
        });

        return new layer();
    }

    window.AirSenseWindRenderer = {
        createLayer,
        buildField
    };
})();
