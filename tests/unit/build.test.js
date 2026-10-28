// gas/Code.gs が元のファイルから作り直されているかのテスト
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

test('gas/Code.gs は tools/build-gas.js で作った最新の内容になっている', () => {
  const { build } = require('../../tools/build-gas.js');
  const current = fs.readFileSync(path.join(__dirname, '../../gas/Code.gs'), 'utf8');
  assert.equal(current, build(), 'gas/src/server.js か docs/js/shared.js を変えたら `npm run build:gas` を実行してください');
});

test('サーバーのコードは、このスプレッドシートだけを読み書きする指定になっている', () => {
  const code = fs.readFileSync(path.join(__dirname, '../../gas/Code.gs'), 'utf8');
  assert.match(code, /@OnlyCurrentDoc/);
});

test('合言葉や接続先などの秘密の情報がコードに書かれていない', () => {
  const root = path.join(__dirname, '../..');
  const files = ['gas/Code.gs', 'docs/js/app.js', 'docs/js/shared.js', 'docs/js/importer.js', 'docs/js/weather.js', 'docs/index.html'];
  files.forEach(f => {
    const text = fs.readFileSync(path.join(root, f), 'utf8');
    assert.doesNotMatch(text, /script\.google\.com\/macros\/s\/[A-Za-z0-9_-]{20,}/, `${f} にウェブアプリの URL が書かれています`);
    assert.doesNotMatch(text, /docs\.google\.com\/spreadsheets\/d\/[A-Za-z0-9_-]{20,}/, `${f} にスプレッドシートの URL が書かれています`);
  });
});
