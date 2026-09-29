// Forex Trading with Ndumiso — Service Worker
// Strategy: network-first for HTML (so updates arrive fast), cache-first for static assets,
// versioned cache so new deployments clean up old caches and notify the client.
const CACHE_VERSION = 'forex-v23'; // bump on each deploy
const STATIC_ASSETS = [
  './',
  './index.html',
  './css/app.css',
  './js/app.js',
  './manifest.webmanifest',
  './icons/icon-72.png','./icons/icon-96.png','./icons/icon-128.png',
  './icons/icon-144.png','./icons/icon-152.png','./icons/icon-192.png',
  './icons/icon-384.png','./icons/icon-512.png'
];

// Install: pre-cache static shell
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION).then(cache => cache.addAll(STATIC_ASSETS).catch(()=>{}))
      .then(() => self.skipWaiting())
  );
});

// Activate: kill old caches, take control immediately
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_VERSION).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

// Fetch:
//  - Navigation requests (HTML): try network first, fall back to cache, and if
//    a new version arrives while the page is open, postMessage an "update-available" event.
//  - Same-origin static assets: cache-first (immutable between versions since we bump CACHE_VERSION).
//  - Cross-origin (TradingView, CDN fonts/icons): network-only (don't cache).
self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (req.method !== 'GET') return;
  if (url.origin !== self.location.origin) return; // cross-origin -> let browser handle

  // HTML / navigations: network-first with update notification
  if (req.mode === 'navigate' || (req.headers.get('accept') || '').includes('text/html')) {
    event.respondWith(
      fetch(req).then(resp => {
        const copy = resp.clone();
        caches.open(CACHE_VERSION).then(c => c.put(req, copy));
        return resp;
      }).catch(() => caches.match(req).then(r => r || caches.match('./index.html')))
    );
    return;
  }

  // Static assets: cache-first, fall back to network and cache
  event.respondWith(
    caches.match(req).then(cached => {
      if (cached) return cached;
      return fetch(req).then(resp => {
        if (resp && resp.status === 200) {
          const copy = resp.clone();
          caches.open(CACHE_VERSION).then(c => c.put(req, copy));
        }
        return resp;
      }).catch(() => cached);
    })
  );
});

// Listen for a new SW activating while a client is open -> tell the page to show update UI
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
});
