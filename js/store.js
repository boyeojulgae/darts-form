// Settings and round history, kept in this browser only.
const KEY = 'dartsform.v1';

export const DEFAULTS = { handed: 'left', heightCm: 170, prepSec: 8, throwSec: 5, facing: 'user', model: 'full', delegate: 'GPU', sound: true, voice: true };

function read() {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return JSON.parse(raw);
  } catch (e) { /* storage unavailable: run without it */ }
  return {};
}

function write(data) {
  try { localStorage.setItem(KEY, JSON.stringify(data)); return true; } catch (e) { return false; }
}

export function loadSettings() {
  return { ...DEFAULTS, ...(read().settings || {}) };
}

export function saveSettings(settings) {
  const d = read();
  d.settings = settings;
  return write(d);
}

export function loadHistory() {
  const h = read().sessions;
  return Array.isArray(h) ? h : [];
}

export function addSession(session) {
  const d = read();
  d.sessions = Array.isArray(d.sessions) ? d.sessions : [];
  d.sessions.push(session);
  return write(d);
}

export function clearHistory() {
  const d = read();
  d.sessions = [];
  return write(d);
}

export const forearmCm = (heightCm) => Math.round(heightCm * 0.146 * 10) / 10;

export function exportJson() {
  const d = read();
  const blob = new Blob([JSON.stringify({ app: 'darts-form', exported: new Date().toISOString(), settings: d.settings || DEFAULTS, sessions: d.sessions || [] }, null, 1)], { type: 'application/json' });
  const a = document.createElement('a');
  const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  a.href = URL.createObjectURL(blob);
  a.download = `darts-form-${stamp}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}
