// App flow: camera preview -> timed capture of three throws -> board input -> tracking check -> analysis -> history.
import { initPose, detect, poseInfo } from './pose.js';
import { analyzeCapture, applyKeyframes, makeFindings, scoreRound, coachRound, reviewFocus, LM } from './analysis.js';
import { BoardInput, hitText } from './board.js';
import { renderResult, renderHistory, disposeResult } from './report.js';
import { ConfirmView } from './confirm.js';
import { loadSettings, saveSettings, loadHistory, addSession, clearHistory, loadFocus, saveFocus, forearmCm, exportJson } from './store.js';

const VERSION = '0.3.0';
const THROWS = 3;
const $ = (id) => document.getElementById(id);
const qs = new URLSearchParams(location.search);
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

const state = {
  settings: loadSettings(),
  screen: 'home',
  // camera
  stream: null,
  cams: [],
  camInfo: null,
  camOk: false,
  camBusy: false,
  camToken: 0,
  camRetries: 0,
  lastRestart: 0,
  lastFrameAt: 0,
  loopId: 0,
  view: { w: 0, h: 0 },
  // pose
  poseOk: false,
  poseBusy: false,
  poseStale: false,
  poseToken: 0,
  poseErr: 0,
  poseRestart: 0,
  // capture
  phase: 'idle', // idle | rec
  cap: null,
  frames: [],
  crop: null,
  lastImgAt: 0,
  lastLm: null,
  lastSeen: 0,
  fps: 0,
  lastT: 0,
  // round
  capView: { w: 0, h: 0 },
  autoAnalysis: null,
  analysis: null,
  confirm: null,
  hits: [],
  board: null,
  round: null,
  audio: null,
  wake: null,
  notice: null,
  noticeUntil: 0,
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

function notify(text, ms = 0) {
  state.notice = text;
  state.noticeUntil = ms ? performance.now() + ms : 0;
  if (state.screen === 'home' && state.phase === 'idle') message(text);
}

// ---------- camera ----------

/** Which way a camera faces: 'user' (screen side), 'environment' (back) or '' (external / unknown). */
function camFacing(d) {
  try {
    const c = typeof d.getCapabilities === 'function' ? d.getCapabilities() : null;
    const f = c && c.facingMode && c.facingMode[0];
    if (f === 'user' || f === 'environment') return f;
  } catch (e) { /* fall back to the label */ }
  const s = d.label || '';
  if (/front|facing user|前面|内側/i.test(s)) return 'user';
  if (/back|rear|environment|背面|外側/i.test(s)) return 'environment';
  return '';
}

/** Lists the cameras the browser can see right now (empty until camera permission is given). */
async function refreshCameras() {
  let list = [];
  try { list = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'videoinput' && d.deviceId); } catch (e) { /* keep empty */ }
  const builtIn = list.some((d) => camFacing(d));
  const count = { user: 0, environment: 0, '': 0 };
  state.cams = list.map((d) => {
    const facing = camFacing(d);
    const n = ++count[facing];
    let raw = (d.label || '').replace(/\s*\([0-9a-f]{4}:[0-9a-f]{4}\)\s*$/i, '').trim();
    if (/^camera2? \d+, facing/i.test(raw)) raw = '';
    let name;
    if (facing === 'user') name = n === 1 ? '内側カメラ' : `内側カメラ ${n}`;
    else if (facing === 'environment') name = n === 1 ? '外側カメラ' : `外側カメラ ${n}`;
    else if (builtIn) name = raw ? `外付けカメラ（${raw}）` : (n === 1 ? '外付けカメラ' : `外付けカメラ ${n}`);
    else name = raw || `カメラ ${n}`;
    return { id: d.deviceId, label: d.label || '', facing, name };
  });
  return state.cams;
}

/** The camera chosen in the settings, if it is connected. */
function wantedCamera() {
  const s = state.settings;
  if (!s.cameraId && !s.cameraLabel) return null;
  return state.cams.find((c) => c.id === s.cameraId) || (s.cameraLabel ? state.cams.find((c) => c.label === s.cameraLabel) : null) || null;
}

