'use strict';
/* Roof geometry and a small satellite map, with no libraries. Plan coordinates are metres: x east, y north, origin at the
   building centre. A "face" is one plane of the roof; it carries the compass direction it faces, its tilt, and the slots
   where panels can sit. */
const Roof = (() => {
  const RAD = Math.PI / 180, M_LAT = 111320;
  const toLocal = (o, lat, lon) => [(lon - o.lon) * M_LAT * Math.cos(o.lat * RAD), (lat - o.lat) * M_LAT];
  const toLatLon = (o, x, y) => [o.lat + y / M_LAT, o.lon + x / (M_LAT * Math.cos(o.lat * RAD))];
  const bearingVec = b => [Math.sin(b * RAD), Math.cos(b * RAD)]; // compass bearing (0 = north, clockwise) -> [east, north]
  const norm360 = a => ((a % 360) + 360) % 360;
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1];

  function inside(p, poly) {
    let c = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const [xi, yi] = poly[i], [xj, yj] = poly[j];
      if ((yi > p[1]) !== (yj > p[1]) && p[0] < (xj - xi) * (p[1] - yi) / (yj - yi) + xi) c = !c;
    }
    return c;
  }
  function edgeDist(p, poly) {
    let best = Infinity;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const [ax, ay] = poly[j], [bx, by] = poly[i], dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
      const t = l2 ? Math.max(0, Math.min(1, ((p[0] - ax) * dx + (p[1] - ay) * dy) / l2)) : 0;
      best = Math.min(best, Math.hypot(p[0] - ax - t * dx, p[1] - ay - t * dy));
    }
    return best;
  }
  const area = poly => Math.abs(poly.reduce((a, p, i) => { const q = poly[(i + 1) % poly.length]; return a + p[0] * q[1] - q[0] * p[1]; }, 0)) / 2;
  const centroid = poly => { // of the bounding box: robust for odd shapes
    const xs = poly.map(p => p[0]), ys = poly.map(p => p[1]);
    return [(Math.min(...xs) + Math.max(...xs)) / 2, (Math.min(...ys) + Math.max(...ys)) / 2];
  };

  // The bearing (0-180) of the long side of the smallest rectangle around the footprint: where the ridge usually runs.
  function longAxis(poly) {
    let best = null;
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i], b = poly[(i + 1) % poly.length], len = Math.hypot(b[0] - a[0], b[1] - a[1]);
      if (len < 0.5) continue;
      const u = [(b[0] - a[0]) / len, (b[1] - a[1]) / len], v = [-u[1], u[0]];
      let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
      for (const p of poly) { const pu = dot(p, u), pv = dot(p, v); u0 = Math.min(u0, pu); u1 = Math.max(u1, pu); v0 = Math.min(v0, pv); v1 = Math.max(v1, pv); }
      const ar = (u1 - u0) * (v1 - v0);
      if (!best || ar < best.ar) best = { ar, u, long: (u1 - u0) >= (v1 - v0) };
    }
    if (!best) return 90;
    const u = best.long ? best.u : [-best.u[1], best.u[0]];
    return norm360(Math.atan2(u[0], u[1]) / RAD) % 180;
  }

  const compassName = az => ['north', 'north-east', 'east', 'south-east', 'south', 'south-west', 'west', 'north-west'][Math.round(norm360(az) / 45) % 8];
  const compassShort = az => ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'][Math.round(norm360(az) / 45) % 8];

  // Row and column pitch for panels of a given size: width across the slope, height up the slope (metres).
  // Panels stay this far inside every wall line, ridge and hip: the usual 0.3-0.4 m edge clearance, less the eaves overhang.
  const SETBACK = 0.25, GAP = 0.03;

  // Where panels can go on one face. n = unit vector (plan) pointing down the slope; poly = the face outline.
  // rowPitchK > 1 spreads rows apart (frames on a flat roof need space so each row does not shade the next).
  function slots(face, foot, pw, ph, rowPitchK) {
    const n = face.n, t = [n[1], -n[0]], th = face.tilt * RAD;
    const depth = ph * Math.cos(th), pitchS = depth * rowPitchK + GAP, pitchT = pw + GAP;
    const ps = face.poly.map(p => dot(p, n)), pt = face.poly.map(p => dot(p, t));
    const sMax = Math.max(...ps) - SETBACK, tMid = (Math.min(...pt) + Math.max(...pt)) / 2, sMin = Math.min(...ps);
    const nRows = Math.max(0, Math.floor((sMax - sMin - SETBACK) / pitchS) + 1), nCols = Math.ceil((Math.max(...pt) - Math.min(...pt)) / pitchT) + 2;
    // Real outlines are never perfectly straight, and the eaves overhang the walls, so the outline itself only needs a small margin;
    // the full setback applies to the face (its ridge, hips and the box around the footprint).
    const ok = (p, poly, m) => inside(p, poly) && edgeDist(p, poly) >= m - 1e-6;
    const out = [];
    for (let r = 0; r < nRows; r++) {
      const s1 = sMax - r * pitchS, s0 = s1 - depth;
      for (let k = -nCols; k <= nCols; k++) {
        const t0 = tMid - pw / 2 + k * pitchT, t1 = t0 + pw;
        const xy = (s, tt) => [n[0] * s + t[0] * tt, n[1] * s + t[1] * tt];
        const corners = [xy(s0, t0), xy(s0, t1), xy(s1, t1), xy(s1, t0)];
        const pts = [...corners, xy((s0 + s1) / 2, t0), xy((s0 + s1) / 2, t1), xy(s0, (t0 + t1) / 2), xy(s1, (t0 + t1) / 2), xy((s0 + s1) / 2, (t0 + t1) / 2)];
        if (pts.every(p => ok(p, face.poly, SETBACK) && ok(p, foot, 0.1))) out.push({ corners, row: r, off: Math.abs(k) + (k < 0 ? 0.1 : 0) });
      }
    }
    out.sort((a, b) => a.row - b.row || a.off - b.off); // fill the eave row first, centred, then the rows above it
    return out;
  }

  /* Build the faces of a roof.
     foot: footprint polygon (plan metres). o: { type: gable|hip|mono|flat, ridge: bearing of the ridge (0-180), pitch, flat: south|ew,
     mono: compass direction the slope faces, panelW (watts), portrait: bool }. */
  function build(foot, o) {
    const pw = o.portrait ? 1.134 : (o.panelW / 225) / 1.134, ph = o.portrait ? (o.panelW / 225) / 1.134 : 1.134;
    const b = o.ridge, u = bearingVec(b), v = bearingVec(b + 90);
    const U = foot.map(p => dot(p, u)), V = foot.map(p => dot(p, v));
    const u0 = Math.min(...U), u1 = Math.max(...U), v0 = Math.min(...V), v1 = Math.max(...V), uc = (u0 + u1) / 2, vc = (v0 + v1) / 2;
    const xy = (a, c) => [u[0] * a + v[0] * c, u[1] * a + v[1] * c];
    const faces = [];
    const add = (poly, az, tilt, extra) => {
      const n = bearingVec(az), f = Object.assign({ poly, az: norm360(az), n, tilt, geom: 1, rowK: 1 }, extra);
      f.slots = slots(f, foot, pw, ph, f.rowK); f.cap = f.slots.length; faces.push(f);
    };
    if (o.type === 'gable' || (o.type === 'flat' && o.flat === 'ew')) {
      const ew = o.type === 'flat';
      add([xy(u0, vc), xy(u1, vc), xy(u1, v1), xy(u0, v1)], b + 90, o.pitch, ew ? { geom: 0.97 } : {});
      add([xy(u0, v0), xy(u1, v0), xy(u1, vc), xy(u0, vc)], b - 90, o.pitch, ew ? { geom: 0.97 } : {});
    } else if (o.type === 'hip') {
      const R = Math.max(0, (u1 - u0 - (v1 - v0)) / 2);
      add([xy(uc - R, vc), xy(uc + R, vc), xy(u1, v1), xy(u0, v1)], b + 90, o.pitch);
      add([xy(u0, v0), xy(u1, v0), xy(uc + R, vc), xy(uc - R, vc)], b - 90, o.pitch);
      add([xy(uc + R, vc), xy(u1, v1), xy(u1, v0)], b, o.pitch);
      add([xy(uc - R, vc), xy(u0, v0), xy(u0, v1)], b + 180, o.pitch);
    } else if (o.type === 'mono') {
      add(foot, o.mono, o.pitch);
    } else { // flat roof, frames facing south; rows spaced so that the winter sun at ~20 degrees clears the row in front
      const th = o.pitch * RAD;
      add(foot, 180, o.pitch, { geom: 0.96, rowK: 1 + Math.sin(th) / Math.tan(20 * RAD) / Math.cos(th) });
    }
    return faces;
  }

  // A rectangle to use when no outline is available.
  function rect(w, d) { return [[-w / 2, -d / 2], [w / 2, -d / 2], [w / 2, d / 2], [-w / 2, d / 2]]; }

  return { RAD, edgeDist, toLocal, toLatLon, inside, area, centroid, longAxis, build, rect, compassName, compassShort, norm360, bearingVec };
})();

