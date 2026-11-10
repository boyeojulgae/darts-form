// Side-by-side replay of the three throws, lined up on the moment the arm swings forward,
// with lines drawn on the arm and body, plus all three overlaid on one picture.
import { LM } from './analysis.js';
import { THROW_COLORS } from './board.js';
import { armRegion, FrameCache, drawRegion, toCanvas } from './frames.js';

const T0 = -1.0, T1 = 0.5, STEP = 1 / 30;
const HIP = { l: 23, r: 24 };
const fin = Number.isFinite;
const f1 = (v) => (fin(v) ? (Math.round(v * 10) / 10).toFixed(1) : '—');

function h(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

function maxPair(points) {
  const p = points.filter((q) => q && fin(q[0]) && fin(q[1]));
  let m = NaN;
  for (let i = 0; i < p.length; i++) {
    for (let j = i + 1; j < p.length; j++) {
      const d = Math.hypot(p[i][0] - p[j][0], p[i][1] - p[j][1]);
      m = fin(m) ? Math.max(m, d) : d;
    }
  }
  return m;
}

export function comparePlayer(analysis, frames, view) {
  const card = h('div', 'card');
  card.append(h('h3', null, '3投の比較（腕を振る瞬間を揃えて再生）'));
  const T = analysis.throws;
  const right = analysis.handed === 'right';
  const A = right
    ? { s: LM.rSh, e: LM.rEl, w: LM.rWr, o: LM.lSh, h1: HIP.r, h2: HIP.l }
    : { s: LM.lSh, e: LM.lEl, w: LM.lWr, o: LM.rSh, h1: HIP.l, h2: HIP.r };
  const regions = { arm: armRegion(analysis, view, 2.9, 0.36), body: armRegion(analysis, view, 4.0, 0.3) };
  let sub = regions.arm;
  const cache = new FrameCache(frames, 24);
  const cm = analysis.cmPerPx;

  // frames of each throw as [seconds from its swing moment, index], in time order
  const tracks = T.map((t) => {
    const zero = fin(t.tSync) ? t.tSync : t.tPeak;
    const list = [];
    frames.forEach((f, i) => { const tau = f.t / 1000 - zero; if (tau >= T0 - 0.1 && tau <= T1 + 0.1) list.push([tau, i]); });
    return list;
  });
  const at = (k, tau) => {
    let best = -1, bd = 1e9;
    for (const [t, i] of tracks[k]) { const d = Math.abs(t - tau); if (d < bd) { bd = d; best = i; } }
    return bd < 0.12 ? best : -1;
  };
  const joint = (idx, j) => { const lm = idx >= 0 && frames[idx] && frames[idx].lm; return lm && lm[j] ? lm[j] : null; };
  // Position of a joint at exactly `tau`, blended from the frames before and after it. The three
  // throws were not filmed at the same instants of the swing, so comparing nearest frames would
  // show a timing difference as a position difference.
  const blend = (k, tau, j) => {
    const list = tracks[k];
    let a = null, b = null;
    for (const e of list) { if (e[0] <= tau) a = e; else { b = e; break; } }
    const pa = a && tau - a[0] < 0.12 ? joint(a[1], j) : null;
    const pb = b && b[0] - tau < 0.12 ? joint(b[1], j) : null;
    if (pa && pb) {
      const w = (tau - a[0]) / (b[0] - a[0]);
      return [pa[0] + (pb[0] - pa[0]) * w, pa[1] + (pb[1] - pa[1]) * w, Math.min(pa[2], pb[2])];
    }
    return pa || pb;
  };

  const grid = h('div', 'cmp-grid');
  const canvases = [];
  [...T.map((t) => `${t.n}投目`), '重ね合わせ'].forEach((name, k) => {
    const box = h('div', 'cmp-cell');
    const cap = h('div', 'cmp-cap');
    if (k < T.length) { const chip = h('i', 'chip'); chip.style.background = THROW_COLORS[(T[k].n - 1) % 3]; cap.append(chip); }
    cap.append(document.createTextNode(name));
    const cv = document.createElement('canvas');
    cv.width = 420;
    cv.height = 420;
    canvases.push(cv);
    box.append(cap, cv);
    grid.append(box);
  });
  card.append(grid);

  const ctl = h('div', 'cmp-ctl');
  const play = h('button', 'primary', '▶ 再生');
  const back = h('button', 'ghost', '◀');
  const fwd = h('button', 'ghost', '▶');
  back.setAttribute('aria-label', '1コマ戻す');
  fwd.setAttribute('aria-label', '1コマ進める');
  const speed = document.createElement('select');
  speed.setAttribute('aria-label', '再生速度');
  for (const [v, s] of [[0.1, '0.1倍速'], [0.25, '0.25倍速'], [0.5, '0.5倍速'], [1, '等速']]) { const o = h('option', null, s); o.value = v; speed.append(o); }
  speed.value = '0.25';
  const zoom = h('button', 'ghost', '上半身を表示');
  const slider = document.createElement('input');
  slider.type = 'range';
  slider.min = T0;
  slider.max = T1;
  slider.step = STEP;
  slider.setAttribute('aria-label', '再生位置');
  const time = h('span', 'cmp-time');
  ctl.append(play, back, fwd, speed, zoom, slider, time);
  card.append(ctl);
  const read = h('div', 'cmp-read');
  card.append(read);

  let tau = -0.3, playing = false, last = 0;
  const shown = [];

  function skeleton(ctx, get, color, cv, thin) {
    const { X, Y, k } = toCanvas(sub, cv);
    const P = (j) => { const p = get(j); return p && p[2] >= 0.3 ? [X(p[0]), Y(p[1])] : null; };
    const line = (a, b, c, w, dash) => {
      if (!a || !b) return;
      ctx.setLineDash(dash || []);
      ctx.strokeStyle = c;
      ctx.lineWidth = w;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(a[0], a[1]);
      ctx.lineTo(b[0], b[1]);
      ctx.stroke();
      ctx.setLineDash([]);
    };
    const s = P(A.s), o = P(A.o), e = P(A.e), w = P(A.w), h1 = P(A.h1), h2 = P(A.h2);
    const le = P(LM.lEye), re = P(LM.rEye);
    const body = thin ? color : 'rgba(255, 255, 255, 0.85)';
    const bw = thin ? 2.5 : 3.5;
    line(s, o, body, bw);
    const ms = s && o ? [(s[0] + o[0]) / 2, (s[1] + o[1]) / 2] : null;
    if (ms && h1 && h2) line(ms, [(h1[0] + h2[0]) / 2, (h1[1] + h2[1]) / 2], body, bw);
    if (le && re) {
      const eye = [(le[0] + re[0]) / 2, (le[1] + re[1]) / 2];
      if (ms) line(eye, ms, body, bw, [6, 6]);
      ctx.beginPath();
      ctx.arc(eye[0], eye[1], 0.32 * analysis.forearmPx * k, 0, Math.PI * 2);
      ctx.strokeStyle = body;
      ctx.lineWidth = bw;
      ctx.stroke();
    }
    line(s, e, color, thin ? 4 : 7);
    line(e, w, color, thin ? 4 : 7);
    for (const p of [s, e, w]) {
      if (!p) continue;
      ctx.beginPath();
      ctx.arc(p[0], p[1], thin ? 4.5 : 7, 0, Math.PI * 2);
      ctx.fillStyle = '#fff';
      ctx.fill();
      ctx.lineWidth = 2.5;
      ctx.strokeStyle = color;
      ctx.stroke();
    }
  }

  const onDecoded = () => { if (card.isConnected) render(); };

  function render() {
    const idxs = T.map((t, k) => at(k, tau));
    // keep showing the previous picture until the wanted one is decoded, to avoid flicker
    const pics = idxs.map((i, k) => {
      const pic = i >= 0 ? cache.get(i, onDecoded) : null;
      if (pic) shown[k] = pic;
      return pic || (shown[k] && !shown[k].closed ? shown[k] : null);
    });
    idxs.forEach((i, k) => { if (i >= 0) { cache.get(i + 1); cache.get(i + 2); } });
    canvases.forEach((cv, k) => {
      const ctx = cv.getContext('2d');
      ctx.fillStyle = '#0a0d12';
      ctx.fillRect(0, 0, cv.width, cv.height);
      if (k < T.length) {
        if (idxs[k] >= 0) {
          drawRegion(ctx, pics[k], sub);
          skeleton(ctx, (j) => joint(idxs[k], j), THROW_COLORS[(T[k].n - 1) % 3], cv, false);
        } else {
          ctx.fillStyle = '#969eac';
          ctx.font = '18px system-ui, sans-serif';
          ctx.fillText('この時点の記録はありません', 16, 32);
        }
      } else {
        const b = idxs.findIndex((i) => i >= 0);
        if (b >= 0) drawRegion(ctx, pics[b], sub, 0.3);
        const { X, Y } = toCanvas(sub, cv);
        T.forEach((t, j) => {
          const color = THROW_COLORS[(t.n - 1) % 3];
          // the way the wrist has come so far
          ctx.beginPath();
          let on = false;
          for (const [tt, i] of tracks[j]) {
            if (tt > tau) break;
            const p = joint(i, A.w);
            if (!p || p[2] < 0.3) continue;
            if (on) ctx.lineTo(X(p[0]), Y(p[1])); else ctx.moveTo(X(p[0]), Y(p[1]));
            on = true;
          }
          const now = blend(j, tau, A.w);
          if (on && now) ctx.lineTo(X(now[0]), Y(now[1]));
          ctx.strokeStyle = color;
          ctx.globalAlpha = 0.75;
          ctx.lineWidth = 1.6;
          ctx.lineJoin = 'round';
          ctx.stroke();
          ctx.globalAlpha = 1;
          if (idxs[j] >= 0) skeleton(ctx, (q) => blend(j, tau, q), color, cv, true);
        });
      }
    });
    slider.value = tau;
    time.textContent = tau <= -0.005 ? `腕を振る${Math.abs(tau).toFixed(2)}秒前` : tau >= 0.005 ? `腕を振った${tau.toFixed(2)}秒後` : '腕を振る瞬間';
    const sp = (j) => maxPair(T.map((t, k) => (idxs[k] >= 0 ? blend(k, tau, j) : null))) * cm;
    const fast = tau > -0.12 && tau < 0.2;
    read.textContent = `この瞬間の3投のばらつき（最も離れた2投の距離）：手首 ${f1(sp(A.w))}cm・肘 ${f1(sp(A.e))}cm・肩 ${f1(sp(A.s))}cm${fast ? '　※腕を振っている最中は動きが速く、数値は粗くなります' : ''}`;
  }

  function frame(now) {
    if (!playing) return;
    if (!card.isConnected) { playing = false; cache.clear(); return; }
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    tau += dt * Number(speed.value);
    if (tau > T1) tau = T0;
    render();
    requestAnimationFrame(frame);
  }

  const setPlaying = (on) => {
    playing = on;
    play.textContent = on ? '⏸ 止める' : '▶ 再生';
    if (on) { last = performance.now(); requestAnimationFrame(frame); }
  };
  play.addEventListener('click', () => setPlaying(!playing));
  back.addEventListener('click', () => { setPlaying(false); tau = Math.max(T0, tau - STEP); render(); });
  fwd.addEventListener('click', () => { setPlaying(false); tau = Math.min(T1, tau + STEP); render(); });
  slider.addEventListener('input', () => { setPlaying(false); tau = Number(slider.value); render(); });
  zoom.addEventListener('click', () => {
    sub = sub === regions.arm ? regions.body : regions.arm;
    zoom.textContent = sub === regions.arm ? '上半身を表示' : '腕まわりを拡大';
    render();
  });

  // spread at the three key moments, from the measured (and possibly hand-corrected) positions
  const table = h('table', 'metrics');
  const thead = h('thead');
  const hr = h('tr');
  for (const s of ['3投のばらつき（cm）', '手首', '肘', '肩']) hr.append(h('th', null, s));
  thead.append(hr);
  table.append(thead);
  const tb = h('tbody');
  const rows = [
    ['構え', (t) => [t.px.ready.wx, t.px.ready.wy], (t) => [t.px.ready.ex, t.px.ready.ey], (t) => [t.px.ready.sx, t.px.ready.sy]],
    ['振り出す直前', (t) => [t.px.pre.wx, t.px.pre.wy], (t) => [t.px.pre.ex, t.px.pre.ey], null],
    ['最高点', (t) => [t.px.top.wx, t.px.top.wy], (t) => [t.px.top.ex, t.px.top.ey], null],
  ];
  for (const [name, fw, fe, fs] of rows) {
    const tr = h('tr');
    tr.append(h('td', null, name));
    for (const fn of [fw, fe, fs]) tr.append(h('td', null, fn ? f1(maxPair(T.map(fn)) * cm) : '—'));
    tb.append(tr);
  }
  table.append(tb);
  card.append(table);
  card.append(h('p', 'note', 'カメラは動かないので、線がぴったり重なるほど3投が同じ動きです。色は投球の番号、白い線は肩・体の軸・頭、重ね合わせの細い線は手首が通ってきた道です。3投は「腕を前へ振る途中で、手が上がりきる半分の高さを通る瞬間」で揃えています。線は自動認識の位置で、確認画面で直した位置は上の表に反映されます。誤差が±1〜2cmあるので、それより小さい差は気にしなくて大丈夫です。'));

  card.dispose = () => { playing = false; cache.clear(); };
  render();
  return card;
}
