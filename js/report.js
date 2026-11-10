// Result and history screens.
import { METRICS, SKILLS, gradeOf, landingSummary, historyStats, historyFindings } from './analysis.js';
import { drawBoard, drawHits, fitView, hitText, THROW_COLORS } from './board.js';

const NS = 'http://www.w3.org/2000/svg';
const fin = Number.isFinite;
const f1 = (v) => (fin(v) ? (Math.round(v * 10) / 10).toFixed(1) : '—');

function h(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

function svgEl(name, attrs, parent) {
  const e = document.createElementNS(NS, name);
  for (const [k, v] of Object.entries(attrs || {})) e.setAttribute(k, v);
  if (parent) parent.appendChild(e);
  return e;
}

function offsetWords(dx, dy) {
  const a = `${dx >= 0 ? '右' : '左'}${f1(Math.abs(dx))}cm`;
  const b = `${dy >= 0 ? '上' : '下'}${f1(Math.abs(dy))}cm`;
  return `${a}・${b}`;
}

function stat(k, v) {
  const d = h('div', 'stat');
  d.append(h('div', 'k', k), h('div', 'v', v));
  return d;
}

function findingList(findings) {
  const card = h('div', 'card');
  card.append(h('h3', null, 'コメント'));
  for (const f of findings) {
    const row = h('div', `finding ${f.level}`);
    row.append(h('div', 'mark', f.level === 'good' ? '✓' : f.level === 'warn' ? '!' : 'i'));
    const body = h('div');
    body.append(h('div', 'ttl', f.title), h('div', 'dtl', f.detail));
    row.append(body);
    card.append(row);
  }
  return card;
}

function boardCard(title, hits, opts) {
  const card = h('div', 'card');
  card.append(h('h3', null, title));
  const wrap = h('div');
  wrap.style.maxWidth = '420px';
  wrap.style.margin = '0 auto';
  const { svg, marks } = drawBoard(wrap);
  if (opts && opts.fit) {
    const half = fitView(svg, marks, hits);
    if (half < 230) card.append(h('p', 'note', 'ダーツが見やすいように、ブル周辺を拡大して表示しています。'));
  } else {
    drawHits(marks, hits, opts);
  }
  card.insertBefore(wrap, card.children[1] || null);
  return card;
}

function skillBars(skills, avg) {
  const box = h('div', 'skills');
  for (const def of SKILLS) {
    const v = skills[def.key];
    const row = h('div', 'skill');
    row.append(h('div', null, def.label));
    const track = h('div', 'track');
    const fill = h('div', `fill ${v == null ? '' : v >= 80 ? '' : v >= 60 ? 'mid' : 'low'}`);
    fill.style.width = `${v == null ? 0 : Math.max(3, v)}%`;
    track.append(fill);
    const val = h('div', 'val', v == null ? '—' : `${v} `);
    if (v != null) {
      val.append(h('small', null, gradeOf(v)));
      const a = avg && avg[def.key];
      if (fin(a) && Math.abs(v - a) >= 3) val.append(h('span', v > a ? 'up' : 'down', v > a ? ' ↑' : ' ↓'));
    }
    row.append(track, val);
    box.append(row);
  }
  return box;
}

function pastScores(history) {
  const rows = history.filter((x) => x.score && fin(x.score.total));
  const totals = rows.map((x) => x.score.total);
  const avg = {};
  for (const def of SKILLS) {
    const vals = rows.map((x) => x.score.skills && x.score.skills[def.key]).filter(fin);
    avg[def.key] = vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : NaN;
  }
  return { n: totals.length, totals, best: totals.length ? Math.max(...totals) : NaN, mean: totals.length ? totals.reduce((a, b) => a + b, 0) / totals.length : NaN, avg };
}

function scoreCard(score, history) {
  const card = h('div', 'card');
  card.append(h('h3', null, 'スコア'));
  const wrap = h('div', 'score');
  const left = h('div');
  const main = h('div', 'score-main');
  main.append(h('div', 'score-num', score.total == null ? '—' : String(score.total)), h('div', 'score-grade', score.grade || ''));
  left.append(main);
  const past = pastScores(history);
  const sub = h('div', 'score-sub');
  if (past.n && score.total != null) {
    const d = Math.round(score.total - past.mean);
    sub.append(document.createTextNode(`これまでの平均 ${Math.round(past.mean)}点（`), h('span', d >= 0 ? 'up' : 'down', `${d >= 0 ? '+' : ''}${d}`), document.createTextNode(`）・最高 ${Math.round(past.best)}点`));
    if (score.total > past.best) sub.append(h('span', 'best', '自己ベスト'));
  } else {
    sub.textContent = '100点満点。保存していくと、平均や自己ベストと比べられます。';
  }
  left.append(sub);
  wrap.append(left, skillBars(score.skills, past.n ? past.avg : null));
  card.append(wrap);
  card.append(h('p', 'note', '着弾（正確さ・グルーピング）40%、フォーム5項目60%で計算した目安です。矢印はこれまでの平均との比較です。'));
  return card;
}

function coachCard(coach, review) {
  const card = h('div', 'card coach');
  if (review) {
    const r = h('div', 'review');
    const word = review.verdict === 'better' ? '良くなりました' : review.verdict === 'worse' ? '今回は悪くなりました' : 'ほぼ同じでした';
    r.append(h('div', 'k', '前回の課題の結果'));
    const line = h('div');
    line.append(document.createTextNode(`「${review.title}」：${review.label} ${f1(review.before)}${review.unit} → ${f1(review.now)}${review.unit}　`), h('span', review.verdict === 'better' ? 'up' : review.verdict === 'worse' ? 'down' : null, word));
    if (review.reached) line.append(h('span', 'best', '目標達成'));
    r.append(line);
    card.append(r);
  }
  if (coach.focus) {
    card.append(h('div', 'k', '次はこうしてみよう'), h('div', 't', coach.focus.title), h('div', 'c', coach.focus.cue), h('div', 'w', coach.focus.why));
  }
  if (coach.also && coach.also.length) card.append(h('div', 'also', `ほかに気になった点：${coach.also.join('／')}。まずは上の1つだけに集中するのがおすすめです。`));
  return card;
}

function scoreTrend(history) {
  const past = pastScores(history);
  const card = h('div', 'card');
  card.append(h('h3', null, 'スコアの推移'));
  if (past.n < 2) {
    card.append(h('p', 'note', '2ラウンド以上保存すると、スコアの推移を表示します。'));
    return card;
  }
  const W = 600, H = 180, L = 34, R = 12, T = 12, B = 24;
  const svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': 'スコアの推移' });
  svg.style.width = '100%';
  const X = (i) => L + (W - L - R) * (past.n === 1 ? 0.5 : i / (past.n - 1));
  const Y = (v) => T + (H - T - B) * (1 - v / 100);
  for (const v of [0, 50, 100]) {
    svgEl('line', { x1: L, x2: W - R, y1: Y(v), y2: Y(v), stroke: '#343b4b', 'stroke-width': 1 }, svg);
    const t = svgEl('text', { x: L - 6, y: Y(v) + 4, 'font-size': 12, fill: '#969eac', 'text-anchor': 'end' }, svg);
    t.textContent = v;
  }
  svgEl('polyline', { points: past.totals.map((v, i) => `${X(i).toFixed(1)},${Y(v).toFixed(1)}`).join(' '), fill: 'none', stroke: '#36d3c4', 'stroke-width': 2, 'stroke-linejoin': 'round' }, svg);
  past.totals.forEach((v, i) => svgEl('circle', { cx: X(i), cy: Y(v), r: past.n > 40 ? 2 : 4, fill: '#36d3c4' }, svg));
  const lab = svgEl('text', { x: W - R, y: H - 6, 'font-size': 12, fill: '#969eac', 'text-anchor': 'end' }, svg);
  lab.textContent = `${past.n}ラウンド目`;
  card.append(svg);
  const recent = past.totals.slice(-5);
  const rmean = recent.reduce((a, b) => a + b, 0) / recent.length;
  card.append(h('p', 'note', `平均 ${Math.round(past.mean)}点・最高 ${Math.round(past.best)}点・直近${recent.length}ラウンドの平均 ${Math.round(rmean)}点`));
  card.append(skillBars(Object.fromEntries(SKILLS.map((d) => [d.key, fin(past.avg[d.key]) ? Math.round(past.avg[d.key]) : null])), null));
  card.append(h('p', 'note', '棒は項目ごとのこれまでの平均です。一番低い項目が、今の伸びしろです。'));
  return card;
}

function pathPlot(analysis) {
  const card = h('div', 'card');
  card.append(h('h3', null, '手首と肘の通り道（ボード側から見た図）'));
  const svg = svgEl('svg', { viewBox: '-24 -20 48 52', role: 'img', 'aria-label': '手首と肘の通り道' });
  svg.style.width = '100%';
  svg.style.maxWidth = '460px';
  svg.style.display = 'block';
  svg.style.margin = '0 auto';
  for (let x = -20; x <= 20; x += 10) svgEl('line', { x1: x, y1: -20, x2: x, y2: 32, stroke: '#343b4b', 'stroke-width': 0.15 }, svg);
  for (let y = -20; y <= 30; y += 10) svgEl('line', { x1: -24, y1: y, x2: 24, y2: y, stroke: '#343b4b', 'stroke-width': 0.15 }, svg);
  svgEl('ellipse', { cx: 0, cy: 2.5, rx: 8, ry: 10.5, fill: 'none', stroke: '#969eac', 'stroke-width': 0.3 }, svg);
  svgEl('circle', { cx: -3.15, cy: 0, r: 0.9, fill: '#ffd34a' }, svg);
  svgEl('circle', { cx: 3.15, cy: 0, r: 0.9, fill: '#969eac' }, svg);
  const lab = (x, y, s, anchor) => { const t = svgEl('text', { x, y, 'font-size': 1.9, fill: '#969eac', 'text-anchor': anchor }, svg); t.textContent = s; };
  lab(-23.5, 31, '← あなたの右側', 'start');
  lab(23.5, 31, 'あなたの左側 →', 'end');
  lab(-3.15, -2.2, '右目', 'middle');
  lab(3.15, -2.2, '左目', 'middle');
  const { face, cmPerPx: cm } = analysis;
  analysis.throws.forEach((t, k) => {
    const color = THROW_COLORS[k % 3];
    const pts = (ix, iy) => t.path.filter((p) => fin(p[ix]) && fin(p[iy]) && p[0] <= 0.03).map((p) => `${((p[ix] - face.x) * cm).toFixed(2)},${((p[iy] - face.y) * cm).toFixed(2)}`).join(' ');
    svgEl('polyline', { points: pts(3, 4), fill: 'none', stroke: color, 'stroke-width': 0.35, 'stroke-dasharray': '0.9 0.7', 'stroke-linejoin': 'round' }, svg);
    svgEl('polyline', { points: pts(1, 2), fill: 'none', stroke: color, 'stroke-width': 0.55, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }, svg);
    const P = (o) => ({ cx: ((o.wx - face.x) * cm).toFixed(2), cy: ((o.wy - face.y) * cm).toFixed(2) });
    svgEl('circle', { ...P(t.px.ready), r: 1, fill: '#12161e', stroke: color, 'stroke-width': 0.45 }, svg);
    svgEl('circle', { ...P(t.px.top), r: 1, fill: color }, svg);
  });
  card.append(svg);
  const lg = h('div', 'legend');
  analysis.throws.forEach((t, k) => {
    const s = h('span');
    const c = h('i', 'chip');
    c.style.background = THROW_COLORS[k % 3];
    s.append(c, document.createTextNode(`${t.n}投目`));
    lg.append(s);
  });
  lg.append(h('span', null, '実線＝手首　点線＝肘　○＝構え　●＝最高点　方眼＝10cm'));
  card.append(lg);
  return card;
}

function metricsTable(analysis) {
  const card = h('div', 'card');
  card.append(h('h3', null, '投球ごとの数値（cm）'));
  const table = h('table', 'metrics');
  const head = h('tr');
  head.append(h('th', null, '項目'));
  analysis.throws.forEach((t) => head.append(h('th', null, `${t.n}投目`)));
  const thead = h('thead');
  thead.append(head);
  table.append(thead);
  const body = h('tbody');
  for (const def of METRICS) {
    const tr = h('tr');
    const td = h('td', null, def.label);
    td.append(h('span', 'help', def.help));
    tr.append(td);
    analysis.throws.forEach((t) => tr.append(h('td', null, f1(t.m[def.key]))));
    body.append(tr);
  }
  table.append(body);
  card.append(table);
  card.append(h('p', 'note', '数値は画面上の位置を前腕の長さからcmに換算した目安です。誤差はおよそ±1〜2cmあり、高さ方向は左右方向より粗くなります。'));
  return card;
}

async function drawKeyframe(canvas, frames, index, view, crop, mark) {
  let i = index;
  for (let d = 0; d < 6 && !(frames[i] && frames[i].img); d++) i = Math.min(frames.length - 1, index + (d % 2 ? -1 : 1) * Math.ceil((d + 1) / 2));
  const blob = frames[i] && frames[i].img;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  if (!blob) return;
  const bmp = await createImageBitmap(blob);
  const s = bmp.width / view.w;
  ctx.drawImage(bmp, crop.x * s, crop.y * s, crop.size * s, crop.size * s, 0, 0, canvas.width, canvas.height);
  bmp.close();
  const k = canvas.width / crop.size;
  const X = (x) => (x - crop.x) * k, Y = (y) => (y - crop.y) * k;
  ctx.setLineDash([10, 8]);
  ctx.lineWidth = 3;
  ctx.strokeStyle = '#ffd34a';
  ctx.beginPath();
  ctx.moveTo(X(mark.lineX), 0);
  ctx.lineTo(X(mark.lineX), canvas.height);
  ctx.stroke();
  ctx.setLineDash([]);
  if (fin(mark.x) && fin(mark.y)) {
    ctx.lineWidth = 5;
    ctx.strokeStyle = mark.color;
    ctx.beginPath();
    ctx.arc(X(mark.x), Y(mark.y), mark.r * k, 0, Math.PI * 2);
    ctx.stroke();
  }
}

function keyframes(analysis, frames, view) {
  const card = h('div', 'card');
  card.append(h('h3', null, '3つの瞬間（黄色の点線＝構えた時の手首の位置）'));
  const L = analysis.forearmPx;
  const size = Math.min(2.7 * L, view.w, view.h);
  const jobs = [];
  for (const t of analysis.throws) {
    const title = h('div', 'kf-title');
    const chip = h('i', 'chip');
    chip.style.background = THROW_COLORS[(t.n - 1) % 3];
    title.append(chip, document.createTextNode(`${t.n}投目`));
    card.append(title);
    const crop = { size, x: Math.max(0, Math.min(view.w - size, analysis.face.x - size / 2)), y: Math.max(0, Math.min(view.h - size, analysis.face.y - 0.38 * size)) };
    const side = (v) => `${v >= 0 ? '右目側' : '左目側'}へ${f1(Math.abs(v))}cm`;
    const shots = [
      { idx: t.iReady, cap: '構え', mark: { x: t.px.ready.wx, y: t.px.ready.wy, color: '#36d3c4' } },
      { idx: t.iPre, cap: `振り出す直前（${side(t.m.preShift)}）`, mark: { x: t.px.pre.wx, y: t.px.pre.wy, color: '#f5785a' } },
      { idx: t.iPeak, cap: `最高点（横のずれ ${side(t.m.swingShift)}）`, mark: { x: t.px.top.wx, y: t.px.top.wy, color: '#f5785a' } },
    ];
    const row = h('div', 'kf-row');
    for (const sh of shots) {
      const cell = h('div');
      const cv = document.createElement('canvas');
      cv.width = 360;
      cv.height = 360;
      cell.append(cv, h('div', 'kf-cap', sh.cap));
      row.append(cell);
      jobs.push(drawKeyframe(cv, frames, sh.idx, view, crop, { ...sh.mark, lineX: t.px.ready.wx, r: 0.22 * L }).catch(() => {}));
    }
    card.append(row);
  }
  return { card, done: Promise.all(jobs) };
}

export function renderResult(root, data) {
  const { analysis, hits, findings, frames, view, score, coach, review, history } = data;
  root.replaceChildren();
  const land = landingSummary(hits);
  if (coach && (coach.focus || review)) root.append(coachCard(coach, review));
  if (score) root.append(scoreCard(score, history || []));
  const cards = h('div', 'cards');
  cards.append(
    stat('着弾の中心', land ? offsetWords(land.cx, land.cy) : '—'),
    stat('ブル中心からの平均距離', land ? `${f1(land.meanDist)}cm` : '—'),
    stat('ブル', land ? `${land.bulls} / ${hits.length}本` : '—'),
    stat('検出した投球', `${analysis.throws.length}投（毎秒${fin(analysis.fps) ? Math.round(analysis.fps) : '—'}コマ）`),
  );
  root.append(cards);
  const two = h('div', 'two');
  const bc = boardCard('刺さった位置', hits, { fit: true });
  const list = h('ol', 'hit-list');
  list.style.marginTop = '10px';
  hits.forEach((x) => list.append(h('li', null, hitText(x))));
  bc.append(list);
  two.append(bc, findingList(findings));
  root.append(two);
  let done = Promise.resolve();
  if (analysis.throws.length) {
    if (frames && frames.some((f) => f.img)) {
      const kf = keyframes(analysis, frames, view);
      root.append(kf.card);
      done = kf.done;
    }
    const two2 = h('div', 'two');
    two2.append(pathPlot(analysis), metricsTable(analysis));
    root.append(two2);
  }
  return done;
}

export function renderHistory(root, history, onClear) {
  root.replaceChildren();
  const st = historyStats(history);
  const cards = h('div', 'cards');
  cards.append(
    stat('ラウンド', `${st.rounds}`),
    stat('位置を記録した投数', `${st.n}`),
    stat('ブル率', st.n ? `${Math.round(st.bullRate * 100)}%` : '—'),
    stat('平均のずれ', st.n ? offsetWords(st.cx, st.cy) : '—'),
    stat('ブル中心からの平均距離', st.n ? `${f1(st.meanDist)}cm` : '—'),
  );
  root.append(cards);
  if (history.length) root.append(scoreTrend(history));
  if (!history.length) {
    root.append(h('p', 'note', 'まだ保存されたラウンドがありません。解析結果の画面で「保存して次へ」を押すと、ここにたまっていきます。'));
    return;
  }
  const two = h('div', 'two');
  const all = [];
  for (const s of history) for (const x of s.hits || []) all.push(x);
  const card = h('div', 'card');
  card.append(h('h3', null, 'これまでの着弾'));
  const wrap = h('div');
  wrap.style.maxWidth = '420px';
  wrap.style.margin = '0 auto';
  const { marks } = drawBoard(wrap);
  drawHits(marks, all, { small: true, color: '#ffd34a' });
  card.append(wrap);
  two.append(card);

  const tcard = h('div', 'card');
  tcard.append(h('h3', null, '動きと着弾の関係'));
  if (st.n < 15) {
    tcard.append(h('p', 'note', `15投以上たまると、どの動きが外れ方と関係しているかを表示します（現在${st.n}投）。`));
  } else {
    for (const f of historyFindings(history)) {
      const row = h('div', 'finding info');
      row.append(h('div', 'mark', 'i'));
      const body = h('div');
      body.append(h('div', 'ttl', f.title), h('div', 'dtl', f.detail));
      row.append(body);
      tcard.append(row);
    }
    const table = h('table', 'metrics');
    const thead = h('thead');
    const hr = h('tr');
    hr.append(h('th', null, '動き'), h('th', null, '外れる方向'), h('th', null, '相関'));
    thead.append(hr);
    table.append(thead);
    const tb = h('tbody');
    for (const c of st.corr.slice(0, 6)) {
      const tr = h('tr');
      const dir = c.axis === 'x' ? (c.r > 0 ? '大きいほど右' : '大きいほど左') : (c.r > 0 ? '大きいほど上' : '大きいほど下');
      tr.append(h('td', null, c.label), h('td', null, dir), h('td', null, c.r.toFixed(2)));
      tb.append(tr);
    }
    table.append(tb);
    tcard.append(table);
    tcard.append(h('p', 'note', '相関は−1〜1の値で、0.5前後から関係がありそうと見てよい目安です。投数が少ないうちは偶然でも大きく出ます。'));
  }
  two.append(tcard);
  root.append(two);

  const lcard = h('div', 'card');
  lcard.append(h('h3', null, 'ラウンド一覧'));
  for (const s of [...history].reverse().slice(0, 60)) {
    const row = h('div', 'sess');
    const d = new Date(s.ts);
    const when = `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    const labels = (s.hits || []).map((x) => (x.out ? '×' : x.label.replace('D-BULL', 'インブル').replace('S-BULL', 'ブル'))).join('　');
    const shifts = (s.throws || []).map((t) => t.m && t.m.preShift).filter(fin);
    const avg = shifts.length ? shifts.reduce((a, b) => a + b, 0) / shifts.length : NaN;
    row.append(h('span', null, when), h('span', null, labels), h('span', null, fin(avg) ? `横移動 ${f1(avg)}cm` : ''));
    lcard.append(row);
  }
  const clear = h('button', 'ghost', '履歴をすべて消す');
  clear.style.marginTop = '12px';
  clear.addEventListener('click', onClear);
  lcard.append(clear);
  root.append(lcard);
}