/* A slippy map on web-mercator tiles with an SVG layer on top. */
class RoofMap {
  constructor(el, opts = {}) {
    this.el = el; this.opts = opts;
    this.lat = 52; this.lon = -1.5; this.z = 19; this.style = 'sat';
    this.tiles = document.createElement('div'); this.tiles.className = 'map-tiles';
    this.svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); this.svg.setAttribute('class', 'map-svg');
    el.append(this.tiles, this.svg);
    this.layers = { buildings: [], selected: null, faces: [] };
    let drag = null, moved = false, endT;
    const at = e => { const r = el.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
    const settled = () => { clearTimeout(endT); endT = setTimeout(() => this.onMove && this.onMove(this.lat, this.lon), 500); };
    this.settled = settled;
    el.addEventListener('pointerdown', e => { if (e.target.closest('.map-ui')) return; drag = { x: e.clientX, y: e.clientY, lat: this.lat, lon: this.lon }; moved = false; el.setPointerCapture(e.pointerId); });
    el.addEventListener('pointermove', e => {
      if (!drag) { const h = this.hit(...at(e)); if (h !== this.hover) { this.hover = h; el.style.cursor = h ? 'pointer' : ''; this.drawOverlay(); } return; }
      const dx = e.clientX - drag.x, dy = e.clientY - drag.y; if (Math.abs(dx) + Math.abs(dy) > 4) moved = true;
      if (!moved) return;
      const c = this.px(drag.lat, drag.lon); [this.lat, this.lon] = this.unpx(c[0] - dx, c[1] - dy); this.draw();
    });
    el.addEventListener('pointerup', e => {
      if (drag && !moved) { // a click: pick the outline under it, or ask for the building at that spot
        const xy = at(e), h = this.hit(...xy);
        if (h) { if (this.onPick) this.onPick(h); }
        else if (this.onEmpty) { const [cx, cy] = this.px(this.lat, this.lon), [w, hh] = this.size; this.onEmpty(...this.unpx(cx + xy[0] - w / 2, cy + xy[1] - hh / 2)); }
      } // our own hit test: faint outlines are hard to hit
      else if (drag) settled();
      drag = null;
    });
    let wheelAt = 0;
    el.addEventListener('wheel', e => { e.preventDefault(); if (Date.now() - wheelAt > 200) { wheelAt = Date.now(); this.zoom(e.deltaY < 0 ? 1 : -1); } }, { passive: false });
    new ResizeObserver(() => this.draw()).observe(el);
  }
  get size() { const r = this.el.getBoundingClientRect(); return [r.width || 600, r.height || 400]; }
  scale() { return 256 * Math.pow(2, this.z); }
  px(lat, lon) { // world pixel at the current zoom
    const s = this.scale(), x = (lon + 180) / 360 * s, sin = Math.sin(lat * Math.PI / 180);
    return [x, (0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI)) * s];
  }
  unpx(x, y) { const s = this.scale(); return [Math.atan(Math.sinh(Math.PI * (1 - 2 * y / s))) * 180 / Math.PI, x / s * 360 - 180]; }
  zoom(dz) { this.z = Math.max(16, Math.min(21, Math.round(this.z + dz))); this.draw(); this.settled(); }
  view(lat, lon, z) { this.lat = lat; this.lon = lon; if (z) this.z = z; this.draw(); }
  // The building under a screen point: the smallest outline containing it, else the nearest one within 14 px.
  hit(x, y) {
    let best = null, ba = Infinity, near = null, nd = 14;
    for (const b of this.layers.buildings) {
      const pts = b.ll.map(p => this.screenLL(p[0], p[1])), a = Roof.area(pts);
      if (Roof.inside([x, y], pts)) { if (a < ba) { ba = a; best = b.id; } }
      else { const d = Roof.edgeDist([x, y], pts); if (d < nd) { nd = d; near = b.id; } }
    }
    return best !== null ? best : near;
  }
  setStyle(s) { this.style = s; this.tiles.innerHTML = ''; this.draw(); }
  // screen point of a plan coordinate (metres from the building centre `origin`)
  screen(origin, x, y) {
    const [lat, lon] = Roof.toLatLon(origin, x, y), [cx, cy] = this.px(this.lat, this.lon), [px, py] = this.px(lat, lon), [w, h] = this.size;
    return [px - cx + w / 2, py - cy + h / 2];
  }
  screenLL(lat, lon) { const [cx, cy] = this.px(this.lat, this.lon), [px, py] = this.px(lat, lon), [w, h] = this.size; return [px - cx + w / 2, py - cy + h / 2]; }
  draw() {
    const [w, h] = this.size, tz = Math.min(this.z, 19), // imagery is not available at street level beyond zoom 19, so tiles are enlarged
       k = Math.pow(2, this.z - tz), ts = 256 * k;
    const [cx, cy] = this.px(this.lat, this.lon), x0 = cx - w / 2, y0 = cy - h / 2;
    const x1 = Math.floor(x0 / ts), x2 = Math.floor((x0 + w) / ts), y1 = Math.floor(y0 / ts), y2 = Math.floor((y0 + h) / ts), max = Math.pow(2, tz);
    const want = new Set();
    for (let tx = x1; tx <= x2; tx++) for (let ty = y1; ty <= y2; ty++) {
      if (ty < 0 || ty >= max) continue;
      const wx = ((tx % max) + max) % max, key = `${this.style}/${tz}/${wx}/${ty}`; want.add(key);
      let img = this.tiles.querySelector(`[data-k="${key}"]`);
      if (!img) {
        img = new Image(); img.dataset.k = key; img.draggable = false; img.alt = '';
        img.src = this.style === 'sat'
          ? `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${tz}/${ty}/${wx}`
          : `https://tile.openstreetmap.org/${tz}/${wx}/${ty}.png`;
        img.onerror = () => { img.style.visibility = 'hidden'; };
        this.tiles.appendChild(img);
      }
      Object.assign(img.style, { left: tx * ts - x0 + 'px', top: ty * ts - y0 + 'px', width: ts + 'px', height: ts + 'px' });
    }
    [...this.tiles.children].forEach(i => { if (!want.has(i.dataset.k)) i.remove(); });
    this.drawOverlay();
  }
  // layers: { origin, buildings: [{id, ll: [[lat,lon]]}], selected: id, faces: [{poly, color, slots: [{corners}], used}] }
  setLayers(l) { Object.assign(this.layers, l); this.drawOverlay(); }
  drawOverlay() {
    const L = this.layers, [w, h] = this.size, pts = a => a.map(p => p.map(n => n.toFixed(1)).join(',')).join(' ');
    let s = '';
    for (const b of L.buildings) {
      const sel = b.id === L.selected;
      s += `<polygon points="${pts(b.ll.map(p => this.screenLL(p[0], p[1])))}" class="bld${sel ? ' sel' : ''}${b.id === this.hover ? ' hov' : ''}"/>`;
    }
    if (L.origin) for (const f of L.faces) {
      s += `<polygon points="${pts(f.poly.map(p => this.screen(L.origin, p[0], p[1])))}" fill="${f.color}" class="face"/>`;
      f.slots.forEach((sl, i) => {
        s += `<polygon points="${pts(sl.corners.map(p => this.screen(L.origin, p[0], p[1])))}" class="${i < f.used ? 'pv' : 'pv free'}"/>`;
      });
    }
    if (L.pin) { const [px, py] = this.screenLL(L.pin.lat, L.pin.lon); s += `<circle cx="${px.toFixed(1)}" cy="${py.toFixed(1)}" r="7" class="pin"/>`; }
    this.svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
    this.svg.innerHTML = s;
  }
}
