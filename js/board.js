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
  hits.forEach((h, i) => {
    if (!h || h.out) return;
    const g = el('g', { transform: `translate(${h.x.toFixed(1)} ${(-h.y).toFixed(1)})` }, marks);
    const r = opts.small ? 5 : 13;
    el('circle', { r, fill: opts.color || THROW_COLORS[i % 3], stroke: '#fff', 'stroke-width': opts.small ? 1 : 2.5, opacity: opts.small ? 0.85 : 1 }, g);
    if (!opts.small) {
      const t = el('text', { fill: '#fff', 'font-size': 17, 'font-weight': 700, 'text-anchor': 'middle', 'dominant-baseline': 'central' }, g);
      t.textContent = i + 1;
    }
  });
}

/** Interactive board: tap to add the next dart, drag a marker to adjust it. */
export class BoardInput {
  constructor(container, max, onChange) {
    this.max = max;
    this.onChange = onChange;
    this.hits = [];
    const { svg, marks } = drawBoard(container);
    this.svg = svg;
    this.marks = marks;
    this.drag = -1;
    svg.addEventListener('pointerdown', (e) => this.down(e));
    svg.addEventListener('pointermove', (e) => this.move(e));
    svg.addEventListener('pointerup', () => { this.drag = -1; });
    svg.addEventListener('pointercancel', () => { this.drag = -1; });
  }

  point(e) {
    const m = this.svg.getScreenCTM();
    if (!m) return null;
    const p = new DOMPoint(e.clientX, e.clientY).matrixTransform(m.inverse());
    return { x: p.x, y: -p.y };
  }

  set(i, p) {
    const lim = VIEW - 6;
    const r = Math.hypot(p.x, p.y);
    const k = r > lim ? lim / r : 1;
    const x = Math.round(p.x * k * 10) / 10, y = Math.round(p.y * k * 10) / 10;
    this.hits[i] = { x, y, label: classify(x, y) };
    this.refresh();
  }

  down(e) {
    const p = this.point(e);
    if (!p) return;
    e.preventDefault();
    let near = -1, best = 22;
    this.hits.forEach((h, i) => {
      if (!h || h.out) return;
      const d = Math.hypot(h.x - p.x, h.y - p.y);
      if (d < best) { best = d; near = i; }
    });
    if (near < 0) {
      if (this.hits.length >= this.max) return;
      near = this.hits.length;
    }
    this.drag = near;
    try { this.svg.setPointerCapture(e.pointerId); } catch (err) { /* not supported */ }
    this.set(near, p);
  }

  move(e) {
    if (this.drag < 0) return;
    const p = this.point(e);
    if (p) this.set(this.drag, p);
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
    drawHits(this.marks, this.hits);
    this.onChange(this.hits);
  }
}
