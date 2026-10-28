// 画面の動きのテスト（iPhone の大きさのブラウザで、実際に操作して確かめる）
'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { startWeb, startGas } = require('../helpers/servers');
const { openApp, closeBrowser, syncBadge, waitSynced, typeWeight, serverRows } = require('./helpers');

const PHOTO1 = path.join(__dirname, '../../docs/icons/icon-192.png');
const PHOTO2 = path.join(__dirname, '../../docs/icons/apple-touch-icon.png');
let web;
before(async () => { web = await startWeb(); });
after(async () => { closeServer(web); await closeBrowser(); });

/** テストが失敗しても、サーバーやブラウザの画面を必ず閉じる */
function closeServer(server) {
  if (!server.listening) return;
  server.closeAllConnections();
  server.close();
}

async function addPlant(page, name) {
  await page.goto(web.url + '#/edit/new');
  await page.fill('#f-name', name);
  await page.click('button[type=submit]');
  await page.waitForSelector('.plant-title');
}

test('はじめの画面からサンプルデータを試せる', async (t) => {
  const { ctx, page } = await openApp(web);
  t.after(() => ctx.close());
  await page.waitForSelector('text=サンプルデータで試してみる');
  await page.click('text=サンプルデータで試してみる');
  await page.waitForSelector('.card');
  assert.equal(await page.locator('.card').count(), 3);
  assert.deepEqual(await page.locator('.summary b').allTextContents(), ['1', '1', '1']);
  await page.locator('.card-main').first().click();
  await page.waitForSelector('#chart svg');
  await page.locator('#chart svg').click({ position: { x: 200, y: 100 } });
  assert.match(await page.locator('#chart-tip').textContent(), /g/);
  assert.deepEqual(page.errors, []);
});

test('接続の設定：Apps Script 以外の URL ははじく', async (t) => {
  const { ctx, page } = await openApp(web);
  t.after(() => ctx.close());
  await page.click('text=接続の設定をする');
  await page.fill('#s-url', 'https://example.com/');
  await page.fill('#s-pass', 'abc');
  await page.click('[data-action=settings-save]');
  assert.match(await page.locator('#s-msg').textContent(), /script\.google\.com/);
});

test('計量：「水やり前」を保存すると「水やり後」に切り替わり、サーバーに保存される', async (t) => {
  const gas = await startGas();
  t.after(() => closeServer(gas));
  const { ctx, page } = await openApp(web, { gas });
  t.after(() => ctx.close());
  await addPlant(page, 'テスト株');
  await page.click('.actions .btn.primary');
  await page.waitForSelector('.keypad');
  await page.click('[data-kind="before"]');
  await typeWeight(page, '610');
  assert.match(await page.locator('#w-display').textContent(), /610/);
  await page.click('#w-save');
  assert.equal(await page.locator('[data-kind].active').getAttribute('data-kind'), 'after');
  await typeWeight(page, '870');
  await page.click('#w-save');
  await page.waitForSelector('.plant-title');
  await waitSynced(page);
  const rows = serverRows(gas, '記録');
  assert.deepEqual(rows.map(r => [r[4], r[5]]).sort(), [[610, 'before'], [870, 'after']]);
  assert.deepEqual(page.errors, []);
});

test('電波がないときの記録は端末にため、つながったら送る', async (t) => {
  const gas = await startGas();
  t.after(() => closeServer(gas));
  const { ctx, page } = await openApp(web, { gas });
  t.after(() => ctx.close());
  await addPlant(page, 'テスト株');
  await waitSynced(page);
  await ctx.setOffline(true);
  await page.click('.actions .btn.primary');
  await typeWeight(page, '700');
  await page.click('#w-save');
  await page.waitForSelector('.plant-title');
  await page.waitForTimeout(1500);
  assert.match(await page.locator('.sync').first().textContent(), /オフライン・未送信1件/);
  assert.equal(serverRows(gas, '記録').length, 0);
  await ctx.setOffline(false);
  await waitSynced(page);
  assert.equal(serverRows(gas, '記録').length, 1);
});