/**
 * What to ask the camera for.
 * auto: the sharpest picture up to full HD, then the highest frame rate at that size.
 * fps:  the highest frame rate the camera has, at about 720p.
 * max:  the largest picture the camera has.
 */
function videoWish(mode, caps) {
  const fcap = caps && caps.frameRate && caps.frameRate.max;
  const wcap = caps && caps.width && caps.width.max;
  const hcap = caps && caps.height && caps.height.max;
  if (mode === 'max') return { width: { ideal: wcap || 4096 }, height: { ideal: hcap || 2160 }, frameRate: { ideal: Math.min(fcap || 60, 60) } };
  if (mode === 'fps') return { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: Math.min(fcap || 120, 240) } };
  return { width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: Math.min(fcap || 60, 60) } };
}

/** Once the camera is open its real limits are known: ask again with those. */
async function tuneTrack(track) {
  if (typeof track.getCapabilities !== 'function' || typeof track.applyConstraints !== 'function') return;
  let caps;
  try { caps = track.getCapabilities(); } catch (e) { return; }
  if (!caps) return;
  const mode = state.settings.camQuality;
  const wish = videoWish(mode, caps);
  const fcap = caps.frameRate && caps.frameRate.max;
  const tries = [];
  if (mode === 'fps' && fcap) tries.push({ ...wish, frameRate: { min: Math.floor(fcap * 0.9), ideal: fcap } });
  else if (mode !== 'fps' && fcap >= 30) tries.push({ ...wish, frameRate: { min: 24, ideal: wish.frameRate.ideal } });
  tries.push(wish);
  for (const c of tries) {
    try { await track.applyConstraints(c); return; } catch (e) { /* try the looser request */ }
  }
}

function stopStream(stream) {
  if (!stream) return;
  for (const t of stream.getTracks()) { try { t.stop(); } catch (e) { /* already stopped */ } }
}

function stopCamera() {
  const s = state.stream;
  state.stream = null;
  state.camOk = false;
  stopStream(s);
  try { cam.srcObject = null; } catch (e) { /* ignore */ }
}

async function openStream(want) {
  const md = navigator.mediaDevices;
  const wish = videoWish(state.settings.camQuality, null);
  const denied = (e) => e && (e.name === 'NotAllowedError' || e.name === 'SecurityError');
  if (want) {
    try { return await md.getUserMedia({ audio: false, video: { deviceId: { exact: want.id }, ...wish } }); } catch (e) { if (denied(e)) throw e; }
  }
  try { return await md.getUserMedia({ audio: false, video: { facingMode: 'user', ...wish } }); } catch (e) { if (denied(e)) throw e; }
  return md.getUserMedia({ audio: false, video: true });
}

function syncView() {
  const w = cam.videoWidth, h = cam.videoHeight;
  if (!w || !h || (state.view.w === w && state.view.h === h)) return false;
  state.view = { w, h };
  overlay.width = w;
  overlay.height = h;
  state.crop = null;
  return true;
}

function camLine() {
  const i = state.camInfo;
  if (!i || !state.camOk) return;
  check('chk-cam', 'ok', `カメラ：${i.name}・${state.view.w}×${state.view.h}${i.fps ? `・毎秒${i.fps}コマ` : ''}`);
}

