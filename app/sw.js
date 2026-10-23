// Offline support: precache the app shell, then serve network-first so updates
// show up immediately when online. GitHub API calls are never intercepted.
const CACHE = 'tracker-v1.7.0';
const ASSETS = [
  './',
  'index.html',
  'quick-add.html',
  'manifest.webmanifest',
  'css/styles.css',
  'help/guide.md',
  'icons/icon.svg',
  'icons/icon-maskable.svg',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/icon-maskable-512.png',
  'icons/apple-touch-icon.png',
  'js/app.js',
  'js/assist.js',
  'js/assistant.js',
  'js/asyncConnection.js',
  'js/asyncLlm.js',
  'js/changes.js',
  'js/commands.js',
  'js/devices.js',
  'js/editorLinks.js',
  'js/files.js',
  'js/format.js',
  'js/github.js',
  'js/kv.js',
  'js/llm.js',
  'js/localFetch.js',
  'js/claude.js',
  'js/providers.js',
  'js/main.js',
  'js/markdown.js',
  'js/model.js',
  'js/notifier.js',
  'js/push.js',
  'js/quickAddPage.js',
  'js/settings.js',
  'js/store.js',
  'js/sync.js',
  'js/syncManager.js',
  'js/theme-boot.js',
  'js/version.js',
  'js/ui/assist.js',
  'js/ui/components.js',
  'js/ui/dictation.js',
  'js/ui/fileViewer.js',
  'js/ui/help.js',
  'js/ui/icons.js',
  'js/ui/itemModal.js',
  'js/ui/modelCard.js',
  'js/ui/notificationsCard.js',
  'js/ui/projects.js',
  'js/ui/settingsView.js',
  'js/ui/views.js',
  'vendor/anthropic.js',
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

// ---- Push notifications (sent by the Claude connector) ----------------------

self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data?.json() ?? {};
  } catch {
    data = { title: 'Tracker', body: event.data?.text() ?? '' };
  }
  const url = new URL(data.itemId ? `#/item/${encodeURIComponent(data.itemId)}` : '#/', self.registration.scope).href;
  event.waitUntil(
    (async () => {
      // Every push must show a notification (Safari revokes permission otherwise).
      await self.registration.showNotification(data.title || 'Tracker', {
        body: data.body || '',
        tag: data.tag || 'tracker',
        icon: 'icons/icon-192.png',
        data: { url },
      });
      // Let open windows pull the change right away.
      const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      for (const client of windows) client.postMessage({ type: 'tracker:changed' });
    })(),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = event.notification.data?.url || self.registration.scope;
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      const open = windows.find((c) => c.url.startsWith(self.registration.scope));
      if (open) {
        await open.focus();
        open.postMessage({ type: 'tracker:open', url });
        return;
      }
      await self.clients.openWindow(url);
    })(),
  );
});
