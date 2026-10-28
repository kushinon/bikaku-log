// メモの取り込み（docs/js/importer.js）のテスト
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const I = require('../../docs/js/importer.js');
const S = require('../../docs/js/shared.js');

const fixture = name => fs.readFileSync(path.join(__dirname, '../fixtures', name), 'utf8');
const NOW = new Date(2026, 9, 20, 12, 0).getTime();
const fmt = ms => { const d = new Date(ms); return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()} ${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`; };

test('Keep 形式のメモを読み取る（「日時」と「重量」が別の行でもよい）', () => {
  const r = I.parse(fixture('memo-basic.txt'), NOW);
  assert.equal(r.entries.length, 12);
  assert.deepEqual(r.skipped, []);
  assert.equal(fmt(r.entries[0].at), '2026/8/1 20:00');
  assert.equal(r.entries[0].weight, 500);
});

test('同じ日時・同じ重さの行は1件にまとめ、メモをつなげる', () => {
  const r = I.parse(fixture('memo-basic.txt'), NOW);
  const e = r.entries.find(x => x.weight === 700 && fmt(x.at) === '2026/8/3 21:30');
  assert.equal(e.memo, '水やり後・はじめての水やり');
  assert.equal(e.kind, 'after');
  assert.equal(e.duplicates, 1);
});

test('「水やり後」の直前（6時間以内）の軽い記録は「水やり前」とみなす', () => {
  const r = I.parse(fixture('memo-basic.txt'), NOW);
  const before = r.entries.filter(e => e.kind === 'before').map(e => e.weight);
  assert.deepEqual(before, [420, 430, 450]);
  assert.ok(r.entries.filter(e => e.kind === 'before').every(e => e.kindGuessed));
});

test('何度も書き足されて重なったメモ・満水・仕立て直しを読み取る', () => {
  const r = I.parse(fixture('memo-remount.txt'), NOW);
  assert.equal(r.entries.length, 9);
  const remount = r.entries.find(e => e.weight === 1800);
  assert.equal(remount.kind, 'after');                  // 「満水」は水やり後
  assert.equal(remount.memo, '板仕立て直し・満水時');
  assert.equal(remount.duplicates, 1);
  const last = r.entries[r.entries.length - 1];
  assert.equal(last.memo, '水やり後・満水時');           // カッコの外のひとことはメモに入れない
  assert.equal(r.entries.find(e => e.weight === 1200).kind, 'before');
});

test('前より1割以上重い行は、書いていなくても「水やり後」とみなす', () => {
  const r = I.parse('8/1 10:00: 500g\n8/2 10:00: 400g\n8/3 10:00: 650g\n8/4 10:00: 600g', NOW);
  assert.deepEqual(r.entries.map(e => e.kind), ['regular', 'regular', 'after', 'regular']);
  assert.equal(r.entries[2].kindGuessed, true);
});

test('取り込んだ記録は仕立て直し以降で判定される', () => {
  const r = I.parse(fixture('memo-remount.txt'), NOW);
  const logs = r.entries.map((e, i) => Object.assign({ id: 'x' + i, plantId: 'p' }, e));
  const j = S.judgePlant({ id: 'p' }, logs, new Date(2026, 7, 18, 12).getTime());
  assert.equal(fmt(j.resetAt), '2026/8/10 12:00');
  assert.equal(j.target, 1200);
});

test('年のない日付は今年。未来になるなら去年', () => {
  const r = I.parse('12/30 10:00 500g', NOW);
  assert.equal(new Date(r.entries[0].at).getFullYear(), 2025);
  const r2 = I.parse('1/5 10:00 500g', NOW);
  assert.equal(new Date(r2.entries[0].at).getFullYear(), 2026);
});

test('年をまたぐ記録（12月 → 1月）は次の年にする', () => {
  const r = I.parse('2025/12/30 10:00 500g\n1/2 10:00 450g', NOW);
  assert.equal(fmt(r.entries[1].at), '2026/1/2 10:00');
});

test('全角の数字や記号でも読み取る', () => {
  const r = I.parse('・９／１０　８：０５　６５０ｇ（水やり後）', NOW);
  assert.equal(r.entries.length, 1);
  assert.equal(fmt(r.entries[0].at), '2026/9/10 8:05');
  assert.equal(r.entries[0].weight, 650);
  assert.equal(r.entries[0].kind, 'after');
});

test('読み取れない数字入りの行は「読み取れなかった行」に入れる', () => {
  const r = I.parse('鉢を3号に変えた\n9/1 10:00 500g\n植物: P. ridleyi 2号', NOW);
  assert.equal(r.entries.length, 1);
  assert.deepEqual(r.skipped, ['鉢を3号に変えた']);
});
