// 画面のファイル（docs/）を配るサーバーと、Apps Script のかわりをするサーバー
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const { loadGas } = require('./gas-mock');

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json'
};

function listen(server) {
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server)));
}

async function startWeb() {
  const root = path.join(__dirname, '../../docs');
  const server = http.createServer((req, res) => {
    let p = decodeURIComponent(req.url.split('?')[0]);
    if (p.endsWith('/')) p += 'index.html';
    const file = path.join(root, p);
    if (!file.startsWith(root)) { res.statusCode = 403; return res.end(); }
    fs.readFile(file, (err, data) => {
      if (err) { res.statusCode = 404; return res.end(); }
      res.setHeader('Content-Type', TYPES[path.extname(file)] || 'application/octet-stream');
      res.setHeader('Cache-Control', 'no-store');
      res.end(data);
    });
  });
  await listen(server);
  server.url = `http://127.0.0.1:${server.address().port}/`;
  return server;
}

/**
 * Apps Script のかわり。mode で失敗の仕方を切り替えられる
 *  'ok'        … ふつうに動く
 *  'post-html' … 承認切れのように、POST に HTML を返す（CORS なし）
 *  'v1'        … アルバムに対応していない古いサーバー
 */
async function startGas(options = {}) {
  const env = loadGas(options);
  const state = { mode: 'ok' };
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      if (req.method === 'GET') {
        res.setHeader('Access-Control-Allow-Origin', '*');
        return res.end(env.gas.doGet().text);
      }
      if (state.mode === 'post-html') {
        res.setHeader('Content-Type', 'text/html');
        return res.end('<html>Authorization is required</html>');
      }
      let out = env.gas.doPost({ postData: { contents: body } }).text;
      if (state.mode === 'v1') {
        const data = JSON.parse(out);
        const req = JSON.parse(body);
        if (req.action === 'photos') out = JSON.stringify({ ok: false, error: '不明な操作です' });
        else { delete data.version; out = JSON.stringify(data); }
      }
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Content-Type', 'application/json');
      res.end(out);
    });
  });
  await listen(server);
  server.url = `http://127.0.0.1:${server.address().port}/`;
  server.env = env;
  server.state = state;
  return server;
}

/** 天気のサービス（Open-Meteo）の模擬データ：過去92日＋予報16日を1時間ごと */
function fakeWeather(now = new Date()) {
  const time = [], temperature_2m = [], relative_humidity_2m = [];
  const start = new Date(now); start.setHours(0, 0, 0, 0); start.setDate(start.getDate() - 92);
  const pad = n => String(n).padStart(2, '0');
  for (let i = 0; i < 108 * 24; i++) {
    const d = new Date(start.getTime() + i * 3600e3);
    time.push(`${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:00`);
    const day = Math.floor(i / 24);
    temperature_2m.push(18 + 6 * Math.sin(day / 7) + 4 * Math.sin((d.getHours() - 8) / 24 * 2 * Math.PI));
    relative_humidity_2m.push(65 + 20 * Math.cos(day / 5));
  }
  return { hourly: { time, temperature_2m, relative_humidity_2m } };
}

module.exports = { startWeb, startGas, fakeWeather };
