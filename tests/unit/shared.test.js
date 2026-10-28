// 水やり判定（docs/js/shared.js）のテスト
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const S = require('../../docs/js/shared.js');

const DAY = S.DAY, HOUR = 3600e3;
const T0 = new Date(2026, 7, 1, 8, 0).getTime();   // 2026/8/1 8:00
let n = 0;
const log = (day, weight, kind = 'regular', memo = '') => ({ id: 'l' + (n++), plantId: 'p', at: T0 + day * DAY, weight, kind, memo });
const plant = (extra = {}) => Object.assign({ id: 'p', name: 'テスト' }, extra);

test('サンプルデータは「水やり時期」「もうすぐ」「まだ大丈夫」の3つになる', () => {
  const d = S.makeSampleData(Date.now());
  const st = d.plants.map(p => S.judgePlant(p, d.logs).status);
  assert.deepEqual(st, ['water', 'soon', 'ok']);
});

test('目安重量は「水やり前」の新しい5件の中央値', () => {
  const logs = [600, 610, 590, 620, 605, 640].map((w, i) => log(i, w, 'before'));
  const j = S.judgePlant(plant(), logs, T0 + 7 * DAY);
  assert.equal(j.autoTarget, 610);   // 610,590,620,605,640 の中央値
  assert.equal(j.targetSource, 'auto');
});

test('手動の目安重量は自動計算より優先される', () => {
  const logs = [log(0, 600, 'before'), log(0.01, 900, 'after'), log(1, 850)];
  const j = S.judgePlant(plant({ targetWeight: 700 }), logs, T0 + 1.1 * DAY);
  assert.equal(j.target, 700);
  assert.equal(j.targetSource, 'manual');
});

test('減り方は「水やり後」の点を除いて計算し、予定日を予測する', () => {
  // 水やり直後に大きく減る（余分な水が抜ける）が、その後は1日50gずつ
  const logs = [log(0, 600, 'before'), log(0.01, 1000, 'after'), log(0.5, 850), log(1.5, 800), log(2.5, 750)];
  const j = S.judgePlant(plant(), logs, T0 + 2.6 * DAY);
  assert.equal(j.rateSource, 'recent');
  assert.ok(Math.abs(j.ratePerDay - 50) < 0.5, `減り方 ${j.ratePerDay}`);
  // 750g → 600g は 150g / 50g = 3日後
  assert.ok(Math.abs((j.predictedAt - (T0 + 5.5 * DAY)) / DAY) < 0.05);
  assert.equal(j.status, 'ok');
});

test('目安重量以下なら「水やり時期」、2日以内なら「もうすぐ」', () => {
  const base = [log(0, 600, 'before'), log(0.01, 1000, 'after'), log(1, 900), log(2, 850)];
  assert.equal(S.judgePlant(plant(), base.concat([log(3, 590)]), T0 + 3.1 * DAY).status, 'water');
  assert.equal(S.judgePlant(plant(), base.concat([log(3, 680)]), T0 + 3.1 * DAY).status, 'soon');
});

test('記録が少ないときは過去のサイクルの平均の減り方を使う', () => {
  const logs = [log(0, 1000, 'after'), log(4, 600, 'before'), log(4.01, 1000, 'after')];
  const j = S.judgePlant(plant(), logs, T0 + 4.5 * DAY);
  assert.equal(j.rateSource, 'history');
  assert.ok(Math.abs(j.ratePerDay - 100) < 0.5);
});

test('最後が「水やり前」のまま時間がたつと、水やりしたものとみなす', () => {
  const logs = [log(0, 1000, 'after'), log(2, 800), log(4, 600, 'before'), log(4.01, 1000, 'after'), log(8, 600, 'before')];
  const j = S.judgePlant(plant(), logs, T0 + 8.5 * DAY);
  assert.notEqual(j.status, 'water');
  assert.match(j.note, /推定/);
});

test('「仕立て直し」より前の記録は判定に使わない', () => {
  const logs = [log(0, 600, 'before'), log(0.01, 900, 'after'), log(3, 650),
    log(5, 1800, 'after', '板仕立て直し'), log(7, 1500)];
  const j = S.judgePlant(plant(), logs, T0 + 7.1 * DAY);
  assert.equal(j.resetAt, T0 + 5 * DAY);
  assert.equal(j.target, null);           // 仕立て直し後の「水やり前」がまだない
  assert.equal(j.status, 'unknown');
});

test('記録がない株は「記録が足りません」', () => {
  const j = S.judgePlant(plant(), [], T0);
  assert.equal(j.status, 'unknown');
  assert.equal(j.statusLabel, '記録が足りません');
});

