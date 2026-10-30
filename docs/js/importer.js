/*
 * ビカクログ メモの取り込み
 *
 * Google Keep などに書いた計量メモを読み取って、記録の形に変換します。
 * 例）
 *   • 日時: 2026/09/17 21:20
 *   • 重量: 460g
 *   • 9/18 21:48: 304g
 *   • 9/18 22:30: 636g (水やり後)
 */
var BikakuImporter = (function () {
  'use strict';

  var HOUR = 60 * 60 * 1000;
  var BEFORE_WINDOW = 6 * HOUR;   // 水やり後の直前、この時間以内の軽い記録は「水やり前」とみなす
  var JUMP_RATIO = 1.1;
  var FUTURE_GRACE = 10 * 60 * 1000;   // これより先の未来の日時は取り込まない           // 前の記録より1割以上重くなっていたら、水やりしたとみなす

  /** 全角の数字・記号を半角にそろえる */
  function normalize(s) {
    return String(s)
      .replace(/[０-９]/g, function (c) { return String.fromCharCode(c.charCodeAt(0) - 0xFEE0); })
      .replace(/[：]/g, ':').replace(/[／]/g, '/').replace(/[（]/g, '(').replace(/[）]/g, ')')
      .replace(/[．]/g, '.').replace(/[ｇ]/g, 'g').replace(/　/g, ' ');
  }

  var DATE_RE = /(?:(\d{4})\s*[\/\-.年]\s*)?(\d{1,2})\s*[\/\-.月]\s*(\d{1,2})日?(?:\s*\([^)]*\))?(?:\s+(\d{1,2})\s*[:時]\s*(\d{1,2})分?)?/;
  var WEIGHT_RE = /(\d+(?:\.\d+)?)\s*(?:g|グラム)(?![a-zA-Z])/i;

  function guessKind(memo) {
    if (!memo) return null;
    if (/水やり前|潅水前|灌水前/.test(memo)) return 'before';
    if (/水やり|潅水|灌水|ソーキング|水を?あげ|満水/.test(memo)) return 'after';
    return null;
  }

  /**
   * テキストを読み取る
   * @return {{entries: Array<{at, weight, kind, memo, kindGuessed}>, skipped: string[]}}
   */
  function parse(text, now) {
    now = now || Date.now();
    var lines = normalize(text).split(/\r?\n/);
    var entries = [];
    var skipped = [];
    var year = null;
    var lastMonth = null;
    var pendingDate = null;   // 「日時: …」だけの行（次の「重量: …」の行と組み合わせる）

    function makeDate(m) {
      var y = m[1] ? Number(m[1]) : year;
      var month = Number(m[2]), day = Number(m[3]);
      if (month < 1 || month > 12 || day < 1 || day > 31) return null;
      if (y === null) {
        y = new Date(now).getFullYear();
        if (new Date(y, month - 1, day).getTime() > now + 24 * HOUR) y--;
      } else if (!m[1] && lastMonth !== null && month < lastMonth - 6) {
        y++;   // 12月 → 1月 のように年をまたいだ
      }
      year = y;
      lastMonth = month;
      var h = m[4] !== undefined ? Number(m[4]) : 12;
      var min = m[5] !== undefined ? Number(m[5]) : 0;
      var t = new Date(y, month - 1, day, h, min).getTime();
      // 時刻が書いていない今日の記録は、12時がまだ来ていなければ今の時刻にする
      if (m[4] === undefined && t > now) t = Math.floor(now / 60000) * 60000;
      return t;
    }

    lines.forEach(function (raw) {
      var line = raw.replace(/^[\s•・\-*●○◦▪︎]+/, '').trim();
      if (!line) return;
      var dm = line.match(DATE_RE);
      var rest = dm ? line.slice(dm.index + dm[0].length) : line;
      var wm = rest.match(WEIGHT_RE);
      var at = null;
      if (dm) at = makeDate(dm);

      if (at !== null && !wm) { pendingDate = at; return; }
      if (!wm) {
        if (/\d/.test(line) && !/^(植物|品種|名前)\s*:/.test(line)) skipped.push(raw.trim());
        return;
      }
      if (at === null) {
        if (pendingDate === null) { skipped.push(raw.trim()); return; }
        at = pendingDate;
      }
      pendingDate = null;
      if (at > now + FUTURE_GRACE) { skipped.push(raw.trim() + '（未来の日時のため取り込みません）'); return; }

      var memoMatch = rest.slice(wm.index + wm[0].length).match(/\(([^)]*)\)/);
      var memo = memoMatch ? memoMatch[1].trim() : rest.slice(wm.index + wm[0].length).replace(/^[\s:、,]+/, '').trim();
      entries.push({ at: at, weight: Number(wm[1]), memo: memo, kind: guessKind(memo) });
    });

    // 同じ日時・同じ重さの行は1件にまとめる（メモはつなげる）
    entries.sort(function (a, b) { return a.at - b.at; });
    var merged = [];
    entries.forEach(function (e) {
      var prev = merged[merged.length - 1];
      if (prev && prev.at === e.at && prev.weight === e.weight) {
        if (e.memo && prev.memo.indexOf(e.memo) < 0) prev.memo = prev.memo ? prev.memo + '・' + e.memo : e.memo;
        prev.kind = prev.kind === 'after' || e.kind === 'after' ? 'after' : (prev.kind || e.kind);
        prev.duplicates = (prev.duplicates || 0) + 1;
      } else {
        merged.push(e);
      }
    });

    // 種別が書かれていない記録で、前より1割以上重くなっていたら「水やり後」とみなす
    merged.forEach(function (e, i) {
      e.kindGuessed = false;
      var prev = merged[i - 1];
      if (!e.kind && prev && e.weight >= prev.weight * JUMP_RATIO) {
        e.kind = 'after';
        e.kindGuessed = true;
      }
    });

    // 水やり後の直前の軽い記録は「水やり前」とみなす
    merged.forEach(function (e, i) {
      if (e.kind) return;
      var next = merged[i + 1];
      if (next && next.kind === 'after' && next.at - e.at <= BEFORE_WINDOW && next.weight > e.weight) {
        e.kind = 'before';
        e.kindGuessed = true;
      } else {
        e.kind = 'regular';
      }
    });

    return { entries: merged, skipped: skipped };
  }

  return { parse: parse };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = BikakuImporter;
