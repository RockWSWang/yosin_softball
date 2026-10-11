/* 壘球紀錄 Service Worker：把程式檔存在手機裡，沒網路也能開啟。
 * 策略：先用手機裡的版本立刻開啟，同時在背景檢查新版，下次開啟就會是新版。
 * ★ 每次更新網頁檔案後，請把下面的版本號 +1，舊快取才會被清掉。 */
const VERSION = 'v5';
const CACHE = 'softball-' + VERSION;
const SHELL = ['./', 'index.html', 'styles.css', 'engine.js', 'app.js', 'config.js',
  'manifest.webmanifest', 'icon-192.png', 'icon-512.png', 'icon-maskable-512.png'];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE)
      .then(c => c.addAll(SHELL.map(u => new Request(u, { cache: 'reload' }))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;   // 後端 API 與外部圖片一律走網路
  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const hit = await cache.match(req, { ignoreSearch: true });
    const net = fetch(req).then(r => { if (r && r.ok) cache.put(req, r.clone()); return r; }).catch(() => null);
    if (hit) { e.waitUntil(net); return hit; }
    const r = await net;
    if (r) return r;
    if (req.mode === 'navigate') { const idx = await cache.match('index.html'); if (idx) return idx; }
    return Response.error();
  })());
});
