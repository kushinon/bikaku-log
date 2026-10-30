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

test('「水やり前」を記録してから12時間までは「水やり中」（ソーキングで時間がかかっても「まだ大丈夫」にしない）', () => {
  const logs = [log(0, 1000, 'after'), log(2, 800), log(4, 600, 'before'), log(4.01, 1000, 'after'), log(8, 600, 'before')];
  for (const hours of [0.1, 2, 11.9]) {
    const j = S.judgePlant(plant(), logs, T0 + 8 * DAY + hours * 3600e3);
    assert.equal(j.status, 'watering', `${hours}時間後`);
    assert.equal(j.statusLabel, '水やり中');
  }
});

test('最後が「水やり前」のまま12時間以上たつと、水やりしたものとみなす', () => {
  const logs = [log(0, 1000, 'after'), log(2, 800), log(4, 600, 'before'), log(4.01, 1000, 'after'), log(8, 600, 'before')];
  const j = S.judgePlant(plant(), logs, T0 + 8.6 * DAY);
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
  const items = ['ok', 'water', 'unknown', 'soon', 'watering'].map((s, i) => ({ plant: { name: 'p' + i }, judge: { statusOrder: S.STATUS[s].order, predictedAt: null } }));
  assert.deepEqual(S.sortByUrgency(items).map(x => x.plant.name), ['p1', 'p4', 'p3', 'p0', 'p2']);
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

// ---------- 留守のときの水やり計画 ----------

// 4日ごとに水やりしている株（水やり後1000g → 水やり前600g、1日100gずつ減る）
function tripLogs(lastDay, lastWeight) {
  const logs = [];
  for (let c = 0; c < 3; c++) {
    logs.push(log(c * 4, 1000, 'after'), log(c * 4 + 1, 900), log(c * 4 + 2, 800), log(c * 4 + 3, 700), log(c * 4 + 4 - 0.01, 600, 'before'));
  }
  logs.push(log(12, 1000, 'after'));
  if (lastDay) logs.push(log(lastDay, lastWeight));
  return logs;
}

test('留守の計画：帰宅後に水やり時期が来る株は「何もしなくてよい」', () => {
  const logs = tripLogs(12.5, 950);
  const now = T0 + 12.6 * DAY;
  const r = S.planAbsence(plant(), logs, now + 0.5 * DAY, now + 1.5 * DAY, { now });
  assert.equal(r.kind, 'ok');
});

test('留守の計画：留守中に水やり時期が来るが、出発直前の水やりで持つ株', () => {
  const logs = tripLogs(13, 900);
  const now = T0 + 13.1 * DAY;
  const r = S.planAbsence(plant(), logs, now + 1 * DAY, now + 4 * DAY, { now });
  assert.equal(r.kind, 'water-before');
  assert.ok(Math.abs(r.cycleDays - 4) < 0.1, `cycle ${r.cycleDays}`);
  assert.ok(r.spareDays > 0.8 && r.spareDays < 1.2);
});

test('留守の計画：留守が長すぎて、出発直前に水やりしても乾く株', () => {
  const logs = tripLogs(13, 900);
  const now = T0 + 13.1 * DAY;
  const r = S.planAbsence(plant(), logs, now + 1 * DAY, now + 8 * DAY, { now });
  assert.equal(r.kind, 'too-long');
  assert.ok(r.shortDays > 2.8 && r.shortDays < 3.2);
});

test('留守の計画：目安重量がない株は「記録が足りない」', () => {
  const r = S.planAbsence(plant(), [log(0, 900, 'after'), log(1, 850)], T0 + 2 * DAY, T0 + 5 * DAY, { now: T0 + 1.1 * DAY });
  assert.equal(r.kind, 'unknown');
});

// ---------- いつもと違う乾き方 ----------

// 4日ごとに水やり。水やり直後は速く、あとはゆっくり減る（1日目 -150g、2〜4日目 -80g/日）
function anomalyLogs(currentDrops) {
  const logs = [];
  let day = 0;
  for (let c = 0; c < 4; c++) {
    logs.push(log(day, 1000, 'after'), log(day + 1, 850), log(day + 2, 770), log(day + 3, 690), log(day + 4 - 0.01, 610, 'before'));
    day += 4;
  }
  logs.push(log(day, 1000, 'after'));
  let w = 1000;
  currentDrops.forEach((d, i) => { w -= d; logs.push(log(day + i + 1, w)); });
  return { logs, now: T0 + (day + currentDrops.length + 0.1) * DAY };
}

test('乾き方：いつもどおりなら知らせない', () => {
  const { logs } = anomalyLogs([150, 80, 80]);
  assert.equal(S.detectAnomaly(plant(), logs), null);
});

test('乾き方：同じ時期と比べて速いと「速い」', () => {
  const { logs } = anomalyLogs([150, 140, 140]);
  const a = S.detectAnomaly(plant(), logs);
  assert.equal(a.type, 'fast');
  assert.ok(Math.abs(a.usualRate - 80) < 1 && Math.abs(a.currentRate - 140) < 1, JSON.stringify(a));
  assert.equal(a.cycles, 4);
});

test('乾き方：水やり直後の速い減りは「速い」と見なさない（同じ時期どうしで比べる）', () => {
  // 1日目の大きな減り（150g）は除いて、2〜3日目の減り方で比べる
  const { logs } = anomalyLogs([200, 80, 80]);
  assert.equal(S.detectAnomaly(plant(), logs), null);
});

test('乾き方：遅いと「遅い」', () => {
  const { logs } = anomalyLogs([150, 30, 30]);
  assert.equal(S.detectAnomaly(plant(), logs).type, 'slow');
});

test('乾き方：天気が乾きやすかった分は差し引く', () => {
  const { logs } = anomalyLogs([150, 125, 125]);   // いつもの約1.56倍
  const dryNow = weatherFrom(d => (d >= 16 ? 1.6 : 0.8));   // 今回だけ乾きやすい（√2 ≒ 1.4倍）
  assert.equal(S.detectAnomaly(plant(), logs).type, 'fast');                 // 天気を考えなければ「速い」
  assert.equal(S.detectAnomaly(plant(), logs, { weather: dryNow }), null);   // 天気のせいなので知らせない
  const { logs: fast } = anomalyLogs([150, 180, 180]);                      // 天気を差し引いても速い
  const a = S.detectAnomaly(plant(), fast, { weather: dryNow });
  assert.equal(a.type, 'fast');
  assert.ok(a.weatherRatio > 1.3);
});

test('乾き方：過去のサイクルが3回に満たないと判定しない', () => {
  const logs = [log(0, 1000, 'after'), log(1, 850), log(2, 770), log(4, 610, 'before'), log(4.01, 1000, 'after'), log(5, 850), log(6, 700), log(7, 550)];
  assert.equal(S.detectAnomaly(plant(), logs), null);
});

// ---------- 水やり不足 ----------

// 水やり前 → 水やり後 を4回（水やり後は約614g、吸う水は約250g）
function wateringLogs() {
  const logs = [];
  [[380, 636], [370, 626], [340, 586], [360, 611]].forEach(([b, a], i) => {
    logs.push(log(i * 5, b, 'before'), log(i * 5 + 0.01, a, 'after'), log(i * 5 + 2, a - 150));
  });
  return logs;
}

test('水やり不足：水やり後がいつもの9割に届かないと知らせる', () => {
  const logs = wateringLogs();
  logs.push(log(20, 370, 'before'));
  const after = log(20.01, 540, 'after');
  logs.push(after);
  const c = S.checkWatering(plant(), logs, after);
  assert.ok(c, '知らせる');
  assert.equal(c.usualAfter, 618.5);           // 636, 626, 586, 611 の中央値
  assert.equal(c.absorbed, 170);
  assert.ok(Math.abs(c.usualAbsorbed - 253.5) < 0.01);
});

test('水やり不足：ふだんのばらつき（9割以上）なら知らせない', () => {
  const logs = wateringLogs();
  const after = log(20.01, 586, 'after');
  logs.push(log(20, 360, 'before'), after);
  assert.equal(S.checkWatering(plant(), logs, after), null);
});

test('水やり不足：過去の「水やり後」が3回未満なら判定しない', () => {
  const logs = wateringLogs().slice(0, 6);   // 2回分
  const after = log(20.01, 400, 'after');
  logs.push(after);
  assert.equal(S.checkWatering(plant(), logs, after), null);
});

test('水やり不足：仕立て直しの記録や、仕立て直しより前の記録とは比べない', () => {
  const logs = wateringLogs();
  const remount = log(20.01, 500, 'after', '仕立て直し');
  logs.push(remount);
  assert.equal(S.checkWatering(plant(), logs, remount), null);
  const next = log(25.01, 300, 'after');
  logs.push(log(25, 200, 'before'), next);
  assert.equal(S.checkWatering(plant(), logs, next), null);   // 仕立て直し後の「水やり後」はまだ1回
});

test('未来の日時の記録は判定に使わない（さっきの「水やり前」が最新として扱われる）', () => {
  const logs = [log(0, 600, 'before'), log(0.01, 1000, 'after'), log(1, 900), log(2, 800),
    log(3, 640, 'before'), log(3.2, 700)];       // 3.2日目（未来）に「ふだん」の記録がある
  const j = S.judgePlant(plant(), logs, T0 + 3.05 * DAY);
  assert.equal(j.status, 'watering');
  assert.equal(j.futureCount, 1);
  assert.equal(j.latest.weight, 640);
});