test('状態の重要度順に並べる', () => {
  const items = ['ok', 'water', 'unknown', 'soon'].map((s, i) => ({ plant: { name: 'p' + i }, judge: { statusOrder: S.STATUS[s].order, predictedAt: null } }));
  assert.deepEqual(S.sortByUrgency(items).map(x => x.plant.name), ['p1', 'p3', 'p0', 'p2']);
});

// ---------- 天気 ----------

function weatherFrom(fn, days = 120) {
  const vpd = {};
  for (let d = -10; d < days; d++) vpd[S.dayKey(T0 + d * DAY)] = fn(d);
  return { vpd, fetchedAt: 1 };
}

test('乾きやすい予報なら予定日が早まり、湿った予報なら遅くなる', () => {
  const logs = [log(0, 600, 'before'), log(0.01, 1000, 'after'), log(1, 950), log(2, 900), log(3, 850)];
  const now = T0 + 3.1 * DAY;
  const plain = S.judgePlant(plant(), logs, now);
  const dry = S.judgePlant(plant(), logs, now, { weather: weatherFrom(d => (d <= 3 ? 0.5 : 1.5)) });
  const wet = S.judgePlant(plant(), logs, now, { weather: weatherFrom(d => (d <= 3 ? 0.5 : 0.2)) });
  assert.equal(dry.weatherApplied, true);
  assert.ok(dry.predictedAt < plain.predictedAt, '乾きやすいと早まる');
  assert.ok(wet.predictedAt > plain.predictedAt, '湿っていると遅くなる');
  assert.equal(dry.plainPredictedAt, plain.predictedAt);
});

test('天気の補正は0.6〜1.6倍におさえる', () => {
  const logs = [log(0, 600, 'before'), log(0.01, 1000, 'after'), log(1, 950), log(2, 900), log(3, 850)];
  const now = T0 + 3.1 * DAY;
  const plain = S.judgePlant(plant(), logs, now);
  const dry = S.judgePlant(plant(), logs, now, { weather: weatherFrom(d => (d <= 3 ? 0.1 : 100)) });
  const wet = S.judgePlant(plant(), logs, now, { weather: weatherFrom(d => (d <= 3 ? 100 : 0.1)) });
  const days = j => (j.predictedAt - logs[4].at) / DAY;
  // どんなに極端な天気でも、記録だけの予測の 1/1.6 倍〜1/0.6 倍の間に収まる
  assert.ok(days(dry) < days(plain) && days(dry) >= days(plain) / 1.6 - 0.01, `乾燥 ${days(dry)}`);
  assert.ok(days(wet) > days(plain) && days(wet) <= days(plain) / 0.6 + 0.01, `湿潤 ${days(wet)}`);
});

function synth(corr) {
  // 乾き方が天気に連動する株（corr=true）と、しない株を作る
  let x = 7; const rnd = () => (x = (x * 16807) % 2147483647) / 2147483647;
  const weather = weatherFrom(d => 0.3 + 1.2 * (0.5 + 0.5 * Math.sin(d / 9)) * (0.7 + 0.6 * rnd()), 110);
  const logs = []; let w = 900, t = T0, i = 0;
  logs.push({ id: 's' + i++, plantId: 'p', at: t, weight: w, kind: 'after' });
  while (t < T0 + 95 * DAY) {
    t += DAY;
    w -= 40 * (corr ? Math.sqrt(weather.vpd[S.dayKey(t)] / 0.9) : 1) * (0.9 + 0.2 * rnd());
    if (w <= 600) {
      logs.push({ id: 's' + i++, plantId: 'p', at: t, weight: Math.round(w), kind: 'before' });
      w = 900; t += 300e3;
      logs.push({ id: 's' + i++, plantId: 'p', at: t, weight: w, kind: 'after' });
    } else logs.push({ id: 's' + i++, plantId: 'p', at: t, weight: Math.round(w), kind: 'regular' });
  }
  return { logs, weather };
}

test('予測の精度：天気に連動する株では天気ありの方が当たる', () => {
  const { logs, weather } = synth(true);
  const ev = S.evaluatePlant(plant(), logs, weather);
  assert.ok(ev.weatherCycles >= 2);
  assert.ok(ev.weather < ev.weatherPlain, JSON.stringify(ev));
});

test('予測の精度：天気と無関係な株では天気なしの方が当たる', () => {
  const { logs, weather } = synth(false);
  const ev = S.evaluatePlant(plant(), logs, weather);
  assert.ok(ev.weather > ev.weatherPlain, JSON.stringify(ev));
});

test('予測の精度：サイクルがなければ cycles は 0', () => {
  const ev = S.evaluatePlant(plant(), [log(0, 900, 'after'), log(1, 850)], null);
  assert.equal(ev.cycles, 0);
  assert.equal(ev.plain, null);
});
