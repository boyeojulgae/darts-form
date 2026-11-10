// Throw detection and form metrics from pose landmarks (front camera view).
// Pure functions: no DOM access, so the same code runs in the app and in tests.
//
// Coordinates are image pixels as the camera sees them (not mirrored):
// image left is the thrower's right-hand side.

export const LM = { nose: 0, lEye: 2, rEye: 5, lSh: 11, rSh: 12, lEl: 13, rEl: 14, lWr: 15, rWr: 16 };

const fin = Number.isFinite;

export function median(a) {
  const s = a.filter(fin).sort((x, y) => x - y);
  if (!s.length) return NaN;
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function quantile(a, q) {
  const s = a.filter(fin).sort((x, y) => x - y);
  if (!s.length) return NaN;
  const pos = (s.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return s[lo] + (s[hi] - s[lo]) * (pos - lo);
}

const spread = (a) => quantile(a, 0.95) - quantile(a, 0.05);
const mean = (a) => { const v = a.filter(fin); return v.length ? v.reduce((p, c) => p + c, 0) / v.length : NaN; };
const range = (a) => { const v = a.filter(fin); return v.length ? Math.max(...v) - Math.min(...v) : NaN; };

function arm(handed) {
  return handed === 'right'
    ? { S: LM.rSh, E: LM.rEl, W: LM.rWr, O: LM.lSh }
    : { S: LM.lSh, E: LM.lEl, W: LM.lWr, O: LM.rSh };
}

function buildSeries(frames, handed) {
  const J = arm(handed);
  const n = frames.length;
  const col = () => new Array(n).fill(NaN);
  const S = { n, t: col(), wx: col(), wy: col(), ex: col(), ey: col(), sx: col(), sy: col(), ox: col(), oy: col(), fx: col(), fy: col(), nx: col() };
  for (let i = 0; i < n; i++) {
    const f = frames[i];
    S.t[i] = f.t / 1000;
    const lm = f.lm;
    if (!lm) continue;
    const put = (kx, ky, j) => { if (lm[j]) { S[kx][i] = lm[j][0]; S[ky][i] = lm[j][1]; } };
    put('wx', 'wy', J.W); put('ex', 'ey', J.E); put('sx', 'sy', J.S); put('ox', 'oy', J.O);
    if (lm[LM.lEye] && lm[LM.rEye]) {
      S.fx[i] = (lm[LM.lEye][0] + lm[LM.rEye][0]) / 2;
      S.fy[i] = (lm[LM.lEye][1] + lm[LM.rEye][1]) / 2;
    }
    if (lm[LM.nose]) S.nx[i] = lm[LM.nose][0];
  }
  return S;
}

function between(S, a, b) {
  const out = [];
  for (let i = 0; i < S.n; i++) if (S.t[i] >= a && S.t[i] <= b) out.push(i);
  return out;
}

const pick = (S, key, idx) => idx.map((i) => S[key][i]);

function forearmLength(S) {
  const len = [];
  for (let i = 0; i < S.n; i++) {
    const d = Math.hypot(S.wx[i] - S.ex[i], S.wy[i] - S.ey[i]);
    // forearm roughly upright and hand above the shoulder: the waiting pose
    if (fin(d) && S.ey[i] - S.wy[i] > 0.8 * d && S.wy[i] < S.sy[i]) len.push(d);
  }
  if (len.length >= 5) return median(len);
  const all = [];
  for (let i = 0; i < S.n; i++) all.push(Math.hypot(S.wx[i] - S.ex[i], S.wy[i] - S.ey[i]));
  return quantile(all, 0.8);
}

function findThrows(S, L, maxThrows) {
  const cands = [];
  for (let i = 2; i < S.n - 1; i++) {
    const dt = S.t[i] - S.t[i - 1];
    if (!(dt > 0) || dt > 0.25) continue;
    const up = (S.wy[i - 1] - S.wy[i]) / dt / L; // forearm lengths per second, upward
    if (!(up > 2.2)) continue;
    const R = between(S, S.t[i] - 0.65, S.t[i] - 0.1);
    if (R.length < 3) continue;
    const rwy = median(pick(S, 'wy', R));
    const rey = median(pick(S, 'ey', R));
    const rsy = median(pick(S, 'sy', R));
    if (!(rwy < rsy)) continue; // hand above the shoulder while waiting
    if (!(rey - rwy > 0.5 * L)) continue; // forearm upright
    const P = between(S, S.t[i] - 0.05, S.t[i] + 0.2);
    let p = P[0];
    for (const j of P) if (S.wy[j] < S.wy[p]) p = j;
    const rise = (rwy - S.wy[p]) / L;
    if (!(rise > 0.15)) continue;
    const A = between(S, S.t[i], S.t[i] + 0.4);
    const eMin = Math.min(...pick(S, 'ey', A).filter(fin));
    const eRise = fin(eMin) ? (rey - eMin) / L : 0;
    cands.push({ i, p, t: S.t[p], score: up + 10 * rise + 5 * Math.max(0, eRise) });
  }
  cands.sort((a, b) => b.score - a.score);
  const chosen = [];
  for (const c of cands) {
    if (chosen.length >= maxThrows) break;
    if (chosen.every((d) => Math.abs(d.t - c.t) > 0.9)) chosen.push(c);
  }
  return chosen.sort((a, b) => a.t - b.t);
}

function measureThrow(S, L, c) {
  const p = c.p;
  const tp = S.t[p];
  let R = between(S, tp - 0.45, tp - 0.25);
  if (R.length < 2) R = between(S, tp - 0.65, tp - 0.2);
  const Wt = between(S, tp - 0.7, tp - 0.25);
  // Last frame before the swing: walking back from the peak, the first frame where the hand
  // has not yet risen above its waiting height (works the same at any frame rate).
  const waitY = median(pick(S, 'wy', R));
  let pre = R[R.length - 1];
  for (let i = p - 1; i > R[R.length - 1]; i--) {
    if (fin(S.wy[i]) && waitY - S.wy[i] <= 0.12 * L) { pre = i; break; }
  }
  const m = (k, idx) => median(pick(S, k, idx));
  const ready = { wx: m('wx', R), wy: m('wy', R), ex: m('ex', R), ey: m('ey', R), sx: m('sx', R), sy: m('sy', R), ox: m('ox', R), oy: m('oy', R) };
  const face = { x: m('fx', Wt.length ? Wt : R), y: m('fy', Wt.length ? Wt : R), nx: m('nx', Wt.length ? Wt : R) };
  const Sw = [];
  for (let i = pre; i <= p; i++) Sw.push(i);
  let swingDx = 0;
  for (const i of Sw) { const d = ready.wx - S.wx[i]; if (fin(d) && Math.abs(d) > Math.abs(swingDx)) swingDx = d; }
  const A = between(S, tp - 0.1, tp + 0.35);
  const eys = pick(S, 'ey', A).filter(fin).sort((x, y) => x - y);
  const eMin = eys.length > 2 ? eys[1] : eys.length ? eys[0] : NaN;
  const near = between(S, tp - 1.0, tp + 0.3);
  const fps = near.length > 1 ? (near.length - 1) / (S.t[near[near.length - 1]] - S.t[near[0]]) : NaN;
  const pathIdx = between(S, tp - 0.8, tp + 0.2);
  return {
    tPeak: tp, iPeak: p, iPre: pre, iReady: R[Math.floor(R.length / 2)], fps,
    px: {
      ready, face, forearm: L,
      pre: { wx: S.wx[pre], wy: S.wy[pre], ex: S.ex[pre], ey: S.ey[pre] },
      top: { wx: S.wx[p], wy: S.wy[p], ex: S.ex[p], ey: S.ey[p] },
      stillX: spread(pick(S, 'wx', Wt)), stillY: spread(pick(S, 'wy', Wt)),
      swingDx, elbowMinY: eMin,
    },
    path: pathIdx.map((i) => [S.t[i] - tp, S.wx[i], S.wy[i], S.ex[i], S.ey[i]]),
  };
}

// Metric catalogue. "axis" says which miss direction a metric could plausibly explain.
export const METRICS = [
  { key: 'side', label: '構えの左右位置', unit: 'cm', axis: 'x', help: '顔の中心から見た手首の位置。＋は右目側、−は左目側' },
  { key: 'height', label: '構えの高さ', unit: 'cm', axis: 'y', help: '手首が目より何cm下にあるか' },
  { key: 'still', label: '投げる前の手の揺れ', unit: 'cm', axis: null, help: '振り出す前の約0.5秒間に手首が動いた幅' },
  { key: 'preShift', label: '引く時の横移動', unit: 'cm', axis: 'x', help: '構えた位置から振り出す直前までの横の動き。＋は右目側' },
  { key: 'preDrop', label: '引く時の沈み', unit: 'cm', axis: 'y', help: '振り出す直前に手首が下がった量' },
  { key: 'swingShift', label: '振り出し中の横移動', unit: 'cm', axis: 'x', help: '構えた位置から最高点までで最も横にずれた量。＋は右目側' },
  { key: 'rise', label: '手の上がり幅', unit: 'cm', axis: 'y', help: '構えから最高点までに手首が上がった量' },
  { key: 'elbowRise', label: '肘の上がり幅', unit: 'cm', axis: 'y', help: '構えから投げ終わりまでに肘が上がった量（画面上）' },
  { key: 'elbowIn', label: '肘の内側への入り', unit: 'cm', axis: 'x', help: '肩より体の中心側にどれだけ肘があるか' },
  { key: 'handX', label: '構えの手のずれ（左右）', unit: 'cm', axis: 'x', help: '1投目を0とした構えの手首の位置。＋は右目側' },
  { key: 'handY', label: '構えの手のずれ（高さ）', unit: 'cm', axis: 'y', help: '1投目を0とした構えの手首の高さ。＋は高い' },
  { key: 'bodyX', label: '体のずれ（左右）', unit: 'cm', axis: 'x', help: '1投目を0とした投げる側の肩の位置。＋は右目側' },
  { key: 'bodyY', label: '体のずれ（高さ）', unit: 'cm', axis: 'y', help: '1投目を0とした投げる側の肩の高さ。＋は高い' },
];

function toMetrics(th, cm, handed, face, first) {
  const { ready, pre, top, stillX, stillY, swingDx, elbowMinY } = th.px;
  const inward = handed === 'right' ? ready.ex - ready.sx : ready.sx - ready.ex;
  return {
    side: (face.x - ready.wx) * cm,
    height: (ready.wy - face.y) * cm,
    still: Math.max(stillX, stillY) * cm,
    preShift: (ready.wx - pre.wx) * cm,
    preDrop: (pre.wy - ready.wy) * cm,
    swingShift: swingDx * cm,
    rise: (ready.wy - top.wy) * cm,
    elbowRise: (ready.ey - elbowMinY) * cm,
    elbowIn: inward * cm,
    handX: (first.wx - ready.wx) * cm,
    handY: (first.wy - ready.wy) * cm,
    bodyX: (first.sx - ready.sx) * cm,
    bodyY: (first.sy - ready.sy) * cm,
  };
}

/**
 * frames: [{ t: ms, lm: [[x, y, visibility] x33] | null }]
 * opts: { handed: 'left' | 'right', forearmCm: number, throws: 3 }
 */
export function analyzeCapture(frames, opts) {
  const handed = opts.handed === 'right' ? 'right' : 'left';
  const S = buildSeries(frames, handed);
  const tracked = S.wx.filter(fin).length;
  const result = { handed, frames: S.n, tracked, throws: [], cmPerPx: NaN, forearmPx: NaN, fps: NaN };
  if (S.n < 10 || tracked < S.n * 0.3) return result;
  result.fps = (S.n - 1) / (S.t[S.n - 1] - S.t[0]);
  const L0 = forearmLength(S);
  if (!fin(L0) || L0 < 8) return result;
  const found = findThrows(S, L0, opts.throws ?? 3).map((c) => measureThrow(S, L0, c));
  if (!found.length) return result;
  const Lr = median(found.map((th) => Math.hypot(th.px.ready.wx - th.px.ready.ex, th.px.ready.wy - th.px.ready.ey)));
  const cm = opts.forearmCm / Lr;
  result.cmPerPx = cm;
  result.forearmPx = Lr;
  // One face reference for the whole capture: the face landmarks are noisy while the hand covers the face.
  const face = { x: median(found.map((th) => th.px.face.x)), y: median(found.map((th) => th.px.face.y)) };
  result.face = face;
  result.throws = found.map((th, k) => ({ n: k + 1, ...th, m: toMetrics(th, cm, handed, face, found[0].px.ready) }));
  return result;
}

// ---------- wording ----------

const r1 = (v) => (Math.round(v * 10) / 10).toFixed(1);
const eyeSide = (v) => (v >= 0 ? '右目側' : '左目側');

export function landingSummary(hits) {
  const ok = hits.filter((h) => h && !h.out);
  if (!ok.length) return null;
  const cx = mean(ok.map((h) => h.x)) / 10;
  const cy = mean(ok.map((h) => h.y)) / 10;
  const dist = ok.map((h) => Math.hypot(h.x, h.y) / 10);
  const spreadCm = ok.length > 1 ? Math.max(...ok.flatMap((a, i) => ok.slice(i + 1).map((b) => Math.hypot(a.x - b.x, a.y - b.y) / 10))) : 0;
  return { n: ok.length, cx, cy, meanDist: mean(dist), spreadCm, bulls: ok.filter((h) => /BULL/.test(h.label)).length };
}

function dirWords(dx, dy, min = 1) {
  const w = [];
  if (Math.abs(dx) >= min) w.push(`${dx > 0 ? '右' : '左'}へ${r1(Math.abs(dx))}cm`);
  if (Math.abs(dy) >= min) w.push(`${dy > 0 ? '上' : '下'}へ${r1(Math.abs(dy))}cm`);
  return w.length ? w.join('・') : 'ほぼ中心';
}

// Measurement noise of the tracker is roughly 1 cm, so differences below these floors are not reported.
const FLOOR = { preShift: 2, preDrop: 3, swingShift: 2.5, rise: 3, elbowRise: 4, elbowIn: 3, handX: 2, handY: 3, bodyX: 2, bodyY: 3 };

export function makeFindings(analysis, hits, history = []) {
  const out = [];
  const T = analysis.throws;
  if (!T.length) {
    out.push({ level: 'warn', title: '投球を検出できませんでした', detail: '上半身と投げる腕（肘まで）がカメラに入っているか、明るさが足りているかを確認してください。' });
    return out;
  }
  if (T.length < 3) out.push({ level: 'warn', title: `検出できた投球は${T.length}投です`, detail: '合図から5秒以内に投げ終わっているか、腕がカメラの外に出ていないかを確認してください。' });
  if (analysis.fps < 14) out.push({ level: 'warn', title: `処理速度が遅めです（毎秒${r1(analysis.fps)}コマ）`, detail: '速い動きの数値は粗くなります。設定で「軽量モデル」を試してください。' });

  const land = landingSummary(hits);
  if (land) {
    out.push({
      level: land.meanDist <= 2.5 ? 'good' : 'info',
      title: `着弾：グループの中心は${dirWords(land.cx, land.cy)}`,
      detail: `ブル中心からの平均距離は${r1(land.meanDist)}cm、3本のまとまり（最も離れた2本の距離）は${r1(land.spreadCm)}cmです。`,
    });
  }

  const mv = (k) => T.map((t) => t.m[k]);
  const avg = (k) => mean(mv(k));

  const ps = avg('preShift');
  if (Math.abs(ps) >= 2) {
    out.push({ level: 'warn', title: `引く時に手が${eyeSide(ps)}へ約${r1(Math.abs(ps))}cm寄っています`, detail: `各投：${mv('preShift').map((v) => r1(v)).join(' / ')} cm。構えた位置から真後ろ（鼻・口の方向）へ引けているかを確認してください。` });
  } else {
    out.push({ level: 'good', title: `引く時の横移動は小さめです（平均${r1(Math.abs(ps))}cm）`, detail: `各投：${mv('preShift').map((v) => r1(v)).join(' / ')} cm。` });
  }

  const st = Math.max(...mv('still'));
  if (st >= 3) out.push({ level: 'warn', title: `投げる前に手が最大${r1(st)}cm動いています`, detail: '構えてから振り出すまで、手を止めて待てているかを確認してください。' });
  else out.push({ level: 'good', title: '投げる前の手はよく止まっています', detail: `揺れは最大${r1(st)}cmです。` });

  if (T.length >= 2) {
    const rs = range(mv('handX'));
    const rh = range(mv('handY'));
    if (rs >= 2 || rh >= 3) {
      const k = rs / 2 >= rh / 3 ? 'handX' : 'handY';
      const vals = mv(k);
      const mdn = median(vals);
      const odd = vals.reduce((b, v, i) => (Math.abs(v - mdn) > Math.abs(vals[b] - mdn) ? i : b), 0);
      const d = vals[odd] - mdn;
      const word = k === 'handX' ? `${eyeSide(d)}へ${r1(Math.abs(d))}cm` : `${d > 0 ? '高く' : '低く'}${r1(Math.abs(d))}cm`;
      out.push({ level: 'warn', title: `構えの位置が投げるごとに違います（${T[odd].n}投目が${word}）`, detail: `左右の差${r1(rs)}cm、高さの差${r1(rh)}cm。毎回同じ場所に手を置けているかを確認してください。` });
    } else {
      out.push({ level: 'good', title: '構えの位置は揃っています', detail: `左右の差${r1(rs)}cm、高さの差${r1(rh)}cm。` });
    }
    const bx = range(mv('bodyX'));
    const by = range(mv('bodyY'));
    if (bx >= 2.5 || by >= 3) out.push({ level: 'warn', title: `体の位置が投げるごとに動いています（左右${r1(bx)}cm・高さ${r1(by)}cm）`, detail: '1投ごとに同じ姿勢へ立ち直せているかを確認してください。' });
  }

  // Link an outlying dart to an outlying movement in the same throw.
  const usable = T.filter((t) => hits[t.n - 1] && !hits[t.n - 1].out);
  if (usable.length === 3) {
    let best = null;
    for (const t of usable) {
      const h = hits[t.n - 1];
      const others = usable.filter((u) => u !== t);
      const ox = mean(others.map((u) => hits[u.n - 1].x)) / 10;
      const oy = mean(others.map((u) => hits[u.n - 1].y)) / 10;
      const dx = h.x / 10 - ox;
      const dy = h.y / 10 - oy;
      const sep = Math.hypot(dx, dy);
      const pair = Math.hypot(hits[others[0].n - 1].x - hits[others[1].n - 1].x, hits[others[0].n - 1].y - hits[others[1].n - 1].y) / 10;
      if (sep < 4 || sep < pair * 1.3) continue;
      for (const def of METRICS) {
        if (!def.axis || !(def.key in FLOOR)) continue;
        const miss = def.axis === 'x' ? dx : dy;
        if (Math.abs(miss) < 2.5) continue;
        const diff = t.m[def.key] - mean(others.map((u) => u.m[def.key]));
        const z = Math.abs(diff) / FLOOR[def.key];
        if (z >= 1 && (!best || z > best.z)) best = { z, t, def, diff, dx, dy };
      }
    }
    if (best) {
      out.push({
        level: 'info',
        title: `${best.t.n}投目だけ「${best.def.label}」が他の2投と${r1(Math.abs(best.diff))}cm違います`,
        detail: `${best.t.n}投目の着弾は他の2本より${dirWords(best.dx, best.dy)}でした。関係があるかもしれませんが、1ラウンドだけでは偶然の可能性があります。履歴がたまると傾向として確認できます。`,
      });
    }
  }

  const trend = historyFindings(history);
  for (const f of trend) out.push(f);
  return out;
}

function pearson(xs, ys) {
  const n = xs.length;
  const mx = mean(xs), my = mean(ys);
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) { sxy += (xs[i] - mx) * (ys[i] - my); sxx += (xs[i] - mx) ** 2; syy += (ys[i] - my) ** 2; }
  return sxx > 0 && syy > 0 ? sxy / Math.sqrt(sxx * syy) : NaN;
}

export function historyStats(history) {
  const rows = [];
  for (const s of history) {
    for (const t of s.throws || []) {
      const h = s.hits?.[t.n - 1];
      if (h && !h.out && t.m) rows.push({ x: h.x / 10, y: h.y / 10, m: t.m, label: h.label });
    }
  }
  const n = rows.length;
  const stats = { n, rounds: history.length, cx: mean(rows.map((r) => r.x)), cy: mean(rows.map((r) => r.y)), meanDist: mean(rows.map((r) => Math.hypot(r.x, r.y))), bullRate: n ? rows.filter((r) => /BULL/.test(r.label)).length / n : NaN, corr: [] };
  if (n >= 15) {
    for (const def of METRICS) {
      if (!def.axis) continue;
      const xs = rows.map((r) => r.m[def.key]);
      const ys = rows.map((r) => (def.axis === 'x' ? r.x : r.y));
      if (xs.some((v) => !fin(v))) continue;
      const r = pearson(xs, ys);
      if (fin(r)) stats.corr.push({ key: def.key, label: def.label, axis: def.axis, r });
    }
    stats.corr.sort((a, b) => Math.abs(b.r) - Math.abs(a.r));
  }
  return stats;
}

export function historyFindings(history) {
  const out = [];
  const st = historyStats(history);
  if (st.n < 15) return out;
  out.push({ level: 'info', title: `これまでの${st.n}投：平均は${dirWords(st.cx, st.cy)}`, detail: `ブル率${Math.round(st.bullRate * 100)}%、ブル中心からの平均距離${r1(st.meanDist)}cm。` });
  const top = st.corr.find((c) => Math.abs(c.r) >= 0.45);
  if (top) {
    const dir = top.axis === 'x' ? (top.r > 0 ? '右' : '左') : (top.r > 0 ? '上' : '下');
    out.push({ level: 'info', title: `傾向：「${top.label}」が大きい投球ほど${dir}に外れやすい`, detail: `相関係数 ${top.r.toFixed(2)}（${st.n}投）。投数が増えるほど確かになります。` });
  }
  return out;
}
