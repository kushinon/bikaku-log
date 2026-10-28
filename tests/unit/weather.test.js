// 天気（docs/js/weather.js）のテスト
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const W = require('../../docs/js/weather.js');

test('飽差（乾きやすさ）の計算', () => {
  assert.ok(Math.abs(W.vpd(25, 50) - 1.584) < 0.01);
  assert.equal(W.vpd(20, 100), 0);
  assert.ok(W.vpd(30, 40) > W.vpd(15, 80));
});

test('1時間ごとのデータを日ごとにまとめる（半日分ない日は使わない）', () => {
  const time = [], temperature_2m = [], relative_humidity_2m = [];
  for (let h = 0; h < 24; h++) { time.push(`2026-10-01T${String(h).padStart(2, '0')}:00`); temperature_2m.push(20); relative_humidity_2m.push(60); }
  for (let h = 0; h < 6; h++) { time.push(`2026-10-02T0${h}:00`); temperature_2m.push(20); relative_humidity_2m.push(60); }
  const s = W.summarize({ time, temperature_2m, relative_humidity_2m });
  assert.deepEqual(Object.keys(s.vpd), ['2026-10-01']);
  assert.equal(s.temp['2026-10-01'], 20);
  assert.equal(s.rh['2026-10-01'], 60);
  assert.ok(Math.abs(s.vpd['2026-10-01'] - W.vpd(20, 60)) < 0.001);
});
