/*
 * ビカクログ サーバー側（Google Apps Script）
 *
 * ・スプレッドシートに「株」「記録」シートを作って読み書きします
 * ・画面（GitHub Pages）からの通信は合言葉（スクリプト プロパティの PASSCODE）で確認します
 * ・毎朝7時に、水やり時期・もうすぐの株をメールで知らせます
 *
 * 合言葉やスプレッドシートの情報はコードに書かず、
 * 「プロジェクトの設定 → スクリプト プロパティ」に保存します。
 */

var SHEET_PLANTS = '株';
var SHEET_LOGS = '記録';

// シートの列（並び順＝スプレッドシートの列の順番）
var PLANT_COLUMNS = [
  ['id', 'ID'], ['name', '名前'], ['variety', '品種'], ['location', '置き場所'], ['style', '仕立て'],
  ['memo', 'メモ'], ['targetWeight', '目安重量(手動)'], ['photo', '写真'],
  ['createdAt', '作成'], ['updatedAt', '更新'], ['deleted', '削除'], ['syncedAt', '保存日時(サーバー)']
];
var LOG_COLUMNS = [
  ['id', 'ID'], ['plantId', '株ID'], ['at', '日時(数値)'], ['atText', '日時'], ['weight', '重さ(g)'],
  ['kind', '種別'], ['memo', 'メモ'], ['updatedAt', '更新'], ['deleted', '削除'], ['syncedAt', '保存日時(サーバー)']
];

var NUMERIC_KEYS = ['at', 'weight', 'targetWeight', 'createdAt', 'updatedAt', 'syncedAt'];

var MAX_FAILS = 20;        // この回数以上合言葉を間違えると、しばらく受け付けません
var LOCK_MINUTES = 10;

// ---------------- 画面からの通信 ----------------

function doGet() {
  return ContentService.createTextOutput('ビカクログのサーバーは動いています。この画面はこのままで大丈夫です。');
}

function doPost(e) {
  var res;
  try {
    var req = JSON.parse(e.postData.contents);
    checkPasscode_(req.passcode);
    if (req.action === 'ping') {
      res = { ok: true, serverTime: Date.now() };
    } else if (req.action === 'sync') {
      res = sync_(req);
    } else {
      throw new Error('不明な操作です');
    }
  } catch (err) {
    res = { ok: false, error: String(err && err.message || err) };
  }
  return ContentService.createTextOutput(JSON.stringify(res)).setMimeType(ContentService.MimeType.JSON);
}

function checkPasscode_(passcode) {
  var expected = PropertiesService.getScriptProperties().getProperty('PASSCODE');
  if (!expected) throw new Error('サーバーに合言葉（PASSCODE）が設定されていません');
  var cache = CacheService.getScriptCache();
  var fails = Number(cache.get('fails') || 0);
  if (fails >= MAX_FAILS) throw new Error('合言葉の間違いが続いたため、' + LOCK_MINUTES + '分ほど受け付けを止めています');
  if (String(passcode || '') !== expected) {
    cache.put('fails', String(fails + 1), LOCK_MINUTES * 60);
    throw new Error('合言葉が違います');
  }
}

/**
 * 端末から届いた変更を保存し、前回以降に変わったデータを返す
 * req.ops: [{table: 'plants'|'logs', record: {...}}]
 * req.since: 前回受け取った serverTime（初回は 0）
 */
function sync_(req) {
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var plantSheet = ensureSheet_(ss, SHEET_PLANTS, PLANT_COLUMNS);
    var logSheet = ensureSheet_(ss, SHEET_LOGS, LOG_COLUMNS);
    var now = Date.now();
    var ops = req.ops || [];
    var touched = { plants: {}, logs: {} };

    var plantOps = ops.filter(function (o) { return o.table === 'plants'; }).map(function (o) { return o.record; });
    var logOps = ops.filter(function (o) { return o.table === 'logs'; }).map(function (o) { return o.record; });
    upsert_(plantSheet, PLANT_COLUMNS, plantOps, now, touched.plants);
    upsert_(logSheet, LOG_COLUMNS, logOps, now, touched.logs);

    var since = Number(req.since) || 0;
    return {
      ok: true,
      serverTime: now,
      plants: readChanged_(plantSheet, PLANT_COLUMNS, since, touched.plants),
      logs: readChanged_(logSheet, LOG_COLUMNS, since, touched.logs)
    };
  } finally {
    lock.releaseLock();
  }
}

function ensureSheet_(ss, name, columns) {
  var sheet = ss.getSheetByName(name);
  if (!sheet) {
    sheet = ss.insertSheet(name);
  }
  if (sheet.getLastRow() === 0) {
    sheet.getRange(1, 1, 1, columns.length).setValues([columns.map(function (c) { return c[1]; })]);
    sheet.setFrozenRows(1);
    sheet.getRange(1, 1, 1, columns.length).setFontWeight('bold').setBackground('#e6efe2');
    // 文字の列は「書式なしテキスト」にして、日付や数値への自動変換を防ぐ
    columns.forEach(function (c, i) {
      if (NUMERIC_KEYS.indexOf(c[0]) < 0 && c[0] !== 'deleted') {
        sheet.getRange(2, i + 1, sheet.getMaxRows() - 1, 1).setNumberFormat('@');
      }
    });
  }
  return sheet;
}