test('別の端末にも同期される', async (t) => {
  const gas = await startGas();
  t.after(() => closeServer(gas));
  const a = await openApp(web, { gas });
  t.after(() => a.ctx.close());
  await addPlant(a.page, '共有の株');
  await waitSynced(a.page);
  const b = await openApp(web, { gas, desktop: true });
  t.after(() => b.ctx.close());
  await waitSynced(b.page);
  assert.deepEqual(await b.page.locator('.card-name').allTextContents(), ['共有の株']);
});

test('株の編集と削除', async (t) => {
  const gas = await startGas();
  t.after(() => closeServer(gas));
  const { ctx, page } = await openApp(web, { gas });
  t.after(() => ctx.close());
  await addPlant(page, '名前1');
  await page.click('text=編集');
  await page.fill('#f-name', '名前2');
  await page.click('[data-style="hanging"]');
  await page.click('button[type=submit]');
  await page.waitForSelector('.plant-title');
  assert.equal(await page.locator('.plant-title').textContent(), '名前2');
  assert.match(await page.locator('.tags').textContent(), /ハンギング/);
  await page.click('text=編集');
  page.once('dialog', d => d.accept());   // 「削除しますか？」に「OK」
  await page.click('[data-action=plant-delete]');
  await page.waitForSelector('.empty');
  await waitSynced(page);
  assert.equal(serverRows(gas, '株')[0][10], true);   // 「削除」の列
});

test('目安重量を手動で設定し、自動に戻せる', async (t) => {
  const { ctx, page } = await openApp(web, { demo: true });
  t.after(() => ctx.close());
  await page.waitForSelector('.card');
  await page.locator('.card-main').first().click();
  await page.fill('#target-input', '555');
  await page.click('[data-action=target-save]');
  assert.match(await page.locator('.kv').textContent(), /555g 手動で設定/);
  await page.click('[data-action=target-clear]');
  assert.match(await page.locator('.kv').textContent(), /自動計算/);
});

test('メモからまとめて取り込み、2回目は登録済みとして外す', async (t) => {
  const gas = await startGas();
  t.after(() => closeServer(gas));
  const { ctx, page } = await openApp(web, { gas });
  t.after(() => ctx.close());
  await addPlant(page, '取り込み株');
  await page.click('text=メモからまとめて取り込む');
  await page.fill('#imp-text', fs.readFileSync(path.join(__dirname, '../fixtures/memo-basic.txt'), 'utf8'));
  await page.click('[data-action=import-parse]');
  await page.waitForSelector('.imp-list');
  assert.equal(await page.locator('.imp-list li').count(), 12);
  await page.click('[data-action=import-run]');
  await page.waitForSelector('.plant-title');
  await waitSynced(page);
  assert.equal(serverRows(gas, '記録').length, 12);
  await page.click('text=メモからまとめて取り込む');
  await page.fill('#imp-text', fs.readFileSync(path.join(__dirname, '../fixtures/memo-basic.txt'), 'utf8'));
  await page.click('[data-action=import-parse]');
  await page.waitForSelector('.imp-list');
  assert.match(await page.locator('[data-action=import-run]').textContent(), /^0件/);
});

test('仕立て直しのチェックを入れて記録すると、それより前を判定に使わない', async (t) => {
  const { ctx, page } = await openApp(web, { demo: true });
  t.after(() => ctx.close());
  await page.waitForSelector('.card');
  await page.locator('.card-weigh').first().click();
  await page.click('details.more summary');
  await page.check('#w-reset');
  await page.click('[data-kind="after"]');
  await typeWeight(page, '1500');
  await page.click('#w-save');
  await page.waitForSelector('.card');
  const pid = await page.evaluate(() => Object.values(JSON.parse(localStorage.getItem('bikaku.demo')).logs).find(l => /仕立て直し/.test(l.memo)).plantId);
  await page.goto(web.url + '#/plant/' + encodeURIComponent(pid));
  await page.waitForSelector('.plant-title');
  assert.match((await page.locator('.panel .note').allTextContents()).join(''), /仕立て直し・植え替えより前の記録は、判定に使っていません/);
});

