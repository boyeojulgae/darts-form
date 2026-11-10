// Soft-tip dartboard (15.5 inch) drawn in millimetres, with tap-to-place markers.
const NS = 'http://www.w3.org/2000/svg';
const ORDER = [20, 1, 18, 4, 13, 6, 10, 15, 2, 17, 3, 19, 7, 16, 8, 11, 14, 9, 12, 5];
// Radii in mm. The outer edge of the double ring is 15.5 inch across; the others were measured from a DARTSLIVE Home board photo.
export const R = { inBull: 8.5, outBull: 21.5, triIn: 109, triOut: 123.5, dblIn: 181, dblOut: 196.85 };
const VIEW = 236;
export const THROW_COLORS = ['#2a78d6', '#eb6834', '#1baf7a'];

export function classify(x, y) {
  const r = Math.hypot(x, y);
  if (r <= R.inBull) return 'D-BULL';
  if (r <= R.outBull) return 'S-BULL';
  if (r > R.dblOut) return 'OUT';
  const deg = (Math.atan2(x, y) * 180 / Math.PI + 360 + 9) % 360;
  const num = ORDER[Math.floor(deg / 18)];
  const ring = r <= R.triIn ? 'S' : r <= R.triOut ? 'T' : r <= R.dblIn ? 'S' : 'D';
  return `${ring}${num}`;
}

export function hitText(h) {
  if (!h) return '—';
  if (h.out) return '刺さらなかった';
  const name = h.label === 'D-BULL' ? 'インブル' : h.label === 'S-BULL' ? 'アウトブル' : h.label === 'OUT' ? '盤の外' : h.label.replace('S', 'シングル').replace('T', 'トリプル').replace('D', 'ダブル');
  const dx = h.x / 10, dy = h.y / 10;
  const f = (v) => (Math.round(Math.abs(v) * 10) / 10).toFixed(1);
  return `${name}（${dx >= 0 ? '右' : '左'}${f(dx)}cm・${dy >= 0 ? '上' : '下'}${f(dy)}cm）`;
}

function el(name, attrs, parent) {
  const e = document.createElementNS(NS, name);
  for (const [k, v] of Object.entries(attrs || {})) e.setAttribute(k, v);
  if (parent) parent.appendChild(e);
  return e;
}

function wedge(r0, r1, a0, a1) {
  const p = (r, a) => `${(r * Math.sin(a)).toFixed(2)} ${(-r * Math.cos(a)).toFixed(2)}`;
  return `M ${p(r0, a0)} L ${p(r1, a0)} A ${r1} ${r1} 0 0 1 ${p(r1, a1)} L ${p(r0, a1)} A ${r0} ${r0} 0 0 0 ${p(r0, a0)} Z`;
}

export function drawBoard(container) {
  const svg = el('svg', { viewBox: `${-VIEW} ${-VIEW} ${VIEW * 2} ${VIEW * 2}`, role: 'img', 'aria-label': 'ダーツボード' });
  el('circle', { r: VIEW - 2, fill: '#0c0d10' }, svg);
  const step = Math.PI / 10;
  ORDER.forEach((num, i) => {
    const a0 = (i - 0.5) * step, a1 = (i + 0.5) * step;
    const single = i % 2 === 0 ? '#1b1c20' : '#e8e3d3';
    const ring = i % 2 === 0 ? '#d8485f' : '#3f66c9';
    el('path', { d: wedge(R.outBull, R.triIn, a0, a1), fill: single }, svg);
    el('path', { d: wedge(R.triIn, R.triOut, a0, a1), fill: ring }, svg);
    el('path', { d: wedge(R.triOut, R.dblIn, a0, a1), fill: single }, svg);
    el('path', { d: wedge(R.dblIn, R.dblOut, a0, a1), fill: ring }, svg);
    const t = el('text', { x: (216 * Math.sin(i * step)).toFixed(1), y: (-216 * Math.cos(i * step)).toFixed(1), fill: '#fff', 'font-size': 26, 'font-weight': 600, 'text-anchor': 'middle', 'dominant-baseline': 'central' }, svg);
    t.textContent = num;
  });
  for (let i = 0; i < 20; i++) {
    const a = (i - 0.5) * step;
    el('line', { x1: R.outBull * Math.sin(a), y1: -R.outBull * Math.cos(a), x2: R.dblOut * Math.sin(a), y2: -R.dblOut * Math.cos(a), stroke: '#0c0d10', 'stroke-width': 1.6 }, svg);
  }
  for (const r of [R.triIn, R.triOut, R.dblIn, R.dblOut]) el('circle', { r, fill: 'none', stroke: '#0c0d10', 'stroke-width': 1.6 }, svg);
  el('circle', { r: R.outBull, fill: '#d8485f', stroke: '#0c0d10', 'stroke-width': 1.6 }, svg);
  el('circle', { r: R.inBull, fill: '#1b1c20', stroke: '#0c0d10', 'stroke-width': 1.2 }, svg);
  const marks = el('g', {}, svg);
  container.replaceChildren(svg);
  return { svg, marks };
}

