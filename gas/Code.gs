// ===== ビカクログ サーバー用コード（このファイルの中身をすべて Apps Script に貼り付けます） =====
// ※このファイルは tools/build-gas.js で自動生成しています。直接編集しないでください。

/**
 * @OnlyCurrentDoc
 * （↑ 読み書きを、このコードが入っているスプレッドシートだけに限定する指定です）
 */

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
var SHEET_PHOTOS = 'アルバム';
var SERVER_VERSION = 2;    // 2: アルバムに対応

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

var PHOTO_COLUMNS = [
  ['id', 'ID'], ['plantId', '株ID'], ['at', '日時(数値)'], ['atText', '日時'], ['photo', '写真'],
  ['memo', 'メモ'], ['updatedAt', '更新'], ['deleted', '削除'], ['syncedAt', '保存日時(サーバー)']
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
      res = { ok: true, serverTime: Date.now(), version: SERVER_VERSION };
    } else if (req.action === 'sync') {
      res = sync_(req);
    } else if (req.action === 'photos') {
      res = photos_(req);
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
    var photoOps = ops.filter(function (o) { return o.table === 'photos'; }).map(function (o) { return o.record; });
    upsert_(plantSheet, PLANT_COLUMNS, plantOps, now, touched.plants);
    upsert_(logSheet, LOG_COLUMNS, logOps, now, touched.logs);
    if (photoOps.length) upsert_(ensureSheet_(ss, SHEET_PHOTOS, PHOTO_COLUMNS), PHOTO_COLUMNS, photoOps, now, {});

    var since = Number(req.since) || 0;
    return {
      ok: true,
      version: SERVER_VERSION,
      serverTime: now,
      plants: readChanged_(plantSheet, PLANT_COLUMNS, since, touched.plants),
      logs: readChanged_(logSheet, LOG_COLUMNS, since, touched.logs)
    };
  } finally {
    lock.releaseLock();
  }
}

