// Home Manager Payments — Service Worker
// אסטרטגיה: קודם רשת (תמיד הגרסה העדכנית), ואם אין חיבור — מהמטמון.
// נתוני המשתמש (Google Drive/Sheets) לא עוברים כאן ולא נשמרים במטמון.
var VERSION = '0.9.1';
var CACHE = 'hmp-' + VERSION;
var SHELL = [
  './', './index.html', './styles.css?v=' + VERSION, './calc.js?v=' + VERSION, './app.js?v=' + VERSION,
  './config.js', './manifest.webmanifest', './data/index.json',
  './icons/icon-192.png', './icons/icon-512.png', './icons/apple-touch-icon.png', './icons/favicon-32.png'
];

self.addEventListener('install', function (e) {
  e.waitUntil(caches.open(CACHE).then(function (c) {
    return Promise.all(SHELL.map(function (u) { return c.add(new Request(u, { cache: 'reload' })).catch(function () {}); }));
  }));
  self.skipWaiting();
});

self.addEventListener('activate', function (e) {
  e.waitUntil(caches.keys().then(function (keys) {
    return Promise.all(keys.filter(function (k) { return k.indexOf('hmp-') === 0 && k !== CACHE; }).map(function (k) { return caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});

self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.method !== 'GET') return;
  var url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // Google, גופנים וכו' — ישירות לרשת
  var nav = req.mode === 'navigate';
  e.respondWith(
    fetch(nav ? new Request(req.url, { cache: 'no-cache', credentials: 'same-origin' }) : req).then(function (res) {
      if (res && res.ok && res.type === 'basic') {
        var copy = res.clone();
        caches.open(CACHE).then(function (c) { c.put(nav ? './index.html' : req, copy); });
      }
      return res;
    }).catch(function () {
      return caches.open(CACHE).then(function (c) {
        return (nav ? c.match('./index.html') : c.match(req)).then(function (hit) {
          return hit || c.match(req, { ignoreSearch: true }).then(function (h2) { return h2 || Response.error(); });
        });
      });
    })
  );
});
