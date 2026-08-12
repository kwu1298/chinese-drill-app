// Service worker: caches the app shell so the drill opens instantly (and
// offline, from the last sync), and turns Web Push messages from the Mac
// into native notifications.
'use strict';
// deploy-webapp.sh rewrites this line with a hash of the deployed files.
// A fixed name meant an installed app could keep serving the old shell
// from cache and there was no way to tell it otherwise short of
// deleting the app.
const CACHE = 'chinese-5dab86f395';
const SHELL = ['./', './index.html', './srs.js', './config.json',
               './manifest.webmanifest', './icon-180.png?v=du', './icon-512.png?v=du'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL))
              .then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) {
      if (k !== CACHE) await caches.delete(k);   // drop every older build
    }
    await self.clients.claim();
  })());
});

// Network-first for the shell so updates land, cache as fallback for offline.
// Ranged requests are left to the browser: a media element asks for its mp3
// with `Range: bytes=0-`, and the Cache API is the wrong tool for that
// conversation -- cache.put refuses a 206, and a stored plain-200 replayed
// at a ranged request is a documented way to stall Chrome's media stack.
// The HTTP cache speaks 206 natively, and the lesson clips' names are the
// sha1 of what 阿姨 (āyí) says (see build-deck.py), so with Pages' ETag a
// re-listen costs a 304 at most. This is also exactly how the word clips in
// ./audio have always reached the ear, so the ▶ inherits a proven road.
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (url.origin !== location.origin) return;      // GitHub API goes straight out
  if (e.request.headers.get('range')) return;      // media: HTTP cache's job
  e.respondWith(
    fetch(e.request).then(r => {
      const copy = r.clone();
      caches.open(CACHE).then(c => c.put(e.request, copy));
      return r;
    }).catch(() => caches.match(e.request, { ignoreSearch: true }))
  );
});

self.addEventListener('push', e => {
  let data = {};
  try { data = e.data.json(); } catch (err) {}
  e.waitUntil(self.registration.showNotification(data.title || 'Chinese', {
    body: data.body || '',
    icon: './icon-180.png',
    badge: './icon-180.png',
    data: { url: data.url || './' },
  }));
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil(clients.matchAll({ type: 'window' }).then(list => {
    for (const c of list) { if ('focus' in c) return c.focus(); }
    return clients.openWindow(e.notification.data.url || './');
  }));
});
