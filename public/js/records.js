/* Tangyuan Math — 游客本地记录存储（DESIGN.md 4.3 / M0）
 * - 每条记录带 client_event_id（UUID），未来 M1 导入账号时按此幂等去重；
 * - 限定条数（MAX_RECORDS）与保留期限（RETENTION_DAYS），加载时自动清理；
 * - 提供「清除」能力；所有数据只存 localStorage，不上传。
 * 存储键：tm_records（记录数组）、tm_wrongbook（错题本）。
 */
(function (global) {
  'use strict';

  var KEYS = { records: 'tm_records', wrongbook: 'tm_wrongbook' };
  var MAX_RECORDS = 100;
  var RETENTION_DAYS = 365;

  function safeParse(raw, fallback) {
    try { var v = JSON.parse(raw); return v == null ? fallback : v; }
    catch (e) { return fallback; }
  }

  function load(storage, key) {
    storage = storage || (global.localStorage);
    return safeParse(storage.getItem(key), []);
  }

  function save(storage, key, arr) {
    storage = storage || (global.localStorage);
    try { storage.setItem(key, JSON.stringify(arr)); return true; }
    catch (e) { return false; } // 隐私模式/空间满：静默失败，游戏可继续
  }

  /* 截断到最近 MAX_RECORDS 条、剔除超过保留期的记录；返回 {list, changed} */
  function prune(list, now) {
    now = now || Date.now();
    var cutoff = now - RETENTION_DAYS * 24 * 3600 * 1000;
    var kept = list.filter(function (r) { return !r.createdAt || r.createdAt >= cutoff; });
    if (kept.length > MAX_RECORDS) kept = kept.slice(kept.length - MAX_RECORDS);
    return { list: kept, changed: kept.length !== list.length };
  }

  function uuid() {
    if (global.crypto && global.crypto.randomUUID) return global.crypto.randomUUID();
    return 'xxxxxxxxyxxx'.replace(/[xy]/g, function (c) {
      var r = Math.random() * 16 | 0;
      return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
    }) + '-' + Date.now().toString(36);
  }

  /* 组装一条完整记录（perQuestion 见 DESIGN 7.2 口径） */
  function buildRecord(meta, perQuestion, now) {
    var firstAnswered = 0, firstCorrect = 0, finalCorrect = 0, blanks = 0;
    var activeTotal = 0, activeCount = 0;
    perQuestion.forEach(function (q) {
      if (q.first_answer === null || q.first_answer === undefined) { blanks++; return; }
      firstAnswered++;
      if (q.first_correct) firstCorrect++;
      if (q.final_correct) finalCorrect++;
      if (q.active_ms != null && q.active_ms > 0) { activeTotal += q.active_ms; activeCount++; }
    });
    return Object.assign({
      id: uuid(),
      createdAt: now || Date.now(),
      count: perQuestion.length,
      firstAnswered: firstAnswered,
      firstCorrect: firstCorrect,
      finalCorrect: finalCorrect,
      blanks: blanks,
      avgActiveMs: activeCount ? Math.round(activeTotal / activeCount) : null
    }, meta, { perQuestion: perQuestion });
  }

  function append(storage, record) {
    var list = load(storage, KEYS.records);
    list.push(record);
    var p = prune(list);
    save(storage, KEYS.records, p.list);
    return p.list;
  }

  /* 分模式汇总（DESIGN 2.1：不同模式分开统计、不混排） */
  function summarize(list) {
    var by = {};
    list.forEach(function (r) {
      var m = r.mode || 'practice';
      if (!by[m]) by[m] = { rounds: 0, questions: 0, firstAnswered: 0, firstCorrect: 0, finalCorrect: 0, activeTotal: 0, activeCount: 0 };
      var s = by[m];
      s.rounds++;
      s.questions += r.count || 0;
      s.firstAnswered += r.firstAnswered || 0;
      s.firstCorrect += r.firstCorrect || 0;
      s.finalCorrect += r.finalCorrect || 0;
      if (r.avgActiveMs != null && r.count) { s.activeTotal += r.avgActiveMs * Math.min(r.count, r.firstAnswered || r.count); s.activeCount += Math.min(r.count, r.firstAnswered || r.count); }
    });
    Object.keys(by).forEach(function (m) {
      var s = by[m];
      s.firstAccuracy = s.firstAnswered ? s.firstCorrect / s.firstAnswered : null;
      s.finalCompletion = s.questions ? s.finalCorrect / s.questions : null;
      s.avgActiveMs = s.activeCount ? Math.round(s.activeTotal / s.activeCount) : null;
    });
    return by;
  }

  function clearAll(storage) {
    storage = storage || (global.localStorage);
    storage.removeItem(KEYS.records);
    storage.removeItem(KEYS.wrongbook);
  }

  var api = {
    KEYS: KEYS, MAX_RECORDS: MAX_RECORDS, RETENTION_DAYS: RETENTION_DAYS,
    load: load, save: save, prune: prune, uuid: uuid,
    buildRecord: buildRecord, append: append, summarize: summarize, clearAll: clearAll
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  global.TMRecords = api;
})(typeof window !== 'undefined' ? window : globalThis);
