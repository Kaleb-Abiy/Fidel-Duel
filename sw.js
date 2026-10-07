// Offline cache for Fidel Duel.
// Bump VERSION whenever you deploy changed files so players get the update.
const VERSION = 'fidel-duel-v4';
const ASSETS = [
  './', './index.html', './style.css', './game.js', './words.js', './manifest.webmanifest',
  './fonts/fonts.css',
  './fonts/BigShouldersDisplay-latin-1.woff2',
  './fonts/BigShouldersDisplay-latin-ext-0.woff2',
  './fonts/Figtree-latin-3.woff2',
  './fonts/Figtree-latin-ext-2.woff2',
  './fonts/NotoSansEthiopic-ethiopic-4.woff2',
  './icons/apple-touch-icon.png',
  './icons/favicon-64.png',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/maskable-512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

// Serve from cache straight away, refresh the cache in the background when online.
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;
  e.respondWith(
    caches.open(VERSION).then(async (cache) => {
      const key = req.mode === 'navigate' ? './index.html' : req;
      const cached = await cache.match(key, { ignoreSearch: true });
      const fresh = fetch(req)
        .then((res) => { if (res.ok) cache.put(key, res.clone()); return res; })
        .catch(() => cached);
      return cached || fresh;
    }),
  );
});
