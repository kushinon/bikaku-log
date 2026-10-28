// サーバー（gas/Code.gs）のテスト。Apps Script の模型の上で動かす
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadGas } = require('../helpers/gas-mock');

const PASS = 'test-pass';
const plantRec = (id, extra = {}) => Object.assign({ id, name: '株' + id, variety: '', location: '', style: 'board', memo: '', photo: '', targetWeight: '', createdAt: 1, updatedAt: 1000, deleted: false }, extra);
const logRec = (id, extra = {}) => Object.assign({ id, plantId: 'p1', at: Date.UTC(2026, 9, 1), weight: 500, kind: 'regular', memo: '', updatedAt: 1000, deleted: false }, extra);

test('GET で開くと動作中のメッセージを返す', () => {
  const { gas } = loadGas();
  assert.match(gas.doGet().text, /動いています/);
});

test('合言葉が違うと読み書きできない', () => {
  const { gas } = loadGas();
  assert.deepEqual(gas.call({ action: 'ping', passcode: 'wrong' }), { ok: false, error: '合言葉が違います' });
  assert.equal(gas.call({ action: 'ping', passcode: PASS }).ok, true);
});

test('合言葉が設定されていないと動かない', () => {
  const { gas } = loadGas({ props: { PASSCODE: null } });
  assert.match(gas.call({ action: 'ping', passcode: '' }).error, /設定されていません/);
});

test('合言葉を20回間違えると、正しい合言葉でもしばらく受け付けない', () => {
  const { gas } = loadGas();
  for (let i = 0; i < 20; i++) gas.call({ action: 'ping', passcode: 'x' });
  assert.match(gas.call({ action: 'ping', passcode: PASS }).error, /受け付けを止めています/);
});

test('同期：送った記録を保存し、変わった分だけを返す', () => {
  const { gas, sheets } = loadGas();
  const r1 = gas.call({ action: 'sync', passcode: PASS, since: 0, ops: [{ table: 'plants', record: plantRec('p1') }, { table: 'logs', record: logRec('l1') }] });
  assert.equal(r1.ok, true);
  assert.equal(r1.version, 2);
  assert.deepEqual(r1.plants.map(p => p.id), ['p1']);
  assert.deepEqual(r1.logs.map(l => l.id), ['l1']);
  assert.equal(sheets['株'].getLastRow(), 2);         // 見出し＋1行
  assert.equal(sheets['記録'].data[1][3], '2026-10-01T00:00:00.000Z');   // 日時（表示用）
  // 何も変わっていなければ、何も返さない
  const r2 = gas.call({ action: 'sync', passcode: PASS, since: r1.serverTime + 1, ops: [] });
  assert.deepEqual([r2.plants.length, r2.logs.length], [0, 0]);
});

test('同期：同じ記録は上書きし、古い変更は無視してサーバーの値を返す', () => {
  const { gas, sheets } = loadGas();
  gas.call({ action: 'sync', passcode: PASS, since: 0, ops: [{ table: 'logs', record: logRec('l1', { weight: 500, updatedAt: 2000 }) }] });
  const old = gas.call({ action: 'sync', passcode: PASS, since: Date.now() + 1e6, ops: [{ table: 'logs', record: logRec('l1', { weight: 999, updatedAt: 1500 }) }] });
  assert.equal(old.logs[0].weight, 500);               // 送った端末にサーバーの値を返す
  gas.call({ action: 'sync', passcode: PASS, since: 0, ops: [{ table: 'logs', record: logRec('l1', { weight: 480, updatedAt: 3000 }) }] });
  assert.equal(sheets['記録'].getLastRow(), 2);
  assert.equal(sheets['記録'].data[1][4], 480);
});

test('同期：削除は「削除」の印で記録する', () => {
  const { gas } = loadGas();
  gas.call({ action: 'sync', passcode: PASS, since: 0, ops: [{ table: 'logs', record: logRec('l1') }] });
  const r = gas.call({ action: 'sync', passcode: PASS, since: 0, ops: [{ table: 'logs', record: logRec('l1', { deleted: true, updatedAt: 5000 }) }] });
  assert.equal(r.logs[0].deleted, true);
});

test('数式として解釈されそうな文字は、文字のまま保存する', () => {
  const { gas, sheets } = loadGas();
  gas.call({ action: 'sync', passcode: PASS, since: 0, ops: [{ table: 'logs', record: logRec('l1', { memo: '=HYPERLINK("x")' }) }] });
  assert.equal(sheets['記録'].raw['1,6'], `'=HYPERLINK("x")`);
  const r = gas.call({ action: 'sync', passcode: PASS, since: 0, ops: [] });
  assert.equal(r.logs[0].memo, '=HYPERLINK("x")');
});

test('アルバム：写真は株ごとに読み込み、ふだんの同期には含めない', () => {
  const { gas, sheets } = loadGas();
  const photo = (id, plantId, extra = {}) => ({ table: 'photos', record: Object.assign({ id, plantId, at: 1, photo: 'data:image/jpeg;base64,AAA', memo: '', updatedAt: 1000, deleted: false }, extra) });
  const r = gas.call({ action: 'sync', passcode: PASS, since: 0, ops: [photo('a', 'p1'), photo('b', 'p2'), photo('c', 'p1', { deleted: true })] });
  assert.equal(r.photos, undefined);
  assert.equal(sheets['アルバム'].getLastRow(), 4);
  const list = gas.call({ action: 'photos', passcode: PASS, plantId: 'p1' });
  assert.deepEqual(list.photos.map(p => p.id), ['a']);
  assert.equal(list.photos[0].photo, 'data:image/jpeg;base64,AAA');
});

test('サンプルデータを入れて、削除済みにできる', () => {
  const { gas } = loadGas();
  gas.insertSampleData();
  let r = gas.call({ action: 'sync', passcode: PASS, since: 0, ops: [] });
  assert.equal(r.plants.length, 3);
  assert.ok(r.logs.length > 100);
  gas.removeSampleData();
  r = gas.call({ action: 'sync', passcode: PASS, since: 0, ops: [] });
  assert.ok(r.plants.every(p => p.deleted) && r.logs.every(l => l.deleted));
});

test('setup は毎朝の通知を1つだけ予約する', () => {
  const { gas, triggers } = loadGas();
  gas.setup();
  gas.setup();
  assert.deepEqual(triggers, ['sendMorningNotice']);
});

test('朝の通知は、水やりが必要な株があるときだけ送る', () => {
  const { gas, mails } = loadGas({ props: { APP_URL: 'https://example.com/app/' } });
  gas.sendMorningNotice({});                    // 株がない
  assert.equal(mails.length, 0);
  gas.insertSampleData();                       // 「水やり時期」「もうすぐ」が1株ずつ
  gas.sendMorningNotice({});
  assert.equal(mails.length, 1);
  assert.match(mails[0].subject, /水やり時期 1株・もうすぐ 1株/);
  assert.equal(mails[0].to, 'owner@example.com');
  assert.match(mails[0].body, /https:\/\/example\.com\/app\//);
});

test('通知のテストは、該当がなくても送る', () => {
  const { gas, mails } = loadGas({ props: { NOTIFY_EMAIL: 'me@example.com' } });
  gas.testNotice();
  assert.equal(mails.length, 1);
  assert.equal(mails[0].to, 'me@example.com');
  assert.match(mails[0].subject, /テスト/);
});
