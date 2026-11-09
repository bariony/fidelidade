/* Carimbô: service worker só para avisos (push). Não guarda páginas em cache. */
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));
self.addEventListener('push', e => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (_) { d = { body: e.data ? e.data.text() : '' }; }
  e.waitUntil(self.registration.showNotification(d.title || 'Carimbô', {
    body: d.body || '',
    icon: '/icons/icon-192.png',
    badge: '/icons/icon-192.png',
    data: { url: d.url || 'https://carimbo.io/lojista' }
  }));
});
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || 'https://carimbo.io/lojista';
  e.waitUntil((async () => {
    const list = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of list) { if (c.url.indexOf('/lojista') !== -1 && 'focus' in c) { await c.focus(); if (url.indexOf('/lojista') !== -1 && 'navigate' in c) { try { await c.navigate(url); } catch (_) {} } else { try { await self.clients.openWindow(url); } catch (_) {} } return; } }
    await self.clients.openWindow(url);
  })());
});
