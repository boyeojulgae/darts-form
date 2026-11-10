// Offline support. App files: network first (so updates arrive), cache as fallback.
// Pose engine and model files are large and rarely change: cache first.
const VERSION = 'v0.1.0';
const SHELL = ['./', 'index.html', 'css/app.css', 'js/main.js', 'js/pose.js', 'js/analysis.js', 'js/board.js', 'js/report.js', 'js/store.js', 'manifest.webmanifest', 'icons/icon-192.png', 'icons/icon-512.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(`shell-${VERSION}`).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k.startsWith('shell-') && k !== `shell-${VERSION}`).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.includes('/vendor/') || url.pathname.includes('/models/')) {
    e.respondWith(caches.open('assets-v1').then(async (c) => {
      const hit = await c.match(req);
      if (hit) return hit;
      const res = await fetch(req);
      if (res.ok) c.put(req, res.clone());
      return res;
    }));
    return;
  }
  e.respondWith(fetch(req).then((res) => {
    if (res.ok) {
      const copy = res.clone();
      caches.open(`shell-${VERSION}`).then((c) => c.put(req, copy));
    }
    return res;
  }).catch(() => caches.match(req, { ignoreSearch: true })));
});
