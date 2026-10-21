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
    HISTORY_CYCLES: 3      // 予測の補助に使う過去の水やりサイクル数
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

  /** 過去の水やりサイクル（水やり後 → 次の水やり前）の平均の減り方 */
  function historicalRate(sorted) {
    var rates = [];
    var lastAfter = null;
    sorted.forEach(function (l) {
      if (l.kind === 'after') lastAfter = l;
      else if (l.kind === 'before' && lastAfter) {
        var days = (l.at - lastAfter.at) / DAY;
        var drop = lastAfter.weight - l.weight;
        if (days > 0.25 && drop > 0) rates.push(drop / days);
        lastAfter = null;
      }
    });
    if (!rates.length) return null;
    var recent = rates.slice(-CONFIG.HISTORY_CYCLES);
    return recent.reduce(function (a, b) { return a + b; }, 0) / recent.length;
  }

  /**
   * 株の水やり判定
   * @return {{status, statusLabel, target, autoTarget, targetSource, latest,
   *           ratePerDay, rateSource, predictedAt, daysLeft, lastWateredAt, note}}
   */
  function judgePlant(plant, logs, now) {
    now = now || Date.now();
    var sorted = plantLogs(plant.id, logs);
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
    if (rate !== null) {
      r.rateSource = 'recent';
    } else {
      rate = historicalRate(sorted);
      if (rate !== null) r.rateSource = 'history';
      else if ((rate = dryingRate(segment)) !== null) r.rateSource = 'recent';
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
    KINDS: KINDS,
    STYLES: STYLES,
    STATUS: STATUS,
    DAY: DAY,
    judgePlant: judgePlant,
    sortByUrgency: sortByUrgency,
    plantLogs: plantLogs,
    makeSampleData: makeSampleData
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = BikakuShared;