function readAll_(sheet, columns) {
  var last = sheet.getLastRow();
  if (last < 2) return [];
  return sheet.getRange(2, 1, last - 1, columns.length).getValues();
}

function rowToRecord_(row, columns) {
  var r = {};
  columns.forEach(function (c, i) {
    var v = row[i];
    if (c[0] === 'deleted') v = v === true || v === 'TRUE' || v === 'true';
    else if (NUMERIC_KEYS.indexOf(c[0]) >= 0 && c[0] !== 'targetWeight') v = v === '' ? null : Number(v);
    else if (c[0] === 'targetWeight') v = v === '' ? '' : Number(v);
    else if (v instanceof Date) v = v.getTime();
    else v = String(v);
    r[c[0]] = v;
  });
  delete r.atText;
  return r;
}

function recordToRow_(rec, columns, now) {
  return columns.map(function (c) {
    var k = c[0];
    if (k === 'syncedAt') return now;
    if (k === 'atText') return rec.at ? formatDate_(Number(rec.at)) : '';
    if (k === 'deleted') return !!rec.deleted;
    var v = rec[k];
    if (v === null || v === undefined) return '';
    if (typeof v === 'string' && /^[=+\-@]/.test(v) && k !== 'photo') return "'" + v; // 数式として解釈させない
    return v;
  });
}

function upsert_(sheet, columns, records, now, touched) {
  if (!records.length) return;
  var data = readAll_(sheet, columns);
  var idIndex = {};
  data.forEach(function (row, i) { idIndex[String(row[0])] = i; });
  var updIdx = columns.map(function (c) { return c[0]; }).indexOf('updatedAt');
  var appends = [];
  var appendIndex = {};

  records.forEach(function (rec) {
    if (!rec || !rec.id) return;
    var id = String(rec.id);
    touched[id] = true;
    var row = recordToRow_(rec, columns, now);
    if (idIndex.hasOwnProperty(id)) {
      var i = idIndex[id];
      if (Number(data[i][updIdx]) > Number(rec.updatedAt)) return; // サーバーの方が新しい
      sheet.getRange(i + 2, 1, 1, columns.length).setValues([row]);
      data[i] = row;
    } else if (appendIndex.hasOwnProperty(id)) {
      if (Number(appends[appendIndex[id]][updIdx]) <= Number(rec.updatedAt)) appends[appendIndex[id]] = row;
    } else {
      appendIndex[id] = appends.length;
      appends.push(row);
    }
  });

  if (appends.length) {
    sheet.getRange(sheet.getLastRow() + 1, 1, appends.length, columns.length).setValues(appends);
  }
}

function readChanged_(sheet, columns, since, touched) {
  var syncIdx = columns.length - 1;
  return readAll_(sheet, columns)
    .filter(function (row) { return row[0] !== '' && (Number(row[syncIdx]) >= since || touched[String(row[0])]); })
    .map(function (row) { return rowToRecord_(row, columns); });
}

function formatDate_(ms) {
  return Utilities.formatDate(new Date(ms), Session.getScriptTimeZone(), 'yyyy/MM/dd HH:mm');
}

function loadAll_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var plants = readAll_(ensureSheet_(ss, SHEET_PLANTS, PLANT_COLUMNS), PLANT_COLUMNS)
    .map(function (r) { return rowToRecord_(r, PLANT_COLUMNS); })
    .filter(function (p) { return p.id && !p.deleted; });
  var logs = readAll_(ensureSheet_(ss, SHEET_LOGS, LOG_COLUMNS), LOG_COLUMNS)
    .map(function (r) { return rowToRecord_(r, LOG_COLUMNS); })
    .filter(function (l) { return l.id && !l.deleted; });
  return { plants: plants, logs: logs };
}

// ---------------- エディタから実行する関数 ----------------

/** ① 最初に1回実行：シートを作り、毎朝7時の通知を設定します */
function setup() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  ensureSheet_(ss, SHEET_PLANTS, PLANT_COLUMNS);
  ensureSheet_(ss, SHEET_LOGS, LOG_COLUMNS);
  var blank = ss.getSheetByName('シート1') || ss.getSheetByName('Sheet1');
  if (blank && ss.getSheets().length > 2 && blank.getLastRow() === 0) ss.deleteSheet(blank);

  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'sendMorningNotice') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('sendMorningNotice').timeBased().everyDays(1).atHour(7).nearMinute(0).create();

  var pass = PropertiesService.getScriptProperties().getProperty('PASSCODE');
  Logger.log('シートの準備と、毎朝7時の通知の設定が終わりました。（タイムゾーン: ' + Session.getScriptTimeZone() + '）');
  Logger.log(pass ? '合言葉（PASSCODE）は設定済みです。' : '【注意】合言葉（PASSCODE）がまだ設定されていません。README の手順で設定してください。');
}

