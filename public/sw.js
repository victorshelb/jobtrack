// App shell: network first, cached copy when offline.
// Data (/api GETs): network first; when your laptop is unreachable the last saved copy is served,
// so the phone keeps working. The data cache stays on this device and is wiped when you sign out.
const CACHE = 'jobtrack-v11';
const DATA = 'jobtrack-data';
const SHELL = ['/', '/index.html', '/app.js', '/md.js', '/styles.css', '/manifest.webmanifest', '/icons/icon.svg', '/icons/icon-192.png'];
self.addEventListener('install', (e) => { e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL))); self.skipWaiting(); });
self.addEventListener('activate', (e) => { e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE && k !== DATA).map((k) => caches.delete(k))))); self.clients.claim(); });

const NO_CACHE = /^\/api\/(auth\/(?!status)|ai\/run|mail\/sync|push|documents\/\d+\/(file|export))/;
const timeout = (ms) => new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms));

// Fast over a slow connection: if the laptop hasn't answered within ~1.2s and a saved copy exists, show the
// saved copy now and let the real response refresh the cache for next time. Fully offline → saved copy.
async function dataFetch(req) {
  const cache = await caches.open(DATA);
  const network = fetch(req).then((r) => { if (r.ok) cache.put(req, r.clone()); return r; });
  const saved = await cache.match(req);
  const fromSaved = async (hit, flag) => {
    const h = new Headers(hit.headers); h.set(flag, hit.headers.get('date') || '1');
    return new Response(await hit.blob(), { status: hit.status, headers: h });
  };
  try {
    if (!saved || req.headers.get('X-JobTrack-Fresh')) return await Promise.race([network, timeout(10000)]); // just changed something: wait for the real data
    const winner = await Promise.race([network, new Promise((res) => setTimeout(() => res(null), 1200))]);
    if (winner) return winner;
    network.catch(() => {});                                   // keep updating the cache in the background
    return fromSaved(saved, 'X-JobTrack-Stale');
  } catch {
    if (saved) return fromSaved(saved, 'X-JobTrack-Offline');
    return new Response(JSON.stringify({ error: 'Your laptop is unreachable and this page hasn\'t been saved on this device yet.', offline: true }),
      { status: 503, headers: { 'Content-Type': 'application/json', 'X-JobTrack-Offline': '1' } });
  }
}

self.addEventListener('fetch', (e) => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET' || u.origin !== location.origin || u.pathname === '/share') return;
  if (u.pathname.startsWith('/api')) { if (!NO_CACHE.test(u.pathname)) e.respondWith(dataFetch(e.request)); return; }
  e.respondWith(Promise.race([fetch(e.request), timeout(6000)]).then((r) => { const copy = r.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); return r; })
    .catch(() => caches.match(e.request).then((m) => m || caches.match('/'))));
});

// Push notifications (new applications from email, interviews, rejections, offers)
self.addEventListener('push', (e) => {
  let d = {};
  try { d = e.data.json(); } catch { d = { title: 'JobTrack', body: e.data && e.data.text() }; }
  e.waitUntil(self.registration.showNotification(d.title || 'JobTrack', {
    body: d.body || '', tag: d.tag, data: { url: d.url || '/' }, icon: '/icons/icon-192.png', badge: '/icons/icon-192.png',
  }));
});
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const url = new URL(e.notification.data?.url || '/', self.location.origin).href;
  e.waitUntil(clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
    const open = list.find((c) => c.url.startsWith(self.location.origin));
    if (open) { open.navigate(url); return open.focus(); }
    return clients.openWindow(url);
  }));
});