test('次の水やり予定は、カレンダーの日付で「今日」「明日」「あと○日」と出す', async (t) => {
  const time = new Date('2026-10-22T08:00:00+09:00');
  const at = (d, h) => new Date(`2026-10-${d}T${h}:00:00+09:00`).getTime();
  const mk = (id, name, lastWeight) => ({
    plant: { id, name, variety: '', location: '', style: 'board', memo: '', photo: '', targetWeight: '', createdAt: 1, updatedAt: 1, deleted: false },
    logs: [[at(15, '07'), 600, 'before'], [at(15, '08'), 1100, 'after'], [at(20, '07'), lastWeight + 200, 'regular'], [at(21, '07'), lastWeight + 100, 'regular'], [at(22, '07'), lastWeight, 'regular']]
      .map(([t, w, k], i) => ({ id: id + i, plantId: id, at: t, weight: w, kind: k, memo: '', updatedAt: 1, deleted: false }))
  });
  // 1日100gずつ減る株。目安は600g
  const items = [mk('a', '今日', 650), mk('b', '明日', 720), mk('c', 'あさって以降', 820)];
  const state = { plants: {}, logs: {}, outbox: [], since: 0, lastSyncAt: 0 };
  items.forEach(it => { state.plants[it.plant.id] = it.plant; it.logs.forEach(l => { state.logs[l.id] = l; }); });
  const { ctx, page } = await openApp(web, { demo: true, state, time });
  t.after(() => ctx.close());
  await page.waitForSelector('.card');
  const text = await page.locator('.card').evaluateAll(cs => Object.fromEntries(cs.map(c => [c.querySelector('.card-name').textContent, c.textContent])));
  assert.match(text['今日'], /今日の19時ごろ（10\/22\(木\)）/);
  assert.match(text['明日'], /明日（10\/23\(金\)）/);
  assert.match(text['あさって以降'], /あと2日（10\/24\(土\)）/);
});

test('同期できない原因を見分けて表示する', async (t) => {
  const gas = await startGas();
  t.after(() => closeServer(gas));
  gas.state.mode = 'post-html';                 // 承認が切れたとき
  const { ctx, page } = await openApp(web, { gas });
  t.after(() => ctx.close());
  assert.equal(await syncBadge(page), 'サーバーで保存できません');
  closeServer(gas);
  await page.click('.sync');
  await page.waitForTimeout(300);
  assert.equal(await syncBadge(page), 'サーバーに接続できません');
});

test('成長アルバム：写真の追加・比較・メモ、別の端末でも見られる', async (t) => {
  const gas = await startGas();
  t.after(() => closeServer(gas));
  const { ctx, page } = await openApp(web, { gas });
  t.after(() => ctx.close());
  await addPlant(page, 'アルバム株');
  await page.waitForSelector('#album .actions');
  await page.setInputFiles('#album-input', [PHOTO1, PHOTO2]);
  await page.waitForSelector('.album-item:nth-child(2)');
  await waitSynced(page);
  assert.equal(serverRows(gas, 'アルバム').length, 2);
  await page.click('[data-action=album-compare]');
  await page.waitForSelector('.compare figure:nth-child(2)');
  await page.click('[data-close]');
  await page.locator('.album-item').first().click();
  await page.fill('#v-memo', '新しい葉');
  await page.click('[data-v=save]');
  await waitSynced(page);
  assert.ok(serverRows(gas, 'アルバム').some(r => r[5] === '新しい葉'));
  const b = await openApp(web, { gas, desktop: true });
  t.after(() => b.ctx.close());
  await waitSynced(b.page);
  await b.page.locator('.card-main').first().click();
  await b.page.waitForSelector('.album-item');
  assert.equal(await b.page.locator('.album-item').count(), 2);
  assert.deepEqual(page.errors.concat(b.page.errors), []);
});

