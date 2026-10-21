/*
 * ビカクログ 画面と同期の処理
 *
 * データはまずこの端末（localStorage）に保存し、「未送信」の変更を
 * Google Apps Script に送ります。電波がないときは端末にためておき、
 * つながったときに自動で送ります。
 */
(function () {
  'use strict';

  var S = BikakuShared;
  var APP_VERSION = '1.1.0';
  var CONFIG_KEY = 'bikaku.config';
  var PHOTO_MAX_CHARS = 45000;   // スプレッドシートの1セルに入る大きさに収める
  var SYNC_INTERVAL = 60 * 1000;

  // ---------------- 小さな道具 ----------------

  function $(sel, root) { return (root || document).querySelector(sel); }
  function $$(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }

  function h(s) {
    return String(s === null || s === undefined ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function uuid() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    return 'id-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
  }

  var WEEK = ['日', '月', '火', '水', '木', '金', '土'];
  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function fmtDate(ms) { var d = new Date(ms); return (d.getMonth() + 1) + '/' + d.getDate() + '(' + WEEK[d.getDay()] + ')'; }
  function fmtDateTime(ms) { var d = new Date(ms); return fmtDate(ms) + ' ' + d.getHours() + ':' + pad(d.getMinutes()); }
  function fmtAgo(ms) {
    var min = Math.round((Date.now() - ms) / 60000);
    if (min < 1) return 'たった今';
    if (min < 60) return min + '分前';
    var hr = Math.round(min / 60);
    if (hr < 24) return hr + '時間前';
    return Math.round(hr / 24) + '日前';
  }
  function toLocalInput(ms) {
    var d = new Date(ms);
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + 'T' + pad(d.getHours()) + ':' + pad(d.getMinutes());
  }
  function fromLocalInput(v) { var t = new Date(v).getTime(); return isFinite(t) ? t : Date.now(); }
  function fmtWeight(w) { return (Math.round(w * 10) / 10).toLocaleString('ja-JP') + 'g'; }
  function safePhoto(src) { return typeof src === 'string' && /^data:image\//.test(src) ? src : ''; }

  function daysText(j) {
    if (j.predictedAt === null) return '';
    var d = j.daysLeft;
    if (j.status === 'water') {
      return d < -0.5 ? '予定日を ' + Math.round(-d) + '日過ぎています' : '今日が水やりの目安です';
    }
    if (d < 1) return '明日ごろ（' + fmtDate(j.predictedAt) + '）';
    return 'あと約' + Math.round(d) + '日（' + fmtDate(j.predictedAt) + '）';
  }

  var ICONS = {
    leaf: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 14C8 12 5.5 8 4.5 3.5 7 6 9 6.5 10 5.5c-.3 2.5 .7 5 2 6.5"/><path d="M12 14c4-2 6.5-6 7.5-10.5C17 6 15 6.5 14 5.5c.3 2.5-.7 5-2 6.5"/><path d="M12 14c-1.5 3-3 5.5-5 7m5-7c1.5 3 3 5.5 5 7m-5-7v7"/></svg>',
    scale: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="8" width="18" height="13" rx="3"/><path d="M8 8a4 4 0 0 1 8 0"/><path d="M12 12v3"/><path d="M7 4h10"/></svg>',
    gear: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/></svg>',
    plus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>',
    camera: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 8h3l2-3h6l2 3h3a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1z"/><circle cx="12" cy="13.5" r="3.5"/></svg>'
  };
  var STATUS_ICON = { water: '💧', soon: '⏳', ok: '✓', unknown: '…' };

  function toast(msg) {
    var el = $('#toast');
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(toast.t);
    toast.t = setTimeout(function () { el.classList.remove('show'); }, 2600);
  }

  // ---------------- 設定とデータの保存 ----------------

  function readJSON(key, fallback) {
    try { var v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback; } catch (e) { return fallback; }
  }
  function writeJSON(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); return true; }
    catch (e) { toast('端末の保存容量が足りません。写真を減らしてください'); return false; }
  }

  var config = readJSON(CONFIG_KEY, { url: '', passcode: '', demo: false });
  function saveConfig() { writeJSON(CONFIG_KEY, config); }
  function isConfigured() { return !!(config.url && config.passcode); }

  function dataKey() { return config.demo ? 'bikaku.demo' : 'bikaku.data'; }
  function emptyState() { return { plants: {}, logs: {}, outbox: [], since: 0, lastSyncAt: 0 }; }

  var state;
  function loadState() {
    state = readJSON(dataKey(), null) || emptyState();
    if (config.demo && !Object.keys(state.plants).length) {
      var sample = S.makeSampleData(Date.now());
      sample.plants.forEach(function (p) { state.plants[p.id] = p; });
      sample.logs.forEach(function (l) { state.logs[l.id] = l; });
      saveState();
    }
  }
  function saveState() { writeJSON(dataKey(), state); }

  function plantsList() {
    return Object.keys(state.plants).map(function (k) { return state.plants[k]; }).filter(function (p) { return !p.deleted; });
  }
  function logsList() {
    return Object.keys(state.logs).map(function (k) { return state.logs[k]; }).filter(function (l) { return !l.deleted; });
  }
  function judged() {
    var logs = logsList();
    var now = Date.now();
    return S.sortByUrgency(plantsList().map(function (p) { return { plant: p, judge: S.judgePlant(p, logs, now) }; }));
  }

  /** 変更を端末に保存して、未送信リストに積む */
  function put(table, record, defer) {
    record.updatedAt = Math.max(Date.now(), (record.updatedAt || 0) + 1);
    state[table][record.id] = record;
    if (!config.demo) {
      // 同じ記録への未送信の変更（送信中でないもの）は新しいものに置き換える
      state.outbox = state.outbox.filter(function (op) {
        return !(op.table === table && op.record.id === record.id && !inflight[op.opId]);
      });
      state.outbox.push({ opId: uuid(), table: table, record: record });
    }
    if (defer) return;   // まとめて保存するときは、呼び出し側で最後に1回だけ保存する
    saveState();
    scheduleSync(800);
  }

  // ---------------- 同期 ----------------

  var inflight = {};
  var syncing = false;
  var syncError = '';
  var syncTimer = null;

  function scheduleSync(delay) {
    clearTimeout(syncTimer);
    syncTimer = setTimeout(sync, delay || 0);
  }

  function post(body, timeoutMs) {
    var ctrl = window.AbortController ? new AbortController() : null;
    var timer = ctrl ? setTimeout(function () { ctrl.abort(); }, timeoutMs || 25000) : null;
    return fetch(config.url, {
      method: 'POST',
      // text/plain にすると、Apps Script でも余計な事前確認（CORS）なしで送れます
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(body),
      signal: ctrl ? ctrl.signal : undefined,
      redirect: 'follow'
    }).then(function (res) {
      if (!res.ok) throw new Error('サーバーの応答がありません（' + res.status + '）');
      return res.text();
    }).then(function (text) {
      var data;
      try { data = JSON.parse(text); } catch (e) {
        throw new Error('サーバーの応答を読めません。URLとデプロイの設定（アクセスできるユーザー：全員）を確認してください');
      }
      if (!data.ok) throw new Error(data.error || 'サーバーでエラーが起きました');
      return data;
    }).finally(function () { if (timer) clearTimeout(timer); });
  }

  function pickBatch() {
    var batch = [], size = 0;
    for (var i = 0; i < state.outbox.length; i++) {
      var op = state.outbox[i];
      var s = JSON.stringify(op).length;
      if (batch.length && (batch.length >= 100 || size + s > 2000000)) break;
      batch.push(op);
      size += s;
    }
    return batch;
  }

  function mergeIncoming(table, records) {
    var changed = false;
    records.forEach(function (r) {
      var local = state[table][r.id];
      if (!local || Number(r.updatedAt) >= Number(local.updatedAt)) {
        if (table === 'plants' && local && local.photo && r.photo === undefined) r.photo = local.photo;
        state[table][r.id] = r;
        changed = true;
      }
    });
    return changed;
  }

  function sync(full) {
    if (config.demo || !isConfigured()) { renderSyncBadge(); return Promise.resolve(); }
    if (syncing) { scheduleSync(1500); return Promise.resolve(); }
    if (navigator.onLine === false) { syncError = 'offline'; renderSyncBadge(); return Promise.resolve(); }
    syncing = true;
    renderSyncBadge();
    var batch = pickBatch();
    batch.forEach(function (op) { inflight[op.opId] = true; });
    var since = full ? 0 : state.since;

    return post({ action: 'sync', passcode: config.passcode, since: since, ops: batch.map(function (op) {
      return { table: op.table, record: op.record };
    }) }).then(function (data) {
      var sent = {};
      batch.forEach(function (op) { sent[op.opId] = true; });
      state.outbox = state.outbox.filter(function (op) { return !sent[op.opId]; });
      if (full) {
        // 全件読み直し：サーバーのデータで置き換え、未送信の変更だけを上に重ねる
        state.plants = {}; state.logs = {};
        data.plants.forEach(function (p) { state.plants[p.id] = p; });
        data.logs.forEach(function (l) { state.logs[l.id] = l; });
        state.outbox.forEach(function (op) { state[op.table][op.record.id] = op.record; });
      } else {
        mergeIncoming('plants', data.plants);
        mergeIncoming('logs', data.logs);
      }
      state.since = data.serverTime;
      state.lastSyncAt = Date.now();
      syncError = '';
      saveState();
      var received = data.plants.length + data.logs.length;
      if (received && !isEditing()) render();
      return state.outbox.length ? 'more' : 'done';
    }).catch(function (err) {
      syncError = err.name === 'AbortError' || err instanceof TypeError ? 'offline' : err.message;
      return 'error';
    }).then(function (result) {
      batch.forEach(function (op) { delete inflight[op.opId]; });
      syncing = false;
      renderSyncBadge();
      if (result === 'more') return sync();
    });
  }

  function isEditing() {
    var r = currentRoute();
    return r.name === 'edit' || r.name === 'weigh' || r.name === 'log' || r.name === 'settings' || r.name === 'import';
  }

  function syncInfo() {
    if (config.demo) return { cls: '', text: 'サンプル表示' };
    if (!isConfigured()) return { cls: 'error', text: '未設定' };
    var n = state.outbox.length;
    if (syncing) return { cls: 'syncing', text: '同期中…' };
    if (syncError === 'offline') return { cls: 'pending', text: n ? 'オフライン・未送信' + n + '件' : 'オフライン' };
    if (syncError) return { cls: 'error', text: '同期エラー' };
    if (n) return { cls: 'pending', text: '未送信' + n + '件' };
    return { cls: 'ok', text: state.lastSyncAt ? '同期済み' : '未同期' };
  }

  function syncBadgeHTML() {
    var i = syncInfo();
    return '<button class="sync ' + i.cls + '" data-action="sync-now" aria-label="同期の状態：' + h(i.text) + '"><span class="dot"></span>' + h(i.text) + '</button>';
  }
  function renderSyncBadge() {
    $$('.sync').forEach(function (el) { el.outerHTML = syncBadgeHTML(); });
    var st = $('#sync-status');
    if (st) st.innerHTML = syncStatusText();
  }

  // ---------------- 画面の切り替え ----------------

  function currentRoute() {
    var parts = location.hash.replace(/^#\/?/, '').split('/');
    return { name: parts[0] || 'home', id: decodeURIComponent(parts[1] || '') };
  }
  function go(path) { location.hash = '#/' + path; }

  var app = $('#app');
  var viewState = { chartRange: 30, logLimit: 20 };

  function render() {
    var r = currentRoute();
    if (!config.demo && !isConfigured() && r.name !== 'settings') r = { name: 'welcome' };
    var views = { home: viewHome, plant: viewPlant, weigh: viewWeigh, edit: viewEdit, log: viewLog, settings: viewSettings, welcome: viewWelcome, import: viewImport };
    (views[r.name] || viewHome)(r.id);
  }

  function topbar(title, opts) {
    opts = opts || {};
    return '<header class="topbar">' +
      (opts.back ? '<button class="back" data-action="back">‹ 戻る</button>' : '') +
      '<h1>' + h(title) + '</h1>' +
      (opts.sync === false ? '' : syncBadgeHTML()) +
      (opts.gear ? '<button class="icon-btn" data-go="settings" aria-label="設定">' + ICONS.gear + '</button>' : '') +
      '</header>' +
      (config.demo ? '<div class="banner">サンプルデータを表示中です（この端末だけに保存）。<a href="#/settings">設定</a>から本番の接続ができます。</div>' : '');
  }

  function thumbHTML(plant, cls) {
    var src = safePhoto(plant.photo);
    return src ? '<img class="thumb ' + (cls || '') + '" src="' + h(src) + '" alt="">' : '<div class="thumb ' + (cls || '') + '">' + ICONS.leaf + '</div>';
  }

  function badgeHTML(j) {
    return '<span class="badge ' + j.status + '">' + STATUS_ICON[j.status] + ' ' + h(j.statusLabel) + '</span>';
  }

  // ----- 一覧 -----
  function viewHome() {
    var items = judged();
    var count = { water: 0, soon: 0, ok: 0 };
    items.forEach(function (it) { if (count[it.judge.status] !== undefined) count[it.judge.status]++; });
    var html = topbar('ビカクログ', { gear: true }) + '<main>';
    if (!items.length) {
      html += '<div class="empty">' + ICONS.leaf + '<p>株がまだ登録されていません。<br>下のボタンから追加しましょう。</p></div>';
    } else {
      html += '<div class="summary">' +
        '<div class="water"><b>' + count.water + '</b>水やり時期</div>' +
        '<div class="soon"><b>' + count.soon + '</b>もうすぐ</div>' +
        '<div class="ok"><b>' + count.ok + '</b>まだ大丈夫</div></div>';
      items.forEach(function (it) {
        var p = it.plant, j = it.judge;
        var meta = [];
        if (j.latest) meta.push(fmtWeight(j.latest.weight) + (j.target !== null ? ' / 目安 ' + fmtWeight(j.target) : ''));
        var when = daysText(j);
        html += '<div class="card ' + j.status + '">' +
          '<button class="card-main" data-go="plant/' + h(encodeURIComponent(p.id)) + '">' + thumbHTML(p) +
          '<div class="card-body"><div class="card-name">' + h(p.name || '(名前なし)') + '</div>' +
          '<div>' + badgeHTML(j) + '</div>' +
          '<div class="card-meta">' + h(meta.join('')) + '</div>' +
          (when ? '<div class="card-meta">' + h(when) + '</div>' : '') +
          '</div></button>' +
          '<button class="card-weigh" data-go="weigh/' + h(encodeURIComponent(p.id)) + '" aria-label="' + h(p.name) + 'を計量">' + ICONS.scale + '計量</button>' +
          '</div>';
      });
    }
    html += '</main><div class="bottombar"><div class="bottombar-inner">' +
      (items.length ? '<button class="btn primary grow" data-go="weigh/' + h(encodeURIComponent(items[0].plant.id)) + '">' + ICONS.scale + '計量する</button>' : '') +
      '<button class="btn ' + (items.length ? '' : 'primary grow') + '" data-go="edit/new">' + ICONS.plus + '株を追加</button>' +
      '</div></div>';
    app.innerHTML = html;
  }

  // ----- 計量 -----
  var weighState = null;

  function viewWeigh(id) {
    var items = judged();
    if (!items.length) { go('edit/new'); return; }
    var current = items.filter(function (it) { return it.plant.id === id; })[0] || items[0];
    if (!weighState || weighState.plantId !== current.plant.id) {
      var sorted = S.plantLogs(current.plant.id, logsList());
      var last = sorted[sorted.length - 1];
      var kind = 'regular';
      if (last && last.kind === 'before' && Date.now() - last.at < 3 * 3600 * 1000) kind = 'after';
      else if (current.judge.status === 'water') kind = 'before';
      weighState = { plantId: current.plant.id, value: '', kind: kind, at: null, memo: '' };
    }
    var ws = weighState;
    var j = current.judge;
    var ref = [];
    if (j.latest) ref.push('前回 ' + fmtWeight(j.latest.weight) + '（' + fmtDateTime(j.latest.at) + '）');
    if (j.target !== null) ref.push('目安 ' + fmtWeight(j.target));

    var html = topbar('計量', { back: true }) + '<div class="weigh">' +
      '<div class="chips">' + items.map(function (it) {
        return '<button class="chip ' + (it.plant.id === ws.plantId ? 'active' : '') + '" data-weigh-plant="' + h(it.plant.id) + '">' +
          '<span class="dot ' + it.judge.status + '"></span>' + h(it.plant.name || '(名前なし)') + '</button>';
      }).join('') + '</div>' +
      '<div class="ref">' + h(ref.join(' ・ ')) + '</div>' +
      '<div class="display" id="w-display"></div>' +
      '<div class="diff" id="w-diff"></div>' +
      '<div class="seg" role="radiogroup" aria-label="種別">' + ['before', 'after', 'regular'].map(function (k) {
        return '<button role="radio" aria-checked="' + (ws.kind === k) + '" class="' + (ws.kind === k ? 'active' : '') + '" data-kind="' + k + '">' +
          (k === 'regular' ? 'ふだん' : S.KINDS[k]) + '</button>';
      }).join('') + '</div>' +
      '<details class="more"' + (ws.at || ws.memo ? ' open' : '') + '><summary>日時・メモを変更 ▾</summary>' +
      '<div class="field"><label for="w-at">日時</label><input class="input" type="datetime-local" id="w-at" value="' + toLocalInput(ws.at || Date.now()) + '"></div>' +
      '<div class="field"><label for="w-memo">メモ</label><input class="input" id="w-memo" value="' + h(ws.memo) + '" placeholder="例：ソーキング、液肥"></div>' +
      '</details>' +
      '<div class="keypad">' + ['1', '2', '3', '4', '5', '6', '7', '8', '9', '.', '0', 'del'].map(function (k) {
        return '<button class="key ' + (k === 'del' || k === '.' ? 'fn' : '') + '" data-key="' + k + '" aria-label="' + (k === 'del' ? '1文字消す' : k) + '">' + (k === 'del' ? '⌫' : k) + '</button>';
      }).join('') + '</div>' +
      '<div class="save-row"><button class="btn primary grow" id="w-save" data-action="weigh-save">保存</button></div>' +
      '</div>';
    app.innerHTML = html;
    var chip = $('.chip.active');
    if (chip && chip.scrollIntoView) chip.scrollIntoView({ inline: 'center', block: 'nearest' });
    $('#w-at').addEventListener('change', function (e) { ws.at = fromLocalInput(e.target.value); });
    $('#w-memo').addEventListener('input', function (e) { ws.memo = e.target.value; });
    updateWeighDisplay(j);
  }

  function updateWeighDisplay(j) {
    var ws = weighState;
    var d = $('#w-display');
    if (!d) return;
    d.innerHTML = ws.value ? h(ws.value) + '<span class="unit">g</span>' : '<span class="placeholder">0</span><span class="unit">g</span>';
    var diff = '';
    var v = parseFloat(ws.value);
    if (j && isFinite(v) && j.latest) {
      var dw = Math.round((v - j.latest.weight) * 10) / 10;
      diff = '前回から ' + (dw > 0 ? '+' : '') + dw + 'g';
    }
    $('#w-diff').textContent = diff;
    $('#w-save').disabled = !(isFinite(v) && v > 0);
  }

  function weighKey(k) {
    var ws = weighState;
    if (!ws) return;
    if (k === 'del') ws.value = ws.value.slice(0, -1);
    else if (k === '.') { if (ws.value.indexOf('.') < 0) ws.value = (ws.value || '0') + '.'; }
    else {
      var dot = ws.value.indexOf('.');
      if (dot >= 0 && ws.value.length - dot > 1) return;   // 小数は1桁まで
      if (dot < 0 && ws.value.replace(/^0+/, '').length >= 5) return;
      ws.value = ws.value === '0' ? k : ws.value + k;
    }
    var it = judged().filter(function (x) { return x.plant.id === ws.plantId; })[0];
    updateWeighDisplay(it && it.judge);
  }

  function weighSave() {
    var ws = weighState;
    var v = parseFloat(ws.value);
    if (!(isFinite(v) && v > 0)) return;
    put('logs', {
      id: uuid(), plantId: ws.plantId, at: ws.at || Date.now(), weight: Math.round(v * 10) / 10,
      kind: ws.kind, memo: ws.memo || '', deleted: false
    });
    var plant = state.plants[ws.plantId];
    if (ws.kind === 'before') {
      // 水やり前のあとは、続けて水やり後を記録しやすくする
      weighState = { plantId: ws.plantId, value: '', kind: 'after', at: null, memo: '' };
      toast('保存しました。水やり後の重さも続けて記録できます');
      viewWeigh(ws.plantId);
    } else {
      weighState = null;
      toast((plant ? plant.name + '：' : '') + fmtWeight(v) + ' を保存しました');
      history.length > 1 ? history.back() : go('');
    }
  }

  // ----- 株の詳細 -----
  function viewPlant(id) {
    var p = state.plants[id];
    if (!p || p.deleted) { go(''); return; }
    var logs = logsList();
    var j = S.judgePlant(p, logs, Date.now());
    var sorted = S.plantLogs(p.id, logs);
    var tags = [S.STYLES[p.style], p.location].filter(Boolean);

    var html = topbar(p.name || '(名前なし)', { back: true }) + '<main>';
    var photo = safePhoto(p.photo);
    if (photo) html += '<div class="hero"><img src="' + h(photo) + '" alt=""></div>';
    html += '<h2 class="plant-title">' + h(p.name || '(名前なし)') + '</h2>' +
      (p.variety ? '<div class="plant-variety">' + h(p.variety) + '</div>' : '') +
      (tags.length ? '<div class="tags">' + tags.map(function (t) { return '<span class="tag">' + h(t) + '</span>'; }).join('') + '</div>' : '');

    html += '<div class="actions"><button class="btn primary grow" data-go="weigh/' + h(encodeURIComponent(p.id)) + '">' + ICONS.scale + '計量する</button>' +
      '<button class="btn" data-go="edit/' + h(encodeURIComponent(p.id)) + '">編集</button></div>';

    html += '<section class="panel"><div class="status-big">' + badgeHTML(j) +
      '<span class="when">' + h(daysText(j)) + '</span></div><dl class="kv">' +
      '<dt>最新の重さ</dt><dd>' + (j.latest ? fmtWeight(j.latest.weight) + ' <small class="small">' + h(fmtDateTime(j.latest.at)) + '</small>' : '—') + '</dd>' +
      '<dt>水やりの目安</dt><dd>' + (j.target !== null ? fmtWeight(j.target) + ' <small class="small">' + (j.targetSource === 'manual' ? '手動で設定' : '自動計算') + '</small>' : '—') + '</dd>' +
      (j.targetSource === 'manual' && j.autoTarget !== null ? '<dt>自動計算の値</dt><dd>' + fmtWeight(j.autoTarget) + '</dd>' : '') +
      '<dt>減り方</dt><dd>' + (j.ratePerDay !== null ? '1日あたり 約' + j.ratePerDay + 'g <small class="small">' + (j.rateSource === 'recent' ? '直近の記録から' : '過去の平均から') + '</small>' : '—') + '</dd>' +
      '<dt>前回の水やり</dt><dd>' + (j.lastWateredAt ? h(fmtDateTime(j.lastWateredAt)) : '—') + '</dd>' +
      '</dl>' + (j.note ? '<div class="note">' + h(j.note) + '</div>' : '') +
      '<div class="target-edit"><input class="input" id="target-input" inputmode="decimal" placeholder="目安重量を手動で設定（g）" value="' + h(p.targetWeight === null || p.targetWeight === undefined ? '' : p.targetWeight) + '">' +
      '<button class="btn small primary" data-action="target-save">設定</button>' +
      (j.targetSource === 'manual' ? '<button class="btn small" data-action="target-clear">自動に戻す</button>' : '') + '</div>' +
      '<div class="note">目安重量は「水やり前」の記録（新しい5件の中央値）から自動で計算します。手動で入れるとそちらを優先します。</div>' +
      '</section>';

    html += '<section class="panel"><h2>重さの推移</h2><div class="tabs">' +
      [[14, '2週間'], [30, '1か月'], [90, '3か月'], [0, 'すべて']].map(function (t) {
        return '<button class="' + (viewState.chartRange === t[0] ? 'active' : '') + '" data-range="' + t[0] + '">' + t[1] + '</button>';
      }).join('') + '</div><div class="chart" id="chart"></div><div class="chart-tip" id="chart-tip">グラフをタップすると値が見られます</div>' +
      '<div class="chart-key">' +
      '<span><svg viewBox="0 0 22 12"><line x1="0" y1="6" x2="22" y2="6" stroke="var(--chart-line)" stroke-width="2"/><circle cx="11" cy="6" r="3" fill="var(--chart-line)"/></svg>重さ</span>' +
      '<span><svg viewBox="0 0 22 12"><circle cx="11" cy="6" r="5" fill="var(--drop)"/></svg>水やり後</span>' +
      '<span><svg viewBox="0 0 22 12"><circle cx="11" cy="6" r="4" fill="var(--surface)" stroke="var(--text)" stroke-width="2"/></svg>水やり前</span>' +
      '<span><svg viewBox="0 0 22 12"><line x1="0" y1="6" x2="22" y2="6" stroke="var(--water)" stroke-width="2" stroke-dasharray="4 3"/></svg>目安重量</span>' +
      '<span><svg viewBox="0 0 22 12"><line x1="0" y1="6" x2="22" y2="6" stroke="var(--chart-line)" stroke-width="2" stroke-dasharray="2 3"/></svg>予測</span>' +
      '</div></section>';

    var recent = sorted.slice().reverse();
    html += '<section class="panel"><h2>記録（' + recent.length + '件）</h2>';
    if (!recent.length) html += '<p class="small">まだ記録がありません。</p>';
    html += '<ul class="logs">' + recent.slice(0, viewState.logLimit).map(function (l) {
      return '<li><button data-go="log/' + h(encodeURIComponent(l.id)) + '"><span class="w">' + fmtWeight(l.weight) + '</span>' +
        '<span class="d">' + h(fmtDateTime(l.at)) + (l.memo ? '<small>' + h(l.memo) + '</small>' : '') + '</span>' +
        '<span class="kind ' + h(l.kind) + '">' + h(S.KINDS[l.kind] || l.kind) + '</span></button></li>';
    }).join('') + '</ul>';
    if (recent.length > viewState.logLimit) html += '<button class="btn ghost block" data-action="more-logs">もっと見る</button>';
    html += '<button class="btn ghost block" data-go="import/' + h(encodeURIComponent(p.id)) + '">メモからまとめて取り込む</button>';
    html += '</section>';
    if (p.memo) html += '<section class="panel"><h2>メモ</h2><div class="memo">' + h(p.memo) + '</div></section>';
    html += '</main>';
    app.innerHTML = html;
    drawChart($('#chart'), sorted, j, viewState.chartRange);
  }

  // ----- グラフ（SVG） -----
  function niceStep(range, count) {
    var raw = range / count;
    var mag = Math.pow(10, Math.floor(Math.log10(raw)));
    var n = raw / mag;
    return (n < 1.5 ? 1 : n < 3 ? 2 : n < 7 ? 5 : 10) * mag;
  }

  function drawChart(el, sorted, j, rangeDays) {
    if (!el) return;
    var tip = $('#chart-tip');
    if (sorted.length < 1) { el.innerHTML = '<p class="small">記録が増えるとグラフが表示されます。</p>'; tip.textContent = ''; return; }
    var now = Date.now();
    var start = rangeDays ? now - rangeDays * S.DAY : sorted[0].at;
    var pts = sorted.filter(function (l) { return l.at >= start; });
    var prev = sorted.filter(function (l) { return l.at < start; }).pop();
    if (prev) pts.unshift(prev);   // 左端から線がつながるように1点前も使う
    if (!pts.length) { el.innerHTML = '<p class="small">この期間の記録はありません。</p>'; return; }

    var end = now;
    var showProj = j.predictedAt !== null && j.latest && j.status !== 'water' && j.predictedAt > j.latest.at;
    if (showProj) end = Math.max(end, Math.min(j.predictedAt, now + 21 * S.DAY));
    start = Math.min(start, pts[0].at);
    if (!rangeDays) start = pts[0].at - 0.02 * (end - pts[0].at || S.DAY);
    if (prev) start = Math.max(start, now - rangeDays * S.DAY);
    if (end - start < S.DAY) start = end - S.DAY;

    var W = Math.max(280, el.clientWidth || 320), H = 220;
    var m = { l: 44, r: 10, t: 12, b: 26 };
    var ws = pts.map(function (p) { return p.weight; });
    if (j.target !== null) ws.push(j.target);
    var lo = Math.min.apply(null, ws), hi = Math.max.apply(null, ws);
    var padY = Math.max(10, (hi - lo) * 0.12);
    lo -= padY; hi += padY;
    var step = niceStep(hi - lo, 4);
    lo = Math.floor(lo / step) * step; hi = Math.ceil(hi / step) * step;

    function x(t) { return m.l + (t - start) / (end - start) * (W - m.l - m.r); }
    function y(w) { return m.t + (hi - w) / (hi - lo) * (H - m.t - m.b); }

    var s = '<svg viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="重さの推移のグラフ">';
    s += '<defs><clipPath id="plot"><rect x="' + m.l + '" y="0" width="' + (W - m.l - m.r) + '" height="' + H + '"/></clipPath></defs>';
    for (var v = lo; v <= hi + 1e-9; v += step) {
      s += '<line x1="' + m.l + '" x2="' + (W - m.r) + '" y1="' + y(v) + '" y2="' + y(v) + '" stroke="var(--line)" stroke-width="1"/>';
      s += '<text x="' + (m.l - 6) + '" y="' + (y(v) + 4) + '" text-anchor="end">' + Math.round(v) + '</text>';
    }
    var days = (end - start) / S.DAY;
    var tickDays = days <= 10 ? 2 : days <= 21 ? 4 : days <= 45 ? 7 : days <= 120 ? 21 : 60;
    var t0 = new Date(end); t0.setHours(0, 0, 0, 0);
    for (var tt = t0.getTime(); tt >= start; tt -= tickDays * S.DAY) {
      var xx = x(tt);
      if (xx < m.l + 12 || xx > W - m.r - 12) continue;
      s += '<text x="' + xx + '" y="' + (H - 6) + '" text-anchor="middle">' + (new Date(tt).getMonth() + 1) + '/' + new Date(tt).getDate() + '</text>';
    }
    s += '<line x1="' + m.l + '" x2="' + (W - m.r) + '" y1="' + (H - m.b) + '" y2="' + (H - m.b) + '" stroke="var(--line)" stroke-width="1"/>';
    s += '<g clip-path="url(#plot)">';
    // 水やりのタイミング（縦の帯）
    pts.forEach(function (p) {
      if (p.kind === 'after') s += '<line x1="' + x(p.at) + '" x2="' + x(p.at) + '" y1="' + m.t + '" y2="' + (H - m.b) + '" stroke="var(--drop)" stroke-opacity=".18" stroke-width="6"/>';
    });
    // 「今」
    s += '<line x1="' + x(now) + '" x2="' + x(now) + '" y1="' + m.t + '" y2="' + (H - m.b) + '" stroke="var(--muted)" stroke-width="1"/>';
    if (j.target !== null) {
      s += '<line x1="' + m.l + '" x2="' + (W - m.r) + '" y1="' + y(j.target) + '" y2="' + y(j.target) + '" stroke="var(--water)" stroke-width="2" stroke-dasharray="6 4"/>';
    }
    if (showProj) {
      s += '<line x1="' + x(j.latest.at) + '" y1="' + y(j.latest.weight) + '" x2="' + x(j.predictedAt) + '" y2="' + y(j.target) + '" stroke="var(--chart-line)" stroke-width="2" stroke-dasharray="2 4" stroke-linecap="round"/>';
    }
    s += '<polyline fill="none" stroke="var(--chart-line)" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" points="' +
      pts.map(function (p) { return x(p.at).toFixed(1) + ',' + y(p.weight).toFixed(1); }).join(' ') + '"/>';
    pts.forEach(function (p) {
      var cx = x(p.at).toFixed(1), cy = y(p.weight).toFixed(1);
      if (p.kind === 'after') s += '<circle cx="' + cx + '" cy="' + cy + '" r="5" fill="var(--drop)" stroke="var(--surface)" stroke-width="2"/>';
      else if (p.kind === 'before') s += '<circle cx="' + cx + '" cy="' + cy + '" r="4.5" fill="var(--surface)" stroke="var(--text)" stroke-width="2"/>';
      else s += '<circle cx="' + cx + '" cy="' + cy + '" r="3" fill="var(--chart-line)"/>';
    });
    s += '</g>';
    if (j.target !== null) s += '<text x="' + (W - m.r - 2) + '" y="' + (y(j.target) - 6) + '" text-anchor="end">目安 ' + Math.round(j.target) + 'g</text>';
    s += '<line id="crosshair" x1="0" x2="0" y1="' + m.t + '" y2="' + (H - m.b) + '" stroke="var(--text)" stroke-width="1" visibility="hidden"/>';
    s += '<circle id="hover-dot" r="6" fill="none" stroke="var(--text)" stroke-width="2" visibility="hidden"/>';
    s += '</svg>';
    el.innerHTML = s;

    var svg = el.querySelector('svg');
    var visible = pts.filter(function (p) { return p.at >= start; });
    function pick(evt) {
      var rect = svg.getBoundingClientRect();
      var px = (evt.clientX - rect.left) / rect.width * W;
      var best = null, bd = Infinity;
      visible.forEach(function (p) { var d = Math.abs(x(p.at) - px); if (d < bd) { bd = d; best = p; } });
      if (!best) return;
      var ch = svg.querySelector('#crosshair'), dot = svg.querySelector('#hover-dot');
      ch.setAttribute('x1', x(best.at)); ch.setAttribute('x2', x(best.at)); ch.setAttribute('visibility', 'visible');
      dot.setAttribute('cx', x(best.at)); dot.setAttribute('cy', y(best.weight)); dot.setAttribute('visibility', 'visible');
      tip.textContent = fmtDateTime(best.at) + '　' + fmtWeight(best.weight) + '　' + (S.KINDS[best.kind] || '');
    }
    svg.addEventListener('pointerdown', pick);
    svg.addEventListener('pointermove', function (e) { if (e.pointerType === 'mouse' || e.buttons) pick(e); });
  }

  // ----- 株の登録・編集 -----
  var editDraft = null;

  function viewEdit(id) {
    var isNew = id === 'new';
    var p = isNew ? null : state.plants[id];
    if (!isNew && (!p || p.deleted)) { go(''); return; }
    if (!editDraft || (isNew ? !editDraft.isNew : editDraft.id !== p.id)) {
      editDraft = isNew
        ? { id: uuid(), name: '', variety: '', location: '', style: 'board', memo: '', photo: '', targetWeight: '', createdAt: Date.now(), deleted: false, isNew: true }
        : JSON.parse(JSON.stringify(p));
    }
    var d = editDraft;
    var html = topbar(isNew ? '株を追加' : '株を編集', { back: true, sync: false }) + '<main><form id="plant-form" autocomplete="off">' +
      '<div class="field"><span class="label">写真</span><label class="photo-pick">' +
      (safePhoto(d.photo) ? '<img class="thumb" src="' + h(d.photo) + '" alt="">' : '<div class="thumb">' + ICONS.camera + '</div>') +
      '<span class="btn small">' + (d.photo ? '写真を変える' : '写真を選ぶ') + '</span><input type="file" accept="image/*" id="photo-input"></label>' +
      (d.photo ? '<button type="button" class="btn ghost small" data-action="photo-clear">写真を外す</button>' : '') + '</div>' +
      '<div class="field"><label for="f-name">名前（必須）</label><input class="input" id="f-name" name="name" required value="' + h(d.name) + '" placeholder="例：リビングのネザーランド"></div>' +
      '<div class="field"><label for="f-variety">品種</label><input class="input" id="f-variety" name="variety" value="' + h(d.variety) + '" placeholder="例：P. bifurcatum" list="variety-list">' +
      '<datalist id="variety-list">' + ['P. bifurcatum', 'P. bifurcatum ‘Netherlands’', 'P. ridleyi', 'P. veitchii', 'P. willinckii', 'P. superbum', 'P. grande', 'P. coronarium', 'P. alcicorne', 'P. hillii', 'P. stemaria', 'P. elephantotis', 'P. andinum', 'P. wandae', 'P. holttumii', 'P. quadridichotomum', 'P. madagascariense', 'P. ellisii', 'P. wallichii'].map(function (v) { return '<option value="' + h(v) + '">'; }).join('') + '</datalist></div>' +
      '<div class="field"><label for="f-location">置き場所</label><input class="input" id="f-location" name="location" value="' + h(d.location) + '" placeholder="例：東の窓辺"></div>' +
      '<div class="field"><span class="label">仕立て</span><div class="seg" role="radiogroup">' + Object.keys(S.STYLES).map(function (k) {
        return '<button type="button" role="radio" aria-checked="' + (d.style === k) + '" class="' + (d.style === k ? 'active' : '') + '" data-style="' + k + '">' + S.STYLES[k] + '</button>';
      }).join('') + '</div></div>' +
      '<div class="field"><label for="f-target">水やりの目安重量（g）</label><input class="input" id="f-target" name="targetWeight" inputmode="decimal" value="' + h(d.targetWeight === null || d.targetWeight === undefined ? '' : d.targetWeight) + '" placeholder="空欄なら自動で計算">' +
      '<div class="hint">ふだんは空欄のままで大丈夫です。「水やり前」の記録から自動で計算します。</div></div>' +
      '<div class="field"><label for="f-memo">メモ</label><textarea class="input" id="f-memo" name="memo" placeholder="入手日、購入店、肥料など">' + h(d.memo) + '</textarea></div>' +
      '<button class="btn primary block" type="submit">保存</button>' +
      (isNew ? '' : '<div style="height:24px"></div><button class="btn danger block" type="button" data-action="plant-delete">この株を削除</button>') +
      '</form></main>';
    app.innerHTML = html;

    var form = $('#plant-form');
    form.addEventListener('input', function () { readForm(); });
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      readForm();
      if (!d.name.trim()) { toast('名前を入れてください'); $('#f-name').focus(); return; }
      var t = String(d.targetWeight).trim();
      if (t !== '' && !(parseFloat(t) > 0)) { toast('目安重量は数字で入れてください'); return; }
      var rec = {
        id: d.id, name: d.name.trim(), variety: d.variety.trim(), location: d.location.trim(), style: d.style, memo: d.memo,
        photo: d.photo || '', targetWeight: t === '' ? '' : parseFloat(t), createdAt: d.createdAt || Date.now(),
        updatedAt: d.updatedAt || 0, deleted: false
      };
      put('plants', rec);
      editDraft = null;
      toast('保存しました');
      if (isNew) location.replace('#/plant/' + encodeURIComponent(rec.id)); else history.back();
    });
    $('#photo-input').addEventListener('change', function (e) {
      var file = e.target.files && e.target.files[0];
      if (!file) return;
      toast('写真を小さくしています…');
      shrinkPhoto(file).then(function (dataUrl) { readForm(); d.photo = dataUrl; viewEdit(id); })
        .catch(function () { toast('この写真は読み込めませんでした'); });
    });
  }

  function readForm() {
    var d = editDraft, f = $('#plant-form');
    if (!d || !f) return;
    d.name = f.name.value; d.variety = f.variety.value; d.location = f.location.value;
    d.targetWeight = f.targetWeight.value; d.memo = f.memo.value;
  }

  /** 写真を縮小して JPEG の文字列にする（スプレッドシートの1セルに収まる大きさまで） */
  function shrinkPhoto(file) {
    return new Promise(function (resolve, reject) {
      var url = URL.createObjectURL(file);
      var img = new Image();
      img.onload = function () {
        URL.revokeObjectURL(url);
        var sizes = [480, 400, 320, 260, 200];
        for (var i = 0; i < sizes.length; i++) {
          var scale = Math.min(1, sizes[i] / Math.max(img.width, img.height));
          var c = document.createElement('canvas');
          c.width = Math.round(img.width * scale); c.height = Math.round(img.height * scale);
          c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
          for (var q = 0.8; q >= 0.4; q -= 0.1) {
            var out = c.toDataURL('image/jpeg', q);
            if (out.length <= PHOTO_MAX_CHARS) { resolve(out); return; }
          }
        }
        reject(new Error('too large'));
      };
      img.onerror = function () { URL.revokeObjectURL(url); reject(new Error('load error')); };
      img.src = url;
    });
  }

  // ----- 記録の修正 -----
  function viewLog(id) {
    var l = state.logs[id];
    if (!l || l.deleted) { history.back(); return; }
    var p = state.plants[l.plantId];
    var html = topbar('記録の修正', { back: true, sync: false }) + '<main><form id="log-form">' +
      '<p class="small">' + h(p ? p.name : '') + '</p>' +
      '<div class="field"><label for="l-weight">重さ（g）</label><input class="input" id="l-weight" inputmode="decimal" value="' + h(l.weight) + '"></div>' +
      '<div class="field"><span class="label">種別</span><div class="seg">' + ['before', 'after', 'regular'].map(function (k) {
        return '<button type="button" class="' + (l.kind === k ? 'active' : '') + '" data-logkind="' + k + '">' + (k === 'regular' ? 'ふだん' : S.KINDS[k]) + '</button>';
      }).join('') + '</div></div>' +
      '<div class="field"><label for="l-at">日時</label><input class="input" type="datetime-local" id="l-at" value="' + toLocalInput(l.at) + '"></div>' +
      '<div class="field"><label for="l-memo">メモ</label><input class="input" id="l-memo" value="' + h(l.memo) + '"></div>' +
      '<button class="btn primary block" type="submit">保存</button><div style="height:24px"></div>' +
      '<button class="btn danger block" type="button" data-action="log-delete" data-id="' + h(l.id) + '">この記録を削除</button>' +
      '</form></main>';
    app.innerHTML = html;
    var kind = l.kind;
    $$('[data-logkind]').forEach(function (b) {
      b.addEventListener('click', function () {
        kind = b.getAttribute('data-logkind');
        $$('[data-logkind]').forEach(function (x) { x.classList.toggle('active', x === b); });
      });
    });
    $('#log-form').addEventListener('submit', function (e) {
      e.preventDefault();
      var w = parseFloat($('#l-weight').value);
      if (!(w > 0)) { toast('重さを数字で入れてください'); return; }
      var rec = Object.assign({}, l, { weight: Math.round(w * 10) / 10, kind: kind, at: fromLocalInput($('#l-at').value), memo: $('#l-memo').value });
      put('logs', rec);
      toast('修正しました');
      history.back();
    });
  }

  // ----- はじめに -----
  function viewWelcome() {
    app.innerHTML = '<main class="welcome" style="padding-top:calc(24px + var(--safe-top))"><img src="icons/icon-192.png" alt="">' +
      '<h2>ビカクログ</h2><p>ビカクシダの重さを記録して、<br>水やりのタイミングをお知らせします。</p>' +
      '<div class="stack">' +
      '<button class="btn primary block" data-go="settings">接続の設定をする</button>' +
      '<button class="btn block" data-action="demo-on">サンプルデータで試してみる</button>' +
      '</div><p class="small" style="margin-top:20px">接続の設定には、スプレッドシートの「ウェブアプリのURL」と「合言葉」が必要です。<br>くわしくは README の手順をご覧ください。</p></main>';
  }

  // ----- 設定 -----
  function syncStatusText() {
    if (config.demo) return 'サンプル表示中のため、同期はしていません。';
    if (!isConfigured()) return '接続先が未設定です。';
    var parts = ['未送信：' + state.outbox.length + '件'];
    parts.push('最後の同期：' + (state.lastSyncAt ? fmtAgo(state.lastSyncAt) : 'まだ'));
    if (syncError && syncError !== 'offline') parts.push('<span style="color:var(--water)">エラー：' + h(syncError) + '</span>');
    if (syncError === 'offline') parts.push('電波がないため、つながったら自動で送ります');
    return parts.join('<br>');
  }

  // ----- メモからまとめて取り込む -----
  var importState = null;

  function sameMinute(a, b) { return Math.floor(a / 60000) === Math.floor(b / 60000); }

  /** 読み取った記録に「すでに登録済み」の印をつける */
  function markExisting() {
    var is = importState;
    var existing = S.plantLogs(is.plantId, logsList());
    is.entries.forEach(function (e) {
      e.exists = existing.some(function (l) { return sameMinute(l.at, e.at) && Math.abs(l.weight - e.weight) < 0.05; });
      e.checked = !e.exists;
    });
  }

  function viewImport(id) {
    var plants = plantsList().sort(function (a, b) { return String(a.name).localeCompare(String(b.name), 'ja'); });
    if (!plants.length) { toast('先に株を登録してください'); go('edit/new'); return; }
    if (!importState) importState = { plantId: '', text: '', entries: null, skipped: [] };
    var is = importState;
    if (id && state.plants[id] && !is.plantId) is.plantId = id;
    if (!state.plants[is.plantId] || state.plants[is.plantId].deleted) is.plantId = plants[0].id;

    var html = topbar('メモから取り込む', { back: true, sync: false }) + '<main>' +
      '<p class="small" style="font-size:16px">Google Keep などに書いた計量のメモを、そのまま貼り付けてください。日時と重さを読み取って、まとめて記録します。</p>' +
      '<div class="field"><label for="imp-plant">取り込む株</label><select class="input" id="imp-plant">' +
      plants.map(function (p) { return '<option value="' + h(p.id) + '"' + (p.id === is.plantId ? ' selected' : '') + '>' + h(p.name || '(名前なし)') + '</option>'; }).join('') +
      '</select></div>' +
      '<div class="field"><label for="imp-text">メモ</label><textarea class="input" id="imp-text" rows="9" placeholder="例）&#10;• 9/18 21:48: 304g&#10;• 9/18 22:30: 636g (水やり後)&#10;• 9/19 08:27: 600g">' + h(is.text) + '</textarea>' +
      '<div class="hint">1行に「日付 時刻 重さ」があれば読み取れます。（ ）の中はメモになり、「水やり」と書いてあれば「水やり後」になります。年がない日付は今年（未来になる場合は去年）とみなします。</div></div>' +
      '<button class="btn primary block" data-action="import-parse">読み取る</button>';

    if (is.entries) {
      var n = is.entries.filter(function (e) { return e.checked; }).length;
      var nExists = is.entries.filter(function (e) { return e.exists; }).length;
      var nDup = is.entries.reduce(function (a, e) { return a + (e.duplicates || 0); }, 0);
      html += '<section class="panel" style="margin-top:16px"><h2>読み取り結果（' + is.entries.length + '件）</h2>';
      var notes = [];
      if (nDup) notes.push('同じ日時・同じ重さの行 ' + nDup + '件を1件にまとめました。');
      if (nExists) notes.push('すでに登録済みの ' + nExists + '件はチェックを外しています。');
      if (is.entries.some(function (e) { return e.kindGuessed; })) notes.push('「水やり後」の直前の記録は「水やり前」にしています（※印）。');
      notes.push('種別は右の欄で直せます。取り込まない行はチェックを外してください。');
      html += '<p class="small">' + notes.map(h).join('<br>') + '</p>';
      if (!is.entries.length) html += '<p class="msg err">日時と重さを読み取れませんでした。書き方を確認してください。</p>';
      html += '<ul class="imp-list">' + is.entries.map(function (e, i) {
        return '<li class="' + (e.checked ? '' : 'off') + '"><label class="imp-check"><input type="checkbox" data-imp-check="' + i + '"' + (e.checked ? ' checked' : '') + '>' +
          '<span class="imp-main"><b>' + fmtWeight(e.weight) + '</b> <span class="imp-date">' + h(fmtDateTime(e.at)) + '</span>' +
          (e.exists ? ' <span class="kind regular">登録済み</span>' : '') +
          (e.memo ? '<small>' + h(e.memo) + '</small>' : '') + '</span></label>' +
          '<select class="imp-kind" data-imp-kind="' + i + '" aria-label="種別">' + ['before', 'after', 'regular'].map(function (k) {
            return '<option value="' + k + '"' + (e.kind === k ? ' selected' : '') + '>' + (k === 'regular' ? 'ふだん' : S.KINDS[k]) + (e.kindGuessed && e.kind === k ? '※' : '') + '</option>';
          }).join('') + '</select></li>';
      }).join('') + '</ul>';
      if (is.skipped.length) {
        html += '<details class="more" style="text-align:left"><summary style="text-align:left">読み取れなかった行（' + is.skipped.length + '件）▾</summary><pre class="small" style="white-space:pre-wrap">' + h(is.skipped.join('\n')) + '</pre></details>';
      }
      html += '<button class="btn primary block" data-action="import-run"' + (n ? '' : ' disabled') + '>' + n + '件を「' + h(state.plants[is.plantId].name) + '」に取り込む</button></section>';
    }
    html += '</main>';
    app.innerHTML = html;

    $('#imp-text').addEventListener('input', function (e) { is.text = e.target.value; });
    $('#imp-plant').addEventListener('change', function (e) {
      is.plantId = e.target.value;
      if (is.entries) markExisting();
      viewImport();
    });
  }

  function importParse() {
    var is = importState;
    is.text = $('#imp-text').value;
    if (!is.text.trim()) { toast('メモを貼り付けてください'); return; }
    var result = BikakuImporter.parse(is.text, Date.now());
    is.entries = result.entries;
    is.skipped = result.skipped;
    markExisting();
    viewImport();
    var panel = $('.imp-list') || $('.msg.err');
    if (panel && panel.scrollIntoView) panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function importRun() {
    var is = importState;
    var list = is.entries.filter(function (e) { return e.checked; });
    if (!list.length) return;
    list.forEach(function (e) {
      put('logs', { id: uuid(), plantId: is.plantId, at: e.at, weight: e.weight, kind: e.kind, memo: e.memo || '', deleted: false }, true);
    });
    saveState();
    scheduleSync(300);
    var plantId = is.plantId;
    importState = null;
    toast(list.length + '件を取り込みました');
    location.replace('#/plant/' + encodeURIComponent(plantId));
  }

  function viewSettings() {
    var hasSample = plantsList().some(function (p) { return String(p.id).indexOf('sample-') === 0; });
    var html = topbar('設定', { back: true }) + '<main>' +
      '<section class="panel"><h2>接続の設定</h2>' +
      '<div class="field"><label for="s-url">ウェブアプリのURL</label><input class="input" id="s-url" type="url" inputmode="url" autocapitalize="off" autocorrect="off" spellcheck="false" placeholder="https://script.google.com/macros/s/…/exec" value="' + h(config.url) + '"></div>' +
      '<div class="field"><label for="s-pass">合言葉</label><div class="row"><input class="input" id="s-pass" type="password" autocapitalize="off" autocorrect="off" spellcheck="false" value="' + h(config.passcode) + '">' +
      '<button type="button" class="btn small" data-action="toggle-pass">表示</button></div>' +
      '<div class="hint">URLと合言葉はこの端末の中だけに保存されます。</div></div>' +
      '<button class="btn primary block" data-action="settings-save">接続して保存</button>' +
      '<div id="s-msg"></div></section>' +
      '<section class="panel"><h2>記録の取り込み</h2><p class="small">Google Keep などのメモに書いた過去の計量記録を、まとめて取り込めます。</p>' +
      '<button class="btn block" data-go="import/">メモからまとめて取り込む</button></section>' +
      '<section class="panel"><h2>同期</h2><p id="sync-status" class="small" style="font-size:16px">' + syncStatusText() + '</p>' +
      '<div class="stack"><button class="btn block" data-action="sync-now"' + (config.demo ? ' disabled' : '') + '>今すぐ同期</button>' +
      '<button class="btn block" data-action="full-reload"' + (config.demo || !isConfigured() ? ' disabled' : '') + '>サーバーから全データを読み直す</button></div>' +
      '<p class="small">スプレッドシートを直接書き換えたときは「全データを読み直す」を押してください。</p></section>' +
      '<section class="panel"><h2>サンプルデータ</h2>' +
      (config.demo
        ? '<p class="small">いまはサンプルを表示しています。</p><button class="btn block" data-action="demo-off">サンプル表示を終える</button>'
        : '<button class="btn block" data-action="demo-on">サンプルデータで試す（この端末だけ）</button>') +
      (hasSample && !config.demo ? '<div style="height:10px"></div><button class="btn danger block" data-action="remove-samples">サンプルの株と記録を削除する</button>' : '') +
      '</section>' +
      '<p class="small" style="text-align:center">ビカクログ ver.' + APP_VERSION + '</p></main>';
    app.innerHTML = html;
  }

  function settingsSave() {
    var url = $('#s-url').value.trim();
    var pass = $('#s-pass').value;
    var msg = $('#s-msg');
    if (!/^https:\/\/script\.google(usercontent)?\.com\//.test(url)) {
      msg.innerHTML = '<div class="msg err">URLは「https://script.google.com/macros/s/…/exec」の形で入れてください。</div>';
      return;
    }
    if (!pass) { msg.innerHTML = '<div class="msg err">合言葉を入れてください。</div>'; return; }
    msg.innerHTML = '<div class="msg">接続を確認しています…</div>';
    var prev = { url: config.url, passcode: config.passcode };
    config.url = url; config.passcode = pass;
    post({ action: 'ping', passcode: pass }, 20000).then(function () {
      var switching = config.demo;
      config.demo = false;
      saveConfig();
      if (switching) { loadState(); }
      if (prev.url !== url) { state.since = 0; saveState(); }
      msg.innerHTML = '<div class="msg ok">接続できました！データを同期します。</div>';
      sync().then(function () { renderSyncBadge(); });
    }).catch(function (err) {
      config.url = prev.url; config.passcode = prev.passcode;
      var text = err.name === 'AbortError' || err instanceof TypeError ? '接続できませんでした。URLと電波の状態を確認してください。' : err.message;
      msg.innerHTML = '<div class="msg err">' + h(text) + '</div>';
    });
  }

  // ---------------- 操作の受け付け ----------------

  document.addEventListener('click', function (e) {
    var el = e.target.closest('[data-go],[data-action],[data-key],[data-kind],[data-weigh-plant],[data-range],[data-style]');
    if (!el) return;
    if (el.hasAttribute('data-go')) {
      var to = el.getAttribute('data-go');
      if (to.indexOf('weigh/') === 0) weighState = null;
      if (to.indexOf('edit/') === 0) editDraft = null;
      if (to.indexOf('plant/') === 0) viewState.logLimit = 20;
      if (to.indexOf('import/') === 0) importState = null;
      go(to);
      return;
    }
    if (el.hasAttribute('data-key')) { weighKey(el.getAttribute('data-key')); return; }
    if (el.hasAttribute('data-kind')) {
      weighState.kind = el.getAttribute('data-kind');
      $$('[data-kind]').forEach(function (b) { var on = b === el; b.classList.toggle('active', on); b.setAttribute('aria-checked', on); });
      return;
    }
    if (el.hasAttribute('data-weigh-plant')) {
      weighState = null;
      location.replace('#/weigh/' + encodeURIComponent(el.getAttribute('data-weigh-plant')));
      return;
    }
    if (el.hasAttribute('data-range')) { viewState.chartRange = Number(el.getAttribute('data-range')); render(); return; }
    if (el.hasAttribute('data-style')) {
      readForm();
      editDraft.style = el.getAttribute('data-style');
      $$('[data-style]').forEach(function (b) { var on = b === el; b.classList.toggle('active', on); b.setAttribute('aria-checked', on); });
      return;
    }
    var action = el.getAttribute('data-action');
    var r = currentRoute();
    switch (action) {
      case 'back':
        if (history.length > 1) history.back(); else go('');
        break;
      case 'sync-now':
        if (config.demo) { toast('サンプル表示中は同期しません'); break; }
        if (!isConfigured()) { go('settings'); break; }
        syncError = '';
        sync().then(function () { toast(syncError && syncError !== 'offline' ? syncError : syncError === 'offline' ? '電波がありません。つながったら自動で送ります' : '同期しました'); });
        break;
      case 'weigh-save': weighSave(); break;
      case 'target-save': {
        var v = parseFloat($('#target-input').value);
        if (!(v > 0)) { toast('目安重量を数字で入れてください'); break; }
        var p1 = Object.assign({}, state.plants[r.id], { targetWeight: Math.round(v * 10) / 10 });
        put('plants', p1); toast('目安重量を ' + fmtWeight(v) + ' にしました'); render();
        break;
      }
      case 'target-clear': {
        var p2 = Object.assign({}, state.plants[r.id], { targetWeight: '' });
        put('plants', p2); toast('自動計算に戻しました'); render();
        break;
      }
      case 'more-logs': viewState.logLimit += 50; render(); break;
      case 'import-parse': importParse(); break;
      case 'import-run': importRun(); break;
      case 'photo-clear': readForm(); editDraft.photo = ''; viewEdit(r.id); break;
      case 'plant-delete': {
        var p3 = state.plants[r.id];
        if (!p3 || !confirm('「' + p3.name + '」を削除しますか？')) break;
        put('plants', Object.assign({}, p3, { deleted: true }));
        editDraft = null; toast('削除しました'); location.replace('#/');
        break;
      }
      case 'log-delete': {
        var l = state.logs[el.getAttribute('data-id')];
        if (!l || !confirm('この記録を削除しますか？')) break;
        put('logs', Object.assign({}, l, { deleted: true }));
        toast('削除しました'); history.back();
        break;
      }
      case 'toggle-pass': {
        var input = $('#s-pass');
        input.type = input.type === 'password' ? 'text' : 'password';
        el.textContent = input.type === 'password' ? '表示' : '隠す';
        break;
      }
      case 'settings-save': settingsSave(); break;
      case 'full-reload':
        if (!confirm('サーバーから全データを読み直します。よろしいですか？（未送信の記録は消えません）')) break;
        sync(true).then(function () { toast(syncError ? '読み直せませんでした' : '読み直しました'); render(); });
        break;
      case 'demo-on':
        config.demo = true; saveConfig(); loadState(); toast('サンプルデータを表示します'); go(''); render();
        break;
      case 'demo-off':
        config.demo = false; saveConfig(); loadState(); toast('サンプル表示を終えました'); go(''); render(); sync();
        break;
      case 'remove-samples': {
        if (!confirm('サンプルの株と記録をすべて削除しますか？')) break;
        plantsList().concat(logsList()).forEach(function (rec) {
          if (String(rec.id).indexOf('sample-') === 0) put(rec.plantId ? 'logs' : 'plants', Object.assign({}, rec, { deleted: true }));
        });
        toast('サンプルを削除しました'); render();
        break;
      }
    }
  });

  // 取り込み画面のチェックと種別の変更
  document.addEventListener('change', function (e) {
    if (!importState || !importState.entries) return;
    var t = e.target;
    if (t.hasAttribute('data-imp-check')) {
      importState.entries[Number(t.getAttribute('data-imp-check'))].checked = t.checked;
      viewImport();
    } else if (t.hasAttribute('data-imp-kind')) {
      var en = importState.entries[Number(t.getAttribute('data-imp-kind'))];
      en.kind = t.value;
      en.kindGuessed = false;
    }
  });

  // パソコンのキーボードでも計量を入力できるように
  document.addEventListener('keydown', function (e) {
    if (currentRoute().name !== 'weigh' || !weighState) return;
    if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA')) return;
    if (/^[0-9.]$/.test(e.key)) { weighKey(e.key); e.preventDefault(); }
    else if (e.key === 'Backspace') { weighKey('del'); e.preventDefault(); }
    else if (e.key === 'Enter') { weighSave(); e.preventDefault(); }
  });

  window.addEventListener('hashchange', function () { window.scrollTo(0, 0); render(); });
  window.addEventListener('online', function () { syncError = ''; sync(); });
  window.addEventListener('offline', function () { syncError = 'offline'; renderSyncBadge(); });
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible') {
      // 別の端末やタブでの変更を取り込む
      var fresh = readJSON(dataKey(), null);
      if (fresh && fresh.outbox) { state = fresh; }
      if (!isEditing()) render();
      sync();
    }
  });
  window.addEventListener('storage', function (e) {
    if (e.key === dataKey()) { state = readJSON(dataKey(), state); if (!isEditing()) render(); }
  });
  var resizeTimer;
  window.addEventListener('resize', function () {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(function () { if (currentRoute().name === 'plant') render(); }, 200);
  });
  setInterval(function () { if (document.visibilityState === 'visible') sync(); }, SYNC_INTERVAL);

  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    navigator.serviceWorker.register('sw.js').catch(function () { /* オフライン機能なしでも動きます */ });
  }

  loadState();
  render();
  sync();
})();
