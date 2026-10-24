const V = 'of-shell-v3';
const SHELL = ['./', 'index.html', 'app.js', 'manifest.webmanifest', 'icon-180.png', 'icon-192.png', 'icon-512.png'];
self.addEventListener('install', e => e.waitUntil(caches.open(V).then(c => c.addAll(SHELL)).then(() => self.skipWaiting())));
self.addEventListener('activate', e => e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== V).map(k => caches.delete(k)))).then(() => self.clients.claim())));
self.addEventListener('fetch', e => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET' || u.origin !== location.origin) return;           // media fetches go straight to network
  if (u.pathname.endsWith('feed.json') || u.pathname.includes('/media/')) return;  // stored in IndexedDB by the app
  // app shell: network first (so updates arrive), fall back to cache when offline
  e.respondWith(fetch(e.request).then(r => { if (r.ok) { const c = r.clone(); caches.open(V).then(ca => ca.put(e.request, c)); } return r; })
    .catch(() => caches.match(e.request, { ignoreSearch: true }).then(r => r || caches.match('index.html'))));
});
