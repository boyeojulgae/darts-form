// "Check the tracking" screen: shows the three key moments of each throw with the detected
// shoulder, elbow and wrist. The player can drag a point or step to a neighbouring frame.
import { LM } from './analysis.js';
import { THROW_COLORS } from './board.js';
import { armRegion, FrameCache, drawRegion, toCanvas } from './frames.js';

const MOMENTS = [['ready', '構え'], ['pre', '振り出す直前'], ['top', '最高点']];
const JOINTS = [['s', '肩', '#ffffff'], ['e', '肘', '#ffd34a'], ['w', '手首', '#f5785a']];
const fin = Number.isFinite;

function h(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

export class ConfirmView {
  constructor(root, { analysis, frames, view }) {
    this.root = root;
    this.analysis = analysis;
    this.frames = frames;
    this.cache = new FrameCache(frames, 16);
    this.sub = armRegion(analysis, view, 2.8);
    this.ids = analysis.handed === 'right' ? { s: LM.rSh, e: LM.rEl, w: LM.rWr } : { s: LM.lSh, e: LM.lEl, w: LM.lWr };
    this.current = 0;
    this.rows = analysis.throws.map((t) => ({
      n: t.n,
      quality: t.quality,
      cells: MOMENTS.map(([key]) => this.makeCell(t, key)),
    }));
    this.build();
    const first = this.rows.findIndex((r) => this.rowSuspect(r));
    this.show(first >= 0 ? first : 0);
  }

  fromFrame(idx) {
    const lm = this.frames[idx] && this.frames[idx].lm;
    if (!lm) return null;
    const p = (j) => (lm[j] ? [lm[j][0], lm[j][1]] : [NaN, NaN]);
    return { s: p(this.ids.s), e: p(this.ids.e), w: p(this.ids.w) };
  }

  makeCell(t, key) {
    const idx = key === 'ready' ? t.iReady : key === 'pre' ? t.iPre : t.iPeak;
    const o = t.px[key];
    const fr = this.fromFrame(idx) || { s: [NaN, NaN], e: [NaN, NaN], w: [NaN, NaN] };
    const pts = { s: key === 'ready' ? [o.sx, o.sy] : fr.s, e: [o.ex, o.ey], w: [o.wx, o.wy] };
    for (const k of ['s', 'e', 'w']) if (!fin(pts[k][0]) || !fin(pts[k][1])) pts[k] = fr[k];
    return { key, idx, idx0: idx, pts, edited: false, canvas: null, label: null, name: '' };
  }

  /** While waiting, the forearm should be upright and of normal length; otherwise the tracking is probably off. */
  suspect(cell) {
    const L = this.analysis.forearmPx;
    const d = Math.hypot(cell.pts.w[0] - cell.pts.e[0], cell.pts.w[1] - cell.pts.e[1]);
    if (!fin(d)) return true;
    if (cell.key === 'top') return !(d > 0.45 * L && d < 1.6 * L);
    return !(d > 0.65 * L && d < 1.45 * L && cell.pts.e[1] - cell.pts.w[1] > 0.45 * L);
  }

  rowSuspect(row) {
    const edited = row.cells.some((c) => c.edited);
    return row.cells.some((c) => this.suspect(c)) || (!edited && row.quality < 0.7);
  }

  summary() {
    const bad = this.rows.filter((r) => this.rowSuspect(r)).map((r) => r.n);
    return bad.length
      ? `自動チェック：${bad.join('・')}投目に認識のずれがありそうです（オレンジの印）。丸の位置を見て、ずれていたら直してください。`
      : '自動チェックでは大きなずれは見つかりませんでした。念のため各投球を見て、合っていれば「この内容で解析する」を押してください。';
  }

  build() {
    this.root.replaceChildren();
    this.head = h('p', 'cf-head');
    this.tabs = h('div', 'tabs');
    this.rows.forEach((row, i) => {
      const b = h('button', 'tab');
      const chip = h('i', 'chip');
      chip.style.background = THROW_COLORS[(row.n - 1) % 3];
      b.append(chip, document.createTextNode(`${row.n}投目`));
      b.addEventListener('click', () => this.show(i));
      this.tabs.append(b);
    });
    this.undo = h('button', 'ghost cf-undo', '自動認識に戻す');
    this.undo.addEventListener('click', () => this.reset());
    this.tabs.append(this.undo);
    this.grid = h('div', 'cf-grid');
    this.note = h('p', 'hint', '肩・肘・手首の丸が体の位置と合っているかを見てください。ずれていたら丸をドラッグして直せます。場面そのものが違う時は◀▶でコマを送れます。');
    this.root.append(this.head, this.tabs, this.grid, this.note);
  }

  marks() {
    this.head.textContent = this.summary();
    [...this.tabs.querySelectorAll('.tab')].forEach((b, k) => {
      b.classList.toggle('on', k === this.current);
      b.classList.toggle('warn', this.rowSuspect(this.rows[k]));
    });
    this.undo.disabled = !this.rows[this.current].cells.some((c) => c.edited);
  }

  /** Puts the shown throw back to what was detected automatically. */
  reset() {
    const row = this.rows[this.current];
    const t = this.analysis.throws.find((x) => x.n === row.n);
    row.cells = MOMENTS.map(([key]) => this.makeCell(t, key));
    this.show(this.current);
  }

  show(i) {
    this.current = i;
    const row = this.rows[i];
    this.grid.replaceChildren();
    row.cells.forEach((cell, k) => {
      const box = h('div', 'cf-cell');
      const cv = document.createElement('canvas');
      cv.width = 480;
      cv.height = 480;
      cell.canvas = cv;
      const bar = h('div', 'cf-bar');
      const prev = h('button', 'ghost', '◀');
      const next = h('button', 'ghost', '▶');
      const label = h('span', 'cf-label');
      prev.setAttribute('aria-label', '前のコマ');
      next.setAttribute('aria-label', '次のコマ');
      prev.addEventListener('click', () => this.step(cell, -1));
      next.addEventListener('click', () => this.step(cell, 1));
      bar.append(prev, label, next);
      cell.label = label;
      cell.name = MOMENTS[k][1];
      box.append(cv, bar);
      this.grid.append(box);
      this.bind(cell);
      this.draw(cell);
    });
    this.marks();
  }

  step(cell, d) {
    let idx = cell.idx;
    // move to the next frame that has both a picture and tracked points
    for (let n = 0; n < 6; n++) {
      idx += d;
      if (idx < 0 || idx >= this.frames.length) return;
      if (this.frames[idx].img && this.frames[idx].lm) break;
    }
    if (idx < 0 || idx >= this.frames.length || idx === cell.idx) return;
    cell.idx = idx;
    const fr = this.fromFrame(idx);
    if (fr) for (const k of ['s', 'e', 'w']) if (fin(fr[k][0]) && fin(fr[k][1])) cell.pts[k] = fr[k];
    cell.edited = true;
    this.draw(cell);
    this.marks();
  }

  bind(cell) {
    const cv = cell.canvas;
    let drag = null;
    const pos = (e) => {
      const r = cv.getBoundingClientRect();
      return [(e.clientX - r.left) * cv.width / r.width, (e.clientY - r.top) * cv.height / r.height];
    };
    cv.addEventListener('pointerdown', (e) => {
      const [x, y] = pos(e);
      const { X, Y } = toCanvas(this.sub, cv);
      let best = 70, hit = null;
      for (const [k] of JOINTS) {
        const d = Math.hypot(X(cell.pts[k][0]) - x, Y(cell.pts[k][1]) - y);
        if (d < best) { best = d; hit = k; }
      }
      if (!hit) return;
      e.preventDefault();
      try { cv.setPointerCapture(e.pointerId); } catch (err) { /* not supported */ }
      // keep the finger's offset from the point, so the point stays visible while dragging
      drag = { k: hit, dx: X(cell.pts[hit][0]) - x, dy: Y(cell.pts[hit][1]) - y };
    });
    cv.addEventListener('pointermove', (e) => {
      if (!drag) return;
      const [x, y] = pos(e);
      const { k } = toCanvas(this.sub, cv);
      cell.pts[drag.k] = [this.sub.x + (x + drag.dx) / k, this.sub.y + (y + drag.dy) / k];
      cell.edited = true;
      this.draw(cell);
    });
    const end = () => {
      if (!drag) return;
      drag = null;
      this.marks();
      this.draw(cell);
    };
    cv.addEventListener('pointerup', end);
    cv.addEventListener('pointercancel', end);
  }

  draw(cell) {
    const cv = cell.canvas;
    if (!cv) return;
    const ctx = cv.getContext('2d');
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, cv.width, cv.height);
    drawRegion(ctx, this.cache.get(cell.idx, () => this.draw(cell)), this.sub);
    const { X, Y } = toCanvas(this.sub, cv);
    const P = (k) => [X(cell.pts[k][0]), Y(cell.pts[k][1])];
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = 'rgba(54, 211, 196, 0.9)';
    ctx.lineWidth = 6;
    ctx.beginPath();
    let started = false;
    for (const k of ['s', 'e', 'w']) {
      const [x, y] = P(k);
      if (!fin(x) || !fin(y)) continue;
      if (started) ctx.lineTo(x, y); else ctx.moveTo(x, y);
      started = true;
    }
    ctx.stroke();
    ctx.font = '600 22px system-ui, sans-serif';
    for (const [k, name, color] of JOINTS) {
      const [x, y] = P(k);
      if (!fin(x) || !fin(y)) continue;
      ctx.beginPath();
      ctx.arc(x, y, 15, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(12, 16, 22, 0.35)';
      ctx.fill();
      ctx.lineWidth = 4;
      ctx.strokeStyle = color;
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(x, y, 3, 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.fill();
      ctx.lineWidth = 4;
      ctx.strokeStyle = 'rgba(12, 16, 22, 0.9)';
      ctx.strokeText(name, x + 20, y + 8);
      ctx.fillStyle = color;
      ctx.fillText(name, x + 20, y + 8);
    }
    const bad = this.suspect(cell);
    if (bad) {
      ctx.lineWidth = 8;
      ctx.strokeStyle = '#f5785a';
      ctx.strokeRect(4, 4, cv.width - 8, cv.height - 8);
    }
    const moved = cell.idx - cell.idx0;
    cell.label.textContent = `${cell.name}${moved ? `（${moved > 0 ? '+' : ''}${moved}コマ）` : ''}${bad ? '　要確認' : cell.edited ? '　修正済み' : ''}`;
    cell.label.classList.toggle('bad', bad);
  }

  get edited() { return this.rows.some((r) => r.cells.some((c) => c.edited)); }

  /** Values for applyKeyframes(). */
  result() {
    return this.rows.map((row) => {
      const out = { n: row.n, edited: row.cells.some((c) => c.edited) };
      for (const c of row.cells) {
        out[c.key] = { idx: c.idx, wx: c.pts.w[0], wy: c.pts.w[1], ex: c.pts.e[0], ey: c.pts.e[1], sx: c.pts.s[0], sy: c.pts.s[1] };
      }
      return out;
    });
  }

  dispose() { this.cache.clear(); }
}
