/* Offerly: обработчики Web Push (4.5). Подключается к сгенерированному service worker через importScripts
 * (vite.config.ts → workbox.importScripts), поэтому файл — обычный скрипт без модулей и без сборки.
 * Полезная нагрузка — JSON {title, body, url, tag} из functions/_lib/push.ts; без неё показывается общий текст, ничего не выдумывается. */
(function () {
  var APP_NAME = 'Offerly';
  var FALLBACK = { title: APP_NAME, body: 'Пора заниматься: откройте приложение.', url: '/', tag: 'offerly-daily' };

  function payloadOf(event) {
    if (!event.data) return FALLBACK;
    try {
      var j = event.data.json() || {};
      return {
        title: typeof j.title === 'string' && j.title ? j.title : FALLBACK.title,
        body: typeof j.body === 'string' ? j.body : FALLBACK.body,
        url: typeof j.url === 'string' && j.url ? j.url : FALLBACK.url,
        tag: typeof j.tag === 'string' && j.tag ? j.tag : FALLBACK.tag,
      };
    } catch (e) {
      return FALLBACK;
    }
  }

  self.addEventListener('push', function (event) {
    var p = payloadOf(event);
    event.waitUntil(self.registration.showNotification(p.title, {
      body: p.body, tag: p.tag, icon: '/icon-192.png', badge: '/icon-192.png', lang: 'ru', renotify: false, data: { url: p.url },
    }));
  });

  /* Клик — в уже открытое окно приложения, иначе новое. */
  self.addEventListener('notificationclick', function (event) {
    event.notification.close();
    var url = (event.notification.data && event.notification.data.url) || '/';
    event.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (list) {
      for (var i = 0; i < list.length; i++) {
        var c = list[i];
        if (c.url && c.url.indexOf(self.location.origin) === 0 && 'focus' in c) return c.focus();
      }
      return self.clients.openWindow(url);
    }));
  });

  /* Push-служба сменила подписку: подписаться заново тем же ключом сервера и сообщить серверу (cookie сессии уходит сама). */
  self.addEventListener('pushsubscriptionchange', function (event) {
    var old = event.oldSubscription;
    var key = old && old.options && old.options.applicationServerKey;
    if (!key) return;
    event.waitUntil(self.registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key }).then(function (sub) {
      if (!sub) return;
      var j = sub.toJSON();
      return fetch('/api/push/subscribe', {
        method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ endpoint: j.endpoint, keys: j.keys, userAgent: self.navigator ? self.navigator.userAgent : null }),
      });
    }).catch(function () { /* сессия истекла или служба недоступна — подпишется заново при следующем входе */ }));
  });
})();