test('成長アルバム：古いサーバーには写真を送らず、端末に残す', async (t) => {
  const gas = await startGas();
  t.after(() => closeServer(gas));
  gas.state.mode = 'v1';
  const { ctx, page } = await openApp(web, { gas });
  t.after(() => ctx.close());
  await addPlant(page, '古いサーバーの株');
  await page.waitForSelector('#album .actions');
  await page.setInputFiles('#album-input', [PHOTO1]);
  await page.waitForSelector('.album-item');
  await page.waitForTimeout(2000);
  assert.match(await syncBadge(page), /未送信1件/);
  assert.equal(serverRows(gas, 'アルバム').length, 0);
  assert.equal(await page.locator('#album .msg').count(), 1);
  // サーバーを更新すると送られる
  gas.state.mode = 'ok';
  await page.click('.sync');
  await page.waitForTimeout(500);
  await page.click('.sync');
  await waitSynced(page);
  assert.equal(serverRows(gas, 'アルバム').length, 1);
});

test('天気：地名で地域を選ぶと、天気を取得して詳細画面に表示する', async (t) => {
  const { ctx, page } = await openApp(web, { demo: true });
  t.after(() => ctx.close());
  await page.goto(web.url + '#/settings');
  await page.fill('#place-q', '横浜');
  await page.click('[data-action=place-search]');
  await page.click('[data-place="0"]');
  await page.waitForSelector('text=天気の更新');
  assert.match(await page.locator('text=いまの設定').textContent(), /横浜市/);
  await page.goto(web.url + '#/');
  await page.locator('.card-main').nth(1).click();
  await page.waitForSelector('.kv');
  const kv = await page.locator('.kv').textContent();
  assert.match(kv, /今日の天気/);
  assert.match(kv, /予測の精度±[\d.]+日/);
  assert.deepEqual(page.errors, []);
});

test('一度開いたあとは、サーバーにつながらなくても開ける', async (t) => {
  const web2 = await startWeb();
  t.after(() => closeServer(web2));
  const { ctx, page } = await openApp(web2);
  t.after(() => ctx.close());
  await page.click('text=サンプルデータで試してみる');
  await page.waitForFunction(() => navigator.serviceWorker.controller);
  await page.waitForTimeout(500);
  closeServer(web2);
  await page.reload();
  await page.waitForSelector('.card', { timeout: 15000 });
  assert.equal(await page.locator('.card').count(), 3);
});

test('留守のときの水やり計画：留守中に乾く株と、出発前の水やりを知らせる', async (t) => {
  const { ctx, page } = await openApp(web, { demo: true });
  t.after(() => ctx.close());
  await page.waitForSelector('.card');
  await page.click('text=留守のときの水やり計画');
  await page.waitForSelector('#t-leave');
  // 明日の朝から5日間の留守（サンプルの株は4日・6日・8日ごとに水やり）
  const leave = await page.evaluate(() => { const d = new Date(); d.setDate(d.getDate() + 1); d.setHours(9, 0, 0, 0); return d.getTime(); });
  const toInput = ms => { const d = new Date(ms + 9 * 3600e3); return d.toISOString().slice(0, 16); };
  await page.fill('#t-leave', toInput(leave));
  await page.fill('#t-return', toInput(leave + 5 * 864e5));
  await page.click('[data-action=trip-save]');
  await page.waitForSelector('.panel.trip');
  const titles = (await page.locator('.panel.trip h2').allTextContents()).join(' / ');
  assert.match(titles, /帰宅前に乾きそう（1株）/);    // 4日ごとのリドレイは5日もたない
  assert.match(titles, /出発の直前に水やりを（1株）/);  // 6日ごとのネザーランドは出発前の水やりで持つ
  assert.match(titles, /何もしなくて大丈夫（1株）/);    // ビーチーは帰宅後まで大丈夫
  await page.goto(web.url + '#/');
  assert.match(await page.locator('.trip-banner').textContent(), /留守の予定.*注意 \d株/);
  await page.click('.trip-banner');
  await page.click('[data-action=trip-clear]');
  await page.goto(web.url + '#/');
  assert.equal(await page.locator('.trip-banner').count(), 0);
  assert.deepEqual(page.errors, []);
});

