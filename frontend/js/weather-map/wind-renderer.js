/* ==========================================================================
   AirSense — static geographic wind renderer
   --------------------------------------------------------------------------
   The animated particle flow (up to ~14k particles redrawn every frame on a
   second blur-filtered canvas) crashed low-memory devices, so the layer is
   now fully static: the Open-Meteo wind-speed grid is painted once per view
   change and never animates. There is no requestAnimationFrame loop at all.
   ========================================================================== */
(function () {
    'use strict';

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

    function createLayer(map) {
        const L = window.L;
        ensureWeatherPane(map);
        const container = L.DomUtil.create('div', 'airsense-wind-layer');
        Object.assign(container.style, { position: 'absolute', top: '0', left: '0', width: '100%', height: '100%', pointerEvents: 'none' });
        const canvas = L.DomUtil.create('canvas', 'airsense-wind-thermal-canvas');
        container.appendChild(canvas);
        const context = canvas.getContext('2d', { alpha: true, desynchronized: true });

        const layer = L.Layer.extend({
            onAdd: function (parentMap) {
                this._map = parentMap;
                parentMap.getPane('weatherPane').appendChild(container);
                this._field = null;
                this._opacity = 0.9;
                this._resize();
                this._bindEvents();
                this._resizeObserver = typeof ResizeObserver === 'function' ? new ResizeObserver(() => this._resize()) : null;
                this._resizeObserver?.observe(container);
            },
            onRemove: function () {
                this._unbindEvents();
                this._resizeObserver?.disconnect();
                if (container.parentNode) container.parentNode.removeChild(container);
                this._field = null;
            },
            _bindEvents: function () {
                this._map.on('resize', this._resize, this);
                this._map.on('moveend zoomend', this._renderThermal, this);
            },
            _unbindEvents: function () {
                this._map.off('resize', this._resize, this);
                this._map.off('moveend zoomend', this._renderThermal, this);
            },
            _resize: function () {
                if (!this._map) return;
                const size = this._map.getSize();
                const dpr = Math.min(window.devicePixelRatio || 1, 2);
                canvas.width = Math.max(1, Math.floor(size.x * dpr));
                canvas.height = Math.max(1, Math.floor(size.y * dpr));
                canvas.style.width = `${size.x}px`;
                canvas.style.height = `${size.y}px`;
                context.setTransform(dpr, 0, 0, dpr, 0, 0);
                this._renderThermal();
            },
            _renderThermal: function () {
                if (!this._map || !this._field) return;
                const size = this._map.getSize();
                context.clearRect(0, 0, size.x, size.y);
                context.globalAlpha = Math.min(0.72, this._opacity * 0.7);
                context.globalCompositeOperation = 'source-over';

                // A coarse, interpolated screen-space field keeps the paint
                // cheap while the browser smooths the colour transitions.
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
                        context.fillStyle = `rgb(${color[0]}, ${color[1]}, ${color[2]})`;
                        context.beginPath();
                        context.moveTo(topLeft.x, topLeft.y);
                        context.lineTo(topRight.x, topRight.y);
                        context.lineTo(bottomRight.x, bottomRight.y);
                        context.lineTo(bottomLeft.x, bottomLeft.y);
                        context.closePath();
                        context.fill();
                    }
                }
                context.globalAlpha = 1;
            },
            setData: function (payload) {
                this._field = buildField(payload);
                if (!this._field) return;
                this._renderThermal();
            },
            setOpacity: function (value) {
                this._opacity = Math.max(0, Math.min(1, Number(value)));
                this._renderThermal();
            }
        });
        return new layer();
    }

    window.AirSenseWindRenderer = { createLayer, buildField };
})();
