/* KAKI CRM browser notification worker. Keep this file dependency-free so it
 * remains available before the React application has loaded. */
self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch { data = { body: event.data?.text() ?? '' }; }
  const title = data.title || 'KAKI CRM';
  const options = {
    body: data.body || 'You have a new notification.',
    icon: data.icon || '/favicon.ico',
    badge: data.badge || '/favicon.ico',
    tag: data.tag || 'kaki-crm-notification',
    renotify: true,
    data: { url: data.url || '/notifications' }
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = new URL(event.notification.data?.url || '/notifications', self.location.origin).href;
  event.waitUntil(clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windows) => {
    const existing = windows.find((window) => window.url.startsWith(self.location.origin));
    if (existing) { existing.focus(); existing.navigate(target); return; }
    return clients.openWindow(target);
  }));
});
