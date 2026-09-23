const CACHE_NAME = 'anjali-admin-v6';
const APP_SHELL = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './config.js',
  './i18n.js',
  './paymentcard.js',
  './lib/qrcode-engine.js',
  './manifest.json'
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((names) => Promise.all(names.filter((n) => n !== CACHE_NAME).map((n) => caches.delete(n))))
  );
  self.clients.claim();
});

// NETWORK-FIRST for the app shell (see customer/service-worker.js for the
// full explanation) - cache-first was silently trapping devices on old
// admin JS after every update. Admin API responses (POST) always bypass
// the cache entirely, same as before.
self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method === 'POST') return;
  event.respondWith(
    fetch(req)
      .then((fresh) => {
        const copy = fresh.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(req, copy)).catch(() => {});
        return fresh;
      })
      .catch(() => caches.match(req))
  );
});
