// 画面のテスト用の道具
'use strict';
const { chromium, devices } = require('playwright');
const { fakeWeather } = require('../helpers/servers');

let browser = null;
async function getBrowser() {
  if (!browser) browser = await chromium.launch();
  return browser;
}
async function closeBrowser() {
  if (browser) await browser.close();
  browser = null;
}

/**
 * iPhone の大きさの画面を開く
 * @param web  画面のサーバー
 * @param opts.gas    つなぐ Apps Script の模型（なければ未設定のまま）
 * @param opts.demo   サンプル表示で始める
 * @param opts.state  端末に保存されたデータ（bikaku.data / bikaku.demo）を最初から入れておく
 * @param opts.time   時計をこの日時に合わせる
 */
async function openApp(web, opts = {}) {
  const b = await getBrowser();
  const ctx = await b.newContext(Object.assign({}, opts.desktop ? { viewport: { width: 1280, height: 900 } } : devices['iPhone 13'], { timezoneId: 'Asia/Tokyo' }));
  await ctx.route('https://api.open-meteo.com/**', r => r.fulfill({ json: fakeWeather(opts.time || new Date()), headers: { 'Access-Control-Allow-Origin': '*' } }));
  await ctx.route('https://geocoding-api.open-meteo.com/**', r => r.fulfill({
    json: { results: [{ name: '横浜市', admin1: '神奈川県', country: '日本', latitude: 35.4437, longitude: 139.638 }] },
    headers: { 'Access-Control-Allow-Origin': '*' }
  }));
  const page = await ctx.newPage();
  page.errors = [];
  page.on('pageerror', e => page.errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error') page.errors.push(m.text()); });
  if (opts.time) await page.clock.install({ time: opts.time });
  await page.goto(web.url);
  const config = opts.gas ? { url: opts.gas.url, passcode: opts.passcode || 'test-pass', demo: false } : (opts.demo ? { url: '', passcode: '', demo: true } : null);
  await page.evaluate(([config, state, demo]) => {
    if (config) localStorage.setItem('bikaku.config', JSON.stringify(config));
    if (state) localStorage.setItem(demo ? 'bikaku.demo' : 'bikaku.data', JSON.stringify(state));
  }, [config, opts.state || null, !!opts.demo]);
  if (config || opts.state) await page.reload();
  return { ctx, page };
}

/** 同期が終わるのを待って、右上の表示を返す */
async function syncBadge(page) {
  await page.waitForFunction(() => document.querySelector('.sync') && !document.querySelector('.sync.syncing'), null, { timeout: 30000 });
  await page.waitForTimeout(200);
  return (await page.locator('.sync').first().textContent()).trim();
}

async function waitSynced(page) {
  await page.waitForFunction(() => {
    const s = document.querySelector('.sync');
    return s && s.textContent.indexOf('同期済み') >= 0;
  }, null, { timeout: 30000 });
}

/** 計量画面で数字キーを押す */
async function typeWeight(page, text) {
  for (const k of text) await page.click(`[data-key="${k}"]`);
}

function serverRows(gas, sheet) {
  const s = gas.env.sheets[sheet];
  return s ? s.data.slice(1) : [];
}

module.exports = { openApp, closeBrowser, syncBadge, waitSynced, typeWeight, serverRows };
