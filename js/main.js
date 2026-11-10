// App flow: camera preview -> timed capture of three throws -> board input -> analysis -> history.
import { initPose, detect, poseInfo } from './pose.js';
import { analyzeCapture, makeFindings, scoreRound, coachRound, reviewFocus, LM } from './analysis.js';
import { BoardInput, hitText } from './board.js';
import { renderResult, renderHistory } from './report.js';
import { loadSettings, saveSettings, loadHistory, addSession, clearHistory, loadFocus, saveFocus, forearmCm, exportJson } from './store.js';

const VERSION = '0.2.0';
const THROWS = 3;
const $ = (id) => document.getElementById(id);
const qs = new URLSearchParams(location.search);

const state = {
  settings: loadSettings(),
  screen: 'home',
  stream: null,
  camOk: false,
  poseOk: false,
  phase: 'idle', // idle | prep | rec
  cap: null,
  frames: [],
  lastLm: null,
  lastSeen: 0,
  fps: 0,
  lastT: 0,
  analysis: null,
  hits: [],
  board: null,
  audio: null,
  wake: null,
  view: { w: 0, h: 0 },
  notice: null,
};
// URL overrides, used for testing
for (const [k, key] of [['prep', 'prepSec'], ['throw', 'throwSec']]) if (qs.has(k)) state.settings[key] = Number(qs.get(k));
for (const k of ['delegate', 'model', 'handed']) if (qs.has(k)) state.settings[k] = qs.get(k);
if (qs.get('sound') === '0') { state.settings.sound = false; state.settings.voice = false; }
window.__app = state;

const cam = $('cam');
const overlay = $('overlay');
const thumb = document.createElement('canvas');

function showError(msg) {
  const bar = $('errbar');
  bar.textContent = `エラー：${msg}`;
  bar.hidden = false;
  clearTimeout(showError.timer);
  showError.timer = setTimeout(() => { bar.hidden = true; }, 12000);
}
window.addEventListener('error', (e) => showError(e.message || String(e.error)));
window.addEventListener('unhandledrejection', (e) => showError((e.reason && e.reason.message) || String(e.reason)));

function show(name) {
  state.screen = name;
  for (const s of document.querySelectorAll('.screen')) s.classList.toggle('active', s.id === `scr-${name}`);
}

function check(id, status, text) {
  const li = $(id);
  li.className = status;
  if (text) li.querySelector('.txt').textContent = text;
}

function message(text) {
  const m = $('stage-msg');
  m.textContent = text || '';
  m.hidden = !text;
}

// ---------- camera and pose ----------

async function startCamera() {
  check('chk-cam', 'wait', 'カメラ：起動中');
  $('btn-cam').hidden = true;
  if (state.stream) for (const t of state.stream.getTracks()) t.stop();
  state.camOk = false;
  try {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) throw new Error('このブラウザではカメラを使えません');
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { facingMode: state.settings.facing, width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } },
    });
    state.stream = stream;
    cam.srcObject = stream;
    await cam.play();
    state.view = { w: cam.videoWidth, h: cam.videoHeight };
    overlay.width = cam.videoWidth;
    overlay.height = cam.videoHeight;
    thumb.width = 640;
    thumb.height = Math.round(640 * cam.videoHeight / cam.videoWidth);
    const st = stream.getVideoTracks()[0].getSettings();
    state.camOk = true;
    check('chk-cam', 'ok', `カメラ：${cam.videoWidth}×${cam.videoHeight}${st.frameRate ? `・毎秒${Math.round(st.frameRate)}コマ` : ''}`);
  } catch (e) {
    check('chk-cam', 'ng', 'カメラ：使えません');
    message(`カメラを開始できませんでした（${e.message}）。ブラウザの設定でカメラを許可してから「カメラを開始」を押してください。`);
    $('btn-cam').hidden = false;
  }
  refreshStart();
}

