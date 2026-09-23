const CACHE_NAME = 'anjali-customer-v10-1';
const APP_SHELL = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './config.js',
  './i18n.js',
  './manifest.json'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((names) =>
      Promise.all(names.filter((n) => n !== CACHE_NAME).map((n) => caches.delete(n)))
    )
  );
  self.clients.claim();
});

// ---------------------------------------------------------------------
// IMPORTANT (root cause of the "fixes never seem to apply" issue):
// the previous version used cache-FIRST for the app shell, which meant a
// customer who had already loaded index.html/app.js once would keep
// getting that exact cached copy forever - even after new files were
// uploaded and CACHE_NAME was bumped - because the browser never asked
// the network again once a cache hit existed. Combined with browsers
// often HTTP-caching service-worker.js itself (see updateViaCache in
// app.js registration), a device could get permanently stuck on old
// JavaScript with no visible error.
//
// This app's data (bookings, availability) is never cached anyway - so
// there is no real offline benefit to cache-first here. NETWORK-FIRST
// for the app shell means every online visit gets the latest code;
// the cache is only a fallback for the rare fully-offline case.
// ---------------------------------------------------------------------
self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method === 'POST') return; // API calls: always network, never touched

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
