// service-worker.js
// Denne filen kjører i bakgrunnen på telefonen din
// og mottar push-varsler selv når appen er lukket

self.addEventListener('push', event => {
  let data = {};
  try {
    data = event.data.json();
  } catch (e) {
    data = { title: 'MarketPulse', body: event.data?.text() || 'Ny oppdatering' };
  }

  const title = data.title || 'MarketPulse';
  const options = {
    body: data.body || '',
    icon: '/icon-192.png',
    badge: '/badge-72.png',
    vibrate: [200, 100, 200],
    tag: data.ticker || 'marketpulse',
    renotify: true,
    data: {
      url: '/',
      ticker: data.ticker,
      type: data.type
    },
    actions: [
      { action: 'view', title: '📊 Se detaljer' },
      { action: 'dismiss', title: 'Lukk' }
    ]
  };

  // Ulike ikoner for ulike varseltyper
  if (data.type === 'TARGET_HIT') {
    options.icon = '🚀';
    options.vibrate = [300, 100, 300, 100, 300];
  } else if (data.type === 'STOP_HIT') {
    options.icon = '⚠️';
    options.vibrate = [500, 200, 500];
  }

  event.waitUntil(
    self.registration.showNotification(title, options)
  );
});

// Håndter klikk på varselet
self.addEventListener('notificationclick', event => {
  event.notification.close();

  if (event.action === 'dismiss') return;

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clientList => {
      // Hvis appen allerede er åpen, fokuser på den
      for (const client of clientList) {
        if (client.url.includes(self.location.origin) && 'focus' in client) {
          return client.focus();
        }
      }
      // Ellers åpne appen
      if (clients.openWindow) {
        return clients.openWindow('/');
      }
    })
  );
});

// Cache app-filer for offline-bruk
const CACHE_NAME = 'marketpulse-v1';
const CACHE_FILES = ['/', '/index.html'];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(CACHE_FILES))
  );
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