async function startPose() {
  state.poseOk = false;
  check('chk-model', 'wait', '姿勢モデル：読み込み中（初回は時間がかかります）');
  refreshStart();
  try {
    const info = await initPose(state.settings.model, state.settings.delegate);
    state.poseOk = true;
    check('chk-model', 'ok', `姿勢モデル：${info.model === 'full' ? '標準' : '軽量'}・${info.delegate}`);
  } catch (e) {
    check('chk-model', 'ng', '姿勢モデル：読み込めません');
    showError(`姿勢モデルを読み込めませんでした（${e.message}）`);
  }
  refreshStart();
}

function refreshStart() {
  $('btn-start').disabled = !(state.camOk && state.poseOk && state.phase === 'idle');
}

function armState(lm) {
  if (!lm) return 'none';
  const ids = state.settings.handed === 'right' ? [LM.rSh, LM.rEl, LM.rWr] : [LM.lSh, LM.lEl, LM.lWr];
  const { w, h } = state.view;
  for (const i of ids) {
    const p = lm[i];
    if (!p || p[2] < 0.5 || p[0] < 0 || p[0] > w || p[1] < 0 || p[1] > h) return 'partial';
  }
  return 'ok';
}

function drawOverlay(lm) {
  const ctx = overlay.getContext('2d');
  ctx.clearRect(0, 0, overlay.width, overlay.height);
  if (!lm) return;
  const lw = Math.max(3, overlay.width / 220);
  const right = state.settings.handed === 'right';
  const seg = (a, b, color, width) => {
    if (!lm[a] || !lm[b]) return;
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(lm[a][0], lm[a][1]);
    ctx.lineTo(lm[b][0], lm[b][1]);
    ctx.stroke();
  };
  seg(LM.lSh, LM.rSh, 'rgba(255,255,255,0.7)', lw);
  const [S, E, W] = right ? [LM.rSh, LM.rEl, LM.rWr] : [LM.lSh, LM.lEl, LM.lWr];
  const [S2, E2, W2] = right ? [LM.lSh, LM.lEl, LM.lWr] : [LM.rSh, LM.rEl, LM.rWr];
  seg(S2, E2, 'rgba(255,255,255,0.45)', lw);
  seg(E2, W2, 'rgba(255,255,255,0.45)', lw);
  seg(S, E, '#36d3c4', lw * 1.6);
  seg(E, W, '#36d3c4', lw * 1.6);
  ctx.fillStyle = '#ffd34a';
  for (const i of [LM.nose, LM.lEye, LM.rEye, S, E, W]) {
    if (!lm[i]) continue;
    ctx.beginPath();
    ctx.arc(lm[i][0], lm[i][1], lw * 1.2, 0, Math.PI * 2);
    ctx.fill();
  }
}

function onFrame() {
  schedule();
  if (state.screen !== 'home' || !state.camOk || !state.poseOk || cam.readyState < 2 || document.hidden) return;
  const now = performance.now();
  let lm = null;
  try { lm = detect(cam, now); } catch (e) { showError(e.message); return; }
  if (state.lastT) {
    const inst = 1000 / Math.max(1, now - state.lastT);
    state.fps = state.fps ? state.fps * 0.9 + inst * 0.1 : inst;
  }
  state.lastT = now;
  state.lastLm = lm;
  if (lm) state.lastSeen = now;
  drawOverlay(lm);
  const c = state.cap;
  if (state.phase === 'rec' && c && now >= c.recStart && now <= c.end) {
    const frame = { t: Math.round(now - c.t0), lm, img: null };
    state.frames.push(frame);
    try {
      thumb.getContext('2d').drawImage(cam, 0, 0, thumb.width, thumb.height);
      thumb.toBlob((b) => { frame.img = b; }, 'image/jpeg', 0.72);
    } catch (e) { /* preview frames are optional */ }
  }
}

function schedule() {
  if (cam.requestVideoFrameCallback) cam.requestVideoFrameCallback(onFrame);
  else requestAnimationFrame(onFrame);
}

