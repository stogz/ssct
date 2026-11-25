// Offline support: cache the app shell (network-first so updates show up right away).
const CACHE = 'ssct-v6';
const SHELL = [
  './', 'index.html', 'style.css', 'manifest.webmanifest',
  'js/app.js', 'js/db.js', 'js/units.js', 'js/goals.js', 'js/plan.js', 'js/colors.js', 'js/food-emojis.js', 'js/label-parser.js', 'js/scanner.js',
  'js/firebase-config.js', 'js/sync.js', 'js/vendor/firebase.js',
  'icons/icon.svg', 'icons/icon-192.png', 'icons/icon-512.png',
  'icons/ui/home.svg', 'icons/ui/star.svg', 'icons/ui/calendar.svg', 'icons/ui/settings.svg',
  'icons/ui/pencil.svg', 'icons/ui/camera.svg', 'icons/ui/trash.svg', 'icons/ui/none.svg',
  'icons/ui/scale.svg', 'icons/ui/target.svg',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET') return;
  if (url.origin === location.origin) {
    // `no-cache` asks the server whether each file changed (cheap 304 if not), so a new deploy never mixes
    // fresh HTML with stale CSS or JS from the browser's HTTP cache.
    e.respondWith(
      fetch(e.request, { cache: 'no-cache' })
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(e.request, copy));
          return res;
        })
        .catch(() => caches.match(e.request, { ignoreSearch: true })),
    );
  } else if (/cdn\.jsdelivr\.net|tessdata/.test(url.host + url.pathname)) {
    // Label-reader files: cache-first so scanning works offline after the first scan.
    e.respondWith(
      caches.match(e.request).then((hit) => hit || fetch(e.request).then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copy));
        return res;
      })),
    );
  }
});
