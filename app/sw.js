// Offline support: precache the app shell, then serve network-first so updates
// show up immediately when online. GitHub API calls are never intercepted.
const CACHE = 'tracker-v1.1.0';
const ASSETS = [
  './',
  'index.html',
  'manifest.webmanifest',
  'css/styles.css',
  'icons/icon.svg',
  'icons/icon-maskable.svg',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/icon-maskable-512.png',
  'icons/apple-touch-icon.png',
  'js/app.js',
  'js/files.js',
  'js/format.js',
  'js/github.js',
  'js/kv.js',
  'js/main.js',
  'js/markdown.js',
  'js/model.js',
  'js/settings.js',
  'js/store.js',
  'js/sync.js',
  'js/syncManager.js',
  'js/theme-boot.js',
  'js/version.js',
  'js/ui/components.js',
  'js/ui/fileViewer.js',
  'js/ui/icons.js',
  'js/ui/itemModal.js',
  'js/ui/settingsView.js',
  'js/ui/views.js',
  'vendor/marked.js',
  'vendor/preact-htm.js',
  'vendor/purify.js',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(ASSETS))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET' || new URL(request.url).origin !== self.location.origin) return;
  // A navigate-mode Request cannot be re-fetched with an init object, so use its URL.
  const network = request.mode === 'navigate' ? fetch(request.url, { cache: 'no-cache' }) : fetch(request, { cache: 'no-cache' });
  event.respondWith(
    network
      .then((response) => {
        if (response.ok) {
          const copy = response.clone();
          caches.open(CACHE).then((cache) => cache.put(request, copy));
        }
        return response;
      })
      .catch(async () => {
        const cached = await caches.match(request, { ignoreSearch: true });
        if (cached) return cached;
        if (request.mode === 'navigate') return caches.match('index.html');
        return Response.error();
      }),
  );
});
