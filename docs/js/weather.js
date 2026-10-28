/*
 * ビカクログ 天気（乾きやすさ）
 *
 * Open-Meteo（無料・登録不要）から、設定した地域の気温と湿度を取得して、
 * 1日ごとの「飽差（空気の乾きやすさ、kPa）」を計算します。
 * 過去92日ぶんと、この先16日ぶんの予報を使います。
 */
var BikakuWeather = (function () {
  'use strict';

  var CACHE_KEY = 'bikaku.weather';
  var MAX_AGE = 3 * 60 * 60 * 1000;   // 3時間たったら取り直す

  /** 気温（℃）と湿度（%）から飽差（kPa）を計算する */
  function vpd(tempC, rh) {
    var es = 0.6108 * Math.exp(17.27 * tempC / (tempC + 237.3));
    return Math.max(0, es * (1 - rh / 100));
  }

  function readCache() {
    try { return JSON.parse(localStorage.getItem(CACHE_KEY) || 'null'); } catch (e) { return null; }
  }
  function writeCache(v) {
    try { localStorage.setItem(CACHE_KEY, JSON.stringify(v)); } catch (e) { /* 保存できなくても動く */ }
  }

  function getJSON(url) {
    var ctrl = window.AbortController ? new AbortController() : null;
    var timer = ctrl ? setTimeout(function () { ctrl.abort(); }, 20000) : null;
    return fetch(url, { signal: ctrl ? ctrl.signal : undefined }).then(function (res) {
      if (!res.ok) throw new Error('天気の取得に失敗しました（' + res.status + '）');
      return res.json();
    }).finally(function () { if (timer) clearTimeout(timer); });
  }

  /** 1時間ごとのデータを、日付ごとの飽差の平均と、気温・湿度の平均にまとめる */
  function summarize(hourly) {
    var days = {};
    hourly.time.forEach(function (t, i) {
      var temp = hourly.temperature_2m[i], rh = hourly.relative_humidity_2m[i];
      if (typeof temp !== 'number' || typeof rh !== 'number') return;
      var key = t.slice(0, 10);
      var d = days[key] || (days[key] = { v: 0, t: 0, h: 0, n: 0 });
      d.v += vpd(temp, rh); d.t += temp; d.h += rh; d.n++;
    });
    var out = { vpd: {}, temp: {}, rh: {} };
    Object.keys(days).forEach(function (k) {
      var d = days[k];
      if (d.n < 12) return;   // 半日分もない日は使わない
      out.vpd[k] = Math.round(d.v / d.n * 1000) / 1000;
      out.temp[k] = Math.round(d.t / d.n * 10) / 10;
      out.rh[k] = Math.round(d.h / d.n);
    });
    return out;
  }

  /**
   * 天気を取得する（3時間以内に取ったものがあればそれを使う）
   * @param place {lat, lon, name}
   */
  function load(place, force) {
    var cached = readCache();
    if (cached && cached.lat === place.lat && cached.lon === place.lon && !force && Date.now() - cached.fetchedAt < MAX_AGE) {
      return Promise.resolve(cached);
    }
    var url = 'https://api.open-meteo.com/v1/forecast?latitude=' + place.lat + '&longitude=' + place.lon +
      '&hourly=temperature_2m,relative_humidity_2m&past_days=92&forecast_days=16&timezone=auto';
    return getJSON(url).then(function (data) {
      if (!data.hourly || !data.hourly.time) throw new Error('天気のデータを読めませんでした');
      var w = summarize(data.hourly);
      w.lat = place.lat; w.lon = place.lon; w.fetchedAt = Date.now();
      writeCache(w);
      return w;
    });
  }

  /** 取得済みの天気（古くても）を返す。なければ null */
  function cached(place) {
    var c = readCache();
    return c && place && c.lat === place.lat && c.lon === place.lon ? c : null;
  }

  /** 地名で場所を探す */
  function search(name) {
    var url = 'https://geocoding-api.open-meteo.com/v1/search?count=6&language=ja&format=json&name=' + encodeURIComponent(name);
    return getJSON(url).then(function (data) {
      return (data.results || []).map(function (r) {
        return {
          lat: Math.round(r.latitude * 100) / 100,
          lon: Math.round(r.longitude * 100) / 100,
          name: [r.name, r.admin1, r.country].filter(Boolean).join('・')
        };
      });
    });
  }

  /** 端末の現在地を使う（だいたいの位置に丸めて保存する） */
  function current() {
    return new Promise(function (resolve, reject) {
      if (!navigator.geolocation) { reject(new Error('この端末では現在地を使えません')); return; }
      navigator.geolocation.getCurrentPosition(function (pos) {
        resolve({
          lat: Math.round(pos.coords.latitude * 100) / 100,
          lon: Math.round(pos.coords.longitude * 100) / 100,
          name: '現在地（' + pos.coords.latitude.toFixed(2) + ', ' + pos.coords.longitude.toFixed(2) + '）'
        });
      }, function () { reject(new Error('現在地を取得できませんでした（位置情報の許可を確認してください）')); },
      { enableHighAccuracy: false, timeout: 15000, maximumAge: 24 * 3600 * 1000 });
    });
  }

  return { load: load, cached: cached, search: search, current: current, vpd: vpd, summarize: summarize };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = BikakuWeather;