test('取り消し：保存した記録を「元に戻す」で取り消せる', async (t) => {
  const gas = await startGas();
  t.after(() => closeServer(gas));
  const { ctx, page } = await openApp(web, { gas });
  t.after(() => ctx.close());
  await addPlant(page, '取り消し株');
  await page.click('.actions .btn.primary');
  await typeWeight(page, '640');
  await page.click('#w-save');
  await page.waitForSelector('.toast-undo');
  await page.click('.toast-undo');
  await page.waitForSelector('text=取り消しました');
  await waitSynced(page);
  assert.equal(await page.locator('.logs li').count(), 0);
  const rows = serverRows(gas, '記録');
  assert.ok(rows.every(r => r[8] === true), '送ったあとの記録も削除の印になる');
  // 記録の削除も取り消せる
  await page.click('.actions .btn.primary');
  await typeWeight(page, '630');
  await page.click('#w-save');
  await page.waitForSelector('.logs li');
  await page.locator('.logs li button').first().click();
  page.once('dialog', d => d.accept());
  await page.click('[data-action=log-delete]');
  await page.waitForSelector('.toast-undo');
  await page.click('.toast-undo');
  await page.waitForSelector('.logs li');
  assert.equal(await page.locator('.logs li').count(), 1);
});

test('いつもと違う乾き方：同じ時期より速く乾いていると知らせ、「わかった」で消せる', async (t) => {
  const day = 864e5, now = Date.now();
  const start = now - 18 * day;
  const logs = [];
  const add = (d, w, kind) => logs.push({ id: 'x' + logs.length, plantId: 'p', at: start + d * day, weight: w, kind, memo: '', updatedAt: 1, deleted: false });
  for (let c = 0; c < 4; c++) {
    const d = c * 4;
    add(d, 1000, 'after'); add(d + 1, 850, 'regular'); add(d + 2, 770, 'regular'); add(d + 3, 690, 'regular'); add(d + 3.99, 610, 'before');
  }
  add(16, 1000, 'after'); add(16.4, 880, 'regular'); add(17.6, 650, 'regular');   // いつもの同じ時期より速い
  const state = { plants: { p: { id: 'p', name: '速い株', variety: '', location: '', style: 'board', memo: '', photo: '', targetWeight: '', createdAt: 1, updatedAt: 1, deleted: false } }, logs: {}, outbox: [], since: 0, lastSyncAt: 0 };
  logs.forEach(l => { state.logs[l.id] = l; });
  const { ctx, page } = await openApp(web, { demo: true, state });
  t.after(() => ctx.close());
  await page.waitForSelector('.card');
  assert.match(await page.locator('.card-alert').textContent(), /いつもより速い/);
  await page.locator('.card-main').first().click();
  await page.waitForSelector('.panel.anomaly');
  assert.match(await page.locator('.panel.anomaly').textContent(), /1日あたり約\d+g減っています/);
  await page.click('[data-action=anomaly-dismiss]');
  assert.equal(await page.locator('.panel.anomaly').count(), 0);
  await page.goto(web.url + '#/');
  assert.equal(await page.locator('.card-alert').count(), 0);
  assert.deepEqual(page.errors, []);
});

test('デザイン：はじめはビビッドで、設定からシンプルに切り替えられる', async (t) => {
  const { ctx, page } = await openApp(web, { demo: true });
  t.after(() => ctx.close());
  await page.waitForSelector('.card');
  assert.equal(await page.getAttribute('html', 'data-theme'), 'pop');
  await page.goto(web.url + '#/settings');
  await page.click('[data-theme-name="simple"]');
  assert.equal(await page.getAttribute('html', 'data-theme'), 'simple');
  await page.reload();                          // 開き直しても覚えている
  await page.waitForSelector('[data-theme-name="simple"].active');
  assert.equal(await page.getAttribute('html', 'data-theme'), 'simple');
  await page.click('[data-theme-name="pop"]');
  assert.equal(await page.getAttribute('html', 'data-theme'), 'pop');
});
