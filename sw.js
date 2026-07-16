// Service worker: caches the app shell so the app opens instantly and offline.
// IMPORTANT: bump CACHE_VERSION whenever any shell file below changes.
const CACHE_VERSION = 'personal-os-shell-v4';

// Same-origin shell files — critical; install fails if any is missing.
const SHELL = [
  './',
  './index.html',
  './manifest.json',
  './js/app.js',
  './js/db.js',
  './js/modules/tasks.js',
  './icons/icon-192.png',
  './icons/icon-512.png'
];

// Cross-origin libs — best-effort so a CDN hiccup can't break the install.
const EXTRA = [
  'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm'
];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_VERSION);
    await cache.addAll(SHELL);
    await Promise.allSettled(EXTRA.map((url) => cache.add(url)));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return; // let Supabase writes (POST etc.) pass straight through

  // Page loads: network-first (so updates show up), fall back to the cached shell offline.
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((response) => {
          if (response.ok) {
            const copy = response.clone();
            caches.open(CACHE_VERSION).then((cache) => cache.put(request, copy));
          }
          return response;
        })
        .catch(() => caches.match(request).then((c) => c || caches.match('./index.html')))
    );
    return;
  }

  // Everything else: serve from cache if we have it (covers the CDN lib offline),
  // otherwise go to the network and cache same-origin responses for next time.
  event.respondWith(
    caches.match(request).then((cached) => {
      const network = fetch(request)
        .then((response) => {
          if (response.ok && new URL(request.url).origin === self.location.origin) {
            const copy = response.clone();
            caches.open(CACHE_VERSION).then((cache) => cache.put(request, copy));
          }
          return response;
        })
        .catch(() => cached);
      return cached || network;
    })
  );
});
