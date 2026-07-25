// Service worker: network-only. It caches NOTHING.
//
// Why this file still exists even though offline support is gone: Chrome only offers a
// real install (a WebAPK, via the beforeinstallprompt event the "Instalar" button uses)
// when a service worker with a fetch handler is registered. So we keep the thinnest
// possible worker — it exists to preserve installability, not to serve content.
//
// The old shell-caching worker (v5 and earlier) is what made updates sticky: a phone
// kept serving its cached copy, so a new deploy only landed after a hard reload. This
// version deletes every cache it finds on activate, so devices coming from v5 are
// cleaned up automatically and a normal reload always gets the latest code.
const SW_VERSION = 'personal-os-network-only-v7';

self.addEventListener('install', (event) => {
  event.waitUntil(self.skipWaiting()); // replace the old caching worker immediately
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    // Drop every cache the previous versions created — this is the one-time cleanup
    // that unsticks devices still holding the v5 app shell.
    const keys = await caches.keys();
    await Promise.all(keys.map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  // Straight to the network, nothing stored. The handler must do real work (not be a
  // no-op) for Chrome to count it toward installability, so navigations go through fetch.
  // Trade-off, accepted deliberately: the app no longer opens offline.
  if (event.request.mode === 'navigate') {
    event.respondWith(fetch(event.request));
  }
});