/** ② 動作確認用：サンプルの株3つと60日ぶんの記録を入れます */
function insertSampleData() {
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var data = BikakuShared.makeSampleData(Date.now());
    var now = Date.now();
    data.plants.forEach(function (p) { p.updatedAt = now; });
    data.logs.forEach(function (l) { l.updatedAt = now; });
    upsert_(ensureSheet_(ss, SHEET_PLANTS, PLANT_COLUMNS), PLANT_COLUMNS, data.plants, now, {});
    upsert_(ensureSheet_(ss, SHEET_LOGS, LOG_COLUMNS), LOG_COLUMNS, data.logs, now, {});
    Logger.log('サンプルの株 ' + data.plants.length + ' 件、記録 ' + data.logs.length + ' 件を入れました。');
  } finally {
    lock.releaseLock();
  }
}

/** ③ サンプルが不要になったら実行：サンプルの株と記録を削除します */
function removeSampleData() {
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var now = Date.now();
    var count = 0;
    [[SHEET_PLANTS, PLANT_COLUMNS], [SHEET_LOGS, LOG_COLUMNS]].forEach(function (def) {
      var sheet = ensureSheet_(ss, def[0], def[1]);
      var records = readAll_(sheet, def[1])
        .map(function (r) { return rowToRecord_(r, def[1]); })
        .filter(function (r) { return String(r.id).indexOf('sample-') === 0 && !r.deleted; });
      records.forEach(function (r) { r.deleted = true; r.updatedAt = now; });
      count += records.length;
      upsert_(sheet, def[1], records, now, {});
    });
    Logger.log('サンプルデータ ' + count + ' 件を削除済みにしました（各端末にも自動で反映されます）。');
  } finally {
    lock.releaseLock();
  }
}

/** 通知のテスト：該当する株がなくても、今の状態をメールで送ります */
function testNotice() {
  sendMorningNotice(true);
}

// ---------------- 毎朝の通知 ----------------

function sendMorningNotice(force) {
  force = force === true;
  var data = loadAll_();
  var now = Date.now();
  var items = BikakuShared.sortByUrgency(data.plants.map(function (p) {
    return { plant: p, judge: BikakuShared.judgePlant(p, data.logs, now) };
  }));
  var due = items.filter(function (it) { return it.judge.status === 'water' || it.judge.status === 'soon'; });
  if (!due.length && !force) return;

  var props = PropertiesService.getScriptProperties();
  var to = props.getProperty('NOTIFY_EMAIL') || Session.getEffectiveUser().getEmail();
  var appUrl = props.getProperty('APP_URL') || '';
  var nWater = due.filter(function (it) { return it.judge.status === 'water'; }).length;
  var nSoon = due.length - nWater;

  var subject = due.length
    ? '【ビカクログ】水やり時期 ' + nWater + '株・もうすぐ ' + nSoon + '株'
    : '【ビカクログ】通知のテスト（今日は水やりが必要な株はありません）';

  var colors = { water: '#c0392b', soon: '#b7791f', ok: '#2f7d4f', unknown: '#777777' };
  var list = force && !due.length ? items : due;
  var text = [];
  var html = ['<div style="font-family:sans-serif;font-size:16px;line-height:1.6">'];
  html.push('<p>おはようございます。今日の水やりの目安です。</p>');
  list.forEach(function (it) {
    var j = it.judge;
    var detail = [];
    if (j.latest) detail.push('最新 ' + j.latest.weight + 'g（' + formatDate_(j.latest.at) + '）');
    if (j.target !== null) detail.push('目安 ' + j.target + 'g');
    if (j.predictedAt !== null) detail.push('予定日 ' + Utilities.formatDate(new Date(j.predictedAt), Session.getScriptTimeZone(), 'M/d'));
    text.push('■ ' + it.plant.name + '：' + j.statusLabel + '\n  ' + detail.join(' / '));
    html.push(
      '<div style="border-left:6px solid ' + colors[j.status] + ';padding:6px 12px;margin:10px 0;background:#f7f7f4">' +
      '<b style="font-size:18px">' + escapeHtml_(it.plant.name) + '</b> ' +
      '<span style="color:' + colors[j.status] + ';font-weight:bold">' + j.statusLabel + '</span><br>' +
      '<span style="color:#555">' + escapeHtml_(detail.join(' / ')) + '</span></div>'
    );
  });
  if (!list.length) {
    text.push('登録されている株はありません。');
    html.push('<p>登録されている株はありません。</p>');
  }
  if (appUrl) {
    text.push('\nアプリを開く: ' + appUrl);
    html.push('<p><a href="' + escapeHtml_(appUrl) + '">ビカクログを開く</a></p>');
  }
  html.push('<p style="color:#888;font-size:13px">このメールは毎朝7時に、水やり時期・もうすぐの株があるときだけ届きます。</p></div>');

  MailApp.sendEmail({ to: to, subject: subject, body: text.join('\n'), htmlBody: html.join('') });
}

function escapeHtml_(s) {
  return String(s).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}
