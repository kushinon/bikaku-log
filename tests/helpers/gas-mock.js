// Google Apps Script のかわりをする小さな模型。gas/Code.gs をそのまま読み込んで動かすために使う
'use strict';
const vm = require('vm');
const fs = require('fs');
const path = require('path');

class Range {
  constructor(sheet, row, col, rows, cols) { Object.assign(this, { sheet, row, col, rows, cols }); }
  getValues() {
    const out = [];
    for (let i = 0; i < this.rows; i++) {
      const r = this.sheet.data[this.row - 1 + i] || [];
      const line = [];
      for (let j = 0; j < this.cols; j++) line.push(r[this.col - 1 + j] ?? '');
      out.push(line);
    }
    return out;
  }
  setValues(values) {
    values.forEach((line, i) => {
      const r = this.row - 1 + i;
      this.sheet.data[r] = this.sheet.data[r] || [];
      line.forEach((v, j) => {
        // スプレッドシートでは先頭の ' は「文字として扱う」印で、値には残らない
        this.sheet.raw[`${r},${this.col - 1 + j}`] = v;
        this.sheet.data[r][this.col - 1 + j] = typeof v === 'string' && v[0] === "'" ? v.slice(1) : v;
      });
    });
    return this;
  }
  setFontWeight() { return this; }
  setBackground() { return this; }
  setNumberFormat() { return this; }
}

class Sheet {
  constructor(name) { this.name = name; this.data = []; this.raw = {}; }
  getLastRow() { return this.data.length; }
  getMaxRows() { return 1000; }
  getRange(row, col, rows = 1, cols = 1) { return new Range(this, row, col, rows, cols); }
  setFrozenRows() {}
}

/** gas/Code.gs を読み込んだ環境を作る */
function loadGas(options = {}) {
  const code = fs.readFileSync(path.join(__dirname, '../../gas/Code.gs'), 'utf8');
  const sheets = {};
  const cache = {};
  const mails = [];
  const triggers = [];
  const props = Object.assign({ PASSCODE: 'test-pass' }, options.props || {});
  const ss = {
    getSheetByName: n => sheets[n] || null,
    insertSheet: n => (sheets[n] = new Sheet(n)),
    getSheets: () => Object.values(sheets),
    deleteSheet: s => { delete sheets[s.name]; }
  };
  const triggerBuilder = name => {
    const b = { timeBased: () => b, everyDays: () => b, atHour: () => b, nearMinute: () => b, create: () => { triggers.push(name); return b; } };
    return b;
  };
  const ctx = {
    SpreadsheetApp: { getActiveSpreadsheet: () => ss },
    PropertiesService: { getScriptProperties: () => ({ getProperty: k => (k in props ? props[k] : null) }) },
    CacheService: { getScriptCache: () => ({ get: k => cache[k] || null, put: (k, v) => { cache[k] = v; } }) },
    LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
    ContentService: { MimeType: { JSON: 'json' }, createTextOutput: text => ({ text, setMimeType() { return this; } }) },
    Utilities: { formatDate: d => d.toISOString() },
    Session: { getScriptTimeZone: () => 'Asia/Tokyo', getEffectiveUser: () => ({ getEmail: () => 'owner@example.com' }) },
    MailApp: { sendEmail: m => mails.push(m) },
    ScriptApp: {
      getProjectTriggers: () => triggers.map(n => ({ getHandlerFunction: () => n })),
      deleteTrigger: t => { const i = triggers.indexOf(t.getHandlerFunction()); if (i >= 0) triggers.splice(i, 1); },
      newTrigger: triggerBuilder
    },
    Logger: { log() {} },
    console
  };
  vm.createContext(ctx);
  vm.runInContext(code, ctx);
  /** 画面からの通信（doPost）をまねる */
  ctx.call = body => JSON.parse(ctx.doPost({ postData: { contents: JSON.stringify(body) } }).text);
  return { gas: ctx, sheets, mails, triggers, cache, props };
}

module.exports = { loadGas };