export function drawHits(marks, hits, opts = {}) {
  marks.replaceChildren();
  const k = opts.scale || 1;
  const pos = hits.filter((h) => h && !h.out);
  // Darts that landed close together: shrink the markers so they do not cover each other,
  // and push each number outwards from the middle of the group.
  let gap = Infinity;
  pos.forEach((a, i) => pos.slice(i + 1).forEach((b) => { gap = Math.min(gap, Math.hypot(a.x - b.x, a.y - b.y)); }));
  const base = (opts.small ? 5 : 13) * k;
  const r = opts.small ? base : Math.max(Math.min(base, gap * 0.46), 2.2 * k);
  const cx = pos.length ? pos.reduce((a, h) => a + h.x, 0) / pos.length : 0;
  const cy = pos.length ? pos.reduce((a, h) => a + h.y, 0) / pos.length : 0;
  hits.forEach((h, i) => {
    if (!h || h.out) return;
    const g = el('g', { transform: `translate(${h.x.toFixed(1)} ${(-h.y).toFixed(1)})` }, marks);
    el('circle', { r, fill: opts.color || THROW_COLORS[i % 3], stroke: '#fff', 'stroke-width': (opts.small ? 1 : Math.min(2.5 * k, r * 0.3)), opacity: opts.small ? 0.85 : 1 }, g);
    if (!opts.small) {
      el('circle', { r: Math.min(1.6 * k, r * 0.3), fill: '#fff' }, g);
      let ux = h.x - cx, uy = -(h.y - cy);
      const n = Math.hypot(ux, uy);
      if (pos.length < 2 || n < 0.5) { ux = 0; uy = -1; } else { ux /= n; uy /= n; }
      const d = r + 12 * k;
      const t = el('text', { x: (ux * d).toFixed(1), y: (uy * d).toFixed(1), fill: '#fff', stroke: '#0c0d10', 'stroke-width': 3.2 * k, 'paint-order': 'stroke', 'font-size': 20 * k, 'font-weight': 700, 'text-anchor': 'middle', 'dominant-baseline': 'central' }, g);
      t.textContent = i + 1;
    }
  });
}

/** Zoom a static board so that the bull and all darts fill the picture. */
export function fitView(svg, marks, hits, opts = {}) {
  const pos = hits.filter((h) => h && !h.out);
  const far = pos.length ? Math.max(...pos.map((h) => Math.max(Math.abs(h.x), Math.abs(h.y)))) : VIEW;
  const half = Math.min(VIEW, Math.max(70, far + 38));
  svg.setAttribute('viewBox', `${-half} ${-half} ${half * 2} ${half * 2}`);
  drawHits(marks, hits, { ...opts, scale: half / VIEW });
  return half;
}

const MIN_HALF = 26;

/** Interactive board: tap to add the next dart, drag a marker to adjust it, pinch or use the buttons to zoom. */
export class BoardInput {
  constructor(container, max, onChange) {
    this.max = max;
    this.onChange = onChange;
    this.hits = [];
    const { svg, marks } = drawBoard(container);
    this.svg = svg;
    this.marks = marks;
    this.view = { cx: 0, cy: 0, half: VIEW }; // svg units (mm, y down)
    this.pointers = new Map();
    this.pinch = null;
    this.pending = null;
    this.blocked = false;
    this.drag = -1;
    svg.addEventListener('pointerdown', (e) => this.down(e));
    svg.addEventListener('pointermove', (e) => this.move(e));
    svg.addEventListener('pointerup', (e) => this.up(e));
    svg.addEventListener('pointercancel', (e) => this.up(e));
    svg.addEventListener('wheel', (e) => { e.preventDefault(); this.zoomAt(e.deltaY < 0 ? 0.85 : 1 / 0.85, this.toSvg(e.clientX, e.clientY)); }, { passive: false });
  }

  get scale() { return this.view.half / VIEW; }

  /** mm per CSS pixel and the on-screen centre of the board. */
  layout() {
    const r = this.svg.getBoundingClientRect();
    return { mx: r.left + r.width / 2, my: r.top + r.height / 2, mmPerPx: (this.view.half * 2) / Math.max(1, Math.min(r.width, r.height)) };
  }

  toSvg(clientX, clientY) {
    const g = this.layout();
    return { x: this.view.cx + (clientX - g.mx) * g.mmPerPx, y: this.view.cy + (clientY - g.my) * g.mmPerPx };
  }