async function startCamera() {
  const token = ++state.camToken;
  stopCamera();
  state.camBusy = true;
  check('chk-cam', 'wait', 'カメラ：起動中');
  $('btn-cam').hidden = true;
  refreshStart();
  let stream = null;
  try {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) throw new Error('このブラウザではカメラを使えません');
    await refreshCameras();
    const first = wantedCamera();
    stream = await openStream(first);
    if (token !== state.camToken) { stopStream(stream); return; }
    // camera names are only readable after permission is given: look again, and switch if the chosen one is there
    await refreshCameras();
    const want = wantedCamera();
    const openId = () => { const st = stream.getVideoTracks()[0].getSettings(); return (st && st.deviceId) || ''; };
    if (want && !first && want.id !== openId()) {
      stopStream(stream);
      stream = await openStream(want);
      if (token !== state.camToken) { stopStream(stream); return; }
    }
    const track = stream.getVideoTracks()[0];
    await tuneTrack(track);
    if (token !== state.camToken) { stopStream(stream); return; }
    state.stream = stream;
    cam.srcObject = stream;
    await cam.play();
    if (token !== state.camToken) return;
    track.addEventListener('ended', () => { if (state.stream === stream && !document.hidden) restartCamera(); });
    const st = track.getSettings ? track.getSettings() : {};
    const me = state.cams.find((c) => c.id === st.deviceId) || state.cams.find((c) => c.label && c.label === track.label);
    state.camInfo = { id: st.deviceId || (me ? me.id : ''), name: me ? me.name : 'カメラ', fps: st.frameRate ? Math.round(st.frameRate) : null };
    state.view = { w: 0, h: 0 };
    syncView();
    state.camOk = true;
    state.camRetries = 0;
    state.lastFrameAt = performance.now();
    state.lastT = 0;
    state.fps = 0;
    camLine();
    if (state.settings.cameraId && !want) notify('設定で選んだカメラが見つからないため、内側カメラを使っています。', 8000);
    kickLoop();
  } catch (e) {
    if (token !== state.camToken) { stopStream(stream); return; }
    stopStream(stream);
    state.stream = null;
    if (e && (e.name === 'NotAllowedError' || e.name === 'SecurityError')) state.camRetries = 99;
    check('chk-cam', 'ng', 'カメラ：使えません');
    notify(`カメラを開始できませんでした（${(e && e.message) || e}）。ブラウザの設定でカメラを許可してから「カメラを開始」を押してください。`);
    $('btn-cam').hidden = false;
  } finally {
    if (token === state.camToken) { state.camBusy = false; refreshStart(); }
  }
}

function restartCamera() {
  const now = performance.now();
  if (state.camBusy || document.hidden || now - state.lastRestart < 3000) return;
  state.lastRestart = now;
  startCamera();
}

/** The page went to the background: release the camera so that it starts cleanly when we come back. */
function suspend() {
  if (state.phase !== 'idle') cancelCapture('撮影の途中でほかのアプリに切り替わったため、中止しました。もう一度スタートを押してください。');
  state.camToken++;
  state.camBusy = false;
  stopCamera();
  check('chk-cam', 'wait', 'カメラ：停止中');
  refreshStart();
}

function resume() {
  if (document.hidden) return;
  if ((state.poseStale || !state.poseOk) && !state.poseBusy) startPose();
  if (state.camBusy) return;
  const track = state.stream && state.stream.getVideoTracks()[0];
  if (track && track.readyState === 'live' && !track.muted) return;
  state.camRetries = 0;
  state.lastRestart = performance.now();
  startCamera();
}

/** Safety net: the picture stopped although the camera should be running, or an earlier start failed. */
function watchdog(now) {
  if (document.hidden || state.camBusy || state.screen !== 'home') return;
  if (state.camOk) {
    if (now - state.lastFrameAt > 2500) restartCamera();
  } else if (state.camRetries < 3 && now - state.lastRestart > 5000) {
    state.camRetries++;
    restartCamera();
  }
}

