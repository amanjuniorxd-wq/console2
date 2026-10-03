/* Mishrin Console service worker: offline shell + immutable asset cache. */
const SHELL = 'mishrin-shell-v2';
const GAMES = 'mishrin-games-v1';
self.addEventListener('install', e => { self.skipWaiting(); e.waitUntil(caches.open(SHELL).then(c => c.addAll(['./', './games/catalog.json', './runner.html']).catch(() => {}))); });
self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k.startsWith('mishrin-') && k !== SHELL && k !== GAMES) await caches.delete(k);
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (url.origin !== location.origin || e.request.method !== 'GET') return;
  const base = new URL(self.registration.scope).pathname;            // '/' or '/mishrin-console/'
  const path = url.pathname.startsWith(base) ? '/' + url.pathname.slice(base.length) : url.pathname;

  // Hashed build assets are immutable: cache-first.
  if (path.startsWith('/assets/')) {
    e.respondWith(caches.open(SHELL).then(async c => (await c.match(e.request)) || fetch(e.request).then(r => { if (r.ok) c.put(e.request, r.clone()); return r; })));
    return;
  }
  // Bundled game sub-assets: stale-while-revalidate. (Packages themselves go through the MPC content store.)
  if (path.startsWith('/games/') && !path.endsWith('.wasm')) {
    e.respondWith(caches.open(GAMES).then(async c => {
      const hit = await c.match(e.request);
      const net = fetch(e.request).then(r => { if (r.ok) c.put(e.request, r.clone()); return r; }).catch(() => hit);
      const r = hit || (await net);
      return r || new Response('Offline', { status: 503 });
    }));
    return;
  }
  // App shell: network-first so updates land immediately; cache for offline.
  if (e.request.mode === 'navigate' && (path === '/' || path === '/index.html')) {
    e.respondWith(fetch(e.request).then(r => { const cp = r.clone(); caches.open(SHELL).then(c => c.put(base, cp)); return r; }).catch(() => caches.match(base)));
  }
});