function statusTick() {
  if (state.screen !== 'home') return;
  if (state.phase !== 'idle') { message(''); return; }
  const now = performance.now();
  if (!state.camOk || !state.poseOk) return;
  const seen = now - state.lastSeen < 700;
  check('chk-pose', seen ? 'ok' : 'ng', seen ? '体の検出：できています' : '体の検出：見つかりません');
  const a = seen ? armState(state.lastLm) : 'none';
  check('chk-arm', a === 'ok' ? 'ok' : 'ng', a === 'ok' ? '投げる腕：肩・肘・手首が映っています' : '投げる腕：肘まで映るように調整してください');
  const f = state.fps;
  check('chk-fps', f >= 18 ? 'ok' : f >= 12 ? 'wait' : 'ng', `処理速度：毎秒${f ? Math.round(f) : '—'}コマ${f && f < 12 ? '（遅い：設定で軽量モデルへ）' : ''}`);
  if (state.notice) { message(state.notice); return; }
  message(seen && a === 'ok' ? '準備ができています。スタートを押して、投げる位置へ移動してください。' : '投げる位置に立ち、顔と投げる腕の肘までが映るように調整してください。');
}

// ---------- capture ----------

function beep(freq, dur, delay = 0) {
  if (!state.settings.sound || !state.audio) return;
  try {
    const ac = state.audio;
    const o = ac.createOscillator();
    const g = ac.createGain();
    o.frequency.value = freq;
    o.connect(g);
    g.connect(ac.destination);
    const t = ac.currentTime + delay;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.7, t + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.start(t);
    o.stop(t + dur + 0.05);
  } catch (e) { /* sound is optional */ }
}

function say(text) {
  if (!state.settings.voice || !('speechSynthesis' in window)) return;
  try {
    const u = new SpeechSynthesisUtterance(text);
    u.lang = 'ja-JP';
    u.rate = 1.15;
    speechSynthesis.cancel();
    speechSynthesis.speak(u);
  } catch (e) { /* voice is optional */ }
}

async function startCapture() {
  if (state.phase !== 'idle') return;
  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (AC && !state.audio) state.audio = new AC();
    if (state.audio && state.audio.state === 'suspended') await state.audio.resume();
  } catch (e) { /* continue without sound */ }
  try { if (navigator.wakeLock) state.wake = await navigator.wakeLock.request('screen'); } catch (e) { /* optional */ }
  const prep = Math.max(1, state.settings.prepSec) * 1000;
  const win = Math.max(2, state.settings.throwSec) * 1000;
  const start = performance.now();
  const t0 = start + prep;
  const fc = loadFocus();
  state.cap = { start, t0, win, recStart: t0 - 1000, end: t0 + THROWS * win + 700, step: -99, focus: fc && fc.key !== 'keep' ? fc.title : null };
  state.frames = [];
  state.notice = null;
  message('');
  state.phase = 'rec';
  $('cap').hidden = false;
  refreshStart();
  say('準備してください');
  requestAnimationFrame(captureTick);
}

function captureTick() {
  const c = state.cap;
  if (state.phase !== 'rec' || !c) return;
  const now = performance.now();
  const cap = $('cap');
  if (now < c.t0) {
    const left = Math.ceil((c.t0 - now) / 1000);
    cap.classList.remove('go');
    $('cap-label').textContent = '準備';
    $('cap-big').textContent = left;
    $('cap-sub').textContent = c.focus ? `課題：${c.focus}` : '投げる位置で構えてください';
    $('cap-fill').style.transform = `scaleX(${(c.t0 - now) / (c.t0 - c.start)})`;
    if (left <= 3 && c.step !== -left) { c.step = -left; beep(520, 0.12); }
  } else if (now < c.t0 + THROWS * c.win) {
    const k = Math.floor((now - c.t0) / c.win);
    const left = c.win - ((now - c.t0) - k * c.win);
    cap.classList.add('go');
    $('cap-label').textContent = '投げてください';
    $('cap-big').textContent = `${k + 1}投目`;
    $('cap-sub').textContent = `残り${Math.ceil(left / 1000)}秒`;
    $('cap-fill').style.transform = `scaleX(${left / c.win})`;
    if (c.step !== k) { c.step = k; beep(980, 0.28); say(`${k + 1}投目`); }
  } else if (now < c.end) {
    if (c.step !== 99) { c.step = 99; beep(700, 0.15); beep(700, 0.15, 0.22); say('終了です'); }
    cap.classList.remove('go');
    $('cap-label').textContent = '';
    $('cap-big').textContent = '終了';
    $('cap-sub').textContent = '解析しています…';
    $('cap-fill').style.transform = 'scaleX(0)';
  } else {
    finishCapture();
    return;
  }
  requestAnimationFrame(captureTick);
}

