'use strict';
const test = require('node:test');
const assert = require('node:assert');
const R = require('../public/js/records.js');

// 测试用内存 storage 桩
function memStorage() {
  const m = new Map();
  return {
    getItem: k => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: k => m.delete(k)
  };
}

test('记录带 client_event_id 且可追加', () => {
  const s = memStorage();
  const rec = R.buildRecord({ mode: 'practice', difficulty: 'two_by_two' },
    [{ a: 12, b: 34, first_answer: 408, first_correct: true, final_answer: 408, final_correct: true, active_ms: 4200 }]);
  assert.ok(rec.id && rec.id.length >= 8, 'id 存在');
  assert.strictEqual(rec.firstCorrect, 1);
  assert.strictEqual(rec.blanks, 0);
  assert.strictEqual(rec.avgActiveMs, 4200);
  R.append(s, rec);
  const list = R.load(s, R.KEYS.records);
  assert.strictEqual(list.length, 1);
  assert.strictEqual(list[0].id, rec.id);
});

test('blank 计数与正确率口径（DESIGN 7.3）', () => {
  const rec = R.buildRecord({ mode: 'challenge', difficulty: 'two_by_two', level: 1 }, [
    { a: 1, b: 1, first_answer: 1, first_correct: true, final_correct: true, active_ms: 1000 },
    { a: 2, b: 2, first_answer: 5, first_correct: false, final_correct: false, active_ms: 2000 },
    { a: 3, b: 3, first_answer: null, final_correct: false, active_ms: null }
  ]);
  assert.strictEqual(rec.count, 3);
  assert.strictEqual(rec.firstAnswered, 2);
  assert.strictEqual(rec.firstCorrect, 1);
  assert.strictEqual(rec.finalCorrect, 1);
  assert.strictEqual(rec.blanks, 1);
});

test('超量截断：只保留最近 MAX_RECORDS 条', () => {
  const list = [];
  const now = Date.now();
  const TOTAL = R.MAX_RECORDS + 30;
  for (let i = 0; i < TOTAL; i++) { // 按追加顺序：旧在前、新在后（同 records.append）
    list.push({ id: 'r' + i, createdAt: now - (TOTAL - 1 - i) * 1000, mode: 'practice', count: 5, firstAnswered: 5, firstCorrect: 5, finalCorrect: 5, avgActiveMs: 1000 });
  }
  const p = R.prune(list, now);
  assert.strictEqual(p.list.length, R.MAX_RECORDS);
  assert.ok(p.changed);
  assert.strictEqual(p.list[0].id, 'r30');   // 丢弃最旧 30 条
  assert.strictEqual(p.list[99].id, 'r129'); // 保留最新一条
});

test('过期清理：超过保留期的记录被剔除', () => {
  const now = Date.now();
  const DAY = 24 * 3600 * 1000;
  const list = [
    { id: 'old', createdAt: now - (R.RETENTION_DAYS + 10) * DAY },
    { id: 'new', createdAt: now - DAY }
  ];
  const p = R.prune(list, now);
  assert.strictEqual(p.list.length, 1);
  assert.strictEqual(p.list[0].id, 'new');
});

test('分模式统计互不混排（DESIGN 2.1）', () => {
  const now = Date.now();
  const list = [
    R.buildRecord({ mode: 'practice', difficulty: 'two_by_two' }, [
      { a: 1, b: 1, first_answer: 1, first_correct: true, final_correct: true, active_ms: 2000 }], now),
    R.buildRecord({ mode: 'challenge', difficulty: 'two_by_two', level: 2 }, [
      { a: 2, b: 2, first_answer: 2, first_correct: true, final_correct: true, active_ms: 4000 },
      { a: 3, b: 3, first_answer: null, final_correct: false, active_ms: null }], now)
  ];
  const s = R.summarize(list);
  assert.ok(s.practice && s.challenge);
  assert.strictEqual(s.practice.rounds, 1);
  assert.strictEqual(s.challenge.rounds, 1);
  assert.strictEqual(s.practice.firstAccuracy, 1);
  assert.strictEqual(s.challenge.firstAccuracy, 1);
  assert.strictEqual(s.challenge.finalCompletion, 0.5);
});

test('clearAll 清除记录与错题本', () => {
  const s = memStorage();
  s.setItem(R.KEYS.records, '[{"id":1}]');
  s.setItem(R.KEYS.wrongbook, '[{"key":"1x2"}]');
  R.clearAll(s);
  assert.strictEqual(s.getItem(R.KEYS.records), null);
  assert.strictEqual(s.getItem(R.KEYS.wrongbook), null);
});