async function onDeviceChange() {
  const before = new Set(state.cams.map((c) => c.id));
  await refreshCameras();
  if ($('dlg-settings').open) fillCameraSelect();
  if (!state.camInfo || state.camBusy || document.hidden) return;
  const added = state.cams.filter((c) => !before.has(c.id));
  const activeGone = state.camOk && state.camInfo.id && !state.cams.some((c) => c.id === state.camInfo.id);
  const want = wantedCamera();
  if (activeGone) {
    if (state.phase !== 'idle') cancelCapture('使っていたカメラが外れたため、撮影を中止しました。');
    else notify('使っていたカメラが外れたため、別のカメラに切り替えました。', 8000);
    startCamera();
  } else if (want && want.id !== state.camInfo.id && added.some((c) => c.id === want.id) && state.phase === 'idle') {
    startCamera();
  } else if (added.length && state.phase === 'idle') {
    notify(`新しいカメラ（${added[0].name}）が見つかりました。右上の「設定」→「カメラ」で切り替えられます。`, 15000);
  }
}

// ---------- pose ----------

async function startPose() {
  const token = ++state.poseToken;
  state.poseOk = false;
  state.poseBusy = true;
  state.poseStale = false;
  check('chk-model', 'wait', '姿勢モデル：読み込み中（初回は時間がかかります）');
  refreshStart();
  try {
    const info = await initPose(state.settings.model, state.settings.delegate, () => {
      // the graphics context was taken away (typically while in the background)
      state.poseOk = false;
      state.poseStale = true;
      if (!document.hidden && !state.poseBusy) startPose();
    });
    if (token !== state.poseToken) return;
    state.poseOk = true;
    state.poseErr = 0;
    check('chk-model', 'ok', `姿勢モデル：${info.model === 'full' ? '標準' : '軽量'}・${info.delegate}`);
  } catch (e) {
    if (token !== state.poseToken) return;
    check('chk-model', 'ng', '姿勢モデル：読み込めません');
    showError(`姿勢モデルを読み込めませんでした（${e.message}）`);
  } finally {
    if (token === state.poseToken) { state.poseBusy = false; refreshStart(); }
  }
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

// ---------- stored pictures ----------

/** Region around the head, arms and chest of the thrower, or null if the pose is not clear enough. */
function cropFor(lm) {
  if (!lm) return null;
  const p = [LM.lEye, LM.rEye, LM.lSh, LM.rSh].map((i) => lm[i]);
  if (p.some((q) => !q || q[2] < 0.5)) return null;
  const ex = (p[0][0] + p[1][0]) / 2, ey = (p[0][1] + p[1][1]) / 2;
  const u = Math.hypot(ex - (p[2][0] + p[3][0]) / 2, ey - (p[2][1] + p[3][1]) / 2);
  const { w, h } = state.view;
  if (!(u > 6)) return null;
  const size = Math.round(Math.min(Math.max(6.4 * u, 160), w, h));
  return { x: Math.round(clamp(ex - size / 2, 0, w - size)), y: Math.round(clamp(ey - 0.36 * size, 0, h - size)), w: size, h: size };
}

/** Keeps one region while the thrower stays roughly in place, so the stored pictures line up. */
function pickCrop(lm) {
  const cur = state.crop;
  const next = cropFor(lm);
  if (cur && !next) return cur;
  if (cur && !cur.full && Math.abs(next.x - cur.x) < 0.2 * cur.w && Math.abs(next.y - cur.y) < 0.2 * cur.h && next.w > 0.75 * cur.w && next.w < 1.3 * cur.w) return cur;
  const c = next || { x: 0, y: 0, w: state.view.w, h: state.view.h, full: true };
  const k = Math.min(1, 640 / Math.max(c.w, c.h));
  thumb.width = Math.max(2, Math.round(c.w * k));
  thumb.height = Math.max(2, Math.round(c.h * k));
  state.crop = c;
  return c;
}

// ---------- frame loop ----------

function onFrame() {
  schedule();
  const now = performance.now();
  state.lastFrameAt = now;
  if (state.screen !== 'home' || !state.camOk || !state.poseOk || cam.readyState < 2 || document.hidden) return;
  if (cam.videoWidth !== state.view.w || cam.videoHeight !== state.view.h) onResize();
  const c = state.cap;
  let frame = null;
  if (state.phase === 'rec' && c && now >= c.recStart && now <= c.end) {
    frame = { t: Math.round(now - c.t0), lm: null, img: null, crop: null };
    if (now - state.lastImgAt >= 28) {
      // The picture is taken before the pose is computed, so that both come from the same video frame.
      state.lastImgAt = now;
      try {
        const crop = pickCrop(state.lastLm);
        thumb.getContext('2d').drawImage(cam, crop.x, crop.y, crop.w, crop.h, 0, 0, thumb.width, thumb.height);
        frame.crop = crop;
        const f = frame;
        thumb.toBlob((b) => { f.img = b; }, 'image/jpeg', 0.8);
      } catch (e) { /* stored pictures are optional */ }
    }
  }
  let lm = null;
  try {
    lm = detect(cam, now);
    state.poseErr = 0;
  } catch (e) {
    if (++state.poseErr >= 3 && now - state.poseRestart > 8000 && !state.poseBusy) { state.poseRestart = now; state.poseErr = 0; startPose(); }
    return;
  }
  if (state.lastT) {
    const inst = 1000 / Math.max(1, now - state.lastT);
    state.fps = state.fps ? state.fps * 0.9 + inst * 0.1 : inst;
  }
  state.lastT = now;
  state.lastLm = lm;
  if (lm) state.lastSeen = now;
  drawOverlay(lm);
  if (frame) {
    frame.lm = lm;
    state.frames.push(frame);
  }
}

function schedule() {
  const id = state.loopId;
  const run = () => { if (id === state.loopId) onFrame(); };
  if (cam.requestVideoFrameCallback) cam.requestVideoFrameCallback(run);
  else requestAnimationFrame(run);
}

/** (Re)starts the frame loop; an older loop notices the new id and ends. */
function kickLoop() {
  state.loopId++;
  schedule();
}

function onResize() {
  if (!syncView()) return;
  camLine();
  if (state.phase !== 'idle') cancelCapture('撮影の途中でカメラの映像の大きさが変わったため、中止しました。もう一度スタートを押してください。');
}

function statusTick() {
  const now = performance.now();
  watchdog(now);
  if (state.screen !== 'home') return;
  if (state.phase !== 'idle') { message(''); return; }
  if (state.notice && state.noticeUntil && now > state.noticeUntil) state.notice = null;
  if (!state.camOk || !state.poseOk) { if (state.notice) message(state.notice); return; }
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
  if (state.phase !== 'idle' || !state.camOk) return;
  const prep = Math.max(1, state.settings.prepSec) * 1000;
  const win = Math.max(2, state.settings.throwSec) * 1000;
  const start = performance.now();
  const t0 = start + prep;
  state.cap = { start, t0, win, recStart: t0 - 1000, end: t0 + THROWS * win + 700, step: -99 };
  state.frames = [];
  state.crop = null;
  state.lastImgAt = 0;
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
    $('cap-sub').textContent = '投げる位置で構えてください';
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

function cancelCapture(why) {
  endCaptureUi();
  state.frames = [];
  if (why) notify(why);
}

function dropConfirm() {
  if (state.confirm) state.confirm.dispose();
  state.confirm = null;
  $('confirm').replaceChildren();
}

function finishCapture() {
  endCaptureUi();
  const frames = state.frames;
  const res = analyzeCapture(frames, { handed: state.settings.handed, forearmCm: forearmCm(state.settings.heightCm), throws: THROWS });
  state.capView = { ...state.view };
  state.autoAnalysis = res;
  state.analysis = res;
  dropConfirm();
  if (!res.throws.length) {
    const why = res.tracked < res.frames * 0.3 ? '体をほとんど検出できませんでした。' : '投げる動きを見つけられませんでした。';
    notify(`${why}顔と投げる腕の肘までが映っているか、利き手の設定が合っているかを確認して、もう一度試してください。（記録${res.frames}コマ）`);
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
      : '3本とも入力できました。「決定」を押すと、腕の認識が合っているかの確認に進みます。';
  });
  state.board.refresh();
  show('board');
}

// ---------- tracking check ----------

function decide() {
  const a = state.autoAnalysis;
  if (!a || !a.throws.length || !state.frames.some((f) => f.img && f.crop)) { showResult(); return; }
  if (!state.confirm) state.confirm = new ConfirmView($('confirm'), { analysis: a, frames: state.frames, view: state.capView });
  show('confirm');
  $('confirm').scrollTop = 0;
}

function confirmOk() {
  const c = state.confirm;
  if (c && c.edited) state.analysis = applyKeyframes(state.autoAnalysis, c.result(), { forearmCm: forearmCm(state.settings.heightCm) });
  else state.analysis = state.autoAnalysis;
  showResult();
}

// ---------- result ----------

async function showResult() {
  const a = state.analysis;
  const hits = state.hits.slice(0, THROWS);
  const history = loadHistory();
  const findings = makeFindings(a, hits, history);
  const score = scoreRound(a, hits);
  const coach = coachRound(a, hits, score);
  const review = reviewFocus(loadFocus(), a, hits, score);
  state.round = { score, coach, review };
  $('btn-recheck').hidden = !state.confirm;
  show('result');
  $('result').scrollTop = 0;
  await renderResult($('result'), { analysis: a, hits, findings, frames: state.frames, view: state.capView, score, coach, review, history });
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
    view: state.capView,
    camera: state.camInfo ? { name: state.camInfo.name, fps: state.camInfo.fps } : null,
    cmPerPx: Math.round(a.cmPerPx * 1e4) / 1e4,
    fps: Math.round(a.fps * 10) / 10,
    pose: poseInfo(),
    hits: state.hits.slice(0, THROWS),
    score: state.round ? state.round.score : null,
    focus: state.round && state.round.coach.focus ? { key: state.round.coach.focus.key, title: state.round.coach.focus.title } : null,
    throws: a.throws.map((t) => ({ n: t.n, tPeak: Math.round(t.tPeak * 100) / 100, edited: !!t.edited, quality: Math.round(t.quality * 100) / 100, m: round1(t.m), ready: round1(t.px.ready), pre: round1(t.px.pre), top: round1(t.px.top) })),
  });
  if (!ok) showError('履歴を保存できませんでした（ブラウザの保存領域が使えません）');
  if (state.round && state.round.coach.focus) saveFocus(state.round.coach.focus);
  backHome();
}

