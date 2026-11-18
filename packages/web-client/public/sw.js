/*
 * 9.4 service worker of the webmail: Web Push notifications and installability.
 * No fetch handler, no offline caching — every request goes to the network.
 * The pure parts live in sw-logic.js.
 */
importScripts('/sw-logic.js');

var sw = self.CoreMailSw;

self.addEventListener('install', function () {
  self.skipWaiting();
});

self.addEventListener('activate', function (event) {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('push', function (event) {
  var n = sw.notificationFromPush(event.data ? event.data.text() : '');
  event.waitUntil(self.registration.showNotification(n.title, n.options));
});

// A click focuses an open webmail window and lets the app route there (no reload);
// without one a new window opens at the message.
self.addEventListener('notificationclick', function (event) {
  event.notification.close();
  var url = sw.clickTarget(event.notification.data);
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (list) {
      var client = sw.pickClient(list);
      if (!client) return self.clients.openWindow(url);
      return client.focus().then(function (focused) {
        (focused || client).postMessage({ type: sw.OPEN_MESSAGE_TYPE, url: url });
      });
    }),
  );
});
