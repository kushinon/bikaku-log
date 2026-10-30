// ビカクログ オフライン用のサービスワーカー
// 画面のファイルを端末に保存して、電波がなくてもアプリを開けるようにします。
// ファイルを更新したら CACHE の番号を上げてください。
var CACHE = 'bikaku-v14';
var FILES = [
  './',
  'index.html',
  'css/style.css',
  'js/shared.js',
  'js/importer.js',
  'js/weather.js',
  'js/app.js',
  'manifest.webmanifest',
  'icons/icon.svg',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/apple-touch-icon.png'
];
var NETWORK_TIMEOUT = 4000;   // 電波が弱いときは、この時間で保存済みの画面に切り替える

self.addEventListener('install', function (e) {
  // ブラウザのキャッシュを通さず、必ずサーバーから最新のファイルを取ってくる
  e.waitUntil(caches.open(CACHE).then(function (c) {
    return c.addAll(FILES.map(function (f) { return new Request(f, { cache: 'reload' }); }));
  }).then(function () { return self.skipWaiting(); }));
});

self.addEventListener('activate', function (e) {
  e.waitUntil(caches.keys().then(function (keys) {
    return Promise.all(keys.filter(function (k) { return k !== CACHE; }).map(function (k) { return caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});

// 同じサイトのファイルは「つながればサーバーの最新版、だめなら保存済みのもの」を使う
// （Apps Script への通信は対象外）
self.addEventListener('fetch', function (e) {
  var req = e.request;
  var url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin) return;

  var key = req.mode === 'navigate' ? './' : url.origin + url.pathname;
  e.respondWith(caches.open(CACHE).then(function (cache) {
    var fromNetwork = fetch(url.origin + url.pathname, { cache: 'no-cache' }).then(function (res) {
      if (res && res.ok) cache.put(key, res.clone());
      return res;
    });
    var timeout = new Promise(function (resolve) { setTimeout(resolve, NETWORK_TIMEOUT); });
    return Promise.race([fromNetwork.catch(function () { return null; }), timeout]).then(function (res) {
      if (res && res.ok) return res;
      return cache.match(key, { ignoreSearch: true }).then(function (cached) {
        return cached || fromNetwork;
      });
    });
  }));
});