function backHome() {
  disposeResult($('result'));
  dropConfirm();
  state.frames = [];
  state.analysis = null;
  state.autoAnalysis = null;
  state.round = null;
  state.lastFrameAt = performance.now();
  show('home');
  kickLoop();
}

// ---------- settings and history ----------

function fillCameraSelect() {
  const sel = $('set-camera');
  const keep = sel.dataset.touched === '1' ? sel.value : null;
  sel.replaceChildren();
  if (!state.cams.length) {
    const o = document.createElement('option');
    o.value = '';
    o.textContent = 'カメラを開始すると選べます';
    sel.append(o);
    sel.disabled = true;
    sel.dataset.initial = '';
    return;
  }
  sel.disabled = false;
  for (const c of state.cams) {
    const o = document.createElement('option');
    o.value = c.id;
    o.textContent = c.name;
    sel.append(o);
  }
  const active = state.camInfo && state.cams.find((c) => c.id === state.camInfo.id);
  const initial = (wantedCamera() || active || state.cams[0]).id;
  sel.dataset.initial = initial;
  sel.value = keep && state.cams.some((c) => c.id === keep) ? keep : initial;
}

async function openSettings() {
  const s = state.settings;
  $('set-handed').value = s.handed;
  $('set-height').value = s.heightCm;
  $('set-prep').value = s.prepSec;
  $('set-throw').value = s.throwSec;
  $('set-quality').value = s.camQuality;
  $('set-model').value = s.model;
  $('set-delegate').value = s.delegate;
  $('set-sound').checked = s.sound;
  $('set-voice').checked = s.voice;
  $('ver').textContent = `バージョン ${VERSION}`;
  $('set-camera').dataset.touched = '';
  fillCameraSelect();
  $('dlg-settings').showModal();
  await refreshCameras();
  fillCameraSelect();
}