function endCaptureUi() {
  state.phase = 'idle';
  state.cap = null;
  $('cap').hidden = true;
  if (state.wake) { try { state.wake.release(); } catch (e) { /* ignore */ } state.wake = null; }
  refreshStart();
}

function finishCapture() {
  endCaptureUi();
  const frames = state.frames;
  const res = analyzeCapture(frames, { handed: state.settings.handed, forearmCm: forearmCm(state.settings.heightCm), throws: THROWS });
  state.analysis = res;
  if (!res.throws.length) {
    const why = res.tracked < res.frames * 0.3 ? '体をほとんど検出できませんでした。' : '投げる動きを見つけられませんでした。';
    state.notice = `${why}顔と投げる腕の肘までが映っているか、利き手の設定が合っているかを確認して、もう一度試してください。（記録${res.frames}コマ）`;
    message(state.notice);
    return;
  }
  openBoard();
}

// ---------- board input ----------

function openBoard() {
  state.hits = [];
  state.board = new BoardInput($('board-wrap'), THROWS, (hits) => {
    state.hits = hits;
    const list = $('hit-list');
    list.replaceChildren();
    for (let i = 0; i < THROWS; i++) {
      const li = document.createElement('li');
      li.textContent = hits[i] ? hitText(hits[i]) : 'まだ';
      if (!hits[i]) li.className = 'pending';
      list.appendChild(li);
    }
    $('btn-decide').disabled = hits.length < THROWS;
    $('btn-undo').disabled = hits.length === 0;
    $('btn-miss').disabled = hits.length >= THROWS;
    const n = state.analysis ? state.analysis.throws.length : 0;
    $('board-hint').textContent = hits.length < THROWS
      ? `${hits.length + 1}投目が刺さった場所をタップしてください。置いた印はドラッグで動かせます。近くに刺さった時は、2本指でつまむか「＋」で拡大できます。${n < THROWS ? `（検出できた投球は${n}投です）` : ''}`
      : '3本とも入力できました。よければ「決定」を押してください。';
  });
  state.board.refresh();
  show('board');
}

async function decide() {
  const hits = state.hits.slice(0, THROWS);
  const history = loadHistory();
  const findings = makeFindings(state.analysis, hits, history);
  const score = scoreRound(state.analysis, hits);
  const coach = coachRound(state.analysis, hits, score);
  const review = reviewFocus(loadFocus(), state.analysis, hits, score);
  state.round = { score, coach, review };
  show('result');
  $('result').scrollTop = 0;
  await renderResult($('result'), { analysis: state.analysis, hits, findings, frames: state.frames, view: state.view, score, coach, review, history });
}

function renderFocus() {
  const f = loadFocus();
  $('focus').hidden = !f;
  if (!f) return;
  $('focus-title').textContent = f.title;
  $('focus-cue').textContent = f.cue;
}

function round1(o) {
  const out = {};
  for (const [k, v] of Object.entries(o)) out[k] = typeof v === 'number' && Number.isFinite(v) ? Math.round(v * 10) / 10 : v;
  return out;
}

