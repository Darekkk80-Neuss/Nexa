/* Effyra – Service Worker (PWA: installierbar + offline).
   Strategie: Netzwerk-zuerst mit Cache-Fallback. So kommen Updates sofort an
   (kein „hängengebliebenes" altes HTML), offline greift der Cache.
   Nur GET-Anfragen der eigenen Origin werden abgefangen – Supabase, OpenAI,
   Google Fonts usw. laufen immer direkt durch. */
const CACHE = 'effyra-v8';
const SHELL = ['./', './index.html', './manifest.webmanifest', './icon.svg', './bg.jpg',
  './impressum.html', './datenschutz.html', './nutzungsbedingungen.html', './konto-loeschen.html',
  './fonts/effyra-fonts.css', './vendor/supabase.min.js',
  './selbstfuersorge.json', './selbstfuersorge.en.json', './selbstfuersorge.fr.json',
  './selbstfuersorge.es.json', './selbstfuersorge.it.json', './selbstfuersorge.pl.json',
  './behoerden.json', './behoerden.en.json', './behoerden.fr.json',
  './behoerden.es.json', './behoerden.it.json', './behoerden.pl.json'];

self.addEventListener('install', (e) => {
  self.skipWaiting();
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL).catch(() => {})));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;   // externe Hosts nicht anfassen
  e.respondWith(
    fetch(req)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
        return res;
      })
      .catch(() => caches.match(req).then((r) => r || caches.match('./index.html')))
  );
});

/* ===== Web Push: System-Benachrichtigung anzeigen, auch wenn die App geschlossen/​im Hintergrund ist ===== */
self.addEventListener('push', (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (err) { d = { title: '👪 Effyra', body: e.data ? e.data.text() : '' }; }
  const opts = {
    body: d.body || '',
    icon: './icon-192.png',
    badge: './icon-192.png',
    tag: d.tag || 'effyra-fam',
    renotify: true,
    vibrate: [250, 100, 250, 100, 400],
    requireInteraction: true,          // bleibt sichtbar, bis der Nutzer reagiert
    data: { url: d.url || './?fam=1' }
  };
  e.waitUntil(self.registration.showNotification(d.title || '👪 Neue Aufgabe für dich', opts));
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const target = (e.notification.data && e.notification.data.url) || './?fam=1';
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((cls) => {
      for (const c of cls) { if ('focus' in c) { try { c.postMessage({ type: 'fam-open' }); } catch (er) {} return c.focus(); } }
      if (self.clients.openWindow) return self.clients.openWindow(target);
    })
  );
});
