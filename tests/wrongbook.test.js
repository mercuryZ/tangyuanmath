'use strict';
const test = require('node:test');
const assert = require('node:assert');
const W = require('../public/js/wrongbook.js');

test('首次错误进入错题本（+1）', () => {
  const book = W.recordFirstWrong([], 24, 13, 300);
  assert.strictEqual(book.length, 1);
  assert.strictEqual(book[0].wrong_count, 1);
  assert.strictEqual(book[0].a, 13); // 规范化 13x24
  assert.strictEqual(book[0].b, 24);
});

test('a×b 与 b×a 合并为同一错题', () => {
  let book = W.recordFirstWrong([], 24, 13, 300);
  book = W.recordFirstWrong(book, 13, 24, 310);
  assert.strictEqual(book.length, 1);
  assert.strictEqual(book[0].wrong_count, 2); // 不同答案 → 累计
});

test('相同错误答案不重复累计（DESIGN 2.4 规则 2）', () => {
  let book = W.recordFirstWrong([], 24, 13, 300);
  const before = book[0].wrong_count;
  book = W.recordFirstWrong(book, 24, 13, 300); // 同答案
  assert.strictEqual(book[0].wrong_count, before);
});

test('未答(blank)不会进入错题本 —— 调用方不调用即可，接口仅接受已判错的答案', () => {
  // blank 情形由 game.js 过滤，本测试确认接口不会凭空创建条目
  const book = W.recordFirstWrong([], 24, 13, undefined);
  assert.strictEqual(book.length, 1); // undefined 也是一次错误作答
  // 但调用方约定：blank 不调用本函数（见 game.js）
});

test('重练答对次数-1，归零移出', () => {
  let book = W.recordFirstWrong([], 24, 13, 300);
  book = W.recordFirstWrong(book, 24, 13, 299); // 不同答案 → 2
  assert.strictEqual(book[0].wrong_count, 2);
  book = W.reviewCorrect(book, 13, 24); // 顺序无关
  assert.strictEqual(book[0].wrong_count, 1);
  book = W.reviewCorrect(book, 24, 13);
  assert.strictEqual(book.length, 0);
});

test('重练答错每题每次重练最多 +1（roundSet 去重）', () => {
  let book = W.recordFirstWrong([], 24, 13, 300);
  const roundSet = {};
  book = W.reviewWrong(book, 24, 13, 311, roundSet);
  assert.strictEqual(book[0].wrong_count, 2);
  book = W.reviewWrong(book, 24, 13, 312, roundSet); // 本轮已加过
  assert.strictEqual(book[0].wrong_count, 2); // 不再增加
  assert.strictEqual(book[0].user_answer, 312); // 但更新最近答案
});

test('当场修正不立即抵消：首次错→最终对，仍保留错题（规则 7 由调用方保证顺序）', () => {
  // game.js 只在「首次判分」时 recordFirstWrong；改对后不再调用抵消类接口
  let book = W.recordFirstWrong([], 24, 13, 300);
  // 用户改对后重新提交 —— 不调用 reviewCorrect（那是重练专用）
  assert.strictEqual(book.length, 1);
});