/** アルバムの写真を返す（写真は大きいので、ふだんの同期とは別に、株ごとに読み込む） */
function photos_(req) {
  var sheet = ensureSheet_(SpreadsheetApp.getActiveSpreadsheet(), SHEET_PHOTOS, PHOTO_COLUMNS);
  var list = readAll_(sheet, PHOTO_COLUMNS)
    .map(function (r) { return rowToRecord_(r, PHOTO_COLUMNS); })
    .filter(function (ph) { return ph.id && !ph.deleted && (!req.plantId || ph.plantId === String(req.plantId)); });
  return { ok: true, version: SERVER_VERSION, photos: list };
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


/*
 * ビカクログ 共通ロジック（画面と Google Apps Script の両方で使います）
 *
 * - 水やり判定（目安重量・次の水やり予定日・色分けの状態）
 * - テスト用サンプルデータの作成
 *
 * このファイルを書き換えたら `node tools/build-gas.js` を実行して
 * gas/Code.gs にも反映してください。
 */
var BikakuShared = (function () {
  'use strict';

  var DAY = 24 * 60 * 60 * 1000;
  var HOUR = 60 * 60 * 1000;

  var CONFIG = {
    SOON_DAYS: 2,          // 予定日までこの日数以内なら「もうすぐ」
    SOON_MARGIN: 0.05,     // 目安重量の +5% 以内なら「もうすぐ」
    TARGET_SAMPLES: 5,     // 目安重量の算出に使う「水やり前」記録の件数（新しい順）
    MIN_SPAN_HOURS: 6,     // 減り方の計算に必要な最短の記録期間
    HISTORY_CYCLES: 3,     // 予測の補助に使う過去の水やりサイクル数
    WEATHER_MIN: 0.6,      // 天気による乾きやすさの補正の下限（ふだんの0.6倍）
    WEATHER_MAX: 1.6,      // 同じく上限（ふだんの1.6倍）
    BACKTEST_CYCLES: 6,    // 予測の精度を確かめる過去のサイクル数
    TRIP_MARGIN_DAYS: 0.5, // 留守の計画：帰宅の半日後までに水やり時期が来る株は、出発前に水やりする
    ANOMALY_FAST: 1.5,     // いつもの1.5倍以上の速さで減っていたら「乾くのが速い」
    ANOMALY_SLOW: 0.6,     // いつもの0.6倍以下なら「乾くのが遅い」
    ANOMALY_MIN_CYCLES: 3, // 比べるのに必要な過去の水やりサイクル数
    UNDERWATER_RATIO: 0.9, // 水やり後の重さが、いつもの水やり後の9割に届かなければ「水やり不足かも」
    UNDERWATER_MIN: 3      // 比べるのに必要な、過去の「水やり後」の記録の数
  };

  var KINDS = {
    before: '水やり前',
    after: '水やり後',
    regular: 'ふだんの計量'
  };

  var STYLES = {
    board: '板付け',
    pot: '鉢',
    hanging: 'ハンギング'
  };

  var STATUS = {
    water: { label: '水やり時期', order: 0 },
    soon: { label: 'もうすぐ', order: 1 },
    ok: { label: 'まだ大丈夫', order: 2 },
    unknown: { label: '記録が足りません', order: 3 }
  };

  // メモにこの言葉がある記録より前は、判定に使わない（株の重さが大きく変わるため）
  var RESET_RE = /仕立て直し|仕立直し|仕立て替え|植え替え|植替え|板替え|付け替え|付替え/;

  function toNumber(v) {
    if (v === null || v === undefined || v === '') return null;
    var n = Number(v);
    return isFinite(n) ? n : null;
  }

  function median(values) {
    if (!values.length) return null;
    var s = values.slice().sort(function (a, b) { return a - b; });
    var mid = Math.floor(s.length / 2);
    return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
  }

  /** 株の記録だけを取り出して日時順に並べる */
  function plantLogs(plantId, logs) {
    return logs
      .filter(function (l) {
        return l.plantId === plantId && !l.deleted && toNumber(l.weight) !== null && toNumber(l.at) !== null;
      })
      .map(function (l) {
        return { id: l.id, at: Number(l.at), weight: Number(l.weight), kind: l.kind, memo: l.memo };
      })
      .sort(function (a, b) { return a.at - b.at; });
  }

  /** 「水やり直前の重さ」の記録から目安重量を自動で算出（新しい5件の中央値） */
  function autoTarget(sorted) {
    var befores = sorted.filter(function (l) { return l.kind === 'before'; });
    var recent = befores.slice(-CONFIG.TARGET_SAMPLES).map(function (l) { return l.weight; });
    var m = median(recent);
    return m === null ? null : Math.round(m);
  }

  /** 最小二乗法で傾き（g/日）を求める。減っていれば正の値を返す */
  function dryingRate(points) {
    if (points.length < 2) return null;
    var span = points[points.length - 1].at - points[0].at;
    if (span < CONFIG.MIN_SPAN_HOURS * HOUR) return null;
    var n = points.length, sx = 0, sy = 0, sxx = 0, sxy = 0;
    var t0 = points[0].at;
    points.forEach(function (p) {
      var x = (p.at - t0) / DAY;
      sx += x; sy += p.weight; sxx += x * x; sxy += x * p.weight;
    });
    var denom = n * sxx - sx * sx;
    if (denom === 0) return null;
    var slope = (n * sxy - sx * sy) / denom;
    return slope < 0 ? -slope : null;
  }

  /** 過去の水やりサイクル（水やり後 → 次の水やり前）の平均の減り方と、その期間 */
  function historicalRate(sorted) {
    var cycles = [];
    var lastAfter = null;
    sorted.forEach(function (l) {
      if (l.kind === 'after') lastAfter = l;
      else if (l.kind === 'before' && lastAfter) {
        var days = (l.at - lastAfter.at) / DAY;
        var drop = lastAfter.weight - l.weight;
        if (days > 0.25 && drop > 0) cycles.push({ rate: drop / days, span: [lastAfter.at, l.at] });
        lastAfter = null;
      }
    });
    if (!cycles.length) return null;
    var recent = cycles.slice(-CONFIG.HISTORY_CYCLES);
    return {
      rate: recent.reduce(function (a, c) { return a + c.rate; }, 0) / recent.length,
      spans: recent.map(function (c) { return c.span; })
    };
  }

  // ---------------- 天気（乾きやすさ） ----------------

  function pad2(n) { return (n < 10 ? '0' : '') + n; }

  /** その時刻の日付（端末の時間帯）を 'YYYY-MM-DD' で返す */
  function dayKey(ms) {
    var d = new Date(ms);
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
  }

  function endOfDay(ms) {
    var d = new Date(ms);
    d.setHours(24, 0, 0, 0);
    return d.getTime();
  }

  /** 期間内の1日ごとの乾きやすさ（飽差 kPa）の平均。データがなければ null */
  function meanVpd(weather, spans) {
    var sum = 0, n = 0;
    spans.forEach(function (span) {
      for (var t = span[0]; t <= span[1] + 1; t = endOfDay(t)) {
        var v = weather.vpd[dayKey(t)];
        if (typeof v === 'number') { sum += v; n++; }
        if (t >= span[1]) break;
      }
    });
    return n ? sum / n : null;
  }

  /**
   * 天気を考えて、目安重量になる時刻を1日ずつ計算する
   * 乾きやすい日（飽差が大きい日）は速く、湿った日はゆっくり減るとみなす。
   * 室内の株も多いので、補正は控えめ（飽差の比の平方根、0.6〜1.6倍）にする
   */
  function projectWithWeather(from, weight, target, rate, vRef, weather) {
    var t = from, remaining = weight - target;
    for (var guard = 0; guard < 400 && remaining > 0; guard++) {
      var v = weather.vpd[dayKey(t)];
      var factor = typeof v === 'number' ? Math.sqrt(Math.max(v, 0.01) / vRef) : 1;
      factor = Math.min(CONFIG.WEATHER_MAX, Math.max(CONFIG.WEATHER_MIN, factor));
      var dayRate = rate * factor;
      var dayEnd = endOfDay(t);
      var loss = dayRate * (dayEnd - t) / DAY;
      if (loss >= remaining) return t + remaining / dayRate * DAY;
      remaining -= loss;
      t = dayEnd;
    }
    return t;
  }

  /**
   * 株の水やり判定
   * @return {{status, statusLabel, target, autoTarget, targetSource, latest,
   *           ratePerDay, rateSource, predictedAt, daysLeft, lastWateredAt, note}}
   */
  function judgePlant(plant, logs, now, opts) {
    now = now || Date.now();
    opts = opts || {};
    var all = plantLogs(plant.id, logs);
    var resetIdx = -1;
    all.forEach(function (l, i) { if (l.memo && RESET_RE.test(l.memo)) resetIdx = i; });
    var sorted = resetIdx > 0 ? all.slice(resetIdx) : all;
    var auto = autoTarget(sorted);
    var manual = toNumber(plant.targetWeight);
    var target = manual !== null && manual > 0 ? manual : auto;
    var r = {
      status: 'unknown',
      target: target,
      autoTarget: auto,
      targetSource: manual !== null && manual > 0 ? 'manual' : (auto !== null ? 'auto' : null),
      latest: sorted.length ? sorted[sorted.length - 1] : null,
      ratePerDay: null,
      rateSource: null,
      predictedAt: null,
      daysLeft: null,
      lastWateredAt: null,
      resetAt: resetIdx > 0 ? all[resetIdx].at : null,
      weatherApplied: false,
      plainPredictedAt: null,
      note: ''
    };

    if (!r.latest) {
      r.note = '計量の記録がまだありません';
      return finish(r);
    }

    // 直近の水やり（水やり後の記録）からの区間を取り出す
    var lastAfterIdx = -1;
    for (var i = sorted.length - 1; i >= 0; i--) {
      if (sorted[i].kind === 'after') { lastAfterIdx = i; break; }
    }
    if (lastAfterIdx >= 0) r.lastWateredAt = sorted[lastAfterIdx].at;
    var segment = lastAfterIdx >= 0 ? sorted.slice(lastAfterIdx) : sorted.slice();

    // 最後が「水やり前」で1時間以上たっている＝水やり後の記録を忘れた可能性。
    // 過去の「水やり後」の重さを使って水やりしたものとみなす
    var current = r.latest;
    if (current.kind === 'before' && now - current.at > HOUR) {
      var afters = sorted.filter(function (l) { return l.kind === 'after'; })
        .slice(-CONFIG.TARGET_SAMPLES).map(function (l) { return l.weight; });
      var afterWeight = median(afters);
      if (afterWeight !== null) {
        current = { at: current.at + 60 * 1000, weight: afterWeight, kind: 'after', virtual: true };
        segment = [current];
        r.lastWateredAt = current.at;
        r.note = '水やり後の重さが未記録のため、過去の記録から推定しています';
      }
    }

    // 水やり直後は余分な水が抜けて急に軽くなるため、「水やり後」の点は除いて減り方を計算する。
    // 足りなければ過去のサイクルの平均、それもなければ水やり後の点も含めて計算する
    var drying = segment.length && segment[0].kind === 'after' ? segment.slice(1) : segment;
    var rate = dryingRate(drying);
    var rateSpans = null;   // 減り方を計算した期間（天気の補正に使う）
    if (rate !== null) {
      r.rateSource = 'recent';
      rateSpans = [[drying[0].at, drying[drying.length - 1].at]];
    } else {
      var hist = historicalRate(sorted);
      if (hist) {
        rate = hist.rate;
        rateSpans = hist.spans;
        r.rateSource = 'history';
      } else if ((rate = dryingRate(segment)) !== null) {
        r.rateSource = 'recent';
        rateSpans = [[segment[0].at, segment[segment.length - 1].at]];
      }
    }
    r.ratePerDay = rate !== null ? Math.round(rate * 10) / 10 : null;

    if (target === null) {
      r.note = r.note || '「水やり前」の記録が1回以上あると目安重量を計算できます';
      return finish(r);
    }

    if (current.kind === 'before' && !current.virtual) {
      r.status = 'water';
      r.predictedAt = current.at;
    } else if (current.weight <= target) {
      r.status = 'water';
      r.predictedAt = current.at;
      if (rate) r.predictedAt = current.at - (target - current.weight) / rate * DAY;
    } else if (rate) {
      r.predictedAt = current.at + (current.weight - target) / rate * DAY;
      r.plainPredictedAt = r.predictedAt;
      var vRef = opts.weather && rateSpans ? meanVpd(opts.weather, rateSpans) : null;
      if (vRef) {
        r.predictedAt = projectWithWeather(current.at, current.weight, target, rate, vRef, opts.weather);
        r.weatherApplied = true;
      }
      var left = (r.predictedAt - now) / DAY;
      if (left <= 0) r.status = 'water';
      else if (left <= CONFIG.SOON_DAYS) r.status = 'soon';
      else r.status = 'ok';
    } else {
      r.status = 'ok';
      r.note = r.note || '予定日の予測には、水やり後から2回以上の計量が必要です';
    }

    if (r.status === 'ok' && current.weight <= target * (1 + CONFIG.SOON_MARGIN)) r.status = 'soon';
    if (r.predictedAt !== null) r.daysLeft = (r.predictedAt - now) / DAY;
    return finish(r);
  }

  /**
   * 予測の精度を、過去の水やりサイクルで確かめる
   * 各サイクルの途中の計量の時点で予測していたら、実際の「水やり前」と何日ずれたかを計算する
   * @return {{cycles, plain, weatherCycles, weatherPlain, weather}} 平均のずれ（日）。計算できなければ null
   */
  function evaluatePlant(plant, logs, weather) {
    var sorted = plantLogs(plant.id, logs);
    var errs = { plain: [], weather: [] };
    var lastAfter = -1;
    var tests = [];
    sorted.forEach(function (l, i) {
      if (l.kind === 'after') lastAfter = i;
      else if (l.kind === 'before' && lastAfter >= 0) {
        var a = sorted[lastAfter];
        var mid = a.at + (l.at - a.at) / 2;
        var best = null;
        for (var k = lastAfter + 1; k < i; k++) {
          if (sorted[k].kind === 'regular' && (!best || Math.abs(sorted[k].at - mid) < Math.abs(best.at - mid))) best = sorted[k];
        }
        if (best) tests.push({ checkpoint: best, actual: l.at });
        lastAfter = -1;
      }
    });
    tests.slice(-CONFIG.BACKTEST_CYCLES).forEach(function (t) {
      var past = logs.filter(function (x) { return x.plantId === plant.id && Number(x.at) <= t.checkpoint.at; });
      var p = judgePlant(plant, past, t.checkpoint.at + 60 * 1000);
      if (p.predictedAt === null || p.status === 'water') return;
      var e = (p.predictedAt - t.actual) / DAY;
      errs.plain.push(e);
      if (weather) {
        var w = judgePlant(plant, past, t.checkpoint.at + 60 * 1000, { weather: weather });
        if (w.weatherApplied) errs.weather.push({ plain: e, weather: (w.predictedAt - t.actual) / DAY });
      }
    });
    function mae(list) { return list.length ? list.reduce(function (s, e) { return s + Math.abs(e); }, 0) / list.length : null; }
    // 天気の補正の良し悪しは、天気のデータがあるサイクルどうしで比べる
    return {
      cycles: errs.plain.length,
      plain: mae(errs.plain),
      weatherCycles: errs.weather.length,
      weatherPlain: mae(errs.weather.map(function (x) { return x.plain; })),
      weather: mae(errs.weather.map(function (x) { return x.weather; }))
    };
  }

  /**
   * 留守のときの水やり計画
   * 出発（leaveAt）から帰宅（returnAt）までの間に、株がどうなるかを判定する
   * @return {{kind, judge, cycleDays, dueAt, emptyAt, spareDays, shortDays}}
   *   kind: 'ok'（何もしなくてよい）／'water-before'（出発直前に水やりすれば帰宅まで持つ）／
   *         'too-long'（出発直前に水やりしても、帰宅前に乾く見込み）／'unknown'（記録が足りない）
   */
  function planAbsence(plant, logs, leaveAt, returnAt, opts) {
    opts = opts || {};
    var j = opts.judge || judgePlant(plant, logs, opts.now || Date.now(), opts);
    var r = { kind: 'unknown', judge: j, cycleDays: null, dueAt: j.predictedAt, emptyAt: null, spareDays: null, shortDays: null };
    if (j.target === null) return r;

    // 水やりしてから、水やり時期になるまでの日数（過去のサイクルの中央値と、今の減り方からの計算の短い方）
    var all = plantLogs(plant.id, logs);
    var resetIdx = -1;
    all.forEach(function (l, i) { if (l.memo && RESET_RE.test(l.memo)) resetIdx = i; });
    var sorted = resetIdx > 0 ? all.slice(resetIdx) : all;
    var durations = [], afters = [], lastAfter = null;
    sorted.forEach(function (l) {
      if (l.kind === 'after') { lastAfter = l; afters.push(l.weight); }
      else if (l.kind === 'before' && lastAfter) { durations.push((l.at - lastAfter.at) / DAY); lastAfter = null; }
    });
    var fromHistory = median(durations.slice(-CONFIG.TARGET_SAMPLES));
    var afterWeight = median(afters.slice(-CONFIG.TARGET_SAMPLES));
    var fromRate = afterWeight !== null && j.ratePerDay ? (afterWeight - j.target) / j.ratePerDay : null;
    var cycle = fromHistory !== null && fromRate !== null ? Math.min(fromHistory, fromRate) : (fromHistory !== null ? fromHistory : fromRate);
    if (cycle === null || cycle <= 0) return r;
    r.cycleDays = cycle;

    if (j.status !== 'water' && j.predictedAt !== null && j.predictedAt >= returnAt + CONFIG.TRIP_MARGIN_DAYS * DAY) {
      r.kind = 'ok';
      return r;
    }
    r.emptyAt = leaveAt + cycle * DAY;
    if (r.emptyAt >= returnAt) {
      r.kind = 'water-before';
      r.spareDays = (r.emptyAt - returnAt) / DAY;
    } else {
      r.kind = 'too-long';
      r.shortDays = (returnAt - r.emptyAt) / DAY;
    }
    return r;
  }

  /** 過去のサイクルの中で、水やりから offset ミリ秒後の重さを、前後の記録から計算する */
  function weightAtOffset(cycle, offset) {
    for (var i = 1; i < cycle.length; i++) {
      var a = cycle[i - 1], b = cycle[i];
      var oa = a.at - cycle[0].at, ob = b.at - cycle[0].at;
      if (offset >= oa && offset <= ob) {
        return ob === oa ? b.weight : a.weight + (b.weight - a.weight) * (offset - oa) / (ob - oa);
      }
    }
    return null;
  }

  /**
   * いつもと違う乾き方を見つける
   * 今回の水やりのあとの減り方と、過去の水やりの「同じ時期（水やりから○日目〜○日目）」の減り方を比べる。
   * 天気のデータがあれば、乾きやすさの違いの分を差し引いて比べる
   * @return {null | {type: 'fast'|'slow', ratio, currentRate, usualRate, cycles, weatherRatio, wateredAt}}
   */
  function detectAnomaly(plant, logs, opts) {
    opts = opts || {};
    var all = plantLogs(plant.id, logs);
    var resetIdx = -1;
    all.forEach(function (l, i) { if (l.memo && RESET_RE.test(l.memo)) resetIdx = i; });
    var sorted = resetIdx > 0 ? all.slice(resetIdx) : all;

    // サイクル（水やり後 → 次の水やり前）に分ける。最後の「水やり後」からは今回のサイクル
    var cycles = [], cur = null;
    sorted.forEach(function (l) {
      if (l.kind === 'after') { cur = [l]; cycles.push(cur); }
      else if (cur) {
        cur.push(l);
        if (l.kind === 'before') cur = null;
      }
    });
    var current = cycles.length ? cycles[cycles.length - 1] : null;
    if (!current || current[current.length - 1].kind === 'before') return null;   // 今は水やり待ち
    var points = current.slice(1);   // 水やり直後の急な減りは除く
    if (points.length < 2) return null;
    var o1 = points[0].at - current[0].at, o2 = points[points.length - 1].at - current[0].at;
    if (o2 - o1 < DAY) return null;  // 1日以上の間がないと比べられない
    var currentRate = dryingRate(points);
    if (currentRate === null) return null;

    var past = cycles.slice(0, -1).filter(function (c) { return c[c.length - 1].kind === 'before'; }).slice(-CONFIG.TARGET_SAMPLES);
    var rates = [], spans = [];
    past.forEach(function (c) {
      var w1 = weightAtOffset(c, o1), w2 = weightAtOffset(c, o2);
      if (w1 === null || w2 === null || w1 <= w2) return;
      rates.push((w1 - w2) / ((o2 - o1) / DAY));
      spans.push([c[0].at + o1, c[0].at + o2]);
    });
    if (rates.length < CONFIG.ANOMALY_MIN_CYCLES) return null;
    var usualRate = median(rates);
    var ratio = currentRate / usualRate;

    // 天気の違いで説明できる分を差し引く
    var weatherRatio = null;
    if (opts.weather) {
      var vNow = meanVpd(opts.weather, [[points[0].at, points[points.length - 1].at]]);
      var vUsual = meanVpd(opts.weather, spans);
      if (vNow && vUsual) {
        weatherRatio = Math.min(CONFIG.WEATHER_MAX, Math.max(CONFIG.WEATHER_MIN, Math.sqrt(vNow / vUsual)));
        ratio = ratio / weatherRatio;
      }
    }
    var type = ratio >= CONFIG.ANOMALY_FAST ? 'fast' : ratio <= CONFIG.ANOMALY_SLOW ? 'slow' : null;
    if (!type) return null;
    return {
      type: type, ratio: ratio, currentRate: currentRate, usualRate: usualRate,
      cycles: rates.length, weatherRatio: weatherRatio, wateredAt: current[0].at
    };
  }

  /**
   * 水やり不足のチェック
   * 「水やり後」の記録 afterLog を、それより前の「水やり後」の重さ（新しい5回の中央値）と比べる。
   * 吸った水の量（水やり後 − 直前の計量）も参考に返す
   * @return {null | {weight, usualAfter, ratio, absorbed, usualAbsorbed, logId}}
   */
  function checkWatering(plant, logs, afterLog) {
    if (!afterLog || afterLog.kind !== 'after' || (afterLog.memo && RESET_RE.test(afterLog.memo))) return null;
    var all = plantLogs(plant.id, logs).filter(function (l) { return l.id !== afterLog.id; });
    var before = all.filter(function (l) { return l.at < afterLog.at; });
    var resetIdx = -1;
    before.forEach(function (l, i) { if (l.memo && RESET_RE.test(l.memo)) resetIdx = i; });
    var past = resetIdx >= 0 ? before.slice(resetIdx) : before;

    var afters = [], absorbed = [];
    past.forEach(function (l, i) {
      if (l.kind !== 'after') return;
      afters.push(l.weight);
      var prev = past[i - 1];
      if (prev && prev.kind !== 'after' && l.at - prev.at < DAY) absorbed.push(l.weight - prev.weight);
    });
    if (afters.length < CONFIG.UNDERWATER_MIN) return null;
    var usualAfter = median(afters.slice(-CONFIG.TARGET_SAMPLES));
    var ratio = afterLog.weight / usualAfter;
    if (ratio >= CONFIG.UNDERWATER_RATIO) return null;

    var prevLog = past[past.length - 1];
    var nowAbsorbed = prevLog && prevLog.kind !== 'after' && afterLog.at - prevLog.at < DAY ? afterLog.weight - prevLog.weight : null;
    return {
      logId: afterLog.id,
      weight: afterLog.weight,
      usualAfter: usualAfter,
      ratio: ratio,
      absorbed: nowAbsorbed,
      usualAbsorbed: absorbed.length ? median(absorbed.slice(-CONFIG.TARGET_SAMPLES)) : null
    };
  }

  function finish(r) {
    r.statusLabel = STATUS[r.status].label;
    r.statusOrder = STATUS[r.status].order;
    return r;
  }

  /** 状態の重要度順（水やり時期 → もうすぐ → まだ大丈夫 → 不明）に並べる */
  function sortByUrgency(items) {
    return items.sort(function (a, b) {
      if (a.judge.statusOrder !== b.judge.statusOrder) return a.judge.statusOrder - b.judge.statusOrder;
      var da = a.judge.predictedAt === null ? Infinity : a.judge.predictedAt;
      var db = b.judge.predictedAt === null ? Infinity : b.judge.predictedAt;
      if (da !== db) return da - db;
      return String(a.plant.name).localeCompare(String(b.plant.name), 'ja');
    });
  }

  // ---------------- サンプルデータ ----------------

  function rng(seed) {
    return function () {
      seed |= 0; seed = seed + 0x6D2B79F5 | 0;
      var t = Math.imul(seed ^ seed >>> 15, 1 | seed);
      t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
  }

  function samplePhoto(bg, leaf) {
    var svg =
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 120">' +
      '<rect width="120" height="120" fill="' + bg + '"/>' +
      '<rect x="40" y="48" width="40" height="40" rx="6" fill="#9a7b55"/>' +
      '<path d="M60 70 C42 60 30 40 24 18 C34 30 42 34 46 30 C44 40 50 50 60 58 Z" fill="' + leaf + '"/>' +
      '<path d="M60 70 C78 60 90 40 96 18 C86 30 78 34 74 30 C76 40 70 50 60 58 Z" fill="' + leaf + '"/>' +
      '<path d="M58 72 C50 86 44 100 40 112 C52 104 58 92 60 80 C62 92 68 104 80 112 C76 100 70 86 62 72 Z" fill="' + leaf + '"/>' +
      '<ellipse cx="60" cy="72" rx="16" ry="10" fill="#c9b26a" opacity="0.9"/>' +
      '</svg>';
    return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
  }

  /**
   * テスト用のサンプルデータを作る（過去60日ぶん）
   * 1株目は「水やり時期」、2株目は「もうすぐ」、3株目は「まだ大丈夫」になるように作ります
   */
  function makeSampleData(now) {
    now = now || Date.now();
    var defs = [
      { id: 'sample-p1', name: 'ネザーランド', variety: 'P. bifurcatum ‘Netherlands’', location: 'リビングの窓辺',
        style: 'board', memo: 'サンプルの株です。設定画面から消せます。', after: 860, before: 620, period: 6, elapsed: 6.4,
        photo: samplePhoto('#e6efe2', '#4f7f3a') },
      { id: 'sample-p2', name: 'リドレイ', variety: 'P. ridleyi', location: '浴室の近く',
        style: 'hanging', memo: '乾きやすいので要注意（サンプル）', after: 520, before: 395, period: 4, elapsed: 2.9,
        photo: samplePhoto('#e2ecef', '#3d7a64') },
      { id: 'sample-p3', name: 'ビーチー', variety: 'P. veitchii', location: 'ベランダ（午前だけ日なた）',
        style: 'pot', memo: 'サンプルの株です。', after: 1240, before: 960, period: 8, elapsed: 2.2,
        photo: samplePhoto('#efe9de', '#6a8a3c') }
    ];
    var plants = [];
    var logs = [];
    var created = now - 62 * DAY;

    defs.forEach(function (d, pi) {
      var rand = rng(1234 + pi * 97);
      plants.push({
        id: d.id, name: d.name, variety: d.variety, location: d.location, style: d.style, memo: d.memo,
        photo: d.photo, targetWeight: '', createdAt: created, updatedAt: created, deleted: false
      });

      // 水やりのタイミングを「今」からさかのぼって決める
      var waterTimes = [];
      var t = now - d.elapsed * DAY;
      while (t > now - 60 * DAY) {
        waterTimes.unshift(t);
        t -= (d.period + (rand() - 0.5) * 1.2) * DAY;
      }

      var n = 0;
      function add(at, weight, kind, memo) {
        n++;
        logs.push({
          id: d.id + '-l' + n, plantId: d.id, at: Math.round(at), weight: Math.round(weight), kind: kind,
          memo: memo || '', updatedAt: created, deleted: false
        });
      }

      waterTimes.forEach(function (wt, wi) {
        var next = wi + 1 < waterTimes.length ? waterTimes[wi + 1] : null;
        var cycleEnd = next || now;
        var period = next ? (next - wt) / DAY : d.period;
        var afterW = d.after + (rand() - 0.5) * 30;
        var beforeW = d.before + (rand() - 0.5) * 24;
        var weightAt = function (time) {
          var x = Math.min(1.15, (time - wt) / DAY / period);
          return beforeW + (afterW - beforeW) * (1 - Math.pow(x, 1.25)) + (rand() - 0.5) * 6;
        };
        add(wt, afterW, 'after', wi === 0 ? '植え替え後はじめての水やり' : '');
        // ふだんの計量（1〜2日おき）
        var c = wt + (0.8 + rand() * 0.6) * DAY;
        while (c < cycleEnd - 0.4 * DAY) {
          add(c, weightAt(c), 'regular');
          c += (1 + rand()) * DAY;
        }
        if (next) add(next - 5 * 60 * 1000, beforeW, 'before', wi % 4 === 1 ? 'ソーキング' : '');
      });

      // 「今」の朝の計量
      var lastWt = waterTimes[waterTimes.length - 1];
      add(now - 2 * HOUR, (function () {
        var x = (now - 2 * HOUR - lastWt) / DAY / d.period;
        return d.before + (d.after - d.before) * (1 - Math.pow(Math.min(1.15, x), 1.25));
      })(), 'regular');
    });

    return { plants: plants, logs: logs };
  }

  return {
    CONFIG: CONFIG,
    RESET_RE: RESET_RE,
    KINDS: KINDS,
    STYLES: STYLES,
    STATUS: STATUS,
    DAY: DAY,
    judgePlant: judgePlant,
    evaluatePlant: evaluatePlant,
    planAbsence: planAbsence,
    detectAnomaly: detectAnomaly,
    checkWatering: checkWatering,
    dayKey: dayKey,
    sortByUrgency: sortByUrgency,
    plantLogs: plantLogs,
    makeSampleData: makeSampleData
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = BikakuShared;