  setView(cx, cy, half) {
    const h = Math.min(VIEW, Math.max(MIN_HALF, half));
    const lim = VIEW - h;
    this.view = { cx: Math.min(lim, Math.max(-lim, cx)), cy: Math.min(lim, Math.max(-lim, cy)), half: h };
    const v = this.view;
    this.svg.setAttribute('viewBox', `${(v.cx - v.half).toFixed(2)} ${(v.cy - v.half).toFixed(2)} ${(v.half * 2).toFixed(2)} ${(v.half * 2).toFixed(2)}`);
    drawHits(this.marks, this.hits, { scale: this.scale });
  }

  /** Zoom by a factor while keeping the given board point where it is on screen. */
  zoomAt(factor, p) {
    const v = this.view;
    const half = Math.min(VIEW, Math.max(MIN_HALF, v.half * factor));
    const k = half / v.half;
    this.setView(p.x - (p.x - v.cx) * k, p.y - (p.y - v.cy) * k, half);
  }

  zoomIn() {
    const pos = this.hits.filter((h) => h && !h.out);
    const v = this.view;
    if (pos.length && v.half > VIEW * 0.95) {
      // first step from the full view: go to where the darts are
      const cx = pos.reduce((a, h) => a + h.x, 0) / pos.length;
      const cy = pos.reduce((a, h) => a - h.y, 0) / pos.length;
      this.setView(cx, cy, v.half * 0.5);
    } else {
      this.setView(v.cx, v.cy, v.half * 0.6);
    }
  }

  zoomOut() { this.setView(this.view.cx, this.view.cy, this.view.half / 0.6); }

  resetView() { this.setView(0, 0, VIEW); }

  set(i, p) {
    const lim = VIEW - 6;
    const r = Math.hypot(p.x, p.y);
    const k = r > lim ? lim / r : 1;
    const x = Math.round(p.x * k * 10) / 10, y = Math.round(-p.y * k * 10) / 10;
    this.hits[i] = { x, y, label: classify(x, y) };
    this.refresh();
  }

  cancelPending() {
    const pd = this.pending;
    if (pd) {
      if (pd.isNew) this.hits.splice(pd.index, 1); else this.hits[pd.index] = pd.prev;
      this.refresh();
    }
    this.pending = null;
    this.drag = -1;
  }

  down(e) {
    e.preventDefault();
    this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    try { this.svg.setPointerCapture(e.pointerId); } catch (err) { /* not supported */ }
    if (this.pointers.size >= 2) {
      // second finger: this is a pinch, not a dart
      this.cancelPending();
      const [a, b] = [...this.pointers.values()];
      const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      this.pinch = { dist: Math.hypot(a.x - b.x, a.y - b.y) || 1, half: this.view.half, anchor: this.toSvg(mid.x, mid.y) };
      this.blocked = true;
      return;
    }
    if (this.blocked) return;
    const p = this.toSvg(e.clientX, e.clientY);
    // Grab an existing marker only when the touch is on it; once all darts are placed, grab the nearest one more generously.
    let near = -1, best = (this.hits.length >= this.max ? 40 : 16) * this.scale;
    this.hits.forEach((h, i) => {
      if (!h || h.out) return;
      const d = Math.hypot(h.x - p.x, -h.y - p.y);
      if (d < best) { best = d; near = i; }
    });
    let isNew = false;
    if (near < 0) {
      if (this.hits.length >= this.max) return;
      near = this.hits.length;
      isNew = true;
    }
    this.pending = { index: near, isNew, prev: isNew ? null : { ...this.hits[near] } };
    this.drag = near;
    this.set(near, p);
  }

  move(e) {
    if (!this.pointers.has(e.pointerId)) return;
    this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (this.pinch && this.pointers.size >= 2) {
      const [a, b] = [...this.pointers.values()];
      const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      const half = Math.min(VIEW, Math.max(MIN_HALF, this.pinch.half * this.pinch.dist / (Math.hypot(a.x - b.x, a.y - b.y) || 1)));
      this.view.half = half;
      const g = this.layout();
      this.setView(this.pinch.anchor.x - (mid.x - g.mx) * g.mmPerPx, this.pinch.anchor.y - (mid.y - g.my) * g.mmPerPx, half);
      return;
    }
    if (this.drag >= 0 && !this.blocked) this.set(this.drag, this.toSvg(e.clientX, e.clientY));
  }

  up(e) {
    this.pointers.delete(e.pointerId);
    if (this.pointers.size < 2) this.pinch = null;
    if (this.pointers.size === 0) {
      this.drag = -1;
      this.pending = null;
      this.blocked = false;
    }
  }

  miss() {
    if (this.hits.length >= this.max) return;
    this.hits.push({ out: true, label: 'MISS' });
    this.refresh();
  }

  undo() {
    this.hits.pop();
    this.refresh();
  }

  refresh() {
    drawHits(this.marks, this.hits, { scale: this.scale });
    this.onChange(this.hits);
  }
}