function applySettings() {
  const old = state.settings;
  const num = (id, lo, hi, def) => { const v = Number($(id).value); return Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : def; };
  const sel = $('set-camera');
  const picked = sel.dataset.touched === '1' ? state.cams.find((c) => c.id === sel.value) : null;
  const s = {
    ...old,
    configured: true,
    handed: $('set-handed').value,
    heightCm: num('set-height', 120, 220, old.heightCm),
    prepSec: num('set-prep', 3, 30, old.prepSec),
    throwSec: num('set-throw', 3, 15, old.throwSec),
    cameraId: picked ? picked.id : old.cameraId,
    cameraLabel: picked ? picked.label : old.cameraLabel,
    camQuality: $('set-quality').value,
    model: $('set-model').value,
    delegate: $('set-delegate').value,
    sound: $('set-sound').checked,
    voice: $('set-voice').checked,
  };
  state.settings = s;
  saveSettings(s);
  const activeId = state.camInfo ? state.camInfo.id : '';
  if ((picked && picked.id !== activeId) || s.camQuality !== old.camQuality) {
    if (state.phase !== 'idle') cancelCapture(null);
    state.lastRestart = performance.now();
    startCamera();
  }
  if (s.model !== old.model || s.delegate !== old.delegate) startPose();
}

function openHistory() {
  renderHistory($('history'), loadHistory(), () => {
    if (window.confirm('保存した履歴をすべて消します。よろしいですか？')) { clearHistory(); openHistory(); }
  });
  show('history');
}

