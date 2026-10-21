// ビカクログ オフライン用のサービスワーカー
// 画面のファイルを端末に保存して、電波がなくてもアプリを開けるようにします。
// ファイルを更新したら CACHE の番号を上げてください。
var CACHE = 'bikaku-v2';
var FILES = [
  './',
  'index.html',
  'css/style.css',
  'js/shared.js',
  'js/importer.js',
  'js/app.js',
  'manifest.webmanifest',
  'icons/icon.svg',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/apple-touch-icon.png'
];

self.addEventListener('install', function (e) {
  e.waitUntil(caches.open(CACHE).then(function (c) { return c.addAll(FILES); }).then(function () { return self.skipWaiting(); }));
});

self.addEventListener('activate', function (e) {
  e.waitUntil(caches.keys().then(function (keys) {
    return Promise.all(keys.filter(function (k) { return k !== CACHE; }).map(function (k) { return caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});

// 同じサイトのファイルは「保存済みのものをすぐ表示し、裏で最新に更新」する
// （Apps Script への通信は対象外）
self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
  e.respondWith(caches.open(CACHE).then(function (cache) {
    return cache.match(req, { ignoreSearch: true }).then(function (cached) {
      var network = fetch(req).then(function (res) {
        if (res && res.ok) cache.put(req, res.clone());
        return res;
      }).catch(function () { return cached || (req.mode === 'navigate' ? cache.match('index.html') : undefined); });
      return cached || network;
    });
  }));
});