function saveRound() {
  const a = state.analysis;
  const ok = addSession({
    id: Date.now(),
    ts: new Date().toISOString(),
    version: VERSION,
    handed: a.handed,
    heightCm: state.settings.heightCm,
    view: state.view,
    cmPerPx: Math.round(a.cmPerPx * 1e4) / 1e4,
    fps: Math.round(a.fps * 10) / 10,
    pose: poseInfo(),
    hits: state.hits.slice(0, THROWS),
    score: state.round ? state.round.score : null,
    focus: state.round && state.round.coach.focus ? { key: state.round.coach.focus.key, title: state.round.coach.focus.title } : null,
    throws: a.throws.map((t) => ({ n: t.n, tPeak: Math.round(t.tPeak * 100) / 100, m: round1(t.m), ready: round1(t.px.ready), pre: round1(t.px.pre), top: round1(t.px.top) })),
  });
  if (!ok) showError('履歴を保存できませんでした（ブラウザの保存領域が使えません）');
  if (state.round && state.round.coach.focus) saveFocus(state.round.coach.focus);
  backHome();
}

function backHome() {
  state.frames = [];
  state.analysis = null;
  state.round = null;
  renderFocus();
  show('home');
}

// ---------- settings and history ----------

function openSettings() {
  const s = state.settings;
  $('set-handed').value = s.handed;
  $('set-height').value = s.heightCm;
  $('set-prep').value = s.prepSec;
  $('set-throw').value = s.throwSec;
  $('set-facing').value = s.facing;
  $('set-model').value = s.model;
  $('set-delegate').value = s.delegate;
  $('set-sound').checked = s.sound;
  $('set-voice').checked = s.voice;
  $('ver').textContent = `バージョン ${VERSION}`;
  $('dlg-settings').showModal();
}

function applySettings() {
  const old = state.settings;
  const num = (id, lo, hi, def) => { const v = Number($(id).value); return Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : def; };
  const s = {
    ...old,
    configured: true,
    handed: $('set-handed').value,
    heightCm: num('set-height', 120, 220, old.heightCm),
    prepSec: num('set-prep', 3, 30, old.prepSec),
    throwSec: num('set-throw', 3, 15, old.throwSec),
    facing: $('set-facing').value,
    model: $('set-model').value,
    delegate: $('set-delegate').value,
    sound: $('set-sound').checked,
    voice: $('set-voice').checked,
  };
  state.settings = s;
  saveSettings(s);
  if (s.facing !== old.facing) startCamera();
  if (s.model !== old.model || s.delegate !== old.delegate) startPose();
}

function openHistory() {
  renderHistory($('history'), loadHistory(), () => {
    if (window.confirm('保存した履歴をすべて消します。よろしいですか？')) { clearHistory(); renderFocus(); openHistory(); }
  });
  show('history');
}

// ---------- wiring ----------

$('btn-start').addEventListener('click', startCapture);
$('btn-cancel').addEventListener('click', () => { endCaptureUi(); state.frames = []; });
$('btn-cam').addEventListener('click', startCamera);
$('btn-settings').addEventListener('click', openSettings);
$('btn-settings-save').addEventListener('click', applySettings);
$('btn-history').addEventListener('click', openHistory);
$('btn-history-back').addEventListener('click', () => show('home'));
$('btn-export').addEventListener('click', exportJson);
$('btn-undo').addEventListener('click', () => state.board && state.board.undo());
$('btn-miss').addEventListener('click', () => state.board && state.board.miss());
$('btn-decide').addEventListener('click', decide);
$('btn-zoom-in').addEventListener('click', () => state.board && state.board.zoomIn());
$('btn-zoom-out').addEventListener('click', () => state.board && state.board.zoomOut());
$('btn-zoom-reset').addEventListener('click', () => state.board && state.board.resetView());
$('btn-board-back').addEventListener('click', backHome);
$('btn-save').addEventListener('click', saveRound);
$('btn-discard').addEventListener('click', backHome);
document.addEventListener('visibilitychange', () => {
  if (document.hidden) return;
  const track = state.stream && state.stream.getVideoTracks()[0];
  if (!track || track.readyState === 'ended') startCamera();
});

if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});

renderFocus();
setInterval(statusTick, 400);
schedule();
startCamera();
startPose();
if (!state.settings.configured && !qs.has('prep')) openSettings();