// ---------- wiring ----------

$('btn-start').addEventListener('click', startCapture);
$('btn-cancel').addEventListener('click', () => cancelCapture(null));
$('btn-cam').addEventListener('click', () => { state.camRetries = 0; state.notice = null; startCamera(); });
$('btn-settings').addEventListener('click', openSettings);
$('btn-settings-save').addEventListener('click', applySettings);
$('set-camera').addEventListener('change', (e) => { e.target.dataset.touched = '1'; });
$('btn-history').addEventListener('click', openHistory);
$('btn-history-back').addEventListener('click', () => { state.lastFrameAt = performance.now(); show('home'); kickLoop(); });
$('btn-export').addEventListener('click', exportJson);
$('btn-undo').addEventListener('click', () => state.board && state.board.undo());
$('btn-miss').addEventListener('click', () => state.board && state.board.miss());
$('btn-decide').addEventListener('click', decide);
$('btn-zoom-in').addEventListener('click', () => state.board && state.board.zoomIn());
$('btn-zoom-out').addEventListener('click', () => state.board && state.board.zoomOut());
$('btn-zoom-reset').addEventListener('click', () => state.board && state.board.resetView());
$('btn-board-back').addEventListener('click', backHome);
$('btn-confirm-back').addEventListener('click', () => show('board'));
$('btn-confirm-ok').addEventListener('click', confirmOk);
$('btn-recheck').addEventListener('click', () => { if (state.confirm) { disposeResult($('result')); show('confirm'); } });
$('btn-save').addEventListener('click', saveRound);
$('btn-discard').addEventListener('click', backHome);
cam.addEventListener('resize', onResize);
document.addEventListener('visibilitychange', () => { if (document.hidden) suspend(); else resume(); });
window.addEventListener('pageshow', (e) => { if (e.persisted) resume(); });
window.addEventListener('focus', resume);
if (navigator.mediaDevices && navigator.mediaDevices.addEventListener) navigator.mediaDevices.addEventListener('devicechange', onDeviceChange);

if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});

setInterval(statusTick, 400);
startCamera();
startPose();
if (!state.settings.configured && !qs.has('prep')) openSettings();
